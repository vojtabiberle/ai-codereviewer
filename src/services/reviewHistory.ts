/**
 * Previous-review history loaded once over REST and trimmed for the prompt.
 *
 * Both listings stop after HISTORY_PAGE_CAP pages of HISTORY_PAGE_SIZE.
 * Resolution is unknown until a GraphQL thread query exists, so a null
 * `line` (REST outdated) stands in for "resolved" when ordering the prompt.
 *
 * Prompt fill order, newest first within a tier. An item that does not fit
 * is skipped so a later smaller item can still be included:
 *   1. Non-outdated bot findings on a file in the current diff, with replies.
 *   2. Other non-outdated bot findings, with replies.
 *   3. Summaries of the two newest bot reviews (hidden marker removed).
 *   4. Summaries of older bot reviews.
 *   5. Outdated bot findings, newest first, so the oldest are dropped first.
 *
 * Dedup uses every loaded finding, including items left out of the prompt.
 * The key is path, then `line ?? originalLine` (null stays out of the key
 * as "null", never coerced to 0), then the normalized body. The outdated
 * flag is stored and rendered; it is not part of the key, so a repeated
 * finding at the same line still matches.
 *
 * `outdated` starts as the REST signal (`line === null`). A later compare
 * can also set it when the finding's commit is not `ahead` or `identical`
 * against the current head. `line` is left as GitHub returned it.
 */

import { parseReviewMarker, stripReviewMarkers } from './reviewMarker';

/** Page size for both REST history listings. GitHub's maximum is 100. */
export const HISTORY_PAGE_SIZE = 100;

/** Both history listings stop after this many pages. */
export const HISTORY_PAGE_CAP = 20;

/** Share of MAX_INPUT_BYTES used when HISTORY_MAX_BYTES is omitted. */
export const HISTORY_BUDGET_FRACTION = 0.12;

/** Replies from other bots are shortened to this many characters. */
export const OTHER_BOT_REPLY_MAX_CHARS = 160;

/** Replies from human (non-bot) authors are shortened to this many characters. */
export const HUMAN_REPLY_MAX_CHARS = 500;

/**
 * Unique commit SHAs compared when marking findings outdated.
 * The baseline SHA is first, then newer review SHAs.
 */
export const HISTORY_COMPARE_SHA_CAP = 30;

/** In-flight compare calls while classifying finding commits. */
export const HISTORY_COMPARE_CONCURRENCY = 4;

const QUALIFYING_REVIEW_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const BASELINE_SHA = /^[0-9a-f]{40,64}$/i;

const RECENT_SUMMARY_COUNT = 2;

export interface HistoryIdentity {
  login: string;
  id: number | null;
}

export interface HistoryUser {
  login?: string | null;
  id?: number | null;
  type?: string | null;
}

