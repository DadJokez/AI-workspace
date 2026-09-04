# ADR 0014: Tamper-evident `audit_log` via a per-row hash chain

- **Status:** Proposed — design only; no code, no migration in this ADR
- **Date:** 2026-09-04
- **Deciders:** Rob (owner; approves the migration and the role/GRANT change), Claude/Codex (implementation once approved)
- **Related:** [#457](https://github.com/DadJokez/AI-workspace/issues/457) (this design), epic [#453](https://github.com/DadJokez/AI-workspace/issues/453), [#460](https://github.com/DadJokez/AI-workspace/issues/460) (retention window), [#455](https://github.com/DadJokez/AI-workspace/issues/455) (signing key), [ADR 0007](./0007-single-execution-ledger.md) (`runs`/`run_events` are *not* the audit log), [ADR 0008](./0008-handwritten-sql-migrations.md) (migration authoring), [docs/ENTERPRISE_READINESS.md](../ENTERPRISE_READINESS.md) §Audit log, [docs/BUILD_QUEUE.md](../BUILD_QUEUE.md) (Rob-gated list)

## Context

An enterprise security reviewer will ask: *can an admin, or a compromised
application credential, silently alter or delete audit history?* Today the
honest answer is **yes**. `audit_log` is append-only by convention only —
there is no DB-level constraint, no integrity chain, and the application's
database credential holds full DML on the table.

Issue #457 names three options in ascending assurance: (a) a DB role that can
`INSERT`/`SELECT` but not `UPDATE`/`DELETE` on `audit_log`; (b) a monotonic
per-row sequence plus periodic checkpoints; (c) a hash chain so that any
edit or deletion is detectable. Option (a) is a role/GRANT change and is
Rob-gated (`docs/BUILD_QUEUE.md`, "#457"). This ADR is the option (c) design,
which `BUILD_QUEUE.md` says may be drafted unattended. It absorbs (b): the
chain needs a monotonic sequence anyway, and the retention prune becomes the
checkpoint.

### The current `audit_log` shape

`packages/db/src/schema.ts:1717-1766` (`auditLog`):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `defaultRandom()` | random — carries **no ordering** |
| `actor_user_id` | `uuid` FK → `users.id` `ON DELETE SET NULL` | nullable |
| `action_type` | `text` NOT NULL | e.g. `mcp_tool_execution`, `mcp_tool_attestation`, `auth_sign_in_denied`, `skill_run`, … |
| `status` | enum `audit_log_status` (`started`/`succeeded`/`failed`/`denied`) | |
| `provider`, `tool_name`, `tool_call_id` | `text` | nullable |
| `chat_thread_id`, `chat_message_id`, `run_id` | `uuid` FKs, `ON DELETE SET NULL` | nullable |
| `input`, `output` | `jsonb` | already redacted at build time (`apps/web/lib/tool-redaction.ts`) |
| `error` | `text` | |
| `policy_decision` | enum `tool_policy_audit_decision` | ADR 0011 |
| `metadata` | `jsonb` | free-form per writer (`modelId`, `runtime`, `autonomyPreset`, `webEgress`, auth `schema`, …) |
| `started_at`, `completed_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` NOT NULL `defaultNow()` | **not monotonic** — `now()` is transaction start time |

Indexes: `(actor_user_id, created_at DESC)`, `(action_type, created_at DESC)`,
`(status)`, `(provider, tool_name)`, `(chat_message_id)`, `(run_id)`.

Two facts about the current shape drive the design:

1. **`ON DELETE SET NULL` FKs mutate audit rows.** Deleting a user, thread,
   message, or run rewrites `actor_user_id` / `chat_thread_id` /
   `chat_message_id` / `run_id` on historical audit rows. Those are *legitimate*
   in-place updates the chain must either exclude from the hash or forbid.
2. **Nothing orders the rows.** `id` is random and `created_at` is
   transaction-start time, so two concurrent writers can commit in the opposite
   order of their `created_at`. A chain needs a total order the writer assigns.

### The current writers

There is **no single writer**. `grep -rn 'insert(auditLog)'` over `apps/web`
finds ~60 call sites across route handlers and libs, half of them inside
callers' transactions (`tx.insert(auditLog)`), several inserting arrays
(`execute-chat-turn.ts:1938` bulk-inserts the per-turn tool rows built by
`buildToolAuditRows`, `apps/web/lib/audit-tool-events.ts:72`;
`tool-approvals.ts`, `workspace-artifacts.ts`, `admin-data-access.ts`,
`oauth/connection.ts` do the same). `apps/web/lib/audit-tool-events.ts` is a
pure row *builder* — it shapes `mcp_tool_execution` rows (status from the
result, redacted input/output, executor policy decision, metadata) but does
not write. `apps/web/lib/auth/auth-audit.ts:152` is a writer that deliberately
fails open (a ledger outage must not lock everyone out of sign-in).

The only `UPDATE`/`DELETE` paths are `apps/web/lib/audit-retention.ts:82`
(`pruneAuditLog`, `DELETE … WHERE created_at < cutoff`, run by
`pnpm audit:retention`, destructive only with `AUDIT_LOG_RETENTION_DAYS` set)
and integration-test teardown. No production code updates an audit row.

## Decision

### 1. Chain columns (additive)

Three columns are added to `audit_log`; nothing existing changes shape.

| Column | Type | Meaning |
|---|---|---|
| `seq` | `bigint` NOT NULL, UNIQUE, fed by a dedicated sequence `audit_log_seq` | the chain position. Assigned **inside the trigger under the chain lock** (§3), not by a column default — a default would draw the number before the lock and let `seq` order drift from chain order. It is the total order; `created_at` is not. |
| `prev_hash` | `bytea` NOT NULL (32 bytes) | `row_hash` of the row with the greatest lower `seq`; the **genesis** value for the first row. |
| `row_hash` | `bytea` NOT NULL (32 bytes) | `sha256(canonical(row) ‖ prev_hash)`. |

Genesis: `prev_hash` of the first chained row is
`sha256('comparative.audit_log.genesis.v1')` — a fixed, non-secret constant.
Using a named constant rather than 32 zero bytes makes a truncated-and-restarted
chain distinguishable from a pristine one.

### 2. Canonical fields and hashing

`row_hash = sha256( canonical ‖ prev_hash )` where `canonical` is the
concatenation, with a `\x1f` (unit separator) between fields and the literal
`\x00` byte for SQL `NULL`, of these fields **in this order**:

```
seq, id, action_type, status, provider, tool_name, tool_call_id,
input::jsonb::text, output::jsonb::text, error, policy_decision,
metadata::jsonb::text, started_at (epoch µs), completed_at (epoch µs),
created_at (epoch µs)
```

Deliberately **excluded**: `actor_user_id`, `chat_thread_id`,
`chat_message_id`, `run_id` — the four `ON DELETE SET NULL` FK columns. Their
legitimate nulling on cascade would otherwise break the chain; instead the
*original* values are preserved by the trigger (§3) copying them into the
hashed `metadata` at write time under `metadata.chain.actor`, `.thread`, `.message`, `.run`
(only when non-null), so an attacker who edits the FK column still cannot
edit the hashed copy. The verifier (§5) reports a mismatch between a non-null
FK column and its hashed copy as a broken link.

Canonicalization notes:
- `jsonb::text` is deterministic in PostgreSQL (keys stored sorted, duplicates
  dropped, whitespace normalized) — that is why the columns are `jsonb`, not
  `json`, and why the hash is computed **in the database** (§3): a TypeScript
  canonicalization would have to byte-match PostgreSQL's, which is a trap.
- Timestamps hash as integer microseconds since epoch
  (`extract(epoch from ts) * 1e6`, rounded) to avoid text-format and timezone
  drift.
- Enums hash as their text label.
- `sha256(bytea)` is a core function since PostgreSQL 11; no `pgcrypto`
  extension is required. The implementation PR confirms the RDS engine
  version before relying on it.

The hashing is factored into one SQL function,
`audit_log_row_hash(r audit_log, prev bytea) RETURNS bytea`, so the writer
(§3) and the verifier (§5) cannot disagree about the recipe.

### 3. Where the chain is computed: a `BEFORE INSERT` trigger is the single writer

With ~60 insert sites and no shared helper, "compute it in the writer" would
mean either a large refactor to route every insert through one
`appendAuditRows()` function or, worse, a convention that the next writer
forgets. The chain must be unforgeable by *omission*, so the single-writer
path is put where every insert already converges: **a `BEFORE INSERT FOR EACH
ROW` trigger on `audit_log`**.

```sql
CREATE FUNCTION audit_log_chain_link() RETURNS trigger AS $$
DECLARE prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));   -- serialize writers
  SELECT row_hash INTO prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF prev IS NULL THEN prev := sha256('comparative.audit_log.genesis.v1'::bytea); END IF;
  NEW.seq      := nextval('audit_log_seq');                        -- under the lock, so seq order == chain order
  NEW.prev_hash := prev;
  NEW.row_hash  := audit_log_row_hash(NEW, prev);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

- The transaction-scoped advisory lock makes chain computation
  single-writer by construction: concurrent transactions queue, each sees the
  committed head, and `seq` order equals chain order. Array inserts inside one
  transaction take the lock once.
- **Isolation requirement.** The lock only serializes writers; the post-lock
  head read (`SELECT row_hash … ORDER BY seq DESC LIMIT 1`) sees the
  just-committed head only if the statement takes a fresh snapshot, which is
  true under READ COMMITTED. Under REPEATABLE READ or SERIALIZABLE the
  trigger's snapshot predates the concurrent writer's commit, so two rows
  chain off the same stale `prev_hash` and the verifier (§5) correctly flags
  a fork. Because audit inserts run inside callers' transactions whose
  isolation level the callers choose, the trigger must read the head with a
  fresh snapshot regardless of that level. Two options: (i) make the head read
  snapshot-independent (a single-row `audit_log_head` table updated with
  `UPDATE … RETURNING`, which under REPEATABLE READ raises a serialization
  error rather than reading stale data), or (ii) make READ COMMITTED a hard
  requirement on every audit writer's transaction, enforced by the trigger
  raising if `current_setting('transaction_isolation') <> 'read committed'`.
  **Recommendation: (ii).** No writer in the tree sets a non-default isolation
  level today, so (ii) costs nothing, adds no second table to the migration
  and the verifier, and turns a silent chain fork into an immediate, loud
  error at the first misuse.
- Writers stay as they are. `buildToolAuditRows` keeps building rows; drizzle
  inserts keep omitting `seq`/`prev_hash`/`row_hash` (the schema marks them
  as DB-generated). The fail-open auth writer stays fail-open.
- A companion `BEFORE UPDATE OR DELETE` trigger **rejects** any change to
  `seq`, `prev_hash`, `row_hash`, or a hashed field, and rejects `DELETE`
  unless a session variable set only by the retention prune
  (`SET LOCAL comparative.audit_prune = 'on'`) is present. FK cascades that
  null the excluded columns still pass. This is *tamper-evidence with a
  speed bump*, not enforcement: the app role can still `DROP TRIGGER`. Real
  enforcement is option (a), §7.

Cost: every audit insert serializes on one advisory lock and does one
index-backed `ORDER BY seq DESC LIMIT 1`. Audit writes are per tool call /
per admin action, not per token; this is well inside budget. The
implementation PR measures the p99 of `execute-chat-turn.ts:1938` (the bulk
insert) before and after.

### 4. Retention becomes the checkpoint

`pruneAuditLog` deletes the oldest rows, so the surviving chain will not start
at genesis. Rather than a separate checkpoint table (option (b)), the prune
itself is recorded in the chain:

- Prune by **`seq` prefix**, not by `created_at` alone: the cutoff is
  `min(seq) WHERE created_at >= cutoff`, and rows with `seq` below it are
  deleted. This keeps the survivor set a contiguous suffix even though
  `created_at` is not monotonic.
- Before deleting, the prune reads the `row_hash` of the last row it will
  delete, then (inside the same transaction, after the delete) inserts one
  audit row `action_type = 'audit_log_retention_prune'` with
  `metadata = { retentionDays, cutoff, deletedSeqRange: [lo, hi],
  lastDeletedRowHash }`. That row is chained like any other.
- The verifier (§5) treats the newest `audit_log_retention_prune` row as the
  trusted head: the first surviving row's `prev_hash` must equal that row's
  `lastDeletedRowHash`. A prune that did not leave its receipt, or a
  surviving-head mismatch, is a broken link.

`AUDIT_LOG_RETENTION_DAYS` semantics, the window itself, and legal hold are
#460's, not this ADR's.

### 5. Verification tooling

`apps/web/scripts/audit-verify-chain.ts`, exposed as `pnpm audit:verify`,
beside the existing `pnpm audit:retention` and in the same style (JSON to
stdout, non-zero exit on failure, `getDb()`/`closeDb()`):

1. Load the newest `audit_log_retention_prune` row (if any) to learn the
   expected `prev_hash` of the surviving head; otherwise expect genesis.
2. Walk `audit_log ORDER BY seq` in batches of 1000 with a keyset cursor.
   For each row check, in order:
   - `seq` is strictly greater than the previous row's `seq`. **Gaps are
     expected and carry no signal**: `nextval('audit_log_seq')` is
     non-transactional, so every rolled-back transaction burns a value (about
     half the writers insert inside callers' transactions, which roll back on
     constraint violations, retries, and ordinary business-logic failures).
     Deletion of an interior row is detected purely by `prev_hash` linkage —
     the next surviving row's stored `prev_hash` will not equal the actual
     previous surviving row's `row_hash` — which is unaffected by burned
     sequence values because `prev_hash` is read from the *committed* head.
     Deletion of the *tail* (the most recent N rows) has no next surviving
     row and is **not** detected by the walk; see Consequences;
   - `prev_hash` equals the previous row's `row_hash`;
   - `row_hash` equals `audit_log_row_hash(row, prev_hash)` recomputed by the
     database;
   - each non-null FK column equals its hashed copy in `metadata.chain`;
   - **suspicious, not failing:** an FK column is null but `metadata.chain`
     still carries a value for it *and* the referenced row still exists (for
     `actor_user_id`, the user is present in `users`). A legitimate cascade
     only nulls the column when the referenced row is gone, so this pattern
     is reported as `warnings: [{ seq, column, reason: 'fk-nulled-target-exists' }]`
     in the output rather than a chain break.
3. Stop at the **first** failure and print
   `{ ok: false, brokenAt: { seq, id, createdAt }, reason, rowsChecked }`;
   otherwise `{ ok: true, rowsChecked, head: { seq, rowHash } }`.

`--from-seq N` resumes a long walk; `--head-only` verifies just the last row
against the previous one (cheap liveness check for a scheduled job). The
script runs with the same read-only credential an auditor would use; it never
writes.

Unit coverage (vitest): a pure `findFirstBrokenLink(rows, expectedHead)`
over fixture rows — pristine chain, edited field, deleted middle row,
deleted head with a prune receipt (passes), deleted head *without* a prune
receipt (passes — this fixture pins the head-truncation gap named in
Consequences so nobody later mistakes it for coverage),
nulled-FK-with-matching-copy (passes), nulled-FK-with-mismatched-copy
(fails), and nulled-FK-with-copy-present-and-target-alive (warns). The hash recipe itself
is exercised by an integration test that inserts through drizzle and then
runs the verifier against a real PostgreSQL.

### 6. Migration shape (proposal — Rob approves before it is written)

Handwritten SQL per ADR 0008, one migration `00NN_audit_log_hash_chain.sql`
plus its `_journal.json` entry:

1. `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq bigint`, `prev_hash
   bytea`, `row_hash bytea` — all nullable at this step.
2. `CREATE OR REPLACE FUNCTION audit_log_row_hash(...)`.
3. **Backfill**, in one transaction holding `LOCK TABLE audit_log IN EXCLUSIVE
   MODE` (readers proceed, writers wait): assign `seq` by
   `ORDER BY created_at, id` (the best available order for pre-chain rows —
   the ADR accepts that this is *an* order, not the true write order; it only
   needs to be fixed from here on), copy FK values into `metadata.chain`,
   then compute `prev_hash`/`row_hash` in a single `DO` block walking
   `seq` ascending from genesis.
4. `CREATE SEQUENCE audit_log_seq OWNED BY audit_log.seq` restarted at
   `max(seq) + 1`; add the `UNIQUE` index on `seq`. No column default — the
   trigger draws from the sequence (§3).
5. `SET NOT NULL` on the three columns; create the `BEFORE INSERT` and
   `BEFORE UPDATE OR DELETE` triggers.
6. Deploy note: the transaction blocks audit inserts for the duration of the
   backfill. Row count is checked first (`SELECT count(*) FROM audit_log`); if
   it is large enough that the exclusive lock would exceed the auth writer's
   tolerance, step 3 is split into an online backfill script and the
   `NOT NULL` step becomes a second migration. Expected to be unnecessary at
   current volume.

`schema.ts` gains the three columns (`seq: bigint(...)`, `prevHash`/`rowHash`
as `customType` bytea, all marked `.generatedAlwaysAs`-style DB-generated so
existing `insert().values()` sites compile unchanged). `pruneAuditLog` is
changed as in §4 and the `mcp_tool_execution` writer path is unchanged.

### 7. What option (a) adds on top

The chain makes tampering **evident**; it does not make it impossible. Option
(a) — a separate application DB role with `SELECT, INSERT` on `audit_log` and
no `UPDATE`, `DELETE`, `TRUNCATE`, or `TRIGGER` privilege, with the trigger
functions and the table owned by the migration role — is what turns the
`BEFORE UPDATE OR DELETE` speed bump into enforcement:

- A compromised app credential can neither rewrite history nor disable the
  trigger that would expose the rewrite.
- The retention prune runs under the migration/ops role (it already runs
  as a separate script, so this is a credential choice, not a code change).
- FK `ON DELETE SET NULL` cascades still work under the app role because
  cascades execute with the privileges of the referencing table's owner, not
  the deleting session — a fact the implementation PR verifies against the
  real engine version.

(a) is a role/GRANT plus a credential rollout across three ECS services and
the AgentCore container — Rob-gated, and sequenced **before or with** the
chain migration, not after: shipping the chain under a role that can drop it
gives a reviewer a false sense of assurance. Both are tracked on #457.

## Consequences

- **Buys:** a reviewer-legible answer — "any edit to a hashed field, and any
  deletion of an interior row, is detectable by `pnpm audit:verify`; with the
  restricted role the app cannot make one" — using core PostgreSQL only, no
  extension, no new dependency, no change to ~60 writers. The two things the
  chain alone does *not* buy are named below (head truncation, attribution
  erasure); the honest claim is "edits and interior deletions", not "any
  deletion".
- **Buys:** an order. `seq` gives the admin audit page and trace views a
  stable sort that `created_at` never did.
- **Costs:** all audit inserts serialize on one advisory lock; bulk inserts
  amortize it. Every audit row grows by 8 + 32 + 32 bytes plus the
  `metadata.chain` copy.
- **Costs:** the FK-exclusion rule is subtle. It is encoded once in
  `audit_log_row_hash`, documented here, and pinned by the verifier tests;
  adding a future `ON DELETE SET NULL` FK to `audit_log` must add it to the
  exclusion list and the `metadata.chain` copy, or cascades will break the
  chain.
- **Forecloses:** editing audit rows for any reason, including "fixing" a
  redaction miss. A missed redaction becomes a *new* row (`action_type =
  'audit_log_redaction'`) that references the offending `seq`, plus the
  operational decision to prune; the original bytes stay until retention
  removes them. This is the right property for an audit log and the wrong
  one for anything else — do not reuse the pattern for `run_events`.
- **Residual gap — head truncation is not detected by the chain alone.** An
  attacker with DELETE who removes the most-recent N rows leaves a chain that
  is internally consistent: every surviving `prev_hash` → `row_hash` link
  still verifies, `max(seq)` is not anchored anywhere trusted, no prune
  receipt is written (the attacker does not write one), and `--head-only`
  passes because it compares the surviving head to its predecessor. The
  verifier returns `{ ok: true }` and the deletion is invisible. Suppression
  of the tail is therefore **out of scope for the chain alone**. It is covered
  by two mitigations, both listed under "Not in this ADR": option (a)'s
  removal of DELETE from the app role (so only the retention prune, running
  as a separate identity, can delete), and external head-anchoring (a
  scheduled job publishing `{ seq, rowHash }` of the head to a store the DB
  role cannot write, which turns a missing tail into a head mismatch).
- **Residual gap — attribution erasure via FK-nulling.** The exclude-and-copy
  rule (§2) must *allow* `actor_user_id`, `chat_thread_id`, `chat_message_id`
  and `run_id` to be nulled so legitimate `ON DELETE SET NULL` cascades pass.
  Those columns are not in `row_hash`, so an attacker with UPDATE can set
  `actor_user_id = NULL` on a row to strip *who did it*, and the result is
  byte-for-byte indistinguishable from a user-deletion cascade: the hash is
  unchanged, and the verifier only compares *non-null* FK columns against
  `metadata.chain`, so the nulled column is skipped. For an audit log, silent
  de-attribution is a meaningful tamper. Mitigations: option (a) removes
  UPDATE from the app role entirely, which closes the app-credential case;
  and the verifier flags "FK column null, but `metadata.chain` still carries
  the value and the referenced row still exists" as suspicious (§5) — a real
  cascade only nulls the column once the referenced row is gone, so a
  surviving `users` row with a nulled `actor_user_id` has no innocent
  explanation. An admin with DML who also deletes the user is not caught by
  this check; that is the DDL/superuser tier below.
- **Threat model, honestly:** the chain has no secret. A party with DDL on
  the database (superuser, the migration role, anyone who can `CREATE OR
  REPLACE` the hash function) can rewrite the whole chain consistently and the
  verifier will pass. Detecting *that* needs the head hash anchored outside
  the database (see "Not in this ADR"). What the chain does defeat is the
  realistic case: a compromised app credential or an admin with DML editing
  hashed fields or deleting interior rows. It does not, by itself, defeat
  the same party truncating the tail or nulling an excluded FK column; those
  two cases rest on option (a)'s DELETE/UPDATE revocation, external
  head-anchoring, and the verifier's null-FK warning, as described above.

## Alternatives considered

- **Compute the hash in TypeScript in one `appendAuditRows()` helper.**
  Rejected: it requires touching ~60 call sites, it is bypassable by the
  next `db.insert(auditLog)`, and TS-side JSON canonicalization must
  byte-match PostgreSQL's `jsonb::text` or the verifier lies. The trigger is
  the only place every writer already passes through.
- **HMAC with a server-held key instead of a plain hash.** Raises the bar
  from "DDL on the DB" to "DDL plus the key", but couples to #455 (split
  signing key, Rob-gated env change) and forces the hash out of the database
  and back into the writers. Revisit once #455 lands; the column and
  verifier shape do not change, only the recipe.
- **Merkle tree / periodic root only (option (b) alone).** Cheaper per row
  but cannot localize a tampered row to a `seq`, which is the thing an
  incident responder actually needs.
- **Ship `audit_log` rows to an external append-only sink (CloudWatch Logs,
  S3 Object Lock) and treat the DB as a cache.** The stronger design long
  term, and the natural home for the external anchor, but it is an
  infrastructure/cost decision (Rob's) and does not remove the need for the
  in-DB chain, which is what a reviewer can see in the schema.
- **Option (a) alone, no chain.** Blocks the app credential but leaves an
  admin with DML free to edit silently; the reviewer's question is about
  detection as much as prevention.

## Not in this ADR

- **Option (a)** — the restricted DB role, GRANTs, credential rollout, and
  the `TRIGGER` privilege split. Rob-gated; §7 says what it adds, nothing
  here creates it.
- **External anchoring** of the chain head (periodic `{seq, row_hash}`
  export to CloudWatch Logs / S3 Object Lock / a signed release note) that
  would detect a whole-chain rewrite by a DDL-holder and, because a missing
  tail becomes a head mismatch, head truncation (Consequences). Follow-up
  issue once the chain exists.
- **The retention window, legal hold, and `AUDIT_LOG_RETENTION_DAYS`
  policy** — #460. This ADR only fixes the *mechanics* of a prune so it does
  not break the chain.
- **Signing with a secret key** — #455; see Alternatives.
- **Chaining any other table** (`run_events`, `tool_approval_requests`,
  `oauth_tokens`). ADR 0007's ledger is operational state, not the audit log.
- **An admin UI** for verification results; `pnpm audit:verify` is a script
  and, later, a scheduled job.
- **Correctness or completeness of what gets audited** — which actions
  write rows, what is redacted, and the `would_*` fallback of ADR 0011 are
  unchanged.
- **The migration and the code.** This ADR is the proposal Rob approves;
  the implementation is a separate PR with the migration flagged
  human-owned at the top of its body, and it does not run against a live
  database unattended.

## Revisit when

- #455 lands a server-held signing key (switch `audit_log_row_hash` to HMAC).
- An external append-only sink is provisioned (move the anchor there; the
  in-DB chain stays).
- `audit_log` write volume makes the single advisory lock visible in the
  chat-turn p99 (partition the chain per `actor_user_id` with a per-user
  head; the verifier walks per partition).
