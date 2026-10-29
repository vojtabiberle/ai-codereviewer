# Trigger incremental and full reviews with commands

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

Users need a predictable way to request a new review or a full re-evaluation without manufacturing another code change.

## Proposal

- Support `/ai-review` for an incremental review and `/ai-review full` for the complete PR comparison.
- Define author/maintainer permission checks and fetch current permissions before spending API credit.
- Parse only explicit commands, ignore bot-generated events, and retain trusted execution boundaries for comment-triggered workflows.

## Acceptance criteria

- Authorized commands use the current pinned head and the requested comparison mode.
- Unauthorized commands and bot replies cannot trigger model calls.
- Tests cover edited comments, duplicate deliveries, forks and stale permissions.

## Open questions

- Should PR authors without write permission be allowed to trigger paid reviews?
- Should labels provide the same controls?
- What cooldown and per-PR concurrency policy is appropriate?

[Back to idea index](README.md).
