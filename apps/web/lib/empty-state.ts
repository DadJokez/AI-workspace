export const FALLBACK_EMPTY_STATE_SUGGESTIONS = [
  "Open GitHub issues assigned to me — what should I tackle first?",
  "Summarize what shipped in my repos this week",
  "Draft a concise project status update for my team",
  "What can you help me with today?",
] as const;

type WorkRole =
  | "product"
  | "engineering"
  | "operations"
  | "finance"
  | "sales"
  | "analyst"
  | "general";

const ROLE_SUGGESTIONS: Record<WorkRole, readonly string[]> = {
  product: [
    "Turn these notes into a clear product decision brief",
    "Draft a concise stakeholder update for this initiative",
    "Identify the biggest delivery risks in this plan",
    "Help me turn this idea into testable requirements",
  ],
  engineering: [
    "Turn these technical notes into a clear team update",
    "Help me identify the biggest delivery risk this week",
    "Draft release notes from this list of changes",
    "Break this technical problem into the next concrete steps",
  ],
  operations: [
    "Find the bottlenecks in this process",
    "Turn these notes into a weekly operations brief",
    "Draft a practical SOP from this workflow",
    "Build a concise risk and action register",
  ],
  finance: [
    "Summarize the important variances in these numbers",
    "Turn this analysis into an executive finance brief",
    "Identify the assumptions and risks in this forecast",
    "Draft a concise update for finance leadership",
  ],
  sales: [
    "Turn these account notes into a focused call brief",
    "Draft a concise follow-up email from these notes",
    "Identify the biggest risks across these opportunities",
    "Help me prepare the next best action for this account",
  ],
  analyst: [
    "Analyze this dataset and explain the important findings",
    "Turn these findings into an executive-ready summary",
    "Create a data-quality checklist for this analysis",
    "Help me frame the next questions this data should answer",
  ],
  general: FALLBACK_EMPTY_STATE_SUGGESTIONS,
};

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google Mail & Calendar",
  notion: "Notion",
  salesforce: "Salesforce",
};

export function selectEmptyStateSuggestions({
  roleContext,
  availableProviders = [],
}: {
  roleContext?: string | null;
  availableProviders?: readonly string[];
}): string[] {
  const role = inferWorkRole(roleContext);
  const available = new Set(
    availableProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const suggestions: string[] = [];

  if (role === "engineering" && available.has("github")) {
    suggestions.push(
      "Review my open GitHub work and tell me what to tackle first",
    );
  }
  if (role === "product" && available.has("notion")) {
    suggestions.push("Summarize the latest product decisions in Notion");
  }
  if (role === "sales" && available.has("salesforce")) {
    suggestions.push("Review my Salesforce pipeline and flag the biggest risks");
  }
  if (available.has("google")) {
    suggestions.push("Summarize the email and calendar items that need my attention");
  }
  if (role === "general" && available.has("github")) {
    suggestions.push(
      "Open GitHub issues assigned to me — what should I tackle first?",
    );
  }

  for (const suggestion of ROLE_SUGGESTIONS[role]) {
    if (!suggestions.includes(suggestion)) suggestions.push(suggestion);
  }

  return suggestions.slice(0, 4);
}

export function firstNameFromDisplayName(displayName?: string | null): string {
  return displayName?.trim().split(/\s+/)[0] ?? "";
}

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

export function connectedProvidersSummary(
  providerIds: readonly string[] | null,
): string {
  if (providerIds === null) {
    return "Connect work tools when you need them.";
  }

  const labels = Array.from(
    new Set(
      providerIds
        .map((provider) => provider.trim().toLowerCase())
        .filter(Boolean)
        .map((provider) => PROVIDER_LABELS[provider] ?? humanize(provider)),
    ),
  );

  if (labels.length === 0) return "No work tools are connected yet.";
  if (labels.length === 1) return `${labels[0]} is connected.`;
  return `${formatList(labels)} are connected.`;
}

function inferWorkRole(roleContext?: string | null): WorkRole {
  const value = roleContext?.toLowerCase() ?? "";
  if (/\b(sales|account executive|account manager|business development)\b/.test(value)) {
    return "sales";
  }
  if (/\b(engineer|engineering|developer|software|technical)\b/.test(value)) {
    return "engineering";
  }
  if (/\b(product|program manager|project manager|roadmap)\b/.test(value)) {
    return "product";
  }
  if (/\b(operations|operator|supply chain|process)\b/.test(value)) {
    return "operations";
  }
  if (/\b(finance|financial|accounting|controller|fp&a)\b/.test(value)) {
    return "finance";
  }
  if (/\b(analyst|analytics|data scientist|business intelligence)\b/.test(value)) {
    return "analyst";
  }
  return "general";
}

function formatList(values: readonly string[]): string {
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function humanize(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
