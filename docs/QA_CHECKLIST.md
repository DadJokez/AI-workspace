# QA Checklist — AI Hub web

A manual + automation-ready regression list for the chat app. Each item is
"do X → expect Y." Items tagged `[AUTOMATE]` are good Playwright candidates;
unmarked items need a human eye for visual / device-specific verification.

**Test URL (live):** https://vacwacwrxu.us-east-1.awsapprunner.com
**Local dev:** `cd apps/web && pnpm dev` → http://localhost:3000

---

## Core Chat

- [ ] **`[AUTOMATE]` Empty state renders.** Open `/chat` with no prior thread → expect heading "Talk to your work", a paragraph below it, and three suggestion pills ("Summarize…", "Draft a quick reply…", "What are my unread Slack…").
- [ ] **`[AUTOMATE]` Suggestion pill sends.** Click any of the three suggestion pills → expect (a) the pill text appears as a user message right-aligned, (b) "Generating…" placeholder shown in the input, (c) an assistant response streams in below.
- [ ] **`[AUTOMATE]` Manual send.** Type "Hello" in the input box, press Enter → expect a user bubble on the right with "Hello", followed by an assistant response.
- [ ] **`[AUTOMATE]` Shift+Enter inserts newline.** Type "line one", press Shift+Enter, type "line two", press Enter → expect the user bubble to render two lines.
- [ ] **`[AUTOMATE]` Empty submit is blocked.** Click the send button with an empty input → expect nothing happens (no message added). Type only spaces and press Enter → expect nothing happens.
- [ ] **`[AUTOMATE]` Send disabled while busy.** While a response is streaming, the placeholder reads "Generating…" and the send button is dim/disabled.
- [ ] **Streaming is visible.** During a response, expect text to appear progressively (not all at once), with a thin pulsing caret at the end while pending.
- [ ] **Auto-scroll follows the stream.** Send a long message that produces a long response → expect the view to keep scrolling so the latest text stays in view.
- [ ] **`[AUTOMATE]` Conversation continuity.** After one exchange, send a follow-up like "what did I just ask?" → expect the assistant to reference your previous message (proves `threadId` is passed back).
- [ ] **Markdown rendering (assistant only).** Ask the model to "reply with a bullet list of three items" → expect a real `<ul>` with bullets, not raw `*` characters. Same for `**bold**`, `# heading`, ` ```code``` ` blocks.
- [ ] **User bubbles do NOT render markdown.** Type literally `**bold**` and send → expect the user bubble shows the asterisks as plain text.
- [ ] **`[AUTOMATE]` Model label appears.** After an assistant response, expect a small "Assistant · {modelId}" label above the answer (e.g. "Assistant · sonnet-4-6").

## Run Lifecycle

- [ ] **`[AUTOMATE]` Chat turns create durable runs.** Send a prompt → expect `/api/chat` to return a run id in the stream metadata and `/admin/runs` to show a matching `chat-turn` row.
- [ ] **`[AUTOMATE]` Running chat turn can be canceled.** Start a long-running prompt and click "Cancel" on the assistant run controls → expect the message to move out of pending state, `recipe_runs.status = canceled`, and a `run_cancel` audit row.
- [ ] **`[AUTOMATE]` Failed/canceled chat turn can be retried.** Force a chat run failure or cancel one, then click "Retry" → expect a new queued run linked to the prior run and the thread to continue with the original prompt.
- [ ] **Admin resume/reconcile is available.** As an admin, open `/admin/runs/[id]` for a queued/running `chat-turn` run → expect "Resume" to be available and to write a resume event/audit row when clicked.
- [ ] **Refresh preserves activity state.** During a long-running chat turn, refresh the browser → expect the pending run and compact activity timeline to reload from `run_events`.

---

## UI / Layout

