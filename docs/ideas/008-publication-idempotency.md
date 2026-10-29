# Make review publication idempotent

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

Workflow retries and ambiguous network failures can duplicate already-published findings even when normal deduplication works.

## Proposal

- Identify a review run using PR, head/base SHAs and relevant configuration/action identity.
- Reconcile existing bot-owned publication markers before repeating writes.
- Recover conservatively from partially published runs; do not treat a marker as proof that every write completed.
- Keep stale-head protection and define the behavior of intentional forced reruns.

## Acceptance criteria

- Retrying the same logical run does not duplicate findings or summaries.
- Tests simulate lost responses after successful writes and failures between writes.
- Concurrent runs cannot regress published state.

## Open questions

- Where should run identity and partial-publication state live without a database?
- Which configuration changes justify a new logical review?

[Back to idea index](README.md).
