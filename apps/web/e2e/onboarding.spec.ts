import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openSettingsSection } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked onboarding tests run only against the local e2e harness",
);

test.describe("first-run onboarding", () => {
  test("names the assistant, then tours only live capabilities", async ({
    page,
  }) => {
    const userPatches: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === "/api/user"
      ) {
        userPatches.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await installMockComparativeApi(page, {
      user: { assistantName: null, tourCompletedAt: null },
      oauthStatus: { github: false },
    });

    await gotoE2EChat(page);

    const setup = page.getByRole("dialog", { name: "Welcome setup" });
    await expect(
      setup.getByRole("heading", { name: "Name your assistant" }),
    ).toBeVisible();
    await expect(page.getByText("Connect your tools")).toHaveCount(0);
    await expect(page.getByText("About your work")).toHaveCount(0);

    const nameInput = setup.getByRole("textbox", { name: "Assistant name" });
    await expect(nameInput).toBeFocused();
    await expect(page.locator('[data-app-shell="true"]')).toHaveAttribute(
      "inert",
      "",
    );
    await nameInput.fill("June");
    await page.keyboard.press("Shift+Tab");
    await expect(setup.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");

    const tour = page.getByRole("dialog", { name: "Welcome tour" });
    await expect(tour.getByRole("button", { name: "Next", exact: true }))
      .toBeFocused();
    await expect(tour.locator('button[aria-label="Next step"]')).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(tour.getByRole("button", { name: "Skip tour" })).toBeFocused();
    const expectedSteps = [
      "Start in chat",
      "Find created files in Artifacts",
      "Reuse good work with Skills",
      "Build small apps from chat",
      "Tell us what broke or felt confusing",
    ];
    for (const [index, title] of expectedSteps.entries()) {
      await expect(tour.getByRole("heading", { name: title })).toBeVisible();
      if (index < expectedSteps.length - 1) {
        await tour.getByRole("button", { name: "Next", exact: true }).click();
      }
    }
    await tour.getByRole("button", { name: "Get started" }).click();
    await expect(tour).toHaveCount(0);
    await expect(
      page.locator('[data-app-shell="true"][inert]'),
    ).toHaveCount(0);

    await expect.poll(() => userPatches).toEqual([
      { assistantName: "June" },
      { tourCompleted: true },
    ]);
    expect(userPatches.some((patch) => "onboarding" in patch)).toBe(false);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          step: localStorage.getItem("comparative.wizard.step"),
          name: localStorage.getItem("comparative.wizard.name"),
        })),
      )
      .toEqual({ step: null, name: null });
  });

  test("replays the tour from Settings without repeating setup", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      user: { assistantName: "June" },
    });
    await gotoE2EChat(page);

    const settings = await openSettingsSection(page, "Profile", isMobile);
    await settings.getByRole("button", { name: "Show tour" }).click();

    await expect(
      page
        .getByRole("dialog", { name: "Welcome tour" })
        .getByRole("heading", { name: "Start in chat" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Name your assistant" }),
    ).toHaveCount(0);
  });

  test("keeps setup open when the assistant name cannot be saved", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      user: { assistantName: null, tourCompletedAt: null },
      onUserPatch: async (_body, route) => {
        await route.fulfill({ status: 500, json: { error: "save_failed" } });
      },
    });
    await gotoE2EChat(page);

    const setup = page.getByRole("dialog", { name: "Welcome setup" });
    await setup.getByPlaceholder("Atlas").fill("June");
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(
      setup.getByText("We couldn't save that name. Try again."),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Welcome tour" }),
    ).toHaveCount(0);
    await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
