/*
 * Privacy screen — answers "What does Torhole prove?"
 *
 * Layout (tabbed as of iteration 8):
 *   Sticky top (always visible):
 *     - Header + Privacy hero
 *     - Per-plane Tor circuit isolation cards
 *
 *   Tabbed below (SectionTabs preserves state via hidden CSS):
 *     - DNS leak test (run button + result block + history strip)
 *     - Live query feed (terminal-styled SSE stream)
 *     - Internal Tor circuits (HS_VANGUARDS, CONFLUX — advanced)
 *
 * Why tabs: the stacked-sections layout made the page 3-4 viewport-heights
 * long, which hurt the "glance and act" feel. Tabs keep the privacy proof
 * (hero + circuits) pinned at the top and let the operator focus on one
 * secondary view at a time. Content stays mounted — non-active tabs are
 * hidden via CSS so SSE connections, leak test results, and scroll
 * positions persist across switches.
 *
 * Reuses the same brand tokens and primitives as Glance.
 */

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  Lock,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Zap,
} from "lucide-react";
import SectionTabs, { type SectionTabDef } from "../components/SectionTabs";
import {
  formatRelative,
  rotateTorIdentity,
  runLeakTest,
  useQueryFeed,
  useSnapshot,
  type LeakTestHistoryEntry,
  type LeakTestResult,
  type QueryEvent,
  type Snapshot,
  type SnapshotState,
  type StatusKind,
  type TorCircuit,
} from "../lib/snapshot";

