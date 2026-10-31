import { buildSystemPrompt } from '../../src/prompts';
import { ReviewRequest } from '../../src/providers/AIProvider';

function makeRequest(overrides: Partial<ReviewRequest['context']> = {}): ReviewRequest {
  return {
    files: [],
    pullRequest: { title: 't', description: 'd', base: 'b', head: 'h' },
    context: {
      repository: 'o/r',
      owner: 'o',
      ...overrides,
    },
  };
}

describe('buildSystemPrompt', () => {
  it('returns just the base prompt when nothing else is set', () => {
    const prompt = buildSystemPrompt(makeRequest());
    expect(prompt).toContain('You are an expert code reviewer');
    expect(prompt).not.toContain('When reviewing updates');
    expect(prompt).not.toContain('Repository-specific reviewer instructions');
  });

  it('explains a null previous-comment line when history is present', () => {
    const prompt = buildSystemPrompt({
      ...makeRequest(),
      previousReviews: [{ lineComments: [{ path: 'a.ts', line: null, outdated: true, comment: 'old' }] }],
    });
    expect(prompt).toContain('outdated');
    expect(prompt).toContain('still a number');
    expect(prompt).toContain('line 0');
    expect(prompt).not.toContain('When reviewing updates');
  });

  it('appends update guidance when isUpdate is true', () => {
    const prompt = buildSystemPrompt(makeRequest({ isUpdate: true }));
    expect(prompt).toContain('When reviewing updates');
  });

  it('appends repo-specific instructions block last so it can override', () => {
    const prompt = buildSystemPrompt(makeRequest({
      repoInstructions: 'Skip nits about import ordering.'
    }));
    const baseIdx = prompt.indexOf('You are an expert code reviewer');
    const repoIdx = prompt.indexOf('Repository-specific reviewer instructions');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(baseIdx);
    expect(prompt).toContain('Skip nits about import ordering.');
  });

  it('skips the repo block when repoInstructions is just whitespace', () => {
    const prompt = buildSystemPrompt(makeRequest({ repoInstructions: '   \n\n  ' }));
    expect(prompt).not.toContain('Repository-specific reviewer instructions');
  });

  it('embeds the default agentic limits and a submit_review-before-cap directive', () => {
    const prompt = buildSystemPrompt(makeRequest({ agenticReview: true }));
    expect(prompt).toContain('Agentic mode');
    // Defaults from DEFAULT_AGENTIC_LIMITS
    expect(prompt).toContain('At most 20 distinct');
    expect(prompt).toContain('at most 20000 bytes');
    expect(prompt).toContain('after 10 model turns');
    expect(prompt).toMatch(/MUST call .*submit_review/);
    expect(prompt).toMatch(/before any of those limits is hit/);
  });

  it('interpolates custom agenticLimits from the request', () => {
    const prompt = buildSystemPrompt(makeRequest({
      agenticReview: true,
      agenticLimits: { maxFiles: 5, maxBytesPerFile: 1234, maxTurns: 3, maxTotalBytes: 5000 },
    }));
    expect(prompt).toContain('At most 5 distinct');
    expect(prompt).toContain('at most 1234 bytes');
    expect(prompt).toContain('after 3 model turns');
  });

  it('omits the agentic addendum entirely when agenticReview is false', () => {
    const prompt = buildSystemPrompt(makeRequest({ agenticReview: false }));
    expect(prompt).not.toContain('Agentic mode');
    expect(prompt).not.toContain('submit_review');
  });
});
