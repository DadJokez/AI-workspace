import React from "react";

/**
 * RadioGroup + Radio — single-choice selection.
 * Use RadioGroup for state; Radio renders one option.
 */
export function RadioGroup({ value, defaultValue, onChange, name, options, children, style }) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue);
  const current = isControlled ? value : internal;
  const autoName = React.useId();
  const groupName = name || autoName;

  const select = (v) => { if (!isControlled) setInternal(v); onChange?.(v); };

  const rendered = options
    ? options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return <Radio key={opt.value} value={opt.value} label={opt.label} description={opt.description}
          checked={current === opt.value} name={groupName} onSelect={select} disabled={opt.disabled} />;
      })
    : React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { checked: current === child.props.value, name: groupName, onSelect: select })
          : child);

  return <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", ...style }}>{rendered}</div>;
}

export function Radio({ value, label, description, checked, name, onSelect, disabled, style }) {
  const [hover, setHover] = React.useState(false);
  const id = React.useId();
  return (
    <label htmlFor={id} style={{
      display: "inline-flex", alignItems: "flex-start", gap: "var(--space-3)",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style,
    }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{
        position: "relative", flexShrink: 0, width: "18px", height: "18px", marginTop: "1px",
        borderRadius: "var(--radius-full)",
        background: "var(--surface)",
        border: `1.5px solid ${checked ? "var(--action)" : hover && !disabled ? "var(--border-focus)" : "var(--border-strong)"}`,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        transition: "border-color var(--dur-fast) var(--ease-out)",
      }}>
        <input type="radio" id={id} value={value} name={name} checked={checked} disabled={disabled}
          onChange={() => onSelect?.(value)}
          style={{ position: "absolute", opacity: 0, inset: 0, margin: 0, cursor: "inherit" }} />
        <span style={{
          width: "9px", height: "9px", borderRadius: "var(--radius-full)", background: "var(--action)",
          opacity: checked ? 1 : 0, transform: checked ? "scale(1)" : "scale(0.4)",
          transition: "opacity var(--dur-fast), transform var(--dur-fast) var(--ease-out)",
        }} />
      </span>
      {(label || description) && (
        <span style={{ display: "flex", flexDirection: "column", gap: "2px", lineHeight: "var(--leading-snug)" }}>
          {label && <span style={{ fontSize: "var(--text-base)", color: "var(--text)" }}>{label}</span>}
          {description && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-subtle)" }}>{description}</span>}
        </span>
      )}
    </label>
  );
}
