import { timingSafeEqual } from 'crypto';
import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';
import { ReviewResponse } from '../providers/AIProvider';
import { resolveReviewerId, withReviewMarker } from './reviewMarker';
import {
  groupReviewHistory,
  HISTORY_PAGE_CAP,
  HISTORY_PAGE_SIZE,
  HistoryReview,
  ListedComment,
  ListedReview,
  reviewBelongsToThisAction,
} from './reviewHistory';

export type CompareCommitsResult =
  | { ok: true; status: string }
  | { ok: false; statusCode: 404 | 422 };

export interface PullRequestFile {
  path: string;
  /** Unified diff for this file. Null when GitHub omitted the patch. */
  patch: string | null;
}

export interface PRDetails {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  base: string;
  head: string;
}

export type BotIdentitySource = 'graphql' | 'rest' | 'fallback';

/** Login and numeric user id of the token that publishes reviews. */
export interface BotIdentity {
  login: string;
  id: number | null;
  source: BotIdentitySource;
}

/**
 * github.com user id of `github-actions[bot]`. Used only when the API cannot
 * be asked and the action token is the job's default `GITHUB_TOKEN`.
 */
export const GITHUB_ACTIONS_BOT_ID = 41898282;
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

interface ViewerQuery {
  viewer: {
    login?: string | null;
    databaseId?: number | null;
  } | null;
}

const VIEWER_QUERY = 'query { viewer { login databaseId } }';

export interface GitHubServiceOptions {
  /** Overrides the marker reviewer id. Defaults to GITHUB_WORKFLOW/GITHUB_JOB. */
  reviewerId?: string;
}

export class GitHubService {
  private octokit: Octokit;
  private token: string;
  private owner: string;
  private repo: string;
  private reviewerIdOverride?: string;
  private botIdentityPromise?: Promise<BotIdentity | null>;

  constructor(token: string, options?: GitHubServiceOptions) {
    this.token = token;
    this.octokit = new Octokit({ auth: token });
    [this.owner, this.repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
    const reviewerId = options?.reviewerId?.trim();
    this.reviewerIdOverride = reviewerId ? reviewerId : undefined;
  }

  /**
   * Identity used to recognize this action's own reviews.
   *
   * Installation tokens (the default GITHUB_TOKEN and any other GitHub App
   * token) cannot call GET /user. GraphQL `viewer` returns that app's bot
   * login and database id for both of those, and for a PAT. GET /user is
   * the next attempt. If both fail and this token is the job's `GITHUB_TOKEN`
   * env var, the identity is github-actions[bot]. Any other token stays
   * unresolved: that login is shared by every workflow and is the wrong app
   * for an installation token.
   */
  async getBotIdentity(): Promise<BotIdentity | null> {
    if (!this.botIdentityPromise) {
      this.botIdentityPromise = this.resolveBotIdentity();
    }
    return this.botIdentityPromise;
  }

  async getBotLogin(): Promise<string | null> {
    return (await this.getBotIdentity())?.login ?? null;
  }

  private async resolveBotIdentity(): Promise<BotIdentity | null> {
    const fromGraphql = await this.identityFromGraphql();
    if (fromGraphql) return this.logIdentity(fromGraphql);

    const fromRest = await this.identityFromRest();
    if (fromRest) return this.logIdentity(fromRest);

    if (isDefaultWorkflowToken(this.token)) {
      core.debug(
        'GraphQL viewer and GET /user failed; token matches the workflow GITHUB_TOKEN, using github-actions[bot]'
      );
      return this.logIdentity({
        login: GITHUB_ACTIONS_BOT_LOGIN,
        id: GITHUB_ACTIONS_BOT_ID,
        source: 'fallback',
      });
    }

    core.warning(
      'Failed to resolve bot identity for this token; not assuming github-actions[bot]. Previous reviews by this action cannot be matched on this run.'
    );
    return null;
  }

  private logIdentity(identity: BotIdentity): BotIdentity {
    core.info(
      `Bot identity: login=${identity.login} databaseId=${identity.id ?? 'unknown'} source=${identity.source}`
    );
    return identity;
  }

  private async identityFromGraphql(): Promise<BotIdentity | null> {
    try {
      const result = await this.octokit.graphql<ViewerQuery>(VIEWER_QUERY);
      const viewer = result?.viewer;
      const login = viewer?.login?.trim();
      if (!login) {
        core.debug('GraphQL viewer returned no login; trying GET /user');
        return null;
      }
      const id = normalizeDatabaseId(viewer?.databaseId);
      core.debug(`Resolved bot identity via GraphQL viewer: login=${login} id=${id ?? 'unknown'}`);
      if (id === null) {
        core.debug('GraphQL viewer returned a login without databaseId');
      }
      return { login, id, source: 'graphql' };
    } catch (error) {
      core.debug(`GraphQL viewer failed (${formatError(error)}); trying GET /user`);
      return null;
    }
  }

  private async identityFromRest(): Promise<BotIdentity | null> {
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      const login = data.login?.trim();
      if (!login) {
        core.debug('GET /user returned no login');
        return null;
      }
      const id = typeof data.id === 'number' ? data.id : null;
      core.debug(`Resolved bot identity via GET /user: login=${login} id=${id ?? 'unknown'}`);
      return { login, id, source: 'rest' };
    } catch (error) {
      const status = httpStatus(error);
      if (status === 401 || status === 403 || status === 404) {
        core.debug(
          `GET /user not accessible (${status}); expected for an installation token when GraphQL viewer also failed`
        );
      } else {
        core.debug(`GET /user failed (${formatError(error)})`);
      }
      return null;
    }
  }

