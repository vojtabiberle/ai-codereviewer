# Make provider fallback explicit and bounded

Status: idea — not approved for implementation.
Priority: P3 (proposed).

## Problem

Provider outages can interrupt review, but automatic fallback can change cost, model behavior and the recipient of repository content.

## Proposal

- Keep fallback disabled by default.
- Allow only an explicit ordered set of approved provider/model combinations with separate credentials.
- Restrict fallback to specified failures, share the total review budget and record which provider produced the result.
- Never fall back after publication in a way that duplicates a review.

## Acceptance criteria

- No repository data is sent to an unconfigured provider.
- Authentication errors, unsupported capabilities and transient failures follow documented policies.
- Fallback attempts cannot reset the overall budget or publication identity.

## Open questions

- Which failures justify fallback?
- What data residency and model-equivalence restrictions must a fallback satisfy?

[Back to idea index](README.md).
