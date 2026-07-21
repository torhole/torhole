import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  CircleAlert,
  ExternalLink,
  Github,
  Info,
  KeyRound,
  Power,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import DeferredPrivacyFlow from "../components/DeferredPrivacyFlow";
import type { BuildInfo } from "../lib/snapshot";

type CheckResult = {
  ok: boolean;
  detail?: string;
  answers?: number;
  ips?: string[];
};

type Relay = {
  role: string;
  nickname: string;
  country?: string;
  address?: string;
  fingerprint: string;
};

type Proof = {
  protected: boolean;
  checked_at: string;
  build: BuildInfo;
  tor: CheckResult & { progress?: number };
  dns: CheckResult;
  blocking: CheckResult;
  exit: CheckResult & { ip?: string; duration_ms?: number; error?: string };
  bypass: CheckResult;
  circuit: { ok: boolean; relays: Relay[]; detail?: string };
  tests: Record<string, { query: string; expected: string }>;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; proof: Proof }
  | { kind: "error"; message: string };

const CONTROL_ACTIONS = [
  { id: "new-identity", label: "New Tor identity", icon: KeyRound, danger: false },
  { id: "restart-tor", label: "Restart Tor", icon: RotateCw, danger: false },
  { id: "restart-dns", label: "Restart private DNS", icon: RotateCw, danger: false },
  { id: "restart-protection", label: "Restart protection", icon: RefreshCw, danger: false },
  { id: "stop-protection", label: "Stop protection", icon: Power, danger: true },
  { id: "start-protection", label: "Start protection", icon: Power, danger: false },
] as const;