  getReviewerId(): string {
    return this.currentReviewerId();
  }

  private currentReviewerId(): string {
    return resolveReviewerId(this.reviewerIdOverride);
  }

  async getPRDetails(prNumber: number): Promise<PRDetails> {
    const { data: pr } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return {
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
      title: pr.title,
      description: pr.body ?? '',
      base: pr.base.sha,
      head: pr.head.sha,
    };
  }

  async getFileContent(path: string, ref?: string, opts?: { quiet?: boolean }): Promise<string> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
      });

      if ('content' in data) {
        return Buffer.from(data.content, 'base64').toString();
      }
      throw new Error('Not a file');
    } catch (error) {
      if (opts?.quiet) {
        core.debug(`File not found at ${path}: ${error}`);
      } else {
        core.warning(`Failed to get content for ${path}: ${error}`);
      }
      return '';
    }
  }

  async submitReview(
    prNumber: number,
    review: ReviewResponse,
    validRightLinesByPath: Map<string, Set<number>> | undefined,
    commitId: string
  ) {
    const reviewer = this.currentReviewerId();
    const markedBody = (body: string, status: 'complete' | 'degraded', base: string) =>
      withReviewMarker(body, { reviewer, sha: commitId, base, status });

    const pr = await this.assertCurrentHead(prNumber, commitId);
    const { summary, lineComments = [], suggestedAction } = review;

    const { kept, dropped } = this.partitionComments(lineComments, validRightLinesByPath);
    if (dropped.length > 0) {
      core.warning(
        `Dropped ${dropped.length} comment(s) targeting lines outside the PR diff: ` +
        dropped.map(c => `${c.path}:${c.line}`).join(', ')
      );
    }

    const comments = kept.map(comment => ({
      path: comment.path,
      side: 'RIGHT' as const,
      line: comment.line,
      body: comment.comment,
    }));

    core.info(`Submitting review with ${comments.length} comments`);
    core.debug(`Review comments: ${JSON.stringify(comments, null, 2)}`);
    core.debug(`Review marker reviewer=${reviewer} sha=${commitId} base=${pr.base} status=complete`);

    const event = suggestedAction.toUpperCase() as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

    const params = {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_id: commitId,
      body: markedBody(summary, 'complete', pr.base),
      comments,
      event,
    };
    try {
      // Do not retry ambiguous network failures: GitHub may already have created the review.
      await this.octokit.pulls.createReview(params);
    } catch (error) {
      const e = error as { status?: number; response?: { data?: { errors?: Array<{ field?: string }> } } };
      const errors = e.response?.data?.errors;
      const invalidLine = e.status === 422 && comments.length > 0 && Array.isArray(errors) &&
        errors.some(item => ['line', 'position', 'path'].includes(item?.field ?? ''));
      if (!invalidLine) throw error;
      const current = await this.assertCurrentHead(prNumber, commitId);
      core.warning('GitHub rejected comment locations; submitting the summary on the reviewed commit.');
      core.debug(`Review marker reviewer=${reviewer} sha=${commitId} base=${current.base} status=degraded`);
      await this.octokit.pulls.createReview({
        ...params,
        body: markedBody(
          `${summary}\n\n> Note: Line comments were omitted because GitHub rejected their locations.`,
          'degraded',
          current.base
        ),
        comments: [],
      });
    }
  }

  private async assertCurrentHead(prNumber: number, commitId: string): Promise<PRDetails> {
    const pr = await this.getPRDetails(prNumber);
    if (!commitId || pr.head !== commitId) {
      throw new Error('PR head changed during review; refusing to publish a stale review. Re-run on the new commit.');
    }
    return pr;
  }

  private partitionComments(
    lineComments: ReviewResponse['lineComments'] = [],
    validRightLinesByPath?: Map<string, Set<number>>
  ) {
    if (!validRightLinesByPath) {
      return { kept: lineComments, dropped: [] as typeof lineComments };
    }
    const kept: typeof lineComments = [];
    const dropped: typeof lineComments = [];
    for (const c of lineComments) {
      const valid = validRightLinesByPath.get(c.path);
      if (valid && valid.has(c.line)) {
        kept.push(c);
      } else {
        dropped.push(c);
      }
    }
    return { kept, dropped };
  }

  /**
   * JSON compare of `base...head`. 404 and 422 mean the baseline commit is
   * unreachable. 500, 503, and network errors propagate and fail the run.
   */
  async compareCommits(base: string, head: string): Promise<CompareCommitsResult> {
    try {
      const { data } = await this.octokit.repos.compareCommitsWithBasehead({
        owner: this.owner,
        repo: this.repo,
        basehead: `${base}...${head}`,
      });
      return { ok: true, status: typeof data.status === 'string' ? data.status : '' };
    } catch (error) {
      const status = httpStatus(error);
      if (status === 404 || status === 422) return { ok: false, statusCode: status };
      throw error;
    }
  }

  /**
   * Files in the pull request diff, with each file's patch when GitHub
   * included one. Paginated so the 300-file compare cap does not apply.
   * `patch` is null for a binary file and when the diff is too large.
   */
  async listPullRequestFiles(prNumber: number): Promise<PullRequestFile[]> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const listed: PullRequestFile[] = [];
    for (const file of files) {
      if (!file.filename) continue;
      listed.push({
        path: file.filename,
        patch: typeof file.patch === 'string' ? file.patch : null,
      });
    }
    return listed;
  }

  /**
   * Reviews by this action, with comments grouped from one pull-request-wide
   * listing. `GET /pulls/{n}/comments` ignores `review_id`, so comments are
   * not fetched per review.
   */
  async getPreviousReviews(prNumber: number): Promise<HistoryReview[]> {
    const identity = await this.getBotIdentity();
    if (!identity) {
      core.debug('Bot identity is unresolved; skipping previous-review attribution');
      return [];
    }

    const params = {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: HISTORY_PAGE_SIZE,
    };
    const rawReviews = await this.octokit.paginate(
      this.octokit.pulls.listReviews,
      params,
      capHistoryPages(loaded => {
        core.warning(
          `Stopped loading pull request reviews after ${HISTORY_PAGE_CAP} pages of ${HISTORY_PAGE_SIZE} (${loaded} reviews). Continuing with the reviews that were loaded.`
        );
      }),
    );

    const reviewerId = this.currentReviewerId();
    const ours = rawReviews.filter(review => reviewBelongsToThisAction(review, identity, reviewerId));
    core.debug(`Found ${ours.length} reviews by this action (${rawReviews.length} total)`);
    if (ours.length === 0) return [];

    const rawComments = await this.octokit.paginate(
      this.octokit.pulls.listReviewComments,
      params,
      capHistoryPages(loaded => {
        core.warning(
          `Stopped loading pull request review comments after ${HISTORY_PAGE_CAP} pages of ${HISTORY_PAGE_SIZE} (${loaded} comments). Deduplicating from the comments that were loaded.`
        );
      }),
    );

    const grouped = groupReviewHistory(ours, rawComments, identity);
    core.debug(`Grouped ${rawComments.length} review comments onto ${grouped.length} previous reviews`);
    return grouped;
  }
}

