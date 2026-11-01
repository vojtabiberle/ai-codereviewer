import { ReviewService } from '../../src/services/ReviewService';
import { GitHubService } from '../../src/services/GitHubService';
import { DiffService } from '../../src/services/DiffService';
import { AIProvider, ReviewResponse } from '../../src/providers/AIProvider';
import { HistoryComment, HistoryReview } from '../../src/services/reviewHistory';
import { buildSystemPrompt } from '../../src/prompts';

class StubAIProvider implements AIProvider {
  public lastRequest: any;
  constructor(private response: ReviewResponse) {}
  async initialize(): Promise<void> {}
  async review(req: any): Promise<ReviewResponse> {
    this.lastRequest = req;
    return this.response;
  }
}

/** Context lines `start` through `start + count - 1` on the right side. */
function contextPatch(start: number, count: number): string {
  const lines = [`@@ -${start},${count} +${start},${count} @@`];
  for (let i = 0; i < count; i++) lines.push(' context');
  return lines.join('\n');
}

function makeServices(aiResponse: ReviewResponse) {
  const githubService = {
    getPRDetails: jest.fn().mockResolvedValue({
      owner: 'o', repo: 'r', number: 1,
      title: 't', description: 'd', base: 'B', head: 'H'
    }),
    getReviewerId: jest.fn().mockReturnValue('CI/review'),
    compareCommits: jest.fn().mockResolvedValue({ ok: true, status: 'ahead' }),
    listPullRequestFiles: jest.fn().mockResolvedValue([
      { path: 'src/a.ts', patch: contextPatch(1, 9) },
    ]),
    getPreviousReviews: jest.fn().mockResolvedValue([]),
    getFileContent: jest.fn().mockResolvedValue('content'),
    submitReview: jest.fn().mockResolvedValue(undefined),
  } as unknown as GitHubService;

  const diffService = {
    getRelevantFiles: jest.fn().mockResolvedValue([
      { path: 'src/a.ts', diff: '@@', validRightLines: new Set([1, 2, 3]) }
    ]),
    getExcludePatterns: jest.fn().mockReturnValue([]),
    setExcludePatterns: jest.fn(),
  } as unknown as DiffService;

  const aiProvider = new StubAIProvider(aiResponse);
  return { githubService, diffService, aiProvider };
}

