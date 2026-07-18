/*
 * Torhole admin v2 — Glance screen, iteration 2.
 *
 * Iteration 2 changes from iteration 1:
 *   - Fixed TOR.ISOLATION proof truncation by switching from a 3-col grid to
 *     a vertical proof list rendered as label-value rows. No more clipped text.
 *   - Each of the 4 proof tiles now has its own component and visual character
 *     based on what it measures. They share a single TileFrame chrome so they
 *     read as siblings, not as identical copies.
 *   - Section headers are larger, with a left accent rail.
 *   - Container chips collapse when all healthy ("14/14 containers healthy ·
 *     expand"). Click to expand. Auto-expanded if anything is unhealthy.
 *   - Quick actions strip reworked: still disabled, but presented as a
 *     deliberate "preview" rather than a sad disabled bar.
 *   - Hero has more breathing room above and below; the shield is bigger and
 *     the headline weight is heavier.
 *   - "Live · 5s" pulse near the snapshot fetch indicator.
 *   - Spacing rhythm: hero stands alone, then proof row, then a single
 *     two-column section (planes + containers), then quick actions.
 */

import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  HardDrive,
  Lock,
  LogOut,
  Network,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { Routes, Route, NavLink } from "react-router-dom";
import PrivacyScreen from "./screens/Privacy";
import OperateScreen from "./screens/Operate";
import ConfigureScreen from "./screens/Configure";
import SetupScreen from "./screens/Setup";
import HomeScreen from "./screens/Home";
import {
  createBackup,
  formatBytes,
  formatInt,
  formatRelative,
  rotateTorIdentity,
  runLeakTest,
  runValidation,
  useSnapshot,
  type ContainerInfo,
  type PlaneStat,
  type Snapshot,
  type SnapshotState,
  type StatusKind,
} from "./lib/snapshot";

const SIDEBAR_COLLAPSED_KEY = "torhole.v2.sidebar.collapsed";

export default function App() {
  const developmentMode = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("mode")
    : null;
  if (window.__TORHOLE_MODE__ === "home" || developmentMode === "home") {
    return <HomeScreen />;
  }
  if (window.__TORHOLE_MODE__ === "bootstrap" || developmentMode === "bootstrap") {
    return <SetupScreen bootstrap />;
  }
  return <AdvancedApp />;
}

declare global {
  interface Window {
    __TORHOLE_MODE__?: "home" | "advanced" | "bootstrap";
  }
}

