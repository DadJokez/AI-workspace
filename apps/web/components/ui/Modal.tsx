"use client";

import { useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Optional action row at the bottom (buttons). */
  actions?: React.ReactNode;
}

export function Modal({ open, onClose, title, children, actions }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "modal-title" : undefined}
      >
        {title ? (
          <div className="border-b border-zinc-200/80 px-5 py-3 dark:border-zinc-800/80">
            <h2
              id="modal-title"
              className="text-sm font-medium text-zinc-900 dark:text-zinc-100"
            >
              {title}
            </h2>
          </div>
        ) : null}
        <div className="px-5 py-4 text-sm text-zinc-600 dark:text-zinc-400">
          {children}
        </div>
        {actions ? (
          <div className="flex justify-end gap-2 border-t border-zinc-200/80 px-5 py-3 dark:border-zinc-800/80">
            {actions}
          </div>
        ) : (
          <div className="flex justify-end px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Got it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
