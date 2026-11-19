// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in page (apps/web/app/login): which methods it offers follows the
 * provider list the server computed, and a refusal's reason code becomes a
 * fixed sentence. Nothing from the URL is rendered as-is.
 *
 * The form is a client component: everything it knows about the deployment
 * arrives as props from the server page, never through an import.
 */

const signIn = vi.hoisted(() => vi.fn());
const getSessionUser = vi.hoisted(() => vi.fn());
const enabledAuthProviders = vi.hoisted(() => vi.fn());
const oidc = vi.hoisted(() => ({
  value: null as { displayName: string } | null,
}));

vi.mock("next-auth/react", () => ({ signIn }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/auth/getSessionUser", () => ({ getSessionUser }));
vi.mock("@/lib/auth/nextauth", () => ({ enabledAuthProviders }));
vi.mock("@/lib/deployment-config", () => ({
  get OIDC() {
    return oidc.value;
  },
}));
vi.mock("@/components/AlphaBadge", () => ({ AlphaBadge: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/ThinkingOrb", () => ({ ThinkingOrb: () => null }));

import { LoginForm } from "@/app/login/LoginForm";
import LoginPage from "@/app/login/page";

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(null);
  enabledAuthProviders.mockReturnValue(["github", "email"]);
  oidc.value = null;
});

afterEach(cleanup);

function renderForm(providers: string[], ssoLabel: string | null = null) {
  return render(
    createElement(LoginForm, { callbackUrl: "/chat", providers, ssoLabel }),
  );
}

async function renderPage(searchParams: Record<string, string> = {}) {
  return render(
    await LoginPage({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("LoginForm", () => {
  it("offers the magic-link form and GitHub, and no SSO button, by default", () => {
    renderForm(["github", "email"]);

    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("shows the SSO button with the configured label when OIDC is enabled", () => {
    renderForm(["email", "pingone"], "Example SSO");

    fireEvent.click(screen.getByRole("button", { name: "Example SSO" }));
    expect(signIn).toHaveBeenCalledWith("pingone", { callbackUrl: "/chat" });
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("shows no magic-link form once the server stops offering it (after the sunset)", () => {
    renderForm(["pingone"], "Single sign-on");

    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Email me a sign-in link" }),
    ).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Single sign-on",
    ]);
  });

  it("says sign-in is not configured when no method is left", () => {
    renderForm([]);
    expect(screen.getByText(/Sign-in is not configured/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("login page", () => {
  it("hands the form the server's provider list and SSO label", async () => {
    enabledAuthProviders.mockReturnValue(["pingone"]);
    oidc.value = { displayName: "Example SSO" };
    await renderPage();

    expect(screen.getByRole("button", { name: "Example SSO" })).toBeTruthy();
    expect(screen.queryByLabelText("Email address")).toBeNull();
    // Single sign-on only: access is not by invitation.
    expect(screen.queryByText(/invite-only/)).toBeNull();
  });

  it("is unchanged by default, invite note included", async () => {
    await renderPage();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.getByText(/Access is invite-only/)).toBeTruthy();
  });

  it.each([
    ["required_group_missing", /isn't in the group that has access/],
    ["groups_claim_unreadable", /did not share your group memberships/],
    ["email_in_use", /already has an account that signs in a different way/],
    ["missing_email", /did not share an email address/],
  ])("explains a %s refusal", async (reason, message) => {
    await renderPage({ error: "AccessDenied", reason });
    expect(screen.getByText(message)).toBeTruthy();
  });

  it.each([
    "not_invited",
    "magic_link_domain_not_allowed",
    "magic_link_sunset",
    "constructor",
    "<img src=x onerror=alert(1)>",
  ])("shows only the generic refusal for reason %j and echoes nothing", async (reason) => {
    const { container } = await renderPage({ error: "AccessDenied", reason });
    expect(screen.getByText(/This account isn't authorized/)).toBeTruthy();
    expect(container.textContent).not.toContain(reason);
    expect(container.querySelector("img")).toBeNull();
  });

  it("ignores a reason on any other error code", async () => {
    await renderPage({ error: "Verification", reason: "required_group_missing" });
    expect(screen.getByText(/invalid or has expired/)).toBeTruthy();
    expect(screen.queryByText(/isn't in the group/)).toBeNull();
  });

  it("names the provider it could not reach", async () => {
    await renderPage({ error: "OAuthCallback" });
    expect(screen.getByText(/Couldn't reach GitHub/)).toBeTruthy();
    cleanup();

    enabledAuthProviders.mockReturnValue(["pingone"]);
    oidc.value = { displayName: "Single sign-on" };
    await renderPage({ error: "OAuthCallback" });
    expect(screen.getByText(/Couldn't reach the sign-in provider/)).toBeTruthy();
  });
});
