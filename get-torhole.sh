#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${TORHOLE_REPO_URL:-https://github.com/torhole/torhole.git}"
REPO_REF="${TORHOLE_REF:-main}"
INSTALL_DIR="${TORHOLE_INSTALL_DIR:-${HOME}/torhole}"

say() {
  printf '%s\n' "$*"
}

install_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1 || [[ ! -f /etc/debian_version ]]; then
    say "Git is required. Install Git, then run the Torhole command again."
    exit 1
  fi

  local answer="${TORHOLE_INSTALL_GIT:-}"
  if [[ "$answer" != "1" ]]; then
    if [[ ! -r /dev/tty ]]; then
      say "Git is required. Re-run from a terminal, or set TORHOLE_INSTALL_GIT=1."
      exit 1
    fi
    read -r -p "Git is required. Install it now? [Y/n] " answer </dev/tty
    case "${answer:-y}" in
      y|Y|yes|YES) ;;
      *)
        say "Installation cancelled."
        exit 1
        ;;
    esac
  fi

  local -a elevate=()
  if [[ "$(id -u)" != "0" ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      say "Installing Git requires root access, but sudo is unavailable."
      exit 1
    fi
    elevate=(sudo)
  fi
  "${elevate[@]}" apt-get update
  "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y git
}

download_torhole() {
  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
    say "Refusing to replace existing non-Git path: $INSTALL_DIR"
    say "Set TORHOLE_INSTALL_DIR to choose another location."
    exit 1
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    local current_origin
    current_origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
    case "$current_origin" in
      "$REPO_URL"|https://github.com/torhole/torhole.git|git@github.com:torhole/torhole.git) ;;
      *)
        say "Refusing to update an unexpected Git repository in $INSTALL_DIR"
        say "Current origin: ${current_origin:-missing}"
        exit 1
        ;;
    esac
    say "Updating Torhole in ${INSTALL_DIR}..."
    # A second depth-1 fetch can leave the old and new tips as unrelated
    # shallow boundaries. Git then cannot prove that --ff-only is safe even
    # when the remote branch is a direct descendant. Convert the existing
    # shallow clone once, then keep all later updates as ordinary fast-forwards.
    if [[ -f "$INSTALL_DIR/.git/shallow" ]]; then
      git -C "$INSTALL_DIR" fetch --unshallow origin "$REPO_REF"
    else
      git -C "$INSTALL_DIR" fetch origin "$REPO_REF"
    fi
    git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD
  else
    say "Downloading Torhole to ${INSTALL_DIR}..."
    git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
  fi
}

install_git
download_torhole

if [[ "${TORHOLE_DOWNLOAD_ONLY:-0}" == "1" ]]; then
  say "Torhole downloaded successfully."
  exit 0
fi

say "Opening the guided Torhole installer..."
if [[ -r /dev/tty ]]; then
  exec "$INSTALL_DIR/install.sh" </dev/tty
fi
exec "$INSTALL_DIR/install.sh"
