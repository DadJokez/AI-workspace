import { describe, expect, it } from "vitest";
import { ProviderOutputFilter } from "./provider-output";

function filter(chunks: string[], strip = true) {
  const output = new ProviderOutputFilter(strip);
  return chunks.map((chunk) => output.push(chunk)).join("") + output.finish();
}

describe("provider text boundary", () => {
  const cases = [
    ["  42.", "42."],
    ["<reasoning>private planning</reasoning>\n42.", "42."],
    ["<thinking>private planning</thinking>Ready.", "Ready."],
    ["<think>private planning</think>Ready.", "Ready."],
    ["<reasoning><thinking>nested</thinking>hidden</reasoning>OK", "OK"],
    ["<\uff5cDSML\uff5cfunction_calls><\uff5cDSML\uff5cinvoke name=\"write\">payload</\uff5cDSML\uff5cinvoke></\uff5cDSML\uff5cfunction_calls>Done", "Done"],
    ["Answer.<thinking>hidden</thinking> Next.", "Answer. Next."],
    ["<reasoning>unfinished secret", ""],
    ["<reason", ""],
    ["<div>Visible HTML</div>", "<div>Visible HTML</div>"],
    ["x < y and <", "x < y and <"],
    ["Use `<thinking>` literally.", "Use `<thinking>` literally."],
    ["``<thinking>literal</thinking>``", "``<thinking>literal</thinking>``"],
    ["```html\n<thinking>literal</thinking>\n```", "```html\n<thinking>literal</thinking>\n```"],
    ["~~~html\n<reasoning>literal</reasoning>\n~~~", "~~~html\n<reasoning>literal</reasoning>\n~~~"],
    ["42.\n  indented\n", "42.\n  indented\n"],
  ];
  it.each(cases)("normalizes %j regardless of chunk boundaries", (input, expected) => {
    expect(filter([input!])).toBe(expected);
    expect(filter([...input!])).toBe(expected);
    for (let split = 0; split <= input!.length; split++) {
      expect(filter([input!.slice(0, split), input!.slice(split)])).toBe(expected);
    }
  });
  it("leaves Anthropic markup byte-identical after leading whitespace", () => {
    const text = "<thinking>literal</thinking>\n```html\n<div>Hi</div>\n```\n";
    expect(filter([...text], false)).toBe(text);
  });
  it("never emits partial provider markers or their payload", () => {
    const output = new ProviderOutputFilter(true);
    for (const text of ["<", "reason", "ing>", "private payload", "</reason", "ing>"]) {
      expect(output.push(text)).toBe("");
    }
    expect(output.push("Final answer")).toBe("Final answer");
  });
  it("preserves separators in a continuation after earlier visible output", () => {
    const output = new ProviderOutputFilter(true, false);
    expect(output.push("<thinking>hidden</thinking>\n\nFinal.")).toBe("\n\nFinal.");
  });
});