export interface ListedReview {
  id: number;
  user?: HistoryUser | null;
  body?: string | null;
  state?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

export interface ListedComment {
  id: number;
  node_id?: string | null;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number | null;
  user?: HistoryUser | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  commit_id?: string | null;
  original_commit_id?: string | null;
  created_at?: string | null;
}

export interface HistoryComment {
  id: number;
  nodeId: string | null;
  inReplyToId: number | null;
  userLogin: string | null;
  userId: number | null;
  userType: string | null;
  commitId: string | null;
  originalCommitId: string | null;
  path: string;
  /** Null when GitHub no longer maps the comment to a diff line. Never coerced to 0. */
  line: number | null;
  originalLine: number | null;
  side: string | null;
  createdAt: string | null;
  pullRequestReviewId: number | null;
  body: string;
  /**
   * True when `line` is null, or when this finding's commit does not compare
   * as `ahead` or `identical` against the current head. `line` is not cleared.
   */
  outdated: boolean;
  /** True when the author is present and is not this bot. Prompt text is abbreviated. */
  external: boolean;
  /** Replies in conversation order. Only set on findings; reply entries leave this empty. */
  replies: HistoryComment[];
}

export interface HistoryReview {
  id: number;
  commit: string | null;
  summary: string;
  submittedAt: string | null;
  /** Review state from `pulls.listReviews`, such as `COMMENTED` or `DISMISSED`. */
  state: string | null;
  /** Reviewer id from a valid marker, or null when the review is unmarked. */
  reviewerId: string | null;
  /** `sha` from a valid marker, or null when the review is unmarked. */
  markerSha: string | null;
  /** `base` from a valid marker, or null when the review is unmarked. */
  markerBase: string | null;
  /** `status` from a valid marker, or null when the review is unmarked. */
  markerStatus: string | null;
  /** Top-level comments by this bot. Replies live on `replies`, not as findings. */
  lineComments: HistoryComment[];
}

export interface BaselineCandidate {
  reviewId: number;
  sha: string;
  base: string;
}

export interface BaselineSelection {
  candidate: BaselineCandidate | null;
  /** Complete markers whose `sha` does not equal `commit_id`. They do not qualify. */
  mismatchedReviewIds: number[];
}

/** `ahead` and `identical` leave the REST outdated flag unchanged. */
export type CommitReachability = 'ahead' | 'identical' | 'unreachable';

export interface PromptReply {
  author: string | null;
  comment: string;
}

export interface PromptLineComment {
  path: string;
  line: number | null;
  outdated?: true;
  originalLine?: number;
  comment: string;
  replies?: PromptReply[];
}

export interface PromptReview {
  summary?: string;
  lineComments: PromptLineComment[];
}

export interface HistoryPromptFit {
  reviews: PromptReview[];
  omittedComments: number;
  omittedSummaries: number;
  truncated: boolean;
}

export function userMatchesBot(
  user: HistoryUser | null | undefined,
  identity: HistoryIdentity
): boolean {
  if (!user) return false;
  if (identity.id !== null && typeof user.id === 'number') {
    return user.id === identity.id;
  }
  const login = user.login?.trim();
  return !!login && login === identity.login;
}

/**
 * A review counts as this action's history when the author is this bot and
 * any valid marker names this reviewer. Unmarked bot reviews still count.
 * Markers on reviews by anyone else are ignored.
 */
export function reviewBelongsToThisAction(
  review: { user?: HistoryUser | null; body?: string | null },
  identity: HistoryIdentity,
  reviewerId: string
): boolean {
  if (!userMatchesBot(review.user, identity)) return false;
  const marker = parseReviewMarker(review.body);
  if (!marker) return true;
  return marker.reviewer === reviewerId;
}

/**
 * Outdated is not part of the key. The same finding should still match after
 * its line goes stale (`line ?? originalLine`), and a null line must not
 * become 0.
 */
export function findingDedupKey(
  path: string,
  line: number | null,
  originalLine: number | null,
  body: string
): string {
  const resolved = line ?? originalLine;
  const linePart = resolved === null ? 'null' : String(resolved);
  const normalized = body.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${path} ${linePart} ${normalized}`;
}

/** When HISTORY_MAX_BYTES is omitted, use 12% of the configured MAX_INPUT_BYTES. */
export function defaultHistoryMaxBytes(maxInputBytes: number): number {
  if (!Number.isFinite(maxInputBytes) || maxInputBytes <= 0) return 0;
  return Math.floor(maxInputBytes * HISTORY_BUDGET_FRACTION);
}

/**
 * An explicit HISTORY_MAX_BYTES overrides the 12% default. Either value is
 * limited to MAX_INPUT_BYTES.
 */
export function resolveHistoryBudget(explicit: number | undefined, maxInputBytes: number): number {
  const chosen = explicit === undefined ? defaultHistoryMaxBytes(maxInputBytes) : explicit;
  if (!Number.isFinite(chosen)) return 0;
  return Math.min(Math.max(0, chosen), Math.max(0, maxInputBytes));
}

export function abbreviateReply(body: string, maxChars: number): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1)}…`;
}

/**
 * Group one comment listing onto the reviews that belong to this action.
 * `reviews` is already filtered to this action. Human comments are not findings.
 * A reply is kept on the root finding even when a later review posted it.
 */
export function groupReviewHistory(
  reviews: readonly ListedReview[],
  comments: readonly ListedComment[],
  identity: HistoryIdentity
): HistoryReview[] {
  const unique: ListedComment[] = [];
  const seen = new Set<number>();
  for (const comment of comments) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    unique.push(comment);
  }

  const byId = new Map(unique.map(comment => [comment.id, comment]));
  const ourReviewIds = new Set(reviews.map(review => review.id));
  const findings = unique.filter(comment => isFinding(comment, ourReviewIds, identity));
  const findingIds = new Set(findings.map(comment => comment.id));

