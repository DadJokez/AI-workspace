import React from "react";

/** Checkbox — controlled or uncontrolled, with optional label + description. */
export function Checkbox({ label, description, checked, defaultChecked, disabled, id, onChange, style, ...rest }) {
  const autoId = React.useId();
  const fieldId = id || autoId;
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(Boolean(defaultChecked));
  const on = isControlled ? checked : internal;
  const [hover, setHover] = React.useState(false);

  const handle = (e) => {
    if (!isControlled) setInternal(e.target.checked);
    onChange?.(e);
  };

  return (
    <label htmlFor={fieldId} style={{
      display: "inline-flex", alignItems: "flex-start", gap: "var(--space-3)",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style,
    }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{
        position: "relative", flexShrink: 0, width: "18px", height: "18px", marginTop: "1px",
        borderRadius: "var(--radius-xs)",
        background: on ? "var(--action)" : "var(--surface)",
        border: `1.5px solid ${on ? "var(--action)" : hover && !disabled ? "var(--border-focus)" : "var(--border-strong)"}`,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
      }}>
        <input type="checkbox" id={fieldId} checked={isControlled ? checked : undefined}
          defaultChecked={isControlled ? undefined : defaultChecked}
          disabled={disabled} onChange={handle}
          style={{ position: "absolute", opacity: 0, inset: 0, margin: 0, cursor: "inherit" }} {...rest} />
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--action-fg)" strokeWidth="3.2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ opacity: on ? 1 : 0, transform: on ? "scale(1)" : "scale(0.6)", transition: "opacity var(--dur-fast), transform var(--dur-fast) var(--ease-out)" }}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      {(label || description) && (
        <span style={{ display: "flex", flexDirection: "column", gap: "2px", lineHeight: "var(--leading-snug)" }}>
          {label && <span style={{ fontSize: "var(--text-base)", color: "var(--text)", fontWeight: "var(--fw-regular)" }}>{label}</span>}
          {description && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-subtle)" }}>{description}</span>}
        </span>
      )}
    </label>
  );
}
