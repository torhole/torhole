"""env_store — the single owner of .env I/O for the torhole backend.

Extracted from server.py (T-048 step 1). Everything that reads or writes the
.env file lives here: the literal (non-shell) parser, the atomic
backup-then-write update path, the 0600 lifecycle guarantees, and the
secret-key guardrails. server.py re-exports these names for compatibility.
"""

import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(os.environ.get("TORHOLE_ROOT_DIR", "/workspace")).resolve()
ENV_FILE = ROOT_DIR / ".env"

# Keys whose values must never flow through the generic config-update path.
# update_env_keys rejects them unless allow_secret_keys=True; dedicated
# helpers (update_admin_password, notification-channel writes) own them.
_SECRET_KEYS = re.compile(r"(PASSWORD|SECRET|KEY|TOKEN|PASS)", re.IGNORECASE)


def read_env_text():
    if not ENV_FILE.exists():
        raise FileNotFoundError(".env")
    return ENV_FILE.read_text(encoding="utf-8")


def parse_env_text(text):
    values = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def read_env_values():
    return parse_env_text(read_env_text())


def read_env_values_safe():
    try:
        return read_env_values()
    except FileNotFoundError:
        return {}


def update_env_value_text(text, key, value):
    replacement = f"{key}={value}"
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(replacement, text, count=1)

    suffix = "" if text.endswith("\n") else "\n"
    return f"{text}{suffix}{replacement}\n"


# ---------------------------------------------------------------------------
# Phase A.1 — safe write helpers for .env
#
# All write paths that touch .env (admin password change, setup wizard apply,
# etc.) must go through these helpers so the file is backed up atomically
# before every change and a partial write can never corrupt it.
# ---------------------------------------------------------------------------

# Regex for a valid .env key: UPPERCASE, alphanumeric, underscores, must
# start with a letter. Rejects anything else to prevent injection of
# quoted/multi-line garbage.
_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

# .env holds plaintext secrets and is shell-sourced-equivalent by the loader,
# so every file we create in its write lifecycle must be owner-only.
_ENV_MODE = 0o600


def _reject_env_control_chars(key, value):
    """A value that contains a newline, carriage return or NUL would split into
    extra .env lines (smuggling a second key) or truncate the file. Reject them
    before anything is written."""
    if any(c in value for c in ("\n", "\r", "\x00")):
        raise ValueError(f"Value for {key!r} may not contain newlines or NUL bytes.")


def backup_env_file():
    """Copy the current .env to a timestamped sibling file. Returns the
    backup path so callers can log it or reference it on rollback.

    Non-fatal if .env is missing — returns None (nothing to back up).
    """
    if not ENV_FILE.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = ENV_FILE.with_name(f".env.bak-{stamp}")
    # shutil.copy2 preserves permissions + mtime. We want a byte-identical
    # snapshot we could cp back on rollback.
    shutil.copy2(ENV_FILE, backup_path)
    # The source .env may be too permissive on legacy hosts; never let a
    # secret-bearing backup be more readable than 0600 regardless.
    os.chmod(backup_path, _ENV_MODE)
    return backup_path


def update_env_keys(updates, *, allow_secret_keys=False):
    """Apply a batch of {key: value} updates to .env atomically.

    Writes to a sibling .env.new file first, validates it parses back to
    the expected values, then renames it over .env. If anything in that
    chain fails, .env is left untouched.

    Every call also creates a .env.bak-<timestamp> via backup_env_file()
    BEFORE writing, so rollback is a straight file copy if a later step
    (e.g. render-auth, container restart) fails.

    Args:
      updates: dict of {key: value} pairs to set. Existing keys are
        updated in place (preserving file ordering and comments); new
        keys are appended at the end.
      allow_secret_keys: if False (default), reject updates whose keys
        match _SECRET_KEYS. The UI-facing callers should pass False and
        use a dedicated higher-level function like update_admin_password
        for secret writes so secret-specific guardrails (hash, render)
        always run together.

    Returns:
      (backup_path, final_values) — backup_path is the .env.bak-* Path
      (or None if .env didn't exist) and final_values is the parsed
      snapshot after the write.

    Raises:
      ValueError on bad key names or secret-key violations.
      OSError on filesystem errors.
    """
    if not isinstance(updates, dict) or not updates:
        raise ValueError("update_env_keys requires a non-empty dict")

    # Validate every key before touching the file so a bad key aborts
    # the whole batch atomically.
    for key in updates.keys():
        if not _ENV_KEY_RE.match(key):
            raise ValueError(
                f"Invalid env key {key!r} — must match [A-Z][A-Z0-9_]*"
            )
        if not allow_secret_keys and _SECRET_KEYS.search(key):
            raise ValueError(
                f"{key!r} is a secret key. Use the dedicated helper for "
                f"secret updates so the render step runs atomically."
            )

    backup_path = backup_env_file()

    text = read_env_text() if ENV_FILE.exists() else ""
    for key, value in updates.items():
        # Stringify everything — .env is key=value, not JSON. Bool/int
        # get their natural repr; None becomes empty string.
        serialized = "" if value is None else str(value)
        _reject_env_control_chars(key, serialized)
        text = update_env_value_text(text, key, serialized)

    tmp_path = ENV_FILE.with_name(".env.new")
    try:
        tmp_path.write_text(text, encoding="utf-8")
        # The temp file becomes .env on rename, so it must already be 0600 —
        # otherwise there is a window where secrets sit world-readable.
        os.chmod(tmp_path, _ENV_MODE)
        # Re-read from disk to make sure the parser agrees with what we
        # intended. Catches broken quoting / control chars before we
        # commit the rename.
        roundtrip = parse_env_text(tmp_path.read_text(encoding="utf-8"))
        for key, value in updates.items():
            expected = "" if value is None else str(value)
            if roundtrip.get(key) != expected:
                raise ValueError(
                    f"Round-trip parse mismatch for {key!r}: "
                    f"wrote {expected!r}, read back {roundtrip.get(key)!r}"
                )
        # Atomic replace — on POSIX this is a single rename(). The destination
        # inode is REPLACED by the temp file's inode (0600), which is exactly
        # why we chmod the temp file above; the operation is crash-safe.
        os.replace(tmp_path, ENV_FILE)
        # Belt and braces: if .env pre-existed with looser perms and something
        # about the rename preserved them, force owner-only.
        os.chmod(ENV_FILE, _ENV_MODE)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    return backup_path, read_env_values()


def restore_env_from_backup(backup_path):
    """Copy a backup file back over .env. Used when a later step in a
    write flow (render script, container restart) fails and we need to
    leave the world as we found it. Returns True on success.
    """
    if backup_path is None or not Path(backup_path).exists():
        return False
    shutil.copy2(backup_path, ENV_FILE)
    os.chmod(ENV_FILE, _ENV_MODE)
    return True