  const repliesByRoot = new Map<number, ListedComment[]>();
  for (const comment of unique) {
    if (!isReply(comment)) continue;
    const root = rootComment(comment, byId);
    if (!findingIds.has(root.id) || root.id === comment.id) continue;
    const list = repliesByRoot.get(root.id) ?? [];
    list.push(comment);
    repliesByRoot.set(root.id, list);
  }

  return reviews.map(review => {
    const marker = parseReviewMarker(review.body);
    const lineComments = findings
      .filter(comment => comment.pull_request_review_id === review.id)
      .map(comment => toHistoryComment(comment, identity, repliesByRoot.get(comment.id) ?? []));
    return {
      id: review.id,
      commit: review.commit_id ?? null,
      summary: review.body ?? '',
      submittedAt: review.submitted_at ?? null,
      state: review.state ?? null,
      reviewerId: marker?.reviewer ?? null,
      markerSha: marker?.sha ?? null,
      markerBase: marker?.base ?? null,
      markerStatus: marker?.status ?? null,
      lineComments,
    };
  });
}

export function fitHistoryToBudget(
  reviews: readonly HistoryReview[],
  diffPaths: ReadonlySet<string>,
  maxBytes: number
): HistoryPromptFit {
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const summaryText = new Map<number, string>();
  for (const review of reviews) {
    const text = stripReviewMarkers(review.summary).trim();
    if (text) summaryText.set(review.id, text);
  }

  const newestFirst = [...reviews].sort(compareReviewsNewestFirst);
  const recentSummaryIds = new Set(newestFirst.slice(0, RECENT_SUMMARY_COUNT).map(review => review.id));

  const items: HistoryItem[] = [];
  for (const review of reviews) {
    const summary = summaryText.get(review.id);
    if (summary) {
      items.push({
        kind: 'summary',
        priority: recentSummaryIds.has(review.id) ? 3 : 4,
        recency: timestamp(review.submittedAt, review.id),
        id: review.id,
        reviewId: review.id,
        summary,
      });
    }
    for (const comment of review.lineComments) {
      items.push({
        kind: 'thread',
        priority: comment.outdated ? 5 : diffPaths.has(comment.path) ? 1 : 2,
        recency: timestamp(comment.createdAt, comment.id),
        id: comment.id,
        reviewId: review.id,
        comment,
      });
    }
  }
  items.sort(compareItems);

  const selectedSummaries = new Map<number, string>();
  const selectedThreads = new Map<number, SelectedThread>();
  let omittedComments = 0;
  let omittedSummaries = 0;

  const payload = () => renderSelection(reviews, selectedSummaries, selectedThreads);

  for (const item of items) {
    if (item.kind === 'summary') {
      selectedSummaries.set(item.reviewId, item.summary);
      if (historyBytes(payload()) <= budget) continue;
      selectedSummaries.delete(item.reviewId);
      omittedSummaries++;
      continue;
    }

    const replies = item.comment.replies;
    selectedThreads.set(item.id, { reviewId: item.reviewId, comment: item.comment, replies });
    if (historyBytes(payload()) <= budget) continue;

    const kept: HistoryComment[] = [];
    selectedThreads.set(item.id, { reviewId: item.reviewId, comment: item.comment, replies: kept });
    if (historyBytes(payload()) > budget) {
      selectedThreads.delete(item.id);
      omittedComments += 1 + replies.length;
      continue;
    }

    const newestReplies = [...replies].sort((a, b) => timestamp(b.createdAt, b.id) - timestamp(a.createdAt, a.id) || b.id - a.id);
    for (const reply of newestReplies) {
      kept.push(reply);
      if (historyBytes(payload()) > budget) {
        kept.pop();
        omittedComments++;
      }
    }
  }

  const rendered = payload();
  return {
    reviews: rendered,
    omittedComments,
    omittedSummaries,
    truncated: omittedComments + omittedSummaries > 0,
  };
}

function historyBytes(reviews: readonly PromptReview[]): number {
  return Buffer.byteLength(JSON.stringify(reviews), 'utf8');
}

interface SelectedThread {
  reviewId: number;
  comment: HistoryComment;
  replies: readonly HistoryComment[];
}

