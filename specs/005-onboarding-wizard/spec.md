# Feature Specification: First-Login Setup

**Feature Branch**: `005-onboarding-wizard`
**Created**: 2026-06-12
**Revised**: 2026-07-22
**Status**: Shipped; simplified after alpha feedback

## Product decision

First login should get a person to useful work quickly. The setup flow has two
parts:

1. **Name your assistant.** Save the name shown in chat and assistant labels.
2. **Tour live capabilities.** Point to Chat, Artifacts, Skills, Apps, and
   Feedback with short, factual copy.

Tool connections, role intake, tool-preference surveys, and first-task
questions are deliberately not part of onboarding. They add decisions before a
new user has experienced the product and can make the tour feel aspirational.
Connections remain available later from Settings. Personal context comes from
custom instructions, approved Vault memory, and normal conversation.

## User scenarios

### Scenario 1: New user

A newly invited user signs in and sees **Name your assistant**. The name is
required to continue and persists to `users.assistant_name`. The user then sees
the five-step capability tour and lands in an empty chat ready to work.

The user may choose **Skip setup**. Skipping marks the tour complete and leaves
the assistant name unset, so the normal `Assistant` fallback applies.

### Scenario 2: Interrupted setup

The drafted name and current tour step persist in local storage. A reload after
naming resumes at the tour. A user left on the retired `tools` or `about` step
who already has an assistant name also resumes at the tour.

### Scenario 3: Returning user

When `tour_completed_at` is set, onboarding never opens automatically. **Show
tour** in Settings replays the capability tour directly and never repeats the
naming step.

### Scenario 4: Save failure

If the assistant name cannot be saved, setup stays on the naming step and shows
a retryable error. The flow must not imply that a name was saved when it was
not.

## Capability tour

Every card is anchored to a surface that exists in the current chat shell:

| Step | Anchor | Promise |
|---|---|---|
| Chat | `chat-input` | Ask, draft, or analyze an attached work file. |
| Artifacts | `nav-workspace` | Open, preview, and download files Comparative creates. |
| Skills | `nav-skills` | Save a useful workflow to run again. |
| Apps | `nav-apps` | Build and preview a small app; find published apps here. |
| Feedback | `nav-feedback` | Report a bug or confusing moment, with a screenshot when useful. |

Tour copy must not advertise secondary or future behavior such as recommended
skills, schedules, one-click deployment, rollback, or unshipped providers.

## Requirements

- **FR-001**: Show setup exactly when `tour_completed_at IS NULL`.
- **FR-002**: Save a non-empty assistant name before entering the tour.
- **FR-003**: Persist a drafted name and tour progress across reloads.
- **FR-004**: Mark `tour_completed_at` when the user finishes or skips.
- **FR-005**: Keep the tour to five or fewer concise, uniquely anchored steps.
- **FR-006**: Keep tool connection and profile/context questions out of the
  first-run modal.
- **FR-007**: Replay from Settings starts at the tour, not setup.
- **FR-008**: Desktop and mobile both provide a usable tour; an unavailable
  mobile anchor falls back to a centered card.

## Success criteria

- A new user can name the assistant and reach chat in under one minute.
- Setup requires one persisted decision, not an integration or questionnaire.
- Every capability named in the tour has a visible, live product surface.
- Unit tests pin the step inventory and factual-copy constraints.
- Playwright covers first run, completion persistence, and Settings replay on
  desktop and mobile.

## Non-goals

- Connecting account tools during onboarding.
- Collecting role, team, preferred tools, or first-task survey answers.
- Recommending a Skill before the user has completed real work.
- Presenting the full product roadmap in the tour.
