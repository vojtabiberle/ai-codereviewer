# Use the exact previously reviewed commit

Status: idea — not approved for implementation.
Priority: P0 (proposed).

## Problem

The current history lookup estimates the reviewed commit from review submission time and commit dates. Dates are not a reliable identity, and the commit listing is limited to one page.

## Proposal

- Use the latest applicable bot review’s `commit_id` directly.
- Count only reviews by this action’s verified bot identity that carry a valid hidden marker. Another workflow on the same bot account does not advance the baseline.
- Treat a missing, diverged, or unreachable baseline as a full `base...head` review.

## Acceptance criteria

- Incremental comparisons use a known reviewed SHA (`commit_id` on a qualifying review) rather than a timestamp approximation.
- Tests assert `pulls.listCommits` is not called.
- Tests cover misleading commit dates (they leave the baseline unchanged), a dismissed review that still advances it, a degraded summary-only publish that leaves it unchanged, and a force-push that falls back to a full `base...head` review.
- When the qualifying SHA is already the current head, the run logs that fact and does not call the model.

## Decisions

### Which review states advance the incremental baseline?

**Answer.** A review advances the baseline only when all of the following hold:

- It is authored by the verified bot identity (`user.login`, and `user.id` plus `user.type === "Bot"` when those fields are present). See Findings for how that identity is resolved.
- Its body contains a valid hidden marker, and the marker’s `sha` equals `review.commit_id`:

  `<!-- ai-codereviewer:review v=1 reviewer=<id> sha=<head> base=<base> status=complete -->`

  `reviewer` defaults to `${GITHUB_WORKFLOW}/${GITHUB_JOB}`. An optional `REVIEWER_ID` input overrides it. `base` is the pull request base SHA; see Additional questions.
- Its state is `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED`. `PENDING` does not count.
- `commit_id` is the current head or an ancestor of it. Confirm with a JSON compare `GET /repos/{owner}/{repo}/compare/{commit_id}...{head}` whose `status` is `ahead` or `identical`.

`DISMISSED` still qualifies. Dismissal withdraws the verdict; the commit was still reviewed. A full re-review belongs to the command in [009](009-review-commands.md).

