/*
 * Typed client for /api/system/snapshot.
 *
 * The snapshot is the single source of truth for the v2 UI. Every screen
 * reads from one shared hook (useSnapshot) which polls this endpoint at a
 * fixed interval. There is exactly one place that fetches it.
 *
 * The schema mirrors the shape returned by backup-manager/server.py
 * _compute_snapshot(). schema_version is checked at runtime so the UI can
 * fail loudly if the backend drifts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_POLL_MS = 5000;

export type StatusKind = "healthy" | "degraded" | "offline";

export interface PlaneStat {
  id: string;
  label: string;
  status: StatusKind | string;
  detail?: string;
  queries_today?: number;
  blocked_today?: number;
  percent_blocked?: number;
  domains_on_blocklist?: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  label: string;
  status: StatusKind | string;
  started_at: string | null;
  restart_count: number | null;
  core: boolean;
}

export interface Counts {
  healthy: number;
  degraded: number;
  offline: number;
  total: number;
}

export interface BootstrapState {
  status: StatusKind | string;
  detail?: string;
  percent?: number;
}

export interface IsolationState {
  status: StatusKind | string;
  detail?: string;
}

export interface TorRelayHop {
  fp: string;
  nickname: string;
}

export interface TorCircuit {
  id: string;
  state: string;
  purpose: string | null;
  build_flags: string[];
  time_created: string | null;
  socks_username: string | null;
  conflux_id: string | null;
  path: TorRelayHop[];
  hops: number;
}

export interface TorCircuits {
  available: boolean;
  reason: string | null;
  items: TorCircuit[];
  by_plane: {
    trusted: string[];
    iot: string[];
  };
  count: number;
  fetched_at: string;
}

/** Live runtime info for the Tor process, read via the control port. The
 *  same data is exported as Prometheus metrics at /api/metrics/tor for
 *  scraping by Grafana. */
export interface TorRuntimeInfo {
  available: boolean;
  reason: string | null;
  /** 0-100. 100 means Tor is ready to carry traffic. */
  bootstrap_percent: number;
  /** Short status summary from `GETINFO status/bootstrap-phase`. */
  bootstrap_summary: string;
  /** "up" | "down" | "" (unknown). */
  network_liveness: string;
  /** True if Tor believes it can build new circuits right now. */
  circuit_established: boolean;
  enough_dir_info: boolean;
  version: string;
  traffic_read_bytes: number;
  traffic_written_bytes: number;
  entry_guards_count: number;
  fetched_at: string;
}

export interface LeakTestResult {
  pass: boolean;
  is_tor: boolean;
  ip: string | null;
  target: string;
  ran_at: string;
  duration_ms: number;
  error: string | null;
}

export interface LeakTestHistoryEntry {
  pass: boolean;
  ran_at: string;
}

export interface LeakTestState {
  available: boolean;
  reason: string | null;
  last_result: LeakTestResult | null;
  last_run_at: string | null;
  history_count: number;
  recent_pass_rate: number | null;
  /** Optional on the type because an older backend (before we added this
   *  field) won't return it. Frontend must default to [] when reading. */
  history?: LeakTestHistoryEntry[];
}

export type ValidationCheckStatus = "success" | "error" | "skipped";

export interface ValidationCheck {
  id: string;
  label: string;
  status: ValidationCheckStatus;
}

export interface ValidationResult {
  status: "success" | "error";
  summary: string;
  checks: ValidationCheck[];
  started_at: string;
  finished_at: string;
  detail?: string;
}

export interface BackupArchive {
  name: string;
  path: string;
  size_bytes: number;
  modified_at: string;
  metadata: {
    project_name?: string;
    format_version?: number;
    captured_volumes?: string[];
    configured_volumes?: string[];
    created_at?: string;
  };
}

export interface RecoveryResponse {
  status: {
    status: string;
    message?: string;
    archive?: string;
    started_at?: string;
    finished_at?: string;
  };
  backups: BackupArchive[];
}

export interface EnvBanner {
  text: string;
  level: "critical" | "warning" | "info" | string;
}

