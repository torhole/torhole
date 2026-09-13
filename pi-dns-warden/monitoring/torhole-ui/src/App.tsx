/* Torhole administration shell, navigation, and shared operational actions. */

import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  Database,
  HardDrive,
  Info,
  Lock,
  LogOut,
  Moon,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  Zap,
} from "lucide-react";
import { Routes, Route, NavLink, Navigate, Link, useLocation } from "react-router-dom";
import PrivacyScreen from "./screens/Privacy";
import OperateScreen from "./screens/Operate";
import ConfigureScreen from "./screens/Configure";
import SetupScreen from "./screens/Setup";
import HomeScreen from "./screens/Home";
import AboutScreen from "./screens/About";
import Glance from "./screens/Glance";
import {
  createBackup,
  rotateTorIdentity,
  runLeakTest,
  runValidation,
  useBuildInfo,
  useSnapshot,
} from "./lib/snapshot";

const SIDEBAR_COLLAPSED_KEY = "torhole.sidebar.collapsed";
const LEGACY_SIDEBAR_COLLAPSED_KEY = "torhole.v2.sidebar.collapsed";
const THEME_KEY = "torhole.theme";
const LEGACY_THEME_KEY = "torhole.v2.theme";
type ThemePreference = "dark" | "light";
export default function App() {
  const [theme, setTheme] = useThemePreference();
  const developmentMode = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("mode")
    : null;
  if (window.__TORHOLE_MODE__ === "home" || developmentMode === "home") {
    return (
      <>
        <HomeScreen />
        <FloatingThemeControl theme={theme} onChange={setTheme} />
      </>
    );
  }
  if (window.__TORHOLE_MODE__ === "bootstrap" || developmentMode === "bootstrap") {
    return (
      <>
        <SetupScreen bootstrap />
        <FloatingThemeControl theme={theme} onChange={setTheme} />
      </>
    );
  }
  return <AdvancedApp theme={theme} onThemeChange={setTheme} />;
}

declare global {
  interface Window {
    __TORHOLE_MODE__?: "home" | "advanced" | "bootstrap";
  }
}

function useThemePreference(): [ThemePreference, (theme: ThemePreference) => void] {
  const [theme, setTheme] = useState<ThemePreference>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new Event("torhole-theme"));
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage may be unavailable */
    }
  }, [theme]);
  return [theme, setTheme];
}

function AdvancedApp({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  // Sidebar collapse state — persisted in localStorage so the operator's
  // preference survives reloads. Defaults to expanded; click the chevron at
  // the bottom of the sidebar to collapse on narrower screens (iPad).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ??
        localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY)
      ) === "true";
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
        theme={theme}
        onThemeChange={onThemeChange}
      />
      <main className="flex-1 min-w-0 flex flex-col">
        <EnvBannerStrip />
        <div className="flex-1 min-h-0">
          <Routes>
            <Route path="/" element={<GlanceScreen />} />
            <Route path="/privacy" element={<PrivacyScreen />} />
            <Route path="/operate" element={<OperateScreen />} />
            <Route path="/configure" element={<ConfigureScreen />} />
            <Route path="/about" element={<AboutScreen />} />
            {/* Setup is a first-run surface. Installed systems are maintained
                from Configure; a stale bookmark must not reopen commissioning. */}
            <Route path="/setup" element={<Navigate to="/configure" replace />} />
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
  if (window.location.protocol === "http:") {
    window.location.reload();
    return;
  }
  const parts = window.location.hostname.split(".");
  const authHost = ["auth", ...parts.slice(1)].join(".");
  const rd = encodeURIComponent(`${window.location.origin}/`);
  window.location.href = `${window.location.protocol}//${authHost}/logout?rd=${rd}`;
}

type SidebarGroup = {
  to: string;
  label: string;
  icon: typeof Activity;
  children?: Array<{ label: string; section: string }>;
};

