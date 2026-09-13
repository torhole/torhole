/*
 * Compact section navigation shared by Privacy, Operate, and Configure.
 * Content stays mounted when hidden to preserve in-flight state.
 * Render-function content receives an active flag to pause live resources.
 */

import { useEffect, useState } from "react";
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

  return (
    <div className={className}>
      {/* One compact row, horizontally scrollable when space is limited. */}
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex gap-1 overflow-x-auto border-b border-th-line mb-4"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === activeId}
            onClick={() => selectTab(tab.id)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap min-h-10 px-3 text-xs border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-primary ${tab.id === activeId ? "border-th-primary text-th-primary font-semibold" : "border-transparent text-th-text-muted hover:text-th-text"}`}
          >{tab.icon}{tab.title}</button>
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
