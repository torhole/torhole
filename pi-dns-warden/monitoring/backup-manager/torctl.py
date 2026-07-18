"""torctl — Tor control-port protocol layer.

Extracted from server.py (T-048 step 3). Everything that speaks the control
protocol at tor:9051 lives here: authenticate + command execution, NEWNYM
rotation (global and per-plane via IsolateSOCKSAuth), and the parsers for
circuit-status / GETINFO replies. Composition (caching, snapshot assembly,
status mapping) stays in server.py. Pure protocol + parsing: no HTTP, no
Docker, no .env.
"""

import os
import re
import socket

from status_math import utc_now


TOR_CONTROL_HOST = os.environ.get("TOR_CONTROL_HOST", "tor")


TOR_CONTROL_PORT = int(os.environ.get("TOR_CONTROL_PORT", "9051"))


TOR_CONTROL_TIMEOUT_S = float(os.environ.get("TOR_CONTROL_TIMEOUT_S", "3"))


PLANE_NAMES = frozenset({"trusted", "iot"})


_TOR_RELAY_RE = re.compile(r"\$([0-9A-F]{40})(?:~([\w\-.]+))?")


_TOR_CIRCUIT_LINE_RE = re.compile(
    r"^(?P<id>\d+)\s+(?P<state>\w+)\s+(?P<path>\$\S+)(?:\s+(?P<rest>.*))?$"
)


_TOR_KV_RE = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')


def _tor_recv_response(sock, max_size=65536):
    """Read a Tor control protocol response until '<code> ' (final reply line)."""
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) >= max_size:
            break
        # Final line is of the form "250 ..." (no '+' or '-' separator).
        # Look for that as the last line.
        last_lines = buf.split(b"\r\n")[-2:]
        for line in last_lines:
            if len(line) >= 4 and line[3:4] == b" " and line[:3].isdigit():
                return buf.decode("utf-8", errors="replace")
    return buf.decode("utf-8", errors="replace")


def _parse_circuit_status(payload):
    """Parse the GETINFO circuit-status response into structured circuits."""
    # Strip protocol envelope: lines starting with 250+circuit-status= … then
    # a list of circuit lines, terminated by a "." line and a "250 OK".
    circuits = []
    in_data = False
    for raw in payload.splitlines():
        if raw.startswith("250+circuit-status="):
            in_data = True
            continue
        if not in_data:
            continue
        if raw == ".":
            in_data = False
            continue
        if raw.startswith("250 "):
            break

        match = _TOR_CIRCUIT_LINE_RE.match(raw)
        if not match:
            continue
        circ_id = match.group("id")
        state = match.group("state")
        path_str = match.group("path") or ""
        rest = match.group("rest") or ""

        path = []
        for relay_match in _TOR_RELAY_RE.finditer(path_str):
            path.append({
                "fp": relay_match.group(1),
                "nickname": relay_match.group(2) or "(unnamed)",
            })

        kv = {}
        for k, v in _TOR_KV_RE.findall(rest):
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1].encode("utf-8").decode("unicode_escape")
            kv[k] = v

        circuits.append({
            "id": circ_id,
            "state": state,
            "purpose": kv.get("PURPOSE"),
            "build_flags": kv.get("BUILD_FLAGS", "").split(",") if kv.get("BUILD_FLAGS") else [],
            "time_created": kv.get("TIME_CREATED"),
            "socks_username": kv.get("SOCKS_USERNAME"),
            "conflux_id": kv.get("CONFLUX_ID"),
            "path": path,
            "hops": len(path),
        })
    return circuits


def _tor_control_command(values, command):
    """Open a Tor control port connection, authenticate, send a command,
    and return the response. Used by both read and write operations.
    Returns (success: bool, response: str).
    """
    password = values.get("TOR_CONTROL_PASSWORD", "")
    if not password:
        return False, "TOR_CONTROL_PASSWORD not set in .env"

    sock = None
    try:
        sock = socket.create_connection(
            (TOR_CONTROL_HOST, TOR_CONTROL_PORT),
            timeout=TOR_CONTROL_TIMEOUT_S,
        )
        sock.settimeout(TOR_CONTROL_TIMEOUT_S)
        safe_pw = password.replace("\\", "\\\\").replace('"', '\\"')
        sock.sendall(f'AUTHENTICATE "{safe_pw}"\r\n'.encode())
        auth_resp = _tor_recv_response(sock)
        if "250 OK" not in auth_resp:
            return False, f"auth failed: {auth_resp.strip()[:120]}"

        sock.sendall((command + "\r\n").encode())
        resp = _tor_recv_response(sock)
        try:
            sock.sendall(b"QUIT\r\n")
        except OSError:
            pass
        return True, resp
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def tor_rotate_identity(values):
    """Send SIGNAL NEWNYM to the Tor control port. Global rotation — affects
    all SOCKS users. New circuits will be built on next request per plane.

    Returns a dict shaped for the API:
      { ok: bool, message: str, rotated_at: iso8601 }
    """
    ok, resp = _tor_control_command(values, "SIGNAL NEWNYM")
    if not ok:
        return {"ok": False, "message": resp, "rotated_at": utc_now()}
    if "250 OK" not in resp:
        return {
            "ok": False,
            "message": f"unexpected response: {resp.strip()[:200]}",
            "rotated_at": utc_now(),
        }
    return {
        "ok": True,
        "message": "Tor identity rotated. New circuits will be built on next request.",
        "rotated_at": utc_now(),
    }


