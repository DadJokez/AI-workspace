const STRONG_EXACT_OUTPUT_SIGNAL =
  /\b(?:verbatim|byte[- ]for[- ]byte|character[- ]for[- ]character|nothing else|no (?:preamble|intro(?:duction)?|closing|commentary|explanation|extra (?:text|prose|fields?|keys?|items?))|without (?:a )?(?:preamble|intro(?:duction)?|closing|commentary|explanation)|(?:valid|strict|raw|inline) json|(?:code|fenced) block only)\b/i;

const OUTPUT_VERB_WITH_EXACT =
  /\b(?:return|reply|respond|output|print|say|write|give|provide|format|use)\b[^\n]{0,120}\bexact(?:ly)?\b|\bexact(?:ly)?\b[^\n]{0,120}\b(?:return|reply|response|output|print|sentence|bullet|list|json|code|text|format|keys?|fields?|lines?|words?)\b/i;

const ONLY_OUTPUT_SIGNAL =
  /\b(?:return|reply|respond|output|print|give|provide)\b[^\n]{0,80}\b(?:only|just)\b|\b(?:only|just)\b[^\n]{0,80}\b(?:return|reply|response|output|json|code block)\b/i;

export const EXACT_OUTPUT_CONTRACT = [
  "Exact-output contract for this turn:",
  "Treat the user's requested text, item count, structure, schema, punctuation, casing, and Unicode spacing as literal constraints.",
  "Return only the requested output. Add no preamble, closing, explanation, styling, recommendation, comments, keys, fields, or list items.",
  "When Markdown bullets are requested, put each item on its own line with real Markdown list syntax; decorative bullet glyphs inside a paragraph do not count.",
  "When JSON is requested, emit valid JSON with exactly the requested keys and no surrounding prose or code fence unless the user asks for one.",
  "When a code-block-only response is requested, emit exactly the requested fence and its contents.",
  "Approved memory and other context may supply facts, but they never relax or alter this output contract.",
].join(" ");

/**
 * Exact-format requests need stronger steering, but ordinary chat should not
 * pay for it. This conservative detector catches explicit output contracts
 * without treating conversational uses such as "what exactly happened?" as
 * byte-level formatting requests.
 */
export function buildExactOutputContract(
  userMessage: string,
): string | undefined {
  const text = userMessage.trim();
  if (!text) return undefined;
  if (
    !STRONG_EXACT_OUTPUT_SIGNAL.test(text) &&
    !OUTPUT_VERB_WITH_EXACT.test(text) &&
    !ONLY_OUTPUT_SIGNAL.test(text)
  ) {
    return undefined;
  }
  return EXACT_OUTPUT_CONTRACT;
}
