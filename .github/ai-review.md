# Review instructions for vojtabiberle/ai-codereviewer

This is the AI Code Reviewer GitHub Action itself. Reviews of this repo
should help maintainers, not generate noise. Apply these rules in
addition to the generic guidance.

## Verify before claiming

- **For any factual claim about an external API, SDK, model name, or
  protocol** (Anthropic, OpenAI, Google AI, Octokit, GitHub Models,
  GitHub Actions): include the exact doc URL or quote that supports the
  claim. If you cannot cite a source, do not raise the comment.
- Recent false positives we want to avoid:
  - "`input_tokens` already includes cached tokens" — *wrong*; per
    Anthropic docs the three usage fields are disjoint.
  - "`gpt-4o` works on GitHub Models" — *wrong*; Models requires the
    `publisher/model` form (`openai/gpt-4o`).

## Model identifiers — do NOT flag as nonexistent

Your training data has a knowledge cutoff. Models released after that
cutoff will look unfamiliar to you, but that does **not** mean they are
invalid. **Never** raise a comment claiming a model ID "does not exist",
"is not a valid model", "is not currently available", or suggesting a
"downgrade" to an older model — that judgement is out of scope for a code
review and you have no authoritative source for it (the API, not your
memory, is the source of truth).

The following identifiers are **known-valid current models** and must be
treated as correct wherever they appear (workflows, README, docs, this
runbook):

- Google: `gemini-3.1-pro-preview` (the model running *this* review),
  and any `gemini-3.x` / later id.
- Anthropic: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`,
  and any later Claude 4.x / Fable id.
- OpenAI: any current `gpt-4.x` / `o`-series id.

If you believe a model id is genuinely *malformed* (e.g. wrong provider
namespace like a missing `publisher/` prefix on GitHub Models), cite the
exact provider doc that defines the required format. Absent such a
citation, say nothing about the model id.

## Use read_file aggressively (with line ranges)

This repo runs in agentic mode (`agentic_review: true`). When the diff
references a function, type, or test fixture that isn't in the diff,
**read it before commenting**. Comments rooted in "I assume X works
like…" are worse than no comment.

**Prefer line ranges.** When you only need a specific function or block,
pass `start_line` / `end_line` instead of pulling the whole file. Output
is line-numbered (`<n>: <text>`); cite those exact numbers in your review
comments. A typical session should look more like "read lines 80-120 of
src/foo.ts" than "read all of src/foo.ts".

Strong reasons to call `read_file`:
- The diff calls a helper not shown — read just that helper.
- A test was added or changed — read just the test it touches.
- A type or interface is referenced but not defined in the diff — read
  the relevant lines, not the whole types module.

Weak reasons (skip):
- "Just to get more context." Be specific about what is actually missing.
- READMEs / docs files unless the PR changes them.
- Pulling a whole file when you only care about ~30 lines.

## Recognize intentional patterns

- `dist/` is committed on purpose — this repo ships as a node-action,
  the bundled JS is the entry point. Do not flag the dist diff as
  unrelated changes.
- `jsonrepair` + fenced-JSON extraction in `OpenAIProvider.parseResponse`
  is a fallback for non-strict-schema models (older o1, GitHub Models
  routes that don't honor `json_schema`). Do not propose removing it
  even though `response_format: json_schema` is the default path.
- `originalContent` was intentionally dropped — do not propose
  re-adding it; the diff already encodes what changed.
- The `core.warning` retry path in `GitHubService.submitReview` exists
  to handle GitHub returning 422 on a single bad line comment — do not
  propose fail-fast.

## Don't suggest

- "Add a comment explaining…" — code should be self-explanatory; if it
  isn't, propose a clearer name or smaller function.
- Renames driven purely by personal preference.
- Backwards-compatibility shims for inputs that have been in the action
  less than a release.
- Splitting into more files / barrels / index re-exports unless there
  is a concrete current consumer.

## Severity calibration for this repo

- `blocker`: real security issue (token leak, prompt-injection vector
  on fork PRs, command injection), data-loss risk, or a change that
  breaks an existing public action input or schema field.
- `major`: incorrect API call (wrong field name / shape against the
  cited SDK), missing await on a promise, unhandled rejection in a
  hot path.
- `minor`: type holes, weak narrowing, missing test for a new branch,
  unused export.
- `nit`: style only — these are dropped by default
  (`MIN_COMMENT_SEVERITY=minor`); don't bother emitting unless asked.

## Tests

- Tests live in `tests/unit/*.test.ts` and `tests/integration/*.test.ts`
  using Jest. Don't suggest a switch to Vitest.
- Real network calls are forbidden in tests. SDK clients are mocked via
  `jest.mock(...)`.
