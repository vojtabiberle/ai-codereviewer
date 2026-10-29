# Respect human resolution of findings

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

The current history representation does not carry actual thread resolution state. A manually dismissed or resolved issue can be raised again.

## Proposal

- Track open, resolved and outdated states separately; outdated does not mean fixed.
- Respect human resolution and do not reopen the same finding on every push.
- Define an explicit way to request reconsideration while limiting changes to this action’s own threads.

## Acceptance criteria

- Resolving a bot thread suppresses unchanged repetitions.
- Human-owned threads are never resolved, reopened or edited by the action.
- Resolution policy is documented and covered by tests.

## Open questions

- Does resolving a thread suppress the finding for the whole PR or only its current code context?
- How can a genuine regression be distinguished from a dismissed finding?

[Back to idea index](README.md).
