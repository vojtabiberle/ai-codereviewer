# ai-codereviewer

GitHub Action for AI code review using OpenAI, Anthropic or Google Gemini.
Reviews PR diffs, posts inline comments, avoids repeated comments, and optionally
reads repository files through a bounded tool loop.

This fork continues [lfsevergnini/ai-codereviewer](https://github.com/lfsevergnini/ai-codereviewer).
Original Git history, contributor attribution and [MIT license](LICENCE) are retained.

## Setup

1. Store your provider API key in the repository or organization secret `AI_REVIEW_API_KEY`.
2. Set repository variables `AI_REVIEW_PROVIDER` (`openai`, `anthropic` or `google`)
   and `AI_REVIEW_MODEL` (a model identifier available to your account).
3. Add `.github/workflows/code-review.yml`:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    # Fork PRs do not receive API secrets or a writable GITHUB_TOKEN.
    if: >-
      !github.event.pull_request.draft
      && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: vojtabiberle/ai-codereviewer@main # Pin a reviewed commit SHA for production.
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: ${{ vars.AI_REVIEW_PROVIDER }}
          AI_MODEL: ${{ vars.AI_REVIEW_MODEL }}
          AI_API_KEY: ${{ secrets.AI_REVIEW_API_KEY }}
          APPROVE_REVIEWS: 'false'
          MAX_COMMENTS: '10'
          EXCLUDE_PATTERNS: '**/*.lock,dist/**'
```

No checkout or dependency installation is needed in consumer repositories.
The action runs the committed `dist/index.js` bundle on Node.js 24.
See [agent setup runbook](docs/SETUP-FOR-AGENTS.md).

## Configuration

| Input | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | required | Token with contents read and pull requests write permissions. |
| `REVIEWER_ID` | `${GITHUB_WORKFLOW}/${GITHUB_JOB}` | Identity stored in the hidden review marker. Distinguishes workflows that share one bot account. Not read from repository YAML. |
| `IDENTITY_ONLY` | `false` | Log the bot identity and exit before a model call. Used by the manual bot-identity workflow. |
| `AI_PROVIDER` | `openai` | `openai`, `anthropic`, `google`. |
| `AI_API_KEY` | required | Key for the selected provider. |
| `AI_MODEL` | required | Model identifier supported by the selected provider/account. |
| `AI_BASE_URL` | empty | Endpoint override for the OpenAI-compatible provider only. |
| `AI_TEMPERATURE` | `0` | Number from 0 to 1. Model compatibility varies. |
| `APPROVE_REVIEWS` | `false` | Enable AI approvals. Blocker comments can still request changes. |
| `APPROVE_CONFIDENCE_THRESHOLD` | `80` | Minimum confidence from 0 to 100 for approval. |
| `MAX_COMMENTS` | `0` | Inline comment cap; 0 means unlimited. |
| `MIN_COMMENT_SEVERITY` | `minor` | `blocker`, `major`, `minor`, `nit`. |
| `EXCLUDE_PATTERNS` | `**/*.lock,**/*.json,**/*.md` | Comma-separated globs excluded from diff and agentic reads. |
| `PROJECT_CONTEXT` | empty | Inline project description. |
| `PROJECT_CONTEXT_FILE` | empty | Project description file read from the PR base commit; takes precedence over inline text. |
| `INSTRUCTIONS_FILE` | `.github/ai-review.md` | Reviewer instructions read from the PR base commit. Missing file is skipped. |
| `INSTRUCTIONS_URL` | empty | Shared reviewer instructions fetched from a workflow-controlled URL. |
| `INSTRUCTIONS_URL_TOKEN` | empty | Optional bearer token for that URL. |
| `CONTEXT_FILES` | empty | Comma-separated paths attached from the reviewed head SHA. |
| `CONFIG_FILE` | `.github/ai-review.yml` | YAML configuration read from the PR base commit. |
| `MAX_INPUT_BYTES` | `1000000` | UTF-8 cap on initial system prompt plus serialized user payload. Oversized reviews fail before a model call. |
| `AGENTIC_REVIEW` | `false` | Allow the model to call `read_file` and `submit_review`. |
| `AGENTIC_MAX_FILES` | `20` | Maximum distinct `(path, range)` read attempts, including missing files. |
| `AGENTIC_MAX_BYTES_PER_FILE` | `20000` | Maximum UTF-8 output bytes per read, including a truncation marker. |
| `AGENTIC_MAX_TOTAL_BYTES` | `200000` | Maximum aggregate UTF-8 file output bytes across the session. |
| `AGENTIC_MAX_TURNS` | `10` | Maximum model turns per agentic session. |

### Repository policy

Commit `.github/ai-review.yml` to the target branch:

```yaml
min_comment_severity: major
approve_reviews: false
approve_confidence_threshold: 95
max_comments: 5
exclude_patterns: '**/*.lock,dist/**'
instructions_file: .github/ai-review.md
context_files:
  - package.json
  - README.md
# Agentic mode must also be enabled in the workflow.
agentic_review: true
agentic_max_files: 10
agentic_max_bytes_per_file: 10000
agentic_max_total_bytes: 50000
agentic_max_turns: 5
```

YAML keys correspond to lowercase action input names. `project_context` and
`project_context_file` are also supported. Unknown or invalid keys are ignored.

Workflow inputs set the trust and budget ceiling. Repository policy can disable
approval or agentic mode, raise the approval threshold, and lower agentic budgets;
it cannot enable those modes or raise budgets beyond the workflow values.
Other recognized keys override the workflow baseline. API keys, endpoint URLs,
shared-instruction credentials, `MAX_INPUT_BYTES` and `REVIEWER_ID` cannot be overridden in YAML.

Configuration, local instructions and project-context files come from the
**base SHA**, so a PR cannot rewrite its own review policy. Policy changes take
effect after merging. Context files, changed file contents, agentic reads and
comparison endpoints use the **head SHA**. Reviews are explicitly attached to that
commit; a changed head detected before publication causes failure instead of a
stale approval. The published body ends with a hidden marker recording the
reviewer id, head SHA, base SHA, and `status=complete` (or `status=degraded`
when GitHub rejects comment locations and only the summary is published).
A reviewer id that is one safe token (`CI/review`, `my-workflow/job`) is stored
as written. Spaces and `--` are percent-encoded. The exact bytes are in
[docs/ideas/001](docs/ideas/001-reviewed-commit-sha.md#review-marker-format).
A push after the last check can still race publication, but the
review remains attached to the older SHA. Enable stale-approval dismissal in
branch protection if approvals are enabled.

### Instructions and agentic review

Put repository conventions in `.github/ai-review.md`. Shared `INSTRUCTIONS_URL`
content is loaded first, followed by local instructions. The URL is controlled by
the workflow; use a versioned URL for reproducible policy.

Agentic mode lets the model inspect helpers and tests beyond the initial diff.
`read_file(path, reason, start_line?, end_line?)` accepts repository-relative paths
and optional inclusive, one-based line ranges. Output includes line numbers.
Absolute paths, parent traversal and excluded paths are rejected. Read slots are
reserved before asynchronous fetches, so parallel tool calls share the same cap.

The input and read caps bound supplied source data, not currency or total billed
tokens. Tool schemas, model output, SDK retries and repeated conversation context
also consume tokens. Provider SDKs may retry individual API requests; the action
does not restart an entire agentic session. Use provider spending limits and the
workflow timeout for an additional cost boundary. Source content remains untrusted;
prompt guidance does not guarantee immunity to prompt injection. AI approval is
opt-in and should not be the only merge gate.

Do not use `pull_request_target` to check out or execute untrusted PR code with
secrets. The example skips fork PRs. Supporting external contributors requires a
separately reviewed workflow and explicit access policy.

## Development

Use Node.js 24 and Yarn 1.22.22:

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test --runInBand
yarn package
yarn test:bundle
```

Commit rebuilt `dist/` with source changes. CI runs type checking, mocked tests,
bundling and process-level checks of the shipped entry point, then rejects stale bundles. It runs without model secrets and never
pushes to contributor branches. Tests do not prove live model behavior.

For a live manual test, provide `GITHUB_TOKEN`, `AI_PROVIDER`, `AI_API_KEY` and
`AI_MODEL` in an untracked `.env` or the environment, then run:

```sh
yarn generate-pr-payload <owner> <repo> <pr_number>
yarn test:e2e <owner> <repo> <pr_number>
```

**The live test posts a review to that PR and spends API credit.** Automatic approvals are disabled; blocker findings can still request changes. The script accepts both `INPUT_AI_*` and `AI_*` environment
variables. `OPENAI_API_KEY` remains a fallback for the OpenAI API key.

To check bot identity against api.github.com without a model key, open Actions →
**Bot identity** → **Run workflow** on this repository. The log line is
`Bot identity: login=… databaseId=… source=graphql|rest|fallback`. The default
job uses `github.token`. The GitHub App job resolves `BOT_IDENTITY_APP_TOKEN`
when that secret is set, and skips the check when it is absent. The workflow
does not post a review.

See [migration plan and compatibility notes](docs/MIGRATION.md).

Proposed improvements are tracked individually in the [idea backlog](docs/ideas/README.md).
