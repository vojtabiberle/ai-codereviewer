# Support OpenRouter

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

Users could choose additional models through one endpoint instead of requiring a new native adapter for each model vendor.

## Proposal

- Start with the existing OpenAI-compatible provider and `AI_BASE_URL`.
- Verify schema and tool support for selected models, usage reporting and required request configuration.
- Document explicit routing/data-disclosure choices and avoid introducing silent cross-provider fallback.

## Acceptance criteria

- A documented model/endpoint combination completes single-shot and, where supported, agentic review.
- Unsupported model capabilities fail clearly.
- No direct-provider credentials are implicitly reused.

## Open questions

- Is documentation/configuration sufficient, or is a named provider preset needed?
- Which model should be used for the first authorized integration test?

[Back to idea index](README.md).
