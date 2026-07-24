export const WEB_EGRESS_POLICY_NAME = "admin_domain_denylist";

export interface WebEgressPolicy {
  name: typeof WEB_EGRESS_POLICY_NAME;
  deniedDomains: readonly string[];
}

export interface WebEgressDenial {
  error: "web_egress_denied";
  reason: "denied_domain_policy";
  policy: typeof WEB_EGRESS_POLICY_NAME;
  hostname: string;
  matchedDomain: string;
}

export function assertWebEgressAllowed(
  hostname: string,
  policy?: WebEgressPolicy,
): void {
  if (!policy) return;

  const normalizedHost = normalizeHostname(hostname);
  const matchedDomain = policy.deniedDomains
    .map(normalizeHostname)
    .find(
      (domain) =>
        domain.length > 0 &&
        (normalizedHost === domain || normalizedHost.endsWith(`.${domain}`)),
    );
  if (!matchedDomain) return;

  const denial: WebEgressDenial = {
    error: "web_egress_denied",
    reason: "denied_domain_policy",
    policy: policy.name,
    hostname: normalizedHost,
    matchedDomain,
  };
  throw new Error(JSON.stringify(denial));
}

export function parseWebEgressDenial(value: unknown): WebEgressDenial | null {
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value) as Partial<WebEgressDenial>;
    if (
      parsed.error !== "web_egress_denied" ||
      parsed.reason !== "denied_domain_policy" ||
      parsed.policy !== WEB_EGRESS_POLICY_NAME ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.matchedDomain !== "string"
    ) {
      return null;
    }
    return parsed as WebEgressDenial;
  } catch {
    return null;
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
