import { executeReadFile, makeAgenticEnv } from '../../src/services/AgenticToolRunner';
import { GitHubService } from '../../src/services/GitHubService';

function fakeGithub(map: Record<string, string>): GitHubService {
  return {
    getFileContent: jest.fn(async (p: string) => map[p] ?? ''),
  } as unknown as GitHubService;
}

describe('executeReadFile', () => {
  it('reads a regular file and returns line-numbered output', async () => {
    const env = makeAgenticEnv({
      github: fakeGithub({ 'src/a.ts': 'foo\nbar\nbaz' }),
      ref: 'h',
      excludePatterns: [],
    });
    const out = await executeReadFile(env, 'src/a.ts', 'inspect');
    expect(out).toBe('1: foo\n2: bar\n3: baz');
    expect(env.filesRead.get('src/a.ts')).toBe(out.length);
  });

  it('rejects parent-traversal paths', async () => {
    const env = makeAgenticEnv({ github: fakeGithub({}), ref: 'h', excludePatterns: [] });
    const out = await executeReadFile(env, '../etc/passwd', 'attack');
    expect(out).toMatch(/invalid path/);
  });

  it('rejects absolute paths', async () => {
    const env = makeAgenticEnv({ github: fakeGithub({}), ref: 'h', excludePatterns: [] });
    const out = await executeReadFile(env, '/etc/passwd', 'attack');
    expect(out).toMatch(/invalid path/);
  });

  it('rejects empty path', async () => {
    const env = makeAgenticEnv({ github: fakeGithub({}), ref: 'h', excludePatterns: [] });
    const out = await executeReadFile(env, '', 'oops');
    expect(out).toMatch(/non-empty/);
  });

  it('refuses to re-read the same whole file', async () => {
    const env = makeAgenticEnv({
      github: fakeGithub({ 'a.ts': 'x' }),
      ref: 'h',
      excludePatterns: [],
    });
    await executeReadFile(env, 'a.ts', 'r1');
    const out = await executeReadFile(env, 'a.ts', 'r2');
    expect(out).toMatch(/already read/);
  });

  it('honors EXCLUDE_PATTERNS', async () => {
    const env = makeAgenticEnv({
      github: fakeGithub({ 'node_modules/foo/index.js': 'x' }),
      ref: 'h',
      excludePatterns: ['node_modules/**'],
    });
    const out = await executeReadFile(env, 'node_modules/foo/index.js', 'why');
    expect(out).toMatch(/EXCLUDE_PATTERNS/);
  });

  it('returns "not found" when file is empty/missing', async () => {
    const env = makeAgenticEnv({ github: fakeGithub({}), ref: 'h', excludePatterns: [] });
    const out = await executeReadFile(env, 'missing.ts', 'why');
    expect(out).toMatch(/not found/);
  });

  it('truncates very large output to maxBytesPerFile', async () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i + 1} of payload here`).join('\n');
    const env = makeAgenticEnv({
      github: fakeGithub({ 'big.ts': big }),
      ref: 'h',
      excludePatterns: [],
      limits: { maxBytesPerFile: 100 },
    });
    const out = await executeReadFile(env, 'big.ts', 'why');
    expect(out).toMatch(/^\[truncated\]/);
    expect(env.filesRead.get('big.ts')).toBe(100);
  });

  it('refuses reads after the per-session budget is exhausted', async () => {
    const env = makeAgenticEnv({
      github: fakeGithub({ 'a.ts': 'x', 'b.ts': 'y', 'c.ts': 'z' }),
      ref: 'h',
      excludePatterns: [],
      limits: { maxFiles: 2 },
    });
    await executeReadFile(env, 'a.ts', 'r');
    await executeReadFile(env, 'b.ts', 'r');
    const out = await executeReadFile(env, 'c.ts', 'r');
    expect(out).toMatch(/budget exhausted/);
  });

  describe('line ranges', () => {
    const sample = 'one\ntwo\nthree\nfour\nfive\nsix';

    it('returns just the requested line range, line-numbered', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      const out = await executeReadFile(env, 'a.ts', 'r', { startLine: 2, endLine: 4 });
      expect(out).toBe('2: two\n3: three\n4: four');
    });

    it('start_line alone reads from that line to end', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      const out = await executeReadFile(env, 'a.ts', 'r', { startLine: 5 });
      expect(out).toBe('5: five\n6: six');
    });

    it('end_line alone reads from line 1 to that line', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      const out = await executeReadFile(env, 'a.ts', 'r', { endLine: 2 });
      expect(out).toBe('1: one\n2: two');
    });

    it('end_line larger than file length is clamped, not an error', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': 'one\ntwo' }),
        ref: 'h',
        excludePatterns: [],
      });
      const out = await executeReadFile(env, 'a.ts', 'r', { startLine: 1, endLine: 999 });
      expect(out).toBe('1: one\n2: two');
    });

    it('rejects end_line < start_line', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      const out = await executeReadFile(env, 'a.ts', 'r', { startLine: 5, endLine: 2 });
      expect(out).toMatch(/end_line.*must be >=.*start_line/);
    });

    it('rejects start_line < 1', async () => {
      const env = makeAgenticEnv({ github: fakeGithub({ 'a.ts': sample }), ref: 'h', excludePatterns: [] });
      const out = await executeReadFile(env, 'a.ts', 'r', { startLine: 0 });
      expect(out).toMatch(/start_line must be an integer >= 1/);
    });

    it('dedup is per (path, range) — different ranges of the same file are allowed', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      const a = await executeReadFile(env, 'a.ts', 'r', { startLine: 1, endLine: 3 });
      const b = await executeReadFile(env, 'a.ts', 'r', { startLine: 4, endLine: 6 });
      expect(a).toMatch(/^1: one/);
      expect(b).toMatch(/^4: four/);
      expect(env.filesRead.size).toBe(2);
    });

    it('refuses re-reading the SAME range', async () => {
      const env = makeAgenticEnv({
        github: fakeGithub({ 'a.ts': sample }),
        ref: 'h',
        excludePatterns: [],
      });
      await executeReadFile(env, 'a.ts', 'r', { startLine: 1, endLine: 3 });
      const second = await executeReadFile(env, 'a.ts', 'r', { startLine: 1, endLine: 3 });
      expect(second).toMatch(/already read/);
    });
  });
});


describe('agentic shared budgets', () => {
  it('reserves read slots before parallel fetches, including duplicate calls', async () => {
    const github = fakeGithub({ 'a.ts': 'x', 'b.ts': 'y', 'c.ts': 'z' });
    const env = makeAgenticEnv({ github, ref: 'H', excludePatterns: [], limits: { maxFiles: 2 } });
    const results = await Promise.all(['a.ts', 'a.ts', 'b.ts', 'c.ts'].map(path => executeReadFile(env, path, 'r')));
    expect(results[1]).toContain('already read');
    expect(results[3]).toContain('budget exhausted');
    expect(github.getFileContent).toHaveBeenCalledTimes(2);
  });

  it('caps aggregate UTF-8 output even for parallel non-ASCII reads', async () => {
    const env = makeAgenticEnv({ github: fakeGithub({ 'a.ts': 'ž'.repeat(100), 'b.ts': '🙂'.repeat(100) }),
      ref: 'H', excludePatterns: [], limits: { maxTotalBytes: 100, maxBytesPerFile: 60 } });
    const results = await Promise.all(['a.ts', 'b.ts'].map(path => executeReadFile(env, path, 'r')));
    const sizes = results.map(out => Buffer.byteLength(out, 'utf8'));
    expect(sizes.every(size => size <= 60)).toBe(true);
    expect(sizes.reduce((a, b) => a + b)).toBeLessThanOrEqual(100);
    expect(results.join('')).not.toContain('�');
    expect(Array.from(env.filesRead.values())).toEqual(sizes);
  });

  it('stops fetching once the aggregate budget is exhausted', async () => {
    const github = fakeGithub({ 'a.ts': 'x'.repeat(100), 'b.ts': 'y' });
    const env = makeAgenticEnv({ github, ref: 'H', excludePatterns: [], limits: { maxTotalBytes: 30 } });
    await executeReadFile(env, 'a.ts', 'r');
    expect(await executeReadFile(env, 'b.ts', 'r')).toContain('budget exhausted');
    expect(github.getFileContent).toHaveBeenCalledTimes(1);
  });

  it('returns fetch failures as tool errors while consuming the reserved slot', async () => {
    const github = fakeGithub({});
    (github.getFileContent as jest.Mock).mockRejectedValueOnce(new Error('network'));
    const env = makeAgenticEnv({ github, ref: 'H', excludePatterns: [], limits: { maxFiles: 1 } });
    expect(await executeReadFile(env, 'a.ts', 'r')).toContain('could not read');
    expect(await executeReadFile(env, 'b.ts', 'r')).toContain('budget exhausted');
  });
});
