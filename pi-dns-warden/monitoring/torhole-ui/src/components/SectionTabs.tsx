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

import { useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { useSearchParams } from "react-router-dom";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedId = searchParams.get("section");
  const initialId = tabs.some((tab) => tab.id === requestedId)
    ? requestedId!
    : defaultTabId || (tabs[0]?.id ?? "");
  const [activeId, setActiveId] = useState<string>(initialId);

  useEffect(() => {
    if (requestedId && tabs.some((tab) => tab.id === requestedId)) {
      setActiveId(requestedId);
    }
  }, [requestedId, tabs]);

  const selectTab = (id: string) => {
    setActiveId(id);
    const next = new URLSearchParams(searchParams);
    next.set("section", id);
    setSearchParams(next, { replace: true });
  };

  if (tabs.length === 0) return null;

  // Column layout scales with tab count. Tabs/tailwind need static classes,
  // so we branch on the common cases.
  const gridCols =
    tabs.length === 2
      ? "grid-cols-1 md:grid-cols-2"
      : tabs.length === 3
      ? "grid-cols-1 md:grid-cols-3"
      : tabs.length === 4
      ? "grid-cols-1 md:grid-cols-2 2xl:grid-cols-4"
      : "grid-cols-1 md:grid-cols-3";

  return (
    <div className={className}>
      <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
        <div className="text-[9.5px] font-mono uppercase tracking-[0.18em] text-th-text-muted/70">
          Choose a view
        </div>
        <div className="hidden text-[10px] font-mono text-th-text-muted/55 sm:block">
          Select a card to open its controls
        </div>
      </div>
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
            onClick={() => selectTab(tab.id)}
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
      className={`group relative flex min-h-[74px] cursor-pointer items-center gap-3 overflow-hidden rounded-lg border px-3.5 py-3 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-th-bg ${
        active
          ? "border-th-primary/55 bg-th-primary/[0.07] shadow-[0_0_24px_rgba(34,197,94,0.09)]"
          : "border-th-line/70 bg-th-panel/65 shadow-sm hover:-translate-y-0.5 hover:border-th-primary/45 hover:bg-th-panel hover:shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
      }`}
    >
      <div className={`absolute inset-y-0 left-0 w-[3px] transition-colors ${active ? "bg-th-primary" : "bg-th-text-muted/20 group-hover:bg-th-primary/60"}`} />

      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-all ${
          active
            ? "border-th-primary/45 bg-th-primary/15 text-th-primary"
            : "border-th-line bg-th-bg/50 text-th-text-muted group-hover:border-th-primary/35 group-hover:text-th-primary"
        }`}
      >
        {tab.icon}
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div
          className={`text-[9.5px] uppercase tracking-[0.18em] font-mono transition-colors flex items-center gap-1.5 ${
            active ? "text-th-text-muted" : "text-th-text-muted/50"
          }`}
        >
          {tab.eyebrow}
        </div>
        <div
          className={`text-[14px] font-semibold leading-tight mt-0.5 transition-colors ${
            active ? "text-th-text" : "text-th-text/90 group-hover:text-th-text"
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

      <div
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[8.5px] font-mono uppercase tracking-[0.13em] transition-all ${
          active
            ? "border-th-primary/40 bg-th-primary/12 text-th-primary"
            : "border-th-line/80 bg-th-bg/35 text-th-text-muted/70 group-hover:border-th-primary/35 group-hover:text-th-primary"
        }`}
      >
        {active ? <Check size={10} strokeWidth={2.5} /> : <ArrowRight size={10} />}
        {active ? "viewing" : "open"}
      </div>
    </button>
  );
}
