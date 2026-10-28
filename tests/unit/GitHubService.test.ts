import { GitHubService } from '../../src/services/GitHubService';

const createReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
const getPR = jest.fn();
const getAuthenticated = jest.fn().mockResolvedValue({
  data: { login: 'ai-reviewer-bot' }
});

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { createReview, get: getPR },
    users: { getAuthenticated }
  }))
}));

describe('GitHubService.submitReview', () => {
  beforeEach(() => {
    createReview.mockReset().mockResolvedValue({ data: { id: 1 } });
    getPR.mockReset().mockResolvedValue({ data: {
      title: 't', body: '', base: { sha: 'B' }, head: { sha: 'H' },
    } });
    getAuthenticated.mockClear();
    process.env.GITHUB_REPOSITORY = 'octocat/hello';
  });

  it('drops only invalid line comments, keeps valid ones', async () => {
    const service = new GitHubService('mock-token');

    const validRightLines = new Map<string, Set<number>>([
      ['src/a.ts', new Set([2, 3])],
      ['src/b.ts', new Set([10])],
    ]);

    await service.submitReview(
      42,
      {
        summary: 'sum',
        suggestedAction: 'COMMENT',
        confidence: 50,
        lineComments: [
          { path: 'src/a.ts', line: 2, comment: 'good a:2' },
          { path: 'src/a.ts', line: 99, comment: 'bad a:99' },
          { path: 'src/b.ts', line: 10, comment: 'good b:10' },
          { path: 'src/c.ts', line: 1, comment: 'bad c:1 (file not in diff)' },
        ]
      },
      validRightLines,
      'H'
    );

    expect(createReview).toHaveBeenCalledTimes(1);
    const call = createReview.mock.calls[0][0];
    expect(call.event).toBe('COMMENT');
    expect(call.commit_id).toBe('H');
    expect(call.comments).toHaveLength(2);
    expect(call.comments.map((c: any) => `${c.path}:${c.line}`).sort())
      .toEqual(['src/a.ts:2', 'src/b.ts:10']);
  });

  it('passes all comments through when no validation map is provided', async () => {
    const service = new GitHubService('mock-token');

    await service.submitReview(7, {
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 0,
      lineComments: [{ path: 'x.ts', line: 1, comment: 'whatever' }]
    }, undefined, 'H');

    const call = createReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(1);
  });

  it('rejects a changed PR head before any review publication', async () => {
    getPR.mockResolvedValueOnce({ data: { title: 't', base: { sha: 'B' }, head: { sha: 'NEW' } } });
    await expect(new GitHubService('token').submitReview(1, {
      summary: 's', suggestedAction: 'APPROVE', confidence: 99,
    }, undefined, 'H')).rejects.toThrow('PR head changed');
    expect(createReview).not.toHaveBeenCalled();
  });

  it.each([403, 422, 500])('does not retry or drop comments on unrelated HTTP %s errors', async status => {
    const error = Object.assign(new Error('failure'), { status });
    createReview.mockRejectedValueOnce(error);
    await expect(new GitHubService('token').submitReview(1, {
      summary: 's', suggestedAction: 'COMMENT', confidence: 0,
      lineComments: [{ path: 'a.ts', line: 1, comment: 'x' }],
    }, undefined, 'H')).rejects.toBe(error);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an ambiguously failed network write', async () => {
    createReview.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await expect(new GitHubService('token').submitReview(1, {
      summary: 's', suggestedAction: 'COMMENT', confidence: 0,
    }, undefined, 'H')).rejects.toThrow('timeout');
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it('retries explicit invalid line errors without comments on the same SHA', async () => {
    createReview.mockRejectedValueOnce({ status: 422, response: { data: { errors: [{ field: 'line' }] } } });
    await new GitHubService('token').submitReview(1, {
      summary: 's', suggestedAction: 'COMMENT', confidence: 0,
      lineComments: [{ path: 'a.ts', line: 1, comment: 'x' }],
    }, undefined, 'H');
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createReview.mock.calls[1][0]).toMatchObject({ commit_id: 'H', comments: [] });
  });

  it('checks the head again before the location-error fallback', async () => {
    createReview.mockRejectedValueOnce({ status: 422, response: { data: { errors: [{ field: 'line' }] } } });
    getPR.mockResolvedValueOnce({ data: { title: 't', base: { sha: 'B' }, head: { sha: 'H' } } })
      .mockResolvedValueOnce({ data: { title: 't', base: { sha: 'B' }, head: { sha: 'NEW' } } });
    await expect(new GitHubService('token').submitReview(1, {
      summary: 's', suggestedAction: 'COMMENT', confidence: 0,
      lineComments: [{ path: 'a.ts', line: 1, comment: 'x' }],
    }, undefined, 'H')).rejects.toThrow('PR head changed');
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it('caches authenticated user lookup', async () => {
    const service = new GitHubService('mock-token');
    const a = await service.getBotLogin();
    const b = await service.getBotLogin();
    expect(a).toBe('ai-reviewer-bot');
    expect(b).toBe('ai-reviewer-bot');
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('falls back silently (debug, not warning) on 403 from /user — the integration-token case', async () => {
    getAuthenticated.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 403 }));
    const warnSpy = jest.spyOn(require('@actions/core'), 'warning').mockImplementation(() => {});
    const debugSpy = jest.spyOn(require('@actions/core'), 'debug').mockImplementation(() => {});

    const service = new GitHubService('default-github-token');
    const login = await service.getBotLogin();

    expect(login).toBe('github-actions[bot]');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('not accessible'));

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('warns on unexpected /user errors (e.g. 5xx, network)', async () => {
    getAuthenticated.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }));
    const warnSpy = jest.spyOn(require('@actions/core'), 'warning').mockImplementation(() => {});

    const service = new GitHubService('mock-token');
    const login = await service.getBotLogin();

    expect(login).toBe('github-actions[bot]');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve authenticated user'));
    warnSpy.mockRestore();
  });
});
