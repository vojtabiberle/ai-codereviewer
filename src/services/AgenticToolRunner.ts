import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import { GitHubService } from './GitHubService';

export interface AgenticLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTurns: number;
  maxTotalBytes: number;
}

export const DEFAULT_AGENTIC_LIMITS: AgenticLimits = {
  maxFiles: 20,
  maxBytesPerFile: 20_000,
  maxTurns: 10,
  maxTotalBytes: 200_000,
};

export interface AgenticEnv {
  github: GitHubService;
  ref: string;
  excludePatterns: string[];
  limits: AgenticLimits;
  /** Map of "path[:start:end]" → bytes returned. Used for dedup and budget. */
  filesRead: Map<string, number>;
}

export interface ReadFileArgs {
  startLine?: number;
  endLine?: number;
}

export function makeAgenticEnv(opts: {
  github: GitHubService;
  ref: string;
  excludePatterns: string[];
  limits?: Partial<AgenticLimits>;
}): AgenticEnv {
  return {
    github: opts.github,
    ref: opts.ref,
    excludePatterns: opts.excludePatterns,
    limits: { ...DEFAULT_AGENTIC_LIMITS, ...(opts.limits ?? {}) },
    filesRead: new Map(),
  };
}

/**
 * Execute the read_file tool. Returns either the (line-numbered) file
 * contents or a short error message that the model can act on. Never
 * throws.
 *
 * Behavior:
 *   - Path safety: rejects absolute paths, parent traversal (`..`),
 *     empty paths, and anything matching EXCLUDE_PATTERNS.
 *   - Optional start_line / end_line slices the file. Both 1-based
 *     and inclusive. end_line is clamped to file length. start_line
 *     defaults to 1, end_line defaults to last line.
 *   - Output is line-numbered (`<n>: <text>`) so the model can cite
 *     accurate review-comment line numbers without arithmetic.
 *   - Dedup key is "path:start:end" — reading lines 1-100 does NOT
 *     block a follow-up read of lines 101-200 of the same file.
 *   - Budget is by returned UTF-8 bytes including the truncation marker, so a
 *     small slice of a huge file barely spends from the per-file cap.
 */
export async function executeReadFile(
  env: AgenticEnv,
  path: string,
  reason: string,
  args: ReadFileArgs = {}
): Promise<string> {
  if (!path || typeof path !== 'string') {
    return 'error: read_file requires a non-empty "path" argument';
  }

  const cleanPath = path.trim();
  if (!cleanPath || cleanPath.startsWith('/') || cleanPath.includes('..')) {
    return `error: invalid path '${cleanPath}' — must be a repo-relative path without leading "/" or ".."`;
  }
  if (env.excludePatterns.some(p => minimatch(cleanPath, p, { matchBase: true, dot: true }))) {
    return `error: '${cleanPath}' matches EXCLUDE_PATTERNS — not readable in this session`;
  }

  // Validate range args before checking budget — bad args shouldn't consume a slot.
  let start = args.startLine;
  let end = args.endLine;
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
    return `error: start_line must be an integer >= 1; got ${start}`;
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) {
    return `error: end_line must be an integer >= 1; got ${end}`;
  }
  if (start !== undefined && end !== undefined && end < start) {
    return `error: end_line (${end}) must be >= start_line (${start})`;
  }

  const dedupKey = rangeKey(cleanPath, start, end);
  if (env.filesRead.has(dedupKey)) {
    const prevSize = env.filesRead.get(dedupKey)!;
    return `error: '${dedupKey}' was already read in this session (${prevSize} bytes); reuse the previous result instead of re-reading`;
  }
  if (env.filesRead.size >= env.limits.maxFiles) {
    return `error: read budget exhausted — already read ${env.filesRead.size} files/slices (limit ${env.limits.maxFiles}). Submit your review now.`;
  }

  const bytesRead = () => Array.from(env.filesRead.values()).reduce((sum, size) => sum + size, 0);
  if (bytesRead() >= env.limits.maxTotalBytes) {
    return 'error: total read byte budget exhausted; submit your review now';
  }
  // Reserve before awaiting: providers can request many reads concurrently.
  env.filesRead.set(dedupKey, 0);
  let content: string;
  try {
    content = await env.github.getFileContent(cleanPath, env.ref, { quiet: true });
  } catch {
    return `error: could not read '${cleanPath}'`;
  }
  if (!content) {
    env.filesRead.set(dedupKey, 0);
    return `error: '${cleanPath}' not found at PR head`;
  }

  // Slice by lines (or take the whole file when no range was requested).
  const allLines = content.split('\n');
  const total = allLines.length;
  const startIdx = (start ?? 1) - 1;
  const endIdx = end !== undefined ? Math.min(end, total) : total;
  const slice = allLines.slice(startIdx, endIdx);

  if (slice.length === 0) {
    env.filesRead.set(dedupKey, 0);
    return `error: '${cleanPath}' has ${total} lines; requested range ${start ?? 1}-${end ?? total} is empty`;
  }

  // Line-number the output so the model cites real lines in comments.
  const padTo = String(startIdx + slice.length).length;
  const numbered = slice
    .map((line, i) => `${String(startIdx + 1 + i).padStart(padTo, ' ')}: ${line}`)
    .join('\n');

  const cap = Math.min(env.limits.maxBytesPerFile, env.limits.maxTotalBytes - bytesRead());
  if (cap <= 0) return 'error: total read byte budget exhausted; submit your review now';
  const bytes = Buffer.from(numbered, 'utf8');
  let out = numbered;
  if (bytes.length > cap) {
    const marker = '[truncated]\n';
    const prefix = Buffer.from(marker).subarray(0, cap).toString();
    out = prefix + bytes.subarray(0, Math.max(0, cap - Buffer.byteLength(prefix))).toString('utf8').replace(/\uFFFD$/, '');
  }
  env.filesRead.set(dedupKey, Buffer.byteLength(out, 'utf8'));
  core.info(`[agentic] read_file ${dedupKey} (${Buffer.byteLength(out, 'utf8')} bytes) — ${reason}`);
  return out;
}

function rangeKey(path: string, start?: number, end?: number): string {
  if (start === undefined && end === undefined) return path;
  return `${path}:${start ?? 1}:${end ?? 'end'}`;
}
