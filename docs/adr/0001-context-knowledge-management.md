# ADR 0001 — Context & Knowledge Management: curated-context-first, defer the vector DB

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Rob (PM), Claude (PO/lead dev)
- **Related:** [docs/KNOWLEDGE_MANAGEMENT.md](../KNOWLEDGE_MANAGEMENT.md), [DESKTOP_PARITY_BACKLOG.md](../DESKTOP_PARITY_BACKLOG.md) P1.2 (Projects), P1.3 (Memory)

## Context

"Projects" in Claude Desktop bundles persistent instructions + reference files
+ threads under one shared context. Asking how to build it surfaced the real
question: **how should the assistant actually acquire and use team/company
knowledge?** Three mechanisms were on the table — a curated "LLM wiki," a
personal/team **vector database (RAG)**, and "how do people share with the
team." This ADR records which mechanism we use, when, and why — because the
choice is also a **governance** decision that the enterprise IT review will
scrutinize.

The trap is conflating two different problems:

- **Problem A — "know our context"** (small, always-on): fiscal year, glossary,
  which systems we use, how we format a status update. A few hundred to a few
  thousand tokens. **Fits in the prompt.**
- **Problem B — "answer from our documents"** (large corpus): search hundreds of
  SOPs and answer from them. Too big to inject → needs retrieval (embeddings +
  a vector store).

~80% of the "it finally knows us" value is Problem A. Reaching for a vector DB
first (Problem B) is the common, expensive mistake: RAG adds stale embeddings,
retrieval misses, chunk-boundary errors, "confidently cites the wrong doc," and
— most importantly — it **forks the access-control model** (whose documents can
you retrieve?) and creates a **new classified data store** IT must audit.

## Decision

Adopt a **four-scope context model** (user → project → team → org) with a
**single injection point** (an extension of `buildAgentPreamble`), and acquire
knowledge with the **cheapest sufficient mechanism per layer**:

1. **Curated context ("LLM wiki") — direct injection, no vector DB.**
   Human-written, owned-and-dated project/team/org facts injected into every
   turn in scope. This is the default and the starting build.

2. **Project reference files — inject while they fit; retrieve only when they
   don't.** A handful of files attached to a project are injected (or
   summarized). A vector index is added **only** when a project's files exceed
   the context budget, and is **scoped to that project's own files** so
   project membership *is* the retrieval ACL.

3. **Org-wide / live-source search — MCP-against-source, not a shadow index.**
   When users need to search live company systems (SharePoint, Workfront), we
   retrieve **through an MCP server using the requesting user's own
   credentials**, so the source system enforces its own permissions and content
   is never stale. We do **not** copy the corpus into our own vector store.

**Sharing** reuses the existing membership/`shares` pattern: a project has
members; members see its curated context and can retrieve its files. A file
*uploaded into* a shared project is shared by that act; a **live source
document is always fetched with the requesting user's credentials** — context
never escalates access.

**Vector store, when needed:** `pgvector` in the existing **RDS Postgres**
(no new infrastructure), embeddings from a **Bedrock** embedding model. Escalate
to **Bedrock Knowledge Bases** only if a unified, cross-project index becomes a
real requirement.

## Build sequence

1. **Projects container + curated context + small injected files.** No
   embeddings. (P1.2 — the next build.)
2. **pgvector retrieval scoped to project files** — only when a real project
   outgrows the context budget. Demand-driven, not speculative.
3. **Org-wide / live-source RAG — deferred**; when it comes, MCP-against-source
   first; a unified Bedrock Knowledge Base only if forced.

## Consequences

**Positive**
- Most of the value ships in Phase 1 with zero new infrastructure and minimal
  governance surface.
- The defensible IT-review sentence: *"We inject curated context and retrieve
  live documents with the user's own credentials; we do not maintain a shadow
  copy of company documents in a separate index."*
- ACL stays simple: project membership = retrieval access; live docs keep their
  source permissions.
- When vectors are needed, they reuse RDS + Bedrock — same account, same
  governance story, consistent with the thin-wrapper-on-AWS doctrine.

**Negative / risks**
- Curated context can rot → mitigated by owned-and-dated items + a periodic
  "review your context" nudge (in KNOWLEDGE_MANAGEMENT.md).
- "Just index everything" will be a recurring request; this ADR is the artifact
  to point at for why we don't, until a measured need appears.
- MCP-against-source depends on the relevant integration existing (GitHub today;
  M365/Workfront later) — until then, org-wide live search is simply not
  offered rather than faked.

## Alternatives considered

- **Vector DB first (index all company docs).** Rejected as the day-one default:
  highest cost, highest governance surface, weakest ACL/freshness story, and it
  solves Problem B while most value is Problem A. Available later as Phase 2/3
  when demand is proven.
- **Bedrock Knowledge Bases from the start.** Good managed RAG, but premature: it
  presumes a unified index we haven't justified. Held in reserve for Layer 3.
- **Per-user personal vector DB.** Overkill for personal context, which is small
  and curated (the Memory surface, P1.3) — injection beats retrieval here.

## Revisit when

A real project's reference files exceed the context budget (triggers Phase 2),
or a sponsored use case genuinely requires org-wide document search (re-opens
the Layer 3 MCP-vs-Knowledge-Base decision).
