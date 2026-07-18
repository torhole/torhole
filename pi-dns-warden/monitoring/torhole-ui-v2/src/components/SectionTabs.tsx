/*
 * SectionTabs — tab pattern that reuses the existing SectionHeader visual
 * language (3px green rail + eyebrow + title + meta) as a row of clickable
 * buttons.
 *
 * Used to split long screens (Privacy, eventually Operate/Configure) into
 * independent views without introducing a new visual vocabulary.
 *
 * Content stays mounted by default — non-active tabs are hidden via CSS,
 * not unmounted — so SSE connections, scroll positions, timers, and
 * in-flight state all persist across tab switches.
 *
 * Tab content that holds an expensive resource (SSE, WebSocket, polling
 * timer) can opt out of the always-on cost by passing `content` as a
 * render function of `active: boolean` and gating the resource on the
 * flag. See LiveQueryFeedPanel for an example.
 *
 * Design notes:
 *   - Active tab: full primary-green rail, bright text, panel-colored bg
 *   - Inactive tab: muted gray rail, dimmed text, slightly transparent bg
 *   - meta is expected to be live — callers pass computed values that
 *     re-render as underlying state changes (e.g. "live · 24 events")
 *   - Each tab owns its content; this component only provides the header
 *     row and the hidden/visible toggling
 */

import { useState } from "react";

export interface SectionTabDef {
  id: string;
  eyebrow: string;
  title: string;
  meta?: string;
  /** Optional small icon shown before the title. */
  icon?: React.ReactNode;
  /** Tab body. Pass a ReactNode for static content (state preserved via
   *  CSS hide), or a render function receiving `active: boolean` when
   *  the content holds an expensive resource (SSE, WebSocket, timers)
   *  that should pause while the tab is hidden. */
  content: React.ReactNode | ((active: boolean) => React.ReactNode);
}

export default function SectionTabs({
  tabs,
  defaultTabId,
  className = "",
}: {
  tabs: SectionTabDef[];
  defaultTabId?: string;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string>(
    defaultTabId || (tabs[0]?.id ?? ""),
  );

  if (tabs.length === 0) return null;

  // Column layout scales with tab count. Tabs/tailwind need static classes,
  // so we branch on the common cases.
  const gridCols =
    tabs.length === 2
      ? "grid-cols-1 md:grid-cols-2"
      : tabs.length === 3
      ? "grid-cols-1 md:grid-cols-3"
      : tabs.length === 4
      ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
      : "grid-cols-1 md:grid-cols-3";

  return (
    <div className={className}>
      {/* Tab row — row of section-header buttons */}
      <div
        role="tablist"
        aria-orientation="horizontal"
        className={`grid ${gridCols} gap-3 mb-4`}
      >
        {tabs.map((tab) => (
          <SectionTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onClick={() => setActiveId(tab.id)}
          />
        ))}
      </div>

      {/* Tab content — ALL tabs rendered, non-active hidden via CSS.
          This preserves scroll positions and in-flight state across
          switches. Tabs whose content is a render function receive an
          `active` flag so live resources (SSE, sockets, timers) can
          release while hidden — see LiveQueryFeedPanel. */}
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const body =
          typeof tab.content === "function" ? tab.content(active) : tab.content;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            hidden={!active}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}

function SectionTabButton({
  tab,
  active,
  onClick,
}: {
  tab: SectionTabDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${tab.id}`}
      aria-selected={active}
      onClick={onClick}
      className={`flex items-stretch gap-3 p-3.5 rounded-lg text-left transition-colors min-h-[60px] ${
        active
          ? "bg-th-panel border border-th-line shadow-[0_0_18px_rgba(34,197,94,0.04)]"
          : "bg-th-panel/30 border border-th-line/40 hover:bg-th-panel/60 hover:border-th-line"
      }`}
    >
      {/* Left accent rail — matches the SectionHeader pattern exactly */}
      <div
        className={`w-[3px] rounded-full shrink-0 transition-colors ${
          active ? "bg-th-primary" : "bg-th-text-muted/20"
        }`}
      />

      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div
          className={`text-[9.5px] uppercase tracking-[0.18em] font-mono transition-colors flex items-center gap-1.5 ${
            active ? "text-th-text-muted" : "text-th-text-muted/50"
          }`}
        >
          {tab.icon}
          {tab.eyebrow}
        </div>
        <div
          className={`text-[14px] font-semibold leading-tight mt-0.5 transition-colors ${
            active ? "text-th-text" : "text-th-text-muted/80"
          }`}
        >
          {tab.title}
          {tab.meta && (
            <span
              className={`ml-2 text-[11px] font-mono font-normal transition-colors ${
                active ? "text-th-text-muted" : "text-th-text-muted/50"
              }`}
            >
              {tab.meta}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
