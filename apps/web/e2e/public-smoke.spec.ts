import { expect, test } from "@playwright/test";

test.describe("public product smoke", () => {
  test("login page renders the Comparative sign-in shell", async ({ page }) => {
    await page.goto("/login");

    await expect(page.locator('[aria-label="Alpha version"]')).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Comparative" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in to continue")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in with github/i }),
    ).toBeVisible();
    await expect(page.getByText("Access is invite-only")).toBeVisible();
  });

  test("protected chat route redirects anonymous visitors to login", async ({
    page,
  }) => {
    await page.goto("/chat");

    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fchat$/);
    await expect(
      page.getByRole("button", { name: /sign in with github/i }),
    ).toBeVisible();
  });

  test("theme toggle flips and persists from the login page", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.evaluate(() => window.localStorage.setItem("theme", "light"));
    await page.reload();

    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("public model metadata stays available", async ({ request }) => {
    const response = await request.get("/api/models");
    expect(response.ok()).toBe(true);

    const body = (await response.json()) as {
      defaultModelId?: unknown;
      models?: Array<{ id?: unknown; displayName?: unknown }>;
      runtimeV2Enabled?: unknown;
    };
    expect(typeof body.defaultModelId).toBe("string");
    expect(typeof body.runtimeV2Enabled).toBe("boolean");
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models?.length).toBeGreaterThan(0);
    expect(body.models?.some((model) => model.id === body.defaultModelId)).toBe(
      true,
    );
  });

  test("chat API rejects anonymous posts before doing model work", async ({
    request,
  }) => {
    const response = await request.post("/api/chat", {
      data: { message: "hello from smoke test" },
    });

    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
