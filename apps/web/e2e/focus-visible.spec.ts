import { expect, type Locator, type Page, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "focus guardrails run only against the local e2e harness",
);

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press("Tab");
    if (
      await target
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    ) {
      return;
    }
  }
  throw new Error("Target was not reachable within 100 Tab presses");
}

async function expectTokenFocusRing(target: Locator) {
  const presentation = await target.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--focus-ring)";
    document.body.appendChild(probe);
    const ringColor = getComputedStyle(probe).color;
    probe.remove();

    const styles = getComputedStyle(element);
    return {
      boxShadow: styles.boxShadow,
      outlineStyle: styles.outlineStyle,
      ringColor,
    };
  });

  expect(presentation.outlineStyle).toBe("solid");
  expect(presentation.boxShadow).not.toBe("none");
  expect(presentation.boxShadow).toContain(presentation.ringColor);
}

test("keyboard focus remains visible in forced-colors mode", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop keyboard navigation is covered here");
  await page.emulateMedia({ forcedColors: "active" });
  await installMockComparativeApi(page);
  await gotoE2EChat(page);

  const sidebar = await openPrimarySidebar(page, false);
  const target = sidebar.getByRole("button", { name: "New chat" });
  await page.locator("main").click({ position: { x: 8, y: 8 } });
  await tabTo(page, target);

  const presentation = await target.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      boxShadow: styles.boxShadow,
      outlineColor: styles.outlineColor,
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
    };
  });

  expect(presentation.boxShadow).toBe("none");
  expect(presentation.outlineStyle).toBe("solid");
  expect(presentation.outlineWidth).toBe("2px");
  expect(presentation.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(presentation.outlineColor).not.toBe("transparent");
});

for (const skin of ["umber", "classic"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`keyboard focus uses the token ring in ${skin} ${theme} mode`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "desktop keyboard navigation is covered here");
      await page.addInitScript(
        ({ storedSkin, storedTheme }) => {
          localStorage.setItem("ui-skin", storedSkin);
          localStorage.setItem("theme", storedTheme);
        },
        { storedSkin: skin, storedTheme: theme },
      );
      await installMockComparativeApi(page);
      await gotoE2EChat(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (skin === "umber") {
        await expect(page.locator("html")).toHaveClass(/skin-umber/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/skin-umber/);
      }

      const sidebar = await openPrimarySidebar(page, false);
      const composer = page.getByPlaceholder(/ask anything/i);
      const composerRail = composer.locator("xpath=ancestor::form");
      const restingComposerBorder = await composerRail.evaluate(
        (element) => getComputedStyle(element).borderColor,
      );
      const targets = [
        sidebar.getByRole("button", { name: "New chat" }),
        sidebar.getByRole("link", { name: "Skills", exact: true }),
        composer,
      ];

      await page.locator("main").click({ position: { x: 8, y: 8 } });
      for (const target of targets) {
        await tabTo(page, target);
        await expectTokenFocusRing(target);
      }
      await expect
        .poll(() =>
          composerRail.evaluate(
            (element) => getComputedStyle(element).borderColor,
          ),
        )
        .toBe(restingComposerBorder);

      const pointerTarget = sidebar.getByRole("button", { name: "New chat" });
      await pointerTarget.click();
      await expect
        .poll(() =>
          pointerTarget.evaluate(
            (element) => getComputedStyle(element).boxShadow,
          ),
        )
        .toBe("none");
    });
  }
}
