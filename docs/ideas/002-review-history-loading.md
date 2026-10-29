# Load previous review comments once

Status: idea — not approved for implementation.
Priority: P0 (proposed).

## Problem

The current loader calls the PR-wide review-comments endpoint inside a loop over reviews. Passing a review ID to that endpoint does not make it review-specific, so comments can be fetched and associated repeatedly.

## Proposal

- Fetch paginated reviews and pull request review comments once, then associate comments by `pull_request_review_id`.
- Keep comment IDs, node IDs, parent/reply relationships, author, and commit identity for later thread management.
- Load thread resolution through GraphQL when a later feature needs it ([004](004-existing-threads.md), [005](005-human-resolution.md), [006](006-fix-verification.md)). REST comment position does not include resolution.
- Cap comment pages while loading, and give the prompt its own history budget so a long discussion does not cancel the review.

## Acceptance criteria

- Each comment is associated with its actual review exactly once, from one paginated reviews fetch and one paginated review-comments fetch.
- A null `line` stays null. Dedup keys use `line ?? original_line` and an outdated flag, so an outdated comment does not become line `0`.
- Tests cover multiple pages, the loading page cap, multiple bot workflows, replies, and comments from humans. Human comments are not stored as this action’s findings.
- History sent to the model stays within its own budget. A discussion that exceeds that budget does not, by itself, trip `MAX_INPUT_BYTES` and skip publication.
- When comment loading passes the page cap, the run logs a warning and deduplicates from the comments that were loaded. Review listing still reads every page.

## Decisions

### Use a combined GraphQL history query, or REST history plus a separate thread query?

**Answer.** Use REST for history. Add a GraphQL thread query only when a feature needs resolution or thread shape ([004](004-existing-threads.md), [005](005-human-resolution.md), [006](006-fix-verification.md)).

For this idea, call `octokit.paginate` on `pulls.listReviews` and on `pulls.listReviewComments` once each. Group comments by `pull_request_review_id`. Keep `id`, `node_id`, `in_reply_to_id`, `user.login`, `user.id`, `user.type`, `commit_id`, `original_commit_id`, `path`, `line` (null stays null), `original_line`, `side`, `created_at`, and `pull_request_review_id`.

The later thread query is `pullRequest.reviewThreads(first: 100) { isResolved isOutdated resolvedBy comments(first: N) { databaseId … } }`. GraphQL `databaseId` matches the REST comment `id`. `isResolved` is not on the REST comment, so that query is what supplies it.

