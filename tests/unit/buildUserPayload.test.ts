import { buildUserPayload } from '../../src/prompts';
import { ReviewRequest } from '../../src/providers/AIProvider';

function makeRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    files: [{ path: 'src/a.ts', content: 'x', diff: '@@' }],
    contextFiles: [{ path: 'package.json', content: '{"name":"app"}' }],
    pullRequest: { title: 't', description: 'd', base: 'b', head: 'h' },
    context: { repository: 'o/r', owner: 'o' },
    ...overrides,
  };
}

describe('buildUserPayload', () => {
  it('serializes contextFiles into the user payload (the bug fix)', () => {
    const out = JSON.parse(buildUserPayload(makeRequest()));
    expect(out.contextFiles).toEqual([{ path: 'package.json', content: '{"name":"app"}' }]);
  });

  it('serializes the modified files', () => {
    const out = JSON.parse(buildUserPayload(makeRequest()));
    expect(out.files).toEqual([{ path: 'src/a.ts', content: 'x', diff: '@@' }]);
  });

  it('strips repoInstructions from the user payload (it lives in the system prompt)', () => {
    const out = JSON.parse(buildUserPayload(makeRequest({
      context: { repository: 'o/r', owner: 'o', repoInstructions: 'Be strict.' },
    })));
    expect(out.context.repoInstructions).toBeUndefined();
    expect(out.context.repository).toBe('o/r');
  });

  it('preserves projectContext, isUpdate, owner, repository in context', () => {
    const out = JSON.parse(buildUserPayload(makeRequest({
      context: {
        repository: 'o/r',
        owner: 'o',
        projectContext: 'Backend API',
        isUpdate: true,
      },
    })));
    expect(out.context).toEqual({
      repository: 'o/r',
      owner: 'o',
      projectContext: 'Backend API',
      isUpdate: true,
    });
  });

  it('keeps a null line and renders outdated comments with their replies', () => {
    const out = JSON.parse(buildUserPayload(makeRequest({
      previousReviews: [
        {
          summary: 'sum',
          lineComments: [{
            path: 'a.ts',
            line: null,
            outdated: true,
            originalLine: 12,
            comment: 'stale',
            replies: [{ author: 'octocat', comment: 'ack' }],
          }],
        },
      ],
    })));
    expect(out.previousReviews).toEqual([
      {
        summary: 'sum',
        lineComments: [{
          path: 'a.ts',
          line: null,
          outdated: true,
          originalLine: 12,
          comment: 'stale',
          replies: [{ author: 'octocat', comment: 'ack' }],
        }],
      },
    ]);
    expect(JSON.stringify(out.previousReviews)).not.toContain('"line":0');
  });
});
