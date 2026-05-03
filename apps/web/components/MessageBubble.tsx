import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
      <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${bubbleClass}`}>
        {role === "assistant" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {content}
          </ReactMarkdown>
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
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

// Tailwind preflight strips browser defaults from h1/ul/strong, so markdown
// would render as a wall of text without explicit classes. Keep the spacing
// tight to fit a chat bubble; first/last children flush to the bubble edges.
const MARKDOWN_COMPONENTS: Components = {
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: (props) => <h1 className="my-2 text-base font-semibold first:mt-0 last:mb-0" {...props} />,
  h2: (props) => <h2 className="my-2 text-base font-semibold first:mt-0 last:mb-0" {...props} />,
  h3: (props) => <h3 className="my-2 text-sm font-semibold first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-2 list-disc pl-5 first:mt-0 last:mb-0" {...props} />,
  ol: (props) => <ol className="my-2 list-decimal pl-5 first:mt-0 last:mb-0" {...props} />,
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => <a className="underline" target="_blank" rel="noreferrer" {...props} />,
  pre: (props) => (
    <pre
      className="my-2 overflow-x-auto rounded bg-black/10 p-2 font-mono text-[12px] first:mt-0 last:mb-0 dark:bg-white/10"
      {...props}
    />
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = !!className && /^language-/.test(className);
    return isBlock ? (
      <code className={className} {...rest}>
        {children}
      </code>
    ) : (
      <code
        className="rounded bg-black/10 px-1 py-0.5 font-mono text-[12px] dark:bg-white/10"
        {...rest}
      >
        {children}
      </code>
    );
  },
};
