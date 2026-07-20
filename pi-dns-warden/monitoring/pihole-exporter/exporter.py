#!/usr/bin/env python3
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRAPE_TIMEOUT = float(os.environ.get("PIHOLE_EXPORTER_TIMEOUT_S", "10"))
LISTEN_ADDR = os.environ.get("PIHOLE_EXPORTER_LISTEN_ADDR", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PIHOLE_EXPORTER_LISTEN_PORT", "9617"))
EXPORT_CLIENT_METRICS = os.environ.get(
    "TORHOLE_EXPORT_CLIENT_METRICS", "false"
).strip().lower() in {"1", "true", "yes", "on"}


def _pihole_tls_context():
    """Verify against PIHOLE_CA_FILE if mounted (hostname check off — the pin
    is the CA, not the container-name SAN). Fallback: no verification —
    ACCEPTED RISK (audit S4/M3.3): scrapes travel the single-host internal
    dns_int bridge only; a MITM there already implies host compromise."""
    ca_file = os.environ.get("PIHOLE_CA_FILE", "").strip()
    if ca_file and os.path.exists(ca_file):
        context = ssl.create_default_context(cafile=ca_file)
        context.check_hostname = False
        return context
    return ssl._create_unverified_context()


SSL_CONTEXT = _pihole_tls_context()

TARGETS = [
    {
        "role": "trusted",
        "url": os.environ.get("PIHOLE_TRUSTED_URL", "https://pihole_trusted/api"),
        "password": os.environ.get("PIHOLE_TRUSTED_PASSWORD", ""),
    },
]
if os.environ.get("TORHOLE_TOPOLOGY", "vlan") == "vlan":
    TARGETS.append({
        "role": "iot",
        "url": os.environ.get("PIHOLE_IOT_URL", "https://pihole_iot/api"),
        "password": os.environ.get("PIHOLE_IOT_PASSWORD", ""),
    })

SESSION_CACHE = {}
SESSION_LOCK = threading.Lock()
HELP_LINES = [
    "# HELP pihole_exporter_up Whether the Pi-hole API scrape succeeded for this role.",
    "# TYPE pihole_exporter_up gauge",
    "# HELP pihole_exporter_scrape_duration_seconds Pi-hole API scrape duration for this role.",
    "# TYPE pihole_exporter_scrape_duration_seconds gauge",
    "# HELP pihole_queries_total Total queries observed by Pi-hole.",
    "# TYPE pihole_queries_total counter",
    "# HELP pihole_queries_blocked_total Total blocked queries observed by Pi-hole.",
    "# TYPE pihole_queries_blocked_total counter",
    "# HELP pihole_queries_forwarded_total Total forwarded queries observed by Pi-hole.",
    "# TYPE pihole_queries_forwarded_total counter",
    "# HELP pihole_queries_cached_total Total cached queries observed by Pi-hole.",
    "# TYPE pihole_queries_cached_total counter",
    "# HELP pihole_queries_unique_domains Unique domains seen by Pi-hole.",
    "# TYPE pihole_queries_unique_domains gauge",
    "# HELP pihole_queries_percent_blocked Blocked query ratio in percent.",
    "# TYPE pihole_queries_percent_blocked gauge",
    "# HELP pihole_queries_frequency_per_second Pi-hole query frequency.",
    "# TYPE pihole_queries_frequency_per_second gauge",
    "# HELP pihole_clients_active Active Pi-hole clients.",
    "# TYPE pihole_clients_active gauge",
    "# HELP pihole_clients_total Total Pi-hole clients.",
    "# TYPE pihole_clients_total gauge",
    "# HELP pihole_gravity_domains Total domains in gravity.",
    "# TYPE pihole_gravity_domains gauge",
    "# HELP pihole_gravity_last_update_timestamp_seconds Gravity last update timestamp.",
    "# TYPE pihole_gravity_last_update_timestamp_seconds gauge",
    "# HELP pihole_query_types_total Query type counts by Pi-hole role.",
    "# TYPE pihole_query_types_total counter",
    "# HELP pihole_query_status_total Query status counts by Pi-hole role.",
    "# TYPE pihole_query_status_total counter",
    "# HELP pihole_query_replies_total Reply type counts by Pi-hole role.",
    "# TYPE pihole_query_replies_total counter",
    "# HELP pihole_upstream_queries_total Queries sent to an upstream target.",
    "# TYPE pihole_upstream_queries_total counter",
    "# HELP pihole_upstream_response_seconds Upstream response time in seconds.",
    "# TYPE pihole_upstream_response_seconds gauge",
    "# HELP pihole_upstream_variance_seconds Upstream response variance in seconds squared.",
    "# TYPE pihole_upstream_variance_seconds gauge",
    "# HELP pihole_top_client_queries_total Query count for current top clients.",
    "# TYPE pihole_top_client_queries_total counter",
    "# HELP pihole_dns_cache_entries Current DNS cache entries by type and freshness.",
    "# TYPE pihole_dns_cache_entries gauge",
    "# HELP pihole_dns_cache_inserted_total Total items inserted into the DNS cache.",
    "# TYPE pihole_dns_cache_inserted_total counter",
    "# HELP pihole_dns_cache_expired_total Total expired DNS cache items.",
    "# TYPE pihole_dns_cache_expired_total counter",
    "# HELP pihole_dns_cache_evicted_total Total evicted DNS cache items.",
    "# TYPE pihole_dns_cache_evicted_total counter",
    "# HELP pihole_dns_replies_total DNS replies by path.",
    "# TYPE pihole_dns_replies_total counter",
    "# HELP pihole_ftl_cpu_percent Pi-hole FTL CPU usage percent.",
    "# TYPE pihole_ftl_cpu_percent gauge",
    "# HELP pihole_ftl_memory_percent Pi-hole FTL memory usage percent.",
    "# TYPE pihole_ftl_memory_percent gauge",
    "# HELP pihole_system_cpu_percent Pi-hole system CPU usage percent.",
    "# TYPE pihole_system_cpu_percent gauge",
    "# HELP pihole_system_memory_bytes Pi-hole system memory statistics.",
    "# TYPE pihole_system_memory_bytes gauge",
    "# HELP pihole_system_load_percent Pi-hole system load percentage per interval.",
    "# TYPE pihole_system_load_percent gauge",
    "# HELP pihole_version_info Version metadata for Pi-hole components.",
    "# TYPE pihole_version_info gauge",
]


def fmt_labels(labels):
    if not labels:
        return ""
    parts = []
    for key, value in sorted(labels.items()):
        val = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        parts.append(f'{key}="{val}"')
    return "{" + ",".join(parts) + "}"


def metric(lines, name, value, labels=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return
    if number != number:
        return
    lines.append(f"{name}{fmt_labels(labels or {})} {number}")


def api_call(base_url, path, method="GET", data=None, headers=None):
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=data,
        headers=headers or {},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=SCRAPE_TIMEOUT, context=SSL_CONTEXT) as response:
        return json.load(response)


def login(target):
    payload = json.dumps({"password": target["password"]}).encode()
    response = api_call(
        target["url"],
        "/auth",
        method="POST",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    sid = response["session"]["sid"]
    validity = response["session"].get("validity", 300)
    with SESSION_LOCK:
        SESSION_CACHE[target["role"]] = {
            "sid": sid,
            "expires_at": time.time() + max(60, int(validity) - 30),
        }
    return sid


def get_sid(target):
    with SESSION_LOCK:
        session = SESSION_CACHE.get(target["role"])
        if session and session["expires_at"] > time.time():
            return session["sid"]
    return login(target)


def fetch_json(target, path):
    sid = get_sid(target)
    headers = {"X-FTL-SID": sid}
    try:
        return api_call(target["url"], path, headers=headers)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            sid = login(target)
            return api_call(target["url"], path, headers={"X-FTL-SID": sid})
        raise


def scrape_target(target):
    role = target["role"]
    started = time.time()
    lines = []
    errors = []

    try:
        summary = fetch_json(target, "/stats/summary")
        upstreams = fetch_json(target, "/stats/upstreams")
        info_metrics = fetch_json(target, "/info/metrics")
        info_ftl = fetch_json(target, "/info/ftl")
        info_system = fetch_json(target, "/info/system")
        info_version = fetch_json(target, "/info/version")
        # Client IP/name labels are locally identifying and create unbounded
        # Prometheus cardinality. Keep them opt-in and avoid fetching the API
        # endpoint at all when disabled.
        top_clients = (
            fetch_json(target, "/stats/top_clients")
            if EXPORT_CLIENT_METRICS
            else {"clients": []}
        )
    except Exception as exc:  # noqa: BLE001
        metric(lines, "pihole_exporter_up", 0, {"role": role})
        metric(lines, "pihole_exporter_scrape_duration_seconds", time.time() - started, {"role": role})
        errors.append(f"# scrape_error role={role} error={str(exc).replace(chr(10), ' ')}")
        return lines, errors

    metric(lines, "pihole_exporter_up", 1, {"role": role})
    metric(lines, "pihole_exporter_scrape_duration_seconds", time.time() - started, {"role": role})

    queries = summary.get("queries", {})
    metric(lines, "pihole_queries_total", queries.get("total"), {"role": role})
    metric(lines, "pihole_queries_blocked_total", queries.get("blocked"), {"role": role})
    metric(lines, "pihole_queries_forwarded_total", queries.get("forwarded"), {"role": role})
    metric(lines, "pihole_queries_cached_total", queries.get("cached"), {"role": role})
    metric(lines, "pihole_queries_unique_domains", queries.get("unique_domains"), {"role": role})
    metric(lines, "pihole_queries_percent_blocked", queries.get("percent_blocked"), {"role": role})
    metric(lines, "pihole_queries_frequency_per_second", queries.get("frequency"), {"role": role})

    clients = summary.get("clients", {})
    metric(lines, "pihole_clients_active", clients.get("active"), {"role": role})
    metric(lines, "pihole_clients_total", clients.get("total"), {"role": role})

    gravity = summary.get("gravity", {})
    metric(lines, "pihole_gravity_domains", gravity.get("domains_being_blocked"), {"role": role})
    metric(lines, "pihole_gravity_last_update_timestamp_seconds", gravity.get("last_update"), {"role": role})

    for query_type, count in queries.get("types", {}).items():
        metric(lines, "pihole_query_types_total", count, {"role": role, "query_type": query_type})
    for status, count in queries.get("status", {}).items():
        metric(lines, "pihole_query_status_total", count, {"role": role, "status": status})
    for reply, count in queries.get("replies", {}).items():
        metric(lines, "pihole_query_replies_total", count, {"role": role, "reply": reply})

    for upstream in upstreams.get("upstreams", []):
        labels = {
            "role": role,
            "upstream": upstream.get("name") or upstream.get("ip"),
            "ip": upstream.get("ip"),
            "port": upstream.get("port"),
        }
        metric(lines, "pihole_upstream_queries_total", upstream.get("count"), labels)
        stats = upstream.get("statistics", {})
        metric(lines, "pihole_upstream_response_seconds", stats.get("response"), labels)
        metric(lines, "pihole_upstream_variance_seconds", stats.get("variance"), labels)

    for client in top_clients.get("clients", []):
        labels = {
            "role": role,
            "client_ip": client.get("ip"),
            "client_name": client.get("name") or client.get("ip"),
        }
        metric(lines, "pihole_top_client_queries_total", client.get("count"), labels)

    cache = info_metrics.get("metrics", {}).get("dns", {}).get("cache", {})
    metric(lines, "pihole_dns_cache_inserted_total", cache.get("inserted"), {"role": role})
    metric(lines, "pihole_dns_cache_expired_total", cache.get("expired"), {"role": role})
    metric(lines, "pihole_dns_cache_evicted_total", cache.get("evicted"), {"role": role})
    for entry in cache.get("content", []):
        metric(
            lines,
            "pihole_dns_cache_entries",
            entry.get("count", {}).get("valid"),
            {"role": role, "query_type": entry.get("name"), "state": "valid"},
        )
        metric(
            lines,
            "pihole_dns_cache_entries",
            entry.get("count", {}).get("stale"),
            {"role": role, "query_type": entry.get("name"), "state": "stale"},
        )

    replies = info_metrics.get("metrics", {}).get("dns", {}).get("replies", {})
    for reply_type, count in replies.items():
        metric(lines, "pihole_dns_replies_total", count, {"role": role, "path": reply_type})

    ftl = info_ftl.get("ftl", {})
    metric(lines, "pihole_ftl_cpu_percent", ftl.get("%cpu"), {"role": role})
    metric(lines, "pihole_ftl_memory_percent", ftl.get("%mem"), {"role": role})

    system = info_system.get("system", {})
    metric(lines, "pihole_system_cpu_percent", system.get("cpu", {}).get("%cpu"), {"role": role})
    for segment, data in system.get("memory", {}).items():
        for field, value in data.items():
            metric(lines, "pihole_system_memory_bytes", value, {"role": role, "memory": segment, "field": field})
    for interval, percent in zip(["1m", "5m", "15m"], system.get("cpu", {}).get("load", {}).get("percent", [])):
        metric(lines, "pihole_system_load_percent", percent, {"role": role, "interval": interval})

    version = info_version.get("version", {})
    for component in ["core", "web", "ftl"]:
        local = version.get(component, {}).get("local", {})
        metric(
            lines,
            "pihole_version_info",
            1,
            {
                "role": role,
                "component": component,
                "version": local.get("version", ""),
                "branch": local.get("branch", ""),
                "hash": local.get("hash", ""),
            },
        )
    metric(
        lines,
        "pihole_version_info",
        1,
        {
            "role": role,
            "component": "docker",
            "version": version.get("docker", {}).get("local", ""),
            "branch": "",
            "hash": "",
        },
    )

    return lines, errors


def render_metrics():
    lines = list(HELP_LINES)
    for target in TARGETS:
        target_lines, target_errors = scrape_target(target)
        lines.extend(target_lines)
        lines.extend(target_errors)
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        payload = render_metrics().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):  # noqa: A003
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler)
    server.serve_forever()
