interface Props {
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  pending?: boolean;
}

export function MessageBubble({ role, content, modelId, pending }: Props) {
  if (role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[80%] rounded-lg bg-subtle px-3.5 py-2 text-[14px] leading-relaxed text-ink whitespace-pre-wrap">
          {content}
        </div>
      </div>
    );
  }

  const label =
    role === "tool" ? "Tool" : modelId ? `Assistant · ${modelId}` : "Assistant";
  const labelColor = role === "tool" ? "text-muted" : "text-muted";

  return (
    <div className="flex w-full flex-col gap-1">
      <div className={`text-[11px] font-medium tracking-wide ${labelColor}`}>
        {label}
      </div>
      <div className="text-[14px] leading-relaxed text-ink whitespace-pre-wrap">
        {content}
        {pending ? (
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[1px] animate-pulse bg-current align-baseline" />
        ) : null}
      </div>
    </div>
  );
}
