"""Validate recovery payloads before any service or installation is changed."""
import argparse
import gzip
import json
import posixpath
import re
from pathlib import Path, PurePosixPath
import sys
import tarfile

FILES = (".env", "docker-compose.yml", "docker-compose.monitoring.yml", "deploy.sh") + tuple(
    "ops/scripts/" + name for name in (
        "17-render-alertmanager.sh", "16-render-reverse-proxy-dns.sh",
        "13-render-prometheus.sh", "14-render-caddy-topology.sh",
        "19-validate-stack.sh", "20-up.sh",
    )
)
DIRECTORIES = ("dnscrypt", "monitoring", "ops", "pihole", "tor", "tor-image")


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Archive contains an unsafe path")
    return str(path)


def resolve_link(name, members, boundary=0):
    """Resolve against the archive's virtual tree, including intermediate links."""
    pending = name.split("/")
    resolved = []
    followed = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if len(resolved) <= boundary:
                raise ValueError("Archive link escapes its restore directory")
            resolved.pop()
            continue
        member = members.get("/".join(resolved + [part]))
        if member and (member.issym() or member.islnk()):
            followed += 1
            if followed > 40:
                raise ValueError("Archive contains a cyclic or excessively deep link")
            if member.islnk():
                resolved = []
            pending = member.linkname.split("/") + pending
        else:
            resolved.append(part)
    return "/".join(resolved)


def inspect_members(archive):
    members = {}
    for member in archive.getmembers():
        name = safe_path(member.name)
        if name in members or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("Archive contains duplicate paths or special files")
        if member.issym() or member.islnk():
            target = member.linkname
            if posixpath.isabs(target):
                raise ValueError("Archive contains an absolute link")
            if member.issym():
                target = posixpath.join(posixpath.dirname(name), target)
            safe_path(posixpath.normpath(target))
        members[name] = member
    # Even a safe link must not redirect extraction of another member.
    for name, member in members.items():
        for parent in PurePosixPath(name).parents:
            ancestor = members.get(str(parent))
            if ancestor and not ancestor.isdir():
                raise ValueError("Archive member has a non-directory parent")
        if member.islnk():
            target = members.get(safe_path(member.linkname))
            if not target or not target.isfile():
                raise ValueError("Archive hard link does not target a regular file")
        if member.issym() or member.islnk():
            resolve_link(name, members)
    return members


def verify_gzip(stream):
    # Tar readers may stop at the tar end marker before checking the gzip CRC.
    with gzip.GzipFile(fileobj=stream) as compressed:
        while compressed.read(1024 * 1024):
            pass
    stream.seek(0)


def inspect_backup(archive):
    members = inspect_members(archive)
    modern = "project" in members
    prefix = "project/" if modern else ""
    if modern:
        for name, member in members.items():
            if name.startswith(prefix) and (member.issym() or member.islnk()):
                target = resolve_link(name, members, boundary=1)
                if target != "project" and not target.startswith(prefix):
                    raise ValueError("Archive link escapes the project restore directory")
    for name in FILES:
        member = members.get(prefix + name)
        if not member or not member.isfile():
            raise ValueError("Backup is missing a required project file: " + name)
    for name in DIRECTORIES:
        member = members.get(prefix + name)
        if not member or not member.isdir():
            raise ValueError("Backup is missing a required project directory: " + name)
    if modern:
        metadata_member = members.get("metadata.json")
        if not metadata_member or not metadata_member.isfile() or metadata_member.size > 1024 * 1024:
            raise ValueError("Backup metadata is missing or invalid")
        with archive.extractfile(metadata_member) as stream:
            metadata = json.load(stream)
        if not isinstance(metadata, dict) or metadata.get("format_version") != 2:
            raise ValueError("Unsupported backup format version")
        captured = metadata.get("captured_volumes")
        if not isinstance(captured, list) or not all(isinstance(v, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", v) for v in captured):
            raise ValueError("Invalid captured volume inventory")
        for volume in captured:
            payload = members.get("volumes/" + volume + ".tar.gz")
            if not payload or not payload.isfile():
                raise ValueError("Backup is missing a captured volume payload")
    # Validate every included volume, not only those listed by metadata.
    for name, member in members.items():
        # BSD tar can add AppleDouble sidecars. They are not volume payloads
        # and restore_volumes never consumes them.
        if PurePosixPath(name).name.startswith("._"):
            continue
        if name.startswith("volumes/") and name.endswith(".tar.gz"):
            if not member.isfile():
                raise ValueError("Volume payload must be a regular file")
            with archive.extractfile(member) as stream:
                verify_gzip(stream)
                with tarfile.open(fileobj=stream, mode="r:gz") as volume:
                    inspect_members(volume)


def check_tree(root):
    root = Path(root)
    project = root / "project" if (root / "project").is_dir() else root
    if project.is_symlink():
        raise ValueError("Project directory must not be a link")
    for name in FILES:
        path = project / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Restore tree is missing a required file: " + name)
    for name in DIRECTORIES:
        path = project / name
        if path.is_symlink() or not path.is_dir():
            raise ValueError("Restore tree is missing a required directory: " + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("validate", "extract", "check-tree"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", nargs="?", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "check-tree":
            check_tree(args.source)
            return
        with args.source.open("rb") as stream:
            verify_gzip(stream)
            with tarfile.open(fileobj=stream, mode="r:gz") as archive:
                inspect_backup(archive)
                if args.operation == "extract":
                    if args.destination is None:
                        raise ValueError("Extraction requires a staging directory")
                    args.destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if args.destination.is_symlink() or any(args.destination.iterdir()):
                        raise ValueError("Staging directory must be empty and must not be a link")
                    # Members and links have been checked above, including on
                    # older Python versions without extraction filters.
                    options = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
                    archive.extractall(args.destination, **options)
                    # The data filter deliberately drops directory modes, so
                    # a private caller umask otherwise makes service bind mounts
                    # untraversable. Reapply only safe bits after extraction,
                    # deepest first; the same sanitization covers older Python.
                    directories = (member for member in archive.getmembers() if member.isdir())
                    for member in sorted(directories, key=lambda item: len(PurePosixPath(item.name).parts), reverse=True):
                        (args.destination / member.name).chmod(member.mode & 0o755)
                    check_tree(args.destination)
    except (OSError, EOFError, ValueError, tarfile.TarError) as exc:
        # Do not include file contents (the archive contains credentials).
        print("Recovery preflight failed: " + str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
