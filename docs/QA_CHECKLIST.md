# QA Checklist — AI Hub web

A manual + automation-ready regression list for the chat app. Each item is
"do X → expect Y." Items tagged `[AUTOMATE]` are good Playwright candidates;
unmarked items need a human eye for visual / device-specific verification.

**Test URL (live):** https://comparative.builtwithrobot.link
**Local dev:** `cd apps/web && pnpm dev` → http://localhost:3000

---

## Core Chat

- [x] **`[AUTOMATE]` Empty state renders.** Open `/chat` with no prior thread → expect heading "Talk to your work", a paragraph below it, and four suggestion pills for GitHub triage, repo shipping summary, status update drafting, and general help.
- [x] **`[AUTOMATE]` Suggestion pill sends.** Click any suggestion pill → expect (a) the pill text appears as a user message right-aligned, (b) "Generating…" placeholder shown in the input, (c) an assistant response streams in below.
- [x] **`[AUTOMATE]` Manual send.** Type "Hello" in the input box, press Enter → expect a user bubble on the right with "Hello", followed by an assistant response.
- [x] **`[AUTOMATE]` Shift+Enter inserts newline.** Type "line one", press Shift+Enter, type "line two", press Enter → expect the user bubble to render two lines.
- [x] **`[AUTOMATE]` Empty submit is blocked.** Click the send button with an empty input → expect nothing happens (no message added). Type only spaces and press Enter → expect nothing happens.
- [x] **`[AUTOMATE]` Send disabled while busy.** While a response is streaming, the placeholder reads "Generating…" and the send button is dim/disabled.
- [ ] **Streaming is visible.** During a response, expect text to appear progressively (not all at once), with a thin pulsing caret at the end while pending.
- [ ] **Auto-scroll follows the stream.** Send a long message that produces a long response → expect the view to keep scrolling so the latest text stays in view.
- [x] **`[AUTOMATE]` Conversation continuity.** After one exchange, send a follow-up like "what did I just ask?" → expect the assistant to reference your previous message (proves `threadId` is passed back).
- [ ] **Markdown rendering (assistant only).** Ask the model to "reply with a bullet list of three items" → expect a real `<ul>` with bullets, not raw `*` characters. Same for `**bold**`, `# heading`, ` ```code``` ` blocks.
- [ ] **User bubbles do NOT render markdown.** Type literally `**bold**` and send → expect the user bubble shows the asterisks as plain text.
- [x] **`[AUTOMATE]` Model label appears.** After an assistant response, expect a small "{assistantName} · {modelId}" label above the answer (e.g. "Thomas · sonnet-4-6").

## Files, Artifacts & Recommendations

- [x] **`[AUTOMATE]` Image upload payload reaches chat.** Attach PNG/JPG/WebP within size caps → expect the chip to appear in the input and `/api/chat` to receive `attachmentCount` plus base64 attachment metadata.
- [x] **`[AUTOMATE]` Representative business file upload accepts common formats.** Attach PDF, DOCX, XLSX, PPTX, and CSV within size caps → expect the chip to appear in the input and `/api/chat` to accept the turn.
- [ ] **Uploaded files are saved as artifacts.** Send a turn with at least one upload → expect the run activity to mention stored uploads and the Artifacts section to list the original file with its MIME type/download preserved.
- [ ] **Images reach the model as visual inputs.** Attach a simple screenshot/image and ask what is visible → expect the assistant to reason from the image, not only the filename/dimensions.
- [x] **Generated artifacts use the cobalt pill.** Ask for a small HTML or Markdown artifact → expect the assistant message to show the compact electric-cobalt document pill instead of dumping a full large code block.
- [x] **Artifact preview stays in the current tab.** Click a document/artifact pill → expect the in-tab preview pane to open; no browser tab/window should be created.
- [ ] **Artifact versions group together.** Ask to revise an existing artifact → expect Artifacts to show one grouped item with the latest version plus expandable prior versions/downloads, not unrelated duplicates.
- [x] **Chat download works.** Click the header download button in a non-empty thread → expect a Markdown transcript file containing messages, thread metadata, and artifact references when present.
- [ ] **Recommendation cards are quiet and actionable.** After a response that produces a reusable workflow or deployable artifact, expect up to three recommendation cards below the assistant message. Accept should run the declared action; Dismiss should hide it and persist.

