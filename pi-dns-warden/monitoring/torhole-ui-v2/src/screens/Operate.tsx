/*
 * Operate screen — "What button do I press to fix or change something?"
 *
 * Iteration 1 scope:
 *   - Containers table with restart/start/stop buttons wired to
 *     POST /api/services/action
 *   - Backups list: create + download only
 *   - Validation section with "Run validation" button and per-check results
 *     from the last run
 *
 * Scoped OUT of iteration 1 — destructive operations require a type-to-
 * confirm modal (e.g. "type DELETE to confirm") before we wire them:
 *   - Restore backup (overwrites live stack data from a snapshot)
 *   - Delete backup (permanently removes an archive from disk)
 *   - Bulk container stop/restart
 *
 * All three current sections reuse the snapshot for "what's the current
 * state" and trigger refetch() after any action.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Bell,
  Boxes,
  Check,
  CircleX,
  Container as ContainerIcon,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  LineChart,
  MinusCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Square,
  Sparkles,
  Trash2,
  Waypoints,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import LogPane from "../components/LogPane";
import SectionTabs, { type SectionTabDef } from "../components/SectionTabs";
import {
  createBackup,
  deleteBackup,
  fetchConfig,
  fetchDnsInsights,
  fetchRecovery,
  formatBytes,
  formatRelative,
  restoreBackup,
  runServiceAction,
  runValidation,
  type InsightsPlane,
  useSnapshot,
  type BackupArchive,
  type ContainerInfo,
  type ServiceAction,
  type SnapshotState,
  type StatusKind,
  type ValidationCheck,
  type ValidationCheckStatus,
  type ValidationResult,
} from "../lib/snapshot";

export default function OperateScreen() {
  const { state, refetch } = useSnapshot();
  const [logContainer, setLogContainer] = useState<string | null>(null);

  // Live meta values for the tab headers — recompute on every render so
  // they stay fresh as the snapshot updates.
  const containerMeta =
    state.kind === "ready"
      ? `${state.data.container_counts.healthy}/${state.data.container_counts.total} healthy`
      : undefined;
  const validationMeta =
    state.kind === "ready" && state.data.validation.last_result
      ? `last: ${state.data.validation.last_result.status}`
      : undefined;

  const tabs: SectionTabDef[] = [
    {
      id: "containers",
      eyebrow: "stack",
      title: "Containers",
      meta: containerMeta,
      icon: <ContainerIcon size={11} />,
      content: (
        <ContainersSection
          state={state}
          refetch={refetch}
          onOpenLogs={setLogContainer}
        />
      ),
    },
    {
      id: "backups",
      eyebrow: "recovery",
      title: "Backups",
      icon: <Database size={11} />,
      content: <BackupsSection />,
    },
    {
      id: "validation",
      eyebrow: "validation",
      title: "Stack validation",
      meta: validationMeta,
      icon: <Sparkles size={11} />,
      content: <ValidationSection state={state} refetch={refetch} />,
    },
    {
      id: "insights",
      eyebrow: "dashboards",
      title: "Insights",
      meta: "grafana · prometheus · pi-hole",
      icon: <BarChart3 size={11} />,
      content: <InsightsSection state={state} />,
    },
  ];

  return (
    <div className="th-page-enter px-6 py-7 lg:px-10 lg:py-9 xl:px-14 max-w-[1500px] 2xl:max-w-[1700px] mx-auto">
      <Header state={state} />
      <SectionTabs tabs={tabs} defaultTabId="containers" />
      <LogPane containerName={logContainer} onClose={() => setLogContainer(null)} />
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
          Operate
        </div>
        <h1 className="text-[28px] font-bold tracking-tight mt-1 leading-none">
          What do you need to change?
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
 * Containers — table with start/stop/restart
 * ----------------------------------------------------------------------- */

