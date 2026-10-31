# Incremental review baseline (idea 001, step 3)

Status: design only. No runtime code in this change. Baseline selection stays unimplemented until the questions below are answered.

This note is the step-3 brief checked against the answers already recorded in [001](001-reviewed-commit-sha.md) and [002](002-review-history-loading.md), and against `main` at `ab3d3c6`. Where the brief and those answers disagree, the question says so. Step 4 (comment lines taken from the pull request diff) is not part of this change.

## Decisions

These follow the brief and the recorded answers together. The implementation should lock them as written.

1. **Replace the date heuristic, using the history load that already exists.** `getLastReviewedCommit` estimates a SHA from the newest bot review’s `submitted_at` and one page of `pulls.listCommits` ([GitHubService.ts](../../src/services/GitHubService.ts#L374-L395)). Delete that method and `getLastReviewSubmittedAt`. Choose the baseline from the reviews `getPreviousReviews` already pages in ([GitHubService.ts](../../src/services/GitHubService.ts#L402-L443)). Do not call `pulls.listReviews` a second time. Tests assert `pulls.listCommits` is not called.

2. **Who can supply the baseline.** The author must be this run’s bot identity, with the same rule as history: numeric `user.id` when both sides have an id, otherwise login. A valid marker must name this run’s reviewer id (`REVIEWER_ID`, otherwise `GITHUB_WORKFLOW/GITHUB_JOB`). Another workflow on `github-actions[bot]` does not move the baseline. A marker on a human review does not count. `PENDING` does not count. `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, and `DISMISSED` do. `DISMISSED` still counts: dismissal withdraws the verdict, and the commit was still reviewed. Newest is `submitted_at`, then review id, the same order as `compareReviewsNewestFirst`.

3. **One candidate, one compare.** Walk newest-first only far enough to pick a single qualifying review (question 2 decides whether `degraded` is skipped). Compare that SHA once. If the compare is not `ahead` or `identical`, review the whole pull request. Do not try an older SHA after `diverged`, `behind`, 404, or 422. That search is the force-push walk already rejected in 001.

4. **JSON compare, then the diff.** `GET /repos/{owner}/{repo}/compare/{baseline}...{head}` (three dots). Read `status`, which is `ahead`, `behind`, `diverged`, or `identical`. Call it through Octokit `repos.compareCommitsWithBasehead` so tests mock the client they already use. The patch request stays `Accept: application/vnd.github.v3.diff` in [DiffService.ts](../../src/services/DiffService.ts#L41-L48). That response has no `status`, and any non-OK response currently throws and stops the run ([DiffService.ts](../../src/services/DiffService.ts#L51-L55)). The diff request runs only after the status is known.

5. **`ahead`.** Review the three-dot range `{baseline}...{head}` and set `isUpdate` only in this case. History still loads when the run falls back to a full review; the update prompt stays tied to a real incremental baseline ([buildSystemPrompt.ts](../../src/prompts/buildSystemPrompt.ts#L24-L26)).

6. **`diverged`, `behind`, 404, and 422.** Review `{pull request base SHA}...{head}`. `behind` means head is an ancestor of the baseline (a rewind). Any other `status` string takes the same fallback. 404 and 422 are caught from the compare call and do not fail the run. The log sentence is question 7. 500, 503, and network errors are question 6.

7. **No qualifying review.** Review `{base}...{head}` and log `no previous review, full review`. History still loads for deduplication and for the prompt.

8. **The qualifying SHA is already the head.** Case-insensitive equality with `pr.head`, or compare `status=identical`, logs `baseline identical to head, skipping review` and returns before the model call and before `submitReview`. Nothing new is published. `performReview` returns `null` for that skip; `main` logs it and exits 0. Check the marker `base` first when question 3 says a base change is a full review, so a moved base is not skipped just because the head SHA is unchanged.

9. **SHA shape used for selection.** `parseReviewMarker` accepts 7–64 hex characters. Selection accepts 40–64. A short SHA is ambiguous and does not qualify. Comparison of SHAs is case-insensitive. The parser stays as it is.

10. **Outdated comments keep their line.** REST `line === null` still sets `outdated`. A comment whose commit is not `ahead` or `identical` against head is also `outdated`, which is the 002 note for force-pushed reviews. `line` stays the number GitHub returned, or null. It is never stored as 0. The dedup key stays `path`, then `line ?? original_line`, then the normalized body. The prompt renders `outdated: true` whenever the flag is set, including when `line` is a number. Today the renderer sets that flag only for a null line ([reviewHistory.ts](../../src/services/reviewHistory.ts#L420-L428)), and the system prompt only mentions the null-line case ([buildSystemPrompt.ts](../../src/prompts/buildSystemPrompt.ts#L18-L21)). Both descriptions gain the compare case. Summaries of those reviews stay in the prompt. The extra flag is on top-level findings, using `commit_id`, then `original_commit_id` when `commit_id` is absent. A missing SHA does not add the flag. Replies do not mark their parent outdated. The identical-head skip does not compare comment SHAs, because no prompt is sent. How many compare calls that takes is question 5.

11. **Step 4 stays out.** `collectRightLines` keeps reading the diff that was fetched. On an incremental run that set is the `{baseline}...{head}` hunks. A comment on a line outside the pull request diff can still get HTTP 422, and the summary-only publish still writes `status=degraded`.

## Open questions

### 1. Does an unmarked review’s `commit_id` become the baseline?

The step brief says: take this reviewer’s newest previous review, prefer the marker `sha` when `status=complete`, and otherwise use that review’s `commit_id`.

001 says a review advances the baseline only when the marker `sha` equals `commit_id` and `status` is `complete`. Unmarked reviews never advance it. The first run of this version on an existing pull request is one full review. A parsed marker always has a `sha`, so the `commit_id` fallback only changes behavior when the newest review has no complete marker.

**Recommendation.** Keep the 001 rule. The baseline SHA is `marker.sha` from a `complete` marker whose `sha` equals `commit_id`. An unmarked review does not qualify, and neither does a complete marker whose `sha` differs from `commit_id`. Log `marker sha differs from commit_id` at debug when that happens, and keep walking under question 2. Do not compare `commit_id` as a second candidate on the same review: when the two SHAs differ, neither is trusted.

### 2. A newest `degraded` marker: full review, or the previous complete SHA?

The step brief lists a `degraded` marker as a full-review fallback. 001 says the summary-only publish writes `status=degraded` and does not advance the baseline, and the acceptance text says a degraded publish leaves the baseline unchanged. “Unchanged” means the previous complete SHA is still the baseline, so the next incremental range includes the commit that only received a summary.

**Recommendation.** Skip `degraded`, unmarked, and `PENDING` reviews and use the newest older review that passes decision 2 and question 1. Compare that one SHA. If none exists, log `no previous review, full review`. A `degraded` publish is not, by itself, a reason to review `base...head`.

This is a walk for a qualifying marker. It is not the rejected force-push walk: a `diverged`, `behind`, 404, or 422 result still does not try the next older SHA.

If the answer is the literal brief instead, the newest review by this reviewer is the only candidate. A `degraded` marker on it forces a full review even when an older complete SHA is still an ancestor of head.

### 3. A changed pull request base

001’s recorded answer is that a change of `base.sha` or the base ref is a full review, and the marker stores `base=<sha>`. `getPRDetails` loads `base.sha` and does not load the base ref ([GitHubService.ts](../../src/services/GitHubService.ts#L174-L189)). The step brief does not mention the base.

**Recommendation.** If the qualifying marker’s `base` differs from the current pull request `base.sha` (case-insensitive), log `baseline base changed, full review` and review `{base}...{head}`. Do this before the identical-head skip, so a re-run on the same head after the base moves is a full review. Do not load or compare the base ref in this step.

### 4. Merge from the base branch while compare is `ahead`

`ahead` means the baseline is an ancestor of head. Merging the base branch into the pull request keeps that status, and the three-dot diff still contains the upstream files. 001 says to limit the incremental files to the intersection of `{baseline}...{head}` with the files in `{base}...{head}`. The step brief says to review the incremental diff when status is `ahead`, and to leave step 4 (valid comment lines) undone. The intersection is a file filter, not the line check.

**Recommendation.** Include the filter in step 3. Take the pull request file paths from paginated `pulls.listFiles` (the compare payload lists at most 300 files). Keep an incremental file only when its path is in that set. Leave `validRightLines` on the incremental hunks until step 4. A comment can still 422; the filter only keeps upstream files out of the model input.

If the answer is to defer the filter, step 3 sends every file in the `ahead` diff, including upstream files from a merge.

### 5. How many compares mark history comments outdated?

002 says to keep a comment after a force-push and mark it outdated when its `commit_id` does not compare as `ahead` or `identical` against head. One baseline compare does not say that about older SHAs. The compare commit list is capped at 250 when `page` and `per_page` are omitted, so membership in that list is the wrong reachability test.

**Recommendation.** After the run has decided it will call the model, collect unique SHAs from this action’s reviews and from top-level findings (`commit_id`, then `original_commit_id`). JSON-compare each `{sha}...{head}`, at most 4 at a time, cached for the run, reusing the baseline compare. `ahead` or `identical` adds nothing. Any other status, 404, or 422 sets `outdated`. Cap the unique SHAs at 30, baseline first, then newest review SHAs. Past the cap, leave the rest to REST `line === null` and log `history compare cap, 30 SHAs`. Do not page the compare commit list.

### 6. Compare HTTP 500 and 503

GitHub documents 200, 404, 422, 500, and 503 for this endpoint. A diff that takes too long has been reported as 422 and as 500. The diff media type can also return 5xx on a large patch.

**Recommendation.** On the JSON status compare, 404 and 422 fall back to a full review. 500, 503, and a thrown network error fail the run. If the status compare returned `ahead` and the follow-up diff request fails, fail the run. Do not silently switch that failure to `{base}...{head}`.

### 7. Wording of the unreachable log

001 names one sentence: `baseline unreachable, full review`. The brief asks the log to say why.

**Recommendation.** Keep that sentence and append the reason, so the recorded phrase still matches:

- `baseline unreachable, full review: diverged`
- `baseline unreachable, full review: behind`
- `baseline unreachable, full review: HTTP 404`
- `baseline unreachable, full review: HTTP 422`

Use separate sentences for the other fallbacks: `no previous review, full review`, `baseline base changed, full review`, and `baseline identical to head, skipping review`.

## What the implementation will touch

After the answers: `reviewHistory.ts` (marker `status`, `sha`, `base`, and review `state` on the loaded review; a pure baseline choice; applying compare results onto `outdated`), `GitHubService.ts` (delete the date heuristic; one compare helper), `DiffService.ts` (the range it is given), `ReviewService.ts` (`isUpdate` only for `ahead`; the identical skip), `main.ts` (the null return), the system-prompt sentence, unit tests, `dist/index.js`, and the status lines in 001. This design PR changes none of those.

## Tests to add with the implementation

- A misleading commit date does not change the chosen SHA, and `pulls.listCommits` is not called.
- A `DISMISSED` review with a complete matching marker advances the baseline.
- The question 2 result: a `degraded` newest review leaves the previous complete SHA in place, or forces a full review.
- `status=diverged` and a 404 both review `{base}...{head}` and the run continues.
- `status=behind` reviews `{base}...{head}`.
- Marker `sha` equal to head does not call the model and does not publish.
- A finding whose `commit_id` compares as `diverged` is `outdated` with its `line` unchanged, and the dedup key is unchanged.
- A complete marker for another reviewer id does not advance the baseline.

[Back to idea 001](001-reviewed-commit-sha.md).
