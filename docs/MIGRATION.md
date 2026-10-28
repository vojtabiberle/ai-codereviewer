# Fork continuation plan (3.0.0)

Name and destination: `vojtabiberle/ai-codereviewer`.

1. Preserve the complete main-branch ancestry through Keboola commit `295c24b`,
   with original commit IDs, contributors and MIT attribution.
2. Replace organization defaults with provider-neutral setup. Retain an isolated
   Keboola example and explicit CLI arguments. Incorporate the upstream script
   argument/environment fixes without restoring organization-specific defaults.
3. Add read-only CI for types, mocked tests and reproducible committed bundles.
   Replace the bot-push rebuild workflow with a bundle freshness check.
4. Pin diff, source context and review submission to commit SHAs; reject a changed
   head before publishing. Retry without inline comments only for explicit
   location-validation errors, never for authentication or ambiguous network errors.
5. Read policy from the base commit. Enforce workflow ceilings for approvals,
   agentic enablement and budgets. Add aggregate UTF-8 read and initial-input caps.
6. Test these boundaries, rebuild the shipped bundle, publish to the existing fork,
   then inspect the actual GitHub CI run. Live model testing requires credentials
   and a designated PR; mocked tests do not establish model quality.

## Compatibility changes

- Automatic approval defaults to false.
- Configuration, local instructions and project-context files come from the base
  SHA. New policy in a PR takes effect after merge.
- Repository YAML can only disable approval/agentic mode, raise the confidence
  threshold or lower agentic limits relative to workflow inputs.
- Agentic defaults change from 80 reads / 1 MB per read / 30 turns to 20 reads /
  20 KB per read / 10 turns, with a new 200 KB aggregate read-output cap.
- Initial prompt and user payload have a new 1 MB cap; oversized reviews fail
  before the first model call. All byte limits use UTF-8.
- Local scripts require explicit owner, repository and PR number; the live-test
  script posts comment-only reviews by default.
- Consumers must commit generated bundles; CI no longer pushes rebuild commits.
- No consumer repository or organization secret is migrated automatically.
