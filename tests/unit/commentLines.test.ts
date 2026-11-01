import parseDiff from 'parse-diff';
import {
  NON_COMMENTABLE_LINE_MARKER,
  formattedDiffLine,
  insertBeforeAttribution,
  restrictToPullRequestLines,
  rightLinesFromPatch,
  unpostedBlockerNote,
} from '../../src/services/commentLines';

describe('rightLinesFromPatch', () => {
  it('reads right-side lines from a headerless pull request patch', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' context',
      '+added',
      ' context',
      '\\ No newline at end of file',
    ].join('\n');

    expect(rightLinesFromPatch(patch)).toEqual(new Set([1, 2, 3]));
  });

  it('returns an empty set for a deletion hunk', () => {
    expect(rightLinesFromPatch('@@ -1,2 +0,0 @@\n-line1\n-line2\n')).toEqual(new Set());
  });

  it('does not treat a no-newline marker as its own line when parse-diff types it as a deletion', () => {
    const parsed = parseDiff([
      'diff --git a/file b/file',
      '--- a/file',
      '+++ b/file',
      '@@ -1 +0,0 @@',
      '-old',
      '\\ No newline at end of file',
    ].join('\n'));
    const lines = parsed[0].chunks[0].changes
      .map(change => formattedDiffLine(change))
      .filter((line): line is string => line !== null);

    expect(lines.join('\n')).toContain('-old');
    expect(lines.join('\n')).not.toContain('No newline');
    expect(rightLinesFromPatch('@@ -1 +0,0 @@\n-old\n\\ No newline at end of file\n')).toEqual(new Set());
  });

  it('returns null when the patch is missing or not a diff', () => {
    expect(rightLinesFromPatch(null)).toBeNull();
    expect(rightLinesFromPatch(undefined)).toBeNull();
    expect(rightLinesFromPatch('')).toBeNull();
    expect(rightLinesFromPatch('Binary files a/x and b/x differ')).toBeNull();
    expect(rightLinesFromPatch('not a diff')).toBeNull();
  });
});

describe('restrictToPullRequestLines', () => {
  const diff = [
    '@@ -10,4 +10,5 @@',
    `${'10'.padStart(5)}|  context`,
    `${'11'.padStart(5)}| +only in the incremental hunk`,
    `${'12'.padStart(5)}|  also context`,
    `${'-'.padStart(5)}| -removed`,
  ].join('\n');

  it('keeps the intersection and shows the rest as nc context', () => {
    const restricted = restrictToPullRequestLines(
      { path: 'src/a.ts', diff, validRightLines: new Set([10, 11, 12]) },
      new Set([10, 50]),
    );

    expect([...restricted.validRightLines]).toEqual([10]);
    expect(restricted.diff).toContain(`${'10'.padStart(5)}|  context`);
    expect(restricted.diff).toContain(`${NON_COMMENTABLE_LINE_MARKER.padStart(5)}|  only in the incremental hunk`);
    expect(restricted.diff).toContain(`${NON_COMMENTABLE_LINE_MARKER.padStart(5)}|  also context`);
    expect(restricted.diff).toContain(`${'-'.padStart(5)}| -removed`);
    expect(restricted.diff).not.toContain(`${'11'.padStart(5)}|`);
    expect(restricted.diff).not.toContain('-| +only');
  });

  it('marks every right-side line when the pull request patch is unknown', () => {
    const restricted = restrictToPullRequestLines(
      { path: 'src/a.ts', diff, validRightLines: new Set([10, 11, 12]) },
      null,
    );

    expect(restricted.validRightLines.size).toBe(0);
    expect(restricted.diff).toContain(`${NON_COMMENTABLE_LINE_MARKER.padStart(5)}|  context`);
    expect(restricted.diff).not.toContain(`${'10'.padStart(5)}|`);
  });
});

describe('unpostedBlockerNote', () => {
  it('caps the summary list at 10 blockers', () => {
    const blockers = Array.from({ length: 11 }, (_, index) => ({
      path: 'src/a.ts',
      line: index + 1,
      comment: `drop-${String(index).padStart(2, '0')}`,
    }));

    const note = unpostedBlockerNote(blockers);
    expect(note).toContain('> Not posted inline (no commentable line on the pull request diff):');
    expect(note).toContain('> - **blocker** `src/a.ts:1` — drop-00');
    expect(note).not.toContain('drop-10');
  });

  it('collapses a multiline comment onto one blockquote line', () => {
    const note = unpostedBlockerNote([
      { path: 'a.ts', line: 4, comment: 'first\nsecond' },
    ]);
    expect(note).toContain('`a.ts:4` — first second');
    expect(note).not.toContain('\nsecond');
  });

  it('inserts the note before the model attribution', () => {
    const summary = insertBeforeAttribution('sum\n\n------\n\n_model_', '> note');
    expect(summary).toBe('sum\n\n> note\n\n------\n\n_model_');
  });
});
