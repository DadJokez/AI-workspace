import React from "react";

/**
 * Tabs — a horizontal underline tab bar. Controlled or uncontrolled.
 * Pass `items` ([{value,label,badge}]) plus optional `onChange`.
 */
export function Tabs({ items = [], value, defaultValue, onChange, style }) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? items[0]?.value);
  const current = isControlled ? value : internal;

  const select = (v) => { if (!isControlled) setInternal(v); onChange?.(v); };

  return (
    <div role="tablist" style={{
      display: "flex", gap: "var(--space-5)",
      borderBottom: "1px solid var(--border)",
      ...style,
    }}>
      {items.map((it) => {
        const active = it.value === current;
        return <TabButton key={it.value} item={it} active={active} onSelect={select} />;
      })}
    </div>
  );
}

function TabButton({ item, active, onSelect }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button role="tab" aria-selected={active} onClick={() => onSelect(item.value)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "inline-flex", alignItems: "center", gap: "var(--space-2)",
        padding: "0 0 var(--space-3)",
        marginBottom: "-1px",
        background: "none", border: "none", cursor: "pointer",
        fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)",
        fontWeight: active ? "var(--fw-semibold)" : "var(--fw-medium)",
        letterSpacing: "var(--tracking-snug)",
        color: active ? "var(--text)" : hover ? "var(--text)" : "var(--text-muted)",
        transition: "color var(--dur-fast) var(--ease-out)",
      }}>
      {item.label}
      {item.badge != null && (
        <span style={{
          minWidth: 18, height: 18, padding: "0 5px",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: active ? "var(--action)" : "var(--surface-inset)",
          color: active ? "var(--action-fg)" : "var(--text-muted)",
          border: active ? "none" : "1px solid var(--border)",
          borderRadius: "var(--radius-full)",
          fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", lineHeight: 1,
        }}>{item.badge}</span>
      )}
      <span style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: 2,
        background: active ? "var(--action)" : "transparent",
        borderRadius: "2px 2px 0 0",
        transition: "background var(--dur-fast) var(--ease-out)",
      }} />
    </button>
  );
}
