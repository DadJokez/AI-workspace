import { createHash, createHmac } from "node:crypto";

/**
 * Shared SES v2 sender — hand-rolled SigV4, no AWS SDK dependency.
 *
 * Extracted from `lib/invite-email.ts` so invitation mail and magic-link
 * sign-in mail use one signing/sending core. Callers own their error
 * semantics: this module throws `SesEmailError` with a machine code;
 * `invite-email.ts` re-wraps into its existing `InvitationEmailError`
 * contract, `magic-link-email.ts` surfaces codes to next-auth.
 *
 * Env (shared with invitation email — one outbound-mail configuration):
 *   - INVITE_EMAIL_PROVIDER: "ses" | anything else = disabled
 *   - INVITE_EMAIL_FROM: verified SES sender
 *   - INVITE_EMAIL_AWS_REGION (falls back to AWS_REGION / AWS_DEFAULT_REGION)
 */

export class SesEmailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SesEmailError";
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SesEnvConfig {
  /** "ses" when outbound email is enabled; "disabled" otherwise. */
  provider: "ses" | "disabled";
  from: string | null;
  region: string | null;
}

export function sesEnvConfig(): SesEnvConfig {
  const provider = (process.env.INVITE_EMAIL_PROVIDER ?? "disabled")
    .trim()
    .toLowerCase();
  return {
    provider: provider === "ses" ? "ses" : "disabled",
    from: process.env.INVITE_EMAIL_FROM?.trim() || null,
    region:
      process.env.INVITE_EMAIL_AWS_REGION ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      null,
  };
}

export async function resolveAwsCredentials(): Promise<AwsCredentials> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }

  const metadataUrl = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    ? process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    : process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
      ? `http://169.254.170.2${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`
      : null;
  if (!metadataUrl) {
    throw new SesEmailError(
      "aws_credentials_missing",
      "AWS credentials for email sending are not available.",
    );
  }

  const headers: Record<string, string> = {};
  if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) {
    headers.authorization = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  }
  const res = await fetch(metadataUrl, { headers });
  if (!res.ok) {
    throw new SesEmailError(
      "aws_credentials_unavailable",
      "AWS task credentials for email sending are unavailable.",
      res.status,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        Token?: string;
      }
    | null;
  if (!body?.AccessKeyId || !body.SecretAccessKey) {
    throw new SesEmailError(
      "aws_credentials_invalid",
      "AWS task credentials for email sending are invalid.",
    );
  }
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
  };
}

export async function sendSesEmail(input: {
  region: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ provider: "ses"; messageId: string | null }> {
  const credentials = await resolveAwsCredentials();
  const host = `email.${input.region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const endpoint = `https://${host}${path}`;
  const payload = JSON.stringify({
    FromEmailAddress: input.from,
    Destination: { ToAddresses: [input.to] },
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: input.text, Charset: "UTF-8" },
          Html: { Data: input.html, Charset: "UTF-8" },
        },
      },
    },
  });
  const signed = signAwsJsonRequest({
    method: "POST",
    path,
    host,
    region: input.region,
    service: "ses",
    payload,
    credentials,
    now: new Date(),
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signed,
    },
    body: payload,
  });
  if (!res.ok) {
    throw new SesEmailError(
      "email_send_failed",
      "SES rejected the email.",
      res.status,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { MessageId?: string }
    | null;
  return {
    provider: "ses",
    messageId: typeof body?.MessageId === "string" ? body.MessageId : null,
  };
}

export function signAwsJsonRequest(input: {
  method: string;
  path: string;
  host: string;
  region: string;
  service: string;
  payload: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const amzDate = awsDateTime(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.payload);
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service),
    stringToSign,
  );

  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken
      ? { "x-amz-security-token": input.credentials.sessionToken }
      : {}),
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", "),
  };
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacBuffer(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacBuffer(kDate, region);
  const kService = hmacBuffer(kRegion, service);
  return hmacBuffer(kService, "aws4_request");
}

function awsDateTime(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacBuffer(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
