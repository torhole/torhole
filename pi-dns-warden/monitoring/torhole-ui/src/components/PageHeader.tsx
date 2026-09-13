import type { Ref } from "react";
import { snapshotFreshness, type SnapshotState } from "../lib/snapshot";

/** Shared page introduction using the quiet, readable Glance hierarchy. */
export default function PageHeader({ title, description, state, headingRef }: {
  title: string;
  description: string;
  state?: SnapshotState;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="th-dashboard-header">
      <div>
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h1>
        <p>{description}</p>
      </div>
      {state && <span className="th-dashboard-updated">{snapshotFreshness(state)}</span>}
    </header>
  );
}
