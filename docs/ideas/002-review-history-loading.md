# Load previous review comments once

Status: idea — not approved for implementation.
Priority: P0 (proposed).

## Problem

The current loader calls the PR-wide review-comments endpoint inside a loop over reviews. Passing a review ID to that endpoint does not make it review-specific, so comments can be fetched and associated repeatedly.

## Proposal

- Fetch paginated reviews and PR review comments once, then associate comments using their actual review IDs.
- Keep comment IDs, node IDs, parent/reply relationships, author and commit identity for later thread management.
- Load thread resolution and outdated state through an appropriate GitHub API when needed; REST comment position alone is insufficient.

## Acceptance criteria

- Each comment is associated with its actual review exactly once.
- Tests cover multiple pages, multiple bot workflows, replies and comments from humans.

## Open questions

- Use a combined GraphQL history query or REST history plus a separate thread query?
- What history limit keeps very large PR discussions bounded without losing active findings?

[Back to idea index](README.md).
