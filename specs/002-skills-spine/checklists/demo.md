# Checklist: The Demo Arc

**Purpose**: This is the contract for the packet. When every box checks on production, the Skills Spine ships. It is also, verbatim, the 5-minute demo for a skeptical exec — one continuous story across J2 → J3 → J4 → J5-seed, using only the GitHub provider, in front of a commodity-chat incumbent that can do none of it.

**Rule**: anything not required by a box below is a follow-up issue, not packet scope.

## Pre-flight

- [ ] Two workspace accounts available (Owner = Rob, Recipient = second/test account), both with GitHub connected and attested
- [ ] Production healthy (`/api/health` ok), Runtime V2 lanes green
- [ ] Starter skills seeded; catalog shows Developer Briefing as Skill 001

## Beat 1 — "It does real work" (J2, ~60s)

- [ ] Owner opens Developer Briefing skill, clicks **Run**
- [ ] Activity timeline streams GitHub MCP calls; result lands in a thread
- [ ] Run appears in `runs` ledger with `trigger_type="skill"`, model, timing, redacted tool calls
- [ ] `/admin/audit` shows the skill run rows

## Beat 2 — "Now it works without me" (J3, ~60s)

- [ ] Owner schedules Developer Briefing: weekly, Monday 8:00, America/New_York (demo uses a near-future minute)
- [ ] Schedule fires without any user action; output arrives in the designated thread
- [ ] Schedule history shows the fire with link to run detail; `last_run_at`/`next_run_at` advanced
- [ ] Kill/redeploy resilience demonstrated at least once in rehearsal: schedule created before a deploy fires after it

## Beat 3 — "Anyone can shape it" (J2 self-serve, ~45s)

- [ ] Recipient (non-admin, no help) clones a starter, edits the prompt, runs the clone successfully
- [ ] Clone shows provenance; starter unchanged

## Beat 4 — "Make me an app for this" (J4 thin, ~90s)

- [ ] Owner asks chat to build a small page presenting the briefing; artifact preview renders
- [ ] **Deploy** → app live at `/apps/{slug}`, sidebar shows it under Apps
- [ ] Incognito request to the app URL redirects to login (SSO gate proven on stage)
- [ ] One more chat iteration → **Save draft** → version list shows plain-English summaries → **Revert** restores v1 in one click

## Beat 5 — "Capability moves between people" (J5 seed, ~45s)

- [ ] Owner shares the skill and the app to Recipient by name
- [ ] Recipient's sidebar shows both under Shared with you / Apps
- [ ] Recipient runs the shared skill — **with their own GitHub identity** (audit shows Recipient as actor)
- [ ] Owner revokes a share; it disappears for Recipient

## Close (the line that lands the thesis)

- [ ] Said out loud over the final screen: *"Nobody here picked a model, saw a branch, or filed a ticket. A skill was built, scheduled, turned into an app, and handed to a teammate — inside the governance you just saw in the audit log. That's the difference between buying copilots and building capability."*

## Evidence to capture (for the IT-review dossier)

- [ ] Screen recording of the full arc on production
- [ ] Audit-log export covering the demo window (redaction visibly applied)
- [ ] `runs` rows for all five beats showing one uniform execution pipeline
