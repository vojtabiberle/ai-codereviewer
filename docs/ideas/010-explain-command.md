# Explain a finding in its thread

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

A reviewer may need the reasoning and code evidence behind a specific bot finding without rerunning the whole PR review.

## Proposal

- Support `/ai-review explain` in a bot finding’s thread.
- Use the original finding, relevant discussion and pinned current code; distinguish old evidence from current behavior.
- Keep explanations within a separate bounded request and do not create recursive bot conversations.

## Acceptance criteria

- The reply addresses the selected finding and cites relevant code.
- Missing context or changed code is stated explicitly.
- Authorization, duplicate delivery and budget checks apply before model calls.

## Open questions

- Should explanations describe the originally reviewed commit, current head, or both?
- Who may request explanations and how often?

[Back to idea index](README.md).
