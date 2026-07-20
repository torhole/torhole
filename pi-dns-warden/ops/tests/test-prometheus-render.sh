#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME="$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"
BACKUP="$(mktemp)"
cp "$RUNTIME" "$BACKUP"
trap 'cp "$BACKUP" "$RUNTIME"; rm -f "$BACKUP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local pattern="$1"
  grep -Fq -- "$pattern" "$RUNTIME" || fail "missing $pattern"
}

assert_not_contains() {
  local pattern="$1"
  if grep -Fq -- "$pattern" "$RUNTIME"; then
    fail "unexpected $pattern"
  fi
}

render() {
  local topology="$1"
  local web_mode="$2"
  TORHOLE_TOPOLOGY="$topology" TORHOLE_WEB_MODE="$web_mode" \
    bash "$ROOT_DIR/ops/scripts/13-render-prometheus.sh" >/dev/null
  assert_contains 'job_name: "alertmanager"'
  assert_contains 'targets: ["alertmanager:9093"]'
}

render single-lan https-local
assert_contains '"reverse-proxy:443"'
assert_not_contains 'pihole_iot:53'
assert_not_contains 'dnscrypt_iot:5053'
assert_not_contains 'http://pihole_iot/admin/login'

render single-lan http
assert_contains '"reverse-proxy:80"'
assert_not_contains '"reverse-proxy:443"'
assert_not_contains 'pihole_iot:53'

render vlan https-local
assert_contains '"reverse-proxy:443"'
assert_contains 'pihole_iot:53'
assert_contains 'dnscrypt_iot:5053'
assert_contains 'http://pihole_iot/admin/login'

render vlan http
assert_contains '"reverse-proxy:80"'
assert_not_contains '"reverse-proxy:443"'
assert_contains 'pihole_iot:53'

echo "OK: Prometheus targets render for every Advanced topology/web mode"
