"""pihole_client — Pi-hole v6 API access layer.

Extracted from server.py (T-048 step 4). Owns the plane targets, the TLS
context policy (PIHOLE_CA_FILE pin or documented unverified fallback), the
cached-SID session pattern (the fix for the original session-leak bug),
API probing, query fetching and normalization. Composition (snapshot
assembly, insights caching) stays in server.py.
"""

import json
import os
import ssl
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


PIHOLE_API_TARGETS = (
    {
        "id": "trusted",
        "label": "Trusted",
        "url_key": "PIHOLE_TRUSTED_URL",
        "password_key": "PIHOLE_TRUSTED_PASSWORD",
        "default_url": "https://pihole_trusted/api",
    },
    {
        "id": "iot",
        "label": "IoT",
        "url_key": "PIHOLE_IOT_URL",
        "password_key": "PIHOLE_IOT_PASSWORD",
        "default_url": "https://pihole_iot/api",
    },
)


def _pihole_tls_context():
    """TLS context for internal Pi-hole API calls (audit S4/M3.3).

    Pi-hole serves a self-signed certificate on the internal dns_int bridge.
    If PIHOLE_CA_FILE points to a mounted CA/cert bundle, verify against it
    (hostname checking stays off — the container-name SANs don't match the
    generated cert; the pin is the CA, not the name). Otherwise fall back to
    no verification: ACCEPTED RISK — both endpoints are containers on the
    same single-host internal bridge, so a man-in-the-middle there already
    implies host or container compromise strictly stronger than what
    DNS-stats interception would grant.
    """
    ca_file = os.environ.get("PIHOLE_CA_FILE", "").strip()
    if ca_file and Path(ca_file).exists():
        context = ssl.create_default_context(cafile=ca_file)
        context.check_hostname = False
        return context
    return ssl._create_unverified_context()


PIHOLE_SSL_CONTEXT = _pihole_tls_context()


PIHOLE_API_TIMEOUT = float(os.environ.get("PIHOLE_API_TIMEOUT_S", "5"))


_PIHOLE_SID_CACHE = {}


_PIHOLE_SID_LOCK = threading.Lock()


def pihole_api_call(base_url, path, method="GET", data=None, headers=None):
    request = Request(
        base_url.rstrip("/") + path,
        data=data,
        headers=headers or {},
        method=method,
    )
    with urlopen(request, timeout=PIHOLE_API_TIMEOUT, context=PIHOLE_SSL_CONTEXT) as response:
        return json.load(response)


def pihole_logout(base_url, sid):
    # Pi-hole v6 sessions persist until DELETE /auth or expiry; without this the
    # session table fills up and subsequent /auth POSTs return HTTP 429.
    if not sid:
        return
    try:
        pihole_api_call(base_url, "/auth", method="DELETE", headers={"X-FTL-SID": sid})
    except Exception:  # noqa: BLE001
        pass


def probe_pihole_api(target, values):
    base_url = values.get(target["url_key"], target["default_url"])
    password = values.get(target["password_key"], "")
    if not password:
        return {
            "id": target["id"],
            "label": target["label"],
            "status": "offline",
            "detail": "Pi-hole API password is not configured.",
        }

    sid = None
    try:
        login_payload = json.dumps({"password": password}).encode("utf-8")
        login = pihole_api_call(
            base_url,
            "/auth",
            method="POST",
            data=login_payload,
            headers={"Content-Type": "application/json"},
        )
        sid = login["session"]["sid"]
        summary = pihole_api_call(base_url, "/stats/summary", headers={"X-FTL-SID": sid})
    except HTTPError as exc:
        pihole_logout(base_url, sid)
        if exc.code == 401:
            detail = "Pi-hole API rejected authentication."
        else:
            detail = f"Pi-hole API returned HTTP {exc.code}."
        status = "offline" if exc.code >= 500 else "degraded"
        return {"id": target["id"], "label": target["label"], "status": status, "detail": detail}
    except URLError as exc:
        pihole_logout(base_url, sid)
        return {
            "id": target["id"],
            "label": target["label"],
            "status": "offline",
            "detail": f"Pi-hole API is unreachable: {exc.reason}.",
        }
    except Exception as exc:  # noqa: BLE001
        pihole_logout(base_url, sid)
        return {
            "id": target["id"],
            "label": target["label"],
            "status": "degraded",
            "detail": f"Pi-hole API probe failed: {str(exc)}",
        }

    pihole_logout(base_url, sid)
    total_queries = summary.get("queries", {}).get("total")
    blocked = summary.get("queries", {}).get("blocked")
    query_text = f"{int(total_queries):,} queries" if isinstance(total_queries, (int, float)) else "query stats available"
    blocked_text = f"{int(blocked):,} blocked" if isinstance(blocked, (int, float)) else "block stats available"
    return {
        "id": target["id"],
        "label": target["label"],
        "status": "healthy",
        "detail": f"Pi-hole API responding, {query_text}, {blocked_text}.",
    }