def tor_rotate_plane(values, plane):
    """Close all Tor circuits belonging to a specific plane.

    The plane is identified by SOCKS_USERNAME, which dnscrypt-proxy sets via
    IsolateSOCKSAuth so each plane gets its own circuit pool. We CLOSECIRCUIT
    each matching circuit; Tor will build new ones on the next DNS query
    that flows through that SOCKS user.

    This avoids the global SIGNAL NEWNYM which rotates ALL planes at once.

    Returns:
      { ok, message, rotated_at, closed: [ids...], failed: [...] }
    """
    if plane not in PLANE_NAMES:
        return {
            "ok": False,
            "message": f"unknown plane: {plane!r}",
            "rotated_at": utc_now(),
        }

    password = values.get("TOR_CONTROL_PASSWORD", "")
    if not password:
        return {
            "ok": False,
            "message": "TOR_CONTROL_PASSWORD not set in .env",
            "rotated_at": utc_now(),
        }

    sock = None
    try:
        sock = socket.create_connection(
            (TOR_CONTROL_HOST, TOR_CONTROL_PORT),
            timeout=TOR_CONTROL_TIMEOUT_S,
        )
        sock.settimeout(TOR_CONTROL_TIMEOUT_S)
        safe_pw = password.replace("\\", "\\\\").replace('"', '\\"')
        sock.sendall(f'AUTHENTICATE "{safe_pw}"\r\n'.encode())
        auth_resp = _tor_recv_response(sock)
        if "250 OK" not in auth_resp:
            return {
                "ok": False,
                "message": f"auth failed: {auth_resp.strip()[:120]}",
                "rotated_at": utc_now(),
            }

        sock.sendall(b"GETINFO circuit-status\r\n")
        circ_resp = _tor_recv_response(sock)
        circuits = _parse_circuit_status(circ_resp)
        plane_circuits = [
            c
            for c in circuits
            if c.get("socks_username") == plane and c["state"] == "BUILT"
        ]

        if not plane_circuits:
            try:
                sock.sendall(b"QUIT\r\n")
            except OSError:
                pass
            return {
                "ok": True,
                "message": f"no active circuits for {plane} plane (currently idle)",
                "rotated_at": utc_now(),
                "closed": [],
                "failed": [],
            }

        closed = []
        failed = []
        for circ in plane_circuits:
            sock.sendall(f"CLOSECIRCUIT {circ['id']}\r\n".encode())
            close_resp = _tor_recv_response(sock)
            if "250 OK" in close_resp:
                closed.append(circ["id"])
            else:
                failed.append({
                    "id": circ["id"],
                    "reason": close_resp.strip()[:120],
                })

        try:
            sock.sendall(b"QUIT\r\n")
        except OSError:
            pass

        return {
            "ok": len(failed) == 0,
            "message": (
                f"closed {len(closed)} circuit{'s' if len(closed) != 1 else ''} for {plane} plane"
                + (f"; {len(failed)} failed" if failed else "")
            ),
            "rotated_at": utc_now(),
            "closed": closed,
            "failed": failed,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "message": f"{exc.__class__.__name__}: {exc}",
            "rotated_at": utc_now(),
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def _parse_getinfo_replies(payload):
    """Parse a Tor control GETINFO reply stream into a dict of key -> value.

    Handles both forms:
      - single-line:  250-key=value
      - multi-line:   250+key=\\r\\n<line>\\r\\n<line>\\r\\n.\\r\\n
    Terminated by a final "250 OK" line (which we ignore).
    """
    out = {}
    lines = payload.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("250-"):
            body = line[4:]
            if "=" in body:
                k, v = body.split("=", 1)
                out[k] = v
            i += 1
            continue
        if line.startswith("250+"):
            body = line[4:]
            k = body.split("=", 1)[0] if "=" in body else body
            buf = []
            i += 1
            while i < len(lines):
                if lines[i] == ".":
                    i += 1
                    break
                buf.append(lines[i])
                i += 1
            out[k] = "\n".join(buf)
            continue
        i += 1
    return out
