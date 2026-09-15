import { expect, test } from "@playwright/test";
import { buildAppDataBootstrap } from "../lib/app-data-client-bootstrap";
import { buildIsolatedAppDocument, GENERATED_DOCUMENT_CSP, isolatedAppShellCsp } from "../lib/isolated-app-document";
import { STUDIO_PREVIEW_CSP } from "../lib/isolated-app-document";

const origin = "https://isolation.example.test";
const binding = { id: "allowed", provider: "github", toolName: "list_issues" };
const html = '<h1>Generated app</h1><button onclick="this.textContent=\'Working\'">Run</button>';

test("opaque grant documents do not transmit the private asset cookie", async ({ page, context }) => {
  let grantCookie = "";
  await context.addCookies([{ name: "test_grant", value: "synthetic", domain: "isolation.example.test", path: "/grant/", secure: true, httpOnly: true, sameSite: "Strict" }]);
  await page.route(origin + "/grant/index", (route) => route.fulfill({
    contentType: "text/html", headers: { "content-security-policy": STUDIO_PREVIEW_CSP },
    body: '<h1>Loading</h1><script src="./asset.js"></script>',
  }));
  await page.route(origin + "/grant/asset.js", async (route) => {
    grantCookie = await route.request().headerValue("cookie") ?? "";
    return route.fulfill({
    contentType: "application/javascript", headers: { "cross-origin-resource-policy": "same-origin" },
    body: 'document.querySelector("h1").textContent = "Loaded";',
    });
  });
  await page.goto(origin + "/grant/index");
  await expect(page.getByRole("heading")).toHaveText("Loaded");
  // This is why multi-file sandbox grants must fail closed until hosted separately.
  expect(grantCookie).toBe("");
});

test("generated code stays opaque while only declared bindings can refresh", async ({ page }, testInfo) => {
  const requested: string[] = [];
  await page.route(origin + "/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path === "/app") return route.fulfill({
      contentType: "text/html", headers: { "content-security-policy": isolatedAppShellCsp(true) },
      body: buildIsolatedAppDocument(buildAppDataBootstrap("demo", [binding]) + html, "demo", [binding]),
    });
    return route.fulfill({ json: { state: "ok", ok: true, fetchedAt: new Date().toISOString(), data: { count: 3 } } });
  });
  await page.goto(origin + "/app");
  const content = page.frameLocator("#app");
  await content.getByRole("button", { name: "Run", exact: true }).click();
  await expect(content.getByRole("button", { name: "Working" })).toBeVisible();
  const result = await content.locator("body").evaluate(async () => {
    const client = (window as unknown as { comparativeData: { refresh: (id: string) => Promise<unknown> } }).comparativeData;
    let cookieBlocked = false, parentBlocked = false, storageBlocked = false, fetchBlocked = false;
    try { void document.cookie; } catch { cookieBlocked = true; }
    try { void parent.document.body; } catch { parentBlocked = true; }
    try { void localStorage.length; } catch { storageBlocked = true; }
    try { await fetch("/api/unrelated", { credentials: "include" }); } catch { fetchBlocked = true; }
    const allowed = await client.refresh("allowed");
    const rejected = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
      parent.postMessage({ type: "comparative:data:refresh", bindingId: "../other", appId: "other", url: "/api/unrelated" }, "*", [channel.port2]);
    });
    return { cookieBlocked, parentBlocked, storageBlocked, fetchBlocked, allowed, rejected };
  });
  expect(result).toMatchObject({
    cookieBlocked: true, parentBlocked: true, storageBlocked: true, fetchBlocked: true,
    allowed: { state: "ok", data: { count: 3 } }, rejected: { status: 404 },
  });
  expect(requested).toEqual(["/app", "/api/apps/demo/data/allowed"]);
  await expect(page.getByRole("link", { name: "Manage data connections" })).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("sandbox", "allow-scripts");
  await page.screenshot({ path: testInfo.outputPath("isolated-app.png"), fullPage: true });
});

test("shell rejects top-window messages and authored markup cannot break out", async ({ page }) => {
  let calls = 0;
  const hostile = '</script><script>parent.document.body.dataset.escaped="yes"</script>';
  await page.route(origin + "/app", (route) => route.fulfill({
    contentType: "text/html", headers: { "content-security-policy": isolatedAppShellCsp(true) },
    body: buildIsolatedAppDocument(hostile + html, "demo", [binding]),
  }));
  await page.route("**/api/**", (route) => { calls++; return route.fulfill({ json: {} }); });
  await page.goto(origin + "/app");
  await expect(page.frameLocator("#app").getByRole("heading")).toHaveText("Generated app");
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  const replied = await page.evaluate(async () => {
    const channel = new MessageChannel();
    return new Promise<boolean>((resolve) => {
      channel.port1.onmessage = () => resolve(true);
      window.postMessage({ type: "comparative:data:refresh", bindingId: "allowed" }, "*", [channel.port2]);
      setTimeout(() => { channel.port1.close(); resolve(false); }, 100);
    });
  });
  expect(replied).toBe(false);
  expect(calls).toBe(0);
  await page.evaluate(() => {
    const sibling = document.createElement("iframe");
    sibling.id = "sibling";
    sibling.sandbox.add("allow-scripts");
    sibling.srcdoc = "<p>Sibling</p>";
    document.body.append(sibling);
  });
  const siblingReplied = await page.frameLocator("#sibling").locator("body").evaluate(async () => {
    const channel = new MessageChannel();
    return new Promise<boolean>((resolve) => {
      channel.port1.onmessage = () => resolve(true);
      parent.postMessage({ type: "comparative:data:refresh", bindingId: "allowed" }, "*", [channel.port2]);
      setTimeout(() => { channel.port1.close(); resolve(false); }, 100);
    });
  });
  expect(siblingReplied).toBe(false);
  expect(calls).toBe(0);
});

for (const [name, policy] of [["version", GENERATED_DOCUMENT_CSP], ["studio-grant", STUDIO_PREVIEW_CSP]]) {
  test(name + " stays isolated when opened directly", async ({ page }) => {
    await page.route(origin + "/preview", (route) => route.fulfill({
      contentType: "text/html", headers: { "content-security-policy": policy! }, body: html,
    }));
    await page.goto(origin + "/preview");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Working" })).toBeVisible();
    expect(await page.evaluate(async () => {
      let cookieBlocked = false, fetchBlocked = false;
      try { void document.cookie; } catch { cookieBlocked = true; }
      try { await fetch("/api/unrelated", { credentials: "include" }); } catch { fetchBlocked = true; }
      return { cookieBlocked, fetchBlocked };
    })).toEqual({ cookieBlocked: true, fetchBlocked: true });
  });
}
