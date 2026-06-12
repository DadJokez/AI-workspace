/**
 * Pure, dependency-free credential-shape scanner. Lives in its own leaf module
 * so client components (the chat composer) and server code (apps, attachments)
 * can both use it without dragging server-only imports into the browser
 * bundle. Used to enforce the no-secrets policy on app content and chat
 * uploads.
 */
export function findCredentialShapedContent(text: string): string[] {
  const findings: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/, "a GitHub token"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "a GitHub fine-grained token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "an API secret key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
    [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
    [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "a bearer token"],
    [
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      "a JWT",
    ],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) findings.push(label);
  }
  return findings;
}
