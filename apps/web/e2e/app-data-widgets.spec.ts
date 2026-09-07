import { expect, test, type Page } from "@playwright/test";
import { buildAppDataBootstrap, injectAppDataBootstrap } from "../lib/app-data-bootstrap";
import { injectAppPublicationBadge, type AppPublicationMetadata } from "../lib/app-publication";
import type { AppDataResponse } from "../lib/app-data-response";

const fetchedAt = "2026-09-07T01:00:00.000Z";
const bindings = [
  { id: "pipeline", provider: "salesforce", toolName: "run_soql" },
  { id: "issues", provider: "github", toolName: "list_issues" },
];
const publication: AppPublicationMetadata = {
  schema: "app-publication.v1", dataMode: "live_via_viewer", audience: "named",
  publishedAt: fetchedAt, publishedByUserId: "author",
  connectorManifest: bindings.map((b) => ({
    provider: b.provider, toolName: b.toolName,
    catalogKey: `${b.provider}:${b.toolName}`, bindingIds: [b.id],
  })),
};

async function openWidgets(page: Page, theme = "light") {
  const html = injectAppPublicationBadge(injectAppDataBootstrap(
    `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0"><main style="padding:16px"><h1>My work</h1>
    <section id="pipeline">BUILDER DATA MUST DISAPPEAR</section>
    <section id="issues">OTHER VIEWER DATA MUST DISAPPEAR</section></main></body></html>`,
    buildAppDataBootstrap("demo", bindings),
  ), { publication, authorName: "Brittany" });
  await page.route("https://app-data.example.test/widgets", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto("https://app-data.example.test/widgets");
}

async function refresh(page: Page, id: string) {
  return page.evaluate(async (bindingId) => {
    const client = (window as unknown as { comparativeData: {
      refreshWidget: (id: string, element: Element, render: (data: unknown) => string) => Promise<AppDataResponse>;
    } }).comparativeData;
    return client.refreshWidget(bindingId, document.getElementById(bindingId)!, (data) => JSON.stringify(data));
  }, id);
}

for (const theme of ["light", "dark"]) {
  test(`independent connected/unconnected widgets and viewer badge in ${theme}`, async ({ page }, testInfo) => {
    await page.route("**/api/apps/demo/data/*", (route) => route.fulfill({ json: route.request().url().endsWith("pipeline")
      ? { state: "ok", ok: true, data: { total: 42 }, fetchedAt }
      : { state: "needs_connection", ok: false, provider: "github", connectUrl: "/chat?open=settings&section=integrations" },
    }));
    await openWidgets(page, theme);
    await refresh(page, "pipeline");
    await refresh(page, "issues");
    await expect(page.locator("#pipeline")).toContainText('"total":42');
    await expect(page.locator("#pipeline time")).toHaveAttribute("datetime", fetchedAt);
    await expect(page.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute("href", "/chat?open=settings&section=integrations");
    await expect(page.locator("#issues time")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("MUST DISAPPEAR");
    const badge = page.locator("#comparative-publication-badge");
    await expect(badge).toContainText("Live data — shown with your access");
    await expect(badge.locator("[title]")).toHaveAttribute("title", /Others may see different numbers/);
    const layout = await badge.evaluate((el) => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    }));
    expect(layout.width).toBeLessThanOrEqual(layout.viewport);
    expect(layout.background).not.toBe(layout.color);
    if (theme === "dark") expect(layout.background).not.toBe("rgb(255, 255, 255)");
    await page.screenshot({ path: testInfo.outputPath(`widgets-${theme}.png`), fullPage: true });
  });
}

test("a failed refresh removes previous data without affecting a sibling", async ({ page }) => {
  let failed = false;
  await page.route("**/api/apps/demo/data/*", (route) => route.fulfill(failed && route.request().url().endsWith("pipeline")
    ? { status: 502, json: { error: "PRIVATE UPSTREAM ARGUMENT" } }
    : { json: { state: "ok", ok: true, data: { total: 42 }, fetchedAt } }));
  await openWidgets(page);
  await refresh(page, "pipeline");
  await refresh(page, "issues");
  failed = true;
  const result = await refresh(page, "pipeline");
  expect(result.state).toBe("error");
  await expect(page.locator("#pipeline")).toHaveText("This data could not be refreshed.");
  await expect(page.locator("#pipeline time")).toHaveCount(0);
  await expect(page.locator("#issues")).toContainText('"total":42');
  await expect(page.locator("body")).not.toContainText("PRIVATE UPSTREAM");
});

for (const failure of ["network", "invalid-json", "invalid-timestamp", "unauthenticated"]) {
  test(`normalizes ${failure} into a scoped error without fallback`, async ({ page }) => {
    await page.route("**/api/apps/demo/data/*", (route) => {
      if (failure === "network") return route.abort();
      if (failure === "invalid-json") return route.fulfill({ body: "not JSON", contentType: "application/json" });
      if (failure === "unauthenticated") return route.fulfill({ status: 401 });
      return route.fulfill({ json: { state: "ok", ok: true, data: { leaked: true }, fetchedAt: "invalid" } });
    });
    await openWidgets(page);
    const result = await refresh(page, "pipeline");
    expect(result.state).toBe("error");
    await expect(page.locator("#pipeline")).not.toContainText("BUILDER");
    await expect(page.locator("#pipeline")).not.toContainText("leaked");
    await expect(page.locator("#pipeline time")).toHaveCount(0);
    await expect(page.locator("#pipeline")).not.toHaveAttribute("aria-busy");
  });
}

test("older in-flight responses cannot resurrect data after a newer connection failure", async ({ page }) => {
  let release!: () => void;
  let first = true;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/apps/demo/data/pipeline", async (route) => {
    if (first) {
      first = false;
      await blocked;
      return route.fulfill({ json: { state: "ok", ok: true, data: { total: 42 }, fetchedAt } });
    }
    return route.fulfill({ json: { state: "needs_connection", provider: "salesforce" } });
  });
  await openWidgets(page);
  const older = refresh(page, "pipeline");
  await expect(page.locator("#pipeline")).toBeEmpty();
  await expect(page.locator("#pipeline")).toHaveAttribute("aria-busy", "true");
  await refresh(page, "pipeline");
  release();
  await older;
  await expect(page.locator("#pipeline")).toHaveText("Connect Salesforce");
  await expect(page.locator("#pipeline time")).toHaveCount(0);
});
