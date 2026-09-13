import { ShieldCheck, ShieldAlert, ArrowRight, Network, Cpu, Globe, Settings, Users, Grid2X2, LockKeyhole, CircleCheck, CircleAlert, CircleX, CircleHelp, FileCheck2 } from "lucide-react";
import { Link } from "react-router-dom";
import "./glance.css";
import { formatInt, formatRelative, snapshotFreshness, type Snapshot, type SnapshotState } from "../lib/snapshot";

// Presentation only: the snapshot remains the authority for every health claim.
export default function Glance({ state, actions }: { state: SnapshotState; actions: React.ReactNode }) {
  return (
    <div className="glance-page">
      <header className="glance-header">
        <div><h1>Glance</h1><p>Your network, at a glance.</p></div>
        <span className="glance-updated">{snapshotFreshness(state)}</span>
      </header>
      {state.kind === "ready" ? <Overview data={state.data} /> : (
        <section className="glance-panel glance-summary" role="status">
          <div><h2>{state.kind === "loading" ? "Checking your network…" : "Snapshot unavailable"}</h2>
          <p>{state.kind === "error" ? state.error : "Waiting for current DNS and Tor status."}</p></div>
        </section>
      )}
      <div className="glance-actions">{actions}</div>
    </div>
  );
}

function Health({ status }: { status: string }) {
  const text = ({ healthy: "Healthy", degraded: "Degraded", offline: "Offline", success: "Passed", error: "Failed" } as Record<string, string>)[status] || "Unknown";
  const Icon = status === "healthy" || status === "success" ? CircleCheck : status === "degraded" ? CircleAlert : status === "offline" || status === "error" ? CircleX : CircleHelp;
  return <span className={`glance-health glance-health-${status}`}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{text}</span>;
}

