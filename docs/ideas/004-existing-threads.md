# Continue existing finding threads

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

Each run currently creates a fresh review. A persistent issue should not produce another independent conversation on every push.

## Proposal

- Match current findings to existing bot threads using stable finding identity.
- Leave an unchanged finding silent; reply only when new evidence or a material change warrants an update.
- Preserve human replies and avoid silently rewriting the meaning of a comment people have answered.

## Acceptance criteria

- Repeated unchanged findings create neither new threads nor repetitive replies.
- New evidence is posted to the matching thread.
- Human discussion remains intact.

## Open questions

- When is editing the original bot comment preferable to adding a reply?
- How should outdated GitHub thread locations be represented?

[Back to idea index](README.md).
