# Recheck whether findings were fixed

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

A finding disappearing from the latest diff does not establish that the underlying bug was repaired.

## Proposal

- Recheck relevant prior findings against current code rather than relying on removed or moved lines.
- Initially report a likely fix with supporting evidence; keep automatic resolution disabled by default.
- Consider opt-in resolution of bot-owned threads only after evidence and human-discussion rules are defined.

## Acceptance criteria

- Line deletion alone does not mark a finding fixed.
- Uncertain rechecks remain open and explain uncertainty.
- Tests include real fixes, moved code, removed functionality and partially fixed bugs.

## Open questions

- What evidence is sufficient for automatic resolution?
- Should auto-resolution be forbidden when a human has replied?
- What separate budget should rechecking consume?

[Back to idea index](README.md).
