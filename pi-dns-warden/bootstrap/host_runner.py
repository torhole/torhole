#!/usr/bin/env python3
"""Narrow host-side bridge for the guided Advanced installer.

The web bootstrap container may request exactly one operation: run this
repository's fixed Advanced deployer. The runner stays on the host as the
original user and uses the sudo authorization obtained by install.sh. It does
not accept command names, arguments, or paths from the request.
"""

import argparse
import hmac
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


REQUEST_ID_RE = re.compile(r"^[a-f0-9]{32}$")
MAX_REQUEST_AGE_SECONDS = 6 * 60 * 60


class InvalidRequestToken(ValueError):
    """Request belongs to a newer or different bootstrap session."""


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def write_status(path, request_id, status, message, returncode=None):
    payload = {
        "request_id": request_id,
        "status": status,
        "message": message,
        "updated_at": utc_now(),
    }
    if returncode is not None:
        payload["returncode"] = returncode
    atomic_json(path, payload)


def validated_request(path, expected_token, now=None):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Advanced install request is not a regular file.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Advanced install request is unreadable.") from exc
    if payload.get("operation") != "deploy-advanced":
        raise ValueError("Unsupported host install operation.")
    token = payload.get("token")
    if not isinstance(token, str) or not hmac.compare_digest(token, expected_token):
        raise InvalidRequestToken("Advanced install request token is invalid.")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("Advanced install request ID is invalid.")
    created_at = payload.get("created_at")
    if not isinstance(created_at, (int, float)):
        raise ValueError("Advanced install request timestamp is invalid.")
    current = time.time() if now is None else now
    if created_at > current + 60 or current - created_at > MAX_REQUEST_AGE_SECONDS:
        raise ValueError("Advanced install request has expired.")
    return payload


def deploy_command(root, use_sudo):
    command = [str(root / "pi-dns-warden" / "deploy.sh")]
    return ["sudo", "-n", *command] if use_sudo else command


def run_deployment(command, log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with log_path.open("w", encoding="utf-8") as log:
        os.chmod(log_path, 0o600)
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        with process.stdout:
            for line in process.stdout:
                log.write(line)
                log.flush()
                print(line, end="", flush=True)
        return process.wait()


def process_request(root, expected_token, use_sudo, command=None):
    run_dir = root / "pi-dns-warden" / "run" / "bootstrap"
    request_path = run_dir / "advanced-request.json"
    processing_path = run_dir / "advanced-request.processing.json"
    status_path = run_dir / "advanced-status.json"
    log_path = run_dir / "advanced-install.log"
    if not request_path.exists():
        return False

    try:
        request = validated_request(request_path, expected_token)
        os.replace(request_path, processing_path)
    except InvalidRequestToken:
        # A previous installer terminal can remain alive while a new setup
        # session rotates the token. It must not consume the new session's
        # request or overwrite its status; the matching runner will handle it.
        return False
    except (OSError, ValueError) as exc:
        request_path.unlink(missing_ok=True)
        write_status(status_path, "unknown", "error", str(exc))
        return True

    request_id = request["request_id"]
    write_status(
        status_path,
        request_id,
        "running",
        "Advanced host deployment is running.",
    )
    chosen_command = command or deploy_command(root, use_sudo)
    try:
        returncode = run_deployment(chosen_command, log_path)
    except OSError as exc:
        write_status(status_path, request_id, "error", f"Could not start deployer: {exc}")
        processing_path.unlink(missing_ok=True)
        return True

    if returncode == 0:
        write_status(
            status_path,
            request_id,
            "success",
            "Torhole Advanced installed successfully.",
            returncode=0,
        )
    else:
        write_status(
            status_path,
            request_id,
            "error",
            f"Advanced deployer exited with status {returncode}.",
            returncode=returncode,
        )
    processing_path.unlink(missing_ok=True)
    return True


def command_ok(command):
    return subprocess.run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def token_is_current(path, expected_token):
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("TORHOLE_BOOTSTRAP_TOKEN="):
                current = line.split("=", 1)[1]
                return hmac.compare_digest(current, expected_token)
    except OSError:
        pass
    return False


def run_loop(root, expected_token, use_sudo, docker_uses_sudo):
    inspect_command = ["docker", "inspect", "torhole-bootstrap"]
    if docker_uses_sudo:
        inspect_command = ["sudo", "-n", *inspect_command]
    last_sudo_refresh = 0.0
    token_file = root / "pi-dns-warden" / ".env.bootstrap.local"
    print("Host installer is ready. Complete setup in the browser.", flush=True)
    while command_ok(inspect_command):
        if not token_is_current(token_file, expected_token):
            print("Host installer was superseded by a newer setup session.", flush=True)
            return 0
        now = time.monotonic()
        if use_sudo and now - last_sudo_refresh >= 60:
            if not command_ok(["sudo", "-n", "true"]):
                run_dir = root / "pi-dns-warden" / "run" / "bootstrap"
                write_status(
                    run_dir / "advanced-status.json",
                    "unknown",
                    "error",
                    "Host authorization expired. Re-run ./install.sh.",
                )
                return 1
            last_sudo_refresh = now
        process_request(root, expected_token, use_sudo)
        time.sleep(1)
    print("Setup wizard closed.", flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--use-sudo", action="store_true")
    parser.add_argument("--docker-uses-sudo", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    token = os.environ.get("TORHOLE_BOOTSTRAP_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("TORHOLE_BOOTSTRAP_TOKEN must contain at least 32 characters")
    if not (root / "pi-dns-warden" / "deploy.sh").is_file():
        raise SystemExit("Torhole Advanced deployer is missing")
    return run_loop(root, token, args.use_sudo, args.docker_uses_sudo)


if __name__ == "__main__":
    sys.exit(main())
