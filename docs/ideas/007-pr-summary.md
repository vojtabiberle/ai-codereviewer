# Maintain one current PR summary

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

Repeated review summaries make it difficult to see the latest state of a PR.

## Proposal

- Maintain one bot-owned summary comment identified by a hidden marker.
- Show reviewed SHA, new and persistent findings, likely fixes, last successful run and review limitations.
- Keep inline threads as the discussion history; do not conflate the summary comment with GitHub’s approval/request-changes review events.
- Prevent an older concurrent run from overwriting a newer summary.

## Acceptance criteria

- Reruns update one summary instead of adding another.
- A failed or partial review cannot be displayed as a successful clean review.
- Summary links point to the corresponding findings and workflow run.

## Open questions

- Should failure status update the summary or only the Actions result?
- What minimal metadata makes the summary useful without becoming noisy?

[Back to idea index](README.md).
