import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  fulfillSse,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked queue tests run only against the local e2e harness",
);

test("keeps send disabled until profile-backed composer state is ready", async ({
  page,
}) => {
  const userGate = deferred();
  await installMockComparativeApi(page, {
    beforeUserGet: () => userGate.promise,
  });

  await page.goto("/e2e/chat");
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Starting Comparative...",
  );
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute("data-composer-ready", "false");
  await composer.fill("Freshly ready follow-up");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  userGate.resolve();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute("data-composer-ready", "true");
  await expect(composer).toHaveValue("Freshly ready follow-up");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("queues editable follow-ups and promotes exactly one turn at a time", async ({
  page,
}) => {
  await installMockComparativeApi(page);
  await page.addInitScript(() => {
    type PendingStream = {
      controller: ReadableStreamDefaultController<Uint8Array>;
      call: number;
    };
    type QueueHarness = {
      bodies: Array<Record<string, unknown>>;
      pending: PendingStream[];
      finishNext: () => boolean;
    };
    const browser = window as typeof window & { __queueHarness?: QueueHarness };
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const event = (value: unknown) =>
      encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const harness: QueueHarness = {
      bodies: [],
      pending: [],
      finishNext() {
        const pending = harness.pending.shift();
        if (!pending) return false;
        pending.controller.enqueue(
          event({ type: "text-delta", delta: `Done ${pending.call}.` }),
        );
        pending.controller.enqueue(
          event({
            type: "persisted",
            assistantMessageId: `assistant-${pending.call}`,
            artifacts: [],
            recommendations: [],
          }),
        );
        pending.controller.enqueue(
          event({ type: "done", stopReason: "completed" }),
        );
        pending.controller.close();
        return true;
      },
    };
    browser.__queueHarness = harness;

    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      const path = new URL(requestUrl, window.location.origin).pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (path !== "/api/chat" || method !== "POST") {
        return originalFetch(input, init);
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      harness.bodies.push(body);
      const call = harness.bodies.length;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              event({
                type: "meta",
                threadId: "00000000-0000-4000-8000-000000000737",
                runId: `00000000-0000-4000-8000-${String(call).padStart(12, "0")}`,
                userMessageId:
                  typeof body.clientMessageId === "string"
                    ? body.clientMessageId
                    : "00000000-0000-4000-8000-000000000001",
                modelId: "sonnet-4-6",
                runtimeRoute: { useWorker: false, lane: "fast-local" },
              }),
            );
            harness.pending.push({ controller, call });
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    };
  });

  await gotoE2EChat(page);
  const composer = page.getByRole("textbox");
  await composer.fill("Start the analysis");
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as typeof window & {
            __queueHarness?: { bodies: unknown[] };
          }
        ).__queueHarness?.bodies.length ?? 0,
      ),
    )
    .toBe(1);

  for (const followUp of [
    "Follow-up one",
    "Follow-up two",
    "Follow-up three",
    "Follow-up four",
  ]) {
    await composer.fill(followUp);
    await page.getByRole("button", { name: "Queue follow-up" }).click();
  }
  const rows = page.getByTestId("queued-turn");
  await expect(rows).toHaveCount(4);
  await expect(
    page
      .getByTestId("chat-scroll-region")
      .getByText("Follow-up one", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .getByTestId("chat-turn-queue")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);

  await page
    .getByRole("button", { name: "Edit Follow-up two" })
    .click();
  const editBox = page.getByRole("textbox", { name: "Edit queued follow-up" });
  await editBox.fill("Follow-up two revised");
  await page.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("button", { name: "Move Follow-up four up" })
    .click();
  await page
    .getByRole("button", { name: "Delete Follow-up one" })
    .click();
  await rows
    .filter({ hasText: "Follow-up three" })
    .getByRole("button", { name: "Apply now", exact: true })
    .click();

  await expect(
    page.getByText(
      "Live steering is not available for this run. This follow-up will send next.",
    ),
  ).toBeVisible();
  await expect
    .poll(() =>
      rows.evaluateAll((items) =>
        items.map((item) => item.querySelector("p")?.textContent),
      ),
    )
    .toEqual(["Follow-up three", "Follow-up two revised", "Follow-up four"]);
  await page
    .getByRole("button", { name: "Edit Follow-up three" })
    .click();
  await page
    .getByRole("textbox", { name: "Edit queued follow-up" })
    .fill("Follow-up three pinned");

  await page.evaluate(() => {
    const browser = window as typeof window & {
      __queueHarness?: { finishNext: () => boolean };
    };
    browser.__queueHarness?.finishNext();
  });
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __queueHarness?: { bodies: unknown[] };
        }
      ).__queueHarness?.bodies.length ?? 0,
    ),
  ).toBe(1);
  await page.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as typeof window & {
            __queueHarness?: { bodies: unknown[] };
          }
        ).__queueHarness?.bodies.length ?? 0,
      ),
    )
    .toBe(2);
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __queueHarness?: { bodies: unknown[] };
        }
      ).__queueHarness?.bodies.length ?? 0,
    ),
  ).toBe(2);

  for (const expectedMessage of [
    "Follow-up two revised",
    "Follow-up four",
  ]) {
    await page.evaluate(() => {
      const browser = window as typeof window & {
        __queueHarness?: { finishNext: () => boolean };
      };
      browser.__queueHarness?.finishNext();
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bodies = (
            window as typeof window & {
              __queueHarness?: { bodies: Array<Record<string, unknown>> };
            }
          ).__queueHarness?.bodies;
          return bodies?.at(-1)?.message;
        }),
      )
      .toBe(expectedMessage);
  }
  await page.evaluate(() => {
    const browser = window as typeof window & {
      __queueHarness?: { finishNext: () => boolean };
    };
    browser.__queueHarness?.finishNext();
  });
  await expect(page.getByTestId("chat-turn-queue")).toHaveCount(0);

  const queuedBodies = await page.evaluate(() =>
    (
      window as typeof window & {
        __queueHarness?: { bodies: Array<Record<string, unknown>> };
      }
    ).__queueHarness?.bodies.slice(1),
  );
  expect(queuedBodies?.map((body) => body.message)).toEqual([
    "Follow-up three pinned",
    "Follow-up two revised",
    "Follow-up four",
  ]);
  for (const body of queuedBodies ?? []) {
    expect(body.clientMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
});