def _pihole_get_with_cached_sid(target, values, path):
    """GET a Pi-hole API path using a cached SID; rebuild on 401.

    Returns the parsed JSON body, or None on failure. Does NOT log out the
    session — the cached SID is reused across calls to avoid the auth churn
    that triggered the original session-leak bug.
    """
    plane_id = target["id"]
    base_url = values.get(target["url_key"], target["default_url"])

    for attempt in range(2):
        with _PIHOLE_SID_LOCK:
            sid = _PIHOLE_SID_CACHE.get(plane_id)

        if not sid:
            password = values.get(target["password_key"], "")
            if not password:
                return None
            try:
                login_payload = json.dumps({"password": password}).encode("utf-8")
                login = pihole_api_call(
                    base_url,
                    "/auth",
                    method="POST",
                    data=login_payload,
                    headers={"Content-Type": "application/json"},
                )
                sid = login["session"]["sid"]
                with _PIHOLE_SID_LOCK:
                    _PIHOLE_SID_CACHE[plane_id] = sid
            except Exception:
                return None

        try:
            return pihole_api_call(base_url, path, headers={"X-FTL-SID": sid})
        except HTTPError as exc:
            if exc.code == 401 and attempt == 0:
                # Session expired or invalid — invalidate and retry once.
                with _PIHOLE_SID_LOCK:
                    _PIHOLE_SID_CACHE.pop(plane_id, None)
                continue
            return None
        except Exception:
            return None
    return None


def _fetch_pihole_queries(target, values, n):
    """Fetch the latest n queries from a Pi-hole. Returns a list of normalized
    query dicts (newest last) suitable for SSE streaming."""
    payload = _pihole_get_with_cached_sid(target, values, f"/queries?length={n}")
    if not payload:
        return []
    raw_queries = payload.get("queries") or []
    out = []
    for raw in raw_queries:
        try:
            out.append(_normalize_pihole_query(raw, target["id"]))
        except Exception:
            continue
    # Pi-hole returns newest first; reverse so SSE clients see chronological order.
    out.reverse()
    return out


def _normalize_query_status(raw):
    if not raw:
        return "other"
    s = str(raw).upper()
    if "GRAVITY" in s or "REGEX" in s or "DENYLIST" in s or s.startswith("EXTERNAL_BLOCKED"):
        return "blocked"
    if s in ("FORWARDED", "RETRIED", "RETRIED_DNSSEC"):
        return "forwarded"
    if s in ("CACHE", "CACHE_STALE"):
        return "cached"
    return "other"


def _normalize_pihole_query(raw, plane_id):
    """Map Pi-hole v6 /api/queries entry to the SSE wire format.

    Note: Pi-hole does NOT log the resolved IP address. The `reply` object
    in Pi-hole v6 only carries the reply `type` (IP / CNAME / NXDOMAIN /
    etc.) and `time` (query latency in seconds). The actual resolution
    happens upstream (dnscrypt → Tor → exit resolver) and the answer
    flows back to the client without being recorded by Pi-hole. The
    frontend renders reply_type + reply_time_ms in the "reply" column
    since the IP itself is never available.
    """
    client = raw.get("client") or {}
    reply = raw.get("reply") or {}
    reply_type = reply.get("type") if isinstance(reply, dict) else None
    reply_time_s = reply.get("time") if isinstance(reply, dict) else None
    reply_time_ms = (
        round(reply_time_s * 1000, 2) if isinstance(reply_time_s, (int, float)) else None
    )
    return {
        "id": raw.get("id"),
        "plane": plane_id,
        "time": raw.get("time"),  # unix epoch float
        "domain": raw.get("domain"),
        "type": raw.get("type"),
        "status": _normalize_query_status(raw.get("status")),
        "raw_status": raw.get("status"),
        "client_ip": client.get("ip") if isinstance(client, dict) else None,
        "client_name": client.get("name") if isinstance(client, dict) else None,
        "reply_type": reply_type,
        "reply_time_ms": reply_time_ms,
    }