function Sidebar({
  collapsed,
  onToggle,
  theme,
  onThemeChange,
}: {
  collapsed: boolean;
  onToggle: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  const location = useLocation();
  const buildState = useBuildInfo();
  const version = buildState.kind === "ready" ? `v${buildState.data.version}` : "version unknown";
  const groups: SidebarGroup[] = [
    { to: "/", label: "Glance", icon: Activity },
    {
      to: "/privacy",
      label: "Privacy",
      icon: Lock,
      children: [
        { label: "DNS leak test", section: "leak-test" },
        { label: "Live queries", section: "query-feed" },
        { label: "Tor circuits", section: "internal" },
      ],
    },
    {
      to: "/operate",
      label: "Operate",
      icon: HardDrive,
      children: [
        { label: "Containers", section: "containers" },
        { label: "Backups", section: "backups" },
        { label: "Validation", section: "validation" },
        { label: "Insights", section: "insights" },
      ],
    },
    {
      to: "/configure",
      label: "Configure",
      icon: Network,
      children: [
        { label: "Identity & access", section: "identity" },
        { label: "Topology", section: "topology" },
        { label: "Alert channels", section: "alerts" },
        { label: "Banner", section: "banner" },
        { label: "App parameters", section: "advanced" },
      ],
    },
    { to: "/about", label: "About", icon: Info },
  ];
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    [location.pathname]: true,
  }));
  const selectedSection = new URLSearchParams(location.search).get("section");

  useEffect(() => {
    if (location.pathname !== "/") {
      setExpanded((current) => ({ ...current, [location.pathname]: true }));
    }
  }, [location.pathname]);

  return (
    <aside
      className={`sticky top-0 h-screen self-start shrink-0 overflow-hidden border-r border-th-line bg-th-panel/40 backdrop-blur-sm flex flex-col transition-[width] duration-200 ${
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

      <nav className={`min-h-0 flex-1 space-y-1 overflow-y-auto ${collapsed ? "px-2" : "px-3"}`}>
        {groups.map(({ to, label, icon: Icon, children }) => {
          const active = location.pathname === to;
          const open = !collapsed && Boolean(children && expanded[to]);
          return (
            <div key={to}>
              <div className="flex items-center gap-1">
                <NavLink
                  to={to}
                  end={to === "/"}
                  title={collapsed ? label : undefined}
                  className={[
                    "flex min-h-[44px] flex-1 items-center rounded-md text-[13px] transition-all",
                    collapsed ? "justify-center px-2" : "gap-2.5 px-3",
                    active
                      ? collapsed
                        ? "bg-th-line/60 text-th-text shadow-[inset_0_0_20px_rgba(34,197,94,0.05)]"
                        : "-ml-0.5 border-l-2 border-l-th-primary bg-th-line/60 pl-[10px] text-th-text"
                      : "text-th-text-muted hover:bg-th-line/30 hover:text-th-text",
                  ].join(" ")}
                >
                  <Icon size={15} strokeWidth={2} />
                  {!collapsed && <span>{label}</span>}
                </NavLink>
                {!collapsed && children && (
                  <button
                    type="button"
                    aria-label={`${open ? "Collapse" : "Expand"} ${label} menu`}
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => ({ ...current, [to]: !current[to] }))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-th-text-muted hover:bg-th-line/40 hover:text-th-text"
                  >
                    <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
              {open && children && (
                <div className="relative ml-[18px] mt-1 space-y-0.5 border-l border-th-line/80 pl-3">
                  {children.map((child) => {
                    const childActive =
                      active && (selectedSection || children[0].section) === child.section;
                    return (
                      <Link
                        key={child.section}
                        to={`${to}?section=${child.section}`}
                        className={`group flex min-h-[34px] items-center gap-2 rounded px-2 text-[11px] transition-colors ${
                          childActive
                            ? "bg-th-primary/[0.08] text-th-primary"
                            : "text-th-text-muted/75 hover:bg-th-line/25 hover:text-th-text"
                        }`}
                      >
                        <span className={`h-1 w-1 rounded-full ${childActive ? "bg-th-primary shadow-[0_0_8px_var(--color-th-primary)]" : "bg-th-text-muted/35 group-hover:bg-th-primary/60"}`} />
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className={`mt-2 shrink-0 border-t border-th-line/50 pt-3 ${collapsed ? "px-2" : "px-3"}`}>
        <ThemeControl collapsed={collapsed} theme={theme} onChange={onThemeChange} />
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
        <div className="shrink-0 border-t border-th-line/40 px-5 py-4 text-[10px] text-th-text-muted/50 font-mono uppercase tracking-[0.14em]">
          Torhole {version}
        </div>
      )}
    </aside>
  );
}

function ThemeControl({
  collapsed,
  theme,
  onChange,
}: {
  collapsed: boolean;
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  if (collapsed) {
    const Icon = theme === "light" ? Sun : Moon;
    const next = theme === "light" ? "dark" : "light";
    return (
      <button
        type="button"
        title={`Switch to ${next} theme`}
        aria-label={`Switch to ${next} theme`}
        onClick={() => onChange(next)}
        className="mb-1 flex min-h-[44px] w-full items-center justify-center rounded-md text-th-text-muted hover:bg-th-line/30 hover:text-th-text"
      >
        <Icon size={15} />
      </button>
    );
  }
  return (
    <div className="mb-2 flex min-h-[44px] items-center justify-between px-1">
      <span className="font-mono text-[8.5px] uppercase tracking-[0.15em] text-th-text-muted/55">Appearance</span>
      <ThemeSwitch theme={theme} onChange={onChange} />
    </div>
  );
}

function ThemeSwitch({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex rounded-full border border-th-line/70 bg-th-line/55 p-[3px] shadow-inner"
    >
      {([
        { value: "light" as const, label: "Light", icon: Sun },
        { value: "dark" as const, label: "Dark", icon: Moon },
      ]).map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={`${label} theme`}
          aria-pressed={theme === value}
          title={`${label} theme`}
          onClick={() => onChange(value)}
          className={`flex h-7 w-7 items-center justify-center rounded-full transition-all duration-200 ${
            theme === value
              ? "bg-th-panel text-th-text shadow-[0_2px_8px_rgba(0,0,0,0.22)] ring-1 ring-th-line"
              : "text-th-text-muted/65 hover:text-th-text"
          }`}
        >
          <Icon size={14} strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}

function FloatingThemeControl({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  return (
    <div className="fixed bottom-5 right-5 z-50 rounded-full bg-th-panel/85 p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)] backdrop-blur">
      <ThemeSwitch theme={theme} onChange={onChange} />
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Glance screen
 * ----------------------------------------------------------------------- */

function GlanceScreen() {
  const { state, refetch } = useSnapshot();
  return <Glance state={state} actions={<QuickActions refetch={refetch} />} />;
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
      // Kick a second refetch after a beat so slower pipelines (validation,
      // backup) have time to update the snapshot with their result.
      setTimeout(refetch, 1800);
    } catch (err) {
      setState({ kind: "error", id, message: (err as Error).message });
    } finally {
      // Failed domain results also change the recorded checks.
      refetch();
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
      onClick: () => run("leak", async () => {
        const result = await runLeakTest();
        if (!result.pass) {
          throw new Error(result.error || (result.verification_status === "unavailable"
            ? "Leak test unavailable"
            : "Leak test failed: exit is not Tor"));
        }
      }, "leak test passed"),
    },
    {
      id: "validate",
      label: "Run validation",
      icon: Sparkles,
      hint: "full stack validator",
      onClick: () => run("validate", async () => {
        const result = await runValidation();
        if (result.status !== "success") throw new Error(result.summary || "Validation failed");
      }, "validation passed"),
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
      <h2 className="text-sm font-semibold mb-3">Quick actions</h2>
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