function AdvancedApp() {
  // Sidebar collapse state — persisted in localStorage so the operator's
  // preference survives reloads. Defaults to expanded; click the chevron at
  // the bottom of the sidebar to collapse on narrower screens (iPad).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {
      /* localStorage may be unavailable in private mode — silently ignore */
    }
  }, [sidebarCollapsed]);

  return (
    /*
     * min-w-[1024px] supports all iPads in landscape (mini 1024, regular
     * 1180, Pro 11" 1194, Pro 12.9" 1366) without horizontal scroll.
     * Below 1024 (portrait iPad, phone) the layout horizontal-scrolls.
     *
     * The xl breakpoint (1280px) is where the layout flips from stacked
     * (planes above containers) to side-by-side. iPad Pro 12.9" landscape
     * (1366) gets the desktop side-by-side layout; smaller iPads get the
     * stacked layout that uses full width for each section.
     */
    <div className="min-h-screen flex min-w-[1024px]">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <main className="flex-1 min-w-0 flex flex-col">
        <EnvBannerStrip />
        <div className="flex-1 min-h-0">
          <Routes>
            <Route path="/" element={<GlanceScreen />} />
            <Route path="/privacy" element={<PrivacyScreen />} />
            <Route path="/operate" element={<OperateScreen />} />
            <Route path="/configure" element={<ConfigureScreen />} />
            <Route path="/setup" element={<SetupScreen />} />
            <Route path="*" element={<GlanceScreen />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Environment banner — operator-configured strip across the top of every
 * screen. Driven by TORHOLE_BANNER_TEXT / TORHOLE_BANNER_LEVEL in the
 * instance's .env (read live by the backend), so staging/prod can be told
 * apart at a glance and ad-hoc operator messages can be posted without a
 * redeploy. Levels: critical (red), warning (amber), info (green).
 * ----------------------------------------------------------------------- */

const BANNER_STYLES: Record<string, { wrap: string; dot: string }> = {
  critical: {
    wrap: "bg-th-danger/15 border-th-danger/50 text-th-danger",
    dot: "bg-th-danger",
  },
  warning: {
    wrap: "bg-th-warning/15 border-th-warning/50 text-th-warning",
    dot: "bg-th-warning",
  },
  info: {
    wrap: "bg-th-primary/10 border-th-primary/40 text-th-primary",
    dot: "bg-th-primary",
  },
};

function EnvBannerStrip() {
  const { state } = useSnapshot();
  if (state.kind !== "ready") return null;
  const banner = state.data.banner;
  if (!banner || !banner.text) return null;
  const style = BANNER_STYLES[banner.level] ?? BANNER_STYLES.info;

  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-2.5 border-b px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.14em] ${style.wrap}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${style.dot}`} />
      <span className="truncate">{banner.text}</span>
      <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${style.dot}`} />
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Sidebar
 * ----------------------------------------------------------------------- */

/** Redirect to Authelia's logout endpoint, which destroys the SSO session
 *  cookie for the whole lab domain and bounces back to this UI (which will
 *  then hit the auth gate again). The auth host is derived from the current
 *  hostname (torhole.<domain> -> auth.<domain>) rather than the snapshot so
 *  sign-out still works when the backend is unreachable. */
function signOut() {
  const parts = window.location.hostname.split(".");
  const authHost = ["auth", ...parts.slice(1)].join(".");
  const rd = encodeURIComponent(`${window.location.origin}/v2/`);
  window.location.href = `https://${authHost}/logout?rd=${rd}`;
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const items = [
    { to: "/", label: "Glance", icon: Activity, enabled: true },
    { to: "/privacy", label: "Privacy", icon: Lock, enabled: true },
    { to: "/operate", label: "Operate", icon: HardDrive, enabled: true },
    { to: "/configure", label: "Configure", icon: Network, enabled: true },
    { to: "/setup", label: "Setup", icon: Bell, enabled: true },
  ];

  return (
    <aside
      className={`shrink-0 border-r border-th-line bg-th-panel/40 backdrop-blur-sm flex flex-col transition-[width] duration-200 ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      {/*
       * Top bar: logo + wordmark on the left (or just the logo when
       * collapsed), collapse toggle on the right. When collapsed, the
       * button tucks under the logo so the 56px column still fits.
       */}
      <div
        className={`pt-4 pb-6 ${collapsed ? "px-2" : "px-3"} flex ${
          collapsed ? "flex-col items-center gap-3" : "items-center gap-2.5"
        }`}
      >
        <div
          className={`w-9 h-9 rounded-lg bg-gradient-to-br from-th-primary to-th-primary/60 flex items-center justify-center shrink-0 shadow-[0_0_28px_rgba(34,197,94,0.32)] ring-1 ring-th-primary/30`}
        >
          <ShieldCheck size={18} className="text-th-bg" strokeWidth={2.6} />
        </div>
        {!collapsed && (
          <div className="font-sans font-bold tracking-[0.04em] text-[15px] flex-1">
            TOR<span className="text-th-primary">HOLE</span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          /*
           * Circular button with a subtle border and a chevron that rotates.
           * 36px square → total tap region ~44px with the surrounding padding,
           * which satisfies the iPad touch-target guideline.
           */
          className="w-9 h-9 rounded-full bg-th-bg/60 border border-th-line hover:border-th-primary/40 hover:bg-th-primary/[0.06] text-th-text-muted hover:text-th-text flex items-center justify-center transition-colors shrink-0"
        >
          <ChevronLeft
            size={14}
            strokeWidth={2.4}
            className={`transition-transform duration-200 ${
              collapsed ? "rotate-180" : ""
            }`}
          />
        </button>
      </div>

      <nav className={`flex-1 space-y-0.5 ${collapsed ? "px-2" : "px-3"}`}>
        {items.map(({ to, label, icon: Icon, enabled }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            title={collapsed ? label : undefined}
            /* min-h-[44px] satisfies the iOS touch target guideline */
            className={({ isActive }) =>
              [
                "flex items-center rounded-md text-[13px] transition-colors min-h-[44px]",
                collapsed ? "justify-center px-2" : "gap-2.5 px-3",
                enabled
                  ? isActive
                    ? collapsed
                      ? "bg-th-line/60 text-th-text"
                      : "bg-th-line/60 text-th-text border-l-2 border-l-th-primary -ml-0.5 pl-[10px]"
                    : "text-th-text-muted hover:text-th-text hover:bg-th-line/30"
                  : "text-th-text-muted/40 cursor-not-allowed",
              ].join(" ")
            }
            onClick={(e) => {
              if (!enabled) e.preventDefault();
            }}
          >
            <Icon size={15} strokeWidth={2} />
            {!collapsed && <span>{label}</span>}
            {!collapsed && !enabled && (
              <span className="ml-auto text-[9px] uppercase tracking-[0.14em] text-th-text-muted/40 font-mono">
                soon
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className={`pb-2 ${collapsed ? "px-2" : "px-3"}`}>
        <button
          type="button"
          onClick={signOut}
          title="Sign out"
          className={[
            "w-full flex items-center rounded-md text-[13px] transition-colors min-h-[44px]",
            collapsed ? "justify-center px-2" : "gap-2.5 px-3",
            "text-th-text-muted hover:text-th-danger hover:bg-th-danger/[0.08]",
          ].join(" ")}
        >
          <LogOut size={15} strokeWidth={2} />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>

      {!collapsed && (
        <div className="border-t border-th-line/40 px-5 py-4 text-[10px] text-th-text-muted/50 font-mono uppercase tracking-[0.14em]">
          v2 prototype · 0.1
        </div>
      )}
    </aside>
  );
}

/* ----------------------------------------------------------------------- *
 * Glance screen
 * ----------------------------------------------------------------------- */

function GlanceScreen() {
  const { state, refetch } = useSnapshot();
  return (
    /*
     * Width: 1500px default, 1700px at 2xl. mx-auto centers within the
     * remaining viewport after the sidebar so the content stays anchored
     * even on ultrawide displays. Padding scales with breakpoint so the
     * page breathes more on bigger canvases.
     */
    <div className="px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
      <Header state={state} />
      <Hero state={state} />
      <ProofRow state={state} />
      {/*
       * Two-column section: stacked below xl (1280px), side-by-side at xl+.
       * This is the iPad-friendly breakpoint — Pro 12.9" landscape (1366)
       * gets side-by-side, smaller iPads get the stacked layout where each
       * section uses full width.
       */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-4 xl:gap-5 mb-4">
        <PlanePosture state={state} />
        <ContainerStrip state={state} />
      </div>
      <QuickActions refetch={refetch} />
    </div>
  );
}

function Header({ state }: { state: SnapshotState }) {
  const fetched =
    state.kind === "ready" ? formatRelative(new Date(state.fetchedAt).toISOString()) : "—";
  return (
    <div className="flex items-end justify-between mb-7">
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.22em] text-th-text-muted font-mono">
          Glance
        </div>
        <h1 className="text-[28px] font-bold tracking-tight mt-1 leading-none">
          Is the privacy guarantee intact?
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
 * Hero — single focal statement, mono proofs as a vertical list
 * ----------------------------------------------------------------------- */

function Hero({ state }: { state: SnapshotState }) {
  if (state.kind === "loading") {
    return (
      <div className="th-scanlines relative overflow-hidden mb-7 bg-th-panel border border-th-line rounded-lg px-8 py-8">
        <div className="h-32 animate-pulse opacity-50">
          <div className="h-7 w-64 bg-th-line/60 rounded mb-3" />
          <div className="h-4 w-96 bg-th-line/40 rounded" />
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="th-scanlines relative overflow-hidden mb-7 bg-th-panel border border-th-danger/40 rounded-lg px-8 py-8">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-lg bg-th-danger/15 text-th-danger flex items-center justify-center">
            <ShieldAlert size={32} strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[24px] font-bold text-th-danger leading-tight">
              Snapshot unavailable
            </div>
            <div className="text-sm text-th-text-muted mt-1 font-mono">{state.error}</div>
          </div>
        </div>
      </div>
    );
  }

  const { data } = state;
  const intact = data.torhole.privacy_intact;

  return (
    <div
      className={`th-scanlines relative overflow-hidden mb-7 rounded-lg px-9 py-9 border ${
        intact
          ? "bg-gradient-to-br from-th-panel via-th-panel to-th-primary/[0.04] border-th-line"
          : "bg-th-panel border-th-danger/40"
      }`}
    >
      <div className="flex items-start gap-7">
        <div
          className={`w-[80px] h-[80px] rounded-xl flex items-center justify-center shrink-0 ${
            intact
              ? "bg-th-primary/12 text-th-primary ring-1 ring-th-primary/30 shadow-[0_0_36px_rgba(34,197,94,0.20)]"
              : "bg-th-danger/15 text-th-danger ring-1 ring-th-danger/30"
          }`}
        >
          {intact ? (
            <ShieldCheck size={42} strokeWidth={1.8} />
          ) : (
            <ShieldAlert size={42} strokeWidth={1.8} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`text-[34px] font-bold leading-[1.05] tracking-[-0.02em] ${
              intact ? "text-th-text" : "text-th-danger"
            }`}
          >
            {intact ? "DNS exits via Tor" : "Privacy guarantee compromised"}
          </div>
          <div className="text-[13.5px] text-th-text-muted mt-2">
            {data.torhole.headline}
          </div>
          <HeroProofTerminal data={data} />
        </div>
      </div>
    </div>
  );
}

function HeroProofTerminal({ data }: { data: Snapshot }) {
  // The proof block. Styled as a small terminal pane with a faint title row,
  // mono throughout, slightly inset background, no rounded corners on the
  // body. Reads like the output of `torhole verify --proof`.
  const totals = data.dns.totals;
  const rows: { label: string; value: string; status: StatusKind }[] = [
    {
      label: "tor.bootstrap",
      value: data.tor.bootstrap.detail || data.tor.bootstrap.status,
      status: data.tor.bootstrap.status as StatusKind,
    },
    {
      label: "tor.isolation",
      value: data.tor.isolation.detail || data.tor.isolation.status,
      status: data.tor.isolation.status as StatusKind,
    },
    {
      label: "dns.throughput",
      value: `${formatInt(totals.queries_today)} queries · ${formatInt(totals.blocked_today)} blocked · ${totals.block_pct}%`,
      status: "healthy",
    },
  ];

  return (
    <div className="mt-5 bg-th-bg/60 border border-th-line/80 rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-th-bg/40 border-b border-th-line/60">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-th-primary/60" />
          <span className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
            verifiable proof
          </span>
        </div>
        <span className="text-[9.5px] text-th-text-muted/50 font-mono">
          torhole.verify
        </span>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-3 text-[12.5px]">
            <StatusDot status={row.status} />
            <div className="text-th-text-muted font-mono uppercase tracking-[0.12em] text-[10.5px] w-[118px] shrink-0">
              {row.label}
            </div>
            <div className="text-th-text-mono font-mono flex-1 min-w-0 break-words">
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ status, size = "sm" }: { status: StatusKind; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";
  const cls =
    status === "healthy"
      ? "bg-th-primary"
      : status === "degraded"
      ? "bg-th-warning"
      : "bg-th-danger";
  return <span className={`rounded-full ${dim} ${cls} shrink-0`} aria-hidden="true" />;
}

/* ----------------------------------------------------------------------- *
 * Proof tile row — 4 distinct components, shared frame
 * ----------------------------------------------------------------------- */

function ProofRow({ state }: { state: SnapshotState }) {
  if (state.kind !== "ready") return null;
  const { data } = state;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 xl:gap-4 mb-7">
      <DnsTile data={data} />
      <TorTile data={data} />
      <AlertsTile data={data} />
      <BackupTile data={data} />
    </div>
  );
}

function TileFrame({
  label,
  status,
  children,
}: {
  label: string;
  status: "ok" | "warn" | "fail";
  children: React.ReactNode;
}) {
  const accent =
    status === "ok"
      ? "border-l-th-primary"
      : status === "warn"
      ? "border-l-th-warning"
      : "border-l-th-danger";
  return (
    <div
      className={`bg-th-panel border border-th-line border-l-2 ${accent} rounded-md p-4 flex flex-col gap-1.5 min-h-[88px]`}
    >
      <div className="text-[9.5px] uppercase tracking-[0.18em] text-th-text-muted font-mono flex items-center gap-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

/* DNS tile — throughput-focused. Big number is the count. Small block ratio
 * bar underneath shows the protected fraction. */
function DnsTile({ data }: { data: Snapshot }) {
  const dnsOk = data.dns.counts.healthy === data.dns.counts.total;
  const totals = data.dns.totals;
  const blockPct = Math.min(100, Math.max(0, totals.block_pct));
  return (
    <TileFrame label="DNS" status={dnsOk ? "ok" : "warn"}>
      <div className="flex items-baseline gap-1.5">
        <div className="text-[20px] font-mono leading-none text-th-text">
          {formatInt(totals.queries_today)}
        </div>
        <div className="text-[10.5px] text-th-text-muted font-mono">queries today</div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex-1 h-1 bg-th-line rounded-full overflow-hidden">
          <div
            className="h-full bg-th-primary"
            style={{ width: `${blockPct}%` }}
            aria-label={`${blockPct}% blocked`}
          />
        </div>
        <div className="text-[10.5px] font-mono text-th-text-muted shrink-0">
          {blockPct.toFixed(1)}% blocked
        </div>
      </div>
    </TileFrame>
  );
}

/* TOR tile — the privacy proof. A bold green BOOTSTRAPPED badge is the
 * primary element. The isolation status is the secondary line. */
function TorTile({ data }: { data: Snapshot }) {
  const bootstrapOk = data.tor.bootstrap.status === "healthy";
  const isolationOk = data.tor.isolation.status === "healthy";
  const overallOk = bootstrapOk && isolationOk;
  return (
    <TileFrame label="TOR" status={overallOk ? "ok" : "warn"}>
      <div className="flex items-center gap-1.5 mt-0.5">
        <ShieldCheck
          size={14}
          strokeWidth={2.5}
          className={bootstrapOk ? "text-th-primary" : "text-th-warning"}
        />
        <span
          className={`font-mono text-[11.5px] tracking-[0.06em] font-semibold ${
            bootstrapOk ? "text-th-primary" : "text-th-warning"
          }`}
        >
          {bootstrapOk ? "BOOTSTRAPPED" : "BOOTSTRAPPING"}
        </span>
      </div>
      <div className="text-[10.5px] text-th-text-muted font-mono mt-1 flex items-center gap-1.5">
        <StatusDot status={isolationOk ? "healthy" : "degraded"} />
        {isolationOk ? "isolation verified" : "isolation degraded"}
      </div>
    </TileFrame>
  );
}

/* ALERTS tile — delivery status. Shows N/M ratio and lists configured channels
 * as small chips so the operator sees which channels actually deliver. */
function AlertsTile({ data }: { data: Snapshot }) {
  const enabled = data.alerts.enabled_channels;
  const configured = data.alerts.configured_channels;
  const ok = enabled > 0 && enabled === configured;
  return (
    <TileFrame label="ALERTS" status={ok ? "ok" : configured === 0 ? "warn" : "warn"}>
      <div className="flex items-baseline gap-1.5">
        <div className="text-[20px] font-mono leading-none text-th-text">
          {enabled}
          <span className="text-th-text-muted/60">/{configured}</span>
        </div>
        <div className="text-[10.5px] text-th-text-muted font-mono">channels active</div>
      </div>
      <div className="text-[10.5px] text-th-text-muted font-mono mt-1">
        {data.alerts.total_channels} available · {configured - enabled} disabled
      </div>
    </TileFrame>
  );
}

/* BACKUP tile — recency-focused. The primary value is "X ago", the
 * secondary line shows the size and total snapshot count. A small clock
 * icon reinforces the time semantic. */
function BackupTile({ data }: { data: Snapshot }) {
  const last = data.backup.last_snapshot_at;
  const ok = data.backup.snapshot_count > 0;
  return (
    <TileFrame label="BACKUP" status={ok ? "ok" : "warn"}>
      <div className="flex items-center gap-1.5">
        <Clock size={13} className="text-th-text-muted" strokeWidth={2} />
        <div className="text-[15px] font-mono leading-none text-th-text">
          {last ? formatRelative(last) : "never"}
        </div>
      </div>
      <div className="text-[10.5px] text-th-text-muted font-mono mt-1.5">
        {data.backup.last_snapshot_size_bytes != null
          ? `${formatBytes(data.backup.last_snapshot_size_bytes)} · ${data.backup.snapshot_count} snapshot${
              data.backup.snapshot_count === 1 ? "" : "s"
            }`
          : "no snapshots"}
      </div>
    </TileFrame>
  );
}

/* ----------------------------------------------------------------------- *
 * Section header — used by Plane posture, Containers, etc.
 * Larger and more distinctive than iteration 1.
 * ----------------------------------------------------------------------- */

function SectionHeader({
  eyebrow,
  title,
  meta,
  action,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  action?: React.ReactNode;
}) {
  return (
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
  );
}

/* ----------------------------------------------------------------------- *
 * Per-plane DNS posture
 * ----------------------------------------------------------------------- */

function PlanePosture({ state }: { state: SnapshotState }) {
  if (state.kind !== "ready") return null;
  const planes = state.data.dns.planes;
  // A plane only truly "serves" when the shared Tor egress is up. Pi-hole
  // keeps counting forwarded queries while tor is bootstrapping/blocked, so
  // without this gate the cards render a dead upstream as healthy throughput.
  const torUp = state.data.tor.overall_status === "healthy";
  const allHealthy = torUp && planes.every((p) => p.status === "healthy");
  const servingCount = torUp
    ? planes.filter((p) => p.status === "healthy").length
    : 0;

  return (
    /*
     * flex flex-col + h-full: the parent grid uses align-items: stretch,
     * so this section gets sized to the taller of the two columns. The
     * inner panel uses flex-1 to absorb the extra height; PlaneCard
     * children inside the panel grid stretch via h-full so all 3 cards
     * land at the same height as well.
     */
    <section className="flex flex-col h-full">
      <SectionHeader
        eyebrow="upstream proof"
        title="DNS planes"
        meta={`${servingCount}/${planes.length} serving`}
      />
      <div
        className={`bg-th-panel border ${
          allHealthy ? "border-th-line" : "border-th-warning/40"
        } rounded-lg p-3 grid grid-cols-1 md:grid-cols-3 gap-2.5 flex-1`}
      >
        {planes.map((plane) => (
          <PlaneCard key={plane.id} plane={plane} torUp={torUp} />
        ))}
      </div>
    </section>
  );
}

function PlaneCard({ plane, torUp }: { plane: PlaneStat; torUp: boolean }) {
  // Tor down caps the plane at "degraded": its own containers may be fine,
  // but nothing it forwards can resolve, so green here would be a lie.
  const status = (
    torUp ? plane.status : plane.status === "offline" ? "offline" : "degraded"
  ) as StatusKind;
  const blockPct = Math.min(100, Math.max(0, plane.percent_blocked ?? 0));

  // Upstream chain is derived from the plane id — the architecture is
  // pi-hole → dnscrypt-proxy → tor:9050 → exit, one isolated path per VLAN.
  // Until tor.circuits is wired up via the Tor control port, the chain is
  // the topology proof. Rendered as a single nowrap line with ellipsis
  // fallback so all three plane cards are exactly the same height.
  const piholeNode = `pihole_${plane.id}`;
  const dnscryptNode = `dnscrypt_${plane.id}`;
  const torNode = "tor:9050";

  return (
    /*
     * h-full + flex column so the card stretches to the row height (set by
     * the parent grid), and content blocks can be pushed to the bottom with
     * mt-auto if the card is taller than its natural content.
     */
    <div className="rounded-md bg-th-bg/60 border border-th-line p-3.5 flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <div className="text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono">
            {plane.label}
          </div>
        </div>
        {torUp ? (
          <div className="text-[10.5px] uppercase tracking-[0.16em] text-th-primary font-mono font-semibold">
            via tor
          </div>
        ) : (
          <div className="text-[10.5px] uppercase tracking-[0.16em] text-th-danger font-mono font-semibold">
            tor down
          </div>
        )}
      </div>

      <div className="font-mono text-[19px] text-th-text leading-none mt-1">
        {formatInt(plane.queries_today)}
        <span className="text-[10.5px] text-th-text-muted ml-1.5 font-sans">queries</span>
      </div>
      {!torUp && (
        <div className="font-mono text-[10px] text-th-warning">
          egress down — forwarded queries are not resolving
        </div>
      )}
      <div className="font-mono text-[10.5px] text-th-text-muted">
        {formatInt(plane.blocked_today)} blocked
      </div>

      {/* Per-plane block ratio bar — mirrors the DNS tile pattern so the
       * three plane cards and the top DNS tile read as one visual family. */}
      <div className="mt-0.5 flex items-center gap-2">
        <div className="flex-1 h-1 bg-th-line rounded-full overflow-hidden">
          <div
            className="h-full bg-th-primary"
            style={{ width: `${blockPct}%` }}
            aria-label={`${blockPct}% blocked`}
          />
        </div>
        <div className="text-[10px] font-mono text-th-text-muted shrink-0 tabular-nums">
          {blockPct.toFixed(1)}%
        </div>
      </div>

      {/* Upstream proof chain — vertical 3-node stack with a network-diagram
       * style connector. Reads top-to-bottom like the actual data flow. No
       * wrapping risk because each node is on its own line. mt-auto anchors
       * the block to the bottom of the card. */}
      <div className="mt-auto pt-2.5 border-t border-th-line/60">
        <div className="text-[8.5px] uppercase tracking-[0.16em] text-th-text-muted/60 font-mono mb-2">
          upstream chain
        </div>
        <div className="font-mono text-[10.5px] text-th-text-mono">
          <ChainNode label={piholeNode} />
          <ChainNode label={dnscryptNode} />
          <ChainNode label={torNode} isLast />
        </div>
      </div>
    </div>
  );
}

function ChainNode({ label, isLast }: { label: string; isLast?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex flex-col items-center pt-[5px]">
        <div className="w-1.5 h-1.5 rounded-full bg-th-primary/70 ring-1 ring-th-primary/20" />
        {!isLast && <div className="w-px h-3 bg-th-line/80 mt-0.5" />}
      </div>
      <div className="text-th-text-mono leading-tight">{label}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Container strip — collapsed when all healthy
 * ----------------------------------------------------------------------- */

function ContainerStrip({ state }: { state: SnapshotState }) {
  if (state.kind !== "ready") return null;
  const containers = state.data.containers;
  const counts = state.data.container_counts;
  const allHealthy = counts.offline === 0 && counts.degraded === 0;

  // Default to expanded — operators want the full grid as a comfort blanket.
  // Toggle is still available; when something breaks we force-expand so the
  // bad apple is never hidden behind a click.
  const [collapsed, setCollapsed] = useState(false);
  const isExpanded = !allHealthy || !collapsed;

  const sorted = [...containers].sort((a, b) => {
    const order: Record<string, number> = { offline: 0, degraded: 1, healthy: 2 };
    const sa = order[a.status] ?? 3;
    const sb = order[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    if (a.core !== b.core) return a.core ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return (
    /*
     * flex flex-col + h-full so this section stretches to row height
     * (matched by PlanePosture). Inner panel is flex-1 to absorb extra
     * vertical space if any.
     */
    <section className="flex flex-col h-full">
      <SectionHeader
        eyebrow="stack"
        title="Containers"
        meta={`${counts.healthy}/${counts.total} healthy`}
        action={
          allHealthy ? (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="flex items-center gap-1 text-[10.5px] text-th-text-muted hover:text-th-text font-mono uppercase tracking-[0.14em]"
            >
              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {collapsed ? "expand" : "collapse"}
            </button>
          ) : null
        }
      />
      <div
        className={`bg-th-panel border ${
          allHealthy ? "border-th-line" : "border-th-warning/40"
        } rounded-lg p-3 flex-1`}
      >
        {!isExpanded ? (
          <div className="flex items-center gap-2.5 text-[12px] text-th-text-muted py-1 px-1">
            <StatusDot status="healthy" />
            <span className="font-mono">
              all {counts.total} containers healthy — {sorted.filter((c) => c.core).length} core
            </span>
          </div>
        ) : (
          /*
           * Below xl: stacked layout, container is full-width — pack chips
           * dense (4 cols on iPad-ish widths). At xl+: side-by-side layout,
           * the container column is narrower so back to 2 cols. At 2xl+:
           * more breathing room, back to 3 cols.
           */
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-3 gap-1.5">
            {sorted.map((c) => (
              <ContainerChip key={c.id} container={c} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ContainerChip({ container }: { container: ContainerInfo }) {
  const status = container.status as StatusKind;
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-th-bg/60 border border-th-line rounded text-[11.5px]">
      <StatusDot status={status} />
      <div className="font-mono text-th-text-mono truncate" title={container.name}>
        {container.name}
      </div>
      {container.core && (
        <div className="ml-auto text-[8.5px] uppercase tracking-[0.14em] text-th-text-muted/50 font-mono">
          core
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Quick actions — live buttons for the four most-used ops shortcuts.
 *
 * All four endpoints behind these buttons exist and are non-destructive:
 *   - Rotate Tor identity → POST /api/tor/rotate (global NEWNYM)
 *   - Run leak test       → POST /api/leak-test/run
 *   - Run validation      → POST /api/system/validate
 *   - Take snapshot       → POST /api/recovery/backup
 *
 * None of these need a ConfirmModal because none have a blast radius
 * bigger than "run something the user could have run from the relevant
 * section screen anyway." The Glance strip is the single-click shortcut
 * for people who know what they want.
 * ----------------------------------------------------------------------- */

type QuickActionId = "rotate" | "leak" | "validate" | "backup";

type QuickActionState =
  | { kind: "idle" }
  | { kind: "running"; id: QuickActionId }
  | { kind: "success"; id: QuickActionId; message: string }
  | { kind: "error"; id: QuickActionId; message: string };

function QuickActions({ refetch }: { refetch: () => void }) {
  const [state, setState] = useState<QuickActionState>({ kind: "idle" });

  // Auto-clear the success/error state after a short delay so the button
  // returns to idle. Long enough to read a glyph, short enough to not feel
  // sticky.
  useEffect(() => {
    if (state.kind !== "success" && state.kind !== "error") return;
    const delay = state.kind === "error" ? 5000 : 3500;
    const h = setTimeout(() => setState({ kind: "idle" }), delay);
    return () => clearTimeout(h);
  }, [state]);

  const run = async (id: QuickActionId, fn: () => Promise<unknown>, okMsg: string) => {
    setState({ kind: "running", id });
    try {
      await fn();
      setState({ kind: "success", id, message: okMsg });
      refetch();
      // Kick a second refetch after a beat so slower pipelines (validation,
      // backup) have time to update the snapshot with their result.
      setTimeout(refetch, 1800);
    } catch (err) {
      setState({ kind: "error", id, message: (err as Error).message });
    }
  };

  const actions: Array<{
    id: QuickActionId;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    hint: string;
    onClick: () => void;
  }> = [
    {
      id: "rotate",
      label: "Rotate Tor identity",
      icon: RefreshCw,
      hint: "global NEWNYM — rebuilds circuits on every plane",
      onClick: () => run("rotate", rotateTorIdentity, "circuits rotating"),
    },
    {
      id: "leak",
      label: "Run leak test",
      icon: Zap,
      hint: "SOCKS5 → Tor → check.torproject.org",
      onClick: () => run("leak", runLeakTest, "leak test complete"),
    },
    {
      id: "validate",
      label: "Run validation",
      icon: Sparkles,
      hint: "full stack validator",
      onClick: () => run("validate", runValidation, "validation complete"),
    },
    {
      id: "backup",
      label: "Take snapshot",
      icon: Database,
      hint: "archive of all stack volumes",
      onClick: () => run("backup", createBackup, "snapshot created"),
    },
  ];

  return (
    <section>
      <SectionHeader
        eyebrow="ops"
        title="Quick actions"
        meta="one click for common operations"
      />
      <div className="bg-th-panel border border-th-line rounded-lg p-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
        {actions.map((action) => (
          <QuickActionButton key={action.id} action={action} state={state} />
        ))}
      </div>
    </section>
  );
}

function QuickActionButton({
  action,
  state,
}: {
  action: {
    id: QuickActionId;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    hint: string;
    onClick: () => void;
  };
  state: QuickActionState;
}) {
  const { id, label, icon: Icon, hint, onClick } = action;
  const isRunning = state.kind === "running" && state.id === id;
  const isSuccess = state.kind === "success" && state.id === id;
  const isError = state.kind === "error" && state.id === id;
  // Disable all buttons while any action runs so we don't queue concurrent
  // writes to the backend (the backend can handle it, but the UX is weird).
  const disabled = state.kind === "running";

  const statusGlyph = isRunning ? (
    <RefreshCw size={13} className="animate-spin text-th-text-muted" />
  ) : isSuccess ? (
    <Check size={13} className="text-th-primary" strokeWidth={2.5} />
  ) : isError ? (
    <AlertCircle size={13} className="text-th-danger" />
  ) : (
    <Icon size={13} className="text-th-text-muted" />
  );

  // Inline status: only rendered while an action is live — idle buttons are
  // a clean single line (the hint lives in the tooltip). Errors show a short
  // slice; the full message is still in the tooltip via title below.
  const statusText = isRunning
    ? "running…"
    : isSuccess && state.kind === "success"
    ? state.message
    : isError && state.kind === "error"
    ? state.message.slice(0, 40)
    : null;

  const borderColor = isSuccess
    ? "border-th-primary/40 bg-th-primary/[0.04]"
    : isError
    ? "border-th-danger/40 bg-th-danger/[0.04]"
    : isRunning
    ? "border-th-line/80 bg-th-bg/60"
    : "border-th-line/60 bg-th-bg/40 hover:bg-th-bg/70 hover:border-th-primary/40";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={isError && state.kind === "error" ? state.message : hint}
      className={`flex items-center gap-2 px-3 rounded-md border transition-colors min-h-[42px] text-[12px] text-th-text ${borderColor} ${
        disabled && !isRunning ? "opacity-50 cursor-not-allowed" : ""
      }`}
    >
      {statusGlyph}
      <span className="truncate">{label}</span>
      {statusText && (
        <span
          className={`ml-auto pl-2 font-mono text-[9.5px] uppercase tracking-[0.12em] truncate max-w-[50%] ${
            isError ? "text-th-danger" : isSuccess ? "text-th-primary" : "text-th-text-muted/70"
          }`}
        >
          {statusText}
        </span>
      )}
    </button>
  );
}
