import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';
import { ReviewResponse } from '../providers/AIProvider';

export interface PRDetails {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  base: string;
  head: string;
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private botLoginPromise?: Promise<string>;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
    [this.owner, this.repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
  }

  async getBotLogin(): Promise<string> {
    if (!this.botLoginPromise) {
      this.botLoginPromise = (async () => {
        try {
          const { data } = await this.octokit.users.getAuthenticated();
          core.debug(`Authenticated as: ${data.login}`);
          return data.login;
        } catch (error) {
          // 401/403/404 here is the expected response for a workflow's default
          // GITHUB_TOKEN — it's an integration credential, not a user, so
          // /user is not accessible. The 'github-actions[bot]' fallback IS
          // the correct identity for that case, so we don't want a warning.
          // For other errors (network, 5xx, etc.) something might actually be
          // wrong, so warn so it's visible in Actions logs.
          const status = (error as { status?: number })?.status;
          const expected = status === 401 || status === 403 || status === 404;
          if (expected) {
            core.debug(`/user not accessible (${status}); using github-actions[bot] as bot identity`);
          } else {
            core.warning(`Failed to resolve authenticated user, falling back to github-actions[bot]: ${error}`);
          }
          return 'github-actions[bot]';
        }
      })();
    }
    return this.botLoginPromise;
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
    const assertCurrentHead = async () => {
      if (!commitId || (await this.getPRDetails(prNumber)).head !== commitId) {
        throw new Error('PR head changed during review; refusing to publish a stale review. Re-run on the new commit.');
      }
    };
    await assertCurrentHead();
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

    const event = suggestedAction.toUpperCase() as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

    const params = {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_id: commitId,
      body: summary,
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
      await assertCurrentHead();
      core.warning('GitHub rejected comment locations; submitting the summary on the reviewed commit.');
      await this.octokit.pulls.createReview({
        ...params,
        body: `${summary}\n\n> Note: Line comments were omitted because GitHub rejected their locations.`,
        comments: [],
      });
    }
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
    const botLogin = await this.getBotLogin();
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
