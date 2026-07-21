# Comparative frontend design audit — 2026-07-20

Read-only audit of `apps/web/` (chat, sidebar, panels, admin, onboarding) and
`packages/umber/`. Benchmarks: Linear, Notion, Vercel dashboard, Perplexity,
Claude.ai. Companion wireframes: [`docs/wireframes-2026-07-20.html`](wireframes-2026-07-20.html).

## TL;DR

The bones are genuinely good: disciplined semantic color tokens in the core UI,
a working dark mode + runtime reskin with no theme flash, thoughtful
progressive-disclosure "work receipts," solid mobile fundamentals, and
above-average accessibility for hand-rolled components. The five things holding
it back from best-in-class:

1. **The app has two competing visual identities and fully commits to neither.**
   The Umber design system is ~90% unadopted (one of seven token files
   imported, no brand fonts loaded), while the default "classic" skin carries a
   hardcoded neon-blue glow aesthetic that bypasses tokens entirely. Pick one
   — Umber is the stated brand — and retire the other.
2. **No semantic status colors.** Error/success/warning are raw Tailwind
   classes in inconsistent shades, several of which are illegible in light mode.
3. **Navigation loses your place.** Settings/Tools/Vault/Artifacts replace the
   entire chat surface instead of layering over it; the thread list is flat
   with no pinning or date grouping; there's no ⌘K palette — and the existing
   SearchPanel is unreachable (no button or shortcut opens it).
4. **The chat thread is missing table-stakes affordances**: timestamps,
   citations/sources, a scroll-to-bottom button, and (under runtime V2) any
   visible model indicator.
5. **Typography ignores its own scale.** Nearly all UI text is arbitrary pixel
   values (`text-[11px]`…`text-[14px]`) instead of a ramp, so hierarchy is
   improvised per-file.

None of these are rewrites. The single highest-leverage move is finishing the
Umber adoption: import the full token set, load the fonts locally, map the
8 app variables onto Umber's semantic aliases, and add the four missing status
tokens. Most other fixes become find-and-replace after that.

---

## What's working well

Worth saying out loud so it doesn't get churned in a redesign:

- **Token discipline in the core shell.** ~92% of color utilities go through
  the 8 semantic vars (`ink`, `canvas`, `subtle`, `hairline`, …) defined in
  [globals.css:7](../apps/web/app/globals.css:7). The theming architecture —
  pre-paint script to prevent flash-of-wrong-theme, post-hydration re-assert
  for React 19, Dark Reader lock — is carefully built and documented
  ([layout.tsx:21](../apps/web/app/layout.tsx:21), [UiSkinSync.tsx](../apps/web/components/UiSkinSync.tsx)).
- **Work receipts.** Tool activity renders as one quiet collapsed line under
  the answer, expanding to grouped steps and raw detail
  ([MessageBubble.tsx:837](../apps/web/components/MessageBubble.tsx:837)). The
  answer stays primary; the audit trail is one click away. This is the right
  pattern — better than the inline tool-card walls in many competitors — and
  it's a governance story in the enterprise pitch.
- **The orb.** A real brand mark with real engineering care: reduced-motion
  fallback, IntersectionObserver pausing, streaming-energy animation
  ([ThinkingOrb.tsx:110](../apps/web/components/ThinkingOrb.tsx:110)).
- **The composer.** Draft persistence per thread with `pagehide` flush, slash
  palette with keyboard nav, drag/paste attachments, dictation, edit-and-resend
  with restore ([ChatInput.tsx](../apps/web/components/ChatInput.tsx)). Feature-complete
  against Claude.ai/ChatGPT composers.
- **Mobile fundamentals.** `h-dvh`, safe-area insets, 44px touch targets that
  compact on desktop, 16px input font to prevent iOS zoom, drawer sidebar,
  full-screen mobile panes. Someone thought about phones.
