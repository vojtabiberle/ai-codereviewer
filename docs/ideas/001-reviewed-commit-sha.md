# Use the exact previously reviewed commit

Status: idea — not approved for implementation.
Priority: P0 (proposed).

## Problem

The current history lookup estimates the reviewed commit from review submission time and commit dates. Dates are not a reliable identity, and the commit listing is limited to one page.

## Proposal

- Use the latest applicable bot review’s `commit_id` directly.
- Define which reviews count as completed reviews by this action; do not mistake another workflow using the same bot account for this reviewer.
- Handle missing or unreachable commits explicitly after force-pushes; use a documented full-review fallback.

## Acceptance criteria

- Tests cover misleading commit dates, more than 100 commits, dismissed reviews and force-pushes.
- Incremental comparisons use a known reviewed SHA rather than a timestamp approximation.

## Open questions

- Which review states advance the incremental baseline?
- How should legacy unmarked bot reviews be migrated?

[Back to idea index](README.md).
