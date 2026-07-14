import React from "react";

/** Textarea — multi-line text field, styling matched to Input. */
export function Textarea({ label, hint, error, id, rows = 4, style, disabled, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const autoId = React.useId();
  const fieldId = id || autoId;
  const invalid = Boolean(error);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%" }}>
      {label && (
        <label htmlFor={fieldId} style={{
          fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)",
          fontWeight: "var(--fw-medium)", color: "var(--text)",
        }}>{label}</label>
      )}
      <textarea
        id={fieldId}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          width: "100%", resize: "vertical",
          padding: "var(--space-3)",
          background: disabled ? "var(--surface-inset)" : "var(--surface)",
          border: `1px solid ${invalid ? "var(--danger)" : focus ? "var(--border-focus)" : "var(--border-strong)"}`,
          borderRadius: "var(--radius-sm)",
          boxShadow: focus && !invalid ? "var(--shadow-focus)" : "var(--shadow-xs)",
          outline: "none",
          fontFamily: "var(--font-sans)", fontSize: "var(--text-base)",
          lineHeight: "var(--leading-normal)", color: "var(--text)",
          letterSpacing: "var(--tracking-snug)",
          transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          opacity: disabled ? 0.6 : 1,
          ...style,
        }}
        {...rest}
      />
      {(hint || error) && (
        <span style={{ fontSize: "var(--text-xs)", color: invalid ? "var(--danger)" : "var(--text-subtle)" }}>
          {error || hint}
        </span>
      )}
    </div>
  );
}