type HistoryItem = {
  priority: number;
  recency: number;
  id: number;
  reviewId: number;
} & (
  | { kind: 'summary'; summary: string }
  | { kind: 'thread'; comment: HistoryComment }
);

function compareItems(a: HistoryItem, b: HistoryItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.recency !== b.recency) return b.recency - a.recency;
  return b.id - a.id;
}

/**
 * Newest complete review by this reviewer whose marker `sha` equals
 * `commit_id`. Unmarked reviews, other reviewer ids, `degraded` markers,
 * `PENDING`, and sha/commit_id mismatches do not qualify. A mismatch is
 * reported and the walk continues. The caller compares at most the one
 * returned SHA.
 */
export function selectBaseline(
  reviews: readonly HistoryReview[],
  reviewerId: string
): BaselineSelection {
  const mismatchedReviewIds: number[] = [];
  for (const review of [...reviews].sort(compareReviewsNewestFirst)) {
    if (!QUALIFYING_REVIEW_STATES.has((review.state ?? '').toUpperCase())) continue;
    if (review.reviewerId !== reviewerId) continue;
    if (review.markerStatus !== 'complete') continue;
    const sha = review.markerSha ?? '';
    const commit = review.commit ?? '';
    if (sha.toLowerCase() !== commit.toLowerCase()) {
      mismatchedReviewIds.push(review.id);
      continue;
    }
    if (!BASELINE_SHA.test(sha)) continue;
    return {
      candidate: {
        reviewId: review.id,
        sha,
        base: review.markerBase ?? '',
      },
      mismatchedReviewIds,
    };
  }
  return { candidate: null, mismatchedReviewIds };
}

/**
 * SHAs to classify, oldest-dropped-first once the cap is applied by the caller.
 * Order: the baseline SHA, then each review `commit` newest first, then each
 * top-level finding's `commitId` (or `originalCommitId` when that is absent).
 * Reply commits are not included.
 */
export function shasForReachability(
  reviews: readonly HistoryReview[],
  baselineSha: string | null
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (sha: string | null | undefined) => {
    if (!sha) return;
    const key = sha.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(sha);
  };

  add(baselineSha);
  const newestFirst = [...reviews].sort(compareReviewsNewestFirst);
  for (const review of newestFirst) add(review.commit);
  for (const review of newestFirst) {
    for (const comment of review.lineComments) {
      add(comment.commitId || comment.originalCommitId);
    }
  }
  return ordered;
}

/**
 * Sets `outdated` when a compared SHA is unreachable. An `ahead` or
 * `identical` result does not clear the REST flag. A SHA missing from the
 * map (over the compare cap, or absent on the comment) changes nothing.
 * Reply commits do not mark the parent.
 */