## Run Lifecycle

- [ ] **`[AUTOMATE]` Chat turns create durable runs.** Send a prompt → expect `/api/chat` to return a run id in the stream metadata and `/admin/runs` to show a matching `chat-turn` row.
- [ ] **`[AUTOMATE]` Running chat turn can be canceled.** Start a long-running prompt and click "Cancel" on the assistant run controls → expect the message to move out of pending state, `recipe_runs.status = canceled`, and a `run_cancel` audit row.
- [ ] **`[AUTOMATE]` Failed/canceled chat turn can be retried.** Force a chat run failure or cancel one, then click "Retry" → expect a new queued run linked to the prior run and the thread to continue with the original prompt.
- [ ] **Admin resume/reconcile is available.** As an admin, open `/admin/runs/[id]` for a queued/running `chat-turn` run → expect "Resume" to be available and to write a resume event/audit row when clicked.
- [ ] **Refresh preserves activity state.** During a long-running chat turn, refresh the browser → expect the pending run and compact activity timeline to reload from `run_events`.
- [x] **Activity receipts are useful but collapsed.** For a turn with uploads/artifacts/tools, expect a grey "Worked for…" row with a caret. Expanding it should show concrete steps such as stored files, selected context, tool/provider work, and created artifacts.

---

## UI / Layout

