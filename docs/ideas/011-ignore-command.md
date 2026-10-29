# Ignore a specific finding for a PR

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

Maintainers need an explicit way to reject a false positive without suppressing every finding in the same file or category.

## Proposal

- Support `/ai-review ignore` in a bot finding’s thread.
- Associate the decision with the stable finding identity and PR, recording the authorized actor.
- Keep ignore state distinguishable from fixed/resolved state and provide an explicit reversal path.

## Acceptance criteria

- The ignored finding stays suppressed across reruns and line movement.
- Other findings are unaffected.
- Forged markers or unauthorized comments cannot change suppression state.

## Open questions

- Can the PR author ignore a finding or only a maintainer?
- How should ignore state be revoked?
- What happens if the same bug is reintroduced with materially different code?

[Back to idea index](README.md).
