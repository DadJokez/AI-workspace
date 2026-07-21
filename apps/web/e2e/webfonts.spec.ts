import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "webfont guardrails run only against the branch-local build",
);

test("brand font roles resolve without third-party font requests", async ({
  page,
}) => {
  const externalFontRequests: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (
      request.resourceType() === "font" &&
      host !== "127.0.0.1" &&
      host !== "localhost"
    ) {
      externalFontRequests.push(request.url());
    }
  });

  await installMockComparativeApi(page);
  await gotoE2EChat(page);

  const families = await page.evaluate(async () => {
    const probe = document.createElement("div");
    probe.innerHTML = [
      '<span data-font="sans" style="font-family: var(--font-sans)">Sans</span>',
      '<span data-font="serif" style="font-family: var(--font-serif)">Serif</span>',
      '<span data-font="serif-italic" style="font-family: var(--font-serif); font-style: italic">Serif italic</span>',
      '<span data-font="mono" style="font-family: var(--font-mono)">Mono</span>',
    ].join("");
    document.body.append(probe);
    await document.fonts.ready;

    const family = (name: string) =>
      getComputedStyle(
        probe.querySelector(`[data-font="${name}"]`) as HTMLElement,
      ).fontFamily;
    const result = {
      sans: family("sans"),
      serif: family("serif"),
      serifItalic: family("serif-italic"),
      mono: family("mono"),
      localFontUrls: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /\.woff2(?:\?|$)/.test(url)),
    };
    probe.remove();
    return result;
  });

  expect(families.sans).toMatch(/Geist/i);
  expect(families.serif).toMatch(/Newsreader/i);
  expect(families.serifItalic).toMatch(/Newsreader/i);
  expect(families.mono).toMatch(/Geist/i);
  expect(families.localFontUrls.length).toBeGreaterThanOrEqual(4);
  expect(
    families.localFontUrls.every(
      (url) => new URL(url).origin === new URL(page.url()).origin,
    ),
  ).toBe(true);
  expect(externalFontRequests).toEqual([]);
});
