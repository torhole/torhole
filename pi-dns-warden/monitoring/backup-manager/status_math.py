"""status_math — pure helpers for status ranking, counting and time display.

Extracted from server.py (T-048 step 2). No I/O, no state: these are the
building blocks the snapshot/composition layer uses to reduce container and
plane states into the traffic-light model the UI renders. server.py
re-exports every name for compatibility.
"""

from datetime import datetime, timezone


def is_truthy(value):
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_iso_datetime(value):
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def humanize_time_ago(value):
    parsed = parse_iso_datetime(value)
    if parsed is None:
        return "unknown time"

    now = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    delta = now - parsed.astimezone(timezone.utc)
    seconds = max(int(delta.total_seconds()), 0)
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        minutes = seconds // 60
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"
    if seconds < 86400:
        hours = seconds // 3600
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    days = seconds // 86400
    return f"{days} day{'s' if days != 1 else ''} ago"


def status_rank(status):
    if status == "offline":
        return 2
    if status == "degraded":
        return 1
    return 0


def combine_statuses(*statuses):
    overall = "healthy"
    for status in statuses:
        if status_rank(status) > status_rank(overall):
            overall = status
    return overall


def service_counts(services):
    counts = {"healthy": 0, "degraded": 0, "offline": 0, "total": len(services)}
    for service in services:
        state = service.get("status", "offline")
        if state not in counts:
            state = "offline"
        counts[state] += 1
    return counts


def overall_status_from_counts(counts):
    if counts["offline"] > 0:
        return "offline"
    if counts["degraded"] > 0:
        return "degraded"
    return "healthy"


def summary_from_counts(counts):
    return (
        f"{counts['healthy']} healthy"
        f", {counts['degraded']} degraded"
        f", {counts['offline']} offline"
    )


def utc_now():
    return datetime.now(timezone.utc).isoformat()
