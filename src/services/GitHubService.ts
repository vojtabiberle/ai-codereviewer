import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';
import { ReviewResponse } from '../providers/AIProvider';
import { resolveReviewerId, withReviewMarker } from './reviewMarker';

export interface PRDetails {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  base: string;
  head: string;
}

/** Login and numeric user id of the token that publishes reviews. */
export interface BotIdentity {
  login: string;
  id: number | null;
}

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
  private owner: string;
  private repo: string;
  private reviewerIdOverride?: string;
  private botIdentityPromise?: Promise<BotIdentity | null>;

  constructor(token: string, options?: GitHubServiceOptions) {
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
   * only the fallback. A total failure does not guess github-actions[bot]:
   * that login is shared by every workflow and is the wrong app for any
   * other installation token.
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
    if (fromGraphql) return fromGraphql;

    const fromRest = await this.identityFromRest();
    if (fromRest) return fromRest;

    core.warning(
      'Failed to resolve bot identity; not assuming github-actions[bot]. Previous reviews by this action cannot be matched on this run.'
    );
    return null;
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
      return { login, id };
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
      return { login, id };
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

  async getLastReviewSubmittedAt(prNumber: number): Promise<string | null> {
    const botLogin = await this.getBotLogin();
    if (!botLogin) return null;
    // Get the first page to check pagination info
    const firstResponse = await this.octokit.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
      page: 1
    });

    // Get the last page number from the Link header
    const linkHeader = firstResponse.headers.link;

    // If no link header or only one page, process the first response directly
    if (!linkHeader) {
      const botReview = firstResponse.data
        .reverse()
        .find(review => review.user?.login === botLogin);

      return botReview?.submitted_at || null;
    }

    // Get the last page number
    const lastPageMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
    const lastPage = lastPageMatch ? parseInt(lastPageMatch[1], 10) : 1;

    // If only one page, process the first response we already have
    if (lastPage === 1) {
      const botReview = firstResponse.data
        .reverse()
        .find(review => review.user?.login === botLogin);

      return botReview?.submitted_at || null;
    }

    // Multiple pages - start from the last page and move backward
    for (let page = lastPage; page > 1; page--) {
      const response = await this.octokit.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
        page
      });

      const botReview = response.data
        .reverse()
        .find(review => review.user?.login === botLogin);

      if (botReview?.submitted_at) {
        return botReview.submitted_at;
      }
    }

    // Check first page last since we're going backwards
    const botReview = firstResponse.data
      .reverse()
      .find(review => review.user?.login === botLogin);

    return botReview?.submitted_at || null;
  }

  async getLastReviewedCommit(prNumber: number): Promise<string | null> {
    
   const lastReviewSubmittedAt = await this.getLastReviewSubmittedAt(prNumber);

    if (!lastReviewSubmittedAt) return null;

    // Get the commit SHA at the time of the review
    const { data: commits } = await this.octokit.pulls.listCommits({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const reviewDate = new Date(lastReviewSubmittedAt!);
    const lastCommit = commits
      .reverse()
      .find(commit => commit.commit.committer?.date &&
        new Date(commit.commit.committer.date) <= reviewDate);

    return lastCommit?.sha || null;
  }

  async getPreviousReviews(prNumber: number): Promise<Array<{
    commit: string | null;
    summary: string;
    lineComments: Array<{
      path: string;
      line: number;
      comment: string;
    }>;
  }>> {
    const botLogin = await this.getBotLogin();
    if (!botLogin) {
      core.debug('Bot identity is unresolved; skipping previous-review attribution');
      return [];
    }

    let allReviews = [];
    let page = 1;
    let hasNextPage = true;

    // Fetch all reviews with pagination
    while (hasNextPage) {
      const response = await this.octokit.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      allReviews.push(...response.data);

      // Check if there's a next page
      const linkHeader = response.headers.link;
      hasNextPage = linkHeader?.includes('rel="next"') ?? false;
      page++;
    }

    // Filter to bot reviews
    const botReviews = allReviews.filter(review => review.user?.login === botLogin);
    core.debug(`Found ${botReviews.length} bot reviews`);

    const botReviewsWithComments = await Promise.all(
      botReviews.map(async review => {
        let allComments = [];
        let commentPage = 1;
        let hasNextCommentPage = true;

        // Fetch all comments for each review with pagination
        while (hasNextCommentPage) {
          const commentsResponse = await this.octokit.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            review_id: review.id,
            per_page: 100,
            page: commentPage,
          });

          allComments.push(...commentsResponse.data);

          // Check if there's a next page of comments
          const commentLinkHeader = commentsResponse.headers.link;
          hasNextCommentPage = commentLinkHeader?.includes('rel="next"') ?? false;
          commentPage++;
        }

        core.debug(`Found ${allComments.length} comments for review ID ${review.id}`);

        return {
          commit: review.commit_id,
          summary: review.body || '',
          lineComments: allComments.map(comment => ({
            path: comment.path,
            line: comment.line || 0,
            comment: comment.body
          }))
        };
      })
    );

    return botReviewsWithComments;
  }
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
