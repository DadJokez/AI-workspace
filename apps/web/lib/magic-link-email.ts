import { SesEmailError, escapeHtml, sendSesEmail, sesEnvConfig } from "@/lib/aws-ses";

/**
 * Magic-link sign-in email (next-auth email provider `sendVerificationRequest`
 * seam). Shares the SES SigV4 core and the INVITE_EMAIL_* env with invitation
 * mail — one outbound-mail configuration.
 *
 * Provider-disabled behavior differs from invites on purpose:
 *   - production: throw (next-auth surfaces `EmailSignin`; a misconfigured
 *     deployment must not silently tell testers "a link is on its way").
 *   - non-production: no-op and log the sign-in URL to the server console so
 *     local dev and e2e can complete the flow without SES. The URL is a
 *     short-lived single-use credential; this log never happens in production.
 */

/** 15 minutes — testers click immediately; short-lived is the right posture. */
export const MAGIC_LINK_MAX_AGE_SECONDS = 15 * 60;

export interface SendMagicLinkEmailInput {
  to: string;
  url: string;
  expires: Date;
}

export interface SendMagicLinkEmailResult {
  delivered: boolean;
  messageId: string | null;
}

export async function sendMagicLinkEmail(
  input: SendMagicLinkEmailInput,
): Promise<SendMagicLinkEmailResult> {
  const config = sesEnvConfig();
  if (config.provider !== "ses") {
    if (process.env.NODE_ENV === "production") {
      throw new SesEmailError(
        "email_provider_disabled",
        "Magic-link email sending is not configured.",
      );
    }
    // Safe to log here only because this branch is non-production by
    // construction (production throws above) and the token is single-use
    // with a 15-minute expiry.
    console.log(
      `[magic-link] Email provider disabled; sign-in link for ${input.to}: ${input.url}`,
    );
    return { delivered: false, messageId: null };
  }
  if (!config.from) {
    throw new SesEmailError(
      "email_sender_missing",
      "Magic-link email sender is not configured.",
    );
  }
  if (!config.region) {
    throw new SesEmailError(
      "email_region_missing",
      "AWS region for magic-link email sending is not configured.",
    );
  }

  const result = await sendSesEmail({
    region: config.region,
    from: config.from,
    to: input.to,
    subject: "Sign in to Comparative",
    text: renderMagicLinkText(input),
    html: renderMagicLinkHtml(input),
  });
  return { delivered: true, messageId: result.messageId };
}

export function renderMagicLinkText(input: SendMagicLinkEmailInput): string {
  return [
    "Sign in to Comparative",
    "",
    `Use this link to sign in as ${input.to}:`,
    input.url,
    "",
    "This link expires in 15 minutes and can be used once.",
    "If you didn't request it, you can safely ignore this email.",
  ].join("\n");
}

export function renderMagicLinkHtml(input: SendMagicLinkEmailInput): string {
  const email = escapeHtml(input.to);
  const url = escapeHtml(input.url);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#0f1115;color:#f4f4f5;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#171a20;border:1px solid #2a2f38;border-radius:12px;padding:28px;">
            <tr>
              <td>
                <h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;">Sign in to Comparative</h1>
                <p style="font-size:14px;line-height:1.6;color:#c5c8cf;margin:0 0 18px;">Use this link to sign in as ${email}.</p>
                <p style="margin:0 0 24px;">
                  <a href="${url}" style="display:inline-block;background:#f4f4f5;color:#0f1115;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px;padding:11px 16px;">Sign in</a>
                </p>
                <p style="font-size:12px;line-height:1.5;color:#8c919b;margin:0 0 10px;">This link expires in 15 minutes and can be used once.</p>
                <p style="font-size:12px;line-height:1.5;color:#8c919b;margin:0 0 10px;">If you didn't request it, you can safely ignore this email.</p>
                <p style="font-size:12px;line-height:1.5;color:#8c919b;margin:0;">If the button does not work, paste this link into your browser: ${url}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
