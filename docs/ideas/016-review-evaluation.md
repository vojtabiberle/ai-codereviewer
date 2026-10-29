# Measure review quality with an evaluation set

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

Passing parser and workflow tests does not establish that a model finds real bugs or avoids false positives. Model-reported confidence is not calibrated evidence.

## Proposal

- Curate small PR fixtures containing verified bugs and correct changes, including fixes to earlier findings.
- Measure detection, false positives, repeated findings after fixes, latency and reported token usage.
- Compare prompts and models under equivalent context/budget conditions; retain human adjudication for ambiguous findings.
- Keep fixtures shareable and separate from proprietary source or credentials.

## Acceptance criteria

- The evaluation can be rerun with a recorded model, prompt/action version and fixture set.
- Results distinguish missed bugs, false positives and publication duplicates.
- Reported costs distinguish measured billing from token-based estimates.

## Open questions

- Which initial bug categories best represent intended users?
- How large a fixture set is useful without encouraging overfitting?
- How should model variability be represented?

[Back to idea index](README.md).
