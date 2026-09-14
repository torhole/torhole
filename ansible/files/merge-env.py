#!/usr/bin/env python3
"""Atomically update operator-managed dotenv keys, retaining generated secrets.

Values remain literal text: no shell evaluation, interpolation, or secret output.
"""
import os
from pathlib import Path
import re
import sys
import tempfile


def read_entries(path):
    entries = []
    for line in path.read_text().splitlines(keepends=True):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            entries.append((None, line))
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, separator, _ = stripped.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid dotenv entry; destination left unchanged")
        entries.append((key, line if line.endswith("\n") else line + "\n"))
    return entries


def merge(candidate, destination):
    managed = read_entries(candidate)
    keys = {key for key, _ in managed if key is not None}
    existing = read_entries(destination) if destination.exists() else []
    content = "".join(line for key, line in existing if key not in keys)
    if content and not content.endswith("\n"):
        content += "\n"
    content += "".join(line for key, line in managed if key is not None)
    # Idempotent on subsequent runs even when the template contains comments.
    if destination.exists() and destination.read_text() == content:
        destination.chmod(0o600)
        return
    fd, temporary = tempfile.mkstemp(prefix=".env-ansible-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    merge(Path(sys.argv[1]), Path(sys.argv[2]))
