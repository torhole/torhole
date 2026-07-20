/*
 * Configure screen — "Where do I set the things I'm allowed to set?"
 *
 * Iteration 1 scope:
 *   - Identity & access: web-access status, CA download, admin password
 *   - Topology: read-only summary of network config from .env
 *   - Alerts: list notification channels, enable/disable toggle (wired)
 *   - Advanced: grouped per-key editor for non-secret .env values
 *
 * Scoped OUT of iteration 1 — each is its own session-worth of work:
 *   - DNS upstream editor (per-plane dnscrypt resolver list)
 *   - Blocklist/gravity URL editor
 *   - Per-plane allow/deny domain editors
 *   - Backup schedule editor
 *   - Alert channel "Send test" buttons (no backend endpoint yet)
 *
 * Design principle: this screen is **read-heavy** and **write-safe**. Generic
 * parameter editing is limited to non-secrets and every .env write is atomic
 * with a backup. Destructive runtime actions remain in Operate.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  KeyRound,
  Mail,
  Megaphone,
  MessageSquare,
  Network as NetworkIcon,
  Send,
  Shield,
  Terminal,
  Upload,
  User,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import SectionTabs, { type SectionTabDef } from "../components/SectionTabs";
import {
  applyCustomHttps,
  fetchConfig,
  fetchNotificationChannels,
  enableLocalHttps,
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
      eyebrow: "admin",
      title: "App parameters",
      meta: keyCount != null ? `${keyCount} keys · editable` : undefined,
      icon: <Terminal size={11} />,
      content: <AdvancedSection config={config} onConfigChange={setConfig} />,
    },
  ];

  return (
    <div className="th-page-enter px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
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
 * Identity & access
 * ----------------------------------------------------------------------- */

function IdentitySection({
  config,
}: {
  config: Record<string, string> | null;
}) {
  const user = config?.TORHOLE_ADMIN_USER || "—";
  const reverseDomain = config?.REVERSE_PROXY_DOMAIN || "—";
  const authHost = config?.TORHOLE_HOST_AUTH || "auth";
  const hostIp = config?.HOST_MGMT_IP || "";
  const installRoot = config?.BACKUP_MANAGER_ROOT_DIR || "<torhole>/pi-dns-warden";
  const webMode = config?.TORHOLE_WEB_MODE;
  const httpsEnabled = Boolean(webMode && webMode !== "http");
  return (
    <TabPanel>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <KVRow label="Admin user" value={user} mono />
        <KVRow
          label="Named-host access"
          value={httpsEnabled ? `Authelia SSO · ${authHost}.${reverseDomain}` : "HTTP Basic Auth"}
          mono
        />
      </div>
      <div className="mt-3 text-[10.5px] text-th-text-muted font-mono leading-relaxed">
        Direct-IP recovery always uses a browser password prompt. Authelia SSO is available on
        the named host when HTTPS is enabled.
      </div>
      {!httpsEnabled && (
        <WebAccessUpgrade
          hostIp={hostIp}
          installRoot={installRoot}
        />
      )}
      {httpsEnabled && (
        <WebAccessStatus
          webMode={webMode || "https-local"}
          hostIp={hostIp}
          authHost={authHost}
          reverseDomain={reverseDomain}
        />
      )}
      <div className="mt-6">
        <AdminPasswordForm />
      </div>
    </TabPanel>
  );
}