- [ ] **Sidebar visible on desktop ≥ md (768px).** Resize window to 1024px width → expect the left sidebar to be persistently visible, no hamburger button shown.
- [ ] **Top bar single row.** At every viewport width from 320px → 1440px, the top bar should remain on one horizontal row (no wrapping).
- [ ] **`[AUTOMATE]` Top bar contains the right elements.** Inspect the `<header>` of `/chat` → expect: hamburger (mobile only), tab list, "+" new-tab button, model selector, theme toggle.
- [ ] **`[AUTOMATE]` Empty-state suggestions clickable.** Each of the three suggestion pills has role=button and is focusable via Tab.
- [ ] **No horizontal overflow.** At 320px, 375px, 414px, 768px, 1280px viewports → expect `document.documentElement.scrollWidth === clientWidth` (no horizontal scrollbar at the page level).
- [ ] **Hairline borders only.** Visual inspection: no drop shadows, no gradients, dividers are 1px lines using `--color-hairline`.
- [ ] **Notion palette in light mode.** Background tone should be off-white (#F7F6F3-ish), not pure white. Hairlines visible but soft.
- [ ] **Active sidebar item highlight.** Click any sidebar nav item → expect a subtle filled background (`bg-subtle`) on it; previously active item loses the highlight. **Note:** these items are cosmetic only — they don't navigate (see Punch List).

---

## Dark Mode

- [ ] **`[AUTOMATE]` Theme toggle exists.** Find the sun/moon icon button in the top-right of the chat top bar.
- [ ] **`[AUTOMATE]` Toggle flips theme.** Click theme toggle → expect `<html>` to gain or lose the `dark` class. Background and surfaces swap palette accordingly. Click again → expect it to flip back.
- [ ] **`[AUTOMATE]` Theme persists across reload.** Set theme to dark, hard-reload `/chat` → expect the app to load already in dark mode (no flash of light theme).
- [ ] **No flash of unstyled / wrong theme on load.** Visual: open app cold (cleared cache) → expect the correct theme paints from the very first frame.
- [ ] **Dark palette correctness.** In dark mode: canvas ≈ `#191919`, sidebar ≈ `#1F1F1F`, surface ≈ `#252525`, hairline ≈ `#2D2D2D`, ink ≈ `#E5E5E5`. Not pure black.
- [ ] **All text legible in both themes.** Visual scan: scrollbar, placeholder text, model selector, message timestamps, pending caret all readable in both modes.
- [ ] **Markdown code blocks themed.** Ask for a fenced code block → expect the `<pre>` background uses the theme's `bg-subtle` (not hardcoded black/white), and inline `code` follows suit.
- [ ] **System preference honored on first visit.** Clear localStorage, set OS to dark mode, visit `/chat` → expect dark theme applied. Switch OS to light, clear storage, reload → expect light.

---

## Mobile (viewport < 768px)

- [ ] **`[AUTOMATE]` Sidebar hidden by default.** At 375px width, on first load → sidebar is offscreen, hamburger visible at top-left of header.
- [ ] **`[AUTOMATE]` Hamburger opens drawer.** Tap the hamburger → expect sidebar slides in from the left, dark backdrop covers the rest of the screen.
- [ ] **`[AUTOMATE]` Backdrop tap closes drawer.** With drawer open, tap anywhere on the dimmed area → expect drawer slides out, backdrop fades away.
- [ ] **`[AUTOMATE]` X button closes drawer.** With drawer open, tap the X in the user header inside the sidebar → expect drawer closes.
- [ ] **`[AUTOMATE]` Escape key closes drawer.** With drawer open and focus anywhere on page, press Escape → drawer closes.
- [ ] **`[AUTOMATE]` Tapping a nav item closes drawer.** Open drawer, tap "Tools" or "Vault" → expect drawer closes and the active highlight in the sidebar moves to the selected section.
- [ ] **`[AUTOMATE]` Vault renders seeded profile.** Open "Vault" from the sidebar → expect the Vault panel to show the seeded employee profile, responsibilities, priorities, systems context, and agent context sections in the active theme.
- [ ] **`[AUTOMATE]` "New chat" from drawer closes drawer + opens new tab.** Tap "New chat" inside the drawer → expect drawer closes AND a new empty tab appears in the tab strip, becomes active.
- [ ] **Touch targets ≥ 44px.** Visual/measurement: hamburger, X close, sidebar nav items, "New chat", and send button all measure ≥ 44px tall in mobile mode.
- [ ] **Tab strip scrolls horizontally.** Open 4–5 tabs on a 375px viewport → expect the tabs container scrolls horizontally, the active tab stays visible after switching.
- [ ] **Tab close buttons visible without hover on mobile.** With multiple tabs at < md, each tab shows its X icon at all times. (At ≥ md, the X is hidden and only appears on hover.)
- [ ] **`[AUTOMATE]` Input not zoomed on focus (iOS).** On Safari iOS, tap into the textarea → expect the page does NOT auto-zoom (textarea font is 16px on mobile to suppress this).
- [ ] **Input bar pinned to bottom.** Visually verify on iPhone Safari with the URL bar collapsed and expanded: input bar always touches the visible bottom edge.
- [ ] **Input bar above keyboard.** Tap into the textarea on iPhone → expect the input bar to remain visible above the on-screen keyboard. (Caveat: iOS Safari behavior with `dvh` is best-effort; the message list above the input may shrink.)
- [ ] **Model selector compact on mobile.** At < sm width, the "Model" label disappears and only the dropdown shows, capped at ~128px wide.
- [ ] **Padding tight but not cramped.** Messages and input use 16px (`px-4`) horizontal padding on mobile, 24px (`px-6`) on desktop.
- [ ] **`[AUTOMATE]` No body scroll while drawer open.** Open drawer at 375px, attempt to scroll the page underneath → expect the underlying chat area does not scroll. (Note: not currently locked — see Punch List.)

---

## Tabs

- [ ] **`[AUTOMATE]` Initial state has one tab named "New chat".** Fresh page load → expect exactly one tab with the title "New chat", input is enabled.
- [ ] **`[AUTOMATE]` "+" button creates a new tab.** Click "+" → expect a new tab labelled "New chat" appears to the right and becomes active.
- [ ] **`[AUTOMATE]` Each tab has independent messages.** Send "tab A" in tab 1, switch to tab 2, send "tab B" in tab 2, switch back to tab 1 → expect tab 1 still shows "tab A" and its assistant response only; tab 2 shows "tab B" and its response only.
- [ ] **`[AUTOMATE]` Each tab has independent threadId.** After sending in two tabs, inspect Network → expect each tab's requests use different `threadId` values.
- [ ] **`[AUTOMATE]` Tab title auto-derives from first message.** Send "What is in my email?" in a fresh tab → expect the tab title becomes "What is in my email?" (truncated at 32 chars + `…` if longer).
- [ ] **Tab title doesn't change after the first message.** Send a second message in the same tab → expect the tab title remains the original.
- [ ] **`[AUTOMATE]` Switching tabs while one is busy.** While tab 1 is generating, switch to tab 2 → expect tab 2's input is enabled (independent busy state); switching back to tab 1 still shows pending state and incoming text.
- [ ] **`[AUTOMATE]` Busy indicator dot.** A tab with a request in flight shows a small pulsing dot to the left of its title. The dot disappears when the response finishes.
- [ ] **`[AUTOMATE]` Closing a tab.** Click X on a non-active tab → expect that tab disappears, active tab stays.
- [ ] **`[AUTOMATE]` Closing the active tab.** Click X on the active tab (when others exist) → expect the previous tab (left neighbor, falling back to first) becomes active.
- [ ] **Last tab cannot be closed.** With only one tab open, expect no X button is shown on it.
- [ ] **Per-tab model selection.** In tab 1 select Sonnet, in tab 2 select Haiku → switch between tabs and expect the model selector in the top bar reflects each tab's choice.
- [ ] **Tabs persist across reload.** Open 3 tabs, refresh the page → expect the same tab set and active tab to return from local storage. Server-side threads still remain the source of truth for persisted conversations.

---

## Error States

- [ ] **`[AUTOMATE]` API 4xx/5xx surfaces.** Use devtools to block `/api/chat` (or stop the dev server) and try to send → expect an error banner above the input ("HTTP 5xx" or similar) and the assistant placeholder shows "(error)".
- [ ] **Models endpoint failure.** Block `/api/models` → expect placeholder reads "Loading models…" forever and the input remains disabled. (Currently no user-facing surface — see Punch List.)
- [ ] **`[AUTOMATE]` Unauthorized response.** Force `/api/chat` to return 401 → expect the error banner shows the server's message.
- [ ] **`[AUTOMATE]` Stream interrupted mid-response.** Kill the connection during streaming (devtools offline toggle) → expect pending=false eventually, partial content remains in the assistant bubble.
- [ ] **`[AUTOMATE]` Resending after an error.** After a failed send, type a new message and Enter → expect a fresh request fires.
- [ ] **Thread ownership / 404.** Manipulate localStorage / send a stale `threadId` → API returns 404 thread_not_found, error surfaces in the banner.
- [ ] **Retry button appears after a failed send.** Force a `/api/chat` failure → expect the error card to show a "Try again" button that resends the failed user message.

---

## API / Health

- [ ] **`[AUTOMATE]` `/api/health` returns dependency checks.** `curl https://vacwacwrxu.us-east-1.awsapprunner.com/api/health` → expect `status`, `service`, `timestamp`, and `checks.db` / `checks.runtime`.
- [ ] **`[AUTOMATE]` `/api/health` reports DB connectivity.** Response includes `checks.db.ok = true` and numeric `checks.db.latencyMs`.
- [ ] **`[AUTOMATE]` `/api/health` reports runtime configuration.** Response includes `checks.runtime.name`, `checks.runtime.configured`, and no secret values.
- [ ] **`[AUTOMATE]` `/api/me` returns the current user.** `curl …/api/me` (with auth) → `{"user":{"id":"…","email":"…","displayName":"…"}}`.
- [ ] **`[AUTOMATE]` `/api/models` returns model list + default.** `curl …/api/models` → `{"defaultModelId":"…","models":[…]}` with at least one entry containing `id`, `displayName`, `costPer1MInput`, `costPer1MOutput`.
- [ ] **`[AUTOMATE]` `/api/chat` rejects empty body.** POST `{}` → 400 `missing_message`.
- [ ] **`[AUTOMATE]` `/api/chat` rejects invalid JSON.** POST `not-json` with `Content-Type: application/json` → 400 `invalid_json`.
- [ ] **`[AUTOMATE]` `/api/chat` rejects unauthenticated requests.** POST without auth → 401 `unauthorized`.
- [ ] **`[AUTOMATE]` `/api/chat` rejects oversized messages.** POST a message longer than `CHAT_MAX_MESSAGE_CHARS` → 413 `message_too_large`.
- [ ] **`[AUTOMATE]` `/api/chat` rate-limits bursts.** Send more than `CHAT_RATE_LIMIT_REQUESTS` requests in `CHAT_RATE_LIMIT_WINDOW_MS` for one user → 429 `rate_limited` with `Retry-After`.
- [ ] **`[AUTOMATE]` `/api/chat` rejects another user's threadId.** POST with someone else's `threadId` → 404 `thread_not_found`.
- [ ] **`[AUTOMATE]` SSE response shape.** Successful POST returns `Content-Type: text/event-stream` and the body contains `data: {"type":"meta",…}` line, then `text-delta` lines, ending with `persisted`.
- [ ] **`[AUTOMATE]` Invalid modelId surfaces a runtime error.** POST with `modelId: "fake-model"` → expect the Cursor runtime to reject it and the UI to show the error state. The route only defaults when `modelId` is missing or blank.

---

## Notes for automation

- Suggested test rig: Playwright + Vitest. Use `BASE_URL` env to flip between local and the App Runner URL.
- The auth model is GitHub OAuth through NextAuth. Browser automation against deployed pages needs a signed-in session; API-level tests should seed or mock auth instead of assuming anonymous access.
- For mobile checks, use Playwright's `iPhone 14` device descriptor or set viewport to `{ width: 375, height: 812 }` and `hasTouch: true`.
- For SSE assertions, use `request.post(...)` and read the response body with `response.body()` then split on `\n\n`.