- **Hand-rolled accessibility.** `role="radiogroup"` segmented controls with a
  documented label trap ([SettingsPanel.tsx:455](../apps/web/components/SettingsPanel.tsx:455)),
  keyboard-resizable panes with ARIA values, layered Escape handling, labeled
  icon buttons throughout.
- **Admin data pages are consistent and dense** in the good, Linear-ish sense —
  real tables, 12–13px, hairline dividers, hover states.

---

## Key gaps vs. best-in-class

**The design-system schism.** [globals.css:1](../apps/web/app/globals.css:1)
imports only Umber's typography tokens. The palette is hand-redeclared as 8
RGB triplets; Umber's neutral ramp, tan, forest pop, radii, shadows, spacing,
motion, and grain are all dead weight in `packages/umber`. The brand fonts
(Geist, Newsreader, Geist Mono) were stripped for zero-egress and never
replaced with local `@font-face`, so everything renders on system fonts —
including the "Umber" skin. Meanwhile the default skin's capability/artifact
chrome is a separate hardcoded identity: `#2f6bff`/`#06112f`/`#28d7ff` glows
repeated across four component families
([MessageBubble.tsx:281](../apps/web/components/MessageBubble.tsx:281), 356, 444, 527;
[ArtifactPreviewPane.tsx:155](../apps/web/components/ArtifactPreviewPane.tsx:155);
[layout.tsx:46](../apps/web/app/layout.tsx:46)), each duplicating an `umber:`
fallback — 73 of the 86 `umber:` overrides live in one file. Linear, Notion,
and Claude.ai each read as *one* system; Comparative currently reads as two
half-systems.

**Context-destroying navigation.** Opening Settings, Tools, Vault, or
Artifacts swaps out the entire chat pane
([ChatClient.tsx:2060](../apps/web/app/chat/ChatClient.tsx:2060)) — scroll
position and reading context gone. Best-in-class apps layer these (modal with
tab rail à la Claude.ai/Linear settings, or a slide-over). Related: the thread
list is a flat `max-h-[40vh]` scroller with no pinned/today/this-week grouping
([Sidebar.tsx:383](../apps/web/components/Sidebar.tsx:383)); there is no ⌘K
palette (already flagged as P2.2 in the parity backlog) while
[SearchPanel.tsx](../apps/web/components/SearchPanel.tsx) sits wired-up but
unreachable — `view="search"` is handled at
[ChatClient.tsx:1281](../apps/web/app/chat/ChatClient.tsx:1281) but nothing
emits it; Admin is a hard `window.location.assign` page reload
([ChatClient.tsx:1288](../apps/web/app/chat/ChatClient.tsx:1288)); the desktop
sidebar can't collapse.

**Chat-thread affordance gaps.** No timestamps anywhere; attribution is a tiny
text label. No citations/sources UI at all despite MCP tool results — as web
connectors land this becomes the credibility surface Perplexity is built on.
No scroll-to-bottom pill when you scroll up mid-stream. Under `runtimeV2` the
model selector disappears with no replacement indicator
([ChatClient.tsx:2142](../apps/web/app/chat/ChatClient.tsx:2142)) — an honesty
product should always show which model answered (the per-message meter label
helps but is 11px muted text).

**Status color chaos.** Twenty `text-red-300`, eight `text-red-500`, plus
red-200/red-400 variants for the same "error" meaning; dark-tuned shades like
`text-red-300 bg-red-500/5` applied unconditionally are near-illegible in
light mode ([VaultPanel.tsx:230](../apps/web/components/VaultPanel.tsx:230),
[RunInspectorPane.tsx:351](../apps/web/components/RunInspectorPane.tsx:351),
[WorkspacePanel.tsx:89](../apps/web/components/WorkspacePanel.tsx:89)). The
notification badge is `text-white` on `bg-accent`, and accent is near-white in
dark mode ([ChatClient.tsx:2181](../apps/web/app/chat/ChatClient.tsx:2181)).
Umber already defines desaturated red/amber/green ramps — they're just not
imported.

