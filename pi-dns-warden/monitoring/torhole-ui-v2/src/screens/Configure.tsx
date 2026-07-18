/*
 * Configure screen — "Where do I set the things I'm allowed to set?"
 *
 * Iteration 1 scope:
 *   - Identity & access: read-only admin user, session info
 *   - Topology: read-only summary of network config from .env
 *   - Alerts: list notification channels, enable/disable toggle (wired)
 *   - Advanced: grouped read-only display of the full .env keyset
 *
 * Scoped OUT of iteration 1 — each is its own session-worth of work:
 *   - Change admin password (needs Authelia re-render flow)
 *   - DNS upstream editor (per-plane dnscrypt resolver list)
 *   - Blocklist/gravity URL editor
 *   - Per-plane allow/deny domain editors
 *   - Backup schedule editor
 *   - Alert channel "Send test" buttons (no backend endpoint yet)
 *
 * Design principle: this screen is **read-heavy** and **write-safe**. The
 * only write action is toggling a notification channel, which is reversible.
 * Anything destructive or hard-to-reverse lives in Operate (with a
 * type-to-confirm modal once that's built).
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  KeyRound,
  Mail,
  Megaphone,
  MessageSquare,
  Network as NetworkIcon,
  Send,
  Shield,
  Terminal,
  User,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import SectionTabs, { type SectionTabDef } from "../components/SectionTabs";
import {
  fetchConfig,
  fetchNotificationChannels,
  formatRelative,
  sendTestAlert,
  setNotificationChannel,
  updateAdminPassword,
  updateConfigValue,
  useSnapshot,
  type NotificationChannel,
  type SnapshotState,
} from "../lib/snapshot";

export default function ConfigureScreen() {
  const { state } = useSnapshot();
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((data) => {
        if (!cancelled) setConfig(data.config);
      })
      .catch((e) => {
        if (!cancelled) setConfigErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keyCount = config ? Object.keys(config).length : null;

  const tabs: SectionTabDef[] = [
    {
      id: "identity",
      eyebrow: "access",
      title: "Identity & access",
      icon: <User size={11} />,
      content: <IdentitySection config={config} />,
    },
    {
      id: "topology",
      eyebrow: "network",
      title: "Topology",
      meta: "read-only · edit in .env",
      icon: <NetworkIcon size={11} />,
      content: <TopologySection config={config} />,
    },
    {
      id: "alerts",
      eyebrow: "delivery",
      title: "Alert channels",
      icon: <Send size={11} />,
      content: <AlertsSection />,
    },
    {
      id: "banner",
      eyebrow: "display",
      title: "Banner",
      icon: <Megaphone size={11} />,
      content: <BannerSection config={config} />,
    },
    {
      id: "advanced",
      eyebrow: "reference",
      title: "Advanced",
      meta: keyCount != null ? `${keyCount} keys` : undefined,
      icon: <Terminal size={11} />,
      content: <AdvancedSection config={config} />,
    },
  ];

  return (
    <div className="px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
      <Header state={state} />

      {configErr && (
        <div className="flex items-start gap-2 p-3 mb-4 bg-th-danger/10 border border-th-danger/30 rounded text-[12px] text-th-danger font-mono">
          <AlertCircle size={14} />
          {configErr}
        </div>
      )}

      <SectionTabs tabs={tabs} defaultTabId="identity" />
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
          Configure
        </div>
        <h1 className="text-[28px] font-bold tracking-tight mt-1 leading-none">
          What can you tune?
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
 * Identity & access — read-only for now
 * ----------------------------------------------------------------------- */

function IdentitySection({ config }: { config: Record<string, string> | null }) {
  const user = config?.TORHOLE_ADMIN_USER || "—";
  const reverseDomain = config?.REVERSE_PROXY_DOMAIN || "—";
  const authHost = config?.TORHOLE_HOST_AUTH || "auth";
  return (
    <TabPanel>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <KVRow label="Admin user" value={user} mono />
        <KVRow label="Auth portal domain" value={`${authHost}.${reverseDomain}`} mono />
      </div>
      <div className="mt-6">
        <AdminPasswordForm />
      </div>
    </TabPanel>
  );
}

