/**
 * Hidden marker stored on reviews this action publishes.
 *
 * `<!-- ai-codereviewer:review v=1 reviewer=<id> sha=<head> base=<sha> status=complete -->`
 *
 * Values that are a single safe token are written as-is. Anything else
 * (spaces, `--`, which cannot appear inside an HTML comment) is percent-encoded.
 * The parser accepts that encoding and double-quoted values, ignores unknown
 * attributes, and accepts any marker version >= 1 that still carries the
 * known fields. Reviews with no valid marker parse as null.
 */

export interface ReviewMarker {
  version: number;
  reviewer: string;
  sha: string;
  base: string;
  status: string;
}

export interface ReviewMarkerInput {
  version?: number;
  reviewer: string;
  sha: string;
  base: string;
  status: 'complete' | 'degraded';
}

export const FALLBACK_REVIEWER_ID = 'ai-codereviewer';

const SAFE_MARKER_VALUE = /^[A-Za-z0-9._/@+:-]+$/;
const MARKER_PATTERN = /<!--\s*ai-codereviewer:review\b([\s\S]*?)-->/g;
const ATTR_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:\\.|[^"\\])*)"|([^\s"<=>]+))/g;
const COMMIT_SHA = /^[0-9a-fA-F]{7,64}$/;
const STATUS_TOKEN = /^[a-z][a-z0-9_-]*$/;

export function resolveReviewerId(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const workflow = env.GITHUB_WORKFLOW?.trim() ?? '';
  const job = env.GITHUB_JOB?.trim() ?? '';
  if (workflow && job) return `${workflow}/${job}`;
  return FALLBACK_REVIEWER_ID;
}

export function formatReviewMarker(fields: ReviewMarkerInput): string {
  const version = fields.version ?? 1;
  const parts = [
    `v=${version}`,
    `reviewer=${encodeMarkerValue(fields.reviewer)}`,
    `sha=${encodeMarkerValue(fields.sha)}`,
    `base=${encodeMarkerValue(fields.base)}`,
    `status=${encodeMarkerValue(fields.status)}`,
  ];
  return `<!-- ai-codereviewer:review ${parts.join(' ')} -->`;
}

export function withReviewMarker(body: string, fields: ReviewMarkerInput): string {
  const stripped = stripReviewMarkers(body).trimEnd();
  const marker = formatReviewMarker(fields);
  return stripped.length > 0 ? `${stripped}\n\n${marker}` : marker;
}

export function stripReviewMarkers(body: string): string {
  return body.replace(new RegExp(MARKER_PATTERN.source, 'g'), '');
}

/**
 * Returns the last valid marker in `body`. Unmarked and malformed comments
 * are ignored. The last marker wins so a marker this action appends at
 * publish time overrides one copied into the summary.
 */
export function parseReviewMarker(body: string | null | undefined): ReviewMarker | null {
  if (!body) return null;
  let found: ReviewMarker | null = null;
  for (const match of body.matchAll(new RegExp(MARKER_PATTERN.source, 'g'))) {
    const parsed = parseMarkerContents(match[1] ?? '');
    if (parsed) found = parsed;
  }
  return found;
}

function encodeMarkerValue(value: string): string {
  if (SAFE_MARKER_VALUE.test(value) && !value.includes('--')) return value;
  return encodeURIComponent(value).replace(/-/g, '%2D');
}

function decodeMarkerValue(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(new RegExp(ATTR_PATTERN.source, 'g'))) {
    const key = match[1];
    const raw = match[2] !== undefined ? unescapeQuoted(match[2]) : match[3];
    attrs[key] = decodeMarkerValue(raw);
  }
  return attrs;
}

function parseMarkerContents(source: string): ReviewMarker | null {
  const attrs = parseAttributes(source);
  const version = Number(attrs.v);
  if (!Number.isInteger(version) || version < 1) return null;
  const reviewer = attrs.reviewer ?? '';
  const sha = attrs.sha ?? '';
  const base = attrs.base ?? '';
  const status = attrs.status ?? '';
  if (!isReviewer(reviewer) || !COMMIT_SHA.test(sha) || !COMMIT_SHA.test(base) || !STATUS_TOKEN.test(status)) {
    return null;
  }
  return { version, reviewer, sha, base, status };
}

function isReviewer(value: string): boolean {
  return value.trim().length > 0 && !value.includes('-->') && !/[\r\n]/.test(value);
}