// Small onion-shaped routing glyph, matching the outline weight of the UI icons.
function TorGlyph({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3c0 5-8 6-8 12a8 7 0 0 0 16 0c0-6-8-7-8-12Z" />
    <path d="M12 6c0 4-4 6-4 10s2 6 4 6 4-2 4-6-4-6-4-10Zm0 3v13M12 3l3-2" />
  </svg>;
}

function Overview({ data }: { data: Snapshot }) {
  const intact = data.torhole.privacy_intact;
  const torUp = data.tor.overall_status === "healthy";
  const totals = data.dns.totals;
  const counts = data.container_counts;
  const validation = data.validation.last_result;
  const issues = data.containers.filter(c => c.status !== "healthy");
  const checks = [
    { title: "Tor bootstrap", icon: <TorGlyph size={23} />, status: data.tor.bootstrap.status, detail: data.tor.bootstrap.detail },
    { title: "DNS planes", icon: <Globe size={23} strokeWidth={1.6} />, status: torUp ? data.dns.overall_status : "degraded", detail: torUp ? "Current plane health" : "Tor egress needs attention" },
    { title: "Configuration", icon: <Settings size={23} strokeWidth={1.6} />, status: validation?.status, detail: validation ? `Last run ${formatRelative(validation.finished_at)} · configuration only` : "No validation result recorded" },
  ];
  return <>
    <section className="glance-panel" aria-label="Network overview">
      <div className={`glance-summary ${intact ? "" : "glance-attention"}`}>
        {intact ? <ShieldCheck className="glance-shield" size={60} strokeWidth={1.3} /> : <ShieldAlert className="glance-shield" size={60} strokeWidth={1.3} />}
        <div className="glance-verdict">
          <h2>{intact ? "DNS routed through Tor" : "Privacy needs attention"}</h2>
          <p>{data.torhole.headline}</p>
          <small>DNS routing status does not guarantee privacy or anonymity.</small>
        </div>
        <Link className="glance-link-button" to="/privacy?section=leak-test"><FileCheck2 size={18} aria-hidden="true" />View privacy checks <ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
      <dl className="glance-metrics">
        <div><dt>Queries today</dt><dd>{formatInt(totals.queries_today)}</dd><small>Across all DNS planes</small></div>
        <div><dt>Blocked</dt><dd>{totals.block_pct.toFixed(1)}%</dd><small>{formatInt(totals.blocked_today)} queries</small></div>
        <div><dt>Tor</dt><dd className="glance-metric-status"><Health status={data.tor.overall_status} /></dd><small>{torUp ? "Egress available" : "Review privacy checks"}</small></div>
        <div><dt>Services</dt><dd>{counts.healthy}<span className="glance-denominator"> / {counts.total}</span></dd><small>{counts.total === 0 ? "No services reported" : counts.healthy === counts.total ? "All services healthy" : "Services need attention"}</small></div>
      </dl>
    </section>
    <div className="glance-columns">
      <section className="glance-panel" aria-labelledby="glance-planes">
        <div className="glance-panel-heading"><h2 id="glance-planes">DNS planes</h2><Link to="/configure?section=topology">Topology <ArrowRight size={14} /></Link></div>
        <table className="glance-planes" aria-label="DNS planes">
          <thead><tr><th>Plane</th><th>Status</th><th>Queries today</th><th>Blocked</th></tr></thead>
          <tbody>{data.dns.planes.map(plane => <tr key={plane.id}>
            <th scope="row"><span className="glance-plane-label"><span className="glance-plane-icon" aria-hidden="true">{plane.id === "iot" ? <Cpu size={20} strokeWidth={1.6} /> : <Network size={20} strokeWidth={1.6} />}</span>{plane.label}</span></th>
            <td><Health status={torUp || plane.status === "offline" ? plane.status : "degraded"} /></td>
            <td>{plane.queries_today == null ? "—" : formatInt(plane.queries_today)}</td>
            <td>{plane.percent_blocked == null ? "—" : `${plane.percent_blocked.toFixed(1)}%`}</td>
          </tr>)}</tbody>
        </table>
        {data.dns.planes.length === 0 && <p className="glance-empty">No DNS planes reported.</p>}
        <div className="glance-path"><h3>Configured DNS path</h3>
          <ol className="glance-path-nodes" aria-label="Configured DNS path">
            {[
              { label: "Clients", icon: <Users size={18} /> },
              { label: "Pi-hole", icon: <Grid2X2 size={18} /> },
              { label: "dnscrypt-proxy", icon: <LockKeyhole size={18} /> },
              { label: "Tor", icon: <TorGlyph size={20} /> },
            ].map((node, index) => <li key={node.label}>
              {index > 0 && <ArrowRight className="glance-path-arrow" size={14} aria-hidden="true" />}
              <span className="glance-path-node"><span aria-hidden="true">{node.icon}</span>{node.label}</span>
            </li>)}
          </ol>
        </div>
        <details className="glance-evidence">
          <summary>Technical evidence</summary>
          <dl>
            <div><dt>Tor isolation</dt><dd>{data.tor.isolation.detail || data.tor.isolation.status}</dd></div>
            <div><dt>Network path</dt><dd>{data.tor.network_path.detail || data.tor.network_path.status}</dd></div>
            <div><dt>Last tested exit IP</dt><dd>{data.leak_test.last_result?.ip || "Not tested"}</dd></div>
            <div><dt>Exit test time</dt><dd>{data.leak_test.last_run_at ? formatRelative(data.leak_test.last_run_at) : "Not run"}</dd></div>
          </dl>
        </details>
      </section>
      <section className="glance-panel" aria-labelledby="glance-checks">
        <div className="glance-panel-heading"><h2 id="glance-checks">Latest checks</h2></div>
        <ul className="glance-checks">{checks.map(check => <li key={check.title}>
          <div className="glance-check-label"><span className="glance-check-icon" aria-hidden="true">{check.icon}</span><div><h3>{check.title}</h3><p>{check.detail}</p></div></div>
          {check.status ? <Health status={check.status} /> : <span className="glance-muted">Not run</span>}
        </li>)}</ul>
        <Link className="glance-panel-link" to="/operate?section=validation">Open stack validation <ArrowRight size={15} /></Link>
      </section>
    </div>
    <section className="glance-panel glance-operations" aria-label="Operations summary">
      <Link to="/configure?section=alerts"><span>Alert channels</span><strong>{data.alerts.enabled_channels} / {data.alerts.configured_channels} enabled</strong></Link>
      <Link to="/operate?section=backups"><span>Latest backup</span><strong>{data.backup.last_snapshot_at ? formatRelative(data.backup.last_snapshot_at) : "No snapshots"}</strong></Link>
      <Link to="/operate?section=containers"><span>Services needing attention</span><strong>{issues.length || (counts.total ? "None" : "Unknown")}</strong></Link>
    </section>
    {issues.length > 0 && <section className="glance-panel glance-issues" aria-label="Services needing attention">
      {issues.map(c => <div key={c.id}><Link to="/operate?section=containers">{c.name}</Link><Health status={c.status} /></div>)}
    </section>}
  </>;
}