export default function PrivacyScreen() {
  const { state, refetch } = useSnapshot();

  // Compute live meta for each tab from the snapshot so the tab row
  // reflects real state without extra polling.
  const leakMeta = computeLeakMeta(state);
  const internalMeta = computeInternalMeta(state);

  const tabs: SectionTabDef[] = [
    {
      id: "leak-test",
      eyebrow: "proof",
      title: "DNS leak test",
      meta: leakMeta,
      icon: <Zap size={11} />,
      content: <LeakTestPanel state={state} refetch={refetch} />,
    },
    {
      id: "query-feed",
      eyebrow: "proof",
      title: "Live query feed",
      // The live meta for the feed is computed inside the component via SSE;
      // we pass a static placeholder here that's replaced by useQueryFeedMeta.
      meta: undefined,
      icon: <Activity size={11} />,
      content: (active) => <LiveQueryFeedPanel active={active} />,
    },
    {
      id: "internal",
      eyebrow: "advanced",
      title: "Tor circuits",
      meta: internalMeta,
      icon: <Lock size={11} />,
      content: <InternalCircuitsPanel state={state} />,
    },
  ];

  return (
    <div className="th-page-enter px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
      <Header state={state} />
      <PrivacyHero state={state} />
      <TorRuntimeStrip state={state} />
      <CircuitPlanePanels state={state} refetch={refetch} />
      <SectionTabs tabs={tabs} />
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * TorRuntimeStrip — live Tor control-port stats, full-width, always
 * visible on the Privacy screen (no tab click required). Promoted out of
 * the Internal circuits tab because this IS the privacy guarantee — it
 * belongs at the top of the page, not three clicks deep.
 * ----------------------------------------------------------------------- */

function TorRuntimeStrip({ state }: { state: SnapshotState }) {
  if (state.kind !== "ready") return null;
  const runtime = state.data.tor.runtime_info;
  // Older backend (no runtime_info) — silently skip. The existing bootstrap
  // tile in the hero still covers the basic case.
  if (!runtime) return null;

  if (!runtime.available) {
    return (
      <div className="mb-6 rounded-lg border border-th-warning/40 bg-th-warning/[0.06] px-5 py-3 flex items-center gap-3">
        <AlertCircle size={14} className="text-th-warning shrink-0" />
        <div className="text-[11.5px] font-mono text-th-warning">
          Tor control port unavailable — {runtime.reason || "unknown reason"}
        </div>
      </div>
    );
  }

  const liveness = runtime.network_liveness === "up";
  const established = runtime.circuit_established;
  const bootstrap = runtime.bootstrap_percent;
  const ready = bootstrap >= 100 && liveness && established;

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div
      data-testid="tor-runtime-strip"
      className="mb-6 rounded-lg border border-th-line bg-th-panel/80 overflow-hidden"
    >
      {/* Header strip — eyebrow + live dot, version pinned right */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-th-line/60 bg-th-bg/40">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-1.5 w-1.5">
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${
                ready ? "bg-th-primary" : "bg-th-warning"
              }`}
            />
            <span
              className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                ready ? "bg-th-primary" : "bg-th-warning"
              }`}
            />
          </span>
          <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-th-text-muted">
            Tor control port · live
          </div>
        </div>
        <div className="text-[10px] font-mono text-th-text-muted/60">
          v{runtime.version || "?"} · traffic {formatBytes(runtime.traffic_read_bytes)} in · {formatBytes(runtime.traffic_written_bytes)} out
        </div>
      </div>

      {/* Stat grid — 5 cells, dense mono */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-th-line/40">
        <RuntimeStatCell
          label="bootstrap"
          value={`${bootstrap}%`}
          sub={runtime.bootstrap_summary || undefined}
          ok={bootstrap >= 100}
        />
        <RuntimeStatCell
          label="liveness"
          value={runtime.network_liveness || "unknown"}
          ok={liveness}
        />
        <RuntimeStatCell
          label="circuits"
          value={established ? "established" : "building"}
          ok={established}
        />
        <RuntimeStatCell
          label="dir info"
          value={runtime.enough_dir_info ? "sufficient" : "partial"}
          ok={runtime.enough_dir_info}
        />
        <RuntimeStatCell
          label="entry guards"
          value={String(runtime.entry_guards_count)}
          ok={runtime.entry_guards_count > 0}
          neutral
        />
      </div>
    </div>
  );
}

function RuntimeStatCell({
  label,
  value,
  sub,
  ok,
  neutral = false,
}: {
  label: string;
  value: string;
  sub?: string;
  ok: boolean;
  neutral?: boolean;
}) {
  const color = neutral
    ? "text-th-text-mono"
    : ok
    ? "text-th-primary"
    : "text-th-warning";
  return (
    <div className="px-5 py-3.5 flex flex-col gap-1">
      <div className="text-[9px] uppercase tracking-[0.16em] font-mono text-th-text-muted/60">
        {label}
      </div>
      <div className={`text-[15px] font-mono font-semibold ${color}`}>{value}</div>
      {sub && (
        <div className="text-[9.5px] font-mono text-th-text-muted/60 uppercase tracking-[0.1em]">
          {sub}
        </div>
      )}
    </div>
  );
}

function computeLeakMeta(state: SnapshotState): string | undefined {
  if (state.kind !== "ready") return undefined;
  const lt = state.data.leak_test;
  if (!lt.last_result) return "never run";
  const verdict = lt.last_result.pass ? "pass" : "fail";
  const count = lt.history_count || 0;
  return `${verdict} · ${count} run${count === 1 ? "" : "s"}`;
}

function computeInternalMeta(state: SnapshotState): string | undefined {
  if (state.kind !== "ready") return undefined;
  const circuits = state.data.tor.circuits;
  if (!circuits.available) return "unavailable";
  return `${circuits.count} reported`;
}

function Header({ state }: { state: SnapshotState }) {
  const fetched =
    state.kind === "ready" ? formatRelative(new Date(state.fetchedAt).toISOString()) : "—";
  return (
    <div className="flex items-end justify-between mb-7">
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.22em] text-th-text-muted font-mono">
          Privacy
        </div>
        <h1 className="text-[28px] font-bold tracking-tight mt-1 leading-none">
          What does Torhole prove?
        </h1>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-th-text-muted">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-th-primary opacity-60"></span>
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-th-primary"></span>
        </span>
        <span className="font-mono uppercase tracking-[0.14em]">live · {fetched}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Privacy hero — overall Tor health summary
 * ----------------------------------------------------------------------- */

function PrivacyHero({ state }: { state: SnapshotState }) {
  if (state.kind === "loading") {
    return (
      <div className="mb-6 bg-th-panel border border-th-line rounded-lg p-6">
        <div className="h-20 animate-pulse opacity-50">
          <div className="h-6 w-64 bg-th-line/60 rounded mb-3" />
          <div className="h-4 w-96 bg-th-line/40 rounded" />
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mb-6 bg-th-panel border border-th-danger/40 rounded-lg p-6">
        <div className="text-th-danger font-mono text-sm">{state.error}</div>
      </div>
    );
  }

  const { data } = state;
  const tor = data.tor;
  const circuits = tor.circuits;
  const intact = data.torhole.privacy_intact;
  const configuredPlaneCount = data.dns.planes.length;

  return (
    <div className="th-scanlines th-hero-surface relative overflow-hidden mb-6 rounded-xl px-9 py-8 border bg-gradient-to-br from-th-panel via-th-panel to-th-primary/[0.04] border-th-line">
      <div className="flex items-start gap-7">
        <div
          className={`w-[80px] h-[80px] rounded-xl flex items-center justify-center shrink-0 ${
            intact
              ? "bg-th-primary/12 text-th-primary ring-1 ring-th-primary/30 shadow-[0_0_32px_rgba(34,197,94,0.18)]"
              : "bg-th-danger/15 text-th-danger ring-1 ring-th-danger/30"
          }`}
        >
          {intact ? (
            <Lock size={42} strokeWidth={1.6} />
          ) : (
            <ShieldAlert size={42} strokeWidth={1.6} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[34px] font-bold leading-[1.05] tracking-[-0.02em] text-th-text">
            Every DNS query exits via Tor
          </div>
          <div className="text-[13.5px] text-th-text-muted mt-2">
            {tor.bootstrap.status === "healthy"
              ? `Tor bootstrapped. ${circuits.count} circuit entr${circuits.count === 1 ? "y" : "ies"} reported; ${configuredPlaneCount} isolated DNS plane${configuredPlaneCount === 1 ? "" : "s"} configured.`
              : "Tor is not bootstrapped — privacy guarantee in flux."}
          </div>

          {/* Inline proof tiles. These complement the Tor runtime strip
              below — the strip answers "is the guarantee working right
              now?" (internal view), and these three tiles prove different
              axes of the guarantee:
                - tor uptime   → duration the privacy stance has held
                - exit IP      → what the internet sees from outside
                - isolation    → per-plane SOCKS isolation is configured
              All three pull from the snapshot, no extra polling. */}
          <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-2">
            <ProofTile
              label="tor uptime"
              value={torUptimeValue(data)}
              status={torUptimeStatus(data)}
            />
            <ProofTile
              label="exit ip"
              value={exitIpValue(data)}
              status={exitIpStatus(data)}
            />
            <ProofTile
              label="isolation"
              value={
                tor.isolation.status === "healthy"
                  ? "IsolateSOCKSAuth verified"
                  : "isolation degraded"
              }
              status={tor.isolation.status as StatusKind}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Format a millisecond duration as "3d 14h", "2h 15m", "5m 12s", "45s".
 *  Used by the tor uptime tile — shows the coarsest two units so it stays
 *  stable at a glance. */
function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function torUptimeValue(data: Snapshot): string {
  const tor = data.containers.find((c) => c.name === "tor");
  if (!tor || !tor.started_at) return "—";
  const ms = Date.now() - new Date(tor.started_at).getTime();
  return formatDuration(ms);
}

function torUptimeStatus(data: Snapshot): StatusKind {
  const tor = data.containers.find((c) => c.name === "tor");
  if (!tor) return "offline";
  return (tor.status as StatusKind) || "offline";
}

function exitIpValue(data: Snapshot): string {
  const last = data.leak_test.last_result;
  if (!last) return "never tested";
  const status = leakVerificationStatus(last);
  if (status === "unavailable") return "verifier unavailable";
  if (status === "confirmed_not_tor") return "leak detected";
  return last.ip || "unknown";
}

function exitIpStatus(data: Snapshot): StatusKind {
  const last = data.leak_test.last_result;
  if (!last) return "degraded";
  const status = leakVerificationStatus(last);
  if (status === "unavailable") return "degraded";
  return status === "confirmed_tor" ? "healthy" : "offline";
}

function leakVerificationStatus(result: LeakTestResult | LeakTestHistoryEntry) {
  if (result.verification_status) return result.verification_status;
  if (result.pass) return "confirmed_tor";
  const error = "error" in result ? String(result.error || "").toLowerCase() : "";
  return error.includes("leak detected") || error.replaceAll(" ", "").includes("istor=false")
    ? "confirmed_not_tor"
    : "unavailable";
}

function ProofTile({ label, value, status }: { label: string; value: string; status: StatusKind }) {
  const dot =
    status === "healthy" ? "bg-th-primary" : status === "degraded" ? "bg-th-warning" : "bg-th-danger";
  return (
    <div className="bg-th-bg/60 border border-th-line/60 rounded-md px-3 py-2.5">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
        <span className="text-[12px] font-mono text-th-text-mono">{value}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Per-plane Tor circuit panels
 * ----------------------------------------------------------------------- */

function CircuitPlanePanels({ state, refetch }: { state: SnapshotState; refetch: () => void }) {
  const [rotate, setRotate] = useState<RotateState>({ kind: "idle" });
  if (state.kind !== "ready") return null;
  const circuits = state.data.tor.circuits;
  const activePlaneIds = new Set(state.data.dns.planes.map((plane) => plane.id));
  const planeLabels = new Map(state.data.dns.planes.map((plane) => [plane.id, plane.label]));

  if (!circuits.available) {
    return (
      <SectionCard
        eyebrow="tor circuits"
        title="Per-plane circuit panel"
        meta="control port unavailable"
        className="mb-5"
      >
        <div className="flex items-start gap-3 p-4 bg-th-bg/40 border border-th-warning/30 rounded">
          <AlertCircle size={18} className="text-th-warning shrink-0 mt-0.5" />
          <div className="text-[12.5px] text-th-text-muted">
            <div className="text-th-text">Tor control port not reachable</div>
            <div className="font-mono text-[11px] mt-1 text-th-text-muted/80">
              {circuits.reason || "unknown reason"}
            </div>
          </div>
        </div>
      </SectionCard>
    );
  }

  const allPlanes: Array<{ id: "trusted" | "iot"; circuitIds: string[] }> = [
    { id: "trusted", circuitIds: circuits.by_plane.trusted },
    { id: "iot", circuitIds: circuits.by_plane.iot },
  ];
  const planes = allPlanes.filter((plane) => activePlaneIds.has(plane.id));

  const handleRotate = async () => {
    setRotate({ kind: "loading" });
    try {
      const result = await rotateTorIdentity();
      if (!result.ok) throw new Error(result.message);
      setRotate({ kind: "success" });
      refetch();
      setTimeout(() => refetch(), 1500);
      setTimeout(() => setRotate({ kind: "idle" }), 2500);
    } catch (err) {
      setRotate({ kind: "error", message: (err as Error).message });
      setTimeout(() => setRotate({ kind: "idle" }), 4000);
    }
  };

  return (
    <SectionCard
      eyebrow="tor circuits"
      title="DNS plane isolation"
      meta={`${planes.length} configured · ${circuits.count} Tor circuit entries`}
      className="mb-5"
      action={
        <button
          type="button"
          onClick={handleRotate}
          disabled={rotate.kind === "loading"}
          title={rotate.kind === "error" ? rotate.message : "Request a new global Tor identity"}
          className={`flex items-center gap-1.5 px-3 py-2 rounded border min-h-[38px] text-[10.5px] font-mono uppercase tracking-[0.12em] ${
            rotate.kind === "success"
              ? "border-th-primary/40 bg-th-primary/10 text-th-primary"
              : rotate.kind === "error"
              ? "border-th-danger/40 bg-th-danger/10 text-th-danger"
              : "border-th-line bg-th-bg/60 text-th-text-muted hover:text-th-text hover:border-th-primary/40"
          }`}
        >
          <RefreshCw size={12} className={rotate.kind === "loading" ? "animate-spin" : ""} />
          {rotate.kind === "loading"
            ? "renewing…"
            : rotate.kind === "success"
            ? "identity renewed"
            : rotate.kind === "error"
            ? "renewal failed"
            : "renew Tor identity"}
        </button>
      }
    >
      <div className={`grid grid-cols-1 ${planes.length > 1 ? "lg:grid-cols-2" : ""} gap-3`}>
        {planes.map((plane) => (
          <PlaneCircuitCard
            key={plane.id}
            planeLabel={planeLabels.get(plane.id) || plane.id}
            circuitIds={plane.circuitIds}
            allItems={circuits.items}
          />
        ))}
      </div>
    </SectionCard>
  );
}

type RotateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function PlaneCircuitCard({
  planeLabel,
  circuitIds,
  allItems,
}: {
  planeLabel: string;
  circuitIds: string[];
  allItems: TorCircuit[];
}) {
  const circuits = circuitIds
    .map((id) => allItems.find((c) => c.id === id))
    .filter((c): c is TorCircuit => Boolean(c));
  const attributed = circuits.length > 0;

  return (
    <div
      className={`rounded-md border p-3.5 flex flex-col gap-2.5 ${
        "bg-th-bg/60 border-th-line"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full bg-th-primary"
          />
          <div className="text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono">
            {planeLabel}
          </div>
        </div>
        <div className="text-[9.5px] uppercase tracking-[0.14em] text-th-primary/70 font-mono">
          {attributed ? `${circuits.length} attributed` : "isolation configured"}
        </div>
      </div>

      {attributed ? (
        <div className="flex flex-col gap-2.5">
          {circuits.map((c) => (
            <CircuitDetail key={c.id} circuit={c} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-th-text-muted/70 font-mono py-3 px-1">
          SOCKS credential isolation is configured. Tor may prebuild circuits
          before a short DNS stream owns them, so the current circuit table has
          no reliable plane label.
        </div>
      )}
    </div>
  );
}

function CircuitDetail({ circuit }: { circuit: TorCircuit }) {
  const builtAgo = circuit.time_created ? formatRelative(circuit.time_created) : null;
  return (
    <div className="bg-th-bg/40 border border-th-line/60 rounded p-2.5">
      <div className="flex items-baseline justify-between text-[9.5px] font-mono uppercase tracking-[0.14em] text-th-text-muted/70 mb-2">
        <span>circuit #{circuit.id}</span>
        {builtAgo && <span>built {builtAgo}</span>}
      </div>
      <div className="space-y-1.5">
        {circuit.path.map((hop, i) => (
          <CircuitHop
            key={`${circuit.id}-${i}`}
            label={["entry", "middle", "exit"][i] || `hop ${i + 1}`}
            hop={hop}
            isLast={i === circuit.path.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function CircuitHop({
  label,
  hop,
  isLast,
}: {
  label: string;
  hop: { fp: string; nickname: string };
  isLast: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-[10.5px] font-mono">
      <div className="flex flex-col items-center pt-[5px]">
        <div className="w-1.5 h-1.5 rounded-full bg-th-primary/70 ring-1 ring-th-primary/20" />
        {!isLast && <div className="w-px h-3 bg-th-line/80 mt-0.5" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[8.5px] uppercase tracking-[0.16em] text-th-text-muted/60">
          {label}
        </div>
        <div className="text-th-text-mono leading-tight truncate" title={`${hop.nickname} (${hop.fp})`}>
          {hop.nickname}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Leak test panel — real, wired to /api/leak-test/run
 * ----------------------------------------------------------------------- */

type LeakTestRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: LeakTestResult }
  | { kind: "error"; message: string };

function LeakTestPanel({ state, refetch }: { state: SnapshotState; refetch: () => void }) {
  const [runState, setRunState] = useState<LeakTestRunState>({ kind: "idle" });

  // Pull the last result from the snapshot if we don't have a fresher one
  // from a just-completed run.
  const snapshotResult =
    state.kind === "ready" ? state.data.leak_test.last_result : null;
  const recentPassRate =
    state.kind === "ready" ? state.data.leak_test.recent_pass_rate : null;
  const historyCount =
    state.kind === "ready" ? state.data.leak_test.history_count : 0;
  const conclusiveCount =
    state.kind === "ready"
      ? state.data.leak_test.conclusive_count ?? state.data.leak_test.history_count
      : 0;
  // history may be absent on an older backend that hasn't been rebuilt yet —
  // fall back to an empty array so the UI doesn't crash on a version skew.
  const history: LeakTestHistoryEntry[] =
    state.kind === "ready" ? state.data.leak_test.history ?? [] : [];

  // The most recently observed result, preferring the one from the
  // just-completed run.
  const activeResult: LeakTestResult | null =
    runState.kind === "done" ? runState.result : snapshotResult;

  const handleRun = async () => {
    setRunState({ kind: "running" });
    try {
      const result = await runLeakTest();
      setRunState({ kind: "done", result });
      refetch();
      // Reset to idle after a moment so the snapshot value takes over.
      setTimeout(() => setRunState({ kind: "idle" }), 4000);
    } catch (err) {
      setRunState({ kind: "error", message: (err as Error).message });
      setTimeout(() => setRunState({ kind: "idle" }), 5000);
    }
  };

  return (
    <div className="bg-th-panel border border-th-line rounded-lg p-5 flex flex-col gap-3">
      <div className="text-[11.5px] text-th-text-muted leading-relaxed">
        Probes <span className="font-mono text-th-text-mono">check.torproject.org/api/ip</span> through{" "}
        <span className="font-mono text-th-text-mono">tor:9050</span>. Pass = every query exits via Tor.
      </div>

      <LeakTestResultBlock
        result={activeResult}
        running={runState.kind === "running"}
      />

      {recentPassRate !== null && historyCount > 0 && (
        <div className="flex items-center gap-3 mt-0.5">
          <div className="text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em] shrink-0">
              recent · {Math.round(recentPassRate * 100)}% conclusive ({conclusiveCount}/{historyCount})
          </div>
          <LeakTestHistoryStrip history={history} />
        </div>
      )}

      {runState.kind === "error" && (
        <div className="text-[11px] text-th-danger font-mono px-2 py-1.5 bg-th-danger/10 border border-th-danger/30 rounded">
          transport error: {runState.message}
        </div>
      )}

      <button
        type="button"
        onClick={handleRun}
        disabled={runState.kind === "running"}
        className={`mt-auto flex items-center justify-center gap-1.5 px-3 py-2.5 rounded text-[11px] font-mono uppercase tracking-[0.14em] min-h-[44px] transition-colors ${
          runState.kind === "running"
            ? "bg-th-bg/60 border border-th-line text-th-text-muted cursor-wait"
            : "bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40 hover:bg-th-primary/[0.04]"
        }`}
      >
        {runState.kind === "running" ? (
          <>
            <Zap size={13} className="animate-pulse" />
            running…
          </>
        ) : (
          <>
            <Zap size={13} />
            run leak test now
          </>
        )}
      </button>
    </div>
  );
}

function LeakTestResultBlock({
  result,
  running,
}: {
  result: LeakTestResult | null;
  running: boolean;
}) {
  if (running) {
    return (
      <div className="bg-th-bg/60 border border-th-line/80 rounded-md p-3 flex items-center gap-3">
        <Zap size={16} className="text-th-primary animate-pulse" />
        <div className="text-[12px] font-mono text-th-text-muted">
          probing tor exit · please wait
        </div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="bg-th-bg/60 border border-th-line/80 border-dashed rounded-md p-3 text-[11px] font-mono text-th-text-muted/70">
        no leak test run yet · click "run leak test now" to verify
      </div>
    );
  }

  const verificationStatus = leakVerificationStatus(result);
  const passed = verificationStatus === "confirmed_tor";
  const unavailable = verificationStatus === "unavailable";
  const ranAgo = formatRelative(result.ran_at);

  return (
    <div
      className={`rounded-md border p-3 ${
        passed
          ? "bg-th-primary/[0.04] border-th-primary/30"
          : unavailable
            ? "bg-th-warning/[0.06] border-th-warning/40"
          : "bg-th-danger/[0.06] border-th-danger/40"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div
          className={`w-6 h-6 rounded flex items-center justify-center ${
            passed
              ? "bg-th-primary/15 text-th-primary"
              : unavailable
                ? "bg-th-warning/15 text-th-warning"
                : "bg-th-danger/15 text-th-danger"
          }`}
        >
          {passed ? <Check size={14} strokeWidth={3} /> : <ShieldAlert size={14} strokeWidth={2.5} />}
        </div>
        <div
          className={`text-[14px] font-bold tracking-tight ${
            passed ? "text-th-primary" : unavailable ? "text-th-warning" : "text-th-danger"
          }`}
        >
          {passed
            ? "PASS · DNS exits via Tor"
            : unavailable
              ? "CHECK INCONCLUSIVE · verifier unavailable"
              : "FAIL · privacy not intact"}
        </div>
        <div className="ml-auto text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em]">
          {ranAgo}
        </div>
      </div>

      <div className="space-y-1 pl-1">
        {result.ip && (
          <ResultRow label="exit ip" value={result.ip} mono />
        )}
        <ResultRow
          label="is_tor"
          value={result.is_tor ? "true" : "false"}
          mono
          accent={result.is_tor ? "ok" : unavailable ? undefined : "fail"}
        />
        <ResultRow label="duration" value={`${result.duration_ms}ms`} mono />
        {result.error && (
          <ResultRow label="error" value={result.error} mono accent="fail" />
        )}
      </div>
    </div>
  );
}

function LeakTestHistoryStrip({ history }: { history: LeakTestHistoryEntry[] }) {
  if (history.length === 0) return null;
  // Render as a row of dots — green for pass, red for fail — with a tooltip
  // on hover showing the timestamp. A simpler alternative to a full
  // sparkline; still gives an operator a sense of "is this consistent?".
  return (
    <div
      className="flex items-center gap-[3px] flex-1 min-w-0"
      role="img"
      aria-label={`Recent leak test history: ${history.length} runs, ${history.filter((h) => leakVerificationStatus(h) === "confirmed_tor").length} passed`}
    >
      {history.map((entry, i) => (
        <span
          key={`${entry.ran_at}-${i}`}
          className={`inline-block w-1.5 h-3 rounded-sm ${
            leakVerificationStatus(entry) === "confirmed_tor"
              ? "bg-th-primary/70"
              : leakVerificationStatus(entry) === "unavailable"
                ? "bg-th-warning/70"
                : "bg-th-danger/80"
          }`}
          title={`${leakVerificationStatus(entry) === "confirmed_tor" ? "PASS" : leakVerificationStatus(entry) === "unavailable" ? "INCONCLUSIVE" : "FAIL"} · ${formatRelative(entry.ran_at)}`}
        />
      ))}
    </div>
  );
}

function ResultRow({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "ok" | "fail";
}) {
  const colour =
    accent === "ok"
      ? "text-th-primary"
      : accent === "fail"
      ? "text-th-danger"
      : "text-th-text-mono";
  return (
    <div className="flex items-baseline gap-3 text-[11.5px]">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/70 font-mono w-[68px] shrink-0">
        {label}
      </div>
      <div className={`${mono ? "font-mono" : ""} ${colour} truncate`} title={value}>
        {value}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Live query feed — terminal-styled SSE stream of Pi-hole queries
 * ----------------------------------------------------------------------- */

const QUERY_FEED_MAX = 250;
const QUERY_FEED_HEIGHT = "h-80"; // ~320px terminal pane

function LiveQueryFeedPanel({ active }: { active: boolean }) {
  const { events, status, clear } = useQueryFeed(active, QUERY_FEED_MAX);
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<QueryEvent[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // When live, mirror the buffer. When paused, freeze the snapshot.
  useEffect(() => {
    if (!paused) setSnapshot(events);
  }, [events, paused]);

  // Auto-scroll to bottom unless paused.
  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [snapshot, paused]);

  const counts = snapshot.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const statusLabel =
    status === "open" ? "live" : status === "connecting" ? "connecting" : "disconnected";
  const statusDot =
    status === "open"
      ? "bg-th-primary animate-pulse"
      : status === "connecting"
      ? "bg-th-warning"
      : "bg-th-danger";

  return (
    <div className="bg-th-panel border border-th-line rounded-lg overflow-hidden">
      {/* Status bar — now also hosts pause/clear controls since the section
          header is gone (the tab button IS the section header). */}
      <div className="flex items-center justify-between px-3 py-2 bg-th-bg/40 border-b border-th-line/60">
        <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.14em]">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            <span className="text-th-text-muted">{statusLabel}</span>
          </div>
          <div className="text-th-text-muted/40">·</div>
          <div className="text-th-text-muted">
            queries / sse stream · {snapshot.length} events
            {paused && " · paused"}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <CountChip label="cached" value={counts.cached || 0} kind="ok" />
            <CountChip label="forwarded" value={counts.forwarded || 0} kind="info" />
            <CountChip label="blocked" value={counts.blocked || 0} kind="danger" />
            {(counts.other || 0) > 0 && (
              <CountChip label="other" value={counts.other || 0} kind="muted" />
            )}
          </div>
          <div className="w-px h-4 bg-th-line/60" />
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[9.5px] font-mono uppercase tracking-[0.14em] text-th-text-muted hover:text-th-text hover:bg-th-line/40 transition-colors"
            title={paused ? "Resume live updates" : "Pause to inspect"}
          >
            {paused ? <Play size={10} /> : <Pause size={10} />}
            {paused ? "resume" : "pause"}
          </button>
          <button
            type="button"
            onClick={clear}
            className="flex items-center gap-1 px-2 py-1 rounded text-[9.5px] font-mono uppercase tracking-[0.14em] text-th-text-muted hover:text-th-danger hover:bg-th-line/40 transition-colors"
            title="Clear feed buffer (does not affect server)"
          >
            <Trash2 size={10} />
            clear
          </button>
        </div>
      </div>

      {/* Column headers — sticky inside the terminal pane so they stay
          visible while the event rows scroll underneath. Styled like the
          other muted uppercase mono eyebrows in the app. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-th-bg/80 backdrop-blur-sm border-b border-th-line/40 font-mono text-[8.5px] uppercase tracking-[0.14em] text-th-text-muted/50">
        <span className="w-[50px] shrink-0">time</span>
        <span className="w-[44px] shrink-0">plane</span>
        <span className="w-[12px] shrink-0 text-center"></span>
        <span className="w-[28px] shrink-0">type</span>
        <span className="min-w-0 max-w-[520px] truncate">domain</span>
        <span className="w-[82px] shrink-0 text-right">reply · ms</span>
      </div>

      {/* Terminal feed */}
      <div
        ref={containerRef}
        className={`${QUERY_FEED_HEIGHT} overflow-y-auto bg-th-bg/40 font-mono text-[10.5px]`}
        style={{ scrollbarWidth: "thin" }}
      >
        {snapshot.length === 0 ? (
          <div className="px-3 py-4 text-th-text-muted/60">
            {status === "connecting"
              ? "connecting to query feed…"
              : status === "closed"
              ? "feed disconnected — check backend"
              : "waiting for queries…"}
          </div>
        ) : (
          snapshot.map((event) => <QueryRow key={`${event.plane}-${event.id}`} event={event} />)
        )}
      </div>
    </div>
  );
}

function CountChip({
  label,
  value,
  kind,
}: {
  label: string;
  value: number;
  kind: "ok" | "info" | "danger" | "muted";
}) {
  const colour =
    kind === "ok"
      ? "text-th-primary"
      : kind === "info"
      ? "text-th-info"
      : kind === "danger"
      ? "text-th-danger"
      : "text-th-text-muted";
  return (
    <span className="flex items-center gap-1">
      <span className="text-th-text-muted/60 uppercase tracking-[0.14em]">{label}</span>
      <span className={`${colour} tabular-nums`}>{value}</span>
    </span>
  );
}

const PLANE_COLOR: Record<string, string> = {
  trusted: "text-th-primary",
  iot: "text-th-info",
};

function QueryRow({ event }: { event: QueryEvent }) {
  const time = new Date((event.time || 0) * 1000);
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const ss = String(time.getSeconds()).padStart(2, "0");
  const planeColor = PLANE_COLOR[event.plane] || "text-th-text-muted";

  const statusGlyph =
    event.status === "blocked"
      ? "✗"
      : event.status === "forwarded"
      ? "→"
      : event.status === "cached"
      ? "•"
      : "?";
  const statusColor =
    event.status === "blocked"
      ? "text-th-danger"
      : event.status === "forwarded"
      ? "text-th-info"
      : event.status === "cached"
      ? "text-th-primary/80"
      : "text-th-text-muted/60";

  // The "reply" column shows what Pi-hole knows about the answer:
  // reply_type (IP / CNAME / NXDOMAIN / SOA / …) and reply_time_ms (latency
  // in ms). Pi-hole does NOT log the actual resolved IP — resolution
  // happens upstream via dnscrypt/Tor and the answer bypasses Pi-hole's
  // logging. For blocked queries we swap in a clear "BLOCKED" label since
  // we know the reply was 0.0.0.0 / ::.
  const replyText = formatReply(event);
  const replyColor =
    event.status === "blocked"
      ? "text-th-danger/80"
      : event.reply_type
      ? "text-th-text-mono"
      : "text-th-text-muted/40";

  return (
    <div
      data-event-key={`${event.plane}-${event.id}`}
      className="flex items-center gap-2 px-3 py-[3px] hover:bg-th-line/20 leading-tight"
      title={`${event.raw_status || event.status} · client ${event.client_ip || "?"}${
        event.reply_type ? ` · reply ${event.reply_type}` : ""
      }${
        event.reply_time_ms != null ? ` · ${event.reply_time_ms}ms` : ""
      }`}
    >
      <span className="text-th-text-muted/40 w-[50px] shrink-0">
        {hh}:{mm}:{ss}
      </span>
      <span className={`w-[44px] shrink-0 ${planeColor} uppercase text-[9.5px] tracking-[0.06em]`}>
        {event.plane}
      </span>
      <span className={`w-[12px] shrink-0 text-center ${statusColor}`}>{statusGlyph}</span>
      <span className="w-[28px] shrink-0 text-th-text-muted/60">{event.type || "?"}</span>
      <span className="min-w-0 max-w-[520px] text-th-text-mono truncate" title={event.domain || ""}>
        {event.domain || "(empty)"}
      </span>
      <span className={`w-[82px] shrink-0 text-right truncate ${replyColor}`} title={replyText}>
        {replyText}
      </span>
    </div>
  );
}

function formatReply(event: QueryEvent): string {
  // Blocked takes precedence — the reply is always the null address.
  if (event.status === "blocked") return "BLOCKED";
  const type = event.reply_type;
  const ms = event.reply_time_ms;
  if (!type && ms == null) return "—";
  if (type && ms != null) return `${type} · ${formatMs(ms)}`;
  if (type) return type;
  if (ms != null) return formatMs(ms);
  return "—";
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

/* ----------------------------------------------------------------------- *
 * Internal circuits — collapsible, for advanced operators
 * ----------------------------------------------------------------------- */

function InternalCircuitsPanel({ state }: { state: SnapshotState }) {
  if (state.kind !== "ready") {
    return (
      <div className="bg-th-panel border border-th-line rounded-lg p-5 text-[11px] text-th-text-muted font-mono">
        loading…
      </div>
    );
  }
  const circuits = state.data.tor.circuits;
  if (!circuits.available) {
    return (
      <div className="bg-th-panel border border-th-line rounded-lg p-5 flex items-start gap-2 text-[11px] text-th-warning font-mono">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        Tor control port not reachable — {circuits.reason || "unknown reason"}
      </div>
    );
  }

  return (
    <div className="bg-th-panel border border-th-line rounded-lg p-4">
      <div className="text-[11px] text-th-text-muted/80 leading-relaxed mb-3">
        Tor's current circuit table, including prebuilt paths, Conflux
        multipaths, directory work, and circuits carrying application streams.
        Tor only includes a SOCKS identity when it attributes a circuit to a
        client, so an unlabeled circuit must not be presented as a specific DNS
        plane. Relay nicknames and path details come directly from the control port.
      </div>
      <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
        {circuits.items.map((c) => (
          <InternalCircuitRow key={c.id} circuit={c} />
        ))}
      </div>
    </div>
  );
}

function InternalCircuitRow({ circuit }: { circuit: TorCircuit }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5 text-[10.5px] font-mono bg-th-bg/40 border border-th-line/40 rounded">
      <span className="text-th-text-muted/60 w-8 shrink-0">#{circuit.id}</span>
      <span className="text-th-text-muted/70 w-[140px] shrink-0 truncate">{circuit.purpose || "?"}</span>
      <span className="text-th-text-mono truncate">
        {circuit.path.map((h) => h.nickname).join(" → ")}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Section card — same primitive as Glance, kept local to keep imports tight
 * ----------------------------------------------------------------------- */

function SectionCard({
  eyebrow,
  title,
  meta,
  className = "",
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  className?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="flex items-end justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-[3px] h-7 bg-th-primary/70 rounded-full" />
          <div>
            <div className="text-[9.5px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
              {eyebrow}
            </div>
            <div className="text-[15px] font-semibold text-th-text leading-tight mt-0.5">
              {title}
              {meta && (
                <span className="ml-2 text-[12px] text-th-text-muted font-mono font-normal">
                  {meta}
                </span>
              )}
            </div>
          </div>
        </div>
        {action}
      </div>
      <div className="bg-th-panel border border-th-line rounded-lg p-4">{children}</div>
    </section>
  );
}
