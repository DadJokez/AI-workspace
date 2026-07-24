# Comparative Core Evaluation Program

## Purpose

Comparative's quality bar is not that a feature exists or that a mocked demo
can render it. A core capability is reliable only when the real user path can
carry the user's intent and evidence from the browser, through persistence and
the runtime, into a grounded result that survives refresh and follow-up.

This program prioritizes the product in dependency order:

1. access and identity;
2. core chat execution;
3. durable threads and conversational context;
4. files, images, and structured data;
5. grounded, useful answers;
6. connected tools and work data;
7. artifacts and durable work products;
8. user-controlled memory;
9. reusable Skills;
10. sharing;
11. recommendations;
12. schedules and event triggers;
13. app generation and deployment.

The blocking alpha program covers 1–7 first, then 8–9. Existing safety
regressions for later features continue to run, but new scheduling,
recommendation, sharing, and app breadth must not displace core-quality work.

## Non-negotiable invariants

Every capability is evaluated against the same five invariants:

- **No silent data loss.** Anything the UI says was sent must reach the
  authoritative server path or fail visibly.
- **No fabricated success.** The assistant must not claim to have read,
  created, updated, sent, or persisted something without matching evidence.
- **Correct authorization.** User, tenant, provider, tool, and write boundaries
  remain intact in success, error, retry, share, and reconnect paths.
- **Recoverable failures.** Errors explain the failed layer and preserve enough
  state for a safe retry without duplicating work.
- **Usable real-browser behavior.** The capability works through the actual UI
  on supported desktop and mobile layouts, not only through helpers or mocked
  route responses.

## Evaluation layers

No single test type can establish product quality. Each core behavior needs the
lowest-cost layers that can catch its failure modes.

| Layer | Model/runtime | What it proves | Default cadence |
| --- | --- | --- | --- |
| Unit and contract | Fake or none | Parsing, scoping, state machines, prompt construction, exact invariants | Every PR |
| Integration | Fake/scripted | Real route, Postgres, persistence, authorization, worker and SSE contracts | Every PR |
| Browser feature | Mocked API | Component interaction, layout, keyboard, mobile and visual states | Every PR |
| Browser real pipeline | Scripted model, real API/DB/runtime | Browser payload reaches the real product path and produces evidence-backed UI | Every PR and every six hours |
| Core behavioral eval | Real Bedrock, production-shaped deterministic fixtures | Model instruction following, grounding, tool decisions and qualitative output | Every ready same-repo PR |
| Full behavioral eval | Real Bedrock, deterministic fixtures | All maintained behavioral and adversarial regressions | Nightly |
| Browser + real model | Real Bedrock, real API/DB/runtime | Production preamble and resource serialization work through the actual UI and persistence path | Nightly |
| Codex agent-as-user browser | Codex in-app Browser, deployed app | A browser-operating agent can discover and complete core workflows through visible UI without API or database shortcuts | Nightly advisory / pre-release |
| Production smoke | Deployed runtime | Deployment configuration, real services, persistence and post-deploy health | After deploy / scheduled |
| Human calibration | Blinded labelled samples | Automated graders still measure what users consider correct and useful | Weekly during alpha |

Passing a mocked browser test does not substitute for a real-pipeline test.
Passing a component behavioral eval does not substitute for the app route,
database, worker, or browser. The layers are intentionally complementary.
The Codex browser-user lane is also intentionally separate: GitHub-hosted
Playwright proves deterministic product behavior, while the local Codex
browser canary measures whether an agent can discover and operate the rendered
experience.

## Core coverage matrix

### 1. Access and identity

- invited and uninvited sign-in;
- protected-route redirects;
- correct user and tenant scoping;
- refresh and navigation session continuity;
- expired-session recovery without losing a composed prompt;
- onboarding complete and skip paths;
- desktop and mobile shell navigation;
- useful error and feedback paths.

Critical failures: cross-user access, authentication bypass, or lost composed
work during recoverable re-authentication.

### 2. Core chat execution

- first turn, multi-turn, empty and long input;
- streaming event order and terminal event;
- incremental rendering and Markdown/table/code rendering;
- stop, cancel, retry, regenerate, and edit-and-resend;
- no duplicate messages or duplicate runs;
- selected, executed, and displayed model identity agreement;
- ordinary conversation stays on the lightest correct lane;
- provider/model failure and safe failover;
- browser disconnect, reconnect, reload, and partial-run states;
- meaningful empty, loading, working, success, and failure UI.