**Rationale.** REST pagination is a single cursor per list and is easy to mock. The integration flow already mocks `pulls.listReviewComments` ([reviewFlow.test.ts](../../tests/integration/reviewFlow.test.ts#L51-L54)). Nested GraphQL connections need a cursor per connection and spend the point-based GraphQL limit. `GITHUB_TOKEN` and App tokens can call GraphQL with the permissions they already use to read pull requests. The per-review route `GET /pulls/{pull_number}/reviews/{review_id}/comments` (`pulls.listCommentsForReview`) does filter by review, and the current code does not call it; one pull-request-wide listing grouped by `pull_request_review_id` is still the shape to load, because it is a single paginated read.

**Rejected.** Loading history only through GraphQL `reviewThreads` plus `reviews`. That is fewer round trips and more pagination code. Revisit it if [004](004-existing-threads.md) is implemented in the same change.

### What history limit keeps very large PR discussions bounded without losing active findings?

**Answer.** Use two limits.

- Loading: at most 20 pages of 100 comments. On overflow, `core.warning` and deduplicate from the comments that were loaded. Reviews are small; always load every review page.
- Prompt: a separate `HISTORY_MAX_BYTES` budget, about 10 to 15 percent of `MAX_INPUT_BYTES`. Fill it in this order:
  1. Bot comments in unresolved, non-outdated threads on files in the current diff.
  2. Other unresolved bot comments.
  3. Summaries of the last one or two bot reviews.
  4. Whatever remains, dropping the oldest and the resolved comments first.
- Human replies inside a thread are abbreviated. The system prompt already treats previous comments as untrusted data ([buildSystemPrompt.ts](../../src/prompts/buildSystemPrompt.ts#L16)).

`isResolved` arrives with the GraphQL thread query above. Until that query exists, treat resolution as unknown and apply the same order with the REST outdated flag only (`line === null`).

**Rationale.** Deduplication needs the bot comments, which are cheap to hold in memory. The model needs the active ones. Today every loaded review is serialized into the user payload ([buildUserPayload.ts](../../src/prompts/buildUserPayload.ts#L30-L37)), the byte length of the system prompt plus that payload is compared with `MAX_INPUT_BYTES`, and over the cap the run throws before the model call and before publication ([ReviewService.ts](../../src/services/ReviewService.ts#L183-L186)). History therefore grows on every push until it cancels the review.

**Rejected.** A fixed cap of the last N bot reviews. It is simpler, and it can drop an older unresolved blocker.

## Findings in current code

Checked against `6db1027`. Line numbers refer to that commit.

- The repeated fetch is broader than “the same bot comments twice.” [getPreviousReviews](../../src/services/GitHubService.ts#L277-L336) keeps reviews whose `user.login` matches the bot, then calls `pulls.listReviewComments` with `review_id` ([GitHubService.ts](../../src/services/GitHubService.ts#L307-L313)). That method is `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`, which has no `review_id` in the route, so each call returns every review comment on the pull request. Human comments and other bots’ comments are stored on every one of this action’s reviews. The prompt then labels that array as previous reviews and keeps only `summary`, `path`, `line`, and `comment` ([buildUserPayload.ts](../../src/prompts/buildUserPayload.ts#L17-L37)). Deduplication uses the same list ([ReviewService.ts](../../src/services/ReviewService.ts#L291-L325)), so a human comment can suppress a new finding.
- Outdated comments arrive with `line: null` and are stored as `comment.line || 0` ([GitHubService.ts](../../src/services/GitHubService.ts#L329-L333)). The dedup key is `` `${path} ${line} ${normalized body}` `` ([ReviewService.ts](../../src/services/ReviewService.ts#L323-L325)), which produces a `path 0 …` key. Keep `line` null, set an outdated flag, and build the key from `line ?? original_line`.
- `Promise.all` over the bot reviews ([GitHubService.ts](../../src/services/GitHubService.ts#L299-L322)) starts one pull-request-wide comment listing per bot review at the same time. The listings are the same data and add secondary rate-limit pressure.
- History is also skipped entirely when the baseline heuristic in [001](001-reviewed-commit-sha.md) returns null ([ReviewService.ts](../../src/services/ReviewService.ts#L110-L118)). Load it whenever reviews by this action exist.

## Additional questions

### Where do bot replies belong?

**Recommended answer.** A bot comment with `in_reply_to_id` (the replies [004](004-existing-threads.md) will publish) is part of that thread’s history. It is not a standalone finding.

**Rationale.** The loader currently drops `in_reply_to_id`, so a reply cannot be told from a new comment ([GitHubService.ts](../../src/services/GitHubService.ts#L329-L333)).

**Rejected.** Deduplicating and prompting each reply as its own finding.

### Which reviews are “this action” in the history?

**Recommended answer.** Use the same verified bot identity and reviewer marker as [001](001-reviewed-commit-sha.md). Ignore markers that appear in human comments ([shared constraints](README.md#shared-constraints)).

**Rationale.** Login alone matches every workflow that posts as `github-actions[bot]`, and the current filter is login-only ([GitHubService.ts](../../src/services/GitHubService.ts#L294-L296)).

**Rejected.** Filtering history by `user.login` alone.

### Include reviews whose commits are unreachable after a force-push?

**Recommended answer.** Yes. Keep them for deduplication, and mark them outdated in the prompt.

**Rationale.** The finding text can still match a comment the model would otherwise repeat. The commit is not a valid baseline; [001](001-reviewed-commit-sha.md) already falls back to a full review when the baseline SHA is unreachable. Unreachable here means the comment’s `commit_id` does not compare as `ahead` or `identical` against the current head.

**Rejected.** Dropping those comments from history because their SHA is no longer on the branch.

[Back to idea index](README.md).