test("keeps queued follow-ups through reload while the selected run is active", async ({
  page,
  isMobile,
}) => {
  const threadId = "00000000-0000-4000-8000-000000000738";
  const runId = "00000000-0000-4000-8000-000000000739";
  const title = "Reloadable queue";
  await installMockComparativeApi(page, {
    threads: [threadSummary(threadId, title)],
    threadMessages: {
      [threadId]: [
        userMessage({ content: "Keep working" }),
        assistantMessage({
          id: `run:${runId}`,
          content: "",
          pending: true,
          runId,
          runStatus: "running",
          status: "Working...",
        }),
      ],
    },
    runStatuses: {
      [runId]: {
        id: runId,
        status: "running",
        latestEventSequence: 1,
        liveTokens: 12,
      },
    },
  });
  let chatRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/chat") chatRequests += 1;
  });

  await gotoE2EChat(page);
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: title }).click();
  const composer = page.getByRole("textbox");
  await expect(page.getByRole("button", { name: "Queue follow-up" })).toBeVisible();
  for (const message of ["Persisted follow-up A", "Persisted follow-up B"]) {
    await composer.fill(message);
    await page.getByRole("button", { name: "Queue follow-up" }).click();
  }
  await expect(page.getByTestId("queued-turn")).toHaveCount(2);

  await page.reload();
  await expect(page.getByTestId("queued-turn")).toHaveCount(2);
  await expect(page.getByText("Persisted follow-up A", { exact: true })).toBeVisible();
  await expect(page.getByText("Persisted follow-up B", { exact: true })).toBeVisible();
  expect(chatRequests).toBe(0);
});

