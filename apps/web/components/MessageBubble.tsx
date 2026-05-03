import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  pending?: boolean;
}

export function MessageBubble({ role, content, modelId, pending }: Props) {
  if (role === "user") {
    return (
      <div className="flex w-full min-w-0 justify-end">
        <div className="max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-subtle px-3.5 py-2 text-[14px] leading-relaxed text-ink">
          {content}
        </div>
      </div>
    );
  }

  const label =
    role === "tool" ? "Tool" : modelId ? `Assistant · ${modelId}` : "Assistant";

  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="text-[11px] font-medium tracking-wide text-muted">
        {label}
      </div>
      <div className="min-w-0 max-w-full overflow-hidden break-words text-[14px] leading-relaxed text-ink">
        {role === "assistant" ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={MARKDOWN_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
        {pending ? (
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[1px] animate-pulse bg-current align-baseline" />
        ) : null}
      </div>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: (props) => (
    <h1
      className="my-2 text-base font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  h2: (props) => (
    <h2
      className="my-2 text-base font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  h3: (props) => (
    <h3
      className="my-2 text-sm font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  ul: (props) => (
    <ul className="my-2 list-disc pl-5 first:mt-0 last:mb-0" {...props} />
  ),
  ol: (props) => (
    <ol className="my-2 list-decimal pl-5 first:mt-0 last:mb-0" {...props} />
  ),
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => (
    <a className="underline" target="_blank" rel="noreferrer" {...props} />
  ),
  pre: (props) => (
    <pre
      className="my-2 overflow-x-auto rounded bg-subtle p-2 font-mono text-[12px] first:mt-0 last:mb-0"
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
        className="rounded bg-subtle px-1 py-0.5 font-mono text-[12px]"
        {...rest}
      >
        {children}
      </code>
    );
  },
};
