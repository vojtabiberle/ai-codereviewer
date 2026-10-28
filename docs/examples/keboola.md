# Keboola organization example

Existing Keboola consumers can keep using the organization-managed action.
Moving a consumer to this fork is a separate deployment choice.

If a repository is explicitly authorized to use this fork and the relevant
organization secrets, adapt the generic README example:

```yaml
- uses: vojtabiberle/ai-codereviewer@main # Pin the reviewed commit in production.
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    AI_PROVIDER: google
    AI_MODEL: ${{ vars.AI_REVIEW_MODEL }}
    AI_API_KEY: ${{ secrets.AI_CR_GOOGLE_API_KEY }}
    APPROVE_REVIEWS: 'false'
```

`AI_CR_GOOGLE_API_KEY` was the secret name used in the inherited setup; verify
current organization provisioning and repository visibility. For Anthropic,
select `anthropic` and the authorized secret, historically
`AI_CR_ANTHROPIC_API_KEY`. Model identifiers are account-specific; configure an
available model explicitly. Do not provision or expose organization credentials
in a personal fork.

Required permissions remain `contents: read` and `pull-requests: write`.
Per-repository policy uses the base commit and cannot raise workflow budgets.
