const STRONG_EXACT_OUTPUT_SIGNAL =
  /\b(?:verbatim|byte[- ]for[- ]byte|character[- ]for[- ]character|nothing else|no (?:preamble|intro(?:duction)?|closing|commentary|explanation|extra (?:text|prose|fields?|keys?|items?))|without (?:a )?(?:preamble|intro(?:duction)?|closing|commentary|explanation)|(?:valid|strict|raw|inline) json|(?:code|fenced) block only)\b/i;

const OUTPUT_VERB_WITH_EXACT =
  /\b(?:return|reply|respond|output|print|say|write|give|provide|format|use)\b[^\n]{0,120}\bexact(?:ly)?\b|\bexact(?:ly)?\b[^\n]{0,120}\b(?:return|reply|response|output|print|sentence|bullet|list|json|code|text|format|keys?|fields?|lines?|words?)\b/i;

const ONLY_OUTPUT_SIGNAL =
  /\b(?:return|reply|respond|output|print|give|provide)\b[^\n]{0,80}\b(?:only|just)\b|\b(?:only|just)\b[^\n]{0,80}\b(?:return|reply|response|output|json|code block)\b/i;

const EXACT_REPLY_DEMAND =
  /\b(?:reply|respond|answer|say)\b(?:\s+back)?(?:\s+with)?\s+exactly(?:\s+with)?\b/i;

// A quoted/backticked literal must END the message: extra clauses after it
// ("… and then summarize") make the demand ambiguous, so nothing is extracted.
const QUOTED_LITERAL_TAIL =
  /^\s*:?\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)\s*[.!]?\s*$/;

const COLON_LITERAL_TAIL = /^\s*:\s*(\S[\s\S]*)$/;

const MEMORY_REQUEST_SIGNAL =
  /\b(?:remember|memori[sz]e|don'?t\s+forget)\b|\b(?:save|store|add)\b[^\n]{0,60}\b(?:memory|vault)\b/i;

export const EXACT_OUTPUT_CONTRACT = [
  "Exact-output contract for this turn:",
  "Treat the user's requested text, item count, structure, schema, punctuation, casing, and Unicode spacing as literal constraints.",
  "Return only the requested output. Add no preamble, closing, explanation, styling, recommendation, comments, keys, fields, or list items.",
  "When Markdown bullets are requested, put each item on its own line with real Markdown list syntax; decorative bullet glyphs inside a paragraph do not count.",
  "When JSON is requested, emit valid JSON with exactly the requested keys and no surrounding prose or code fence unless the user asks for one.",
  "When a code-block-only response is requested, emit exactly the requested fence and its contents.",
  "Approved memory and other context may supply facts, but they never relax or alter this output contract.",
].join(" ");

// Truthful by construction: memory capture is enqueued after every
// successful turn and only produces approval-gated suggestions, so the model
// can obey a demanded literal without claiming or disclaiming a save
// (apps/web/lib/memory-capture.ts).
export const EXACT_OUTPUT_MEMORY_ACK =
  "This turn also asks to remember information: memory capture runs after the turn completes and queues suggestions for the user's later review, so replying with only the demanded text is truthful and neither skips nor confirms the save.";

export interface ExactOutputSpec {
  kind: "literal";
  value: string;
}

export interface ExactOutputContract {
  prose: string;
  /** Present when the demanded reply literal could be extracted verbatim. */
  spec?: ExactOutputSpec;
}

interface DemandedReplyLiteral {
  value: string;
  /** Offset of the demand clause, so callers can see what precedes it. */
  index: number;
  delimiter: "quoted" | "colon";
}

/**
 * A demanded exact reply whose literal is explicitly delimited: quoted,
 * backticked, or everything after a colon. Undelimited tails ("reply exactly
 * ACK and also …") stay unextracted on purpose — only an unambiguous literal
 * may be machine-enforced. List/JSON/code contracts are prompt-prose only
 * for now (#652 follow-up).
 */
function findDemandedReplyLiteral(
  text: string,
): DemandedReplyLiteral | undefined {
  const demand = EXACT_REPLY_DEMAND.exec(text);
  if (!demand) return undefined;
  const tail = text.slice(demand.index + demand[0].length);
  const quoted = QUOTED_LITERAL_TAIL.exec(tail);
  if (quoted) {
    const value = quoted[1] ?? quoted[2] ?? quoted[3];
    return value
      ? { value, index: demand.index, delimiter: "quoted" }
      : undefined;
  }
  const colon = COLON_LITERAL_TAIL.exec(tail);
  if (colon) {
    const value = colon[1]!.trim();
    return value
      ? { value, index: demand.index, delimiter: "colon" }
      : undefined;
  }
  return undefined;
}

/**
 * Exact-format requests need stronger steering, but ordinary chat should not
 * pay for it. This conservative detector catches explicit output contracts
 * without treating conversational uses such as "what exactly happened?" as
 * byte-level formatting requests.
 */
export function buildExactOutputContract(
  userMessage: string,
): ExactOutputContract | undefined {
  const text = userMessage.trim();
  if (!text) return undefined;
  // A demanded reply literal is itself an explicit contract ("Answer
  // exactly: X" uses a verb the broad signals never listed).
  const literal = findDemandedReplyLiteral(text);
  if (
    !literal &&
    !STRONG_EXACT_OUTPUT_SIGNAL.test(text) &&
    !OUTPUT_VERB_WITH_EXACT.test(text) &&
    !ONLY_OUTPUT_SIGNAL.test(text)
  ) {
    return undefined;
  }
  const prose =
    literal && MEMORY_REQUEST_SIGNAL.test(text)
      ? `${EXACT_OUTPUT_CONTRACT} ${EXACT_OUTPUT_MEMORY_ACK}`
      : EXACT_OUTPUT_CONTRACT;
  return {
    prose,
    ...(literal
      ? { spec: { kind: "literal" as const, value: literal.value } }
      : {}),
  };
}

/**
 * When the ENTIRE user message is a single demanded echo ("Reply exactly
 * with \"X\"" and nothing else), returns the literal so the caller can answer
 * deterministically without invoking the model (#644: our own injection
 * hardening refused a benign token echo). Conservative on purpose: any prefix
 * beyond "please", an undelimited literal, or a multi-word colon-delimited
 * tail falls back to the model path.
 */
export function extractPureEchoReply(userMessage: string): string | undefined {
  const text = userMessage.trim();
  if (!text) return undefined;
  const found = findDemandedReplyLiteral(text);
  if (!found) return undefined;
  const prefix = text.slice(0, found.index).trim();
  if (prefix.length > 0 && !/^please[,!]?$/i.test(prefix)) return undefined;
  if (found.delimiter === "quoted") return found.value;
  return /^\S+$/.test(found.value) ? found.value : undefined;
}

export type LiteralContractOutcome = "exact" | "reduced" | "violated";

/**
 * Post-stream check of a literal contract. "reduced" means the literal is
 * present but wrapped in prose (persist the literal instead); "violated"
 * means it is absent (keep the answer as generated, flag the run — never
 * invent it). Byte-exact on purpose: casing and punctuation are part of the
 * contract.
 */
export function evaluateLiteralContract(
  answer: string,
  literal: string,
): LiteralContractOutcome {
  if (answer === literal) return "exact";
  return answer.includes(literal) ? "reduced" : "violated";
}
