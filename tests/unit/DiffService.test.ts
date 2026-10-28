import { DiffService } from '../../src/services/DiffService';
import { PRDetails } from '../../src/services/GitHubService';
import * as core from '@actions/core';

// Mock fetch
global.fetch = jest.fn();

// Mock core.getInput
jest.spyOn(core, 'getInput').mockImplementation((name: string) => {
  if (name === 'EXCLUDE_PATTERNS') return '**/*.md,**/*.json';
  return '';
});

describe('DiffService', () => {
  const mockPRDetails: PRDetails = {
    number: 123,
    owner: 'test-owner',
    repo: 'test-repo',
    base: 'main',
    head: 'feature',
    title: 'Test PR',
    description: 'Test PR description',
  };

  const mockDiffResponse = `diff --git a/src/test.ts b/src/test.ts
index abc..def 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 console.log("test");
+console.log("new line");
 console.log("end");`;

  // For deleted files, parse-diff sets `to` to "/dev/null" and keeps the real
  // path in `from`. This diff deletes a large fixture that matches
  // "fixtures/**" and a source file that does not match any pattern.
  const mockDeletedFilesDiffResponse = `diff --git a/fixtures/large-fixture.json b/fixtures/large-fixture.json
deleted file mode 100644
index abc..000 100644
--- a/fixtures/large-fixture.json
+++ /dev/null
@@ -1,3 +0,0 @@
-{
-  "big": "fixture"
-}
diff --git a/src/kept.ts b/src/kept.ts
deleted file mode 100644
index def..000 100644
--- a/src/kept.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-console.log("kept");
-console.log("also kept");`;

  // Rename OUT of an excluded dir: parse-diff sets `from` to the old (excluded)
  // path and `to` to the new (included) path. The file now lives in src/ and
  // must still be reviewed — the destination path decides inclusion.
  const mockRenameOutOfExcludedDiffResponse = `diff --git a/vendor/lib.ts b/src/lib.ts
similarity index 80%
rename from vendor/lib.ts
rename to src/lib.ts
index abc..def 100644
--- a/vendor/lib.ts
+++ b/src/lib.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;`;

  // Rename INTO an excluded dir: the destination path matches the pattern, so
  // the file must be excluded.
  const mockRenameIntoExcludedDiffResponse = `diff --git a/src/lib.ts b/vendor/lib.ts
similarity index 80%
rename from src/lib.ts
rename to vendor/lib.ts
index abc..def 100644
--- a/src/lib.ts
+++ b/vendor/lib.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;`;

  beforeEach(() => {
    // Reset mocks
    (global.fetch as jest.Mock).mockReset();
    // Setup default mock response
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockDiffResponse
    });
  });

  it('fetches first-review diffs using pinned base and head commits', async () => {
    await new DiffService('token', '').getRelevantFiles(mockPRDetails);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-owner/test-repo/compare/main...feature', expect.anything());
  });

  it('pins update comparisons to the previously reviewed commit and current head', async () => {
    await new DiffService('token', '').getRelevantFiles(mockPRDetails, 'old-sha');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-owner/test-repo/compare/old-sha...feature', expect.anything());
  });

  it('should filter out excluded files', async () => {
    const service = new DiffService('mock-github-token', '**/*.md,**/*.json');
    const files = await service.getRelevantFiles(mockPRDetails);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => !f.path.endsWith('.md'))).toBeTruthy();
  });

  it('should format diff with right-side line numbers per line', async () => {
    const service = new DiffService('mock-github-token', '**/*.md,**/*.json');
    const files = await service.getRelevantFiles(mockPRDetails);
    expect(files[0].diff).toContain('@@ ');
    // Added line "new line" is at right-side line 2; format is "<num>| <originalDiffLine>".
    expect(files[0].diff).toMatch(/^\s+2\|\s\+console\.log\("new line"\);$/m);
    // First context line is at right-side line 1.
    expect(files[0].diff).toMatch(/^\s+1\|\s+console\.log\("test"\);$/m);
  });

  it('should expose RIGHT-side commentable line numbers including context', async () => {
    const service = new DiffService('mock-github-token', '**/*.md,**/*.json');
    const files = await service.getRelevantFiles(mockPRDetails);
    const lines = files[0].validRightLines;
    // @@ -1,3 +1,4 @@: context line 1 (right=1), added line 2 (right=2), context line 3 (right=3).
    expect(lines.has(1)).toBe(true); // context above
    expect(lines.has(2)).toBe(true); // added
    expect(lines.has(3)).toBe(true); // context below
    expect(lines.has(99)).toBe(false);
  });

  it('should exclude a deleted file whose real (pre-deletion) path matches an exclude pattern', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockDeletedFilesDiffResponse
    });

    // Deleted files have `to === "/dev/null"`; the real path lives in `from`.
    // Only the fixture deletion should match "fixtures/**" and be dropped.
    const service = new DiffService('mock-github-token', 'fixtures/**');
    const files = await service.getRelevantFiles(mockPRDetails);

    expect(files.length).toBe(1);
    expect(files.some(f => f.diff.includes('"big": "fixture"'))).toBe(false);
  });

  it('should keep a deleted file whose real path does not match any exclude pattern', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockDeletedFilesDiffResponse
    });

    const service = new DiffService('mock-github-token', 'fixtures/**');
    const files = await service.getRelevantFiles(mockPRDetails);

    expect(files.some(f => f.diff.includes('console.log("kept");'))).toBe(true);
  });

  it('should expose the real pre-deletion path for a kept deleted file (not /dev/null)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockDeletedFilesDiffResponse
    });

    const service = new DiffService('mock-github-token', 'fixtures/**');
    const files = await service.getRelevantFiles(mockPRDetails);

    const kept = files.find(f => f.diff.includes('console.log("kept");'));
    expect(kept).toBeDefined();
    // Downstream lookups key off `path`; a deleted file must carry its real
    // pre-deletion path, never "/dev/null" (which collides across deletions).
    expect(kept!.path).toBe('src/kept.ts');
  });

  it('should keep a file renamed OUT of an excluded dir (destination path decides)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockRenameOutOfExcludedDiffResponse
    });

    const service = new DiffService('mock-github-token', 'vendor/**');
    const files = await service.getRelevantFiles(mockPRDetails);

    // Moved from vendor/ (excluded) into src/ (reviewed): must be kept, keyed
    // by its new path.
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/lib.ts');
  });

  it('should exclude a file renamed INTO an excluded dir (destination path decides)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => mockRenameIntoExcludedDiffResponse
    });

    const service = new DiffService('mock-github-token', 'vendor/**');
    const files = await service.getRelevantFiles(mockPRDetails);

    // Moved into vendor/ (excluded): must be dropped.
    expect(files.length).toBe(0);
  });
});
