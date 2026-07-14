import React from "react";

const SIZES = {
  sm: { w: 30, h: 18, knob: 12 },
  md: { w: 38, h: 22, knob: 16 },
};

/** Switch — instant on/off toggle for settings. Controlled or uncontrolled. */
export function Switch({ checked, defaultChecked, onChange, disabled, size = "md", label, id, style, ...rest }) {
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(Boolean(defaultChecked));
  const on = isControlled ? checked : internal;
  const autoId = React.useId();
  const fieldId = id || autoId;
  const s = SIZES[size] || SIZES.md;

  const toggle = (e) => { if (!isControlled) setInternal(e.target.checked); onChange?.(e); };

  const track = (
    <span style={{
      position: "relative", flexShrink: 0, width: s.w, height: s.h,
      borderRadius: "var(--radius-full)",
      background: on ? "var(--action)" : "var(--neutral-300)",
      border: "1px solid " + (on ? "var(--action)" : "var(--border-strong)"),
      transition: "background var(--dur-base) var(--ease-out), border-color var(--dur-base)",
    }}>
      <input type="checkbox" role="switch" id={fieldId} checked={isControlled ? checked : undefined}
        defaultChecked={isControlled ? undefined : defaultChecked}
        disabled={disabled} onChange={toggle}
        style={{ position: "absolute", opacity: 0, inset: 0, margin: 0, cursor: "inherit" }} {...rest} />
      <span style={{
        position: "absolute", top: "50%", left: 2, width: s.knob, height: s.knob,
        borderRadius: "var(--radius-full)", background: on ? "var(--action-fg)" : "var(--surface)",
        boxShadow: "var(--shadow-sm)",
        transform: `translateY(-50%) translateX(${on ? s.w - s.knob - 4 : 0}px)`,
        transition: "transform var(--dur-base) var(--ease-out), background var(--dur-base)",
      }} />
    </span>
  );

  if (!label) {
    return <label htmlFor={fieldId} style={{ display: "inline-flex", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style }}>{track}</label>;
  }
  return (
    <label htmlFor={fieldId} style={{
      display: "inline-flex", alignItems: "center", gap: "var(--space-3)",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style,
    }}>
      {track}
      <span style={{ fontSize: "var(--text-base)", color: "var(--text)" }}>{label}</span>
    </label>
  );
}
