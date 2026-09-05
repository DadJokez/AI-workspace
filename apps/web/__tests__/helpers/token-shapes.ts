import { findCredentialShapedContent } from "../../lib/secret-scan";

/**
 * Token-handler verification (#807): the shapes a leaked provider credential
 * would take in a client-visible payload. Extends the mint-time scanner
 * (`lib/secret-scan.ts`, which stays unchanged — widening it would change
 * deploy behaviour) with the provider-specific token formats Comparative
 * actually stores, plus the value-assignment shapes a serialized token row
 * would produce. Test-only: nothing in production imports this.
 */
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  // Salesforce session id: 00D<org id>!<opaque>
  [/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._+/=-]{20,}/, "a Salesforce session id"],
  // Google OAuth access token prefix.
  [/\bya29\.[A-Za-z0-9_-]{20,}/, "a Google access token"],
  // A serialized token row: access_token/refresh_token with a value attached.
  [
    /\b(?:access|refresh)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=!-]{8,}/i,
    "a token field with a value",
  ],
  // A credential smuggled through a query string. Anchored on the query
  // separator: bare `token=` also matches minified-JS assignments
  // (`h.token=this.config.token`), which are not credentials.
  [/[?&]token=[A-Za-z0-9._~+/=-]{16,}/i, "a token query parameter"],
];

/** Every credential-shaped finding in `text`, labelled; empty means clean. */
export function findTokenShapedContent(text: string): string[] {
  const findings = findCredentialShapedContent(text);
  for (const [pattern, label] of TOKEN_SHAPES) {
    if (pattern.test(text)) findings.push(label);
  }
  return findings;
}
