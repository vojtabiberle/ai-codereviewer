import {
  FALLBACK_REVIEWER_ID,
  formatReviewMarker,
  parseReviewMarker,
  resolveReviewerId,
  stripReviewMarkers,
  withReviewMarker,
} from '../../src/services/reviewMarker';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function marker(overrides: Partial<{ reviewer: string; sha: string; base: string; status: 'complete' | 'degraded'; version: number }> = {}) {
  return formatReviewMarker({
    reviewer: 'CI/review',
    sha: SHA,
    base: BASE,
    status: 'complete',
    ...overrides,
  });
}

describe('resolveReviewerId', () => {
  const env = { GITHUB_WORKFLOW: 'Code Review', GITHUB_JOB: 'review' } as NodeJS.ProcessEnv;

  it('uses an explicit id over the workflow env', () => {
    expect(resolveReviewerId(' custom/id ', env)).toBe('custom/id');
  });

  it('defaults to GITHUB_WORKFLOW/GITHUB_JOB', () => {
    expect(resolveReviewerId('  ', env)).toBe('Code Review/review');
    expect(resolveReviewerId(undefined, env)).toBe('Code Review/review');
  });

  it('uses a stable fallback when the workflow env is incomplete', () => {
    expect(resolveReviewerId(undefined, { GITHUB_WORKFLOW: 'CI' } as NodeJS.ProcessEnv)).toBe(FALLBACK_REVIEWER_ID);
    expect(resolveReviewerId(undefined, {} as NodeJS.ProcessEnv)).toBe(FALLBACK_REVIEWER_ID);
  });
});

describe('formatReviewMarker', () => {
  it('writes a v=1 complete marker with safe tokens unencoded', () => {
    expect(marker()).toBe(
      `<!-- ai-codereviewer:review v=1 reviewer=CI/review sha=${SHA} base=${BASE} status=complete -->`
    );
  });

  it('writes status=degraded and keeps a single hyphen', () => {
    const text = marker({ reviewer: 'my-workflow/job', status: 'degraded' });
    expect(text).toContain('reviewer=my-workflow/job');
    expect(text).toContain('status=degraded');
  });

  it('percent-encodes spaces and double hyphens', () => {
    const spaced = marker({ reviewer: 'Code Review/job' });
    expect(spaced).toContain('reviewer=Code%20Review%2Fjob');
    expect(parseReviewMarker(spaced)?.reviewer).toBe('Code Review/job');

    const dashed = marker({ reviewer: 'foo--bar' });
    expect(dashed).toContain('reviewer=foo%2D%2Dbar');
    expect(dashed).not.toContain('foo--bar');
    expect(parseReviewMarker(dashed)?.reviewer).toBe('foo--bar');
  });
});

describe('parseReviewMarker', () => {
  it('returns null for unmarked, empty, and unrelated comments', () => {
    expect(parseReviewMarker(null)).toBeNull();
    expect(parseReviewMarker(undefined)).toBeNull();
    expect(parseReviewMarker('')).toBeNull();
    expect(parseReviewMarker('just a review')).toBeNull();
    expect(parseReviewMarker('<!-- not our marker -->')).toBeNull();
    expect(parseReviewMarker('<!-- ai-codereviewer:reviewer v=1 -->')).toBeNull();
  });

  it('parses complete and degraded markers from surrounding summary text', () => {
    const body = `Summary line\n\n${marker({ status: 'degraded' })}\n`;
    expect(parseReviewMarker(body)).toEqual({
      version: 1,
      reviewer: 'CI/review',
      sha: SHA,
      base: BASE,
      status: 'degraded',
    });
  });

  it('accepts a newer version and ignores unknown attributes', () => {
    const body = `<!-- ai-codereviewer:review v=2 reviewer=CI/review sha=${SHA} base=${BASE} status=partial extra=1 -->`;
    expect(parseReviewMarker(body)).toEqual({
      version: 2,
      reviewer: 'CI/review',
      sha: SHA,
      base: BASE,
      status: 'partial',
    });
  });

  it('accepts quoted and percent-encoded reviewer values', () => {
    const quoted = `<!-- ai-codereviewer:review v=1 reviewer="Code Review/job" sha=${SHA} base=${BASE} status=complete -->`;
    expect(parseReviewMarker(quoted)?.reviewer).toBe('Code Review/job');

    const encoded = `<!-- ai-codereviewer:review v=1 reviewer=Caf%C3%A9%2Fjob sha=${SHA} base=${BASE} status=complete -->`;
    expect(parseReviewMarker(encoded)?.reviewer).toBe('Café/job');
  });

  it('ignores malformed markers and unmarked reviews, and keeps the last valid marker', () => {
    const short = 'abc1234';
    const body = [
      'human review with no marker',
      `<!-- ai-codereviewer:review v=1 reviewer=only -->`,
      `<!-- ai-codereviewer:review v=0 reviewer=CI/review sha=${SHA} base=${BASE} status=complete -->`,
      `<!-- ai-codereviewer:review v=1 reviewer=first sha=${short} base=${'d'.repeat(7)} status=complete -->`,
      'still not a marker',
      `<!-- ai-codereviewer:review v=1 reviewer=second sha=${SHA} base=${BASE} status=degraded -->`,
    ].join('\n');

    expect(parseReviewMarker(body)).toMatchObject({ reviewer: 'second', status: 'degraded' });
  });

  it('rejects a marker that is missing a required field or has a non-sha', () => {
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review v=1 reviewer=CI/review sha=${SHA} base=${BASE} -->`
    )).toBeNull();
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review v=1 reviewer=CI/review sha=not-a-sha base=${BASE} status=complete -->`
    )).toBeNull();
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review nope reviewer=CI/review sha=${SHA} base=${BASE} status=complete -->`
    )).toBeNull();
  });

  it('keeps a reviewer when percent-decoding fails and rejects a broken reviewer', () => {
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review v=1 reviewer=100% sha=${SHA} base=${BASE} status=complete -->`
    )?.reviewer).toBe('100%');
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review v=1 reviewer="say \\"hi\\"" sha=${SHA} base=${BASE} status=complete -->`
    )?.reviewer).toBe('say "hi"');
    expect(parseReviewMarker(
      `<!-- ai-codereviewer:review v=1 reviewer="line\nbreak" sha=${SHA} base=${BASE} status=complete -->`
    )).toBeNull();
  });

  it('tolerates extra whitespace inside the comment', () => {
    const body = `<!--   ai-codereviewer:review   v=1   reviewer=CI/review   sha=${SHA}   base=${BASE}   status=complete   -->`;
    expect(parseReviewMarker(body)?.version).toBe(1);
  });
});

describe('withReviewMarker', () => {
  it('appends one marker and strips any earlier copy', () => {
    const earlier = marker({ reviewer: 'evil' });
    const body = withReviewMarker(`hello\n\n${earlier}`, {
      reviewer: 'CI/review',
      sha: SHA,
      base: BASE,
      status: 'complete',
    });
    expect(body.startsWith('hello')).toBe(true);
    expect(body.match(/ai-codereviewer:review/g)).toHaveLength(1);
    expect(parseReviewMarker(body)?.reviewer).toBe('CI/review');
    expect(stripReviewMarkers(body).trim()).toBe('hello');
  });

  it('publishes a marker alone when the summary is empty', () => {
    const body = withReviewMarker('  ', {
      reviewer: 'CI/review',
      sha: SHA,
      base: BASE,
      status: 'degraded',
    });
    expect(parseReviewMarker(body)?.status).toBe('degraded');
    expect(body.startsWith('<!--')).toBe(true);
  });
});
