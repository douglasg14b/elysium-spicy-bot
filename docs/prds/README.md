# PRDs

Product Requirements Documents for this bot. A PRD describes intended product behavior, UX, and
non-negotiable constraints — it is **not** an implementation plan. Plans and design docs are written
*against* a PRD; the PRD is the anchor and changes only when product intent changes.

Related documents that are not PRDs:

- `docs/adr/` — architecture decision records.
- `nimbalyst-local/plans/` — design docs and implementation plans (e.g. the v1 flow engine design doc).
- `AGENTS.md` and `.claude/rules/*.md` — repository conventions and product constraints a PRD must respect.

## PRDs

<!-- One line per PRD. Companion execution/strategy docs are listed under the PRD they serve. -->


- [Flow Engine v2: Composable Blocks, Member Journeys, and Server Provisioning](flow-engine-v2-journeys-and-provisioning.md) — a block contract that makes flow capabilities cheap to add, plus the tickets, custom events, and Discord provisioning needed to run our onboarding and verification journey entirely from the builder. *(Approved)*
  - [Execution Strategy](flow-engine-v2-execution-strategy.md) — wave structure, what parallelizes, the contract amendment protocol, and the state-machine taxonomy. *(Approved)*
