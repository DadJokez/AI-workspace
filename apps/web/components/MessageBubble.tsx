interface Props {
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  pending?: boolean;
}

export function MessageBubble({ role, content, modelId, pending }: Props) {
  const align = role === "user" ? "items-end" : "items-start";
  const bubbleClass =
    role === "user"
      ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
      : role === "tool"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100";

  return (
    <div className={`flex w-full flex-col gap-1 ${align}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${bubbleClass}`}
      >
        {content}
        {pending ? (
          <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-current align-baseline" />
        ) : null}
      </div>
      {modelId && role === "assistant" ? (
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
          {modelId}
        </span>
      ) : null}
    </div>
  );
}
