# Add native adapters only for concrete deployment needs

Status: idea — not approved for implementation.
Priority: P3 (proposed).

## Problem

Some deployments require authentication, request formats or infrastructure integration that a generic compatible endpoint cannot cover.

## Proposal

- Choose the next native provider from an actual user/deployment requirement.
- Check whether the installed SDK or existing compatible adapter already solves the need.
- Use the shared capability tests and keep provider-specific authentication separate from review and comment lifecycle logic.

## Acceptance criteria

- A named deployment requirement explains why the generic route is insufficient.
- The adapter has contract tests and an explicitly authorized live verification path.
- No unrelated SDK migration or provider abstraction is introduced.

## Open questions

- Which deployment and authentication method is needed first?
- Can the requirement be met with a small preset rather than another adapter?

[Back to idea index](README.md).