function ContainersSection({
  state,
  refetch,
  onOpenLogs,
}: {
  state: SnapshotState;
  refetch: () => void;
  onOpenLogs: (containerName: string) => void;
}) {
  if (state.kind !== "ready") {
    return (
      <TabPanel>
        <div className="text-[11px] text-th-text-muted py-3 font-mono">loading…</div>
      </TabPanel>
    );
  }

  const containers = state.data.containers;

  // Sort: unhealthy first (to demand attention), then core, then alpha.
  const sorted = [...containers].sort((a, b) => {
    const order: Record<string, number> = { offline: 0, degraded: 1, healthy: 2 };
    const sa = order[a.status] ?? 3;
    const sb = order[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    if (a.core !== b.core) return a.core ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return (
    <TabPanel>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] font-mono">
          <thead>
            <tr className="text-[9.5px] uppercase tracking-[0.14em] text-th-text-muted/70 border-b border-th-line/60">
              <th className="text-left py-2 pl-1 pr-3 w-[14px]"></th>
              <th className="text-left py-2 pr-3">name</th>
              <th className="text-left py-2 pr-3">role</th>
              <th className="text-left py-2 pr-3">uptime</th>
              <th className="text-left py-2 pr-3">restarts</th>
              <th className="text-right py-2 pl-3 pr-1">actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <ContainerRow
                key={c.id}
                container={c}
                refetch={refetch}
                onOpenLogs={() => onOpenLogs(c.name)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </TabPanel>
  );
}

type ActionState =
  | { kind: "idle" }
  | { kind: "running"; action: ServiceAction }
  | { kind: "error"; message: string };

function ContainerRow({
  container,
  refetch,
  onOpenLogs,
}: {
  container: ContainerInfo;
  refetch: () => void;
  onOpenLogs: () => void;
}) {
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const status = container.status as StatusKind;

  const handle = async (op: ServiceAction) => {
    setAction({ kind: "running", action: op });
    try {
      await runServiceAction(container.id, op);
      refetch();
      setTimeout(() => refetch(), 1500);
      setAction({ kind: "idle" });
    } catch (err) {
      setAction({ kind: "error", message: (err as Error).message });
      setTimeout(() => setAction({ kind: "idle" }), 4000);
    }
  };

  const dot =
    status === "healthy"
      ? "bg-th-primary"
      : status === "degraded"
      ? "bg-th-warning"
      : "bg-th-danger";

  const uptime = container.started_at
    ? formatRelative(container.started_at)
    : "—";
  const isRunning = status === "healthy" || status === "degraded";
  const disabled = action.kind === "running";

  return (
    <tr className="border-b border-th-line/30 hover:bg-th-line/10">
      <td className="py-2 pl-1 pr-3">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      </td>
      <td className="py-2 pr-3 text-th-text-mono">{container.name}</td>
      <td className="py-2 pr-3 text-th-text-muted text-[10.5px] uppercase tracking-[0.08em]">
        {container.core ? "core" : "support"}
      </td>
      <td className="py-2 pr-3 text-th-text-muted tabular-nums">{uptime}</td>
      <td className="py-2 pr-3 text-th-text-muted tabular-nums">
        {container.restart_count ?? "—"}
      </td>
      <td className="py-2 pl-3 pr-1">
        <div className="flex items-center justify-end gap-1">
          <ActionBtn
            label="logs"
            icon={ScrollText}
            onClick={onOpenLogs}
          />
          <ActionBtn
            label="restart"
            icon={RefreshCw}
            spinning={action.kind === "running" && action.action === "restart"}
            disabled={disabled}
            onClick={() => handle("restart")}
          />
          {isRunning ? (
            <ActionBtn
              label="stop"
              icon={Square}
              variant="danger"
              spinning={action.kind === "running" && action.action === "stop"}
              disabled={disabled}
              onClick={() => handle("stop")}
            />
          ) : (
            <ActionBtn
              label="start"
              icon={Play}
              variant="primary"
              spinning={action.kind === "running" && action.action === "start"}
              disabled={disabled}
              onClick={() => handle("start")}
            />
          )}
        </div>
        {action.kind === "error" && (
          <div className="text-[10px] text-th-danger text-right mt-1 truncate max-w-[240px]">
            {action.message}
          </div>
        )}
      </td>
    </tr>
  );
}

function ActionBtn({
  label,
  icon: Icon,
  spinning,
  disabled,
  onClick,
  variant = "neutral",
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  spinning?: boolean;
  disabled?: boolean;
  onClick: () => void;
  variant?: "neutral" | "primary" | "danger";
}) {
  const colour =
    variant === "primary"
      ? "hover:text-th-primary hover:border-th-primary/40"
      : variant === "danger"
      ? "hover:text-th-danger hover:border-th-danger/40"
      : "hover:text-th-text hover:border-th-primary/40";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex items-center gap-1 px-2 py-1.5 rounded bg-th-bg/60 border border-th-line text-th-text-muted transition-colors text-[10px] uppercase tracking-[0.14em] ${colour} disabled:opacity-40 disabled:cursor-not-allowed min-h-[28px]`}
    >
      <Icon size={11} strokeWidth={2.2} className={spinning ? "animate-spin" : ""} />
      {label}
    </button>
  );
}

/* ----------------------------------------------------------------------- *
 * Backups — list + create + download
 * ----------------------------------------------------------------------- */

type BackupRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; archive?: string }
  | { kind: "error"; message: string };

function BackupsSection() {
  const [backups, setBackups] = useState<BackupArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [create, setCreate] = useState<BackupRunState>({ kind: "idle" });
  const [deleteTarget, setDeleteTarget] = useState<BackupArchive | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupArchive | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchRecovery();
      setBackups(data.backups);
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

  const handleCreate = async () => {
    setCreate({ kind: "running" });
    try {
      const result = await createBackup();
      setCreate({ kind: "success", archive: result.archive });
      await load();
      setTimeout(() => setCreate({ kind: "idle" }), 3000);
    } catch (e) {
      setCreate({ kind: "error", message: (e as Error).message });
      setTimeout(() => setCreate({ kind: "idle" }), 5000);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteBackup(deleteTarget.name);
    setDeleteTarget(null);
    await load();
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    await restoreBackup(restoreTarget.name);
    setRestoreTarget(null);
    await load();
  };

  return (
    <TabPanel
      action={
        <>
          <div className="text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em] mr-auto">
            {backups.length} snapshot{backups.length === 1 ? "" : "s"}
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={create.kind === "running"}
            className={`flex items-center gap-1.5 px-3 rounded-md text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[36px] transition-colors ${
              create.kind === "running"
                ? "bg-th-bg/60 border border-th-line text-th-text-muted cursor-wait"
                : create.kind === "success"
                ? "bg-th-primary/15 border border-th-primary/40 text-th-primary"
                : create.kind === "error"
                ? "bg-th-danger/10 border border-th-danger/40 text-th-danger"
                : "bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40"
            }`}
          >
            {create.kind === "running" ? (
              <>
                <RefreshCw size={12} className="animate-spin" />
                creating…
              </>
            ) : create.kind === "success" ? (
              <>
                <Check size={12} strokeWidth={2.5} />
                created
              </>
            ) : create.kind === "error" ? (
              <>
                <CircleX size={12} />
                failed
              </>
            ) : (
              <>
                <Database size={12} />
                create snapshot
              </>
            )}
          </button>
        </>
      }
    >
      {loading && backups.length === 0 ? (
        <div className="text-[11px] text-th-text-muted py-3 font-mono">loading…</div>
      ) : err ? (
        <div className="flex items-start gap-2 text-[11px] text-th-danger font-mono py-2">
          <AlertCircle size={13} />
          {err}
        </div>
      ) : backups.length === 0 ? (
        <div className="text-[11px] text-th-text-muted py-3 font-mono">
          no backups yet · click "create snapshot" to make the first one
        </div>
      ) : (
        <div className="space-y-1.5">
          {backups.map((b) => (
            <BackupRow
              key={b.name}
              backup={b}
              onRestore={() => setRestoreTarget(b)}
              onDelete={() => setDeleteTarget(b)}
            />
          ))}
        </div>
      )}
      {create.kind === "error" && (
        <div className="text-[11px] text-th-danger font-mono mt-2 px-2 py-1.5 bg-th-danger/10 border border-th-danger/30 rounded">
          {create.message}
        </div>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete backup"
        confirmWord="DELETE"
        confirmLabel="Delete backup"
        kind="danger"
        body={
          <>
            <p className="mb-2">
              This will permanently delete{" "}
              <span className="font-mono text-th-text-mono">{deleteTarget?.name}</span>{" "}
              from the backup directory on the host.
            </p>
            <p className="text-th-text-muted">
              The archive ({formatBytes(deleteTarget?.size_bytes ?? 0)}) cannot be
              recovered after this. Make sure you have a copy elsewhere if you need it.
            </p>
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />

      <ConfirmModal
        open={restoreTarget !== null}
        title="Restore backup"
        confirmWord="RESTORE"
        confirmLabel="Restore from archive"
        kind="danger"
        body={
          <>
            <p className="mb-2">
              This will overwrite the live Docker volumes from{" "}
              <span className="font-mono text-th-text-mono">{restoreTarget?.name}</span>
              . The stack will be restarted and any changes made since this snapshot
              was taken will be lost.
            </p>
            <p className="text-th-text-muted">
              Expect a short downtime during the restore. Run a fresh snapshot first
              if you want a rollback point.
            </p>
          </>
        }
        onCancel={() => setRestoreTarget(null)}
        onConfirm={handleRestore}
      />
    </TabPanel>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
}: {
  backup: BackupArchive;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const ageIso = backup.metadata.created_at || backup.modified_at;
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-th-bg/40 border border-th-line/60 rounded text-[11px]">
      <Database size={13} className="text-th-text-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-th-text-mono truncate" title={backup.name}>
          {backup.name}
        </div>
        <div className="font-mono text-[9.5px] text-th-text-muted/70 mt-0.5">
          {formatBytes(backup.size_bytes)} · {formatRelative(ageIso)}
        </div>
      </div>
      <a
        href={`/api/recovery/download?archive=${encodeURIComponent(backup.name)}`}
        download
        className="flex items-center gap-1 px-2.5 py-2 rounded bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40 transition-colors text-[10px] uppercase tracking-[0.14em] font-mono min-h-[32px]"
        title="Download archive"
      >
        <Download size={11} />
        download
      </a>
      <button
        type="button"
        onClick={onRestore}
        className="flex items-center gap-1 px-2.5 py-2 rounded bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-warning hover:border-th-warning/40 transition-colors text-[10px] uppercase tracking-[0.14em] font-mono min-h-[32px]"
        title="Restore — overwrites live volumes"
      >
        <RotateCcw size={11} />
        restore
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1 px-2.5 py-2 rounded bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-danger hover:border-th-danger/40 transition-colors text-[10px] uppercase tracking-[0.14em] font-mono min-h-[32px]"
        title="Delete — permanently remove archive"
      >
        <Trash2 size={11} />
        delete
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------- *
 * Validation — run + per-check results
 * ----------------------------------------------------------------------- */

type ValidationRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: ValidationResult }
  | { kind: "error"; message: string };

function ValidationSection({
  state,
  refetch,
}: {
  state: SnapshotState;
  refetch: () => void;
}) {
  const [run, setRun] = useState<ValidationRunState>({ kind: "idle" });

  const lastFromSnapshot =
    state.kind === "ready" ? state.data.validation.last_result : null;

  const result: ValidationResult | null =
    run.kind === "done" ? run.result : lastFromSnapshot;

  const handleRun = async () => {
    setRun({ kind: "running" });
    try {
      const r = await runValidation();
      setRun({ kind: "done", result: r });
      refetch();
      setTimeout(() => setRun({ kind: "idle" }), 5000);
    } catch (e) {
      setRun({ kind: "error", message: (e as Error).message });
      setTimeout(() => setRun({ kind: "idle" }), 5000);
    }
  };

  return (
    <TabPanel
      action={
        <>
          <div className="text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em] mr-auto">
            {result ? `last run: ${result.status}` : "no runs yet"}
          </div>
          <button
            type="button"
            onClick={handleRun}
            disabled={run.kind === "running"}
            className={`flex items-center gap-1.5 px-3 rounded-md text-[10.5px] font-mono uppercase tracking-[0.14em] min-h-[36px] transition-colors ${
              run.kind === "running"
                ? "bg-th-bg/60 border border-th-line text-th-text-muted cursor-wait"
                : "bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40"
            }`}
          >
            {run.kind === "running" ? (
              <>
                <RefreshCw size={12} className="animate-spin" />
                running…
              </>
            ) : (
              <>
                <Sparkles size={12} />
                run validation
              </>
            )}
          </button>
        </>
      }
    >
      {!result ? (
        <div className="text-[11px] text-th-text-muted font-mono py-3">
          no validation run yet · click "run validation" to check the stack
        </div>
      ) : (
        <>
          <div
            className={`rounded-md border p-3 mb-3 ${
              result.status === "success"
                ? "bg-th-primary/[0.04] border-th-primary/30"
                : "bg-th-danger/[0.06] border-th-danger/40"
            }`}
          >
            <div className="flex items-center gap-2">
              <div
                className={`w-5 h-5 rounded flex items-center justify-center ${
                  result.status === "success"
                    ? "bg-th-primary/15 text-th-primary"
                    : "bg-th-danger/15 text-th-danger"
                }`}
              >
                {result.status === "success" ? (
                  <Check size={13} strokeWidth={3} />
                ) : (
                  <CircleX size={13} strokeWidth={2.5} />
                )}
              </div>
              <div
                className={`text-[12.5px] font-semibold ${
                  result.status === "success" ? "text-th-primary" : "text-th-danger"
                }`}
              >
                {result.summary}
              </div>
              <div className="ml-auto text-[10px] font-mono text-th-text-muted uppercase tracking-[0.14em]">
                {formatRelative(result.finished_at)}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            {result.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>

          {result.detail && result.status !== "success" && (
            <details className="mt-3">
              <summary className="text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono cursor-pointer hover:text-th-text">
                failure detail
              </summary>
              <pre className="mt-2 p-2 bg-th-bg/60 border border-th-line/60 rounded text-[10px] font-mono text-th-text-mono overflow-x-auto whitespace-pre-wrap break-words">
                {result.detail}
              </pre>
            </details>
          )}
        </>
      )}

      {run.kind === "error" && (
        <div className="text-[11px] text-th-danger font-mono mt-2 px-2 py-1.5 bg-th-danger/10 border border-th-danger/30 rounded">
          {run.message}
        </div>
      )}
    </TabPanel>
  );
}

function CheckRow({ check }: { check: ValidationCheck }) {
  const icon = statusIcon(check.status);
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
      {icon}
      <span className="font-mono text-th-text-mono">{check.label}</span>
      <span
        className={`ml-auto text-[9.5px] font-mono uppercase tracking-[0.14em] ${
          check.status === "success"
            ? "text-th-primary/70"
            : check.status === "error"
            ? "text-th-danger"
            : "text-th-text-muted/50"
        }`}
      >
        {check.status}
      </span>
    </div>
  );
}

function statusIcon(status: ValidationCheckStatus) {
  if (status === "success")
    return <ShieldCheck size={12} className="text-th-primary" strokeWidth={2.5} />;
  if (status === "error") return <CircleX size={12} className="text-th-danger" strokeWidth={2.5} />;
  return <MinusCircle size={12} className="text-th-text-muted/50" strokeWidth={2} />;
}

/* ----------------------------------------------------------------------- *
 * Insights — curated deep-links to Grafana dashboards and neighbouring
 * observability tools (Prometheus, Alertmanager, Dockhand, Pi-hole admin).
 *
 * Each tile has:
 *   - icon + name + one-line description
 *   - health dot driven by the related container's status in the snapshot
 *   - "open →" button that launches the target in a new tab
 *
 * URLs are templated off REVERSE_PROXY_DOMAIN which we read once on mount
 * via /api/config (the same helper Configure uses). We keep the tile
 * definitions in a plain array so adding new dashboards or tools later is
 * a single-line edit.
 * ----------------------------------------------------------------------- */

type InsightTile = {
  id: string;
  group: "metrics" | "alerts" | "logs" | "containers" | "dns" | "host";
  name: string;
  description: string;
  icon: React.ReactNode;
  /** Host label key from /api/config; path is appended to the configured public URL. */
  hostConfigKey: string;
  fallbackSubdomain: string;
  path: string;
  /** Container name in the snapshot used to compute the health dot. */
  healthContainer: string;
};

const INSIGHT_TILES: InsightTile[] = [
  // ---- Grafana dashboards ----
  {
    id: "grafana-control",
    group: "metrics",
    name: "Control Room",
    description: "Top-level stack health, all planes at a glance",
    icon: <Gauge size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-control/",
    healthContainer: "grafana",
  },
  {
    id: "grafana-dns-path",
    group: "metrics",
    name: "DNS Path",
    description: "Per-plane query flow · Pi-hole → dnscrypt → Tor",
    icon: <LineChart size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-path/",
    healthContainer: "grafana",
  },
  {
    id: "grafana-torflow",
    group: "metrics",
    name: "Tor Flow & Runtime",
    description: "Container uptime, restarts, resource usage",
    icon: <Boxes size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-torflow/",
    healthContainer: "grafana",
  },
  {
    id: "grafana-edge",
    group: "metrics",
    name: "Edge & Egress",
    description: "Reverse proxy, upstream health, Tor edge flow",
    icon: <Waypoints size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-platform/",
    healthContainer: "grafana",
  },
  {
    id: "grafana-visibility",
    group: "logs",
    name: "Visibility & Logs",
    description: "Query stats, upstream share, Loki log search",
    icon: <FileText size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-visibility/",
    healthContainer: "grafana",
  },
  // ---- Host infrastructure (separated from Torhole-specific dashboards) ----
  {
    id: "grafana-host",
    group: "host",
    name: "Host Infrastructure",
    description: "CPU, RAM, disk, network interfaces · node-exporter + cadvisor",
    icon: <Cpu size={14} className="text-th-text-muted" />,
    hostConfigKey: "TORHOLE_HOST_GRAFANA",
    fallbackSubdomain: "grafana",
    path: "/d/pidns-host/",
    healthContainer: "grafana",
  },
  // ---- Raw sources ----
  {
    id: "prometheus",
    group: "metrics",
    name: "Prometheus",
    description: "Raw metrics, PromQL explorer, alert rules",
    icon: <BarChart3 size={14} className="text-th-accent" />,
    hostConfigKey: "TORHOLE_HOST_PROMETHEUS",
    fallbackSubdomain: "prometheus",
    path: "/",
    healthContainer: "prometheus",
  },
  {
    id: "alertmanager",
    group: "alerts",
    name: "Alertmanager",
    description: "Firing & silenced alerts, routing status",
    icon: <Bell size={14} className="text-th-warning" />,
    hostConfigKey: "TORHOLE_HOST_ALERTMANAGER",
    fallbackSubdomain: "alertmanager",
    path: "/",
    healthContainer: "alertmanager",
  },
  // ---- Container runtime ----
  {
    id: "dockhand",
    group: "containers",
    name: "Dockhand",
    description: "Image update monitor (read-only)",
    icon: <ContainerIcon size={14} className="text-th-text-muted" />,
    hostConfigKey: "TORHOLE_HOST_DOCKHAND",
    fallbackSubdomain: "dockhand",
    path: "/",
    healthContainer: "dockhand",
  },
  // ---- Pi-hole admin UIs ----
  {
    id: "pihole-trusted",
    group: "dns",
    name: "Pi-hole · Trusted",
    description: "Legacy admin UI for the trusted plane",
    icon: <ShieldCheck size={14} className="text-th-primary" />,
    hostConfigKey: "TORHOLE_HOST_PIHOLE_TRUSTED",
    fallbackSubdomain: "pihole-trusted",
    path: "/admin/",
    healthContainer: "pihole_trusted",
  },
  {
    id: "pihole-iot",
    group: "dns",
    name: "Pi-hole · IoT",
    description: "Legacy admin UI for the IoT plane",
    icon: <ShieldCheck size={14} className="text-th-warning" />,
    hostConfigKey: "TORHOLE_HOST_PIHOLE_IOT",
    fallbackSubdomain: "pihole-iot",
    path: "/admin/",
    healthContainer: "pihole_iot",
  },
];

const INSIGHT_GROUPS: Array<{ id: InsightTile["group"]; label: string }> = [
  { id: "metrics", label: "Metrics · Grafana dashboards" },
  { id: "logs", label: "Logs" },
  { id: "alerts", label: "Alerts" },
  { id: "containers", label: "Containers" },
  { id: "dns", label: "DNS admin" },
  { id: "host", label: "Host infrastructure" },
];

/* ----------------------------------------------------------------------- *
 * Query insights — top domains / top blocked / top clients per plane, from
 * the Pi-hole stats API via /api/dns/insights (60s server-side cache).
 * ----------------------------------------------------------------------- */

function QueryInsights() {
  const [data, setData] = useState<{ planes: InsightsPlane[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [planeId, setPlaneId] = useState<string>("trusted");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchDnsInsights()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setErr(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setErr((e as Error).message);
        });
    load();
    const h = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, []);

  const plane =
    data?.planes.find((p) => p.id === planeId) ?? data?.planes[0] ?? null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono">
          Query insights · last 24h
        </div>
        <div className="flex gap-1.5">
          {(data?.planes ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlaneId(p.id)}
              className={`px-2.5 py-1.5 rounded border text-[10px] font-mono uppercase tracking-[0.14em] min-h-[30px] transition-colors ${
                plane?.id === p.id
                  ? "border-th-primary/50 text-th-primary bg-th-primary/10"
                  : "border-th-line text-th-text-muted hover:text-th-text"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="p-3 bg-th-danger/10 border border-th-danger/30 rounded text-[11px] text-th-danger font-mono mb-3">
          insights unavailable: {err}
        </div>
      )}

      {!data && !err && (
        <div className="p-4 text-[11px] font-mono text-th-text-muted/60 border border-dashed border-th-line rounded">
          loading query insights…
        </div>
      )}

      {plane && !plane.available && (
        <div className="p-3 bg-th-warning/10 border border-th-warning/30 rounded text-[11px] text-th-warning font-mono">
          {plane.label}: Pi-hole stats API unreachable.
        </div>
      )}

      {plane && plane.available && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <InsightList
            title="Top domains"
            entries={plane.top_domains.map((d) => ({ label: d.name, count: d.count }))}
            barClass="bg-th-primary/50"
          />
          <InsightList
            title="Top blocked"
            entries={plane.top_blocked.map((d) => ({ label: d.name, count: d.count }))}
            barClass="bg-th-danger/50"
          />
          <InsightList
            title="Top clients"
            entries={plane.top_clients.map((c) => ({
              label: c.name ? `${c.name} (${c.ip})` : c.ip,
              count: c.count,
            }))}
            barClass="bg-th-warning/50"
          />
        </div>
      )}
    </div>
  );
}

