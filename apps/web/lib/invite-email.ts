import { SesEmailError, escapeHtml, sendSesEmail, sesEnvConfig } from "@/lib/aws-ses";

/**
 * Invitation email sending. The SigV4/SES core lives in `lib/aws-ses.ts`
 * (shared with magic-link sign-in mail); this module owns the invitation
 * rendering and the `InvitationEmailError` contract that
 * `lib/admin-invitations.ts` records per-invite delivery status against.
 */

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

export async function sendInvitationEmail(
  input: SendInvitationEmailInput,
): Promise<SendInvitationEmailResult> {
  const config = sesEnvConfig();
  if (config.provider !== "ses") {
    throw new InvitationEmailError(
      "email_provider_disabled",
      "Invitation email sending is not configured.",
    );
  }
  if (!config.from) {
    throw new InvitationEmailError(
      "email_sender_missing",
      "Invitation email sender is not configured.",
    );
  }
  if (!config.region) {
    throw new InvitationEmailError(
      "email_region_missing",
      "AWS region for invitation email sending is not configured.",
    );
  }

  try {
    return await sendSesEmail({
      region: config.region,
      from: config.from,
      to: input.to,
      subject: "You have been invited to Comparative",
      text: renderInvitationText(input),
      html: renderInvitationHtml(input),
    });
  } catch (err) {
    // Preserve the pre-refactor contract: everything thrown from this module
    // is an InvitationEmailError with the same codes callers already track.
    if (err instanceof SesEmailError) {
      throw new InvitationEmailError(err.code, err.message, err.status);
    }
    throw err;
  }
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
