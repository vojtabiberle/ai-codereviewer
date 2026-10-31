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

function makeServices(aiResponse: ReviewResponse) {
  const githubService = {
    getPRDetails: jest.fn().mockResolvedValue({
      owner: 'o', repo: 'r', number: 1,
      title: 't', description: 'd', base: 'B', head: 'H'
    }),
    getLastReviewedCommit: jest.fn().mockResolvedValue(null),
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
    expect(submit.mock.calls[0][1].suggestedAction).toBe('COMMENT');
    expect(submit.mock.calls[0][1].lineComments).toHaveLength(0);
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

  it('loads history when the baseline heuristic is null and does not switch to the update prompt', async () => {
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

    expect(githubService.getLastReviewedCommit).toHaveBeenCalled();
    expect(githubService.getPreviousReviews).toHaveBeenCalledWith(1);
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
    reviewerId: null,
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