/* ----------------------------------------------------------------------- *
 * Admin password change form
 *
 * Two password inputs with client-side validation, then a type-to-confirm
 * modal gate before the POST hits the backend. The backend flow:
 *   1. write TORHOLE_ADMIN_PASSWORD into .env (backed up first)
 *   2. run ops/scripts/18-render-auth.sh to regenerate users_database.yml
 *   3. docker restart authelia
 *
 * After success we surface a "please log in again" banner — the old
 * session is still valid until Authelia finishes its restart cycle,
 * so reloading the page is the fastest way to end up on the new creds.
 * ----------------------------------------------------------------------- */

type AdminPasswordState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function AdminPasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<AdminPasswordState>({ kind: "idle" });

  // Client-side validation mirrors the backend policy so the operator
  // gets immediate feedback. The backend still enforces these same
  // rules — this is UX, not security.
  const validationError = (() => {
    if (newPassword.length === 0) return null;
    if (newPassword.length < 12) return "At least 12 characters.";
    if (newPassword.length > 128) return "At most 128 characters.";
    if (!/[a-z]/.test(newPassword)) return "Must include a lowercase letter.";
    if (!/[A-Z]/.test(newPassword)) return "Must include an uppercase letter.";
    if (!/\d/.test(newPassword)) return "Must include a digit.";
    if (/[\r\n]/.test(newPassword)) return "Cannot contain line breaks.";
    return null;
  })();

  const mismatchError =
    confirmPassword.length > 0 && newPassword !== confirmPassword
      ? "Passwords do not match."
      : null;

  const reuseError =
    newPassword.length > 0 && currentPassword.length > 0 && currentPassword === newPassword
      ? "New password must differ from the current one."
      : null;

  const canSubmit =
    state.kind !== "running" &&
    currentPassword.length > 0 &&
    newPassword.length >= 12 &&
    validationError === null &&
    mismatchError === null &&
    reuseError === null &&
    confirmPassword.length > 0;

  const submit = async () => {
    setState({ kind: "running" });
    try {
      const result = await updateAdminPassword(
        currentPassword,
        newPassword,
        confirmPassword,
      );
      setState({ kind: "success", message: result.message });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setModalOpen(false);
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
      setModalOpen(false);
    }
  };

  if (state.kind === "success") {
    return (
      <div className="rounded-md border border-th-primary/40 bg-th-primary/[0.06] p-4">
        <div className="flex items-start gap-2">
          <Check size={14} className="text-th-primary shrink-0 mt-0.5" strokeWidth={2.5} />
          <div className="flex-1">
            <div className="text-[12px] font-semibold text-th-primary">
              Admin password updated
            </div>
            <div className="text-[11px] text-th-text-muted mt-1 leading-relaxed">
              {state.message} Authelia has been restarted; your current
              session will end as soon as the container finishes booting
              (typically a few seconds). Reload the page and sign in with
              the new password.
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 px-3 py-2 rounded text-[10.5px] font-mono uppercase tracking-[0.14em] bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 min-h-[36px]"
            >
              reload to sign in again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="text-[10px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2">
        Change admin password
      </div>

      {/* Current password sits alone on its own row — it's the
          authorization gate, not a symmetrical input with the new
          fields. The backend rejects the whole request (before any
          write) if this doesn't match the plaintext currently in .env. */}
      <div className="mb-3">
        <label className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
          Current password
        </label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={state.kind === "running"}
          autoComplete="current-password"
          placeholder="verify it's really you"
          className="w-full md:w-1/2 px-3 py-2.5 bg-th-bg/60 border border-th-line rounded-md text-[13px] font-mono text-th-text-mono outline-none focus:border-th-primary/40 disabled:opacity-50"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
            New password
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={state.kind === "running"}
            autoComplete="new-password"
            placeholder="min 12 chars, mixed case + digit"
            className="w-full px-3 py-2.5 bg-th-bg/60 border border-th-line rounded-md text-[13px] font-mono text-th-text-mono outline-none focus:border-th-primary/40 disabled:opacity-50"
          />
          {validationError && (
            <div className="mt-1 text-[10px] text-th-warning font-mono">
              {validationError}
            </div>
          )}
          {reuseError && (
            <div className="mt-1 text-[10px] text-th-warning font-mono">
              {reuseError}
            </div>
          )}
        </div>
        <div>
          <label className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
            Confirm new password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={state.kind === "running"}
            autoComplete="new-password"
            placeholder="type it again"
            className="w-full px-3 py-2.5 bg-th-bg/60 border border-th-line rounded-md text-[13px] font-mono text-th-text-mono outline-none focus:border-th-primary/40 disabled:opacity-50"
          />
          {mismatchError && (
            <div className="mt-1 text-[10px] text-th-warning font-mono">
              {mismatchError}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-start gap-3">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={!canSubmit}
          className={`px-3 rounded-md text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[44px] flex items-center gap-1.5 transition-colors ${
            canSubmit
              ? "bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40"
              : "bg-th-bg/60 border border-th-line/40 text-th-text-muted/40 cursor-not-allowed"
          }`}
        >
          <KeyRound size={12} />
          update password
        </button>
        <div className="text-[10px] text-th-text-muted/70 font-mono leading-relaxed flex-1">
          Writes <span className="text-th-text-mono">TORHOLE_ADMIN_PASSWORD</span>{" "}
          to <span className="text-th-text-mono">.env</span>, reruns{" "}
          <span className="text-th-text-mono">ops/scripts/18-render-auth.sh</span>
          , and restarts the authelia container. You will need to sign in again.
        </div>
      </div>

      {state.kind === "error" && (
        <div className="mt-3 px-2 py-1.5 text-[11px] text-th-danger font-mono bg-th-danger/10 border border-th-danger/30 rounded">
          {state.message}
        </div>
      )}

      <ConfirmModal
        open={modalOpen}
        title="Change admin password"
        confirmWord="UPDATE"
        confirmLabel="Update password"
        kind="danger"
        body={
          <>
            <p className="mb-2">
              This rewrites the admin password hash in Authelia's user
              database and restarts the authelia container. Your current
              session will end within a few seconds.
            </p>
            <p className="text-th-text-muted">
              Make sure the new password is stored safely before confirming —
              if the restart succeeds and you forgot it, you'll need SSH
              access to the host to recover.
            </p>
          </>
        }
        onCancel={() => setModalOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}

/* ----------------------------------------------------------------------- *
 * Topology — read-only summary
 * ----------------------------------------------------------------------- */

function TopologySection({ config }: { config: Record<string, string> | null }) {
  const parent = config?.PARENT_IF;
  const tz = config?.TZ;
  const hostIp = config?.HOST_MGMT_IP;

  const planes: Array<{
    id: "trusted" | "iot";
    label: string;
    parentKey: string;
    idKey: string;
    subnetKey: string;
    gwKey: string;
    piholeIpKey: string;
  }> = [
    {
      id: "trusted",
      label: "Trusted",
      parentKey: "TRUSTED_PARENT",
      idKey: "TRUSTED_VLAN_ID",
      subnetKey: "TRUSTED_SUBNET_CIDR",
      gwKey: "TRUSTED_GATEWAY",
      piholeIpKey: "PIHOLE_TRUSTED_IP",
    },
    {
      id: "iot",
      label: "IoT",
      parentKey: "IOT_PARENT",
      idKey: "IOT_VLAN_ID",
      subnetKey: "IOT_SUBNET_CIDR",
      gwKey: "IOT_GATEWAY",
      piholeIpKey: "PIHOLE_IOT_IP",
    },
  ];

  return (
    <TabPanel>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <KVRow label="Parent interface" value={parent} mono />
        <KVRow label="Host management IP" value={hostIp} mono />
        <KVRow label="Timezone" value={tz} mono />
      </div>

      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2 mt-1">
        VLANs
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {planes.map((plane) => (
          <div
            key={plane.id}
            className="rounded-md bg-th-bg/60 border border-th-line p-3"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-th-primary" />
              <div className="text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono">
                {plane.label}
              </div>
            </div>
            <div className="space-y-1.5">
              <TinyKV label="parent" value={config?.[plane.parentKey]} />
              <TinyKV label="vlan id" value={config?.[plane.idKey]} />
              <TinyKV label="subnet" value={config?.[plane.subnetKey]} />
              <TinyKV label="gateway" value={config?.[plane.gwKey]} />
              <TinyKV label="pihole ip" value={config?.[plane.piholeIpKey]} />
            </div>
          </div>
        ))}
      </div>
    </TabPanel>
  );
}

/* ----------------------------------------------------------------------- *
 * Alerts — list channels, enable/disable toggle
 * ----------------------------------------------------------------------- */

type TestAlertState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; ok: boolean; message: string };

/* ----------------------------------------------------------------------- *
 * Banner — operator-configured environment strip shown across the top of
 * every screen (TORHOLE_BANNER_TEXT / TORHOLE_BANNER_LEVEL in .env). The
 * backend reads the values live per snapshot, so a save here is visible on
 * all screens within a few seconds — no restart, no redeploy.
 * ----------------------------------------------------------------------- */

const BANNER_LEVELS: Array<{
  id: string;
  label: string;
  hint: string;
  chip: string;
  strip: string;
  dot: string;
}> = [
  {
    id: "info",
    label: "Info",
    hint: "green",
    chip: "border-th-primary/50 text-th-primary bg-th-primary/10",
    strip: "bg-th-primary/10 border-th-primary/40 text-th-primary",
    dot: "bg-th-primary",
  },
  {
    id: "warning",
    label: "Warning",
    hint: "amber",
    chip: "border-th-warning/50 text-th-warning bg-th-warning/10",
    strip: "bg-th-warning/15 border-th-warning/50 text-th-warning",
    dot: "bg-th-warning",
  },
  {
    id: "critical",
    label: "Critical",
    hint: "red",
    chip: "border-th-danger/50 text-th-danger bg-th-danger/10",
    strip: "bg-th-danger/15 border-th-danger/50 text-th-danger",
    dot: "bg-th-danger",
  },
];

type BannerSaveState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function BannerSection({ config }: { config: Record<string, string> | null }) {
  const [text, setText] = useState("");
  const [level, setLevel] = useState("info");
  const [seeded, setSeeded] = useState(false);
  const [save, setSave] = useState<BannerSaveState>({ kind: "idle" });

  // Seed the form once from the loaded config (config arrives async).
  useEffect(() => {
    if (config && !seeded) {
      setText(config.TORHOLE_BANNER_TEXT || "");
      const lvl = (config.TORHOLE_BANNER_LEVEL || "info").toLowerCase();
      setLevel(BANNER_LEVELS.some((l) => l.id === lvl) ? lvl : "info");
      setSeeded(true);
    }
  }, [config, seeded]);

  const active = BANNER_LEVELS.find((l) => l.id === level) ?? BANNER_LEVELS[0];
  const trimmed = text.trim();

  const apply = async (nextText: string) => {
    setSave({ kind: "running" });
    try {
      await updateConfigValue("TORHOLE_BANNER_TEXT", nextText);
      await updateConfigValue("TORHOLE_BANNER_LEVEL", level);
      setSave({
        kind: "success",
        message: nextText
          ? "Banner saved — it appears on every screen within a few seconds."
          : "Banner cleared.",
      });
    } catch (e) {
      setSave({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2">
        Environment banner
      </div>
      <p className="text-[11.5px] text-th-text-muted leading-relaxed mb-4 max-w-[640px]">
        A strip shown across the top of every screen — mark this instance
        (e.g. staging) or post an operator message. Changes go live on all
        open sessions within a few seconds; clearing the text removes the
        banner.
      </p>

      <label className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
        Message
      </label>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={save.kind === "running"}
        maxLength={200}
        placeholder="e.g. STAGING ENVIRONMENT — data may be reset at any time"
        className="w-full md:w-2/3 px-3 py-2.5 bg-th-bg/60 border border-th-line rounded-md text-[13px] font-mono text-th-text-mono outline-none focus:border-th-primary/40 disabled:opacity-50"
      />

      <div className="mt-4">
        <label className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
          Severity
        </label>
        <div className="flex gap-2">
          {BANNER_LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLevel(l.id)}
              disabled={save.kind === "running"}
              className={`px-3 py-2 rounded-md border text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[36px] transition-colors ${
                level === l.id
                  ? l.chip
                  : "border-th-line text-th-text-muted hover:text-th-text"
              }`}
            >
              {l.label} · {l.hint}
            </button>
          ))}
        </div>
      </div>

      {/* Live preview of exactly what the strip will look like. */}
      <div className="mt-5">
        <div className="text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/80 font-mono mb-1.5">
          Preview
        </div>
        {trimmed ? (
          <div
            className={`flex items-center justify-center gap-2.5 border rounded-md px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.14em] ${active.strip}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${active.dot}`} />
            <span className="truncate">{trimmed}</span>
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${active.dot}`} />
          </div>
        ) : (
          <div className="border border-dashed border-th-line rounded-md px-4 py-2 text-[11px] font-mono text-th-text-muted/50 text-center">
            no banner — message is empty
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => apply(trimmed)}
          disabled={save.kind === "running" || !seeded || trimmed.length === 0}
          className="px-4 py-2 rounded text-[10.5px] font-mono uppercase tracking-[0.14em] bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 disabled:opacity-40 min-h-[36px]"
        >
          {save.kind === "running" ? "saving…" : "save banner"}
        </button>
        <button
          type="button"
          onClick={() => {
            setText("");
            void apply("");
          }}
          disabled={save.kind === "running" || !seeded}
          className="px-4 py-2 rounded text-[10.5px] font-mono uppercase tracking-[0.14em] border border-th-line text-th-text-muted hover:text-th-text hover:border-th-danger/40 disabled:opacity-40 min-h-[36px]"
        >
          clear banner
        </button>
      </div>

      {save.kind === "success" && (
        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-th-primary font-mono">
          <Check size={13} strokeWidth={2.5} /> {save.message}
        </div>
      )}
      {save.kind === "error" && (
        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-th-danger font-mono">
          <AlertCircle size={13} /> {save.message}
        </div>
      )}
    </div>
  );
}

function AlertsSection() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [testAlert, setTestAlert] = useState<TestAlertState>({ kind: "idle" });

  const load = async () => {
    setLoading(true);
    try {
      setChannels(await fetchNotificationChannels());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (channel: string, enabled: boolean) => {
    setPending(channel);
    try {
      const next = await setNotificationChannel(channel, enabled);
      setChannels(next);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  const handleTest = async () => {
    setTestAlert({ kind: "running" });
    try {
      const result = await sendTestAlert();
      setTestAlert({ kind: "done", ok: result.ok, message: result.message });
    } catch (e) {
      setTestAlert({ kind: "done", ok: false, message: (e as Error).message });
    }
    setTimeout(() => setTestAlert({ kind: "idle" }), 5000);
  };

  const activeCount = channels.filter((c) => c.enabled).length;

  return (
    <TabPanel
      action={
        <>
          <div className="text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em] mr-auto">
            {channels.length > 0
              ? `${activeCount}/${channels.length} active`
              : "loading…"}
          </div>
          <button
            type="button"
            onClick={handleTest}
            disabled={testAlert.kind === "running" || activeCount === 0}
            className={`flex items-center gap-1.5 px-3 rounded-md text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[36px] transition-colors ${
              testAlert.kind === "running"
                ? "bg-th-bg/60 border border-th-line text-th-text-muted cursor-wait"
                : testAlert.kind === "done" && testAlert.ok
                ? "bg-th-primary/15 border border-th-primary/40 text-th-primary"
                : testAlert.kind === "done" && !testAlert.ok
                ? "bg-th-danger/10 border border-th-danger/40 text-th-danger"
                : activeCount === 0
                ? "bg-th-bg/60 border border-th-line/40 text-th-text-muted/40 cursor-not-allowed"
                : "bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40"
            }`}
            title={
              activeCount === 0
                ? "Enable at least one channel to send a test"
                : "Send a test alert through Alertmanager"
            }
          >
            {testAlert.kind === "running" ? (
              <>
                <Send size={12} className="animate-pulse" />
                sending…
              </>
            ) : testAlert.kind === "done" && testAlert.ok ? (
              <>
                <Check size={12} strokeWidth={2.5} />
                sent
              </>
            ) : testAlert.kind === "done" ? (
              <>
                <AlertCircle size={12} />
                failed
              </>
            ) : (
              <>
                <Send size={12} />
                send test
              </>
            )}
          </button>
        </>
      }
    >
      {loading && channels.length === 0 ? (
        <div className="text-[11px] text-th-text-muted py-3 font-mono">loading…</div>
      ) : err ? (
        <div className="flex items-start gap-2 text-[11px] text-th-danger font-mono py-2">
          <AlertCircle size={13} />
          {err}
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              pending={pending === c.id}
              onToggle={(enabled) => toggle(c.id, enabled)}
            />
          ))}
        </div>
      )}

      {testAlert.kind === "done" && !testAlert.ok && (
        <div className="mt-3 px-2 py-1.5 text-[11px] text-th-danger font-mono bg-th-danger/10 border border-th-danger/30 rounded">
          {testAlert.message}
        </div>
      )}
    </TabPanel>
  );
}

function ChannelRow({
  channel,
  pending,
  onToggle,
}: {
  channel: NotificationChannel;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const icon =
    channel.id === "telegram" ? (
      <MessageSquare size={14} className="text-th-text-muted" />
    ) : channel.id === "email" ? (
      <Mail size={14} className="text-th-text-muted" />
    ) : (
      <Send size={14} className="text-th-text-muted" />
    );

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-th-bg/40 border border-th-line/60 rounded">
      <div className="w-7 h-7 rounded bg-th-bg/60 border border-th-line/60 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-semibold text-th-text">{channel.label}</div>
        <div className="text-[10px] font-mono text-th-text-muted/70 mt-0.5">
          {channel.configured
            ? `configured via ${channel.enabled_key}`
            : "not configured in .env"}
        </div>
      </div>
      <Toggle
        enabled={channel.enabled}
        disabled={!channel.configured || pending}
        onChange={onToggle}
      />
    </div>
  );
}

function Toggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  // Outer button provides the 44px touch target via padding. Inner pill is
  // the visual 44x24 track with an absolutely-positioned 20px knob, so the
  // round shape stays correct regardless of the outer button's true size.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`p-2 flex items-center justify-center shrink-0 ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      }`}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      <span
        className={`relative block w-11 h-6 rounded-full transition-colors ${
          disabled
            ? "bg-th-line/30 opacity-60"
            : enabled
            ? "bg-th-primary/70 hover:bg-th-primary/90"
            : "bg-th-line hover:bg-th-line-strong"
        }`}
        aria-hidden="true"
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-[left] duration-150 ${
            enabled ? "left-[22px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------------- *
 * Advanced — read-only .env dump, collapsible
 * ----------------------------------------------------------------------- */

const ADVANCED_CATEGORIES: Array<{
  id: string;
  label: string;
  prefixes: string[];
}> = [
  { id: "pihole", label: "Pi-hole", prefixes: ["PIHOLE_"] },
  { id: "dnscrypt", label: "dnscrypt-proxy", prefixes: ["DNSCRYPT_"] },
  { id: "grafana", label: "Grafana / monitoring", prefixes: ["GRAFANA_", "PROMETHEUS_", "ALERTMANAGER_", "LOKI_", "ALLOY_", "BLACKBOX_", "NODE_EXPORTER_", "CADVISOR_"] },
  { id: "alerts", label: "Alerts", prefixes: ["ALERT_"] },
  { id: "auth", label: "Authelia / access", prefixes: ["AUTHELIA_", "TORHOLE_ADMIN", "REVERSE_PROXY_", "DOCKHAND_"] },
  { id: "torhole", label: "Torhole", prefixes: ["TORHOLE_", "TOR_", "BACKUP_"] },
];

function AdvancedSection({ config }: { config: Record<string, string> | null }) {
  // In the tab layout, Advanced no longer competes for space on the main
  // Configure page — it's always expanded when the tab is active.
  const [expanded, setExpanded] = useState(true);
  if (!config) {
    return (
      <TabPanel>
        <div className="text-[11px] text-th-text-muted py-3 font-mono">loading…</div>
      </TabPanel>
    );
  }

  // Categorize keys; put anything uncategorized under "other"
  const groups: Record<string, Array<[string, string]>> = {};
  const other: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(config)) {
    let matched = false;
    for (const cat of ADVANCED_CATEGORIES) {
      if (cat.prefixes.some((p) => k.startsWith(p))) {
        (groups[cat.id] ||= []).push([k, v]);
        matched = true;
        break;
      }
    }
    if (!matched) other.push([k, v]);
  }

  return (
    <TabPanel
      action={
        <>
          <div className="text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em] mr-auto">
            {Object.keys(config).length} keys in .env
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[10.5px] text-th-text-muted hover:text-th-text font-mono uppercase tracking-[0.14em] min-h-[36px] px-2"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? "collapse" : "expand"}
          </button>
        </>
      }
    >
      <div className="flex items-start gap-2 mb-3 p-3 bg-th-bg/40 border border-th-line/60 rounded text-[11px] text-th-text-muted leading-relaxed">
        <Shield size={13} className="text-th-text-muted/70 shrink-0 mt-0.5" />
        <div>
          These values live in{" "}
          <span className="font-mono text-th-text-mono">/opt/pi-dns-warden/.env</span>{" "}
          on the host. Edit the file and re-run{" "}
          <span className="font-mono text-th-text-mono">
            docker compose up -d
          </span>{" "}
          (or the relevant render script) to apply. Secrets are masked; the real
          values never leave the host.
        </div>
      </div>

      {expanded && (
        <div className="space-y-4">
          {ADVANCED_CATEGORIES.map(
            (cat) =>
              groups[cat.id] &&
              groups[cat.id].length > 0 && (
                <AdvancedGroup key={cat.id} label={cat.label} entries={groups[cat.id]} />
              ),
          )}
          {other.length > 0 && <AdvancedGroup label="Other" entries={other} />}
        </div>
      )}
    </TabPanel>
  );
}

function AdvancedGroup({
  label,
  entries,
}: {
  label: string;
  entries: Array<[string, string]>;
}) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-1.5">
        {label}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline gap-2 py-0.5 text-[11px] font-mono border-b border-th-line/20"
          >
            <span className="text-th-text-muted/70 truncate w-[200px] shrink-0" title={k}>
              {k}
            </span>
            <span
              className={`truncate ${v === "***" ? "text-th-text-muted/50 italic" : "text-th-text-mono"}`}
              title={v}
            >
              {v || "(empty)"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Reusable KV row + section card
 * ----------------------------------------------------------------------- */

function KVRow({ label, value, mono }: { label: string; value: string | undefined; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2.5 bg-th-bg/40 border border-th-line/60 rounded">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
        {label}
      </div>
      <div className={`text-[12.5px] ${mono ? "font-mono text-th-text-mono" : "text-th-text"}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function TinyKV({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex items-baseline gap-2 text-[10.5px]">
      <span className="text-[9px] uppercase tracking-[0.14em] text-th-text-muted/60 font-mono w-[60px] shrink-0">
        {label}
      </span>
      <span className="font-mono text-th-text-mono truncate" title={value}>
        {value || "—"}
      </span>
    </div>
  );
}

function TabPanel({
  action,
  className = "",
  children,
}: {
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`bg-th-panel border border-th-line rounded-lg p-4 ${className}`}>
      {action && (
        <div className="flex items-center justify-end gap-2 mb-3">{action}</div>
      )}
      {children}
    </div>
  );
}

// Satisfy strict TS: FileText is referenced only in the file as a type so
// that it remains importable by future sub-features.
export type { FileText };
