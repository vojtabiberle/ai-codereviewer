# Give findings stable identities

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

Deduplication currently depends on path, line number and nearly identical comment text. Moving code or rephrasing the same issue can produce duplicate findings.

## Proposal

- Identify findings using code location/context, category and the substance of the problem.
- Store a versioned machine-readable finding ID in a hidden comment marker; start without a separate database.
- Separate deterministic identity from any optional model-assisted matching and handle ambiguous matches conservatively.

## Acceptance criteria

- A moved line or paraphrased description does not create a duplicate in representative fixtures.
- Distinct bugs in the same function remain distinct.
- Only markers belonging to authenticated bot comments are trusted.

## Open questions

- What code anchor survives renames and refactoring?
- When should a recurring issue receive a new identity?
- How should legacy comments without markers be matched?

[Back to idea index](README.md).
