import React from "react";

const SIZES = {
  sm: { height: "var(--control-h-sm)", fontSize: "var(--text-sm)" },
  md: { height: "var(--control-h-md)", fontSize: "var(--text-base)" },
  lg: { height: "var(--control-h-lg)", fontSize: "var(--text-md)" },
};

/** Select — native dropdown styled to match the form family, with a custom chevron. */
export function Select({ label, hint, error, options = [], placeholder, size = "md", id, style, disabled, children, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const autoId = React.useId();
  const fieldId = id || autoId;
  const invalid = Boolean(error);
  const s = SIZES[size] || SIZES.md;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%" }}>
      {label && (
        <label htmlFor={fieldId} style={{
          fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)",
          fontWeight: "var(--fw-medium)", color: "var(--text)",
        }}>{label}</label>
      )}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <select
          id={fieldId}
          disabled={disabled}
          aria-invalid={invalid}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            appearance: "none", WebkitAppearance: "none",
            width: "100%", height: s.height,
            padding: "0 var(--space-8) 0 var(--space-3)",
            background: disabled ? "var(--surface-inset)" : "var(--surface)",
            border: `1px solid ${invalid ? "var(--danger)" : focus ? "var(--border-focus)" : "var(--border-strong)"}`,
            borderRadius: "var(--radius-sm)",
            boxShadow: focus && !invalid ? "var(--shadow-focus)" : "var(--shadow-xs)",
            outline: "none",
            fontFamily: "var(--font-sans)", fontSize: s.fontSize, color: "var(--text)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
            ...style,
          }}
          {...rest}
        >
          {placeholder && <option value="" disabled>{placeholder}</option>}
          {children ?? options.map((o) => {
            const opt = typeof o === "string" ? { value: o, label: o } : o;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ position: "absolute", right: "var(--space-3)", pointerEvents: "none" }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {(hint || error) && (
        <span style={{ fontSize: "var(--text-xs)", color: invalid ? "var(--danger)" : "var(--text-subtle)" }}>
          {error || hint}
        </span>
      )}
    </div>
  );
}
