/*
 * Setup wizard — "How do I get from git clone to a working Torhole?"
 *
 * Home and Advanced are capability profiles of one Torhole product. The
 * wizard persists the selected edition plus low-risk identity/timezone
 * fields through the backend's atomic .env writer. Deployment remains a
 * separate, explicit host action until the bootstrap helper has narrower
 * privileges and a transactional rollback path.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Lock,
  Network,
  Play,
  Save,
  Shield,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import {
  applySetupConfig,
  finishBootstrap,
  fetchBootstrapStatus,
  fetchConfig,
  formatRelative,
  startBootstrapInstall,
  useSnapshot,
  type BootstrapInstallStatus,
  type SetupApplyResult,
  type SnapshotState,
} from "../lib/snapshot";

type StepId =
  | "welcome"
  | "edition"
  | "topology"
  | "network"
  | "admin"
  | "blocklists"
  | "tor"
  | "alerts"
  | "test"
  | "done";

const ADVANCED_STEP_ORDER: StepId[] = [
  "welcome",
  "edition",
  "topology",
  "network",
  "admin",
  "blocklists",
  "tor",
  "alerts",
  "test",
  "done",
];

const HOME_STEP_ORDER: StepId[] = [
  "welcome",
  "edition",
  "network",
  "blocklists",
  "tor",
  "test",
  "done",
];

const STEP_TITLES: Record<StepId, string> = {
  welcome: "Welcome",
  edition: "Edition",
  topology: "Topology",
  network: "Network",
  admin: "Admin account",
  blocklists: "Blocklists",
  tor: "Tor",
  alerts: "Alerts",
  test: "Test",
  done: "Done",
};

const STEP_ICONS: Record<StepId, React.ComponentType<{ size?: number; className?: string }>> = {
  welcome: Shield,
  edition: ShieldCheck,
  topology: Network,
  network: Globe,
  admin: Lock,
  blocklists: Zap,
  tor: ShieldCheck,
  alerts: Terminal,
  test: Play,
  done: Check,
};

type Topology = "single-lan" | "vlan";
type Edition = "home" | "advanced";

export default function SetupScreen({ bootstrap = false }: { bootstrap?: boolean }) {
  const { state } = useSnapshot();
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  const [step, setStep] = useState<StepId>("welcome");
  const [edition, setEdition] = useState<Edition>("home");
  const [topology, setTopology] = useState<Topology>("single-lan");

  // Phase A.3 — editable wizard state. Kept at the top level so every
  // step can read/write and the Done step can diff against the loaded
  // .env to build a per-key change list for the Apply button.
  const [adminUser, setAdminUser] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");

  useEffect(() => {
    fetchConfig()
      .then((d) => {
        setConfig(d.config);
        // Seed the editable fields from the current .env so the wizard
        // starts from the live values rather than empty strings.
        setAdminUser(d.config.TORHOLE_ADMIN_USER || "");
        setTimezone(d.config.TZ || "");
        // Auto-detect: if both VLAN IDs are set and not trivially "1",
        // assume the existing install is VLAN mode.
        const ids = [d.config.TRUSTED_VLAN_ID, d.config.IOT_VLAN_ID];
        const vlanish = ids.filter((v) => v && v !== "1").length >= 2;
        if (vlanish) setTopology("vlan");

        // Explicit edition wins. Older installs pre-date TORHOLE_EDITION,
        // so a real VLAN footprint keeps them on Advanced automatically.
        // A fresh or single-LAN configuration follows the Home default.
        const configuredEdition = d.config.TORHOLE_EDITION;
        if (configuredEdition === "home" || configuredEdition === "advanced") {
          setEdition(configuredEdition);
        } else if (vlanish) {
          setEdition("advanced");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (edition === "home" && (step === "topology" || step === "alerts")) {
      setStep("edition");
    }
  }, [edition, step]);

  const stepOrder = edition === "advanced" ? ADVANCED_STEP_ORDER : HOME_STEP_ORDER;
  const idx = stepOrder.indexOf(step);
  const total = stepOrder.length;

  const chooseEdition = (nextEdition: Edition) => {
    setEdition(nextEdition);
    if (nextEdition === "home") setTopology("single-lan");
  };

  const goNext = () => {
    if (idx < total - 1) setStep(stepOrder[idx + 1]);
  };
  const goBack = () => {
    if (idx > 0) setStep(stepOrder[idx - 1]);
  };
  const jumpTo = (s: StepId) => setStep(s);

  return (
    <div className="px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
      <Header state={state} />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
        <Stepper step={step} stepOrder={stepOrder} onJump={jumpTo} />

        <div className="bg-th-panel border border-th-line rounded-lg overflow-hidden">
          <div className="px-7 py-7 min-h-[420px]">
            {step === "welcome" && <WelcomeStep />}
            {step === "edition" && (
              <EditionStep edition={edition} setEdition={chooseEdition} />
            )}
            {step === "topology" && (
              <TopologyStep topology={topology} setTopology={setTopology} />
            )}
            {step === "network" && (
              <NetworkStep
                config={config}
                topology={topology}
                timezone={timezone}
                setTimezone={setTimezone}
              />
            )}
            {step === "admin" && (
              <AdminStep
                config={config}
                adminUser={adminUser}
                setAdminUser={setAdminUser}
              />
            )}
            {step === "blocklists" && <BlocklistsStep edition={edition} />}
            {step === "tor" && <TorStep config={config} />}
            {step === "alerts" && <AlertsStep config={config} />}
            {step === "test" && <TestStep bootstrap={bootstrap} />}
            {step === "done" && (
              bootstrap ? (
                <BootstrapDoneStep
                  edition={edition}
                  topology={topology}
                  adminUser={adminUser}
                  timezone={timezone}
                />
              ) : (
                <DoneStep
                  edition={edition}
                  topology={topology}
                  config={config}
                  adminUser={adminUser}
                  timezone={timezone}
                />
              )
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4 border-t border-th-line/60 bg-th-bg/40">
            <button
              type="button"
              onClick={goBack}
              disabled={idx === 0}
              className="flex items-center gap-1.5 px-3 rounded-md text-[11px] font-mono uppercase tracking-[0.14em] min-h-[44px] text-th-text-muted hover:text-th-text hover:bg-th-line/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowLeft size={13} />
              back
            </button>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-th-text-muted/60">
              step {idx + 1} of {total}
            </div>
            <button
              type="button"
              onClick={goNext}
              disabled={idx === total - 1}
              className="flex items-center gap-1.5 px-4 rounded-md text-[11px] font-mono uppercase tracking-[0.14em] min-h-[44px] bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              next
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
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
          Setup
        </div>
        <h1 className="text-[28px] font-bold tracking-tight mt-1 leading-none">
          How do you want to run Torhole?
        </h1>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-th-text-muted">
        <span className="font-mono uppercase tracking-[0.14em]">live · {fetched}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Stepper rail
 * ----------------------------------------------------------------------- */

