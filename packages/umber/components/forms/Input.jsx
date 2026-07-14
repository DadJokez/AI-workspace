import React from "react";

const SIZES = {
  sm: { height: "var(--control-h-sm)", fontSize: "var(--text-sm)", padding: "0 var(--space-3)" },
  md: { height: "var(--control-h-md)", fontSize: "var(--text-base)", padding: "0 var(--space-3)" },
  lg: { height: "var(--control-h-lg)", fontSize: "var(--text-md)", padding: "0 var(--space-4)" },
};

/** Input — single-line text field with optional leading icon, label, hint & error. */
export function Input({
  label,
  hint,
  error,
  size = "md",
  iconLeft,
  prefix,
  id,
  style,
  disabled,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
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
      <div style={{
        display: "flex", alignItems: "center", gap: "var(--space-2)",
        height: s.height, padding: s.padding,
        background: disabled ? "var(--surface-inset)" : "var(--surface)",
        border: `1px solid ${invalid ? "var(--danger)" : focus ? "var(--border-focus)" : "var(--border-strong)"}`,
        borderRadius: "var(--radius-sm)",
        boxShadow: focus && !invalid ? "var(--shadow-focus)" : "var(--shadow-xs)",
        transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
        opacity: disabled ? 0.6 : 1,
      }}>
        {iconLeft && <span style={{ display: "inline-flex", color: "var(--text-subtle)" }}>{iconLeft}</span>}
        {prefix && <span style={{ color: "var(--text-subtle)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>{prefix}</span>}
        <input
          id={fieldId}
          disabled={disabled}
          aria-invalid={invalid}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
            fontFamily: "var(--font-sans)", fontSize: s.fontSize, color: "var(--text)",
            letterSpacing: "var(--tracking-snug)",
            ...style,
          }}
          {...rest}
        />
      </div>
      {(hint || error) && (
        <span style={{
          fontSize: "var(--text-xs)",
          color: invalid ? "var(--danger)" : "var(--text-subtle)",
        }}>{error || hint}</span>
      )}
    </div>
  );
}
