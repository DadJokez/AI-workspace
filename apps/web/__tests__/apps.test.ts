import { describe, expect, it } from "vitest";
import {
  canViewApp,
  findCredentialShapedContent,
  isServableArtifact,
  parseAppInput,
  RESERVED_APP_SLUGS,
} from "@/lib/apps";

const owner = { id: "owner-1", role: "user" as const };
const stranger = { id: "user-2", role: "user" as const };
const admin = { id: "admin-1", role: "admin" as const };

describe("canViewApp", () => {
  const app = { ownerUserId: "owner-1", archivedAt: null };

  it("allows the owner and admins, not strangers", () => {
    expect(canViewApp(app, owner)).toBe(true);
    expect(canViewApp(app, admin)).toBe(true);
    expect(canViewApp(app, stranger)).toBe(false);
  });

  it("keeps archived apps visible to owner and admin only", () => {
    const archived = { ownerUserId: "owner-1", archivedAt: new Date() };
    expect(canViewApp(archived, owner)).toBe(true);
    expect(canViewApp(archived, admin)).toBe(true);
    expect(canViewApp(archived, stranger)).toBe(false);
  });
});

describe("findCredentialShapedContent (FR-014 no-secrets policy)", () => {
  it("flags GitHub tokens", () => {
    expect(
      findCredentialShapedContent(
        `fetch(url, {headers:{Authorization:"token ghp_${"a".repeat(30)}"}})`,
      ),
    ).toContain("a GitHub token");
    expect(
      findCredentialShapedContent(`github_pat_${"x".repeat(40)}`),
    ).toContain("a GitHub fine-grained token");
  });

  it("flags API keys, AWS key ids, bearer tokens, JWTs, and PEM blocks", () => {
    expect(findCredentialShapedContent(`sk-${"k".repeat(28)}`)).toContain(
      "an API secret key",
    );
    expect(
      findCredentialShapedContent("const id = 'AKIAIOSFODNN7EXAMPLE';"),
    ).toContain("an AWS access key id");
    expect(
      findCredentialShapedContent(`Authorization: Bearer ${"t".repeat(24)}`),
    ).toContain("a bearer token");
    expect(
      findCredentialShapedContent(
        `eyJhbGciOiJIUzI1NiJ9x.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4f`,
      ),
    ).toContain("a JWT");
    expect(
      findCredentialShapedContent(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...",
      ),
    ).toContain("a private key block");
  });

  it("passes ordinary app content mentioning auth concepts", () => {
    const html = `<!doctype html><html><body>
      <h1>Token usage dashboard</h1>
      <p>Sign in with your workspace account. API keys are managed in Settings.</p>
      <script>const skills = ["briefing"]; document.title = "ok";</script>
    </body></html>`;
    expect(findCredentialShapedContent(html)).toEqual([]);
  });
});

describe("isServableArtifact", () => {
  it("accepts HTML by mime type or filename, rejects the rest", () => {
    expect(
      isServableArtifact({ mimeType: "text/html", filename: "page" }),
    ).toBe(true);
    expect(
      isServableArtifact({ mimeType: "text/plain", filename: "index.HTML" }),
    ).toBe(true);
    expect(
      isServableArtifact({ mimeType: "text/markdown", filename: "notes.md" }),
    ).toBe(false);
  });
});

describe("parseAppInput", () => {
  it("requires a name and trims description", () => {
    expect(parseAppInput({ name: "" }).ok).toBe(false);
    expect(parseAppInput("nope").ok).toBe(false);
    const parsed = parseAppInput({
      name: "  Dashboard ",
      description: "  shows things  ",
    });
    expect(parsed).toEqual({
      ok: true,
      input: { name: "Dashboard", description: "shows things" },
    });
  });
});

describe("RESERVED_APP_SLUGS", () => {
  it("reserves the static /apps segments so routing can never collide", () => {
    expect(RESERVED_APP_SLUGS.has("manage")).toBe(true);
    expect(RESERVED_APP_SLUGS.has("new")).toBe(true);
  });
});