function InsightList({
  title,
  entries,
  barClass,
}: {
  title: string;
  entries: Array<{ label: string; count: number }>;
  barClass: string;
}) {
  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
  return (
    <div className="bg-th-bg/40 border border-th-line/60 rounded-md p-3">
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2.5">
        {title}
      </div>
      {entries.length === 0 ? (
        <div className="text-[10.5px] font-mono text-th-text-muted/50">no data yet</div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((e) => (
            <div key={e.label} className="relative overflow-hidden rounded-sm">
              {/* count-proportional backdrop bar */}
              <div
                className={`absolute inset-y-0 left-0 opacity-[0.14] ${barClass}`}
                style={{ width: max > 0 ? `${(e.count / max) * 100}%` : "0%" }}
              />
              <div className="relative flex items-center justify-between gap-2 px-1.5 py-1">
                <span className="font-mono text-[10.5px] text-th-text-mono truncate">
                  {e.label}
                </span>
                <span className="font-mono text-[10px] text-th-text-muted tabular-nums shrink-0">
                  {e.count.toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsightsSection({ state }: { state: SnapshotState }) {
  const [domain, setDomain] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [domainErr, setDomainErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((data) => {
        if (!cancelled) {
          setConfig(data.config);
          setDomain(data.config.REVERSE_PROXY_DOMAIN || null);
        }
      })
      .catch((e) => {
        if (!cancelled) setDomainErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build a quick container status lookup for the health dots.
  const containerStatus = new Map<string, StatusKind>();
  if (state.kind === "ready") {
    for (const c of state.data.containers) {
      containerStatus.set(c.name, c.status as StatusKind);
    }
  }
  const iotEnabled =
    state.kind === "ready"
      ? state.data.dns.planes.some((plane) => plane.id === "iot")
      : config.TORHOLE_TOPOLOGY === "vlan";

  return (
    <TabPanel>
      <QueryInsights />

      <div className="flex items-start gap-2 mb-4 p-3 bg-th-bg/40 border border-th-line/60 rounded text-[11px] text-th-text-muted leading-relaxed">
        <BarChart3 size={13} className="text-th-text-muted/70 shrink-0 mt-0.5" />
        <div>
          Curated deep-links into the observability stack. Each tile opens in a
          new tab and inherits your current Torhole login when the access mode supports it.
          Health dots mirror the container state from the snapshot, so a red
          dot means the tool is down, not just unreachable from your browser.
        </div>
      </div>

      {domainErr && (
        <div className="flex items-start gap-2 text-[11px] text-th-danger font-mono py-2 mb-3">
          <AlertCircle size={13} />
          {domainErr}
        </div>
      )}

      <div className="space-y-5">
        {INSIGHT_GROUPS.map((group) => {
          const tiles = INSIGHT_TILES.filter(
            (t) =>
              t.group === group.id &&
              (iotEnabled || t.id !== "pihole-iot"),
          ).map((tile) =>
            tile.id === "pihole-trusted" && !iotEnabled
              ? {
                  ...tile,
                  name: "Pi-hole · Flat LAN",
                  description: "Admin UI for the single-LAN DNS plane",
                }
              : tile,
          );
          if (tiles.length === 0) return null;
          return (
            <div key={group.id}>
              <div className="text-[9.5px] uppercase tracking-[0.16em] text-th-text-muted/70 font-mono mb-2">
                {group.label}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {tiles.map((tile) => (
                  <InsightTileCard
                    key={tile.id}
                    tile={tile}
                    domain={domain}
                    config={config}
                    status={containerStatus.get(tile.healthContainer) ?? null}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </TabPanel>
  );
}

function InsightTileCard({
  tile,
  domain,
  config,
  status,
}: {
  tile: InsightTile;
  domain: string | null;
  config: Record<string, string>;
  status: StatusKind | null;
}) {
  const host = config[tile.hostConfigKey] || tile.fallbackSubdomain;
  const scheme = config.TORHOLE_WEB_MODE === "http" ? "http" : "https";
  const href = domain ? `${scheme}://${host}.${domain}${tile.path}` : null;
  const dotColor =
    status === "healthy"
      ? "bg-th-primary"
      : status === "degraded"
      ? "bg-th-warning"
      : status === "offline"
      ? "bg-th-danger"
      : "bg-th-text-muted/30";
  const dotTitle =
    status === "healthy"
      ? "container healthy"
      : status === "degraded"
      ? "container degraded"
      : status === "offline"
      ? "container offline"
      : "container status unknown";

  const disabled = !href || status === "offline";

  const content = (
    <>
      <div className="flex items-start gap-2.5">
        <div className="w-8 h-8 rounded bg-th-bg/60 border border-th-line/60 flex items-center justify-center shrink-0 mt-0.5">
          {tile.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[12.5px] font-semibold text-th-text truncate">
              {tile.name}
            </div>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`}
              title={dotTitle}
              aria-label={dotTitle}
            />
          </div>
          <div className="text-[10.5px] text-th-text-muted mt-0.5 leading-snug">
            {tile.description}
          </div>
        </div>
        <ExternalLink
          size={12}
          className="text-th-text-muted/60 group-hover:text-th-text shrink-0 mt-1"
        />
      </div>
    </>
  );

  const className = `group flex items-start px-3 py-2.5 rounded-md bg-th-bg/40 border border-th-line/60 transition-colors ${
    disabled
      ? "opacity-50 cursor-not-allowed"
      : "hover:bg-th-bg/70 hover:border-th-primary/40"
  }`;

  if (disabled) {
    return (
      <div
        className={className}
        title={!href ? "loading URL…" : "container is offline"}
      >
        {content}
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={`open ${tile.name} in a new tab`}
    >
      {content}
    </a>
  );
}

/* ----------------------------------------------------------------------- *
 * TabPanel — panel chrome without a duplicate header. Used by tab-content
 * sections since the eyebrow/title/meta live in the SectionTabs button.
 * Accepts an optional right-aligned action slot that floats above the body.
 * ----------------------------------------------------------------------- */

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
