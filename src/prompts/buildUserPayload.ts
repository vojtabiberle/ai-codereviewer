import { ReviewRequest } from '../providers/AIProvider';

/**
 * Build the JSON payload sent as the user message to every provider.
 *
 * Includes:
 *   - files:        the modified files (path, content, diff) of this PR
 *   - contextFiles: extra files the consumer pinned via CONTEXT_FILES
 *                   (default: package.json, README.md). Useful for the
 *                   model to understand project shape without re-fetching.
 *   - pr:           title, description, base/head SHAs
 *   - context:      repository, owner, projectContext, isUpdate
 *                   (NOTE: repoInstructions is intentionally stripped
 *                   here — it's already in the system prompt where it
 *                   gets cached. Keeping it here too would double-count
 *                   tokens and bypass caching.)
 *   - previousReviews: history already trimmed to the prompt budget.
 *                   A null line is left null and paired with outdated: true.
 *                   Replies from other authors are already abbreviated.
 */
export function buildUserPayload(request: ReviewRequest): string {
  const { repoInstructions: _omit, ...contextSansInstructions } = request.context;

  return JSON.stringify({
    type: 'code_review',
    files: request.files,
    contextFiles: request.contextFiles,
    pr: request.pullRequest,
    context: contextSansInstructions,
    previousReviews: request.previousReviews,
  });
}