- [ ] **Sidebar visible on desktop ≥ md (768px).** Resize window to 1024px width → expect the left sidebar to be persistently visible, no hamburger button shown.
- [ ] **Top bar single row.** At every viewport width from 320px → 1440px, the top bar should remain on one horizontal row (no wrapping).
- [x] **`[AUTOMATE]` Top bar contains the right elements.** Inspect the `<header>` of `/chat` → expect: hamburger (mobile only), tab list, "+" new-tab button, chat download button, stop/regenerate when applicable, and theme toggle. In Runtime v1 only, the model selector may also appear.
- [ ] **`[AUTOMATE]` Empty-state suggestions clickable.** Each of the three suggestion pills has role=button and is focusable via Tab.
- [x] **No horizontal overflow.** At 320px, 375px, 414px, 768px, 1280px viewports → expect `document.documentElement.scrollWidth === clientWidth` (no horizontal scrollbar at the page level).
- [ ] **Hairline borders only.** Visual inspection: no drop shadows, no gradients, dividers are 1px lines using `--color-hairline`.
- [ ] **Notion palette in light mode.** Background tone should be off-white (#F7F6F3-ish), not pure white. Hairlines visible but soft.
- [ ] **Active sidebar item highlight.** Click any sidebar nav item → expect a subtle filled background (`bg-subtle`) on it; previously active item loses the highlight. **Note:** these items are cosmetic only — they don't navigate (see Punch List).
- [x] **Persona navigation is role-aware.** Admin users see the Admin navigation item; regular users do not.
- [x] **Conversation preview blurbs are useful.** Seed one real summary and one useless greeting → expect only the useful chat to expose a preview blurb.
- [x] **Tools connection state renders.** Mock GitHub connected/disconnected states → expect connected copy for linked accounts and a GitHub connect link when disconnected.
- [x] **Settings saves user context.** Change display name and custom instructions → expect successful save state and updated values.
- [x] **Vault memory workflow works.** Open Vault → expect approved/suggested memory, add a manual fact, approve a suggestion, and see counts update.

---

## Dark Mode

- [x] **`[AUTOMATE]` Theme toggle exists.** Find the sun/moon icon button in the top-right of the chat top bar.
- [x] **`[AUTOMATE]` Toggle flips theme.** Click theme toggle → expect `<html>` to gain or lose the `dark` class. Background and surfaces swap palette accordingly. Click again → expect it to flip back.
- [x] **`[AUTOMATE]` Theme persists across reload.** Set theme to dark, hard-reload `/chat` → expect the app to load already in dark mode (no flash of light theme).
- [ ] **No flash of unstyled / wrong theme on load.** Visual: open app cold (cleared cache) → expect the correct theme paints from the very first frame.
- [ ] **Dark palette correctness.** In dark mode: canvas ≈ `#191919`, sidebar ≈ `#1F1F1F`, surface ≈ `#252525`, hairline ≈ `#2D2D2D`, ink ≈ `#E5E5E5`. Not pure black.
- [ ] **All text legible in both themes.** Visual scan: scrollbar, placeholder text, header buttons, assistant/model labels, message timestamps, pending caret, artifact pills, and recommendation cards all readable in both modes.
- [ ] **Markdown code blocks themed.** Ask for a fenced code block → expect the `<pre>` background uses the theme's `bg-subtle` (not hardcoded black/white), and inline `code` follows suit.
- [ ] **System preference honored on first visit.** Clear localStorage, set OS to dark mode, visit `/chat` → expect dark theme applied. Switch OS to light, clear storage, reload → expect light.

---

## Mobile (viewport < 768px)

- [x] **`[AUTOMATE]` Sidebar hidden by default.** At 375px width, on first load → sidebar is offscreen, hamburger visible at top-left of header.
- [x] **`[AUTOMATE]` Hamburger opens drawer.** Tap the hamburger → expect sidebar slides in from the left, dark backdrop covers the rest of the screen.
- [x] **`[AUTOMATE]` Backdrop tap closes drawer.** With drawer open, tap anywhere on the dimmed area → expect drawer slides out, backdrop fades away.
- [x] **`[AUTOMATE]` X button closes drawer.** With drawer open, tap the X in the user header inside the sidebar → expect drawer closes.
- [x] **`[AUTOMATE]` Escape key closes drawer.** With drawer open and focus anywhere on page, press Escape → drawer closes.
- [x] **`[AUTOMATE]` Tapping a nav item closes drawer.** Open drawer, tap "Tools" or "Vault" → expect drawer closes and the active highlight in the sidebar moves to the selected section.
- [x] **`[AUTOMATE]` Vault renders seeded memory.** Open "Vault" from the sidebar → expect approved and suggested memory to render in the active theme.
- [x] **`[AUTOMATE]` "New chat" from drawer closes drawer + opens new tab.** Tap "New chat" inside the drawer → expect drawer closes AND a new empty tab appears in the tab strip, becomes active.
- [ ] **Touch targets ≥ 44px.** Visual/measurement: hamburger, X close, sidebar nav items, "New chat", and send button all measure ≥ 44px tall in mobile mode.
- [ ] **Tab strip scrolls horizontally.** Open 4–5 tabs on a 375px viewport → expect the tabs container scrolls horizontally, the active tab stays visible after switching.
- [ ] **Tab close buttons visible without hover on mobile.** With multiple tabs at < md, each tab shows its X icon at all times. (At ≥ md, the X is hidden and only appears on hover.)
- [ ] **`[AUTOMATE]` Input not zoomed on focus (iOS).** On Safari iOS, tap into the textarea → expect the page does NOT auto-zoom (textarea font is 16px on mobile to suppress this).
- [ ] **Input bar pinned to bottom.** Visually verify on iPhone Safari with the URL bar collapsed and expanded: input bar always touches the visible bottom edge.
- [ ] **Input bar above keyboard.** Tap into the textarea on iPhone → expect the input bar to remain visible above the on-screen keyboard. (Caveat: iOS Safari behavior with `dvh` is best-effort; the message list above the input may shrink.)
- [ ] **Header controls compact on mobile.** At < sm width, the download, stop/regenerate, and theme controls stay usable without causing horizontal page overflow.
- [ ] **Padding tight but not cramped.** Messages and input use 16px (`px-4`) horizontal padding on mobile, 24px (`px-6`) on desktop.
- [ ] **`[AUTOMATE]` No body scroll while drawer open.** Open drawer at 375px, attempt to scroll the page underneath → expect the underlying chat area does not scroll. (Note: not currently locked — see Punch List.)

---

## Tabs

- [x] **`[AUTOMATE]` Initial state has one tab named "New chat".** Fresh page load → expect exactly one tab with the title "New chat", input is enabled.
- [x] **`[AUTOMATE]` "+" button creates a new tab.** Click "+" → expect a new tab labelled "New chat" appears to the right and becomes active.
- [x] **`[AUTOMATE]` Each tab has independent messages.** Send "tab A" in tab 1, switch to tab 2, send "tab B" in tab 2, switch back to tab 1 → expect tab 1 still shows "tab A" and its assistant response only; tab 2 shows "tab B" and its response only.
- [ ] **`[AUTOMATE]` Each tab has independent threadId.** After sending in two tabs, inspect Network → expect each tab's requests use different `threadId` values.
- [x] **`[AUTOMATE]` Tab title auto-derives from first message.** Send "What is in my email?" in a fresh tab → expect the tab title becomes "What is in my email?" (truncated at 32 chars + `…` if longer).
- [ ] **Tab title doesn't change after the first message.** Send a second message in the same tab → expect the tab title remains the original.
- [ ] **`[AUTOMATE]` Switching tabs while one is busy.** While tab 1 is generating, switch to tab 2 → expect tab 2's input is enabled (independent busy state); switching back to tab 1 still shows pending state and incoming text.
- [ ] **`[AUTOMATE]` Busy indicator dot.** A tab with a request in flight shows a small pulsing dot to the left of its title. The dot disappears when the response finishes.
- [x] **`[AUTOMATE]` Closing a tab.** Click X on a non-active tab → expect that tab disappears, active tab stays.
- [x] **`[AUTOMATE]` Closing the active tab.** Click X on the active tab (when others exist) → expect the previous tab (left neighbor, falling back to first) becomes active.
- [x] **Last tab cannot be closed.** With only one tab open, expect no X button is shown on it.
- [x] **Runtime v2 hides per-tab model picking.** With Runtime v2 enabled, expect no chat-level model dropdown; routing/model choice is handled by the runtime while the assistant label still records the model used.
- [ ] **Tabs persist across reload.** Open 3 tabs, refresh the page → expect the same tab set and active tab to return from local storage. Server-side threads still remain the source of truth for persisted conversations.

---

## Error States

- [x] **`[AUTOMATE]` API 4xx/5xx surfaces.** Use devtools to block `/api/chat` (or stop the dev server) and try to send → expect an error banner above the input ("HTTP 5xx" or similar).
- [ ] **Models endpoint failure.** Block `/api/models` → expect placeholder reads "Loading models…" forever and the input remains disabled. (Currently no user-facing surface — see Punch List.)
- [ ] **`[AUTOMATE]` Unauthorized response.** Force `/api/chat` to return 401 → expect the error banner shows the server's message.
- [ ] **`[AUTOMATE]` Stream interrupted mid-response.** Kill the connection during streaming (devtools offline toggle) → expect pending=false eventually, partial content remains in the assistant bubble.
- [x] **`[AUTOMATE]` Retrying after an error.** After a failed send, click "Try again" → expect a fresh request fires for the failed prompt and succeeds when the backend recovers.
- [ ] **Thread ownership / 404.** Manipulate localStorage / send a stale `threadId` → API returns 404 thread_not_found, error surfaces in the banner.
- [x] **Retry button appears after a failed send.** Force a `/api/chat` failure → expect the error card to show a "Try again" button that resends the failed user message.

---

## API / Health

- [ ] **`[AUTOMATE]` `/api/health` returns dependency checks.** `curl https://comparative.builtwithrobot.link/api/health` → expect `status`, `service`, `timestamp`, and `checks.db` / `checks.runtime`.
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
- [ ] **`[AUTOMATE]` Invalid modelId surfaces a runtime error.** POST with `modelId: "fake-model"` → expect the Bedrock runtime to reject it and the UI to show the error state. The route only defaults when `modelId` is missing or blank.

---

## Notes for automation

- The current automation strategy lives in `docs/REGRESSION_GAUNTLET.md`.
- Browser smoke is now Playwright-backed: run `pnpm smoke:browser`.
- Local browser smoke includes mocked signed-in chat feature flows at `/e2e/chat`: image upload payloads, artifact collapse/preview/menu, tool activity receipts, slash skill execution, chat transcript download, tab isolation, retry recovery, chat shell guardrails, persona/admin gating, Tools connection state, Settings saves, and Vault memory approval.
- Production public smoke is now script-backed: run `pnpm smoke:prod`.
- Use `PLAYWRIGHT_BASE_URL` to point browser smoke at an already-running app.
- Use `SMOKE_BASE_URL` to point production smoke at a preview or alternate deployed URL.
- The auth model is GitHub OAuth through NextAuth. Browser automation against deployed pages needs a signed-in session; API-level tests should seed or mock auth instead of assuming anonymous access.
- For mobile checks, use Playwright's `iPhone 14` device descriptor or set viewport to `{ width: 375, height: 812 }` and `hasTouch: true`.
- For SSE assertions, use `request.post(...)` and read the response body with `response.body()` then split on `\n\n`.