/**
 * Map callback for `octokit.paginate`. Calls `done()` after HISTORY_PAGE_CAP
 * pages when another page exists, and keeps the pages already returned.
 */
function capHistoryPages<T>(onCap: (loaded: number) => void) {
  let pages = 0;
  let loaded = 0;
  return (response: { data: T[]; headers: { link?: string } }, done: () => void): T[] => {
    pages += 1;
    const batch = response.data;
    loaded += batch.length;
    if (pages >= HISTORY_PAGE_CAP && linkHeader(response.headers.link).includes('rel="next"')) {
      onCap(loaded);
      done();
    }
    return batch;
  };
}

function linkHeader(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(',');
  return '';
}

/**
 * True when `token` is the job's default Actions token.
 *
 * The runner injects that credential as `GITHUB_TOKEN`. The action input is a
 * separate `INPUT_GITHUB_TOKEN` value. They match when the workflow passes
 * `secrets.GITHUB_TOKEN` / `github.token` and does not replace the
 * `GITHUB_TOKEN` environment variable. Installation tokens and PATs differ
 * from that env var, so a failed `viewer` query must not assume
 * `github-actions[bot]` for them. Token bytes are compared in constant time
 * and are never logged.
 */
function isDefaultWorkflowToken(token: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const workflowToken = env.GITHUB_TOKEN ?? '';
  if (!token || !workflowToken) return false;
  const left = Buffer.from(token);
  const right = Buffer.from(workflowToken);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeDatabaseId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: number })?.status;
  return typeof status === 'number' ? status : undefined;
}

function formatError(error: unknown): string {
  const status = httpStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  return status ? `${status} ${message}` : message;
}
