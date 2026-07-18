#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

REMOTE="$TEST_ROOT/remote.git"
SOURCE="$TEST_ROOT/source"
INSTALL="$TEST_ROOT/install"

git init --bare --quiet "$REMOTE"
git init --quiet --initial-branch=main "$SOURCE"
git -C "$SOURCE" config user.name "Torhole test"
git -C "$SOURCE" config user.email "test@torhole.invalid"

printf 'one\n' >"$SOURCE/version"
git -C "$SOURCE" add version
git -C "$SOURCE" commit --quiet -m "version one"
git -C "$SOURCE" remote add origin "file://$REMOTE"
git -C "$SOURCE" push --quiet -u origin main

TORHOLE_REPO_URL="file://$REMOTE" \
TORHOLE_INSTALL_DIR="$INSTALL" \
TORHOLE_DOWNLOAD_ONLY=1 \
bash "$REPO_ROOT/get-torhole.sh" >/dev/null

[[ -f "$INSTALL/.git/shallow" ]] || {
  echo "FAIL: initial installation was expected to be shallow"
  exit 1
}

printf 'two\n' >"$SOURCE/version"
git -C "$SOURCE" commit --quiet -am "version two"
printf 'three\n' >"$SOURCE/version"
git -C "$SOURCE" commit --quiet -am "version three"
git -C "$SOURCE" push --quiet

TORHOLE_REPO_URL="file://$REMOTE" \
TORHOLE_INSTALL_DIR="$INSTALL" \
TORHOLE_DOWNLOAD_ONLY=1 \
bash "$REPO_ROOT/get-torhole.sh" >/dev/null

expected="$(git -C "$SOURCE" rev-parse HEAD)"
actual="$(git -C "$INSTALL" rev-parse HEAD)"
[[ "$actual" == "$expected" ]] || {
  echo "FAIL: shallow installation did not update to the remote tip"
  exit 1
}
[[ ! -f "$INSTALL/.git/shallow" ]] || {
  echo "FAIL: existing shallow installation was not converted before update"
  exit 1
}

echo "get-torhole shallow-update test passed"
