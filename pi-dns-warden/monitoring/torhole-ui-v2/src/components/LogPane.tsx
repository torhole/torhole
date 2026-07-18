/*
 * LogPane — slide-over container log viewer.
 *
 * Subscribes to GET /api/containers/{name}/logs (SSE stream), buffers the
 * last N lines in memory, auto-scrolls to bottom unless paused, and lets
 * the operator close or clear the pane.
 *
 * The pane is fixed-position, slides in from the right edge, takes ~55%
 * of the viewport width on desktop and full-width on narrower screens.
 * Click the backdrop or the close button to dismiss.
 */

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2, X } from "lucide-react";

const MAX_LINES = 600;

interface LogEvent {
  line: string;
  container: string;
}

export default function LogPane({
  containerName,
  onClose,
}: {
  containerName: string | null;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LogEvent[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Open/close the EventSource with the selected container.
  useEffect(() => {
    if (!containerName) {
      setLines([]);
      setStatus("connecting");
      setPaused(false);
      return;
    }
    setLines([]);
    setStatus("connecting");

    const url = `/api/containers/${encodeURIComponent(containerName)}/logs`;
    const es = new EventSource(url, { withCredentials: true });
    let cancelled = false;

    es.onopen = () => {
      if (!cancelled) setStatus("open");
    };
    es.onerror = () => {
      if (!cancelled) setStatus("closed");
    };
    es.onmessage = (msg) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(msg.data) as LogEvent;
        setLines((prev) => {
          const next = prev.concat(data);
          if (next.length > MAX_LINES) {
            next.splice(0, next.length - MAX_LINES);
          }
          return next;
        });
      } catch {
        // Drop malformed events silently.
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [containerName]);

  // When not paused, mirror the live buffer. When paused, freeze what we have.
  useEffect(() => {
    if (!paused) setFrozen(lines);
  }, [lines, paused]);

  // Auto-scroll to bottom when new lines arrive, unless paused.
  useEffect(() => {
    if (paused) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frozen, paused]);

  // Escape closes the pane.
  useEffect(() => {
    if (!containerName) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [containerName, onClose]);

  if (!containerName) return null;

  const statusLabel =
    status === "open"
      ? "streaming"
      : status === "connecting"
      ? "connecting"
      : "disconnected";
  const statusDot =
    status === "open"
      ? "bg-th-primary animate-pulse"
      : status === "connecting"
      ? "bg-th-warning"
      : "bg-th-danger";

  return (
    <div
      className="fixed inset-0 z-40 flex"
      aria-modal="true"
      role="dialog"
      aria-label={`Logs for ${containerName}`}
    >
      {/* Backdrop — click to close */}
      <div
        className="flex-1 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Slide-over pane */}
      <div className="w-full md:w-[55%] lg:w-[60%] xl:max-w-[1000px] bg-th-panel border-l border-th-line shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-th-line/60 bg-th-bg/40">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-th-text-muted">
              {statusLabel}
            </span>
          </div>
          <div className="text-[13px] font-semibold text-th-text flex-1 min-w-0 truncate">
            <span className="text-th-text-muted font-mono">docker logs -f </span>
            <span className="font-mono text-th-text-mono">{containerName}</span>
          </div>
          <div className="text-[10px] font-mono text-th-text-muted">
            {frozen.length} lines
            {paused && " · paused"}
          </div>
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 rounded text-[10px] font-mono uppercase tracking-[0.14em] min-h-[36px] bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-text hover:border-th-primary/40 transition-colors"
          >
            {paused ? <Play size={11} /> : <Pause size={11} />}
            {paused ? "resume" : "pause"}
          </button>
          <button
            type="button"
            onClick={() => setLines([])}
            className="flex items-center gap-1.5 px-2.5 rounded text-[10px] font-mono uppercase tracking-[0.14em] min-h-[36px] bg-th-bg/60 border border-th-line text-th-text-muted hover:text-th-danger hover:border-th-danger/40 transition-colors"
            title="Clear local buffer"
          >
            <Trash2 size={11} />
            clear
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-md flex items-center justify-center text-th-text-muted hover:text-th-text hover:bg-th-line/40 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Terminal pane */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto bg-th-bg/60 font-mono text-[11px] leading-[1.5]"
          style={{ scrollbarWidth: "thin" }}
        >
          {frozen.length === 0 ? (
            <div className="px-4 py-6 text-th-text-muted/60">
              {status === "connecting"
                ? "connecting to log stream…"
                : status === "closed"
                ? "log stream disconnected · reopen the pane to retry"
                : "waiting for output…"}
            </div>
          ) : (
            <div className="px-4 py-3 whitespace-pre-wrap break-words">
              {frozen.map((evt, i) => (
                <LogLine key={`${evt.container}-${i}`} line={evt.line} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  // docker logs --timestamps prefixes each line with an RFC3339Nano stamp,
  // e.g. "2026-04-11T02:30:45.123456Z <rest>". Split it so we can style
  // the timestamp separately from the payload.
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/);
  if (!m) {
    return <div className="text-th-text-mono">{line || "\u00a0"}</div>;
  }
  const [, ts, rest] = m;
  // Render only HH:MM:SS from the timestamp to save horizontal space.
  const time = ts.slice(11, 19);
  return (
    <div>
      <span className="text-th-text-muted/40">{time}</span>{" "}
      <span className="text-th-text-mono">{rest || "\u00a0"}</span>
    </div>
  );
}