describe('ReviewService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('CONFIG_FILE context_files overrides the action-input list', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    const yaml = `
context_files:
  - package.json
  - tsconfig.json
`.trim();

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => {
        if (path === '.github/ai-review.yml') return yaml;
        if (path === 'package.json') return '{"name":"app"}';
        if (path === 'tsconfig.json') return '{"compilerOptions":{}}';
        return 'baseline-default-should-not-show';
      }
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      contextFiles: ['baseline-default'],
      configFile: '.github/ai-review.yml',
    });

    await service.performReview(1);

    const ctx = (aiProvider as StubAIProvider).lastRequest.contextFiles.map((f: any) => f.path);
    expect(ctx.sort()).toEqual(['package.json', 'tsconfig.json']);
  });

  it('per-repo CONFIG_FILE overrides action-input baselines', async () => {
    // Baseline: minor severity, threshold 80, max 0 (unlimited).
    // YAML overrides: major severity, threshold 95, max 1.
    // AI returns one minor and one major comment + APPROVE@90.
    // Expected after override: minor dropped, major kept, APPROVE downgraded
    // to COMMENT (90 < 95).
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 90,
      lineComments: [
        { path: 'src/a.ts', line: 1, comment: 'minor issue', severity: 'minor' },
        { path: 'src/a.ts', line: 2, comment: 'big issue', severity: 'major' },
      ]
    });

    const yaml = `
min_comment_severity: major
approve_confidence_threshold: 95
max_comments: 5
`.trim();

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/ai-review.yml' ? yaml : 'content'
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      approveConfidenceThreshold: 80,
      minCommentSeverity: 'minor',
      configFile: '.github/ai-review.yml',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    const submitted = submit.mock.calls[0][1];
    expect(submitted.lineComments.map((c: any) => c.severity)).toEqual(['major']);
    expect(submitted.suggestedAction).toBe('COMMENT'); // downgraded from APPROVE@90 because YAML raised threshold to 95
  });

  it('combines INSTRUCTIONS_URL (shared) and INSTRUCTIONS_FILE (local) into the prompt', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/ai-review.md' ? 'Local: skip nits.' : 'content'
    );

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'Shared org-wide rule: SQL concat is a blocker.',
    }) as any;

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      instructionsFile: '.github/ai-review.md',
      instructionsUrl: 'https://example.com/shared.md',
    });

    await service.performReview(1);

    const merged = (aiProvider as StubAIProvider).lastRequest.context.repoInstructions;
    expect(merged).toContain('Shared org-wide rule');
    expect(merged).toContain('Local: skip nits.');
    // Shared baseline appears before local override
    expect(merged.indexOf('Shared org-wide rule')).toBeLessThan(merged.indexOf('Local: skip nits.'));
  });

  it('sends Authorization header when INSTRUCTIONS_URL_TOKEN is set', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', text: async () => 'Shared rules.'
    });
    global.fetch = fetchMock as any;

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      instructionsUrl: 'https://example.com/private.md',
      instructionsUrlToken: 'ghp_secret',
    });

    await service.performReview(1);

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['Authorization']).toBe('Bearer ghp_secret');
  });

  it('skips shared instructions silently when INSTRUCTIONS_URL fetch fails', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockResolvedValue('');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found', text: async () => '',
    }) as any;

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      instructionsUrl: 'https://example.com/missing.md',
    });

    await service.performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.context.repoInstructions).toBeUndefined();
  });

  it('PROJECT_CONTEXT_FILE takes precedence over inline PROJECT_CONTEXT when present', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/project-context.md' ? 'From file.' : 'content'
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      projectContext: 'Inline context.',
      projectContextFile: '.github/project-context.md',
    });

    await service.performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.context.projectContext).toBe('From file.');
  });

  it('falls back to inline PROJECT_CONTEXT when PROJECT_CONTEXT_FILE is missing', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/project-context.md' ? '' : 'content'
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      projectContext: 'Inline context.',
      projectContextFile: '.github/project-context.md',
    });

    await service.performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.context.projectContext).toBe('Inline context.');
  });

  it('passes per-repo instructions from INSTRUCTIONS_FILE into the AI request', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/ai-review.md' ? 'Be strict about SQL injection.' : 'content'
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      instructionsFile: '.github/ai-review.md',
    });

    await service.performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.context.repoInstructions)
      .toContain('Be strict about SQL injection.');
  });

  it('skips repo instructions silently when the file is missing', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async () => '' // empty content emulates "missing file"
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      instructionsFile: '.github/ai-review.md',
    });

    await service.performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.context.repoInstructions).toBeUndefined();
  });

  it('drops comments below MIN_COMMENT_SEVERITY', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 1, comment: 'nit comment', severity: 'nit' },
        { path: 'src/a.ts', line: 2, comment: 'minor issue', severity: 'minor' },
        { path: 'src/a.ts', line: 3, comment: 'big issue', severity: 'major' },
      ]
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'major',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    const submittedComments = submit.mock.calls[0][1].lineComments;
    expect(submittedComments.map((c: any) => c.severity)).toEqual(['major']);
  });

  it('does not escalate when the only blocker is on a line outside the diff', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 999, comment: 'blocker on bad line', severity: 'blocker', category: 'security' },
      ]
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    const body = submit.mock.calls[0][1].summary as string;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('COMMENT');
    expect(submit.mock.calls[0][1].lineComments).toHaveLength(0);
    expect(body).toContain('> Not posted inline (no commentable line on the pull request diff):');
    expect(body).toContain('> - **blocker** `src/a.ts:999` — blocker on bad line');
    expect(body.indexOf('blocker on bad line')).toBeLessThan(body.indexOf('------'));
  });

  it('appends at most 10 dropped blockers and leaves other severities in the log', async () => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const lineComments = [
      ...Array.from({ length: 11 }, (_, index) => ({
        path: 'src/a.ts',
        line: 100 + index,
        comment: `drop-${String(index).padStart(2, '0')}`,
        severity: 'blocker' as const,
      })),
      { path: 'src/a.ts', line: 2, comment: 'kept major', severity: 'major' as const },
      { path: 'src/a.ts', line: 4, comment: 'logged minor', severity: 'minor' as const },
    ];
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments,
    });
    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const body = (githubService.submitReview as jest.Mock).mock.calls[0][1].summary as string;
    for (let index = 0; index < 10; index++) {
      expect(body).toContain(`drop-${String(index).padStart(2, '0')}`);
    }
    expect(body).not.toContain('drop-10');
    expect(body).not.toContain('logged minor');
    expect(info).toHaveBeenCalledWith('Dropped 12 comment(s) that are not commentable on the pull request diff');
    info.mockRestore();
  });

  it('forces REQUEST_CHANGES when any blocker survives, even if AI said approve', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 99,
      lineComments: [
        { path: 'src/a.ts', line: 1, comment: 'sql injection', severity: 'blocker', category: 'security' },
      ]
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('REQUEST_CHANGES');
  });

  it('downgrades to COMMENT when approveReviews is false and there is no blocker', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 99,
      lineComments: []
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('COMMENT');
  });

  it('downgrades approve to comment when confidence is below threshold', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 60,
      lineComments: []
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      approveConfidenceThreshold: 80,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('COMMENT');
  });

  it('does not approve when confidence is missing (treated as 0)', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      // simulate a provider that omitted confidence
      confidence: undefined as unknown as number,
      lineComments: []
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      approveConfidenceThreshold: 80,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('COMMENT');
  });

  it('falls back to default threshold when input is NaN', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 90,
      lineComments: []
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      approveConfidenceThreshold: NaN as unknown as number,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    // 90 >= default 80 → APPROVE
    expect(submit.mock.calls[0][1].suggestedAction).toBe('APPROVE');
  });

  it('approves when confidence meets threshold and no blocker', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'APPROVE',
      confidence: 90,
      lineComments: []
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      approveConfidenceThreshold: 80,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    expect(submit.mock.calls[0][1].suggestedAction).toBe('APPROVE');
  });

  it('propagates configured agentic limits into the AI request when agentic review is on', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    (githubService.getFileContent as jest.Mock).mockResolvedValue('content');

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      agenticReview: true,
      agenticLimits: { maxFiles: 5, maxBytesPerFile: 1000, maxTurns: 3 },
    });

    await service.performReview(1);

    const ctx = (aiProvider as StubAIProvider).lastRequest.context;
    expect(ctx.agenticReview).toBe(true);
    expect(ctx.agenticLimits).toEqual({ maxFiles: 5, maxBytesPerFile: 1000, maxTurns: 3, maxTotalBytes: 200000 });
  });

  it('CONFIG_FILE agentic_max_* keys lower action-input agentic limits', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: []
    });

    const yaml = `
agentic_review: true
agentic_max_files: 7
agentic_max_bytes_per_file: 4096
agentic_max_turns: 4
`.trim();

    (githubService.getFileContent as jest.Mock).mockImplementation(
      async (path: string) => path === '.github/ai-review.yml' ? yaml : 'content'
    );

    const service = new ReviewService(aiProvider as any, githubService, diffService, {
      maxComments: 0,
      approveReviews: true,
      minCommentSeverity: 'minor',
      configFile: '.github/ai-review.yml',
      agenticReview: true,
      agenticLimits: { maxFiles: 99, maxBytesPerFile: 999999, maxTurns: 99 },
    });

    await service.performReview(1);

    const ctx = (aiProvider as StubAIProvider).lastRequest.context;
    expect(ctx.agenticLimits).toEqual({ maxFiles: 7, maxBytesPerFile: 4096, maxTurns: 4, maxTotalBytes: 200000 });
  });

  it('keeps higher-severity comments when MAX_COMMENTS truncates', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 1, comment: 'a', severity: 'minor' },
        { path: 'src/a.ts', line: 2, comment: 'b', severity: 'major' },
        { path: 'src/a.ts', line: 3, comment: 'c', severity: 'minor' },
      ]
    });

    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 1,
      approveReviews: true,
      minCommentSeverity: 'minor',
    });

    await service.performReview(1);

    const submit = githubService.submitReview as jest.Mock;
    const submitted = submit.mock.calls[0][1].lineComments;
    expect(submitted).toHaveLength(1);
    expect(submitted[0].severity).toBe('major');
  });

  it('loads history for an unmarked review and does not switch to the update prompt', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 50, lineComments: [],
    });
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      historyReview({
        lineComments: [historyComment({ body: 'earlier finding', line: 2, originalLine: 2 })],
      }),
    ]);

    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
    }).performReview(1);

    expect(githubService.getPreviousReviews).toHaveBeenCalledWith(1);
    expect(diffService.getRelevantFiles).toHaveBeenCalledWith(expect.objectContaining({ base: 'B', head: 'H' }));
    expect((diffService.getRelevantFiles as jest.Mock).mock.calls[0][1]).toBeUndefined();
    const request = (aiProvider as StubAIProvider).lastRequest;
    expect(request.context.isUpdate).toBe(false);
    expect(buildSystemPrompt(request)).not.toContain('When reviewing updates');
    expect(JSON.stringify(request.previousReviews)).toContain('earlier finding');
  });

  it('dedupes on line ?? originalLine from the full history when the prompt budget drops the comment', async () => {
    const warn = jest.spyOn(require('@actions/core'), 'warning').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 2, comment: 'Same', severity: 'major' },
        { path: 'src/a.ts', line: 3, comment: 'Same', severity: 'major' },
        { path: 'src/a.ts', line: 1, comment: 'Fresh', severity: 'major' },
      ],
    });
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      historyReview({
        lineComments: [historyComment({
          body: 'Same',
          line: null,
          originalLine: 2,
          outdated: true,
        })],
      }),
    ]);

    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
      historyMaxBytes: 0,
    }).performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.previousReviews).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Review history truncated to 0 bytes'));
    const submitted = (githubService.submitReview as jest.Mock).mock.calls[0][1].lineComments;
    expect(submitted.map((comment: { line: number; comment: string }) => `${comment.line}:${comment.comment}`)).toEqual([
      '3:Same',
      '1:Fresh',
    ]);
    warn.mockRestore();
  });

  it('truncates a discussion that would exceed MAX_INPUT_BYTES and still publishes', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 40, lineComments: [],
    });
    const huge = 'c'.repeat(80_000);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      historyReview({
        summary: huge,
        lineComments: [historyComment({ body: huge })],
      }),
    ]);

    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
      maxInputBytes: 50_000,
      historyMaxBytes: 1_500,
    }).performReview(1);

    const previous = (aiProvider as StubAIProvider).lastRequest.previousReviews;
    const historyBytes = Buffer.byteLength(JSON.stringify(previous ?? []), 'utf8');
    expect(huge.length).toBeGreaterThan(50_000);
    expect(historyBytes).toBeLessThanOrEqual(1_500);
    expect(githubService.submitReview).toHaveBeenCalledTimes(1);
  });

  it('defaults the history budget to 12% of MAX_INPUT_BYTES unless an explicit value is set', async () => {
    const warn = jest.spyOn(require('@actions/core'), 'warning').mockImplementation(() => {});
    const huge = historyReview({
      summary: '',
      lineComments: [historyComment({ body: 'c'.repeat(30_000) })],
    });

    const derived = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 40, lineComments: [],
    });
    (derived.githubService.getPreviousReviews as jest.Mock).mockResolvedValue([huge]);
    await new ReviewService(derived.aiProvider, derived.githubService, derived.diffService, {
      maxComments: 0,
      approveReviews: false,
      maxInputBytes: 20_000,
    }).performReview(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Review history truncated to 2400 bytes'));

    warn.mockClear();
    const explicit = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 40, lineComments: [],
    });
    (explicit.githubService.getPreviousReviews as jest.Mock).mockResolvedValue([huge]);
    await new ReviewService(explicit.aiProvider, explicit.githubService, explicit.diffService, {
      maxComments: 0,
      approveReviews: false,
      maxInputBytes: 20_000,
      historyMaxBytes: 40,
    }).performReview(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Review history truncated to 40 bytes'));

    warn.mockClear();
    const clamped = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 40, lineComments: [],
    });
    (clamped.githubService.getPreviousReviews as jest.Mock).mockResolvedValue([huge]);
    await new ReviewService(clamped.aiProvider, clamped.githubService, clamped.diffService, {
      maxComments: 0,
      approveReviews: false,
      maxInputBytes: 20_000,
      historyMaxBytes: 50_000,
    }).performReview(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Review history truncated to 20000 bytes'));
    warn.mockRestore();
  });

  it('does not let repository YAML raise the history budget', async () => {
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum', suggestedAction: 'COMMENT', confidence: 40, lineComments: [],
    });
    (githubService.getFileContent as jest.Mock).mockImplementation(async (path: string) =>
      path === '.github/ai-review.yml' ? 'history_max_bytes: 999999\n' : 'content'
    );
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      historyReview({
        summary: '',
        lineComments: [historyComment({ body: 'y'.repeat(500) })],
      }),
    ]);

    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
      historyMaxBytes: 80,
      configFile: '.github/ai-review.yml',
    }).performReview(1);

    expect((aiProvider as StubAIProvider).lastRequest.previousReviews).toBeUndefined();
  });
});

function historyComment(overrides: Partial<HistoryComment> = {}): HistoryComment {
  return {
    id: 10,
    nodeId: 'N10',
    inReplyToId: null,
    userLogin: 'my-app[bot]',
    userId: 12345,
    userType: 'Bot',
    commitId: 'abc',
    originalCommitId: 'abc',
    path: 'src/a.ts',
    line: 2,
    originalLine: 2,
    side: 'RIGHT',
    createdAt: '2024-01-01T00:00:00Z',
    pullRequestReviewId: 1,
    body: 'earlier',
    outdated: false,
    external: false,
    replies: [],
    ...overrides,
  };
}

function historyReview(overrides: Partial<HistoryReview> = {}): HistoryReview {
  return {
    id: 1,
    commit: 'abc',
    summary: 'previous summary',
    submittedAt: '2024-01-01T00:00:00Z',
    state: null,
    reviewerId: null,
    markerSha: null,
    markerBase: null,
    markerStatus: null,
    lineComments: [],
    ...overrides,
  };
}


describe('ReviewService trust and input boundaries', () => {
  const response: ReviewResponse = { summary: 'ok', suggestedAction: 'APPROVE', confidence: 99, lineComments: [] };

  it('reads policy from base, source context from head and submits the reviewed SHA', async () => {
    const { githubService, diffService, aiProvider } = makeServices({ ...response });
    (githubService.getFileContent as jest.Mock).mockImplementation(async (path: string) => path === '.github/ai-review.yml' ? '' : 'content');
    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0, approveReviews: false, configFile: '.github/ai-review.yml',
      instructionsFile: '.github/ai-review.md', projectContextFile: 'PROJECT.md', contextFiles: ['package.json'],
    });
    await service.performReview(1);
    expect(githubService.getFileContent).toHaveBeenCalledWith('.github/ai-review.yml', 'B', { quiet: true });
    expect(githubService.getFileContent).toHaveBeenCalledWith('.github/ai-review.md', 'B', { quiet: true });
    expect(githubService.getFileContent).toHaveBeenCalledWith('PROJECT.md', 'B', { quiet: true });
    expect(githubService.getFileContent).toHaveBeenCalledWith('package.json', 'H');
    expect(githubService.getFileContent).toHaveBeenCalledWith('src/a.ts', 'H');
    expect((githubService.submitReview as jest.Mock).mock.calls[0][3]).toBe('H');
  });

  it('cannot enable approvals or agentic mode through repository YAML', async () => {
    const { githubService, diffService, aiProvider } = makeServices({ ...response });
    (githubService.getFileContent as jest.Mock).mockImplementation(async (path: string) =>
      path === '.github/ai-review.yml' ? 'approve_reviews: true\nagentic_review: true\napprove_confidence_threshold: 0' : 'content');
    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0, approveReviews: false, agenticReview: false, configFile: '.github/ai-review.yml',
    }).performReview(1);
    expect(aiProvider.lastRequest.context.agenticReview).toBe(false);
    expect((githubService.submitReview as jest.Mock).mock.calls[0][1].suggestedAction).toBe('COMMENT');
  });

  it('cannot lower approval thresholds or raise agentic budgets through YAML', async () => {
    const { githubService, diffService, aiProvider } = makeServices({ ...response, confidence: 90 });
    (githubService.getFileContent as jest.Mock).mockImplementation(async (path: string) =>
      path === '.github/ai-review.yml' ? 'approve_confidence_threshold: 0\nagentic_max_files: 999\nagentic_max_bytes_per_file: 999999\nagentic_max_turns: 999\nagentic_max_total_bytes: 999999' : 'content');
    const limits = { maxFiles: 2, maxBytesPerFile: 100, maxTurns: 3, maxTotalBytes: 150 };
    await new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0, approveReviews: true, approveConfidenceThreshold: 95, agenticReview: true,
      agenticLimits: limits, configFile: '.github/ai-review.yml',
    }).performReview(1);
    expect(aiProvider.lastRequest.context.agenticLimits).toEqual(limits);
    expect((githubService.submitReview as jest.Mock).mock.calls[0][1].suggestedAction).toBe('COMMENT');
  });

  it('rejects oversized UTF-8 input before calling a provider or submitting a review', async () => {
    const { githubService, diffService, aiProvider } = makeServices({ ...response });
    (githubService.getFileContent as jest.Mock).mockResolvedValue('ž'.repeat(5000));
    const review = jest.spyOn(aiProvider, 'review');
    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0, approveReviews: false, maxInputBytes: 8000,
    });
    await expect(service.performReview(1)).rejects.toThrow('MAX_INPUT_BYTES');
    expect(review).not.toHaveBeenCalled();
    expect(githubService.submitReview).not.toHaveBeenCalled();
  });

  it('does not restart an agentic session after a transient provider error', async () => {
    const { githubService, diffService, aiProvider } = makeServices({ ...response });
    const review = jest.spyOn(aiProvider, 'review').mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    const service = new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0, approveReviews: false, agenticReview: true,
    });
    await expect(service.performReview(1)).rejects.toThrow('rate limited');
    expect(review).toHaveBeenCalledTimes(1);
    expect(githubService.submitReview).not.toHaveBeenCalled();
  });
});

describe('incremental review baseline', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const HEAD = 'h'.repeat(40);
  const BASE = 'b'.repeat(40);
  const OLD = 'a'.repeat(40);
  const NEWER = 'c'.repeat(40);
  const response: ReviewResponse = {
    summary: 'sum',
    suggestedAction: 'COMMENT',
    confidence: 50,
    lineComments: [],
  };

  function pull(githubService: GitHubService, base = BASE, head = HEAD) {
    (githubService.getPRDetails as jest.Mock).mockResolvedValue({
      owner: 'o', repo: 'r', number: 1, title: 't', description: 'd', base, head,
    });
  }

  function qualifying(overrides: Partial<HistoryReview> = {}): HistoryReview {
    return historyReview({
      state: 'COMMENTED',
      reviewerId: 'CI/review',
      markerStatus: 'complete',
      markerSha: OLD,
      markerBase: BASE,
      commit: OLD,
      lineComments: [],
      ...overrides,
    });
  }

  function reviewWith(githubService: GitHubService, diffService: DiffService, aiProvider: StubAIProvider) {
    return new ReviewService(aiProvider, githubService, diffService, {
      maxComments: 0,
      approveReviews: false,
    });
  }

  it('reviews only the ahead range intersected with the pull request files', async () => {
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });
    (diffService.getRelevantFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', diff: '@@', validRightLines: new Set([1]) },
      { path: 'upstream.ts', diff: '@@', validRightLines: new Set([4]) },
    ]);
    (githubService.listPullRequestFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', patch: contextPatch(1, 9) },
    ]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(githubService.compareCommits).toHaveBeenCalledTimes(1);
    expect(githubService.compareCommits).toHaveBeenCalledWith(OLD, HEAD);
    expect(diffService.getRelevantFiles).toHaveBeenCalledWith(expect.anything(), OLD);
    expect(aiProvider.lastRequest.files.map((file: { path: string }) => file.path)).toEqual(['src/a.ts']);
    expect(aiProvider.lastRequest.context.isUpdate).toBe(true);
    expect(buildSystemPrompt(aiProvider.lastRequest)).toContain('When reviewing updates');
  });

  it('posts a comment only when the line is in the fetched diff and the pull request patch', async () => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const diff = [
      '@@ -10,4 +10,5 @@',
      `${'10'.padStart(5)}|  context`,
      `${'11'.padStart(5)}| +only in the incremental hunk`,
      `${'12'.padStart(5)}|  also context`,
      `${'-'.padStart(5)}| -removed`,
    ].join('\n');
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 10, comment: 'on both', severity: 'major' },
        { path: 'src/a.ts', line: 11, comment: 'incremental only', severity: 'blocker' },
        { path: 'src/a.ts', line: 12, comment: 'outside the patch', severity: 'minor' },
        { path: 'src/a.ts', line: 50, comment: 'pull request only', severity: 'minor' },
      ],
    });
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });
    (diffService.getRelevantFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', diff, validRightLines: new Set([10, 11, 12]) },
    ]);
    (githubService.listPullRequestFiles as jest.Mock).mockResolvedValue([
      {
        path: 'src/a.ts',
        patch: '@@ -10,1 +10,1 @@\n context\n@@ -50,1 +50,1 @@\n elsewhere',
      },
    ]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    const shown = aiProvider.lastRequest.files[0].diff as string;
    expect(shown).toContain(`${'10'.padStart(5)}|  context`);
    expect(shown).toContain(`${'nc'.padStart(5)}|  only in the incremental hunk`);
    expect(shown).toContain(`${'nc'.padStart(5)}|  also context`);
    expect(shown).toContain(`${'-'.padStart(5)}| -removed`);
    expect(shown).not.toContain(`${'11'.padStart(5)}|`);
    expect(shown).not.toContain('-| +only');

    const submitted = (githubService.submitReview as jest.Mock).mock.calls[0][1];
    expect(submitted.lineComments.map((comment: { line: number }) => comment.line)).toEqual([10]);
    expect(submitted.suggestedAction).toBe('COMMENT');
    expect(submitted.summary).toContain('> - **blocker** `src/a.ts:11` — incremental only');
    expect(submitted.summary).not.toContain('outside the patch');
    expect(submitted.summary).not.toContain('pull request only');
    expect(info).toHaveBeenCalledWith('Dropped 3 comment(s) that are not commentable on the pull request diff');
    expect(diffService.getRelevantFiles).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('drops inline comments when a pull request patch is missing or unparseable', async () => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const numbered = (line: number, text: string) => `${String(line).padStart(5)}| ${text}`;
    const { githubService, diffService, aiProvider } = makeServices({
      summary: 'sum',
      suggestedAction: 'COMMENT',
      confidence: 50,
      lineComments: [
        { path: 'src/a.ts', line: 1, comment: 'kept', severity: 'major' },
        { path: 'src/big.ts', line: 2, comment: 'too big', severity: 'blocker' },
        { path: 'src/odd.ts', line: 3, comment: 'unparsed', severity: 'major' },
      ],
    });
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });
    (diffService.getRelevantFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', diff: numbered(1, ' kept'), validRightLines: new Set([1]) },
      { path: 'src/big.ts', diff: numbered(2, '+too big'), validRightLines: new Set([2]) },
      { path: 'src/odd.ts', diff: numbered(3, ' odd'), validRightLines: new Set([3]) },
    ]);
    (githubService.listPullRequestFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', patch: contextPatch(1, 1) },
      { path: 'src/big.ts', patch: null },
      { path: 'src/odd.ts', patch: 'not a diff' },
    ]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(info).toHaveBeenCalledWith('comment lines unknown, dropped: src/big.ts');
    expect(info).toHaveBeenCalledWith('comment lines unknown, dropped: src/odd.ts');
    const submitted = (githubService.submitReview as jest.Mock).mock.calls[0][1];
    expect(submitted.lineComments.map((comment: { path: string }) => comment.path)).toEqual(['src/a.ts']);
    expect(submitted.summary).toContain('> - **blocker** `src/big.ts:2` — too big');
    expect(submitted.summary).not.toContain('unparsed');
    expect(aiProvider.lastRequest.files.map((file: { path: string }) => file.path)).toEqual([
      'src/a.ts', 'src/big.ts', 'src/odd.ts',
    ]);
    expect(aiProvider.lastRequest.files[1].diff).toContain(`${'nc'.padStart(5)}|  too big`);
    expect(diffService.getRelevantFiles).toHaveBeenCalledTimes(1);
    expect(githubService.listPullRequestFiles).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('keeps a dismissed review as the baseline', async () => {
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ state: 'DISMISSED' }),
    ]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(diffService.getRelevantFiles).toHaveBeenCalledWith(expect.anything(), OLD);
    expect(aiProvider.lastRequest.context.isUpdate).toBe(true);
  });

  it('uses the previous complete sha when the newest marker is degraded', async () => {
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ id: 1, submittedAt: '2024-01-01T00:00:00Z' }),
      qualifying({
        id: 2,
        submittedAt: '2024-06-01T00:00:00Z',
        commit: NEWER,
        markerSha: NEWER,
        markerStatus: 'degraded',
      }),
    ]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(githubService.compareCommits).toHaveBeenCalledWith(OLD, HEAD);
    expect(diffService.getRelevantFiles).toHaveBeenCalledWith(expect.anything(), OLD);
  });

  it.each([
    ['diverged', { ok: true, status: 'diverged' }, 'baseline unreachable, full review: diverged'],
    ['behind', { ok: true, status: 'behind' }, 'baseline unreachable, full review: behind'],
    ['404', { ok: false, statusCode: 404 }, 'baseline unreachable, full review: HTTP 404'],
    ['422', { ok: false, statusCode: 422 }, 'baseline unreachable, full review: HTTP 422'],
  ] as const)('falls back to a full review when compare is %s', async (_label, compared, message) => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ id: 1, submittedAt: '2024-01-01T00:00:00Z' }),
      qualifying({
        id: 2,
        submittedAt: '2024-06-01T00:00:00Z',
        commit: NEWER,
        markerSha: NEWER,
      }),
    ]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue(compared);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(info).toHaveBeenCalledWith(message);
    expect(githubService.listPullRequestFiles).not.toHaveBeenCalled();
    expect((githubService.compareCommits as jest.Mock).mock.calls[0][0]).toBe(NEWER);
    expect((diffService.getRelevantFiles as jest.Mock).mock.calls[0][1]).toBeUndefined();
    expect(aiProvider.lastRequest.context.isUpdate).toBe(false);
    expect(githubService.submitReview).toHaveBeenCalled();
    info.mockRestore();
  });

  it('does not walk to an older sha after a diverged compare', async () => {
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ id: 1, submittedAt: '2024-01-01T00:00:00Z' }),
      qualifying({
        id: 2,
        submittedAt: '2024-06-01T00:00:00Z',
        commit: NEWER,
        markerSha: NEWER,
      }),
    ]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'diverged' });

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    const ranges = (diffService.getRelevantFiles as jest.Mock).mock.calls.map(call => call[1]);
    expect(ranges).not.toContain(OLD);
    expect(ranges).not.toContain(NEWER);
  });

  it('skips the model when the qualifying sha is already the head', async () => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService, BASE, OLD);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    const review = jest.spyOn(aiProvider, 'review');

    await expect(reviewWith(githubService, diffService, aiProvider).performReview(1)).resolves.toBeNull();

    expect(info).toHaveBeenCalledWith('baseline identical to head, skipping review');
    expect(review).not.toHaveBeenCalled();
    expect(githubService.submitReview).not.toHaveBeenCalled();
    expect(githubService.compareCommits).not.toHaveBeenCalled();
    expect(diffService.getRelevantFiles).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('reviews the whole pull request when base.sha changed, before the identical-head skip', async () => {
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService, 'f'.repeat(40), OLD);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(info).toHaveBeenCalledWith('baseline base changed, full review');
    expect((githubService.compareCommits as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(0);
    expect((diffService.getRelevantFiles as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (githubService.compareCommits as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((diffService.getRelevantFiles as jest.Mock).mock.calls[0][1]).toBeUndefined();
    expect(aiProvider.lastRequest.context.isUpdate).toBe(false);
    expect(githubService.submitReview).toHaveBeenCalled();
    info.mockRestore();
  });

  it('does not advance the baseline for another reviewer or a sha/commit_id mismatch', async () => {
    const debug = jest.spyOn(require('@actions/core'), 'debug').mockImplementation(() => {});
    const info = jest.spyOn(require('@actions/core'), 'info').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ id: 1, reviewerId: 'Other/job', commit: NEWER, markerSha: NEWER }),
      qualifying({ id: 2, commit: NEWER, markerSha: OLD }),
    ]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    expect(debug).toHaveBeenCalledWith('marker sha differs from commit_id review=2');
    expect(info).toHaveBeenCalledWith('no previous review, full review');
    expect((diffService.getRelevantFiles as jest.Mock).mock.calls[0][1]).toBeUndefined();
    expect(aiProvider.lastRequest.context.isUpdate).toBe(false);
    debug.mockRestore();
    info.mockRestore();
  });

  it('fails the run when compare returns 500 or the network fails', async () => {
    const unavailable = Object.assign(new Error('unavailable'), { status: 500 });
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (githubService.compareCommits as jest.Mock).mockRejectedValue(unavailable);
    const review = jest.spyOn(aiProvider, 'review');

    await expect(reviewWith(githubService, diffService, aiProvider).performReview(1)).rejects.toBe(unavailable);
    expect(review).not.toHaveBeenCalled();

    const network = makeServices(response);
    pull(network.githubService);
    (network.githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (network.githubService.compareCommits as jest.Mock).mockRejectedValue(new Error('socket hang up'));
    await expect(reviewWith(network.githubService, network.diffService, network.aiProvider).performReview(1))
      .rejects.toThrow('socket hang up');
  });

  it('fails the run when the diff fetch fails after an ahead compare', async () => {
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([qualifying()]);
    (githubService.compareCommits as jest.Mock).mockResolvedValue({ ok: true, status: 'ahead' });
    (diffService.getRelevantFiles as jest.Mock).mockRejectedValue(new Error('diff failed'));
    const review = jest.spyOn(aiProvider, 'review');

    await expect(reviewWith(githubService, diffService, aiProvider).performReview(1)).rejects.toThrow('diff failed');
    expect(review).not.toHaveBeenCalled();
    expect(githubService.submitReview).not.toHaveBeenCalled();
  });

  it('marks a diverged finding outdated without changing the dedup key', async () => {
    const findingSha = 'd'.repeat(40);
    const { githubService, diffService, aiProvider } = makeServices({
      ...response,
      lineComments: [
        { path: 'src/a.ts', line: 9, comment: 'Keep me', severity: 'major' },
        { path: 'src/a.ts', line: 1, comment: 'Fresh', severity: 'major' },
      ],
    });
    pull(githubService);
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({
        lineComments: [historyComment({
          commitId: findingSha,
          originalCommitId: findingSha,
          line: 9,
          originalLine: 3,
          body: 'Keep me',
          outdated: false,
        })],
      }),
    ]);
    (githubService.compareCommits as jest.Mock).mockImplementation(async (sha: string) => (
      sha === findingSha ? { ok: true, status: 'diverged' } : { ok: true, status: 'ahead' }
    ));
    (diffService.getRelevantFiles as jest.Mock).mockResolvedValue([
      { path: 'src/a.ts', diff: '@@', validRightLines: new Set([1, 9]) },
    ]);

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    const rendered = JSON.stringify(aiProvider.lastRequest.previousReviews);
    expect(rendered).toContain('"line":9');
    expect(rendered).toContain('"outdated":true');
    const submitted = (githubService.submitReview as jest.Mock).mock.calls[0][1].lineComments;
    expect(submitted.map((comment: { comment: string }) => comment.comment)).toEqual(['Fresh']);
    expect(githubService.compareCommits).toHaveBeenCalledTimes(2);
  });

  it('stops comparing finding SHAs after 30 and compares at most 4 at a time', async () => {
    const warn = jest.spyOn(require('@actions/core'), 'warning').mockImplementation(() => {});
    const { githubService, diffService, aiProvider } = makeServices(response);
    pull(githubService);
    const findings = Array.from({ length: 31 }, (_, index) => {
      const commitId = (index + 1).toString(16).padStart(40, '0');
      return historyComment({
        id: index + 1,
        commitId,
        originalCommitId: commitId,
        line: index + 1,
        body: `finding ${index + 1}`,
        outdated: false,
      });
    });
    (githubService.getPreviousReviews as jest.Mock).mockResolvedValue([
      qualifying({ lineComments: findings }),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    (githubService.compareCommits as jest.Mock).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 'diverged' };
    });

    await reviewWith(githubService, diffService, aiProvider).performReview(1);

    const compared = (githubService.compareCommits as jest.Mock).mock.calls.map(call => call[0] as string);
    expect(compared).toHaveLength(30);
    expect(compared[0]).toBe(OLD);
    expect(compared).not.toContain(findings[29].commitId);
    expect(compared).not.toContain(findings[30].commitId);
    expect(maxInFlight).toBe(4);
    expect(warn).toHaveBeenCalledWith('history compare cap, 30 SHAs');
    warn.mockRestore();
  });
});
