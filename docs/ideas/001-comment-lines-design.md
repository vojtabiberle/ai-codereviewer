# Valid comment lines (idea 001, step 4)

Status: implemented. All five questions are answered below. Question 4 was changed: a non-commentable line is marked `nc`, not `-`. Steps 1–3 are unchanged.

GitHub accepts an inline review comment only when `path`, `side`, and `line` (and `start_line` / `start_side`, when a range is sent) name a line in the pull request diff. `createReview` is one request: a single bad comment returns HTTP 422 and publishes nothing. The current catch then publishes the summary alone with `status=degraded` ([GitHubService.ts](../../src/services/GitHubService.ts#L269-L286)). This step stops using that fallback for lines we can already classify.

Today both checks read `validRightLines` from the diff that was fetched ([DiffService.ts](../../src/services/DiffService.ts#L134-L146), [ReviewService.ts](../../src/services/ReviewService.ts#L267-L273), [GitHubService.ts](../../src/services/GitHubService.ts#L298-L316)). A full review fetches `base...head`, which is the pull request diff. An incremental review fetches `baseline...head` and then keeps files whose path is in paginated `pulls.listFiles` ([ReviewService.ts](../../src/services/ReviewService.ts#L335-L343)). The file filter does not make those hunks commentable. A line added after `base` and removed before `head` is in the incremental hunk and absent from the pull request diff. GitHub rejects it.

## Decisions

1. **One comment shape.** Every inline comment stays `path`, `side: RIGHT`, and one `line`. The schema has no range, and the publisher does not send `start_line`, `start_side`, `subject_type`, or the legacy `position`. `start_line` is in scope only as a field we must not invent. A later range needs hunk ids: two lines can each be commentable and still 422 when they sit in different hunks (`Pull request review thread start line must be part of the same hunk as the line`). A set of line numbers cannot express that, and this step does not add one.

2. **Which right-side lines count.** The same rule as `collectRightLines`: an `add` line’s `ln`, and a context line’s `ln2`. Deletions have no right-side number. The prompt tells the model to skip them. LEFT-side comments on removed lines are a new comment shape and stay out of this step. A `\ No newline at end of file` marker is not a line. parse-diff sometimes types that marker as a deletion and copies the previous line number; the formatter drops the marker so it is not shown as a commentable line.

3. **Full reviews.** The fetched compare is `base...head` (three dots), which is the diff GitHub reviews against the pinned head. Commentable lines stay `collectRightLines` on that diff. The full-review path does not call `pulls.listFiles`.

4. **Paths.** The path is the one step 3 already kept: `filename` from `listFiles`, and the diff’s new path (`file.to`, or `file.from` for a deletion). Match is exact. `previous_filename` is not a comment path. A rename is commented on the new path.

5. **Filter before `createReview`.** Known-bad lines are removed first. The comments that remain are published with `status=complete`. Dropped lines do not flip `suggestedAction`; a blocker that is not posted still does not force `REQUEST_CHANGES` ([ReviewService.ts](../../src/services/ReviewService.ts#L367-L384)). `ReviewService.dropInvalidLines` and `GitHubService.partitionComments` both keep using that one map.

6. **The degraded publish stays for a 422 this filter did not predict.** It still writes `status=degraded`, still omits every inline comment, and still does not advance the baseline. There is no per-comment retry. The head is still checked before that second publish. This step does not change the marker or the baseline walk.

7. **No second file list at publish time.** `listFiles` runs when the incremental files are chosen. `assertCurrentHead` already refuses to publish if the head moved. Line numbers are file lines at that head, not diff `position` values, so the incremental diff and the pull request patch number the same file.

8. **Parsing.** `listFiles[].patch` is a hunk body without a `diff --git` header. Wrap it in a synthetic header and parse it with the helper from decision 2, so the add/context rule lives in one place. A patch that does not parse is treated as a missing patch (question 2).

## Questions

### 1. On an incremental run, which lines may be commented?

The model sees `baseline...head` for files that survived the `listFiles` path intersection. GitHub accepts lines from the pull request diff (`base...head`). Those hunks differ: context around a change that cancels out of the pull request diff is in the fetched diff only.

**Answer.** Approved. Send a comment only when the line is a right-side line of the diff fetched for this run and a right-side line of the pull request diff. On a full review the fetched diff is the pull request diff, so the intersection is that set. `listPullRequestFiles` is not called on a full review.

### 2. Where do the pull request lines come from when `patch` is missing?

`listPullRequestFiles` paginates `pulls.listFiles` and keeps `filename` and `patch`. Each file’s `patch` is the pull request hunk and is omitted for a binary file and when GitHub considers the diff too large. The JSON compare lists at most 300 files, which step 3 avoided on purpose.

**Answer.** Approved. Read `patch` from that same pagination. No second compare, and no extra `base...head` diff fetch. When `patch` is absent or does not parse, that file stays in the model input and its inline comments are dropped. Log `comment lines unknown, dropped: <path>`. Publish the other files’ comments with `status=complete`.

### 3. Where does a dropped finding go?

**Answer.** Approved. Leave it off the diff. Do not move it to a nearby line, and do not send `subject_type: file`.

Append blockers only to the review body, after the summary and before the model attribution, capped at 10:

`> Not posted inline (no commentable line on the pull request diff):`

`> - **blocker** `path:line` — comment text`

`major`, `minor`, and `nit` are log-only. The info line is `Dropped N comment(s) that are not commentable on the pull request diff`. The existing blocker warning stays. `suggestedAction` is unchanged (decision 5).

### 4. Should the incremental diff hide lines GitHub will reject?

The prompt tells the model to comment on the `<rightLine>` before `|`, and to skip a line whose number is `-`.

**Answer.** Changed. Do not print `-` for a right-side line outside the pull request patch. That marker means the line was removed. Keep the line as context: its diff prefix is a space, including when the fetched diff had `+`, and its right-line column is `nc`. `nc` is not a line number and not a diff prefix (`+`, `-`, or a space). The prompt says a line marked `nc` may be read and must not be commented on. The publish filter still drops a line taken from the full file body or from `read_file`. Full reviews do not emit `nc`.

### 5. Should the 422 field check grow to the names GitHub returns?

The fallback treats `field` of `line`, `position`, or `path` as a bad location. Live errors use names such as `pull_request_review_thread.line` and `pull_request_review_thread.diff_hunk`. An unpredicted location 422 can therefore fail the run instead of publishing `status=degraded`.

**Answer.** Approved. Leave the matcher as it is. Widening it would change which failures advance the baseline, which step 3 already settled.

## Acceptance

- A full-review comment on an added or context line is sent with `side: RIGHT`. A line outside that diff is absent from `createReview`. The publish is `status=complete`.
- An incremental comment is sent only when the line is in the fetched `baseline...head` hunk and in the `listFiles` patch. A line that is only in the incremental hunk is absent from `createReview`. Upstream files stay excluded by the step 3 path filter.
- A missing `patch` drops that file’s inline comments, still publishes the rest as `complete`, and does not call the diff endpoint a second time.
- A dropped blocker does not change `suggestedAction`.
- An injected `createReview` 422 with `field: line` still publishes one summary with `status=degraded` and does not become the path for a line the filter already removed.
- `pulls.listCommits` stays uncalled. Baseline selection, history loading, and the file-path intersection stay as step 3 shipped them.

[Back to idea index](README.md).