export interface Snapshot {
  schema_version: number;
  generated_at: string;
  /** Operator-configured environment banner (TORHOLE_BANNER_TEXT/LEVEL in
   *  .env, read live). Optional: older backends don't return it. */
  banner?: EnvBanner | null;
  torhole: {
    overall_status: StatusKind | string;
    privacy_intact: boolean;
    headline: string;
    summary_sentence: string;
  };
  tor: {
    overall_status: StatusKind | string;
    summary: string;
    bootstrap: BootstrapState;
    isolation: IsolationState;
    network_path: { status: StatusKind | string; detail?: string };
    plane_identities: { overall_status: StatusKind | string };
    circuits: TorCircuits;
    /** Live runtime info from the Tor control port. Optional because an
     *  older backend (before Phase D) won't return it — frontend must
     *  handle the missing case gracefully. */
    runtime_info?: TorRuntimeInfo;
    last_rotation_at: string | null;
  };
  dns: {
    planes: PlaneStat[];
    counts: Counts;
    overall_status: StatusKind | string;
    totals: {
      queries_today: number;
      blocked_today: number;
      block_pct: number;
    };
  };
  leak_test: LeakTestState;
  containers: ContainerInfo[];
  container_counts: Counts;
  backup: {
    snapshot_count: number;
    last_snapshot_name: string | null;
    last_snapshot_at: string | null;
    last_snapshot_size_bytes: number | null;
  };
  alerts: {
    total_channels: number;
    configured_channels: number;
    enabled_channels: number;
  };
  validation: {
    last_result: ValidationResult | null;
  };
  recovery: {
    status: string;
    latest_archive: string | null;
    finished_at: string | null;
  };
  links: Record<string, string>;
}

export type SnapshotState =
  | { kind: "loading" }
  | { kind: "ready"; data: Snapshot; fetchedAt: number }
  | { kind: "error"; error: string; fetchedAt: number };

async function fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
  const res = await fetch("/api/system/snapshot", {
    credentials: "include",
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Snapshot;
  if (data.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `snapshot schema mismatch: expected ${SNAPSHOT_SCHEMA_VERSION}, got ${data.schema_version}`,
    );
  }
  return data;
}

export interface UseSnapshotResult {
  state: SnapshotState;
  /** Force an immediate fetch, bypassing the poll interval. Used after
   *  POST actions so the UI reflects the new state right away. */
  refetch: () => void;
}

/**
 * useSnapshot — single shared poller for the v2 UI.
 *
 * Polls /api/system/snapshot every SNAPSHOT_POLL_MS, updates on success,
 * preserves the last known good snapshot on transient errors so screens
 * don't flicker between "data" and "loading" on every poll.
 *
 * Exposes a `refetch` function that callers can invoke after running an
 * action (e.g. rotate identity, take snapshot) to immediately reflect the
 * new state instead of waiting up to SNAPSHOT_POLL_MS for the next tick.
 */
export function useSnapshot(): UseSnapshotResult {
  const [state, setState] = useState<SnapshotState>({ kind: "loading" });
  const lastGood = useRef<Snapshot | null>(null);
  const tickRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const data = await fetchSnapshot(controller.signal);
        if (cancelled) return;
        lastGood.current = data;
        setState({ kind: "ready", data, fetchedAt: Date.now() });
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === "AbortError") return;
        if (lastGood.current) {
          setState({
            kind: "ready",
            data: lastGood.current,
            fetchedAt: Date.now(),
          });
        } else {
          setState({
            kind: "error",
            error: (err as Error).message,
            fetchedAt: Date.now(),
          });
        }
      }
    };
    tickRef.current = tick;

    void tick();
    const interval = window.setInterval(tick, SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      tickRef.current = null;
    };
  }, []);

  const refetch = useCallback(() => {
    void tickRef.current?.();
  }, []);

  return { state, refetch };
}

/* ---------------------------------------------------------------------- *
 * Action endpoints — POST helpers used by screens to trigger backend
 * operations. Each one returns the parsed JSON body and throws on HTTP
 * errors. Callers should call refetch() from useSnapshot after a successful
 * action to refresh the UI.
 * ---------------------------------------------------------------------- */

export interface RotateIdentityResult {
  ok: boolean;
  message: string;
  rotated_at: string;
}

