type KnownContextProvider = "github" | "vault";

type KnownContextDenialOptions = {
  providers: KnownContextProvider[];
  scopedToolBoundaryProviders?: KnownContextProvider[];
};

function sentenceContaining(answer: string, index: number, length: number) {
  const before = answer.slice(0, index);
  const sentenceStart = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  );
  const after = answer.slice(index + length);
  const boundary = after.search(/[.!?\n]/);
  const sentenceEnd =
    boundary === -1 ? answer.length : index + length + boundary;
  return answer.slice(sentenceStart + 1, sentenceEnd);
}

export function findKnownContextDenial(
  answer: string,
  {
    providers,
    scopedToolBoundaryProviders = [],
  }: KnownContextDenialOptions,
) {
  const plain = answer.replace(/[*_`]/g, "");
  const providerAlternation = providers.join("|");
  const permanentDenialPatterns = [
    /\bno tools are connected\b/i,
    new RegExp(
      `\\b(?:your\\s+)?(${providerAlternation})\\s+(?:account\\s+)?(?:is\\s+not|isn't)\\s+(?:connected|available|accessible)\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:your\\s+)?(${providerAlternation})\\s+(?:account\\s+)?is\\s+(?:disconnected|unavailable|not wired up)\\b`,
      "i",
    ),
  ];
  const permanentDenial = permanentDenialPatterns
    .map((pattern) => plain.match(pattern)?.[0])
    .find((match): match is string => Boolean(match));
  if (permanentDenial) return permanentDenial;

  const accessDenial = [
    new RegExp(
      `\\b(?:(?:don'?t|do not|cannot|can'?t)\\s+(?:have\\s+)?access\\s+to|(?:cannot|can'?t)\\s+access)\\s+(?:your\\s+)?(${providerAlternation})(?:\\s+(data|content|information|results?|pull requests?|prs?|issues?|tools?|memory))?\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:i|we|comparative)\\s+(?:(?:don'?t|do not|cannot|can'?t)\\s+have|(?:cannot|can'?t)\\s+get)\\s+(?:your\\s+)?(${providerAlternation})(?:\\s+(access|data|content|information|results?|pull requests?|prs?|issues?|tools?|memory))?\\b`,
      "i",
    ),
  ]
    .map((pattern) => plain.match(pattern))
    .find((match): match is RegExpMatchArray => Boolean(match));
  if (!accessDenial) return undefined;

  const provider = accessDenial[1]?.toLowerCase() as
    | KnownContextProvider
    | undefined;
  const boundaryTarget = accessDenial[2]?.toLowerCase();
  const limitedDataBoundary =
    boundaryTarget !== undefined &&
    boundaryTarget !== "access" &&
    !boundaryTarget.startsWith("tool");
  if (limitedDataBoundary) return undefined;

  const denialClause = sentenceContaining(
    plain,
    accessDenial.index ?? 0,
    accessDenial[0].length,
  );
  const affirmsConnection = provider
    ? new RegExp(
        `\\b(?:your\\s+)?${provider}\\s+(?:account\\s+)?(?:is\\s+)?(?:connected|available)\\b`,
        "i",
      ).test(plain)
    : false;
  const scopedToolBoundary =
    provider !== undefined &&
    scopedToolBoundaryProviders.includes(provider) &&
    boundaryTarget?.startsWith("tool") === true &&
    affirmsConnection &&
    /\b(?:this|current)\s+(?:(?:lightweight|fast(?:-chat)?|tool-backed)\s+)?(?:turn|lane|chat|response)\b/i.test(
      denialClause,
    );

  return scopedToolBoundary ? undefined : accessDenial[0];
}
