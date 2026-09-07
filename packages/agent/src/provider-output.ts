const HIDDEN_TAGS = ["thinking", "reasoning", "think", "\uff5cDSML\uff5cfunction_calls"];

/** Filters text-embedded provider protocol before any visible delta escapes. */
export class ProviderOutputFilter {
  private pending = "";
  private hidden: string[] = [];
  private code: string | null = null;
  private started: boolean;

  constructor(private readonly stripMarkup: boolean, trimLeading = true) {
    this.started = !trimLeading;
  }

  push(text: string): string {
    this.pending += text;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (this.pending) {
      if (this.stripMarkup && this.pending[0] === "<" && !this.code) {
        const lower = this.pending.toLowerCase();
        const markers = HIDDEN_TAGS.flatMap((tag) => [
          { text: `<${tag}>`.toLowerCase(), tag, close: false },
          { text: `</${tag}>`.toLowerCase(), tag, close: true },
        ]);
        const match = markers.find((marker) => lower.startsWith(marker.text));
        if (match) {
          this.pending = this.pending.slice(match.text.length);
          if (match.close) {
            if (this.hidden.at(-1) === match.tag) this.hidden.pop();
          } else {
            this.hidden.push(match.tag);
          }
          continue;
        }
        if (markers.some((marker) => marker.text.startsWith(lower))) {
          // An incomplete protocol marker must not flash into the UI.
          if (!final) break;
          if (lower !== "<") {
            this.pending = "";
            break;
          }
        }
      }
      if (this.hidden.length) {
        this.pending = this.pending.slice(1);
        continue;
      }
      if (this.stripMarkup && /^[`~]/.test(this.pending)) {
        const delimiter = this.pending.match(/^(`+|~+)/)![0];
        if (delimiter.length === this.pending.length && !final) break;
        if (!this.code && (delimiter[0] === "`" || delimiter.length >= 3)) {
          this.code = delimiter;
        } else if (
          this.code && delimiter[0] === this.code[0] &&
          delimiter.length >= this.code.length
        ) {
          this.code = null;
        }
        output += delimiter;
        this.started = true;
        this.pending = this.pending.slice(delimiter.length);
        continue;
      }
      const char = this.pending[0]!;
      this.pending = this.pending.slice(1);
      if (!this.started && /\s/.test(char)) continue;
      this.started = true;
      output += char;
    }
    return output;
  }
}
