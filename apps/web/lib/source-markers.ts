interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

export function remarkSourceMarkers(
  sourceNumbers: readonly number[],
  anchorPrefix: string,
) {
  const validNumbers = new Set(sourceNumbers);
  return () => (tree: MarkdownNode) => {
    transformChildren(tree, validNumbers, anchorPrefix);
  };
}

export function sourceMarkerNodes(
  value: string,
  validNumbers: ReadonlySet<number>,
  anchorPrefix: string,
): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const markerPattern = /\[(\d{1,3})\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markerPattern.exec(value)) !== null) {
    const n = Number(match[1]);
    if (!validNumbers.has(n)) continue;
    if (match.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    nodes.push({
      type: "link",
      url: `#${anchorPrefix}-${n}`,
      children: [{ type: "text", value: `[${n}]` }],
    });
    cursor = match.index + match[0].length;
  }

  if (cursor === 0) return [{ type: "text", value }];
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function transformChildren(
  node: MarkdownNode,
  validNumbers: ReadonlySet<number>,
  anchorPrefix: string,
): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") {
    return;
  }

  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string") {
      return sourceMarkerNodes(child.value, validNumbers, anchorPrefix);
    }
    transformChildren(child, validNumbers, anchorPrefix);
    return [child];
  });
}