Critical failures: stuck runs without recovery, duplicated writes/turns,
persisted state contradicting the visible state, or silent model substitution.

### 3. Durable context and threads

- history ordering and user scoping;
- follow-up references to prior facts and artifacts;
- correction of earlier user information;
- recent instructions outrank stale conversation data;
- edit/regenerate removes the abandoned branch;
- long-context compaction preserves named constraints and decisions;
- current date, locale, and user timezone;
- thread rename, archive/delete, and reload;
- no context leak between threads;
- stale and failed historical tool evidence is labelled correctly.

Critical failures: cross-thread/user leakage or a current explicit correction
being replaced by stale context.

### 4. Files, images, and structured data

- picker, drag/drop, and paste;
- CSV/TSV, XLSX, PDF, DOCX, PPTX, image, and text fixtures;
- MIME/name disagreement and malformed inputs;
- extraction fidelity for numbers, booleans, dates, formulas, sheets, tables,
  paragraphs, and slide ordering;
- clear unsupported, oversized, truncated, encrypted, and scanned-file states;
- filename and attachment state before send, after send, and after reload;
- exact payload-to-persistence parity;
- resource authorization and current-upload selection;
- required resource read before a comprehensive claim;
- content availability across multiple agent/tool iterations;
- follow-up and edit/replay behavior;
- multi-file identity and order;
- prompt injection, forged markers, secrets, and tool-call-shaped file content;
- visible failure instead of a dropped attachment.

The canonical canary is a CSV with a unique row/value. A required PR browser
test uploads it through the real composer and `/api/chat`, forces a real
resource-tool round trip with a deterministic model, verifies the canary in the
rendered answer, reloads, and verifies a follow-up can still recover it. The
same journey runs every six hours; nightly it additionally runs against real
Bedrock so the production preamble, real resource contract, and model are
exercised together.

Critical failures: UI/payload disagreement, an accepted file becoming
unavailable to the runtime, invented file content, or file content gaining
instruction authority.

### 5. Grounded answer quality

- direct task completion;
- exact preservation of supplied names, numbers, dates, units, and caveats;
- separation of source facts, inference, and recommendation;
- faithful summaries at short and long input sizes;
- requested format, tone, and length;
- clarification when the request or evidence is insufficient;
- explicit limitation for partial/truncated evidence;
- citation/attribution correctness when evidence is available;
- contradiction handling;
- refusal to invent current events, files, results, links, or actions.

Exact facts and prohibitions use deterministic assertions. Qualitative
faithfulness uses reference-guided rubrics that include the relevant evidence,
not an answer-only judge.

### 6. Connected tools and work data

Every live provider gets the same baseline matrix:

- disconnected, connected, pending approval, approved, expired, and revoked;
- capability question versus actual action request;
- provider and tool selection;
- argument extraction and provider precedence;
- minimum sufficient tool sequence;
- successful, empty, partial, paginated, stale, rate-limited, and failed result;
- exact grounding in tool evidence;
- no provider-loss claim when a tool is merely not mounted;
- read/write distinction;
- prepare/confirm/execute for consequential writes;
- cancellation and retry without duplicate writes;
- prompt injection and forged tool results;
- redacted activity, audit, and run receipts;
- follow-up continuity and required freshness rechecks.

Critical failures: unauthorized tool use, destructive/unconfirmed writes,
duplicate writes, secret disclosure, or fabricated successful actions.

### 7. Artifacts and durable work products

- create requested document, data, code, or HTML artifact;
- valid filename, MIME type, syntax, and completeness;
- answer and artifact content agree;
- preview, download, reload, and transcript evidence;
- ordinary revision updates the same visible artifact;
- explicit copy/fork creates a distinct artifact;
- version history and revert;
- current artifact selection across turns and threads;
- multiple artifacts remain distinct;
- oversized edits and unsupported types fail honestly;
- no manual copy/save instructions after a real artifact exists;
- no claim of creation without a persisted artifact;
- secret scan and user/tenant scoping;
- desktop and mobile preview interaction.

Critical failures: false creation claims, wrong-user artifacts, secret-bearing
artifacts, or revision of the wrong artifact.

### 8. User-controlled memory

- propose only durable, useful facts;
- reject credentials, sensitive or transient facts;
- approval before injection;
- view, edit, delete, archive, deduplicate, and supersede;
- relevant retrieval without unnecessary disclosure;
- empty-memory honesty;
- user scoping;
- planted or poisoned memory remains lower-authority data;
- capture worker failure and safe retry.