export default function HomeScreen() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [verifying, setVerifying] = useState(false);
  const verifyingRef = useRef(false);
  const [pin, setPin] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);

  const verify = useCallback(async () => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setVerifying(true);
    setState((current) =>
      current.kind === "ready" ? current : { kind: "loading" },
    );
    try {
      const response = await fetch("/api/proof", { cache: "no-store" });
      const data = (await response.json()) as Proof & { detail?: string };
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      setState({ kind: "ready", proof: data });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    } finally {
      verifyingRef.current = false;
      setVerifying(false);
    }
  }, []);

  useEffect(() => {
    void verify();
    const timer = window.setInterval(() => void verify(), 60_000);
    return () => window.clearInterval(timer);
  }, [verify]);

  const runAction = async (id: string) => {
    if (!pin.trim()) {
      setNotice("Enter the control PIN first.");
      return;
    }
    if (
      id === "stop-protection" &&
      !window.confirm("Stop DNS privacy protection for every connected device?")
    ) {
      return;
    }
    setAction(id);
    setNotice("Applying control…");
    try {
      const response = await fetch(`/api/actions/${id}`, {
        method: "POST",
        headers: { "X-Torhole-PIN": pin.trim() },
      });
      const data = (await response.json()) as { ok: boolean; detail?: string };
      if (response.status === 403) setPin("");
      if (!response.ok || !data.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      setNotice(data.detail || "Action completed.");
      window.setTimeout(() => void verify(), id === "new-identity" ? 5_000 : 12_000);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setAction(null);
    }
  };

  const proof = state.kind === "ready" ? state.proof : null;
  const piholeUrl = useMemo(
    () => `${window.location.protocol}//${window.location.hostname}:8081/admin/`,
    [],
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-th-line/70 bg-th-panel/45 backdrop-blur-sm">
        <div className="max-w-[1180px] mx-auto px-5 sm:px-8 min-h-16 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-th-primary to-th-primary/60 flex items-center justify-center shadow-[0_0_25px_rgba(34,197,94,0.25)]">
            <ShieldCheck size={18} className="text-th-bg" strokeWidth={2.6} />
          </div>
          <div className="font-bold tracking-[0.04em] text-[15px]">
            TOR<span className="text-th-primary">HOLE</span>
          </div>
          <span className="px-2 py-1 rounded border border-th-primary/25 bg-th-primary/[0.06] text-[9.5px] uppercase tracking-[0.16em] text-th-primary font-mono">
            Home
          </span>
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-th-text-muted hover:text-th-text min-h-[44px]"
          >
            <Info size={12} /> About{proof?.build?.version ? ` v${proof.build.version}` : ""}
          </button>
          <a
            href={piholeUrl}
            className="inline-flex items-center gap-1.5 text-[11px] text-th-text-muted hover:text-th-text min-h-[44px]"
          >
            Pi-hole settings <ExternalLink size={12} />
          </a>
        </div>
      </header>

      <main className="max-w-[1180px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
        <PrivacyHero state={state} verifying={verifying} onVerify={verify} />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-4">
          <ProofCard
            label="Private DNS"
            ok={proof?.dns.ok}
            good="Resolving privately"
            bad="DNS path failed"
            detail={
              proof
                ? `${proof.dns.answers || 0} answer(s) through Pi-hole → dnscrypt-proxy → Tor.`
                : "Testing a real DNS lookup through the complete path."
            }
          />
          <ProofCard
            label="Tor route"
            ok={proof ? proof.tor.ok && proof.exit.ok : undefined}
            good="Tor exit verified"
            bad={`Tor ${proof?.tor.progress || 0}%`}
            detail={
              proof?.exit.ok
                ? `Tor Project verified ${proof.exit.ip} as a Tor exit.`
                : proof?.exit.error || "Checking the public address independently."
            }
          />
          <ProofCard
            label="Bypass prevention"
            ok={proof?.bypass.ok}
            good="Enforced"
            bad="Not enforced"
            detail={proof?.bypass.detail || "Only Tor may have an internet-capable network."}
          />
          <ProofCard
            label="Ad blocking"
            ok={proof?.blocking.ok}
            good="Active"
            bad="Block test failed"
            detail={
              proof
                ? `doubleclick.net returned ${(proof.blocking.ips || []).join(", ") || "no answer"}.`
                : "Testing a known advertising domain."
            }
          />
        </div>

        <PrivacyPath proof={proof} />

        <section className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-4 mt-4">
          <CircuitPanel circuit={proof?.circuit} />
          <EvidencePanel proof={proof} />
        </section>

        <section className="bg-th-panel border border-th-line rounded-lg p-5 sm:p-6 mt-4">
          <div className="flex flex-col md:flex-row md:items-end gap-4 mb-4">
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
                Protection controls
              </div>
              <h2 className="text-[20px] font-bold mt-1">Operate without the command line</h2>
              <p className="text-[11.5px] text-th-text-muted mt-1">
                Controls are fixed, allowlisted operations. The PIN is checked locally and is
                never sent outside this Torhole host.
              </p>
            </div>
            <label className="w-full md:w-52">
              <span className="block text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted font-mono mb-1.5">
                Control PIN
              </span>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder="6-digit PIN"
                className="w-full min-h-[44px] px-3 rounded-md bg-th-bg/60 border border-th-line focus:border-th-primary/50 outline-none text-[13px] font-mono"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {CONTROL_ACTIONS.map(({ id, label, icon: Icon, danger }) => (
              <button
                key={id}
                type="button"
                disabled={action !== null}
                onClick={() => void runAction(id)}
                className={`min-h-[46px] px-3 rounded-md border flex items-center gap-2 text-[11.5px] font-medium transition-colors disabled:opacity-45 ${
                  danger
                    ? "border-th-danger/35 bg-th-danger/[0.06] text-th-danger hover:bg-th-danger/15"
                    : "border-th-line bg-th-bg/40 text-th-text hover:border-th-primary/35 hover:bg-th-primary/[0.05]"
                }`}
              >
                <Icon size={13} className={action === id ? "animate-spin" : ""} />
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-5 mt-3 text-[11px] font-mono text-th-text-muted">
            {notice}
          </div>
        </section>

        <footer className="text-center text-[10.5px] text-th-text-muted/60 mt-7">
          Torhole{proof?.build?.version ? ` v${proof.build.version}` : ""} reports protected only when every independent proof passes.
        </footer>
      </main>
      {aboutOpen && <HomeAboutDialog build={proof?.build ?? null} onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

function HomeAboutDialog({ build, onClose }: { build: BuildInfo | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-5" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-about-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-th-primary/30 bg-th-panel shadow-[0_25px_100px_rgba(0,0,0,0.45)] overflow-hidden"
      >
        <div className="p-5 border-b border-th-line flex items-center gap-3 bg-th-primary/[0.06]">
          <ShieldCheck size={20} className="text-th-primary" />
          <div>
            <h2 id="home-about-title" className="font-bold">Torhole Home</h2>
            <div className="font-mono text-xs text-th-primary mt-0.5">{build ? `v${build.version}` : "version loading"}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close About" className="ml-auto w-9 h-9 rounded-md flex items-center justify-center text-th-text-muted hover:text-th-text hover:bg-th-line/50">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3 text-xs">
          <HomeBuildField label="Version" value={build ? `v${build.version}` : "unavailable"} />
          <HomeBuildField label="Revision" value={build?.revision || "unknown"} />
          <HomeBuildField label="Edition" value={build?.edition || "home"} />
          <HomeBuildField label="Topology" value={build?.topology || "single-lan"} />
        </div>
        <div className="px-5 pb-5">
          <a href="https://github.com/torhole/torhole" target="_blank" rel="noreferrer" className="min-h-[42px] rounded-md border border-th-line flex items-center gap-2 px-3 text-xs text-th-text-muted hover:text-th-text hover:border-th-primary/40">
            <Github size={14} /> Source, releases, and support <ExternalLink size={11} className="ml-auto" />
          </a>
        </div>
      </section>
    </div>
  );
}

function HomeBuildField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-th-line bg-th-bg/40 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-th-text-muted">{label}</div>
      <div className="font-mono mt-1.5 break-all">{value}</div>
    </div>
  );
}

function PrivacyHero({
  state,
  verifying,
  onVerify,
}: {
  state: LoadState;
  verifying: boolean;
  onVerify: () => Promise<void>;
}) {
  const proof = state.kind === "ready" ? state.proof : null;
  const protectedNow = proof?.protected === true;
  return (
    <section
      className={`relative overflow-hidden border rounded-xl p-6 sm:p-8 th-scanlines th-hero-surface ${
        protectedNow
          ? "border-th-primary/45 bg-th-primary/[0.045]"
          : "border-th-warning/35 bg-th-warning/[0.035]"
      }`}
    >
      <DeferredPrivacyFlow active={protectedNow} />
      <div className="relative flex flex-col lg:flex-row lg:items-center gap-6">
        <div
          className={`w-14 h-14 rounded-full border flex items-center justify-center shrink-0 ${
            protectedNow
              ? "border-th-primary/45 bg-th-primary/10 text-th-primary"
              : "border-th-warning/45 bg-th-warning/10 text-th-warning"
          }`}
        >
          {protectedNow ? <Check size={25} /> : <CircleAlert size={24} />}
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
            Live privacy proof
          </div>
          <h1 className="text-[30px] sm:text-[40px] font-bold tracking-tight leading-none mt-2">
            {state.kind === "loading"
              ? "Verifying privacy"
              : state.kind === "error"
                ? "Verification unavailable"
                : protectedNow
                  ? "Privacy is protected"
                  : "Privacy needs attention"}
          </h1>
          <p className="text-[12.5px] text-th-text-muted mt-3">
            {state.kind === "error"
              ? state.message
              : protectedNow
                ? "DNS is resolving through an enforced Tor-only path."
                : "Torhole is checking the complete DNS path and Tor exit."}
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-5 text-[10.5px] text-th-text-muted font-mono">
            <span>exit <strong className="text-th-text-mono">{proof?.exit.ip || "—"}</strong></span>
            <span>
              response{" "}
              <strong className="text-th-text-mono">
                {proof?.exit.duration_ms ? `${proof.exit.duration_ms} ms` : "—"}
              </strong>
            </span>
            <span>
              verified{" "}
              <strong className="text-th-text-mono">
                {proof ? new Date(proof.checked_at).toLocaleTimeString() : "—"}
              </strong>
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onVerify()}
          disabled={verifying || state.kind === "loading"}
          aria-live="polite"
          className="relative min-h-[46px] px-5 rounded-md bg-th-primary/15 border border-th-primary/40 text-th-primary hover:bg-th-primary/25 disabled:opacity-45 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.14em] font-mono"
        >
          <RefreshCw
            size={13}
            className={verifying || state.kind === "loading" ? "animate-spin" : ""}
          />
          {verifying || state.kind === "loading" ? "verifying..." : "verify now"}
        </button>
      </div>
    </section>
  );
}

function ProofCard({
  label,
  ok,
  good,
  bad,
  detail,
}: {
  label: string;
  ok: boolean | undefined;
  good: string;
  bad: string;
  detail: string;
}) {
  return (
    <article className="bg-th-panel border border-th-line rounded-lg p-4 min-h-36">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted font-mono">
        {label}
      </div>
      <div className="flex items-center gap-2 mt-4 text-[14px] font-semibold">
        <span
          className={`w-2 h-2 rounded-full ${
            ok === undefined ? "bg-th-text-muted/40" : ok ? "bg-th-primary" : "bg-th-danger"
          }`}
        />
        {ok === undefined ? "Checking" : ok ? good : bad}
      </div>
      <div className="text-[10.5px] text-th-text-muted leading-relaxed mt-2">{detail}</div>
    </article>
  );
}

function PrivacyPath({ proof }: { proof: Proof | null }) {
  const stages = [
    {
      number: "01",
      label: "Your devices",
      detail: `Send DNS to ${window.location.hostname}:53. Plain DNS stays on your local network.`,
      ok: proof?.dns.ok,
    },
    {
      number: "02",
      label: "Pi-hole",
      detail: proof?.blocking.ok
        ? "Blocks known advertising domains locally."
        : "Checks whether blocking is working locally.",
      ok: proof?.blocking.ok,
    },
    {
      number: "03",
      label: "Encrypted + Tor",
      detail: "dnscrypt-proxy encrypts the lookup; Tor hides where it came from.",
      ok: proof ? proof.tor.ok && proof.bypass.ok : undefined,
    },
    {
      number: "04",
      label: "DNS resolver",
      detail: proof?.exit.ok
        ? `Sees Tor exit ${proof.exit.ip}, not your home address.`
        : "Should see a Tor exit rather than your home address.",
      ok: proof?.exit.ok,
    },
  ];

  return (
    <section className="bg-th-panel border border-th-line rounded-lg p-5 sm:p-6 mt-4">
      <div className="flex flex-col lg:flex-row lg:items-end gap-2 lg:gap-8 mb-5">
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
            Privacy path
          </div>
          <h2 className="text-[20px] font-bold mt-1">What happens to one DNS lookup</h2>
        </div>
        <p className="text-[10.5px] text-th-text-muted lg:text-right">
          Proof refreshes every minute. Verify now reruns all four checks immediately.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        {stages.map(({ number, label, detail, ok }) => (
          <article key={number} className="relative bg-th-bg/45 border border-th-line/70 rounded-md p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[9px] uppercase tracking-[0.16em] text-th-primary/80 font-mono">
                {number}
              </span>
              <span
                className={`w-2 h-2 rounded-full ${
                  ok === undefined ? "bg-th-text-muted/40" : ok ? "bg-th-primary" : "bg-th-danger"
                }`}
              />
            </div>
            <div className="text-[12.5px] font-semibold mt-3">{label}</div>
            <div className="text-[10.5px] text-th-text-muted leading-relaxed mt-1.5">{detail}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CircuitPanel({ circuit }: { circuit: Proof["circuit"] | undefined }) {
  return (
    <section className="bg-th-panel border border-th-line rounded-lg p-5 sm:p-6">
      <div className="text-[10px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
        Active Tor circuit
      </div>
      <h2 className="text-[20px] font-bold mt-1">The relays protecting this connection</h2>
      <p className="text-[11px] text-th-text-muted mt-1 mb-5">
        Tor maintains several circuits and changes them automatically. This is one circuit
        currently available to new connections.
      </p>
      {!circuit?.ok ? (
        <div className="text-[11.5px] text-th-text-muted">
          {circuit?.detail || "Loading relay details…"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {circuit.relays.map((relay) => (
            <article key={`${relay.role}-${relay.fingerprint}`} className="bg-th-bg/45 border border-th-line/70 rounded-md p-3">
              <div className="text-[9px] uppercase tracking-[0.15em] text-th-primary/80 font-mono">
                {relay.role}
              </div>
              <div className="text-[13px] font-semibold mt-2 truncate">{relay.nickname}</div>
              <div className="text-[10px] text-th-text-muted mt-1.5 leading-relaxed font-mono">
                {relay.country || "??"} · {relay.address || "address hidden"}
                <br />
                {relay.fingerprint.slice(0, 12)}…
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function EvidencePanel({ proof }: { proof: Proof | null }) {
  const rows = proof
    ? [
        ["Tor route", proof.tests.tor, `IsTor=${proof.exit.ok}; exit ${proof.exit.ip || "unavailable"}; ${proof.exit.duration_ms || 0} ms`],
        ["Private DNS", proof.tests.dns, `${proof.dns.answers || 0} answer(s): ${(proof.dns.ips || []).join(", ") || "none"}`],
        ["Ad blocking", proof.tests.blocking, `${proof.blocking.answers || 0} answer(s): ${(proof.blocking.ips || []).join(", ") || "none"}`],
        ["Bypass prevention", proof.tests.bypass, proof.bypass.detail || "No detail"],
      ] as const
    : [];
  return (
    <section className="bg-th-panel border border-th-line rounded-lg p-5 sm:p-6">
      <div className="text-[10px] uppercase tracking-[0.18em] text-th-text-muted font-mono">
        What Torhole tested
      </div>
      <h2 className="text-[20px] font-bold mt-1 mb-4">Evidence, not a green light</h2>
      {rows.length === 0 ? (
        <div className="text-[11.5px] text-th-text-muted">Evidence appears after verification.</div>
      ) : (
        <div className="divide-y divide-th-line/60">
          {rows.map(([name, test, actual]) => (
            <details key={name} className="py-3 group">
              <summary className="cursor-pointer text-[11.5px] font-semibold flex items-center gap-2">
                <Activity size={12} className="text-th-primary" />
                {name}
              </summary>
              <div className="pl-5 pt-2 text-[10px] text-th-text-muted leading-relaxed">
                <strong className="text-th-text">Test:</strong>{" "}
                <span className="font-mono">{test.query}</span>
                <br />
                <strong className="text-th-text">Expected:</strong> {test.expected}
                <br />
                <strong className="text-th-text">Actual:</strong> {actual}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
