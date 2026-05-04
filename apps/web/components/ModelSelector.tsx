"use client";

export interface ModelOption {
  id: string;
  displayName: string;
  blurb: string;
  costPer1MInput: number;
  costPer1MOutput: number;
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  options: readonly ModelOption[];
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, options, disabled }: Props) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span className="hidden sm:inline">Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Model"
        className="max-w-[8rem] rounded-md border border-hairline bg-canvas px-1.5 py-1 text-xs text-ink hover:bg-subtle disabled:opacity-50 focus:outline-none sm:max-w-none sm:py-0.5"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
