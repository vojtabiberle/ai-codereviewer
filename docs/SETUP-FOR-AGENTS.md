# Agent setup runbook

Install `vojtabiberle/ai-codereviewer` into a consumer repository.

1. Inspect existing review workflows, repository policy and Actions restrictions.
   Update the existing integration rather than adding a duplicate workflow.
2. Select `openai`, `anthropic` or `google`, a model available to the account, and
   an existing authorized API secret. Never invent a current model identifier,
   print secret values, or copy organization credentials between accounts.
3. Use the workflow in [README](../README.md#setup). Pin the action to a reviewed
   commit SHA for production. Permissions: `contents: read`, `pull-requests: write`.
4. Keep approvals and agentic mode disabled initially. Skip draft and fork PRs.
   Set `timeout-minutes: 10` and concurrency cancellation for updates.
5. Add repository conventions in `.github/ai-review.md` and optional configuration
   in `.github/ai-review.yml`. Both are read from the PR base SHA. A new file in
   the setup PR takes effect only after merging.
6. Set context paths and exclude patterns deliberately. Files attached to the
   model must be suitable for disclosure to the chosen provider.
7. Verify the workflow and bundle checks. With authorization, exercise one real
   PR; confirm the run used the intended model and commit, and inspect the posted
   review. A passing mocked test is not proof of live integration.

## Optional agentic mode

Enable `AGENTIC_REVIEW: 'true'` in the trusted workflow. Start with defaults:
20 read attempts, 20,000 UTF-8 output bytes per read, 200,000 bytes total, 10 turns.
Repository YAML may lower those caps, but cannot raise them or enable the mode
when disabled by the workflow. Initial prompt and user payload are capped at
1,000,000 bytes by `MAX_INPUT_BYTES` independently of the read budget.

Model output and repeated context can still be costly. Set provider spending
limits; byte budgets are not a hard currency cap.

## This repository's optional self-review

The shipped self-review workflow is disabled until repository variable
`AI_REVIEW_ENABLED=true` is set. It also needs `AI_REVIEW_PROVIDER`,
`AI_REVIEW_MODEL` and secret `AI_REVIEW_API_KEY`. It checks out the trusted base
commit and executes its bundled action; it does not execute PR source with model
secrets. Fork PRs are skipped. CI runs independently without these credentials.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Action not found | Exact repository name and pinned commit; organization allowlist. |
| Missing API key | Secret name and organization secret visibility for the consumer. |
| Review permission denied | `pull-requests: write`, repository/org restrictions, fork-PR behavior. |
| New policy ignored | Configuration comes from the base commit; merge the setup change first. |
| Review exceeds input budget | Narrow excluded files/context or explicitly raise the workflow cap. |
| Stale head failure | Re-run on the latest commit; no stale review should be published. |
| Bundle check fails | Run `yarn package` on Node.js 24 and commit `dist/`. |

Organization-specific names belong in separate examples. See
[Keboola](examples/keboola.md).
