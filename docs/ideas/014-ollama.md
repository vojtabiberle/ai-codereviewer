# Support Ollama on a self-hosted runner

Status: idea — not approved for implementation.
Priority: P2 (proposed).

## Problem

Users may want repository review against a locally operated model endpoint.

## Proposal

- Test the existing OpenAI-compatible route against Ollama before adding a dedicated adapter.
- Handle partial API compatibility and model-specific tool/schema behavior explicitly.
- Document runner-to-endpoint connectivity, optional authentication requirements and which data leaves the runner.
- Use explicit configuration for any unauthenticated endpoint; preserve validation for cloud API credentials.

## Acceptance criteria

- A documented local model completes an end-to-end review on a self-hosted runner.
- Tool/schema limitations and context constraints are visible.
- The action does not silently route local review content to a cloud service.

## Open questions

- What hardware/model is available for the first test?
- Should local endpoints use single-shot review initially?
- How should unauthenticated local endpoint configuration be represented?

[Back to idea index](README.md).
