# Define and test provider capabilities

Status: idea — not approved for implementation.
Priority: P1 (proposed).

## Problem

An OpenAI-compatible endpoint is not evidence that every required parameter, tool or structured-output mode works.

## Proposal

- Build a small compatibility matrix for single-shot review, tool calls, structured outputs, output limits, usage and error handling.
- Reuse existing provider interfaces and endpoint support; add only capability switches required by concrete integrations.
- Use contract fixtures plus separately authorized live smoke tests; report tested model/endpoint combinations explicitly.
- Fail clearly for unsupported combinations rather than silently disabling essential review behavior.

## Acceptance criteria

- Each supported integration has documented capabilities and meaningful contract tests.
- Unsupported tool or schema modes have a clear failure or explicitly configured alternative.
- Mocked compatibility is never presented as live verification.

## Open questions

- Which capabilities belong to the provider versus the specific model/deployment?
- How should capability overrides be exposed without hardcoding a quickly stale model catalog?

[Back to idea index](README.md).