### 9. Reusable Skills

- a manual workflow and its Skill produce equivalent grounded results;
- required parameters, tools, and providers;
- missing-input clarification;
- instruction and authority boundaries;
- starter Skill output contracts;
- manual and durable worker execution parity;
- retry/cancel and result delivery;
- versions and edits;
- output persistence to the correct thread;
- no hidden instruction disclosure.

## Case design

Each behavior pack should include:

- ordinary happy paths representative of alpha use;
- boundary and malformed inputs;
- empty and partial evidence;
- dependency and runtime errors;
- multi-turn follow-ups and corrections;
- adversarial content at every untrusted-data boundary;
- repeated probabilistic cases where a single sample is weak evidence;
- at least one regression fixture from a real user-discovered failure.

Cases carry stable capability, priority, severity, and tags. Security,
authorization, data-loss, and fabricated-success cases are `critical`.
Critical probabilistic behavior uses repeated runs with an `all` pass policy:
one unsafe transcript fails the case.

## Automated gates

### Every pull request

- lint, typecheck, unit/integration tests, and build;
- structural execution of every eval case with behavior assertions explicitly
  skipped and labelled;
- golden transcript replay;
- desktop/mobile browser feature suites;
- authenticated browser smoke;
- required real-pipeline CSV/context canary;
- for every ready same-repository pull request: the real Bedrock core profile
  using a Bedrock-only GitHub OIDC role, fanned into the already-required
  `local browser smoke` result.

Forked pull requests never receive AWS credentials. No workflow uses
`pull_request_target` to execute pull-request code.

### Nightly

- full real-model behavioral suite in one bounded lane;
- an independent app-backed real-Bedrock CSV lane through the production preamble,
  `/api/chat`, Postgres, resource MCP, SSE, reload, and follow-up;
- repeated critical/adversarial cases;
- JSON and Markdown report artifact;
- explicit configuration failure if the AWS role is absent;
- a separate timeout-safe GitHub issue job opened or refreshed when either lane
  regresses;
- retained per-case model, tool trace, evidence, usage, severity, and debug ids.

### Agent-as-user browser

- the repo-local `$comparative-browser-evals` skill defines two visible-UI
  canaries: CSV upload/grounding/reload/follow-up and artifact
  creation/preview/in-place revision/reload;
- once a dedicated browser profile is provisioned and manually verified, a
  local Codex scheduled task can use the in-app Browser; it never runs as a
  GitHub-hosted check;
- each scenario returns `PASS`, `FAIL`, or `BLOCKED`, exact weighted assertions,
  thread URLs, screenshots, visible errors, and qualitative UX notes;
- authentication, site permission, target availability, and missing browser
  capabilities are `BLOCKED`, never green;
- activation follows one successful manual dry run; the lane then remains
  advisory until at least 30 consecutive stable runs separate product failures
  from browser/runtime failures;
- every product defect it finds becomes a deterministic Playwright,
  integration, or behavioral regression with the fix.

### Deployment and production

- public production health on a schedule;
- authenticated post-deploy smoke using an isolated smoke identity;
- persisted turn and artifact checks;
- runtime/worker backlog checks;
- keep the deployed file-resource matrix and tool-backed worker canary aligned
  with the corresponding PR/nightly contracts.

## Dataset and grader hygiene

- Production-derived cases are scrubbed of names, email addresses, private
  repositories, customer data, tokens, and proprietary content before commit.
- Fixtures retain the failure shape and use stable synthetic facts.
- A bug is not closed until the cheapest layer that reproduces it gains a
  regression; user-visible cross-layer bugs also gain a browser or production
  check.
- Prompt changes are not tuned only against the visible regression set. Keep a
  small held-out set for model/prompt qualification.
- Prefer deterministic checks. A model judge is used only for qualities code
  cannot establish.
- Judge prompts include the criterion and relevant reference evidence. They do
  not ask for a generic impression.
- During alpha, humans review a blinded sample of passes and failures weekly.
  A judge must demonstrate acceptable agreement before its verdict alone
  becomes a required gate.

## Promotion rule

Every alpha failure is classified immediately:

1. deterministic code invariant → unit or integration regression;
2. browser interaction or visible state → Playwright regression;
3. model decision or grounded output → behavioral eval;
4. deployment/configuration behavior → production smoke;
5. cross-layer failure → more than one of the above.

The regression is added with the fix, not deferred to a later quality sprint.
