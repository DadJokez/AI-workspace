import { describe, expect, it } from "vitest";
import {
  renderInvitationHtml,
  renderInvitationText,
  signAwsJsonRequest,
} from "@/lib/invite-email";

const inviteInput = {
  to: 'bad"><script>alert(1)</script>@example.com',
  role: "admin" as const,
  inviteUrl: "https://example.com/invite/token?source=a&team=b",
  expiresAt: new Date("2026-07-01T12:00:00Z"),
  invitedByName: 'Rob "><script>alert(1)</script>',
  invitedByEmail: "rob@example.com",
};

describe("invite email rendering", () => {
  it("escapes hostile display fields in HTML while preserving the invite link", () => {
    const html = renderInvitationHtml(inviteInput);

    expect(html).toContain("You have been invited to Comparative");
    expect(html).toContain("Rob &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      "bad&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.com",
    );
    expect(html).toContain(
      "https://example.com/invite/token?source=a&amp;team=b",
    );
    expect(html).not.toContain('Rob "><script>');
    expect(html).not.toContain('bad"><script>');
  });

  it("renders a plain-text fallback with the invite URL and expiration", () => {
    const text = renderInvitationText(inviteInput);

    expect(text).toContain("invited you to Comparative");
    expect(text).toContain(inviteInput.inviteUrl);
    expect(text).toContain("Jul 1, 2026");
  });
});

describe("AWS SigV4 signing for SES", () => {
  it("matches a fixed SigV4 authorization vector for the SES JSON request shape", () => {
    const payload =
      '{"FromEmailAddress":"sender@example.com","Destination":{"ToAddresses":["to@example.com"]},"Content":{"Simple":{"Subject":{"Data":"Subject","Charset":"UTF-8"},"Body":{"Text":{"Data":"Text","Charset":"UTF-8"},"Html":{"Data":"<p>Text</p>","Charset":"UTF-8"}}}}}';

    const headers = signAwsJsonRequest({
      method: "POST",
      path: "/v2/email/outbound-emails",
      host: "email.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "ses",
      payload,
      now: new Date("2015-08-30T12:36:00Z"),
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
    });

    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers["x-amz-content-sha256"]).toBe(
      "54d83e374c6030189779f9279614765ce69d8e5c961a382f37ffdda5199aa8d1",
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/ses/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=36f856b26d46ab0fdf2a7db856c06ddf19c1c7d0ebc8f4d9a000ad164d525b12",
    );
  });

  it("includes temporary session tokens in signed headers", () => {
    const headers = signAwsJsonRequest({
      method: "POST",
      path: "/v2/email/outbound-emails",
      host: "email.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "ses",
      payload: "{}",
      now: new Date("2015-08-30T12:36:00Z"),
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        sessionToken: "session-token",
      },
    });

    expect(headers["x-amz-security-token"]).toBe("session-token");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });
});
