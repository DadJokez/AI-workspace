"use client";

import type { ModelId } from "@ai-workspace/agent";

export interface ModelOption {
  id: ModelId;
  displayName: string;
  blurb: string;
  costPer1MInput: number;
  costPer1MOutput: number;
}

interface Props {
  value: ModelId;
  onChange: (id: ModelId) => void;
  options: readonly ModelOption[];
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, options, disabled }: Props) {
  const selected = options.find((o) => o.id === value);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ModelId)}
        disabled={disabled}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.displayName} — ${opt.costPer1MInput}/${opt.costPer1MOutput} per
            1M
          </option>
        ))}
      </select>
      {selected ? (
        <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">
          {selected.blurb}
        </span>
      ) : null}
    </label>
  );
}