/** Global Tor identity rotation — sends SIGNAL NEWNYM. Affects ALL planes
 *  at once. Use rotateTorPlane for per-plane rotation. */
export async function rotateTorIdentity(): Promise<RotateIdentityResult> {
  const res = await fetch("/api/tor/rotate", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = (await res.json()) as RotateIdentityResult;
  if (!res.ok) {
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

export interface RotatePlaneResult {
  ok: boolean;
  message: string;
  rotated_at: string;
  closed?: string[];
  failed?: Array<{ id: string; reason: string }>;
}

/** Per-plane Tor rotation — closes only the circuits whose SOCKS_USERNAME
 *  matches the given plane. Other planes are untouched. New circuits build
 *  on the next DNS query through that plane. */
export async function rotateTorPlane(
  plane: "trusted" | "iot",
): Promise<RotatePlaneResult> {
  const res = await fetch("/api/tor/rotate-plane", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plane }),
  });
  const data = (await res.json()) as RotatePlaneResult;
  if (!res.ok) {
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

/** Run a DNS leak test through tor:9050 SOCKS5 to check.torproject.org and
 *  verify IsTor=true. Result is stored in the backend ring buffer and the
 *  next snapshot will reflect it. Always returns a result (never throws on
 *  test failure — only on transport errors). */
export async function runLeakTest(): Promise<LeakTestResult> {
  const res = await fetch("/api/leak-test/run", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = (await res.json()) as LeakTestResult;
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------------------------------------------------------------------- *
 * Live query feed — Server-Sent Events stream of normalized Pi-hole queries.
 * ---------------------------------------------------------------------- */

export type QueryStatusKind = "blocked" | "forwarded" | "cached" | "other";

export interface QueryEvent {
  id: number;
  plane: "trusted" | "iot" | string;
  time: number; // unix epoch float
  domain: string | null;
  type: string | null;
  status: QueryStatusKind;
  raw_status: string | null;
  client_ip: string | null;
  client_name: string | null;
  /** Reply record type from Pi-hole (IP / CNAME / NXDOMAIN / SOA / etc.)
   *  Note: Pi-hole doesn't expose the resolved IP, only the reply type. */
  reply_type: string | null;
  /** Query latency in milliseconds, from Pi-hole's reply.time (seconds ×1000). */
  reply_time_ms: number | null;
}

export type QueryFeedStatus = "connecting" | "open" | "closed";

export interface UseQueryFeedResult {
  events: QueryEvent[];
  status: QueryFeedStatus;
  clear: () => void;
}

/* ---------------------------------------------------------------------- *
 * Operate screen helpers — container actions, backups, validation.
 * ---------------------------------------------------------------------- */

export type ServiceAction = "start" | "stop" | "restart";

export interface ServiceActionResult {
  message: string;
  services: unknown[]; // We don't use the returned list, we refetch snapshot.
}

/** POST /api/services/action — start/stop/restart a container. */
export async function runServiceAction(
  id: string,
  action: ServiceAction,
): Promise<ServiceActionResult> {
  const res = await fetch("/api/services/action", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data as ServiceActionResult;
}

/** POST /api/recovery/backup — create a backup archive. */
export async function createBackup(): Promise<{ message?: string; archive?: string }> {
  const res = await fetch("/api/recovery/backup", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

/** POST /api/recovery/restore — restore a backup archive. Destructive:
 *  caller MUST gate this behind the ConfirmModal. Backend rewrites live
 *  volumes from the archive, which will cause stack-wide downtime during
 *  the restore.
 *
 *  The backend requires a literal confirm:"RESTORE" field in the body —
 *  this is an intentional belt-and-braces check on top of the UI modal. */
export async function restoreBackup(archive: string): Promise<{ message?: string }> {
  const res = await fetch("/api/recovery/restore", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archive, confirm: "RESTORE" }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

/** POST /api/recovery/delete — delete a backup archive permanently. Destructive:
 *  caller MUST gate this behind the ConfirmModal.
 *
 *  The backend requires TWO confirmations on top of the UI modal: a literal
 *  confirm:"DELETE" field AND archive_confirm:<archive name> that must echo
 *  the archive name being deleted. Both are sent here; the ConfirmModal
 *  provides the user-facing "type DELETE" gate. */
export async function deleteBackup(archive: string): Promise<{ message?: string }> {
  const res = await fetch("/api/recovery/delete", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      archive,
      confirm: "DELETE",
      archive_confirm: archive,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

/** POST /api/system/validate — run stack validation. Returns the full result. */
export async function runValidation(): Promise<ValidationResult> {
  const res = await fetch("/api/system/validate", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data as ValidationResult;
}

/** GET /api/recovery — list of backup archives. Not in the snapshot because
 *  listing requires reading tar metadata (slow on large archives). Fetched
 *  on-demand when the Operate screen mounts. */
export async function fetchRecovery(): Promise<RecoveryResponse> {
  const res = await fetch("/api/recovery", {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as RecoveryResponse;
}

/* ---------------------------------------------------------------------- *
 * Configure screen helpers — config values, notification channels.
 * ---------------------------------------------------------------------- */

export interface ConfigResponse {
  config: Record<string, string>;
}

export interface NotificationChannel {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  enabled_key: string;
}

/** GET /api/config — masked .env values. Secrets come back as "***". */
export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ConfigResponse;
}

/** POST /api/config — update a single non-secret .env key. The write is
 *  atomic with a timestamped backup on the backend. */
export async function updateConfigValue(
  key: string,
  value: string,
): Promise<{ message?: string }> {
  const res = await fetch("/api/config", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data || {};
}

export interface InsightEntry {
  name: string;
  count: number;
}

export interface InsightClient {
  ip: string;
  name: string | null;
  count: number;
}

export interface InsightsPlane {
  id: string;
  label: string;
  available: boolean;
  top_domains: InsightEntry[];
  top_blocked: InsightEntry[];
  top_clients: InsightClient[];
}

/** GET /api/dns/insights — per-plane top domains / blocked / clients from
 *  the Pi-hole stats API (60s server-side cache). */
export async function fetchDnsInsights(): Promise<{
  planes: InsightsPlane[];
  generated_at: string;
}> {
  const res = await fetch("/api/dns/insights", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** GET /api/notifications — list of alert channels with configured/enabled flags. */
export async function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  const res = await fetch("/api/notifications", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { channels: NotificationChannel[] };
  return data.channels || [];
}

/** POST /api/notifications/channel — enable/disable a channel.
 *  Returns the updated channel list. */
export async function setNotificationChannel(
  channel: string,
  enabled: boolean,
): Promise<NotificationChannel[]> {
  const res = await fetch("/api/notifications/channel", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, enabled }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return (data as { channels: NotificationChannel[] }).channels || [];
}

/** POST /api/notifications/test — send a synthetic alert to Alertmanager.
 *  Alertmanager routes it through whichever channels are enabled; operators
 *  should see the test notification in their Telegram/email/etc. */
export async function sendTestAlert(): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/notifications/test", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = (await res.json()) as { ok: boolean; message: string };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/** POST /api/setup/apply — persist the Setup wizard's captured fields
 *  into .env. Current scope: edition + admin_user + timezone. Does NOT
 *  auto-deploy — the backend returns a "run deploy.sh on the host"
 *  message on success and the UI surfaces the next step.
 *
 *  The backend requires a literal confirm:"APPLY" field in the body. */
export interface SetupApplyChange {
  key: string;
  old: string;
  new: string;
}

export interface SetupApplyResult {
  ok: boolean;
  message: string;
  changes: SetupApplyChange[];
  backup: string | null;
}

export async function applySetupConfig(
  edition: "home" | "advanced",
  admin_user: string | null,
  timezone: string | null,
): Promise<SetupApplyResult> {
  const body: Record<string, string> = { confirm: "APPLY", edition };
  if (admin_user && admin_user.trim().length > 0) body.admin_user = admin_user.trim();
  if (timezone && timezone.trim().length > 0) body.timezone = timezone.trim();

  const res = await fetch("/api/setup/apply", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data as SetupApplyResult;
}

export interface BootstrapInstallStatus {
  status: "idle" | "running" | "success" | "error";
  message: string;
  logs: string[];
  edition?: "home" | "advanced";
  home_url?: string;
  pihole_url?: string;
  control_pin?: string;
}

export async function startBootstrapInstall(
  edition: "home" | "advanced",
  admin_user: string | null,
  timezone: string | null,
): Promise<BootstrapInstallStatus> {
  const body: Record<string, string> = { confirm: "INSTALL", edition };
  if (admin_user?.trim()) body.admin_user = admin_user.trim();
  if (timezone?.trim()) body.timezone = timezone.trim();
  const response = await fetch("/api/bootstrap/install", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Torhole-Request": "bootstrap" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as BootstrapInstallStatus & { error?: string };
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

export async function fetchBootstrapStatus(): Promise<BootstrapInstallStatus> {
  const response = await fetch("/api/bootstrap/status", {
    credentials: "include",
    headers: { "X-Torhole-Request": "bootstrap" },
    cache: "no-store",
  });
  const data = (await response.json()) as BootstrapInstallStatus & { error?: string };
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

export async function finishBootstrap(): Promise<void> {
  const response = await fetch("/api/bootstrap/finish", {
    method: "POST",
    credentials: "include",
    headers: { "X-Torhole-Request": "bootstrap" },
  });
  const data = (await response.json()) as { error?: string; message?: string };
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
}

/** POST /api/identity/password — change the admin password. Destructive:
 *  caller MUST gate this behind a ConfirmModal. On success the user's
 *  Authelia session is invalidated as soon as the container restarts,
 *  so the UI must surface a "log in again" banner immediately.
 *
 *  Requires the user's *current* password in addition to the new one —
 *  the backend verifies via constant-time comparison against the
 *  plaintext in .env. Wrong current password → 400 before any write
 *  happens. The backend also requires a literal confirm:"UPDATE" field
 *  as a belt-and-braces check on top of the UI modal. */
export async function updateAdminPassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<{ message: string }> {
  const res = await fetch("/api/identity/password", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
      confirm_password: confirmPassword,
      confirm: "UPDATE",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

/** Subscribe to /api/stream/queries via EventSource. Holds the most recent
 *  `maxSize` events in a ring buffer and exposes connection status. The
 *  EventSource auto-reconnects on transient failures.
 *
 *  `active` controls whether the subscription is open. When it flips to
 *  false (e.g. the Privacy screen's query-feed tab is hidden), the
 *  existing EventSource is closed and the backend polling thread it
 *  created is released. When it flips back to true, a new connection
 *  is opened and the server sends the initial dump again. Pass a
 *  constant `true` to match the old always-on behaviour. */
export function useQueryFeed(
  active: boolean,
  maxSize = 200,
): UseQueryFeedResult {
  const [events, setEvents] = useState<QueryEvent[]>([]);
  const [status, setStatus] = useState<QueryFeedStatus>(
    active ? "connecting" : "closed",
  );

  useEffect(() => {
    if (!active) {
      setStatus("closed");
      return;
    }
    setStatus("connecting");
    const es = new EventSource("/api/stream/queries", { withCredentials: true });
    let cancelled = false;

    es.onopen = () => {
      if (!cancelled) setStatus("open");
    };
    es.onerror = () => {
      if (!cancelled) setStatus("closed");
    };
    es.onmessage = (msg) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(msg.data) as QueryEvent;
        setEvents((prev) => {
          // The server re-sends its initial dump on every new connection
          // (see _stream_query_feed in backup-manager/server.py). When the
          // Privacy tab becomes active again after a flip, the preserved
          // ring buffer already contains events from the previous session —
          // appending the re-dump blindly would produce duplicate rows and
          // trip React's duplicate-key warning on QueryRow. Skip events
          // whose (plane, id) is already in the buffer.
          const key = `${data.plane}-${data.id}`;
          for (let i = prev.length - 1; i >= 0; i--) {
            const existing = prev[i];
            if (`${existing.plane}-${existing.id}` === key) {
              return prev;
            }
          }
          const next = prev.concat(data);
          if (next.length > maxSize) {
            next.splice(0, next.length - maxSize);
          }
          return next;
        });
      } catch {
        /* malformed event, drop silently */
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [active, maxSize]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, status, clear };
}

/* Small formatting helpers used across screens. All number formatting goes
 * through here so we have one place to control localization later. */

export function formatInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
