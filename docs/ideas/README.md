# Improvement ideas

These are independent discussion items, not a release commitment. Each idea
includes a problem, proposal, acceptance criteria and the questions to settle
before implementation. [001](001-reviewed-commit-sha.md) and [002](002-review-history-loading.md)
record settled answers; the others still have open questions.
[001](001-reviewed-commit-sha.md) step 1 (bot identity and the hidden review marker)
is implemented. [002](002-review-history-loading.md) (one REST load of review
history, a 20-page cap on reviews and review comments, and `HISTORY_MAX_BYTES`) is implemented.
Baseline selection in [001](001-reviewed-commit-sha.md) is implemented. The design note is [001-incremental-baseline-design.md](001-incremental-baseline-design.md). Valid comment lines are implemented. The step 4 design note is [001-comment-lines-design.md](001-comment-lines-design.md).

Proposed priorities: P0 correctness prerequisites; P1 comment lifecycle and shared
foundations; P2 user controls, provider integrations and evaluation; P3 later,
need-driven extensions. Priority does not automatically authorize implementation.

| ID | Idea | Priority |
| --- | --- | --- |
| 001 | [Use the exact previously reviewed commit](001-reviewed-commit-sha.md) | P0 |
| 002 | [Load previous review comments once](002-review-history-loading.md) | P0 |
| 003 | [Give findings stable identities](003-finding-identity.md) | P1 |
| 004 | [Continue existing finding threads](004-existing-threads.md) | P1 |
| 005 | [Respect human resolution of findings](005-human-resolution.md) | P1 |
| 006 | [Recheck whether findings were fixed](006-fix-verification.md) | P2 |
| 007 | [Maintain one current PR summary](007-pr-summary.md) | P1 |
| 008 | [Make review publication idempotent](008-publication-idempotency.md) | P1 |
| 009 | [Trigger incremental and full reviews with commands](009-review-commands.md) | P2 |
| 010 | [Explain a finding in its thread](010-explain-command.md) | P2 |
| 011 | [Ignore a specific finding for a PR](011-ignore-command.md) | P2 |
| 012 | [Define and test provider capabilities](012-provider-capabilities.md) | P1 |
| 013 | [Support OpenRouter](013-openrouter.md) | P2 |
| 014 | [Support Ollama on a self-hosted runner](014-ollama.md) | P2 |
| 015 | [Make provider fallback explicit and bounded](015-provider-fallback.md) | P3 |
| 016 | [Measure review quality with an evaluation set](016-review-evaluation.md) | P2 |
| 017 | [Add native adapters only for concrete deployment needs](017-native-provider-adapters.md) | P3 |

## Suggested sequence

1. Correct previous-review identity and history loading (001–002).
   Done: resolve the bot identity and write the review marker. Load history once
   over REST (002).
   Done: select the baseline from the previous complete review and compare status,
   with a full-review fallback (001; design in
   [001-incremental-baseline-design.md](001-incremental-baseline-design.md)).
   Done: comment only on a line that is in the fetched diff and in the pull
   request diff ([001-comment-lines-design.md](001-comment-lines-design.md)).
2. Define stable finding identity (003) and publication idempotency (008).
3. Continue existing threads, respect human resolution and maintain one summary
   (004–005, 007). Fix verification/auto-resolution is a separate opt-in design (006).
4. Add authorized review, explanation and ignore commands (009–011).
5. Establish provider capability tests (012), then integrate OpenRouter (013) and
   Ollama (014). The compatible endpoint may already cover much of the work.
6. Use evaluation fixtures (016) to compare improvements. Begin curating fixtures
   early rather than waiting for every integration to be complete.
7. Consider explicit fallback (015) and native adapters (017) when there is a
   concrete need.

## Shared constraints

- Preserve trusted base policy, pinned source/review SHAs and workflow budget ceilings.
- Mutate only this action's own authenticated comments/threads; preserve human discussion.
- Hidden markers are storage, not authentication. Ignore markers forged in human comments.
- Prefer GitHub-hosted state over a separate database until a concrete limitation appears.
- Provider fallback must never silently change the recipient of repository content.
- Commands need explicit permissions, bounded spending and protection against bot loops.
- Live tests need an authorized endpoint, credentials, spending and target PR; mocked
  tests do not establish live compatibility or review quality.
