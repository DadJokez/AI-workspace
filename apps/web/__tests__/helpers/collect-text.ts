export interface ReactElementLike {
  type?: unknown;
  props?: Record<string, unknown>;
}

/**
 * Walk the JSX tree returned from a server component (without rendering it)
 * and collect all string content. Server components compose by returning
 * React elements whose `type` is a function — we descend into props.children
 * and also concatenate any string-valued props (so `title`/`message` props
 * passed to ErrorPanel still contribute text).
 */
export function collectText(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  const el = node as ReactElementLike;
  if (typeof el !== "object" || !el.props) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(el.props)) {
    if (key === "children") {
      parts.push(collectText(value));
    } else if (typeof value === "string") {
      parts.push(value);
    }
  }
  return parts.join(" ");
}
