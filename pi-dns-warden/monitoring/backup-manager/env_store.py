"""env_store — the single owner of .env I/O for the torhole backend.

Extracted from server.py (T-048 step 1). Everything that reads or writes the
.env file lives here: the literal (non-shell) parser, the atomic
backup-then-write update path, the 0600 lifecycle guarantees, and the
secret-key guardrails. server.py re-exports these names for compatibility.
"""

import os
import re
import shlex
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

ROOT_DIR = Path(os.environ.get("TORHOLE_ROOT_DIR", "/workspace")).resolve()
ENV_FILE = ROOT_DIR / ".env"

# Keys whose values must never flow through the generic config-update path.
# update_env_keys rejects them unless allow_secret_keys=True; dedicated
# helpers (update_admin_password, notification-channel writes) own them.
_SECRET_KEYS = re.compile(r"(PASSWORD|SECRET|KEY|TOKEN|PASS)", re.IGNORECASE)

# One lock covers both individual writes and callers that may roll them back.
# Reentrancy lets those callers hold the transaction through rendering/reload.
_ENV_LOCK = threading.RLock()


def serialized_env_operation(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with _ENV_LOCK:
            return function(*args, **kwargs)
    return wrapped


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
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, raw_value = stripped.split("=", 1)
        raw_value = raw_value.strip()
        # Match ops/lib/load-env.sh: parse quoting, never evaluate shell code.
        if raw_value.startswith(("'", '"')):
            parts = shlex.split(raw_value, comments=True, posix=True)
            if len(parts) > 1:
                raise ValueError(f"Unexpected tokens after quoted value for {key.strip()}")
            value = parts[0] if parts else ""
        else:
            value = re.split(r"\s+#", raw_value, maxsplit=1)[0].rstrip()
        values[key.strip()] = value
    return values


def read_env_values():
    return parse_env_text(read_env_text())


def read_env_values_safe():
    try:
        return read_env_values()
    except FileNotFoundError:
        return {}


def update_env_value_text(text, key, value):
    replacement = f"{key}={shlex.quote(value)}"
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(lambda _: replacement, text, count=1)

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

def _reject_env_control_chars(key, value):
    """A value that contains a newline, carriage return or NUL would split into
    extra .env lines (smuggling a second key) or truncate the file. Reject them
    before anything is written."""
    if any(c in value for c in ("\n", "\r", "\x00")):
        raise ValueError(f"Value for {key!r} may not contain newlines or NUL bytes.")


@serialized_env_operation
def backup_env_file():
    """Copy the current .env to a timestamped sibling file. Returns the
    backup path so callers can log it or reference it on rollback.

    Non-fatal if .env is missing — returns None (nothing to back up).
    """
    if not ENV_FILE.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    fd, name = tempfile.mkstemp(prefix=f".env.bak-{stamp}-", dir=ENV_FILE.parent)
    backup_path = Path(name)
    try:
        with os.fdopen(fd, "wb") as target, ENV_FILE.open("rb") as source:
            shutil.copyfileobj(source, target)
    except Exception:
        backup_path.unlink(missing_ok=True)
        raise
    return backup_path


def _atomic_env_write(text):
    # mkstemp creates a unique, exclusive 0600 inode before any secrets enter it.
    fd, name = tempfile.mkstemp(prefix=".env.new-", dir=ENV_FILE.parent)
    tmp_path = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(text)
        os.replace(tmp_path, ENV_FILE)
    finally:
        tmp_path.unlink(missing_ok=True)


@serialized_env_operation
def update_env_keys(updates, *, allow_secret_keys=False):
    """Apply a batch of {key: value} updates to .env atomically.

    Validates the new text parses back to the expected values, writes to
    a private unique sibling file, then renames it over .env. If anything in that
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

    roundtrip = parse_env_text(text)
    for key, value in updates.items():
        expected = "" if value is None else str(value)
        if roundtrip.get(key) != expected:
            raise ValueError(
                f"Round-trip parse mismatch for {key!r}: "
                f"wrote {expected!r}, read back {roundtrip.get(key)!r}"
            )
    _atomic_env_write(text)

    return backup_path, read_env_values()


@serialized_env_operation
def restore_env_text(text):
    _atomic_env_write(text)


@serialized_env_operation
def restore_env_from_backup(backup_path):
    """Copy a backup file back over .env. Used when a later step in a
    write flow (render script, container restart) fails and we need to
    leave the world as we found it. Returns True on success.
    """
    if backup_path is None or not Path(backup_path).exists():
        return False
    restore_env_text(Path(backup_path).read_text(encoding="utf-8"))
    return True