function WebAccessStatus({
  webMode,
  hostIp,
  authHost,
  reverseDomain,
}: {
  webMode: string;
  hostIp: string;
  authHost: string;
  reverseDomain: string;
}) {
  const generatedCertificate = webMode === "https-local";
  const certificateUrl = hostIp ? `http://${hostIp}/torhole-local-ca.crt` : null;
  const authUrl = reverseDomain !== "—" ? `https://${authHost}.${reverseDomain}/` : null;

  return (
    <div className="mt-4 rounded-md border border-th-primary/35 bg-th-primary/[0.06] p-4">
      <div className="flex items-start gap-2">
        <Shield size={14} className="mt-0.5 shrink-0 text-th-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-th-primary">
            HTTPS + Authelia SSO is active
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-th-text-muted">
            {generatedCertificate
              ? "This installation uses Torhole's generated local certificate authority. Install its certificate once on each device that administers Torhole."
              : "This installation uses the custom certificate supplied during setup."}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {generatedCertificate && certificateUrl && (
              <a
                href={certificateUrl}
                className="inline-flex min-h-[40px] items-center gap-2 rounded border border-th-primary/45 bg-th-primary/10 px-3 text-[10px] font-mono uppercase tracking-[0.12em] text-th-primary hover:bg-th-primary/20"
              >
                <Download size={13} />
                download Torhole CA
              </a>
            )}
            {authUrl && (
              <a
                href={authUrl}
                className="inline-flex min-h-[40px] items-center gap-2 rounded border border-th-line px-3 text-[10px] font-mono uppercase tracking-[0.12em] text-th-text hover:border-th-primary/40 hover:text-th-primary"
              >
                <ExternalLink size={13} />
                open Authelia login
              </a>
            )}
          </div>
          {generatedCertificate && certificateUrl && (
            <div className="mt-3 break-all font-mono text-[10px] text-th-text-muted">
              Certificate: {certificateUrl}
            </div>
          )}
          {!generatedCertificate && <GeneratedCertificateSwitch />}
          <CustomCertificateUpload replacing={webMode === "https-custom"} />
        </div>
      </div>
    </div>
  );
}

