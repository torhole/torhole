/*
 * Compact section navigation shared by Privacy, Operate, and Configure.
 * Content stays mounted when hidden to preserve in-flight state.
 * Render-function content receives an active flag to pause live resources.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

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
  scrollOnSelect = false,
  contentReady = true,
  beforePanels,
}: {
  tabs: SectionTabDef[];
  defaultTabId?: string;
  className?: string;
  /** Reveal selected lower-page content, including sidebar links and bookmarks. */
  scrollOnSelect?: boolean;
  contentReady?: boolean;
  /** Shared context between navigation and the selected tool. */
  beforePanels?: React.ReactNode;
}) {
  const { key: navigationKey } = useLocation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState(0);
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

  useLayoutEffect(() => {
    const linkedSection = tabs.some(tab => tab.id === requestedId);
    if (!scrollOnSelect || !contentReady || (selection === 0 && !linkedSection)) return;
    sectionRef.current?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [selection, requestedId, activeId, navigationKey, scrollOnSelect, contentReady]);

  const selectTab = (id: string) => {
    setSelection(value => value + 1);
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
            aria-controls={`panel-${tab.id}`}
            onClick={() => selectTab(tab.id)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap min-h-10 px-3 text-xs border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-primary ${tab.id === activeId ? "border-th-primary text-th-primary font-semibold" : "border-transparent text-th-text-muted hover:text-th-text"}`}
          >{tab.icon}{tab.title}</button>
        ))}
      </div>

      {beforePanels}
      <div ref={sectionRef} className="scroll-mt-4">
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
              id={`panel-${tab.id}`}
              aria-labelledby={`tab-${tab.id}`}
              hidden={!active}
              className={scrollOnSelect ? "min-h-[calc(100dvh-5rem)]" : undefined}
            >
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