test("keeps a pre-accept failure in its original chat after switching", async ({
  page,
  isMobile,
}) => {
  const firstThreadId = "00000000-0000-4000-8000-000000000741";
  const secondThreadId = "00000000-0000-4000-8000-000000000742";
  const responses = [deferred(), deferred()];
  const bodies: Array<Record<string, unknown>> = [];
  await installMockComparativeApi(page, {
    threads: [
      threadSummary(firstThreadId, "Original queue"),
      threadSummary(secondThreadId, "Other work"),
    ],
    threadMessages: {
      [firstThreadId]: [],
      [secondThreadId]: [],
    },
    onChat: async (body, route) => {
      const call = bodies.push(body);
      await responses[call - 1]!.promise;
      await fulfillSse(route, [
        {
          type: "meta",
          threadId: firstThreadId,
          runId: `00000000-0000-4000-8000-${String(call).padStart(12, "0")}`,
          userMessageId:
            typeof body.clientMessageId === "string"
              ? body.clientMessageId
              : "00000000-0000-4000-8000-000000000743",
          modelId: "sonnet-4-6",
          runtimeRoute: { useWorker: false, lane: "fast-local" },
        },
        { type: "text-delta", delta: `Completed ${call}.` },
        {
          type: "persisted",
          assistantMessageId: `assistant-scope-${call}`,
          artifacts: [],
          recommendations: [],
        },
        { type: "done", stopReason: "completed" },
      ]);
    },
  });

  await gotoE2EChat(page);
  let sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: "Original queue" }).click();
  const composer = page.getByRole("textbox");
  await composer.fill("Start scoped work");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await composer.fill("Keep this with the original chat");
  await page.getByRole("button", { name: "Queue follow-up" }).click();

  responses[0]!.resolve();
  await expect.poll(() => bodies.length).toBe(2);
  sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: "Other work" }).click();
  await expect(page.getByTestId("chat-turn-queue")).toHaveCount(0);

  responses[1]!.resolve();
  await expect
    .poll(() =>
      page.evaluate((threadId) => {
        const suffix = `thread:${threadId}`;
        const key = Object.keys(window.localStorage).find((candidate) =>
          candidate.endsWith(suffix),
        );
        return key ? window.localStorage.getItem(key) : null;
      }, firstThreadId),
    )
    .toContain('"status":"failed"');
  sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: "Original queue" }).click();
  await expect(page.getByTestId("chat-turn-queue")).toBeVisible();
  await expect(
    page.getByText(
      "This follow-up was not accepted. Try it again when the connection is ready.",
    ),
  ).toBeVisible();
  expect(bodies[1]?.clientMessageId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("keeps a rejected promotion for an idempotent retry", async ({ page }) => {
  await installMockComparativeApi(page);
  await page.addInitScript(() => {
    type RetryHarness = {
      bodies: Array<Record<string, unknown>>;
      finishFirst: () => boolean;
      firstController?: ReadableStreamDefaultController<Uint8Array>;
    };
    const browser = window as typeof window & { __retryHarness?: RetryHarness };
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const event = (value: unknown) =>
      encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const harness: RetryHarness = {
      bodies: [],
      finishFirst() {
        if (!harness.firstController) return false;
        harness.firstController.enqueue(
          event({ type: "text-delta", delta: "Initial work complete." }),
        );
        harness.firstController.enqueue(
          event({
            type: "persisted",
            assistantMessageId: "assistant-initial",
            artifacts: [],
            recommendations: [],
          }),
        );
        harness.firstController.enqueue(
          event({ type: "done", stopReason: "completed" }),
        );
        harness.firstController.close();
        harness.firstController = undefined;
        return true;
      },
    };
    browser.__retryHarness = harness;

    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      const path = new URL(requestUrl, window.location.origin).pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (path !== "/api/chat" || method !== "POST") {
        return originalFetch(input, init);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      harness.bodies.push(body);
      const call = harness.bodies.length;
      if (call === 2) {
        return new Response(
          JSON.stringify({
            error: "temporarily_unavailable",
            message: "Temporary queue failure.",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (call > 2) {
        return new Response(
          [
            {
              type: "meta",
              threadId: "00000000-0000-4000-8000-000000000737",
              runId: body.clientMessageId,
              userMessageId: body.clientMessageId,
              modelId: "sonnet-4-6",
              runtimeRoute: { useWorker: false, lane: "fast-local" },
            },
            { type: "text-delta", delta: "Retry accepted." },
            {
              type: "persisted",
              assistantMessageId: "assistant-retry",
              artifacts: [],
              recommendations: [],
            },
            { type: "done", stopReason: "completed" },
          ]
            .map((value) => `data: ${JSON.stringify(value)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            harness.firstController = controller;
            controller.enqueue(
              event({
                type: "meta",
                threadId: "00000000-0000-4000-8000-000000000737",
                runId: "00000000-0000-4000-8000-000000000701",
                userMessageId: "00000000-0000-4000-8000-000000000702",
                modelId: "sonnet-4-6",
                runtimeRoute: { useWorker: false, lane: "fast-local" },
              }),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    };
  });

  await gotoE2EChat(page);
  const composer = page.getByRole("textbox");
  await composer.fill("Start a long task");
  await page.getByRole("button", { name: "Send" }).click();
  await composer.fill("Retry this follow-up");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await page.evaluate(() => {
    const browser = window as typeof window & {
      __retryHarness?: { finishFirst: () => boolean };
    };
    browser.__retryHarness?.finishFirst();
  });

  await expect(
    page.getByRole("button", { name: "Retry Retry this follow-up" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("chat-scroll-region")
      .getByText("Retry this follow-up", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry Retry this follow-up" })
    .click();
  await expect(page.getByTestId("chat-turn-queue")).toHaveCount(0);

  const retryIds = await page.evaluate(() => {
    const bodies = (
      window as typeof window & {
        __retryHarness?: { bodies: Array<Record<string, unknown>> };
      }
    ).__retryHarness?.bodies;
    return bodies?.slice(1).map((body) => body.clientMessageId);
  });
  expect(retryIds).toHaveLength(2);
  expect(retryIds?.[0]).toBe(retryIds?.[1]);
});

function threadSummary(id: string, title: string) {
  return {
    id,
    title,
    pinned: false,
    defaultModelId: "sonnet-4-6",
    previewSummary: null,
    previewSummaryUpdatedAt: null,
    titleSource: "auto",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
