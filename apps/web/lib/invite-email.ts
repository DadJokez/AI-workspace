import { createHash, createHmac } from "node:crypto";

export interface SendInvitationEmailInput {
  to: string;
  role: "admin" | "user";
  inviteUrl: string;
  expiresAt: Date;
  invitedByName: string;
  invitedByEmail: string;
}

export interface SendInvitationEmailResult {
  provider: "ses";
  messageId: string | null;
}

export class InvitationEmailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "InvitationEmailError";
  }
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export async function sendInvitationEmail(
  input: SendInvitationEmailInput,
): Promise<SendInvitationEmailResult> {
  const provider = (process.env.INVITE_EMAIL_PROVIDER ?? "disabled")
    .trim()
    .toLowerCase();
  if (provider !== "ses") {
    throw new InvitationEmailError(
      "email_provider_disabled",
      "Invitation email sending is not configured.",
    );
  }

  const from = process.env.INVITE_EMAIL_FROM?.trim();
  if (!from) {
    throw new InvitationEmailError(
      "email_sender_missing",
      "Invitation email sender is not configured.",
    );
  }

  const region =
    process.env.INVITE_EMAIL_AWS_REGION ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new InvitationEmailError(
      "email_region_missing",
      "AWS region for invitation email sending is not configured.",
    );
  }

  const credentials = await resolveAwsCredentials();
  return sendSesEmail({
    region,
    credentials,
    from,
    to: input.to,
    subject: "You have been invited to Comparative",
    text: renderInvitationText(input),
    html: renderInvitationHtml(input),
  });
}

export function renderInvitationText(input: SendInvitationEmailInput): string {
  const expires = input.expiresAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return [
    `${input.invitedByName} invited you to Comparative.`,
    "",
    `Use this link to join as ${input.to} with the ${input.role} role:`,
    input.inviteUrl,
    "",
    `This invitation expires on ${expires}.`,
  ].join("\n");
}

export function renderInvitationHtml(input: SendInvitationEmailInput): string {
  const expires = input.expiresAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const invitedBy = escapeHtml(input.invitedByName);
  const email = escapeHtml(input.to);
  const role = escapeHtml(input.role);
  const inviteUrl = escapeHtml(input.inviteUrl);
  const expiresText = escapeHtml(expires);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#0f1115;color:#f4f4f5;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#171a20;border:1px solid #2a2f38;border-radius:12px;padding:28px;">
            <tr>
              <td>
                <h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;">You have been invited to Comparative</h1>
                <p style="font-size:14px;line-height:1.6;color:#c5c8cf;margin:0 0 18px;">${invitedBy} invited ${email} to join Comparative with the ${role} role.</p>
                <p style="margin:0 0 24px;">
                  <a href="${inviteUrl}" style="display:inline-block;background:#f4f4f5;color:#0f1115;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px;padding:11px 16px;">Accept invite</a>
                </p>
                <p style="font-size:12px;line-height:1.5;color:#8c919b;margin:0 0 10px;">This invitation expires on ${expiresText}.</p>
                <p style="font-size:12px;line-height:1.5;color:#8c919b;margin:0;">If the button does not work, paste this link into your browser: ${inviteUrl}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function resolveAwsCredentials(): Promise<AwsCredentials> {
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
    throw new InvitationEmailError(
      "aws_credentials_missing",
      "AWS credentials for invitation email sending are not available.",
    );
  }

  const headers: Record<string, string> = {};
  if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) {
    headers.authorization = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  }
  const res = await fetch(metadataUrl, { headers });
  if (!res.ok) {
    throw new InvitationEmailError(
      "aws_credentials_unavailable",
      "AWS task credentials for invitation email sending are unavailable.",
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
    throw new InvitationEmailError(
      "aws_credentials_invalid",
      "AWS task credentials for invitation email sending are invalid.",
    );
  }
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
  };
}

async function sendSesEmail(input: {
  region: string;
  credentials: AwsCredentials;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendInvitationEmailResult> {
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
    credentials: input.credentials,
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
    throw new InvitationEmailError(
      "email_send_failed",
      "SES rejected the invitation email.",
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

function signAwsJsonRequest(input: {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
