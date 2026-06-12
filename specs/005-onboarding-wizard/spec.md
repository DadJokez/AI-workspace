# Feature Specification: First-Login Setup Wizard

**Feature Branch**: `005-onboarding-wizard`
**Created**: 2026-06-12
**Status**: Spec — ready to build (Rob's #2 after the eval harness)
**Input**: "First time a user logs in, a setup guide: name your assistant (everyone names their own), connect any tools (checkbox → SSO into what you pick), answer 2–3 questions about your role, then the capability walkthrough."

## Why

The first five minutes decide adoption. Today a new user lands on a blank chat
box — no identity, no context, no idea what the platform can do. The result is
the cold-start every consumer app has trained people to expect *away* from. This
wizard turns first login into: **make it yours → connect your work → tell it who
you are → see what it can do.** It also seeds the context substrate
(KNOWLEDGE_MANAGEMENT.md layer 1) and the future skill-proposal flywheel.

The existing first-run **tour** (#136, shipped) is the *last* step of this
wizard — the "capability walkthrough." This packet wraps the three steps before
it and makes the whole thing one flow.

## The "name your assistant" idea

Letting each person **name their own assistant** is the emotional hook — it
turns "a corporate AI tool" into "my assistant, Jarvis." It's cheap to build and
it's the difference between a tool people are assigned and one they adopt. The
name shows in the chat header, in assistant message labels ("Jarvis · sonnet"),
and in the wizard's closing line.

## User Scenarios *(mandatory)*

### Scenario 1 — Happy path (Priority: P1)

A brand-new user signs in. A four-step wizard appears (not skippable past
step 1's "name," but every later step has "skip for now"):

1. **Name your assistant** — text field, a few suggested names, a friendly
   default. Saves to `users.assistant_name`.
2. **Connect your tools** — checkbox list of available providers (GitHub today;
   M365/Salesforce/etc. shown as "coming soon," disabled). Checking a box and
   clicking Connect kicks the provider's existing OAuth flow; on return, the
   wizard resumes at this step with the provider ticked.
3. **About your work** — 2–3 questions (below). Answers seed custom instructions
   + Vault memory items.
4. **Capability walkthrough** — the existing tour (#136), now framed as "Here's
   what {assistant_name} can do."

On finish, `users.tour_completed_at` is set (reusing the shipped gate) and the
user lands in chat with their named assistant, connected tools, and seeded
context.

### Scenario 2 — Resume after OAuth redirect (Priority: P1)

Connecting a tool round-trips through the provider's OAuth and back. The wizard
must **resume at step 2** with state intact (assistant name already saved), not
restart. (Persist wizard progress server-side or in the return URL.)

### Scenario 3 — Skip and finish later (Priority: P2)

A user can skip tools and questions (but is gently encouraged). Skipped steps
are resumable from a "finish setup" nudge until completed. Naming is the only
required step (it's one field and it's the fun one).

### Scenario 4 — Returning user never sees it (Priority: P1)

`tour_completed_at` set → wizard never appears again. Re-runnable from Settings
("Redo setup" / the existing "Show tour" replay).

### Edge cases
- Closes the tab mid-wizard → resumes where they left off next sign-in.
- Declines all tools, skips all questions → still gets a named assistant and the
  walkthrough; never blocked.
- Admin-invited user with a pre-set role → role question can pre-fill.

## The 2–3 role questions (drafted — Rob to red-pencil)

Kept to three, each answer wired to something concrete the assistant uses:

1. **"What's your role and team?"** (short text or pick-list: PM, analyst, ops,
   engineer, finance, sales, other + free text)
   → seeds custom instructions ("The user is a {role} on {team}.") and is the
   key signal for future role-based skill proposals.

2. **"Which tools do you live in all day?"** (multi-select: GitHub, Outlook/
   M365, Salesforce, Workfront, Excel, Slack/Teams, … + other)
   → tells us which integrations to prioritize *and* primes the connect step;
   answers we don't yet support become demand signal (counted, not connected).

3. **"What's one thing you'd hand off to an assistant first?"** (free text)
   → the highest-signal answer. Seeds a memory item, frames the first useful
   interaction, and is a candidate to auto-suggest a matching skill at the end
   ("Sounds like the Weekly Status skill could help — want to try it?").

Design rule: every question earns its place by driving a concrete downstream
behavior. No survey questions for their own sake. Three max — fatigue kills
completion.

## Requirements

- **FR-001**: Add `users.assistant_name` (text, nullable; default shown in UI
  but null until the user sets it). One migration.
- **FR-002**: Wizard shows when `tour_completed_at IS NULL` (reuse the shipped
  gate); naming required, later steps skippable; finishing sets the gate.
- **FR-003**: Step 2 lists providers from the same registry the Tools page uses;
  checking + Connect launches the existing per-provider OAuth; the flow resumes
  at step 2 with state preserved across the redirect.
- **FR-004**: Role answers persist to `users.custom_instructions` (composed) and
  as `user_memory_items` (approved, source = "onboarding") so they inject from
  turn one.
- **FR-005**: `assistant_name` surfaces in the chat header and assistant message
  labels; falls back to "Assistant" when unset.
- **FR-006**: Step 4 is the existing tour component, re-titled with the assistant
  name; no duplication of tour logic.
- **FR-007**: Re-runnable from Settings; never auto-shows twice.
- **FR-008**: Every wizard write is auditable; role answers are user-owned
  context (visible/editable/deletable on the future Memory page, per
  KNOWLEDGE_MANAGEMENT.md layer 1).

## Success criteria

- **SC-001**: A new user goes from first sign-in to a named assistant +
  ≥1 connected tool (if they have one) + seeded role context in under 3 minutes.
- **SC-002**: The OAuth round-trip resumes the wizard without data loss
  (Scenario 2) — the make-or-break technical risk.
- **SC-003**: After finishing, the assistant's first answer reflects the role
  context (e.g. defaults to the user's stated format preference) — proof the
  seeding works end to end.
- **SC-004**: Completion rate is measurable (wizard-step events) so the flow can
  be tuned.

## Dependencies & sequencing

- Reuses: `tour_completed_at` gate + tour component (#136, shipped), provider
  OAuth flows (GitHub shipped), `custom_instructions` + Vault (shipped).
- Adds: `users.assistant_name`, wizard UI, step-resume state, role-answer
  seeding.
- Pairs with the **Memory page** (parity P1.3) — they share the user-context
  model; ship close together so role answers are immediately viewable/editable.
- Gated by the **eval harness** (specs/004): an onboarding eval asserts the
  assistant name appears and role context injects.