export function applyCommitReachability(
  reviews: readonly HistoryReview[],
  reachability: ReadonlyMap<string, CommitReachability>
): HistoryReview[] {
  return reviews.map(review => ({
    ...review,
    lineComments: review.lineComments.map(comment => {
      const sha = comment.commitId || comment.originalCommitId;
      if (!sha) return comment;
      if (reachability.get(sha.toLowerCase()) !== 'unreachable') return comment;
      if (comment.outdated) return comment;
      return { ...comment, outdated: true };
    }),
  }));
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

function compareReviewsNewestFirst(a: HistoryReview, b: HistoryReview): number {
  const byTime = timestamp(b.submittedAt, b.id) - timestamp(a.submittedAt, a.id);
  if (byTime !== 0) return byTime;
  return b.id - a.id;
}

function timestamp(iso: string | null | undefined, fallbackId: number): number {
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackId;
}

function renderSelection(
  reviews: readonly HistoryReview[],
  summaries: ReadonlyMap<number, string>,
  threads: ReadonlyMap<number, SelectedThread>
): PromptReview[] {
  const byId = new Map(reviews.map(review => [review.id, review]));
  const commentsByReview = new Map<number, Array<{ sort: number; id: number; comment: PromptLineComment }>>();
  for (const thread of threads.values()) {
    const list = commentsByReview.get(thread.reviewId) ?? [];
    list.push({
      sort: timestamp(thread.comment.createdAt, thread.comment.id),
      id: thread.comment.id,
      comment: renderComment(thread.comment, thread.replies),
    });
    commentsByReview.set(thread.reviewId, list);
  }

  const included = new Set<number>([...summaries.keys(), ...commentsByReview.keys()]);
  const orderedIds = [...included].sort((a, b) => {
    const left = byId.get(a);
    const right = byId.get(b);
    const byTime = timestamp(right?.submittedAt, b) - timestamp(left?.submittedAt, a);
    if (byTime !== 0) return byTime;
    return b - a;
  });

  return orderedIds.map(id => {
    const prompt: PromptReview = { lineComments: [] };
    const summary = summaries.get(id);
    if (summary !== undefined) prompt.summary = summary;
    const comments = commentsByReview.get(id) ?? [];
    comments.sort((a, b) => a.sort - b.sort || a.id - b.id);
    prompt.lineComments = comments.map(entry => entry.comment);
    return prompt;
  });
}

function renderComment(comment: HistoryComment, replies: readonly HistoryComment[]): PromptLineComment {
  const rendered: PromptLineComment = {
    path: comment.path,
    line: comment.line,
    comment: comment.body,
  };
  if (comment.outdated) {
    rendered.outdated = true;
    if (comment.line === null && typeof comment.originalLine === 'number') {
      rendered.originalLine = comment.originalLine;
    }
  }
  if (replies.length > 0) {
    const ordered = [...replies].sort((a, b) => timestamp(a.createdAt, a.id) - timestamp(b.createdAt, b.id) || a.id - b.id);
    rendered.replies = ordered.map(reply => ({
      author: reply.userLogin,
      comment: abbreviateReplyForPrompt(reply),
    }));
  }
  return rendered;
}

function abbreviateReplyForPrompt(reply: HistoryComment): string {
  if (!reply.external) return reply.body;
  const cap = reply.userType?.toLowerCase() === 'bot' ? OTHER_BOT_REPLY_MAX_CHARS : HUMAN_REPLY_MAX_CHARS;
  return abbreviateReply(reply.body, cap);
}

function isReply(comment: ListedComment): boolean {
  return typeof comment.in_reply_to_id === 'number' && comment.in_reply_to_id > 0;
}

function isFinding(
  comment: ListedComment,
  ourReviewIds: ReadonlySet<number>,
  identity: HistoryIdentity
): boolean {
  if (isReply(comment)) return false;
  if (typeof comment.pull_request_review_id !== 'number' || !ourReviewIds.has(comment.pull_request_review_id)) {
    return false;
  }
  if (!comment.user || (comment.user.login == null && typeof comment.user.id !== 'number')) return true;
  return userMatchesBot(comment.user, identity);
}

function rootComment(comment: ListedComment, byId: ReadonlyMap<number, ListedComment>): ListedComment {
  let current = comment;
  const seen = new Set<number>();
  while (isReply(current) && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.in_reply_to_id;
    if (typeof parentId !== 'number') break;
    const parent = byId.get(parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function toHistoryComment(
  comment: ListedComment,
  identity: HistoryIdentity,
  replies: readonly ListedComment[]
): HistoryComment {
  const mapped = mapComment(comment, identity);
  const ordered = [...replies].sort((a, b) => timestamp(a.created_at, a.id) - timestamp(b.created_at, b.id) || a.id - b.id);
  mapped.replies = ordered.map(reply => mapComment(reply, identity));
  return mapped;
}

function mapComment(comment: ListedComment, identity: HistoryIdentity): HistoryComment {
  const line = nullableLine(comment.line);
  const user = comment.user ?? null;
  const hasAuthor = !!user && (user.login != null || typeof user.id === 'number');
  return {
    id: comment.id,
    nodeId: comment.node_id ?? null,
    inReplyToId: isReply(comment) ? comment.in_reply_to_id ?? null : null,
    userLogin: user?.login ?? null,
    userId: typeof user?.id === 'number' ? user.id : null,
    userType: user?.type ?? null,
    commitId: comment.commit_id ?? null,
    originalCommitId: comment.original_commit_id ?? null,
    path: comment.path ?? '',
    line,
    originalLine: nullableLine(comment.original_line),
    side: comment.side ?? null,
    createdAt: comment.created_at ?? null,
    pullRequestReviewId: typeof comment.pull_request_review_id === 'number' ? comment.pull_request_review_id : null,
    body: comment.body ?? '',
    outdated: line === null,
    external: hasAuthor && !userMatchesBot(user, identity),
    replies: [],
  };
}

function nullableLine(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
