export function escapeBareOrderedListMarkers(content: string): string {
  let inFence = false;
  let activeFenceChar: "`" | "~" | null = null;

  return content
    .split("\n")
    .map((line) => {
      const fence = /^ {0,3}(```+|~~~+)/.exec(line);
      if (fence) {
        const fenceChar = fence[1]![0] as "`" | "~";
        if (!inFence) {
          inFence = true;
          activeFenceChar = fenceChar;
        } else if (activeFenceChar === fenceChar) {
          inFence = false;
          activeFenceChar = null;
        }
        return line;
      }

      if (inFence) return line;
      if (!/^ {0,3}\d{1,9}[.)]\s*$/.test(line)) return line;
      return line.replace(/(\d{1,9})([.)])(?=\s*$)/, "$1\\$2");
    })
    .join("\n");
}
