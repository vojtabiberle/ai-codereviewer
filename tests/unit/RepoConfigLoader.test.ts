import { loadRepoConfig } from '../../src/services/RepoConfigLoader';
import { GitHubService } from '../../src/services/GitHubService';

function fakeGithub(content: string): GitHubService {
  return {
    getFileContent: jest.fn().mockResolvedValue(content),
  } as unknown as GitHubService;
}

describe('loadRepoConfig', () => {
  it('returns empty when path is undefined', async () => {
    const cfg = await loadRepoConfig(fakeGithub(''), undefined, 'h');
    expect(cfg).toEqual({});
  });

  it('returns empty when file is missing (empty string content)', async () => {
    const cfg = await loadRepoConfig(fakeGithub(''), '.github/ai-review.yml', 'h');
    expect(cfg).toEqual({});
  });

  it('parses recognized keys and ignores unknown ones', async () => {
    const yaml = `
min_comment_severity: major
approve_reviews: false
approve_confidence_threshold: 90
max_comments: 5
exclude_patterns: "vendor/**,*.gen.ts"
instructions_file: ".github/rules.md"
project_context: "Backend service"
project_context_file: "ARCH.md"
unknown_key: "ignored"
`.trim();
    const cfg = await loadRepoConfig(fakeGithub(yaml), '.github/ai-review.yml', 'h');
    expect(cfg).toEqual({
      min_comment_severity: 'major',
      approve_reviews: false,
      approve_confidence_threshold: 90,
      max_comments: 5,
      exclude_patterns: 'vendor/**,*.gen.ts',
      instructions_file: '.github/rules.md',
      project_context: 'Backend service',
      project_context_file: 'ARCH.md',
    });
  });

  it('ignores invalid severity values with a warning, returns no override', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('min_comment_severity: criticla'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg.min_comment_severity).toBeUndefined();
  });

  it('rejects malformed YAML gracefully', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('min_comment_severity: : :'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg).toEqual({});
  });

  it('rejects YAML that is not an object (e.g. array, string)', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('- foo\n- bar'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg).toEqual({});
  });

  it('rejects negative max_comments', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('max_comments: -3'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg.max_comments).toBeUndefined();
  });

  it('parses context_files as a YAML list', async () => {
    const yaml = `
context_files:
  - package.json
  - tsconfig.json
`.trim();
    const cfg = await loadRepoConfig(fakeGithub(yaml), '.github/ai-review.yml', 'h');
    expect(cfg.context_files).toEqual(['package.json', 'tsconfig.json']);
  });

  it('parses context_files as a comma-separated string', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('context_files: "package.json, tsconfig.json"'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg.context_files).toEqual(['package.json', 'tsconfig.json']);
  });

  it('parses context_files: [] as an explicit opt-out (empty array)', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('context_files: []'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg.context_files).toEqual([]);
  });

  it('ignores context_files of unsupported type', async () => {
    const cfg = await loadRepoConfig(
      fakeGithub('context_files: 42'),
      '.github/ai-review.yml',
      'h'
    );
    expect(cfg.context_files).toBeUndefined();
  });

  it('parses positive integer agentic limit overrides', async () => {
    const yaml = `
agentic_max_files: 30
agentic_max_bytes_per_file: 300000
agentic_max_turns: 12
`.trim();
    const cfg = await loadRepoConfig(fakeGithub(yaml), '.github/ai-review.yml', 'h');
    expect(cfg.agentic_max_files).toBe(30);
    expect(cfg.agentic_max_bytes_per_file).toBe(300000);
    expect(cfg.agentic_max_turns).toBe(12);
  });

  it('rejects non-positive or non-integer agentic limits', async () => {
    const yaml = `
agentic_max_files: 0
agentic_max_bytes_per_file: -1
agentic_max_turns: 2.5
`.trim();
    const cfg = await loadRepoConfig(fakeGithub(yaml), '.github/ai-review.yml', 'h');
    expect(cfg.agentic_max_files).toBeUndefined();
    expect(cfg.agentic_max_bytes_per_file).toBeUndefined();
    expect(cfg.agentic_max_turns).toBeUndefined();
  });
});


it.each(['approve_confidence_threshold: -1', 'approve_confidence_threshold: 101', 'max_comments: 1.5',
  'agentic_max_total_bytes: -1', 'agentic_max_total_bytes: 1.5'])('ignores invalid policy numeric input: %s', async yaml => {
  expect(await loadRepoConfig(fakeGithub(yaml), 'config.yml', 'BASE')).toEqual({});
});

it('loads aggregate read limits from the supplied trusted ref', async () => {
  const github = fakeGithub('agentic_max_total_bytes: 12345');
  expect(await loadRepoConfig(github, 'config.yml', 'BASE')).toEqual({ agentic_max_total_bytes: 12345 });
  expect(github.getFileContent).toHaveBeenCalledWith('config.yml', 'BASE', { quiet: true });
});
