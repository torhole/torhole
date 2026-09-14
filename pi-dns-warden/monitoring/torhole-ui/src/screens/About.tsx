import { useState } from "react";
import { Check, Copy, ExternalLink, Github, ShieldCheck } from "lucide-react";
import { useBuildInfo, type BuildInfo as BuildInfoType } from "../lib/snapshot";

import PageHeader from "../components/PageHeader";

const REPOSITORY_URL = "https://github.com/torhole/torhole";

export default function AboutScreen() {
  const state = useBuildInfo();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const build = state.kind === "ready" ? state.data : null;

  const copyDiagnostics = async () => {
    if (!build) return;
    try {
      await navigator.clipboard.writeText(diagnosticText(build));
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <div className="th-dashboard-page">
      <PageHeader title="Which Torhole is this?" description="Version, build identity, and project information." />

      <section className="th-dashboard-surface overflow-hidden">
        <div className="p-6 border-b border-th-line flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-th-primary/15 border border-th-primary/30 flex items-center justify-center">
            <ShieldCheck size={24} className="text-th-primary" />
          </div>
          <div>
            <div className="font-bold text-xl tracking-tight">Torhole</div>
            <div className="font-mono text-th-primary text-sm mt-1">
              {build ? `v${build.version}` : state.kind === "error" ? "version unavailable" : "loading version..."}
            </div>
          </div>
        </div>

        {build ? (
          <div className="grid sm:grid-cols-2">
            <BuildRow label="Version" value={`v${build.version}`} />
            <BuildRow label="Revision" value={build.revision} />
            <BuildRow label="Edition" value={build.edition} />
            <BuildRow label="Topology" value={build.topology} />
            <BuildRow label="Snapshot schema" value={String(build.snapshot_schema ?? "not applicable")} />
            <BuildRow label="Update channel" value={build.version.endsWith("-dev") ? "development" : "stable release"} />
          </div>
        ) : (
          <div className="p-6 text-sm text-th-text-muted">
            {state.kind === "error" ? state.error : "Reading build identity..."}
          </div>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-4 mt-5">
        <section className="th-dashboard-panel">
          <div className="th-ui-label text-th-text-muted mb-2">
            Support identity
          </div>
          <p className="text-sm text-th-text-muted leading-relaxed">
            Include the version and revision when reporting a problem. The copied identity contains no credentials, DNS queries, clients, local addresses, or Tor exits.
          </p>
          <button
            type="button"
            disabled={!build}
            onClick={() => void copyDiagnostics()}
            className="mt-4 min-h-[40px] inline-flex items-center gap-2 rounded-md border border-th-line px-3 text-xs font-medium text-th-text hover:border-th-primary/40 hover:bg-th-primary/[0.06] disabled:opacity-40"
          >
            {copied ? <Check size={14} className="text-th-primary" /> : <Copy size={14} />}
            {copied ? "Copied" : copyFailed ? "Copy unavailable" : "Copy build identity"}
          </button>
        </section>

        <section className="th-dashboard-panel">
          <div className="th-ui-label text-th-text-muted mb-2">
            Project
          </div>
          <div className="space-y-2">
            <ProjectLink href={REPOSITORY_URL} icon={Github} label="Source and issues" />
            <ProjectLink href={`${REPOSITORY_URL}/releases`} icon={ExternalLink} label="Published releases" />
            <ProjectLink href={`${REPOSITORY_URL}/blob/main/LICENSE`} icon={ExternalLink} label="GPL v3 license" />
            <ProjectLink href={`${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`} icon={ExternalLink} label="Third-party notices" />
            <ProjectLink href={`${REPOSITORY_URL}/blob/main/TRADEMARKS.md`} icon={ExternalLink} label="Trademarks and independence" />
            <ProjectLink href="/third-party-licenses.txt" icon={ExternalLink} label="Browser bundle licenses" />
          </div>
        </section>
      </div>

      <section className="th-dashboard-panel mt-4" aria-labelledby="independence-title">
        <div id="independence-title" className="th-ui-label text-th-text-muted mb-2">
          Independent project
        </div>
        <p className="text-sm text-th-text-muted leading-relaxed">
          Torhole is not endorsed, sponsored by, or affiliated with The Tor Project, the Pi-hole project,
          or the maintainers of its other third-party components. Tor and Pi-hole are referenced solely to
          describe interoperability and the configured privacy path.
        </p>
        <p className="text-[11px] text-th-text-muted/80 leading-relaxed mt-3">
          Tor is a trademark of The Tor Project; all rights reserved. Pi-hole® and other product names and
          marks belong to their respective owners.
        </p>
      </section>
    </div>
  );
}

function diagnosticText(build: BuildInfoType) {
  return [
    `${build.product} v${build.version}`,
    `revision: ${build.revision}`,
    `edition: ${build.edition}`,
    `topology: ${build.topology}`,
    `snapshot schema: ${build.snapshot_schema ?? "not applicable"}`,
  ].join("\n");
}

function BuildRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-5 border-b border-th-line sm:odd:border-r">
      <div className="th-ui-label text-th-text-muted">{label}</div>
      <div className="mt-1.5 font-mono text-sm text-th-text break-all">{value}</div>
    </div>
  );
}

function ProjectLink({ href, icon: Icon, label }: { href: string; icon: typeof Github; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="min-h-[40px] flex items-center gap-2.5 rounded-md border border-th-line px-3 text-xs text-th-text-muted hover:text-th-text hover:border-th-primary/40 hover:bg-th-primary/[0.05]"
    >
      <Icon size={14} />
      <span>{label}</span>
      <ExternalLink size={11} className="ml-auto opacity-50" />
    </a>
  );
}