The summary-only publish after GitHub returns 422 for comment locations ([GitHubService.ts](../../src/services/GitHubService.ts#L144-L153)) writes `status=degraded` and does not advance the baseline. A failed run publishes nothing and advances nothing.

When the compare reports `diverged`, or returns 404 or 422 for an unreachable SHA, log `baseline unreachable, full review` and review `base...head`. Older reviews stay available to history ([002](002-review-history-loading.md)).

**Rationale.** Reviews published since `7fc0108` send `commit_id` set to the pinned head ([GitHubService.ts](../../src/services/GitHubService.ts#L133), [ReviewService.ts](../../src/services/ReviewService.ts#L239)) and refuse to publish if that head moved ([GitHubService.ts](../../src/services/GitHubService.ts#L101-L106)). The date heuristic in [getLastReviewedCommit](../../src/services/GitHubService.ts#L240-L261) is unnecessary once a review carries both that SHA and the marker. The marker is required because later thread replies ([004](004-existing-threads.md), [008](008-publication-idempotency.md)) will also be `COMMENTED` reviews and must not move the baseline. Markers are storage, not authentication ([shared constraints](README.md#shared-constraints)): a marker in a human comment is ignored.

The current diff fetch cannot supply this check. It requests `application/vnd.github.v3.diff` ([DiffService.ts](../../src/services/DiffService.ts#L41-L48)), so a successful response has no `status` field. A three-dot compare of a rebased SHA usually still returns 200 and the diff from the merge base, which can include upstream commits. Any non-OK response, including 404, throws and stops the run ([DiffService.ts](../../src/services/DiffService.ts#L51-L55)).

**Rejected.** Treat `DISMISSED` as a reason to re-review the whole pull request. Also rejected: after a force-push, walking older reviews for an ancestor SHA. That search is complex and rarely changes the outcome.

### How should legacy unmarked bot reviews be migrated?

**Answer.** Unmarked reviews never advance the baseline. The first run of the new version on an existing pull request does one full review. Older reviews are still loaded for deduplication and for the prompt ([002](002-review-history-loading.md)). Leave the old review bodies unchanged.

**Rationale.** Before `7fc0108`, `createReview` was called without `commit_id`, so GitHub stored the pull request head at submission time. A push during the run can make that SHA a commit the model never saw. New reviews are reliable because they pin the head and abort when it changes, as cited above. There is no marker on reviews published today; the footer is only the model attribution at [ReviewService.ts](../../src/services/ReviewService.ts#L211).

**Rejected.** A temporary fallback, even one limited to an explicit switch with a removal date, that recognizes the footer `_Code review performed by …_` and trusts that review’s `commit_id`.

## Findings in current code

Checked against `6db1027`. Line numbers refer to that commit.

- Bot identity is wrong for a GitHub App installation token. [getBotLogin](../../src/services/GitHubService.ts#L26-L52) calls `GET /user`. On 401, 403, or 404 it logs at debug level and returns `github-actions[bot]` ([GitHubService.ts](../../src/services/GitHubService.ts#L40-L47)); other errors already warn. The comment above that branch describes the default `GITHUB_TOKEN`, where `github-actions[bot]` is the right login. An installation token for any other app gets the same 403, so reviews posted as `my-app[bot]` never match the login checks ([GitHubService.ts](../../src/services/GitHubService.ts#L195), [L296](../../src/services/GitHubService.ts#L296)). Chosen fix: resolve identity with GraphQL `query { viewer { login databaseId } }`, which works for a PAT, `GITHUB_TOKEN`, and an App token. On failure, warn; do not substitute another app’s login.
- With `GITHUB_TOKEN`, `github-actions[bot]` is shared by every workflow in the repository. The marker’s `reviewer` field, defaulting to `${GITHUB_WORKFLOW}/${GITHUB_JOB}`, is what separates this action from the others. `REVIEWER_ID` is not an input today.
- A force-push often leaves the old SHA reachable. The lookup uses one page of `pulls.listCommits` ([GitHubService.ts](../../src/services/GitHubService.ts#L247-L252)), then a three-dot compare ([DiffService.ts](../../src/services/DiffService.ts#L41)). When the old SHA still exists, that compare typically succeeds and returns the diff from the merge base, including upstream changes, and nothing reads compare `status`. When the SHA is gone, the failed response throws ([DiffService.ts](../../src/services/DiffService.ts#L51-L55)).
- The previous acceptance case “more than 100 commits” described that single `listCommits` page. `commit_id` removes the call, so the test asserts `listCommits` is not called.
- Previous comments are loaded only when the heuristic returns a SHA. `isUpdate` is `!!lastReviewedCommit`, and [getPreviousReviews](../../src/services/ReviewService.ts#L110-L118) runs only in that branch. A null baseline therefore skips deduplication ([ReviewService.ts](../../src/services/ReviewService.ts#L291-L297)). Load history whenever reviews by this action exist, including the one-time full review of a pull request that has only unmarked reviews. Keep the update prompt tied to a real incremental baseline ([buildSystemPrompt.ts](../../src/prompts/buildSystemPrompt.ts#L18-L20)); deduplication can use the loaded history on a full review too.

## Additional questions

### Merging the base branch into the pull request

**Recommended answer.** When the baseline `R` is an ancestor of head but `R...head` also contains upstream commits, limit the incremental files to the intersection of that range with the files in `base...head`.

**Rationale.** Ancestor checks accept the range, and the three-dot diff from `R` still contains the merged upstream changes. Those files are outside this pull request’s own diff.

**Rejected.** Reviewing every file in `R...head` after a merge from the base branch.

### Where do valid comment lines come from?

**Recommended answer.** Compute the lines GitHub will accept from the pull request diff (`base...head`), including when the model reviews an incremental range.

**Rationale.** [collectRightLines](../../src/services/DiffService.ts#L134-L146) reads the same compare that [getRelevantFiles](../../src/services/DiffService.ts#L36-L41) fetched, and that set is what publication checks ([ReviewService.ts](../../src/services/ReviewService.ts#L214-L216)). GitHub validates a comment against the pull request diff. An incremental hunk can name a line outside that diff, the API returns 422, and the run drops the line comments ([GitHubService.ts](../../src/services/GitHubService.ts#L144-L153)).

**Rejected.** Treating lines from the incremental diff as commentable positions.

### The pull request base branch changes

**Recommended answer.** A change of `base.sha` or the base ref is a full review. Store `base.sha` in the marker as `base=<sha>`.

**Rationale.** An incremental range against the previous base mixes two different comparisons. [getPRDetails](../../src/services/GitHubService.ts#L61-L68) already records `base.sha` and does not record the base ref; compare the ref as well once it is loaded.

**Rejected.** Continuing from the previous `commit_id` after the base branch changes.

### The qualifying commit is already the head

**Recommended answer.** When `commit_id` and the current head are the same commit, log that fact and return without a model call. A full review of an unchanged head happens only through the explicit command in [009](009-review-commands.md).

**Rationale.** A re-run or a reopened pull request has nothing new to compare. Nothing in the current flow returns early when the baseline SHA equals head ([ReviewService.ts](../../src/services/ReviewService.ts#L110-L120)); the model is still called after the byte check ([ReviewService.ts](../../src/services/ReviewService.ts#L183-L190)).

**Rejected.** Calling the model on an empty update, or treating every re-run as a full review.

[Back to idea index](README.md).