function Stepper({
  step,
  stepOrder,
  onJump,
}: {
  step: StepId;
  stepOrder: StepId[];
  onJump: (s: StepId) => void;
}) {
  const currentIdx = stepOrder.indexOf(step);
  return (
    <nav className="bg-th-panel border border-th-line rounded-lg p-3 h-fit sticky top-5">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono px-2 mb-2">
        first-run flow
      </div>
      <div className="space-y-0.5">
        {stepOrder.map((s, i) => {
          const Icon = STEP_ICONS[s];
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onJump(s)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[12px] transition-colors min-h-[40px] ${
                active
                  ? "bg-th-line/60 text-th-text border-l-2 border-l-th-primary -ml-0.5 pl-[10px]"
                  : done
                  ? "text-th-primary/80 hover:text-th-text hover:bg-th-line/30"
                  : "text-th-text-muted hover:text-th-text hover:bg-th-line/30"
              }`}
            >
              {done ? (
                <CircleCheck size={14} className="text-th-primary shrink-0" strokeWidth={2} />
              ) : active ? (
                <Icon size={14} className="text-th-primary shrink-0" />
              ) : (
                <Circle size={14} className="text-th-text-muted/40 shrink-0" />
              )}
              <span className="flex-1 text-left">{STEP_TITLES[s]}</span>
              <span className="text-[9px] font-mono text-th-text-muted/40">
                {String(i + 1).padStart(2, "0")}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ----------------------------------------------------------------------- *
 * Step primitives
 * ----------------------------------------------------------------------- */

function StepHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="mb-6">
      <div className="text-[10px] uppercase tracking-[0.22em] text-th-text-muted font-mono">
        {eyebrow}
      </div>
      <h2 className="text-[24px] font-bold tracking-tight mt-1 leading-tight">{title}</h2>
      <p className="text-[13px] text-th-text-muted mt-2 max-w-[680px] leading-relaxed">
        {body}
      </p>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5 bg-th-bg/40 border border-th-line/60 rounded">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
        {label}
      </div>
      <div className="break-all text-[12.5px] font-mono text-th-text-mono">
        {value || "—"}
      </div>
    </div>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function SecretKV({ label, value }: { label: string; value: string | undefined }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const secret = value || "";
  const copy = async () => {
    if (!secret) return;
    await copyText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5 bg-th-bg/40 border border-th-line/60 rounded">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
        {label}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <div className="text-[12.5px] font-mono text-th-text-mono flex-1 truncate">
          {secret ? (visible ? secret : "••••••••••••") : "—"}
        </div>
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          disabled={!secret}
          aria-label={`${visible ? "Hide" : "Show"} ${label}`}
          className="p-1.5 text-th-text-muted hover:text-th-primary disabled:opacity-30"
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!secret}
          aria-label={`Copy ${label}`}
          className="p-1.5 text-th-text-muted hover:text-th-primary disabled:opacity-30"
        >
          {copied ? <Check size={14} className="text-th-primary" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/** Same chrome as KV but the value is a text input. Used by the Phase A.3
 *  wizard fields that feed into /api/setup/apply. */
function EditableKV({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2 bg-th-bg/40 border border-th-line/60 rounded focus-within:border-th-primary/40 transition-colors">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="bg-transparent outline-none text-[12.5px] font-mono text-th-text-mono placeholder:text-th-text-muted/30 w-full"
      />
    </div>
  );
}

function Note({ children, kind = "info" }: { children: React.ReactNode; kind?: "info" | "warn" }) {
  return (
    <div
      className={`flex items-start gap-2 p-3 rounded text-[11.5px] ${
        kind === "warn"
          ? "bg-th-warning/[0.06] border border-th-warning/30 text-th-warning"
          : "bg-th-bg/40 border border-th-line/60 text-th-text-muted"
      }`}
    >
      {kind === "warn" ? (
        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      ) : (
        <Shield size={13} className="shrink-0 mt-0.5 text-th-text-muted/70" />
      )}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Steps
 * ----------------------------------------------------------------------- */

function WelcomeStep() {
  return (
    <div>
      <StepHeader
        eyebrow="Welcome"
        title="Set up a privacy-first DNS gateway in about 5 minutes"
        body="Torhole runs Pi-hole behind an encrypted DNS resolver, which in turn routes upstream DNS through Tor. This wizard walks through the pieces you need to configure once."
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FeatureTile
          icon={ShieldCheck}
          title="Choose an edition"
          body="Home keeps the setup small. Advanced unlocks VLANs, SSO, observability, alerts, and operations."
        />
        <FeatureTile
          icon={Lock}
          title="Keep control local"
          body="Home uses a generated local control PIN. Advanced adds an administrator account and Authelia SSO."
        />
        <FeatureTile
          icon={ShieldCheck}
          title="Verify everything"
          body="Run DNS, Tor egress, and bypass checks at the end before you depend on the service."
        />
      </div>
      <Note>
        Home and Advanced use the <strong className="text-th-text">same Torhole UI</strong> and
        privacy core. The edition only controls which capabilities are enabled. At the end,
        Torhole shows an exact diff before safely writing the low-risk settings to{" "}
        <span className="font-mono text-th-text-mono">.env</span>.
      </Note>
    </div>
  );
}

function FeatureTile({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-th-bg/40 border border-th-line/60 rounded-md p-4">
      <div className="w-8 h-8 rounded-md bg-th-primary/10 border border-th-primary/20 flex items-center justify-center text-th-primary mb-3">
        <Icon size={15} />
      </div>
      <div className="text-[13px] font-semibold text-th-text">{title}</div>
      <div className="text-[11.5px] text-th-text-muted mt-1 leading-relaxed">{body}</div>
    </div>
  );
}

function EditionStep({
  edition,
  setEdition,
}: {
  edition: Edition;
  setEdition: (edition: Edition) => void;
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Edition"
        title="Start simple, add operations when you need them"
        body="This is one product and one configuration path. Home is the safe default for ordinary networks; Advanced adds infrastructure features without changing the privacy core."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <EditionCard
          title="Torhole Home"
          badge="default"
          selected={edition === "home"}
          onSelect={() => setEdition("home")}
          body="For a home router and one LAN. Torhole manages one private DNS path with the minimum number of moving parts."
          capabilities={[
            "One LAN and one Pi-hole",
            "Encrypted DNS routed through Tor",
            "Privacy proof and Tor circuit visibility",
            "Safe start, stop, restart, and identity controls",
          ]}
        />
        <EditionCard
          title="Torhole Advanced"
          badge="optional"
          selected={edition === "advanced"}
          onSelect={() => setEdition("advanced")}
          body="For homelabs and managed networks. Adds segmentation, identity, observability, alerting, and operational tooling."
          capabilities={[
            "Trusted and IoT VLAN DNS planes",
            "Authelia SSO and reverse proxy",
            "Prometheus, Grafana, and Loki",
            "Alertmanager, backups, and service operations",
          ]}
        />
      </div>
      <Note>
        Choose Advanced only if you already understand why you need VLANs or the operational
        stack. More services mean more configuration, updates, storage, and failure modes.
      </Note>
    </div>
  );
}

function EditionCard({
  title,
  badge,
  selected,
  onSelect,
  body,
  capabilities,
}: {
  title: string;
  badge: string;
  selected: boolean;
  onSelect: () => void;
  body: string;
  capabilities: string[];
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left p-5 rounded-md border transition-colors ${
        selected
          ? "bg-th-primary/[0.05] border-th-primary/50 ring-1 ring-th-primary/30"
          : "bg-th-bg/40 border-th-line hover:border-th-primary/30"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[15px] font-semibold text-th-text">{title}</div>
          <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-primary/70 font-mono mt-1">
            {badge}
          </div>
        </div>
        <div
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
            selected ? "bg-th-primary border-th-primary" : "border-th-text-muted/40"
          }`}
        >
          {selected && <Check size={11} strokeWidth={3} className="text-th-bg" />}
        </div>
      </div>
      <div className="text-[11.5px] text-th-text-muted leading-relaxed mb-3">{body}</div>
      <div className="space-y-1.5">
        {capabilities.map((capability) => (
          <div key={capability} className="flex items-start gap-2 text-[10.5px] text-th-text-mono">
            <Check size={11} className="text-th-primary shrink-0 mt-0.5" />
            <span>{capability}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

function TopologyStep({
  topology,
  setTopology,
}: {
  topology: Topology;
  setTopology: (t: Topology) => void;
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Topology"
        title="Single-LAN or segmented VLANs?"
        body="Pick the network layout that matches your home setup. You can switch later by re-running the wizard."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TopologyCard
          id="single-lan"
          title="Single LAN"
          badge="recommended"
          selected={topology === "single-lan"}
          onSelect={() => setTopology("single-lan")}
          body="One network, one Pi-hole, one DNS path. Works on any home router. No VLAN configuration required."
          diagram={[
            "clients ─┐",
            "         │",
            "         ▼",
            "   [pi-hole] ─▶ [dnscrypt] ─▶ [tor:9050] ─▶ exit",
          ]}
        />
        <TopologyCard
          id="vlan"
          title="Segmented VLANs"
          badge="advanced"
          selected={topology === "vlan"}
          onSelect={() => setTopology("vlan")}
          body="Two isolated DNS planes for trusted / IoT networks. Requires a managed switch and VLAN-aware router."
          diagram={[
            "trusted ─▶ [pihole_trusted] ─▶ [dnscrypt_t]    all ─▶ tor:9050 ─▶ exit",
            "iot     ─▶ [pihole_iot]      ─▶ [dnscrypt_i]",
          ]}
        />
      </div>
    </div>
  );
}

function TopologyCard({
  id,
  title,
  badge,
  selected,
  onSelect,
  body,
  diagram,
}: {
  id: Topology;
  title: string;
  badge: string;
  selected: boolean;
  onSelect: () => void;
  body: string;
  diagram: string[];
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left p-5 rounded-md border transition-colors ${
        selected
          ? "bg-th-primary/[0.05] border-th-primary/50 ring-1 ring-th-primary/30"
          : "bg-th-bg/40 border-th-line hover:border-th-primary/30"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[15px] font-semibold text-th-text">{title}</div>
          <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-primary/70 font-mono mt-1">
            {badge}
          </div>
        </div>
        <div
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
            selected ? "bg-th-primary border-th-primary" : "border-th-text-muted/40"
          }`}
        >
          {selected && <Check size={11} strokeWidth={3} className="text-th-bg" />}
        </div>
      </div>
      <div className="text-[11.5px] text-th-text-muted leading-relaxed mb-3">{body}</div>
      <pre className="text-[10px] font-mono text-th-text-mono/80 bg-th-bg/60 border border-th-line/40 rounded p-2.5 overflow-x-auto leading-relaxed">
        {diagram.map((line) => `${line}\n`).join("")}
      </pre>
      <div className="sr-only">{id}</div>
    </button>
  );
}

function NetworkStep({
  config,
  topology,
  timezone,
  setTimezone,
}: {
  config: Record<string, string> | null;
  topology: Topology;
  timezone: string;
  setTimezone: (v: string) => void;
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Network"
        title="What does your network look like?"
        body={
          topology === "single-lan"
            ? "Torhole auto-detects most of this from the host. For single-LAN, you mainly need a static IP for the Pi-hole and the gateway address."
            : "For segmented VLANs, Torhole needs the parent interface name (usually eth0) and per-VLAN tags, subnets, and gateways."
        }
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <KV label="Host management IP" value={config?.HOST_MGMT_IP} />
        <KV label="Parent interface" value={config?.PARENT_IF} />
        <EditableKV
          label="Timezone"
          value={timezone}
          onChange={setTimezone}
          placeholder="Europe/London"
        />
        <KV label="Reverse proxy domain" value={config?.REVERSE_PROXY_DOMAIN} />
      </div>

      {topology === "vlan" && (
        <>
          <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2">
            per-plane
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              { id: "trusted", label: "Trusted", id_key: "TRUSTED_VLAN_ID", ip_key: "PIHOLE_TRUSTED_IP", cidr: "TRUSTED_SUBNET_CIDR" },
              { id: "iot", label: "IoT", id_key: "IOT_VLAN_ID", ip_key: "PIHOLE_IOT_IP", cidr: "IOT_SUBNET_CIDR" },
            ].map((plane) => (
              <div
                key={plane.id}
                className="bg-th-bg/40 border border-th-line/60 rounded-md p-3"
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono mb-2">
                  {plane.label}
                </div>
                <div className="space-y-1.5 text-[10.5px] font-mono">
                  <div>vlan {config?.[plane.id_key] || "—"}</div>
                  <div className="text-th-text-muted">{config?.[plane.cidr] || "—"}</div>
                  <div className="text-th-text-mono">{config?.[plane.ip_key] || "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Note>
        These values come from the running <span className="font-mono text-th-text-mono">.env</span>{" "}
        file. If you see dashes, they're not set yet — fill them in on the host and re-run{" "}
        <span className="font-mono text-th-text-mono">deploy.sh</span>.
      </Note>
    </div>
  );
}

function AdminStep({
  config,
  adminUser,
  setAdminUser,
}: {
  config: Record<string, string> | null;
  adminUser: string;
  setAdminUser: (v: string) => void;
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Admin account"
        title="Who administers the stack?"
        body="One admin user, used by this UI and Authelia SSO. The password hash is written to the Authelia users database by 18-render-auth.sh."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <EditableKV
          label="Admin user"
          value={adminUser}
          onChange={setAdminUser}
          placeholder="admin"
        />
        <KV
          label="Admin password"
          value={config?.TORHOLE_ADMIN_PASSWORD === "***" ? "(set — masked)" : "(not set)"}
        />
      </div>
      <Note>
        Only the <strong className="text-th-text">admin user</strong> can be changed
        from this wizard — the password has its own flow in{" "}
        <span className="font-mono text-th-text-mono">Configure › Identity</span> because
        changing it restarts Authelia immediately. Apply the user change on the Done
        step, then <span className="font-mono text-th-text-mono">sudo ./deploy.sh</span>{" "}
        on the host so the new user lands in the Authelia database.
      </Note>
    </div>
  );
}

function BlocklistsStep({ edition }: { edition: Edition }) {
  const curated = [
    {
      name: "StevenBlack hosts",
      url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
      desc: "The default. Merges unified adblock, malware, and phishing lists.",
    },
    {
      name: "OISD Basic",
      url: "https://big.oisd.nl",
      desc: "Community-curated; balanced blocking with a low false-positive rate.",
    },
    {
      name: "AdGuard DNS filter",
      url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
      desc: "AdGuard's own filter. Good for ad-heavy blocking.",
    },
  ];
  return (
    <div>
      <StepHeader
        eyebrow="Blocklists"
        title="What do you want Pi-hole to block?"
        body="Torhole ships with a default gravity list, but you can add more curated sources. Blocklists are loaded on first run and refreshed on a schedule."
      />
      <div className="space-y-2">
        {curated.map((list) => (
          <div
            key={list.url}
            className="flex items-start gap-3 p-3 bg-th-bg/40 border border-th-line/60 rounded"
          >
            <div className="w-7 h-7 rounded bg-th-primary/10 border border-th-primary/20 flex items-center justify-center shrink-0">
              <Zap size={13} className="text-th-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-th-text">{list.name}</div>
              <div className="text-[10.5px] font-mono text-th-text-mono/70 truncate">
                {list.url}
              </div>
              <div className="text-[11px] text-th-text-muted mt-1">{list.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <Note>
        Pi-hole manages the gravity list via its admin UI. For now, add these URLs in
        Pi-hole {edition === "advanced" ? "behind Authelia " : ""}and run{" "}
        <span className="font-mono text-th-text-mono">pihole -g</span>.
      </Note>
    </div>
  );
}

function TorStep({ config }: { config: Record<string, string> | null }) {
  return (
    <div>
      <StepHeader
        eyebrow="Tor"
        title="How should Tor behave?"
        body="The default config exits via any Tor relay and rotates identities per-plane via IsolateSOCKSAuth. Advanced operators can pin an exit country or wire up bridges by editing tor/torrc."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <KV label="SOCKS port" value="9050 (internal only)" />
        <KV label="Control port" value="9051 (authenticated)" />
        <KV label="Isolation" value="IsolateSOCKSAuth (per-plane)" />
        <KV
          label="Control password"
          value={config?.TOR_CONTROL_PASSWORD === "***" ? "(set — masked)" : "(not set)"}
        />
      </div>
      <Note>
        The leak test on the <strong className="text-th-text">Test</strong> step will verify
        that traffic through tor:9050 actually reaches the internet via a Tor exit relay. If
        it fails, recheck the torrc and make sure the tor container is healthy.
      </Note>
    </div>
  );
}

function AlertsStep({ config }: { config: Record<string, string> | null }) {
  const telegram = !!(config?.ALERT_TELEGRAM_BOT_TOKEN && config?.ALERT_TELEGRAM_CHAT_ID);
  const email = !!(
    config?.ALERT_EMAIL_TO &&
    config?.ALERT_EMAIL_FROM &&
    config?.ALERT_EMAIL_SMARTHOST
  );
  const discord = !!config?.ALERT_DISCORD_WEBHOOK_URL;
  return (
    <div>
      <StepHeader
        eyebrow="Alerts"
        title="Where should alerts go?"
        body="Alertmanager routes notifications to Telegram, email, or Discord based on what's configured in .env. You can enable/disable individual channels later from the Configure screen."
      />
      <div className="space-y-2">
        <ChannelStatus label="Telegram" configured={telegram} />
        <ChannelStatus label="Email (SMTP)" configured={email} />
        <ChannelStatus label="Discord webhook" configured={discord} />
      </div>
      <Note>
        Alerts are optional — Torhole works without any notification channel configured. But
        a silent stack is a surprising stack when something breaks at 3am.
      </Note>
    </div>
  );
}

function ChannelStatus({ label, configured }: { label: string; configured: boolean }) {
  return (
    <div className="flex items-center gap-3 p-3 bg-th-bg/40 border border-th-line/60 rounded">
      <div
        className={`w-2 h-2 rounded-full ${
          configured ? "bg-th-primary" : "bg-th-text-muted/40"
        }`}
      />
      <div className="text-[12.5px] text-th-text flex-1">{label}</div>
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-th-text-muted">
        {configured ? "configured" : "not set"}
      </div>
    </div>
  );
}

function TestStep({ bootstrap }: { bootstrap: boolean }) {
  return (
    <div>
      <StepHeader
        eyebrow="Test"
        title={bootstrap ? "What the installer will verify" : "Verify the privacy path"}
        body={
          bootstrap
            ? "Installation happens on the next step. Torhole will report success only after these three independent checks pass."
            : "Use the Privacy screen to test the running Tor path and inspect its current exit relay."
        }
      />
      {bootstrap ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <FeatureTile
            icon={Globe}
            title="DNS resolution"
            body="Resolve example.com through Pi-hole and dnscrypt-proxy—not through the host resolver."
          />
          <FeatureTile
            icon={ShieldCheck}
            title="Tor egress"
            body="Open a SOCKS5 connection through Tor and require the Tor Project to return IsTor=true."
          />
          <FeatureTile
            icon={Lock}
            title="No DNS bypass"
            body="Confirm dnscrypt-proxy is attached only to an internal network and cannot reach the internet directly."
          />
        </div>
      ) : (
        <div className="bg-th-primary/[0.04] border border-th-primary/30 rounded-md p-5 flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-th-primary/15 text-th-primary flex items-center justify-center shrink-0">
            <ShieldCheck size={18} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-th-text">Run the live Tor egress test</div>
            <div className="text-[11.5px] text-th-text-muted mt-1 leading-relaxed">
              The Privacy screen opens a real SOCKS5 connection through Tor and asks the Tor
              Project whether it sees a Tor exit IP.
            </div>
            <a
              href="#/privacy"
              className="inline-flex items-center gap-1.5 mt-3 px-3 py-2 rounded-md text-[11px] font-mono uppercase tracking-[0.14em] bg-th-bg/60 border border-th-line text-th-text hover:border-th-primary/40 hover:bg-th-primary/[0.06] transition-colors min-h-[44px]"
            >
              <ShieldCheck size={12} />
              open privacy screen
            </a>
          </div>
        </div>
      )}
      <Note kind="warn">
        These checks cover <strong>DNS handled by Torhole</strong>. They do not turn the device
        into a VPN and do not hide web traffic, app traffic, or DNS that a client sends to a
        different resolver.
      </Note>
    </div>
  );
}

function BootstrapDoneStep({
  edition,
  topology,
  adminUser,
  timezone,
}: {
  edition: Edition;
  topology: Topology;
  adminUser: string;
  timezone: string;
}) {
  const [install, setInstall] = useState<BootstrapInstallStatus>({
    status: "idle",
    message: "Ready to install.",
    logs: [],
  });
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [copiedReceipt, setCopiedReceipt] = useState(false);

  useEffect(() => {
    if (install.status !== "running") return;
    const refresh = async () => {
      try {
        setInstall(await fetchBootstrapStatus());
      } catch (error) {
        setInstall((current) => ({
          ...current,
          status: "error",
          message: (error as Error).message,
        }));
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [install.status]);

  const begin = async () => {
    setStarting(true);
    try {
      setInstall(await startBootstrapInstall(edition, adminUser || "admin", timezone || "UTC"));
    } catch (error) {
      setInstall({ status: "error", message: (error as Error).message, logs: [] });
    } finally {
      setStarting(false);
    }
  };

  const advancedBlocked = edition === "advanced";
  const copyReceipt = async () => {
    if (!install.home_url) return;
    const dnsServer = new URL(install.home_url).hostname;
    await copyText(
      [
        `Torhole Home: ${install.home_url}`,
        `Pi-hole settings: ${install.pihole_url || ""}`,
        `Pi-hole admin password: ${install.pihole_password || ""}`,
        `Control PIN: ${install.control_pin || ""}`,
        `DNS server: ${dnsServer}`,
      ].join("\n"),
    );
    setCopiedReceipt(true);
    window.setTimeout(() => setCopiedReceipt(false), 1_500);
  };
  const finish = async () => {
    if (!install.home_url) return;
    setFinishing(true);
    try {
      await finishBootstrap();
      window.location.assign(install.home_url);
    } catch (error) {
      setInstall((current) => ({
        ...current,
        status: "error",
        message: (error as Error).message,
      }));
      setFinishing(false);
    }
  };
  return (
    <div>
      <StepHeader
        eyebrow="Install"
        title={install.status === "success" ? "Torhole Home is ready" : "Review and install"}
        body={
          install.status === "success"
            ? "The privacy stack passed all three installer checks. Open Torhole, then point your router's DNS setting at this host."
            : "The installer will generate local secrets, build the selected profile, start it, and verify DNS resolution, Tor egress, and bypass protection before reporting success."
        }
      />

      {install.status === "success" ? (
        <div className="space-y-4">
          <div className="p-5 rounded-md border border-th-primary/40 bg-th-primary/[0.06]">
            <div className="flex items-center gap-2 text-th-primary font-semibold">
              <CircleCheck size={16} /> Privacy path verified
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              <KV label="DNS query" value={install.verification?.dns.answer ? `PASS · ${install.verification.dns.answer}` : "PASS"} />
              <KV label="Tor egress" value={install.verification?.tor.exit_ip ? `PASS · ${install.verification.tor.exit_ip}` : "PASS"} />
              <KV label="Bypass protection" value="PASS · internal-only" />
            </div>
          </div>
          <div className="p-5 rounded-md border border-th-line bg-th-bg/30">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-semibold text-th-text">Save your access details</div>
                <div className="text-[11px] text-th-text-muted mt-1">
                  The Pi-hole password is masked below. Reveal it or copy it before closing setup.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void copyReceipt()}
                className="inline-flex min-h-[40px] px-3 items-center gap-2 rounded-md border border-th-line text-th-text-muted hover:text-th-primary hover:border-th-primary/40 text-[10px] uppercase tracking-[0.14em] font-mono"
              >
                {copiedReceipt ? <Check size={13} /> : <Copy size={13} />}
                {copiedReceipt ? "copied" : "copy all"}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
              <KV label="Torhole Home" value={install.home_url} />
              <KV label="Pi-hole settings" value={install.pihole_url} />
              <SecretKV label="Pi-hole admin password" value={install.pihole_password} />
              <SecretKV label="Control PIN" value={install.control_pin} />
              <KV label="DNS server" value={new URL(install.home_url || window.location.href).hostname} />
            </div>
            <div className="mt-3 text-[10.5px] text-th-text-muted">
              Missed them? On the Torhole host, run{" "}
              <span className="font-mono text-th-text-mono">./install.sh credentials</span>{" "}
              from the cloned repository.
            </div>
          </div>
          {install.home_url && (
            <button
              type="button"
              disabled={finishing}
              onClick={() => void finish()}
              className="inline-flex min-h-[46px] px-5 items-center gap-2 rounded-md bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 text-[11px] uppercase tracking-[0.14em] font-mono"
            >
              <ShieldCheck size={13} />
              {finishing ? "closing installer…" : "finish and open Torhole Home"}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <KV label="Edition" value={edition === "home" ? "Torhole Home" : "Torhole Advanced"} />
            <KV label="Topology" value={topology} />
            <KV label="Timezone" value={timezone || "UTC"} />
            {edition === "advanced" && <KV label="Admin user" value={adminUser || "admin"} />}
          </div>

          {advancedBlocked && (
            <Note kind="warn">
              Advanced activation is not enabled in this checkpoint. The wizard must capture
              and validate VLAN interfaces, CIDRs, gateways, static Pi-hole addresses, SSO,
              and alerting values before it can safely run the existing Advanced deployer.
              Choose Home for the clean-install rehearsal.
            </Note>
          )}

          {install.status === "error" && (
            <div className="p-3 rounded border border-th-danger/35 bg-th-danger/[0.06] text-[11px] text-th-danger font-mono">
              {install.message}
            </div>
          )}

          {(install.status === "running" || install.logs.length > 0) && (
            <div className="rounded-md border border-th-line bg-th-bg/60 overflow-hidden">
              <div className="px-3 py-2 border-b border-th-line text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted font-mono flex items-center justify-between">
                <span>installer progress</span>
                <span>{install.status}</span>
              </div>
              <pre className="p-3 max-h-52 overflow-auto text-[10px] leading-relaxed text-th-text-mono font-mono whitespace-pre-wrap">
                {install.logs.slice(-30).join("\n") || install.message}
              </pre>
            </div>
          )}

          <button
            type="button"
            disabled={advancedBlocked || starting || install.status === "running"}
            onClick={() => void begin()}
            className="min-h-[46px] px-5 rounded-md bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 disabled:opacity-35 disabled:cursor-not-allowed flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-mono"
          >
            <Play size={13} />
            {starting || install.status === "running" ? "installing…" : `install Torhole ${edition}`}
          </button>
          <div className="text-[10.5px] text-th-text-muted font-mono">
            Existing Torhole data is never deleted by this action. A failed attempt keeps its
            generated configuration so it can be inspected and retried.
          </div>
        </div>
      )}
    </div>
  );
}

type ApplyState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; result: SetupApplyResult }
  | { kind: "error"; message: string };

function DoneStep({
  edition,
  topology,
  config,
  adminUser,
  timezone,
}: {
  edition: Edition;
  topology: Topology;
  config: Record<string, string> | null;
  adminUser: string;
  timezone: string;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [state, setState] = useState<ApplyState>({ kind: "idle" });

  // Diff the captured wizard state against live .env so the operator
  // sees exactly which keys change BEFORE confirming. Empty diff
  // disables Apply.
  const pendingChanges: Array<{ key: string; label: string; old: string; next: string }> = [];
  if (config) {
    const currentEdition = config.TORHOLE_EDITION || "";
    if (edition !== currentEdition) {
      pendingChanges.push({
        key: "TORHOLE_EDITION",
        label: "Edition",
        old: currentEdition,
        next: edition,
      });
    }
    const currentAdmin = config.TORHOLE_ADMIN_USER || "";
    if (adminUser.trim() && adminUser.trim() !== currentAdmin) {
      pendingChanges.push({
        key: "TORHOLE_ADMIN_USER",
        label: "Admin user",
        old: currentAdmin,
        next: adminUser.trim(),
      });
    }
    const currentTz = config.TZ || "";
    if (timezone.trim() && timezone.trim() !== currentTz) {
      pendingChanges.push({
        key: "TZ",
        label: "Timezone",
        old: currentTz,
        next: timezone.trim(),
      });
    }
  }

  const apply = async () => {
    setState({ kind: "running" });
    try {
      const result = await applySetupConfig(edition, adminUser, timezone);
      setState({ kind: "success", result });
      setModalOpen(false);
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
      setModalOpen(false);
    }
  };

  const canApply =
    state.kind !== "running" && state.kind !== "success" && pendingChanges.length > 0;

  return (
    <div>
      <StepHeader
        eyebrow="Done"
        title="Review and apply"
        body="This is the write-out. Any field you changed in the wizard is diffed against the live .env on the host. You'll see exactly which keys change before you confirm."
      />

      {state.kind === "success" ? (
        <ApplySuccessPanel result={state.result} edition={edition} />
      ) : (
        <div className="space-y-4">
          <ChangeList changes={pendingChanges} />

          {state.kind === "error" && (
            <div className="flex items-start gap-2 p-3 bg-th-danger/10 border border-th-danger/30 rounded text-[11.5px] text-th-danger font-mono">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              {state.message}
            </div>
          )}

          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={!canApply}
              className={`px-3 rounded-md text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[44px] flex items-center gap-1.5 transition-colors ${
                canApply
                  ? "bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25"
                  : "bg-th-bg/60 border border-th-line/40 text-th-text-muted/40 cursor-not-allowed"
              }`}
            >
              <Save size={12} />
              apply configuration
            </button>
            <div className="text-[10.5px] text-th-text-muted/80 font-mono leading-relaxed flex-1">
              Writes the changes above to{" "}
              <span className="text-th-text-mono">/opt/pi-dns-warden/.env</span>, backed
              up first to{" "}
              <span className="text-th-text-mono">.env.bak-&lt;timestamp&gt;</span>. Nothing
              restarts automatically. {edition === "advanced" ? (
                <>
                  Run <span className="text-th-text-mono">sudo ./deploy.sh</span> on the
                  host to apply. Network topology (
                  <span className="font-mono text-th-primary">{topology}</span>) still
                  needs explicit network values before it can be deployed safely.
                </>
              ) : (
                <>
                  Home always uses the single-LAN topology. Changing an existing
                  deployment to Home is recorded here but not activated yet.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={modalOpen}
        title="Apply configuration"
        confirmWord="APPLY"
        confirmLabel="Write to .env"
        kind="warning"
        body={
          <>
            <p className="mb-2">
              About to write{" "}
              <strong className="text-th-text">{pendingChanges.length}</strong> key
              {pendingChanges.length === 1 ? "" : "s"} to{" "}
              <span className="font-mono text-th-text-mono">.env</span>. The current
              file is backed up first, so rolling back is a single{" "}
              <span className="font-mono text-th-text-mono">cp</span>.
            </p>
            <p className="text-th-text-muted">
              Nothing restarts automatically. {edition === "advanced" ? (
                <>
                  After the write succeeds, SSH into the host and run{" "}
                  <span className="font-mono text-th-text-mono">sudo ./deploy.sh</span>{" "}
                  to pick up the Advanced settings.
                </>
              ) : (
                <>
                  Home is recorded as the target profile, but switching an existing
                  Advanced deployment is intentionally not automated yet.
                </>
              )}
            </p>
          </>
        }
        onCancel={() => setModalOpen(false)}
        onConfirm={apply}
      />
    </div>
  );
}

function ChangeList({
  changes,
}: {
  changes: Array<{ key: string; label: string; old: string; next: string }>;
}) {
  if (changes.length === 0) {
    return (
      <div className="p-4 bg-th-bg/40 border border-th-line/60 rounded-md text-[11.5px] text-th-text-muted leading-relaxed">
        No changes yet. Edit the edition, admin user, or timezone in earlier steps, then come
        back here to apply. If you're on an existing install with nothing to change,
        head to <span className="font-mono text-th-text-mono">Glance</span> for live
        status instead.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-th-line/60 bg-th-bg/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-th-line/60 text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono flex items-center justify-between">
        <span>pending changes</span>
        <span>
          {changes.length} key{changes.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y divide-th-line/40">
        {changes.map((c) => (
          <div
            key={c.key}
            className="px-3 py-2.5 flex items-baseline gap-3 text-[11.5px]"
          >
            <div className="w-[200px] shrink-0">
              <div className="font-semibold text-th-text">{c.label}</div>
              <div className="text-[9.5px] font-mono text-th-text-muted/60 mt-0.5">
                {c.key}
              </div>
            </div>
            <div className="flex-1 flex items-baseline gap-2 font-mono min-w-0">
              <span className="text-th-text-muted/60 line-through truncate">
                {c.old || "—"}
              </span>
              <span className="text-th-text-muted/60">→</span>
              <span className="text-th-primary truncate">{c.next}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApplySuccessPanel({
  result,
  edition,
}: {
  result: SetupApplyResult;
  edition: Edition;
}) {
  return (
    <div className="rounded-md border border-th-primary/40 bg-th-primary/[0.06] p-4">
      <div className="flex items-start gap-2">
        <Check size={14} className="text-th-primary shrink-0 mt-0.5" strokeWidth={2.5} />
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-th-primary">
            Configuration written
          </div>
          <div className="text-[11.5px] text-th-text-muted mt-1 leading-relaxed">
            {result.message}
          </div>
          {result.changes.length > 0 && (
            <div className="mt-3 space-y-1">
              {result.changes.map((c) => (
                <div key={c.key} className="text-[10.5px] font-mono text-th-text-muted">
                  <span className="text-th-text-muted/60">wrote</span>{" "}
                  <span className="text-th-text-mono">{c.key}</span> ={" "}
                  <span className="text-th-primary">{c.new}</span>
                </div>
              ))}
            </div>
          )}
          {result.backup && (
            <div className="mt-3 text-[10px] font-mono text-th-text-muted/60">
              rollback: <span className="text-th-text-mono">{result.backup}</span>
            </div>
          )}
          <div className="mt-4 p-3 bg-th-bg/50 border border-th-line/40 rounded">
            <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-1">
              next step
            </div>
            <div className="text-[11.5px] font-mono text-th-text-mono">
              {edition === "advanced" ? "sudo ./deploy.sh" : "Home activation pending"}
            </div>
            <div className="text-[10px] text-th-text-muted mt-1.5 leading-relaxed">
              {edition === "advanced"
                ? "Run the deploy script on the host (via SSH) to have Torhole pick up the new values. Until you do, the running stack is still on the old config."
                : "The profile choice is saved, but this checkpoint does not stop or replace an existing Advanced stack. The unified bootstrap dispatcher is the next implementation stage."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