**Weak focus visibility.** 12 uses of `focus:outline-none`, only 2 files using
`focus-visible`, many buttons with no ring at all. Umber ships a forest-green
focus system (`--focus-ring`) that would make keyboard navigation both visible
and on-brand. For an enterprise IT review, keyboard operability is an
accessibility checkbox that gets audited.

---

## Recommendations

Priorities: **P0** = do first, unblocks everything else · **P1** = biggest
visible quality jump · **P2** = polish.

### Layout & Navigation

- **P1 — Stop swapping the chat away.** Move Settings into a centered modal
  with a left tab rail (see wireframe 3); make Tools/Vault slide-over drawers
  from the right (the resizable-pane pattern already exists for
  artifacts/inspector — reuse it). Keep Skills/Apps/Admin as routes.
- **P1 — Group the thread list**: Pinned / Today / Previous 7 days / Older,
  with pin + rename + delete in the row menu. Let the list take the available
  sidebar height instead of `max-h-[40vh]`.
- **P1 — Ship ⌘K.** One palette for threads, skills, apps, admin pages, and
  actions ("New chat", "Toggle theme"). Fold the orphaned SearchPanel into it
  (or delete SearchPanel — dead UI fails the no-tech-debt rubric). This is
  parity-backlog P2.2 and the single most "Linear-feeling" addition available.
- **P2 — Collapsible desktop sidebar** (240px ↔ 56px icon rail, persisted).
  Umber's `--sidebar-w: 248px` token should drive the width.
- **P2 — Make Admin a soft navigation** (Next `<Link>`, not
  `window.location.assign`) and give sub-areas a consistent back-to-chat
  header; the current mix of hard reloads and per-area headers feels stitched.

### Typography & Spacing

- **P0 — Load the brand fonts locally.** Self-hosted woff2 for Geist, Geist
  Mono, and Newsreader via `next/font/local` (zero egress, satisfies the
  sourcing concern). Without this, "Umber" is a palette, not an identity.
  Sourcing the files is Rob's call per the reskin decision — flagging, not
  doing.
- **P1 — Replace arbitrary pixel sizes with the Umber ramp.** `text-[14px]` →
  `--text-sm/base`, `text-[11px]/[12px]` → `--text-2xs/xs`, mapped through
  Tailwind theme so the fix is mechanical. One ramp, applied everywhere, is
  most of what makes Linear/Notion feel "tight."
- **P1 — Adopt the spacing/radius/shadow tokens** (`--space-*`, `--radius-*`,
  warm shadows) into the Tailwind theme; sweep arbitrary values like
  `mt-[5px]` during the same pass.
- **P2 — Use the serif display face** (Newsreader) for the empty-state
  headline and login card to give the brand a voice beyond color.

### Color & Theming

- **P0 — Adopt Umber for real.** Import `umber/styles.css` (or the token files
  individually), bridge `html.dark` ↔ `[data-theme="dark"]` (one line in the
  theme script), and remap the app's 8 vars onto Umber's semantic aliases so
  every existing `text-ink`/`bg-canvas` class keeps working. Then delete the
  hand-authored palette in globals.css.
- **P0 — Add semantic status tokens** — `--color-danger/success/warning/info`
  with light+dark values from Umber's desaturated support hues — and sweep the
  132 raw-palette usages onto them. Fixes the light-mode illegibility and the
  dark-mode badge bug in one pass.
- **P1 — Retire the neon-blue "classic" chrome.** Decide Umber is the
  identity: flip the default skin, rebuild the capability/artifact/slash
  styling on tokens (forest pop for the one emphasis), and after a stable
  release delete the `umber:` variant and both skins' duplication. Two
  maintained skins is ongoing tax with no user payoff. The blue gradient can
  survive as a tokenized brand ramp for the orb only.
