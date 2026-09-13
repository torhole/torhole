import { snapshotFreshness, type SnapshotState } from "../lib/snapshot";

/** Shared page introduction using the quiet, readable Glance hierarchy. */
export default function PageHeader({ title, description, state }: {
  title: string;
  description: string;
  state?: SnapshotState;
}) {
  return (
    <header className="th-dashboard-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {state && <span className="th-dashboard-updated">{snapshotFreshness(state)}</span>}
    </header>
  );
}
