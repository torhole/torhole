/*
 * ConfirmModal — type-to-confirm gate for destructive operations.
 *
 * Rule from docs/admin-redesign.md §4.3: any irreversible operation in the
 * admin UI (backup delete, backup restore, future bulk container stop, …) must
 * require typing a verb (DELETE / RESTORE / FORCE) or the resource name
 * into an input before the destructive button enables. Not a yes/no dialog.
 * The point is friction: make the operator stop and type, not click-through.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <ConfirmModal
 *     open={open}
 *     title="Delete backup"
 *     body={`This permanently deletes ${backup.name}. Cannot be undone.`}
 *     confirmWord="DELETE"
 *     confirmLabel="Delete backup"
 *     kind="danger"
 *     onCancel={() => setOpen(false)}
 *     onConfirm={async () => { await apiCall(); setOpen(false); }}
 *   />
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export type ConfirmKind = "danger" | "warning";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  /** The word the operator must type to enable the confirm button. */
  confirmWord: string;
  /** Label for the confirm button (defaults to the confirmWord). */
  confirmLabel?: string;
  /** Visual severity — picks the icon and button color. */
  kind?: ConfirmKind;
  onCancel: () => void;
  /** Called when the operator clicks confirm. May be async; the modal
   *  shows a loading state while the promise resolves. */
  onConfirm: () => void | Promise<void>;
}

export default function ConfirmModal({
  open,
  title,
  body,
  confirmWord,
  confirmLabel,
  kind = "danger",
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset when reopened.
  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setRunning(false);
      // Focus the input after the modal mounts.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, running, onCancel]);

  if (!open) return null;

  const matches = typed === confirmWord;
  const accent = kind === "danger" ? "danger" : "warning";

  const handleConfirm = async () => {
    if (!matches || running) return;
    setRunning(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="w-full max-w-lg bg-th-panel border border-th-line rounded-lg shadow-2xl overflow-hidden"
      >
        <div
          className={`flex items-start gap-3 px-5 py-4 border-b ${
            accent === "danger"
              ? "border-th-danger/40 bg-th-danger/[0.04]"
              : "border-th-warning/40 bg-th-warning/[0.04]"
          }`}
        >
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              accent === "danger"
                ? "bg-th-danger/15 text-th-danger"
                : "bg-th-warning/15 text-th-warning"
            }`}
          >
            <AlertTriangle size={16} strokeWidth={2.4} />
          </div>
          <div className="flex-1 min-w-0">
            <div
              id="confirm-modal-title"
              className={`text-[15px] font-semibold ${
                accent === "danger" ? "text-th-danger" : "text-th-warning"
              }`}
            >
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={running}
            aria-label="Close"
            className="w-7 h-7 rounded flex items-center justify-center text-th-text-muted hover:text-th-text hover:bg-th-line/40 transition-colors disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="text-[12.5px] text-th-text leading-relaxed mb-4">{body}</div>

          <label className="block text-[10px] uppercase tracking-[0.14em] text-th-text-muted font-mono mb-2">
            Type{" "}
            <span className={accent === "danger" ? "text-th-danger" : "text-th-warning"}>
              {confirmWord}
            </span>{" "}
            to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches) handleConfirm();
            }}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            className={`w-full px-3 py-2.5 bg-th-bg/60 border rounded-md text-[13px] font-mono text-th-text-mono outline-none transition-colors disabled:opacity-50 ${
              matches
                ? accent === "danger"
                  ? "border-th-danger/50 focus:border-th-danger"
                  : "border-th-warning/50 focus:border-th-warning"
                : "border-th-line focus:border-th-primary/40"
            }`}
            placeholder={confirmWord}
          />

          {error && (
            <div className="mt-3 flex items-start gap-2 p-2 bg-th-danger/10 border border-th-danger/30 rounded text-[11px] text-th-danger font-mono">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-th-line/60 bg-th-bg/40">
          <button
            type="button"
            onClick={onCancel}
            disabled={running}
            className="px-3 py-2 rounded-md text-[11.5px] font-mono uppercase tracking-[0.14em] text-th-text-muted hover:text-th-text hover:bg-th-line/30 transition-colors min-h-[44px] disabled:opacity-40"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!matches || running}
            className={`ml-auto px-4 py-2 rounded-md text-[11.5px] font-mono uppercase tracking-[0.14em] min-h-[44px] transition-colors ${
              !matches
                ? "bg-th-bg/60 border border-th-line text-th-text-muted/40 cursor-not-allowed"
                : running
                ? "bg-th-bg/60 border border-th-line text-th-text-muted cursor-wait"
                : accent === "danger"
                ? "bg-th-danger/15 border border-th-danger/40 text-th-danger hover:bg-th-danger/25"
                : "bg-th-warning/15 border border-th-warning/40 text-th-warning hover:bg-th-warning/25"
            }`}
          >
            {running ? "working…" : confirmLabel || confirmWord.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  );
}
