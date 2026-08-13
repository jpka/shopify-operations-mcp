# Project Context: Agentic-Engineering Portfolio for Upwork/Fiverr

**Purpose:** Handoff/context doc summarizing this session so it can be picked up in a new conversation or shared with a collaborator.

## Background

User has an existing Upwork freelancer profile: [https://www.upwork.com/freelancers/\~01c09a254fcc9fcc76](https://www.upwork.com/freelancers/~01c09a254fcc9fcc76)

Publicly readable header only (full skills/portfolio are behind Upwork's login wall):

- Name: Juan Pablo K.  
- Title: "Full-Stack Engineer"  
- Location: Rio Cuarto, Argentina  
- Rate: $35/hr  
- Job Success Score: 100%  
- Badge: Top Rated  
- Rating: 4.2★ (31 reviews)  
- Volume: 48 jobs, 270 total hours

**Key gap identified:** the profile shows zero AI/agentic specialization despite being a proven, well-reviewed full-stack generalist. This is the primary strategic opening.

## Full research report

A detailed research report was generated earlier in this session covering:

- Upwork's 2026 in-demand-skills data (AI Integration \+178%, AI Chatbot Dev \+71%)  
- Fiverr's 2026 trends data (Claude Code specialists \+938%, n8n \+125%)  
- Actual job-posting screening requirements (GitHub links, live demos, case studies, anti-"ChatGPT wrapper" positioning)  
- Rate benchmarks ($40–$60/hr for AI/RAG work vs. current $35/hr generalist rate)  
- 7 tiered portfolio project ideas with effort estimates, stacks, and Fiverr packaging

This report exists as a canvas/artifact in the conversation (title: "Full-Stack Freelancer Portfolio Strategy for Agentic-Engineering Work on Upwork and Fiverr (August 2026)"). **Reference it rather than re-deriving the market research** — re-fetch it from the conversation history or re-run research only if it's not accessible in the new context.

## Decisions made so far

**Three flagship portfolio projects selected** (narrowed down from the 7-idea report):

1. **RAG assistant over a hard corpus** (building codes / insurance policies / tariff schedules — something that breaks naive chunking). Hybrid search \+ reranker, citations, nightly eval suite (ragas), published precision@k metrics including failure modes. \~2 weeks. Fiverr tiers: $200/$600/$1,500.  
     
2. **Write-capable MCP server with approval gating \+ audit log.** Chosen because most public MCP servers are read-only; a safe-write one is the scarce, differentiated build. \~1 week. Fiverr/Project Catalog tiers: $350/$500/$2,500.  
     
3. **Support-triage agent (LangGraph) that visibly recovers from tool failure on camera.** Classify → pull order history → draft reply → escalate/approve. Deliberately shows a broken-tool scenario and retry/recovery, not just the happy path. \~2 weeks. Fiverr tiers: $500/$900/$2,000+.

**Suggested build order:** MCP server first (shortest, rarest credential) → RAG assistant (broadest demand) → agent (most complex, benefits from patterns built in the first two). **Progress:** MCP servers done; RAG assistant next.

**Universal proof-of-work rules** (non-negotiable per market research): public GitHub repo with clean README \+ architecture diagram; live demo URL; 3–5 min Loom walkthrough; one quantified metric per project; never use generic/AI-written cover letters when applying.

### MCP server: three concrete proposals drafted, user chose C (A also built)

- **Option A — Safe-Write Postgres Server (BUILT).** 7 tools (query, explain\_plan, describe\_schema, insert/update/delete rows, run\_migration). Safety: EXPLAIN-before-write with row-count estimate, dry-run mode with transaction rollback, per-table allowlists, full audit log. Strongest moat — no vendor competition, no fakeable API keys. Best engineering showcase. \~1 week. Repo: [sw-postgres-mcp](https://github.com/jpka/sw-postgres-mcp).  
- **Option B — Stripe Test-Mode Financial Ops Server.** 8 tools around refunds/subscriptions/credits. Safety: currency ceilings, idempotency keys, approval queue, reconciliation against Stripe's event stream. Stripe has an official MCP server already — this differentiates on governance/controls, not coverage. Better as a contract-closing demo than a standalone gig. \~1 week \+ a day of fixture setup. Not built.  
- **Option C — Shopify Store Operations Server (BUILT).** 8 tools (bulk price/inventory updates, order cancels, refunds, discounts). Safety: preview manifest before bulk writes, percentage-change guards, one-call rollback token. Best commercial legibility (huge non-technical buyer base), best productization potential. \~1 week \+ dev-store setup. Repo: [shopify-operations-mcp](https://github.com/jpka/shopify-operations-mcp).

Shared safety/audit plumbing was built as its own library: [safe-write-mcp-core](https://github.com/jpka/safe-write-mcp-core).

Claude's recommendation: **A** for the strongest pure engineering showcase and safest build; **C** for the best business/gig potential; if building two, do A first since its dry-run/audit patterns port directly into C.

**Decision (made):** C was chosen and built; A was also built. Both reuse the safe-write-mcp-core patterns (dry-run, approval gating, audit log).

## Suggested skills for next session

- `mattpocock-skills:prototype` — if the user wants to sanity-check the MCP server's tool/approval design before full implementation.  
- `mattpocock-skills:to-spec` or `mattpocock-skills:to-tickets` — to turn the next project (RAG assistant) into a build spec or tracked tickets.  
- `mattpocock-skills:tdd` — for building the server test-first, especially the safety-gating logic (dry-run, approval thresholds).  
- `engineering:architecture` — if the user wants an ADR comparing the three MCP options before committing.

## Suggested next steps

1. Build the RAG assistant (next in build order) using the patterns from the completed MCP servers.  
2. Scope the RAG assistant into concrete tasks (hybrid search, reranker, citations, eval suite, published metrics).  
3. Build, with README \+ architecture diagram from the start (not bolted on after).  
4. Record the Loom demo showing the safety gate in action (blocked/escalated write, not just a happy path) for the completed MCP servers.  
5. Repeat for the triage agent per the build order above.  
6. Update Upwork headline/portfolio and set up the Fiverr gig tiers once at least one project has a working demo.

## Redactions / notes

No API keys, passwords, or other credentials appeared in this session. No other PII beyond the user's own publicly-listed Upwork profile info (already public).  