- **P1 — Visible focus rings everywhere** via Umber's `--focus-ring`; remove
  bare `focus:outline-none`.
- **P2 — Honor "one pop per view."** `umber:bg-pop` currently decorates 7 spots
  (mostly status dots); reserve it for the primary action (Send / New chat) per
  the design system's own rule.

### Chat UX

- **P1 — Timestamps + model attribution.** Hover-revealed relative timestamp
  (absolute on click) on every message; keep the cost meter. Under runtime V2,
  show which model/lane answered in the same row — never leave the surface
  model-silent.
- **P1 — Citations pattern.** When tool results carry URLs/documents, render a
  numbered source-chip row under the answer (wireframe 2) feeding inline
  `[1]` markers. Design it now, before web connectors land, so receipts
  (how I worked) and citations (what I relied on) are distinct surfaces.
- **P1 — Scroll-to-bottom pill** when the user scrolls out of the stick zone
  during streaming (the `stickToBottomRef` logic already knows; it just has no
  affordance).
- **P2 — Render user-message markdown** (at minimum code blocks/links) —
  asymmetry with assistant messages reads as a bug when pasting code.
- **P2 — Extract components from `ChatClient.tsx`** (2,577 lines; `send()`
  alone is ~445). Not visual, but it's the file every UI improvement must pass
  through; splitting thread/header/state lowers the cost of all of the above.

### Empty & loading states

- **P1 — Personalize the empty state.** The wizard already captures name,
  role, and tools; greet with them and generate role-aware suggestions
  (recommendation API exists) instead of four hardcoded prompts
  ([ChatClient.tsx:2536](../apps/web/app/chat/ChatClient.tsx:2536)). Keep the
  honest "what's connected today" line — it's on-mission.
- **P1 — Skeletons for thread load.** Sidebar has one; the message area
  itself should skeleton while a thread loads rather than pop in.
- **P2 — Empty states for panels**: Vault with nothing captured, Tools with
  nothing connected, and admin tables with no rows should each say what the
  surface is for and offer the first action, in one shared pattern.
- **P2 — A tiny chart primitive for admin.** The hand-rolled div bars work but
  have no axes/tooltips and are duplicated per page (self-documented drift in
  [admin/ui.tsx:8](../apps/web/app/admin/ui.tsx:8)); one shared `<BarChart>` +
  shared `Metric`/`StatusBadge` ends the drift.

### Mobile responsiveness

- Fundamentals are solid; remaining gaps are polish:
- **P1 — Swipe-to-open sidebar** and swipe-back from full-screen panes —
  currently hamburger-only.
- **P2 — Reposition the alpha badge** (fixed top-center `z-[90]`) which can
  overlap the header title/notification icons on narrow screens
  ([layout.tsx:46](../apps/web/app/layout.tsx:46)).
- **P2 — A tablet stance**: between 768–1024px the resizable right pane plus
  240px sidebar leaves the thread cramped; auto-collapse the sidebar to the
  icon rail when a right pane is open.
- **P2 — Extend density-compact below 768px** (currently desktop-only) once
  touch targets are guaranteed by component minimums instead of the global
  44px floor.

---

## Suggested sequence

1. **Token foundation (P0s):** full Umber import + dark-mode bridge + status
   tokens + local fonts. Mostly mechanical; everything after inherits it.
2. **Identity commit:** flip Umber to default, rebuild blue chrome on tokens,
   focus rings. The app now looks like one product.
3. **Navigation:** settings modal, slide-over panels, thread grouping, ⌘K.
4. **Chat polish:** timestamps, citations pattern, scroll pill, personalized
   empty state.
5. **Cleanup:** delete classic skin + `umber:` variant, split ChatClient,
   shared admin primitives.

Phases 1–2 are the "best-in-class feel" unlock; they're also the cheapest.
Wireframes for phases 2–4: [`docs/wireframes-2026-07-20.html`](wireframes-2026-07-20.html).
