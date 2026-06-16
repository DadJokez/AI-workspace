import { expect, test } from "@playwright/test";
import {
  fulfillSse,
  installMockComparativeApi,
} from "./helpers/mock-comparative";
import { gotoE2EChat } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat shell tests run only against the local e2e harness",
);

test.describe("chat shell guardrails", () => {
  test("blocks empty and whitespace-only submits", async ({ page }) => {
    let chatCalls = 0;
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        chatCalls += 1;
        await fulfillSse(route, [
          { type: "meta", threadId: "thread-empty", modelId: "sonnet-4-6" },
          { type: "text-delta", delta: "This should not be sent." },
          {
            type: "persisted",
            assistantMessageId: "assistant-empty",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await expect(page.getByText(/GitHub is wired up today/)).toBeVisible();

    const input = page.getByPlaceholder(/ask anything/i);
    const send = page.getByRole("button", { name: "Send" });

    await expect(send).toBeDisabled();
    await input.fill("   ");
    await expect(send).toBeDisabled();
    await input.press("Enter");

    expect(chatCalls).toBe(0);
    await expect(page.getByText("This should not be sent.")).toHaveCount(0);
  });

  test("sends suggestions and preserves manual multiline payloads", async ({
    page,
  }) => {
    const chatBodies: Array<Record<string, unknown>> = [];
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        const response =
          chatBodies.length === 1
            ? "Suggestion answer streamed in."
            : "Multiline answer streamed in.";
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-continuity",
            modelId: "haiku-4-5",
          },
          { type: "text-delta", delta: response },
          {
            type: "persisted",
            assistantMessageId: `assistant-${chatBodies.length}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);

    const suggestions = [
      "Open GitHub issues assigned to me — what should I tackle first?",
      "Summarize what shipped in my repos this week",
      "Draft a concise project status update for my team",
      "What can you help me with today?",
    ];
    for (const suggestion of suggestions) {
      await expect(
        page.getByRole("button", { name: suggestion }),
      ).toBeVisible();
    }

    await page
      .getByRole("button", {
        name: "Draft a concise project status update for my team",
      })
      .click();
    const suggestionBubble = page
      .locator("main")
      .locator(".justify-end")
      .filter({
        hasText: "Draft a concise project status update for my team",
      });
    await expect(suggestionBubble).toBeVisible();
    await expect(page.getByText("Suggestion answer streamed in.")).toBeVisible();
    await expect(page.getByText("Thomas · haiku-4-5")).toBeVisible();

    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill("line one");
    await input.press("Shift+Enter");
    await input.pressSequentially("line two");
    await expect(input).toHaveValue("line one\nline two");
    await input.press("Enter");

    const multilineBubble = page
      .locator("main")
      .locator(".whitespace-pre-wrap")
      .filter({ hasText: "line one\nline two" });
    await expect(multilineBubble).toBeVisible();
    await expect(multilineBubble).toHaveText("line one\nline two");
    await expect(page.getByText("Multiline answer streamed in.")).toBeVisible();
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]?.message).toBe(
      "Draft a concise project status update for my team",
    );
    expect(chatBodies[1]?.message).toBe("line one\nline two");
    expect(chatBodies[1]?.threadId).toBe("thread-continuity");
  });

  test("keeps short assistant answers from clipping on the left edge", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-short-answer",
            modelId: "haiku-4-5",
          },
          { type: "text-delta", delta: "42." },
          {
            type: "persisted",
            assistantMessageId: "assistant-short-answer",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill("what is the answer to the universe?");
    await input.press("Enter");

    const answer = page
      .getByTestId("assistant-message-content")
      .filter({ hasText: "42." })
      .last();
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("42.");

    const paintBounds = await answer.evaluate((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const messageColumn = document
        .querySelector('[data-density="messages"]')
        ?.getBoundingClientRect();
      return {
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        left: rect.left,
        columnLeft: messageColumn?.left ?? 0,
      };
    });

    await expect(answer.locator("ol")).toHaveCount(0);
    expect(paintBounds.paddingLeft).toBeGreaterThanOrEqual(1);
    expect(paintBounds.paddingRight).toBeGreaterThanOrEqual(1);
    expect(paintBounds.left).toBeGreaterThan(paintBounds.columnLeft);
  });

  test("keeps top-bar controls, theme persistence, and tab closing behavior stable", async ({
    page,
  }, testInfo) => {
    let calls = 0;
    let releaseFirstResponse: (() => void) | undefined;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        calls += 1;
        if (calls === 1) {
          await firstResponseGate;
        }
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-header-controls",
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: `Shell response ${calls}.` },
          {
            type: "persisted",
            assistantMessageId: `assistant-header-${calls}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page.evaluate(() => window.localStorage.setItem("theme", "light"));
    await page.reload();
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    const header = page.locator("header").first();
    const isMobile = testInfo.project.name.includes("mobile");
    const openMenu = header.getByRole("button", { name: "Open menu" });
    if (isMobile) {
      await expect(openMenu).toBeVisible();
    } else {
      await expect(openMenu).toBeHidden();
    }

    await expect(
      header.getByRole("button", { name: "New tab" }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Download chat transcript" }),
    ).toBeDisabled();
    await expect(
      header.getByRole("button", { name: "Switch to dark mode" }),
    ).toBeVisible();
    await expect(header.getByLabel("Model")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await header.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await expect(
      header.getByRole("button", { name: "Close tab" }),
    ).toHaveCount(0);
    await header.getByRole("button", { name: "New tab" }).click();
    await expect(
      header.getByRole("button", { name: "New chat" }),
    ).toHaveCount(2);
    await expect(
      header.getByRole("button", { name: "Close tab" }),
    ).toHaveCount(2);

    await header.getByRole("button", { name: "Close tab" }).last().click();
    await expect(
      header.getByRole("button", { name: "Close tab" }),
    ).toHaveCount(0);

    await header.getByRole("button", { name: "New tab" }).click();
    await header.getByRole("button", { name: "Close tab" }).first().click();
    await expect(
      header.getByRole("button", { name: "Close tab" }),
    ).toHaveCount(0);

    const longTitlePrompt =
      "make the header state testable with a longer tab title please";
    await page.getByPlaceholder(/ask anything/i).fill(longTitlePrompt);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByPlaceholder("Generating…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(
      header.getByRole("button", { name: "Stop generating" }),
    ).toBeVisible();
    releaseFirstResponse?.();
    await expect(page.getByText("Shell response 1.")).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Download chat transcript" }),
    ).toBeEnabled();
    await expect(
      header.getByRole("button", { name: "make the header state testable w…" }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Regenerate last response" }),
    ).toBeVisible();

    await header
      .getByRole("button", { name: "Regenerate last response" })
      .click();
    await expect(page.getByText("Shell response 2.")).toBeVisible();
    expect(calls).toBe(2);
  });

  test("does not create page-level horizontal overflow", async ({ page }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("mobile drawer opens, closes, and creates a fresh chat", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("mobile"),
      "mobile-only drawer behavior",
    );

    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const sidebar = page.locator('aside[aria-label="Primary"]');
    const openMenu = page.getByRole("button", { name: "Open menu" }).first();

    await expect(sidebar).not.toBeInViewport();
    await openMenu.click();
    await expect(sidebar).toBeInViewport();

    const backdrop = page.getByTestId("sidebar-backdrop");
    await expect(backdrop).toBeVisible();
    const backdropBox = await backdrop.boundingBox();
    expect(backdropBox).toBeTruthy();
    await backdrop.click({
      position: { x: (backdropBox?.width ?? 390) - 8, y: 80 },
    });
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await sidebar.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(sidebar).not.toBeInViewport();
    await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();

    await page.getByRole("button", { name: "Open menu" }).first().click();
    await expect(sidebar).toBeInViewport();
    await sidebar.getByRole("button", { name: "New chat" }).click();
    await expect(sidebar).not.toBeInViewport();
    await expect(page.getByText("Talk to your work.")).toBeVisible();
    await expect(
      page.locator("header").getByRole("button", { name: "New chat" }),
    ).toHaveCount(2);
  });

  test("keeps mobile tab strip scrollable with visible close buttons", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("mobile"),
      "mobile-only tab strip behavior",
    );

    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const header = page.locator("header").first();
    const tabStrip = page.getByTestId("chat-tab-strip");
    for (let i = 0; i < 6; i += 1) {
      await header.getByRole("button", { name: "New tab" }).click();
    }

    const closeButtons = header.getByRole("button", { name: "Close tab" });
    await expect(closeButtons).toHaveCount(7);
    await expect(closeButtons.first()).toBeVisible();

    const firstCloseOpacity = await closeButtons.first().evaluate((element) =>
      window.getComputedStyle(element).opacity,
    );
    expect(Number(firstCloseOpacity)).toBeGreaterThan(0.9);

    const stripMetrics = await tabStrip.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(stripMetrics.scrollWidth).toBeGreaterThan(
      stripMetrics.clientWidth + 1,
    );

    const tabButtons = tabStrip.getByTestId("chat-tab-button");
    await expect(tabButtons).toHaveCount(7);
    const maxScrollLeft = await tabStrip.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    await tabStrip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await tabButtons.first().evaluate((button) => {
      (button as HTMLElement).click();
    });
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeLessThan(maxScrollLeft / 2);
    await expect(tabButtons.first()).toBeInViewport();
    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await tabButtons.last().evaluate((button) => {
      (button as HTMLElement).click();
    });
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(tabButtons.last()).toBeInViewport();

    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });
});