function GeneratedCertificateSwitch() {
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<WebAccessState>({ kind: "idle" });

  const apply = async () => {
    setModalOpen(false);
    setState({ kind: "running" });
    try {
      const result = await enableLocalHttps();
      setState({
        kind: "success",
        message: result.message,
        recoveryUrl: result.recovery_url,
        certificateUrl: result.certificate_url,
        httpsUrl: result.https_url,
      });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  };

  return (
    <div className="mt-4 border-t border-th-line/70 pt-4">
      <button
        type="button"
        disabled={state.kind === "running"}
        onClick={() => setModalOpen(true)}
        className="inline-flex min-h-[38px] items-center gap-2 rounded border border-th-line px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-th-text hover:border-th-primary/40 hover:text-th-primary disabled:cursor-wait disabled:opacity-50"
      >
        <Shield size={13} />
        {state.kind === "running" ? "validating generated HTTPS…" : "use generated Torhole certificate"}
      </button>
      {state.kind === "success" && (
        <div className="mt-3 text-[10.5px] text-th-primary">
          {state.message} Reload this page when the proxy restart completes.
        </div>
      )}
      {state.kind === "error" && (
        <div className="mt-3 rounded border border-th-danger/35 bg-th-danger/10 px-3 py-2 font-mono text-[10.5px] text-th-danger">
          {state.message}
        </div>
      )}
      <ConfirmModal
        open={modalOpen}
        title="Use generated Torhole certificate"
        confirmWord="ENABLE"
        confirmLabel="Use generated HTTPS"
        body={
          <>
            <p>This replaces the active custom certificate with Torhole's generated local CA certificate.</p>
            <p className="mt-2 text-th-text-muted">You will need to install the downloadable Torhole CA on each administration device. Direct-IP recovery remains available.</p>
          </>
        }
        onCancel={() => setModalOpen(false)}
        onConfirm={() => void apply()}
      />
    </div>
  );
}

function CustomCertificateUpload({ replacing }: { replacing: boolean }) {
  const [certificate, setCertificate] = useState("");
  const [certificateName, setCertificateName] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<WebAccessState>({ kind: "idle" });

  const readFile = async (
    file: File | undefined,
    setValue: (value: string) => void,
    setName: (value: string) => void,
  ) => {
    if (!file) return;
    setValue(await file.text());
    setName(file.name);
    setState({ kind: "idle" });
  };

  const apply = async () => {
    setModalOpen(false);
    setState({ kind: "running" });
    try {
      const result = await applyCustomHttps(certificate, privateKey);
      setState({
        kind: "success",
        message: result.message,
        recoveryUrl: result.recovery_url,
        certificateUrl: result.certificate_url,
        httpsUrl: result.https_url,
      });
      setPrivateKey("");
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  };

  if (state.kind === "success") {
    return (
      <div className="mt-4 rounded border border-th-primary/35 bg-th-bg/40 p-3">
        <div className="flex items-start gap-2 text-[11px] text-th-primary">
          <Check size={13} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Custom certificate accepted</div>
            <div className="mt-1 text-th-text-muted">{state.message}</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 min-h-[36px] rounded border border-th-primary/40 px-3 font-mono text-[10px] uppercase tracking-[0.12em] hover:bg-th-primary/10"
            >
              reload web access status
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-th-line/70 pt-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-h-[38px] items-center gap-2 rounded border border-th-line px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-th-text hover:border-th-primary/40 hover:text-th-primary"
      >
        <Upload size={13} />
        {replacing ? "replace custom certificate" : "use my own certificate"}
        <ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
      </button>

      {expanded && (
        <div className="mt-3 rounded border border-th-line bg-th-bg/35 p-3">
          <div className="mb-3 text-[10.5px] leading-relaxed text-th-text-muted">
            Upload a PEM certificate or full chain and its matching unencrypted private key.
            Torhole validates the format, expiry, and public-key match before changing Caddy.
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="min-h-[72px] cursor-pointer rounded border border-th-line p-3 hover:border-th-primary/40">
              <span className="flex items-center gap-2 text-[11px] font-semibold text-th-text">
                <Upload size={13} /> Certificate / full chain
              </span>
              <span className="mt-2 block break-all font-mono text-[10px] text-th-text-muted">
                {certificateName || "Choose .crt or .pem"}
              </span>
              <input
                className="sr-only"
                type="file"
                accept=".crt,.cer,.pem,application/x-pem-file"
                onChange={(event) =>
                  void readFile(event.target.files?.[0], setCertificate, setCertificateName)
                }
              />
            </label>
            <label className="min-h-[72px] cursor-pointer rounded border border-th-line p-3 hover:border-th-primary/40">
              <span className="flex items-center gap-2 text-[11px] font-semibold text-th-text">
                <Upload size={13} /> Private key
              </span>
              <span className="mt-2 block break-all font-mono text-[10px] text-th-text-muted">
                {privateKeyName || "Choose .key or .pem"}
              </span>
              <input
                className="sr-only"
                type="file"
                accept=".key,.pem,application/x-pem-file"
                onChange={(event) =>
                  void readFile(event.target.files?.[0], setPrivateKey, setPrivateKeyName)
                }
              />
            </label>
          </div>
          <button
            type="button"
            disabled={!certificate || !privateKey || state.kind === "running"}
            onClick={() => setModalOpen(true)}
            className="mt-3 inline-flex min-h-[42px] items-center gap-2 rounded border border-th-primary/50 bg-th-primary/10 px-3 font-mono text-[10.5px] uppercase tracking-[0.13em] text-th-primary hover:bg-th-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Shield size={13} />
            {state.kind === "running" ? "validating certificate…" : "validate and use certificate"}
          </button>
          {state.kind === "error" && (
            <div className="mt-3 rounded border border-th-danger/35 bg-th-danger/10 px-3 py-2 font-mono text-[10.5px] text-th-danger">
              {state.message}
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={modalOpen}
        title={replacing ? "Replace custom certificate" : "Use custom HTTPS certificate"}
        confirmWord="UPLOAD"
        confirmLabel="Validate and apply"
        body={
          <>
            <p>Torhole will validate the certificate, private key, expiry, and complete Caddy configuration before activating it.</p>
            <p className="mt-2 text-th-text-muted">If validation fails, the active certificate and web configuration remain unchanged. Direct-IP recovery remains available.</p>
          </>
        }
        onCancel={() => setModalOpen(false)}
        onConfirm={() => void apply()}
      />
    </div>
  );
}

type WebAccessState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "success";
      message: string;
      recoveryUrl?: string | null;
      certificateUrl?: string | null;
      httpsUrl?: string | null;
    }
  | { kind: "error"; message: string };

function WebAccessUpgrade({
  hostIp,
  installRoot,
}: {
  hostIp: string;
  installRoot: string;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<WebAccessState>({ kind: "idle" });

  const activate = async () => {
    setState({ kind: "running" });
    setModalOpen(false);
    try {
      const result = await enableLocalHttps();
      setState({
        kind: "success",
        message: result.message,
        recoveryUrl: result.recovery_url,
        certificateUrl: result.certificate_url,
        httpsUrl: result.https_url,
      });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  };

  if (state.kind === "success") {
    return (
      <div className="mt-4 rounded-md border border-th-primary/40 bg-th-primary/[0.06] p-4">
        <div className="flex items-start gap-2">
          <Check size={14} className="mt-0.5 shrink-0 text-th-primary" strokeWidth={2.5} />
          <div>
            <div className="text-[12px] font-semibold text-th-primary">HTTPS + Authelia SSO is activating</div>
            <div className="mt-1 text-[11px] leading-relaxed text-th-text-muted">{state.message}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {state.certificateUrl && (
                <a href={state.certificateUrl} className="rounded border border-th-primary/40 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-th-primary hover:bg-th-primary/10">
                  download local CA
                </a>
              )}
              {state.httpsUrl && (
                <a href={state.httpsUrl} className="rounded border border-th-line px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-th-text hover:border-th-primary/40">
                  open HTTPS login
                </a>
              )}
            </div>
            <div className="mt-3 text-[10px] font-mono text-th-text-muted">
              If the proxy is still restarting, wait a few seconds. Recovery remains at {state.recoveryUrl || `http://${hostIp}/`}.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mt-4 rounded-md border border-th-warning/35 bg-th-warning/[0.06] p-4 text-[11px] leading-relaxed">
        <div className="font-semibold text-th-warning">Authelia SSO is currently off</div>
        <div className="mt-1 text-th-text-muted">
          HTTP uses Basic Auth, so every named service may show a browser password prompt.
          Enable generated HTTPS here; do not rerun the setup installer.
        </div>
        <button
          type="button"
          disabled={state.kind === "running"}
          onClick={() => setModalOpen(true)}
          className="mt-3 inline-flex min-h-[42px] items-center gap-2 rounded-md border border-th-primary/50 bg-th-primary/12 px-3 text-[10.5px] font-mono uppercase tracking-[0.13em] text-th-primary transition-colors hover:bg-th-primary/20 disabled:cursor-wait disabled:opacity-50"
        >
          <Shield size={13} />
          {state.kind === "running" ? "validating and applying…" : "enable HTTPS + Authelia SSO"}
        </button>
        <details className="mt-3 text-th-text-muted">
          <summary className="cursor-pointer font-mono text-[10px] text-th-text-muted hover:text-th-text">manual fallback</summary>
          <div className="mt-2">Set <span className="font-mono text-th-text-mono">TORHOLE_WEB_MODE=https-local</span>, then run:</div>
          <div className="mt-2 overflow-x-auto rounded border border-th-line/70 bg-th-bg/70 px-3 py-2 font-mono text-[10.5px] text-th-text-mono">
            cd {installRoot} &amp;&amp; sudo ./deploy.sh --skip-prereqs
          </div>
        </details>
        {state.kind === "error" && (
          <div className="mt-3 rounded border border-th-danger/35 bg-th-danger/10 px-3 py-2 font-mono text-[10.5px] text-th-danger">{state.message}</div>
        )}
      </div>

      <ConfirmModal
        open={modalOpen}
        title="Enable HTTPS and Authelia SSO"
        confirmWord="ENABLE"
        confirmLabel="Enable HTTPS"
        body={
          <>
            <p>This renders and validates generated HTTPS before recreating only Authelia and Caddy. Prometheus is restarted so its HTTPS probe target is current.</p>
            <p className="mt-2 text-th-text-muted">The DNS privacy path is not restarted. Direct-IP recovery remains available at <span className="font-mono">http://{hostIp}/</span>.</p>
          </>
        }
        onCancel={() => setModalOpen(false)}
        onConfirm={() => void activate()}
      />
    </>
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
  const topology = config?.TORHOLE_TOPOLOGY === "vlan" ? "vlan" : "single-lan";

  const allPlanes: Array<{
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
      label: topology === "vlan" ? "Trusted" : "Flat LAN",
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
  const planes = topology === "vlan" ? allPlanes : allPlanes.slice(0, 1);

  return (
    <TabPanel>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
        <KVRow label="Installed topology" value={topology === "vlan" ? "Segmented VLANs" : "Single LAN"} mono />
        <KVRow label="Parent interface" value={parent} mono />
        <KVRow label="Host management IP" value={hostIp} mono />
        <KVRow label="Timezone" value={tz} mono />
      </div>

      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2 mt-1">
        {topology === "vlan" ? "DNS planes · VLANs" : "DNS plane · flat LAN"}
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
              {topology === "vlan" && <TinyKV label="vlan id" value={config?.[plane.idKey]} />}
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
 * Advanced — guarded per-key .env editor, collapsible
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

function AdvancedSection({
  config,
  onConfigChange,
}: {
  config: Record<string, string> | null;
  onConfigChange: (config: Record<string, string>) => void;
}) {
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
          Edit non-secret application parameters one key at a time. Each save is
          written atomically to <span className="font-mono text-th-text-mono">.env</span>{" "}
          with a backup. Saved does not mean applied: host networking, rendered
          authentication, and most container settings require a maintenance deploy.
          Secrets stay masked and use their dedicated editors or direct host access.
        </div>
      </div>

      {expanded && (
        <div className="space-y-4">
          {ADVANCED_CATEGORIES.map(
            (cat) =>
              groups[cat.id] &&
              groups[cat.id].length > 0 && (
                <AdvancedGroup
                  key={cat.id}
                  label={cat.label}
                  entries={groups[cat.id]}
                  onConfigChange={onConfigChange}
                />
              ),
          )}
          {other.length > 0 && (
            <AdvancedGroup
              label="Other"
              entries={other}
              onConfigChange={onConfigChange}
            />
          )}
        </div>
      )}
    </TabPanel>
  );
}

function AdvancedGroup({
  label,
  entries,
  onConfigChange,
}: {
  label: string;
  entries: Array<[string, string]>;
  onConfigChange: (config: Record<string, string>) => void;
}) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-1.5">
        {label}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([k, v]) => (
          <AdvancedConfigRow
            key={k}
            configKey={k}
            value={v}
            onConfigChange={onConfigChange}
          />
        ))}
      </div>
    </div>
  );
}

const SECRET_CONFIG_KEY = /(PASSWORD|SECRET|KEY|TOKEN|PASS)/i;

function AdvancedConfigRow({
  configKey,
  value,
  onConfigChange,
}: {
  configKey: string;
  value: string;
  onConfigChange: (config: Record<string, string>) => void;
}) {
  const secret = SECRET_CONFIG_KEY.test(configKey);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saveState, setSaveState] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const save = async () => {
    setSaveState({ kind: "saving" });
    try {
      const result = await updateConfigValue(configKey, draft);
      if (result.config) onConfigChange(result.config);
      setEditing(false);
      setSaveState({ kind: "idle" });
    } catch (error) {
      setSaveState({ kind: "error", message: (error as Error).message });
    }
  };

  return (
    <div className="py-1 text-[11px] font-mono border-b border-th-line/20 min-w-0">
      <div className="flex items-center gap-2 min-h-[30px]">
        <span
          className="text-th-text-muted/70 truncate w-[200px] shrink-0"
          title={configKey}
        >
          {configKey}
        </span>
        {editing ? (
          <>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={saveState.kind === "saving"}
              aria-label={`Value for ${configKey}`}
              className="min-w-0 flex-1 px-2 py-1.5 rounded border border-th-line bg-th-bg/70 text-th-text-mono outline-none focus:border-th-primary/50"
            />
            <button
              type="button"
              disabled={saveState.kind === "saving" || draft === value}
              onClick={() => void save()}
              className="px-2 min-h-[30px] rounded border border-th-primary/40 text-th-primary disabled:opacity-35"
            >
              {saveState.kind === "saving" ? "saving…" : "save"}
            </button>
            <button
              type="button"
              disabled={saveState.kind === "saving"}
              onClick={() => {
                setDraft(value);
                setEditing(false);
                setSaveState({ kind: "idle" });
              }}
              className="px-2 min-h-[30px] rounded border border-th-line text-th-text-muted"
            >
              cancel
            </button>
          </>
        ) : (
          <>
            <span
              className={`truncate flex-1 ${secret ? "text-th-text-muted/50 italic" : "text-th-text-mono"}`}
              title={secret ? "Secret value masked" : value}
            >
              {secret ? value || "(secret not configured)" : value || "(empty)"}
            </span>
            {!secret && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="px-2 min-h-[30px] rounded border border-th-line text-th-text-muted hover:text-th-primary hover:border-th-primary/40"
              >
                edit
              </button>
            )}
          </>
        )}
      </div>
      {saveState.kind === "error" && (
        <div className="mt-1 text-[10px] text-th-danger">{saveState.message}</div>
      )}
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
