import parseDiff, { Change, File } from 'parse-diff';

/**
 * Right-line column for a line that is visible in the fetched diff and is
 * not a commentable pull-request position. Not a diff prefix (`+`, `-`, or
 * a space) and not a line number.
 */
export const NON_COMMENTABLE_LINE_MARKER = 'nc';

export const UNPOSTED_BLOCKER_CAP = 10;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const NUMBERED_DIFF_LINE = /^([ ]*)(\d+)(\| )(.*)$/;

export interface CommentableFile {
  path: string;
  diff: string;
  validRightLines: Set<number>;
}

export function rightLinesInFile(file: File): Set<number> {
  const lines = new Set<number>();
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      const line = rightLineNumber(change);
      if (line !== null) lines.add(line);
    }
  }
  return lines;
}

/**
 * Right-side line numbers in a `pulls.listFiles` patch.
 * `null` means the patch is missing or is not a unified diff.
 * An empty set means the patch parsed and has no right-side lines.
 */
export function rightLinesFromPatch(patch: string | null | undefined): Set<number> | null {
  if (typeof patch !== 'string') return null;
  const body = patch.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!body.trim()) return null;
  if (!body.split('\n').some(line => HUNK_HEADER.test(line))) return null;

  const wrapped = body.startsWith('diff --git ')
    ? body
    : `diff --git a/file b/file\n--- a/file\n+++ b/file\n${body.endsWith('\n') ? body : `${body}\n`}`;

  let parsed: File[];
  try {
    parsed = parseDiff(wrapped);
  } catch {
    return null;
  }
  if (parsed.length === 0 || parsed.every(file => file.chunks.length === 0)) return null;

  const lines = new Set<number>();
  for (const file of parsed) {
    for (const line of rightLinesInFile(file)) lines.add(line);
  }
  return lines;
}

export function formattedDiffLine(change: Change): string | null {
  if (change.content.startsWith('\\')) return null;
  if (change.type === 'del') return `${'-'.padStart(5)}| ${change.content}`;
  const line = rightLineNumber(change);
  if (line === null) return null;
  return `${String(line).padStart(5)}| ${change.content}`;
}

/**
 * Keep right-side lines that are also in the pull request diff.
 * A fetched line outside that diff stays in the text as context, with
 * `nc` in the right-line column. `null` means the pull request patch
 * could not be read, so no line of this file is commentable.
 */
export function restrictToPullRequestLines(
  file: CommentableFile,
  pullRequestLines: Set<number> | null,
): CommentableFile {
  const allowed = pullRequestLines === null
    ? new Set<number>()
    : new Set([...file.validRightLines].filter(line => pullRequestLines.has(line)));
  return {
    path: file.path,
    validRightLines: allowed,
    diff: markNonCommentableLines(file.diff, allowed),
  };
}

export function unpostedBlockerNote(
  blockers: ReadonlyArray<{ path: string; line: number; comment: string }>,
): string | null {
  if (blockers.length === 0) return null;
  const lines = blockers.slice(0, UNPOSTED_BLOCKER_CAP).map(blocker => {
    const text = blocker.comment.replace(/\s+/g, ' ').trim();
    return `> - **blocker** \`${blocker.path}:${blocker.line}\` — ${text}`;
  });
  return [
    '> Not posted inline (no commentable line on the pull request diff):',
    ...lines,
  ].join('\n');
}

/** Place `note` after the summary and before the model attribution. */
export function insertBeforeAttribution(summary: string, note: string): string {
  const separator = '\n\n------\n\n';
  const index = summary.lastIndexOf(separator);
  if (index === -1) return `${summary}\n\n${note}`;
  return `${summary.slice(0, index)}\n\n${note}${summary.slice(index)}`;
}

function rightLineNumber(change: Change): number | null {
  if (change.content.startsWith('\\')) return null;
  if (change.type === 'add' && typeof change.ln === 'number') return change.ln;
  if (change.type === 'normal' && typeof change.ln2 === 'number') return change.ln2;
  return null;
}

function markNonCommentableLines(diff: string, allowed: ReadonlySet<number>): string {
  return diff.split('\n').map(line => {
    const match = NUMBERED_DIFF_LINE.exec(line);
    if (!match) return line;
    const lineNo = Number(match[2]);
    if (allowed.has(lineNo)) return line;
    const width = match[1].length + match[2].length;
    const marker = NON_COMMENTABLE_LINE_MARKER.padStart(width);
    return `${marker}${match[3]}${asContext(match[4])}`;
  }).join('\n');
}

/** An added line that cannot be commented on is shown as context, not as a deletion. */
function asContext(original: string): string {
  if (original.startsWith('+')) return ` ${original.slice(1)}`;
  return original;
}
