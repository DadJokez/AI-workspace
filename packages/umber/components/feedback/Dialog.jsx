import React from "react";

/**
 * Dialog — a centered modal with scrim, title, body, and footer actions.
 * Controlled via `open` / `onClose`. Closes on scrim click and Escape.
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 460, style }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div onMouseDown={onClose} style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "var(--space-6)",
      background: "rgba(17, 14, 10, 0.42)",
      backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
      animation: "umber-fade 160ms var(--ease-out)",
    }}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: width,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-lg)",
        overflow: "hidden",
        animation: "umber-pop 200ms var(--ease-out)",
        ...style,
      }}>
        <div style={{ padding: "var(--space-5) var(--space-5) 0" }}>
          {title && <div style={{ fontSize: "var(--text-lg)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--tracking-snug)", color: "var(--text)" }}>{title}</div>}
          {description && <div style={{ marginTop: "var(--space-1)", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{description}</div>}
        </div>
        <div style={{ padding: "var(--space-4) var(--space-5)", fontSize: "var(--text-base)", color: "var(--text)", lineHeight: "var(--leading-normal)" }}>
          {children}
        </div>
        {footer && (
          <div style={{
            display: "flex", justifyContent: "flex-end", gap: "var(--space-3)",
            padding: "var(--space-4) var(--space-5)",
            borderTop: "1px solid var(--border)", background: "var(--surface-2)",
          }}>{footer}</div>
        )}
        <style>{"@keyframes umber-fade{from{opacity:0}to{opacity:1}}@keyframes umber-pop{from{opacity:0;transform:translateY(6px) scale(0.98)}to{opacity:1;transform:none}}"}</style>
      </div>
    </div>
  );
}
