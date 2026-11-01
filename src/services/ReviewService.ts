import { buildSystemPrompt, buildUserPayload } from '../prompts';
import { AIProvider, ReviewRequest } from '../providers/AIProvider';
import { CompareCommitsResult, GitHubService, PRDetails } from '../services/GitHubService';
import {
  insertBeforeAttribution,
  restrictToPullRequestLines,
  rightLinesFromPatch,
  unpostedBlockerNote,
} from './commentLines';
import { DiffService } from '../services/DiffService';
import { CommentSeverity, ReviewResponse, UsageReport } from '../providers/AIProvider';
import { loadRepoConfig, RepoConfig } from './RepoConfigLoader';
import { AgenticLimits, DEFAULT_AGENTIC_LIMITS, executeReadFile, makeAgenticEnv } from './AgenticToolRunner';
import { withRetry } from '../utils/retry';
import {
  applyCommitReachability,
  CommitReachability,
  findingDedupKey,
  fitHistoryToBudget,
  HISTORY_COMPARE_CONCURRENCY,
  HISTORY_COMPARE_SHA_CAP,
  HistoryReview,
  mapWithConcurrency,
  resolveHistoryBudget,
  selectBaseline,
  shasForReachability,
} from './reviewHistory';
import * as core from '@actions/core';

const SEVERITY_ORDER: CommentSeverity[] = ['nit', 'minor', 'major', 'blocker'];

function severityRank(s: CommentSeverity | undefined): number {
  if (!s) return SEVERITY_ORDER.indexOf('minor');
  const idx = SEVERITY_ORDER.indexOf(s);
  return idx === -1 ? SEVERITY_ORDER.indexOf('minor') : idx;
}

export interface ReviewServiceConfig {
  maxInputBytes?: number;
  /** UTF-8 budget for previous-review history inside the user payload. */
  historyMaxBytes?: number;
  maxComments: number;
  approveReviews: boolean;
  approveConfidenceThreshold?: number;
  projectContext?: string;
  projectContextFile?: string;
  contextFiles?: string[];
  instructionsFile?: string;
  instructionsUrl?: string;
  instructionsUrlToken?: string;
  configFile?: string;
  agenticReview?: boolean;
  agenticLimits?: Partial<AgenticLimits>;
  providerLabel?: string;
  modelLabel?: string;
  minCommentSeverity?: CommentSeverity;
}

export class ReviewService {
  private config: ReviewServiceConfig & {
    maxInputBytes: number;
    historyMaxBytes: number;
    agenticLimits: AgenticLimits;
  };

  constructor(
    private aiProvider: AIProvider,
    private githubService: GitHubService,
    private diffService: DiffService,
    config: ReviewServiceConfig
  ) {
    const rawThreshold = config.approveConfidenceThreshold;
    const threshold = (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold))
      ? rawThreshold
      : 80;

    const maxInputBytes = config.maxInputBytes ?? 1_000_000;
    const historyMaxBytes = resolveHistoryBudget(config.historyMaxBytes, maxInputBytes);
    if (config.historyMaxBytes !== undefined && config.historyMaxBytes > maxInputBytes) {
      core.debug(
        `HISTORY_MAX_BYTES ${config.historyMaxBytes} is above MAX_INPUT_BYTES ${maxInputBytes}; history budget is ${historyMaxBytes}`
      );
    }
    this.config = {
      maxInputBytes,
      historyMaxBytes,
      maxComments: config.maxComments || 0,
      approveReviews: config.approveReviews,
      approveConfidenceThreshold: threshold,
      projectContext: config.projectContext,
      projectContextFile: config.projectContextFile,
      contextFiles: config.contextFiles ?? [],
      instructionsFile: config.instructionsFile,
      instructionsUrl: config.instructionsUrl,
      instructionsUrlToken: config.instructionsUrlToken,
      configFile: config.configFile,
      agenticReview: config.agenticReview ?? false,
      agenticLimits: { ...DEFAULT_AGENTIC_LIMITS, ...(config.agenticLimits ?? {}) },
      providerLabel: config.providerLabel,
      modelLabel: config.modelLabel,
      minCommentSeverity: config.minCommentSeverity ?? 'minor',
    };
  }

  private applyRepoConfig(repo: RepoConfig): void {
    if (repo.min_comment_severity !== undefined) this.config.minCommentSeverity = repo.min_comment_severity;
    if (repo.approve_reviews !== undefined) this.config.approveReviews = this.config.approveReviews && repo.approve_reviews;
    if (repo.approve_confidence_threshold !== undefined) this.config.approveConfidenceThreshold = Math.max(this.config.approveConfidenceThreshold ?? 80, repo.approve_confidence_threshold);
    if (repo.max_comments !== undefined) this.config.maxComments = repo.max_comments;
    if (repo.instructions_file !== undefined) this.config.instructionsFile = repo.instructions_file;
    if (repo.project_context_file !== undefined) this.config.projectContextFile = repo.project_context_file;
    if (repo.project_context !== undefined) this.config.projectContext = repo.project_context;
    if (repo.context_files !== undefined) this.config.contextFiles = repo.context_files;
    if (repo.agentic_review !== undefined) this.config.agenticReview = this.config.agenticReview && repo.agentic_review;
    if (repo.agentic_max_files !== undefined || repo.agentic_max_bytes_per_file !== undefined || repo.agentic_max_turns !== undefined || repo.agentic_max_total_bytes !== undefined) {
      this.config.agenticLimits = {
        ...this.config.agenticLimits,
        ...(repo.agentic_max_total_bytes !== undefined ? { maxTotalBytes: Math.min(this.config.agenticLimits.maxTotalBytes, repo.agentic_max_total_bytes) } : {}),
        ...(repo.agentic_max_files !== undefined ? { maxFiles: Math.min(this.config.agenticLimits.maxFiles, repo.agentic_max_files) } : {}),
        ...(repo.agentic_max_bytes_per_file !== undefined ? { maxBytesPerFile: Math.min(this.config.agenticLimits.maxBytesPerFile, repo.agentic_max_bytes_per_file) } : {}),
        ...(repo.agentic_max_turns !== undefined ? { maxTurns: Math.min(this.config.agenticLimits.maxTurns, repo.agentic_max_turns) } : {}),
      };
    }
  }

  async performReview(prNumber: number): Promise<ReviewResponse | null> {
    core.info(`Starting review for PR #${prNumber}`);

    // Get PR details
    const prDetails = await this.githubService.getPRDetails(prNumber);
    core.info(`PR title: ${prDetails.title}`);

    // Layer per-repo config (.github/ai-review.yml) on top of action inputs
    // BEFORE we use any tunable to fetch / filter / decide. exclude_patterns
    // is applied to DiffService below; the rest mutate this.config.
    const repoConfig = await loadRepoConfig(this.githubService, this.config.configFile, prDetails.base);
    this.applyRepoConfig(repoConfig);
    if (repoConfig.exclude_patterns !== undefined) {
      this.diffService.setExcludePatterns(repoConfig.exclude_patterns);
    }

    // History loads whenever this action has reviews. The update prompt is
    // used only when the compare of a qualifying baseline is `ahead`.
    const loadedHistory = await this.githubService.getPreviousReviews(prNumber);
    core.debug(`Found ${loadedHistory.length} previous reviews`);

    const decision = await this.decideBaseline(prDetails, loadedHistory);
    if (decision.kind === 'skip') {
      core.info('baseline identical to head, skipping review');
      return null;
    }

    const modifiedFiles = decision.kind === 'incremental'
      ? await this.incrementalFiles(prNumber, prDetails, decision.baselineSha)
      : await this.diffService.getRelevantFiles(prDetails);
    const history = await this.markUnreachableFindings(
      loadedHistory,
      prDetails.head,
      decision.known,
      decision.baselineSha,
    );
    const isUpdate = decision.kind === 'incremental';
    core.info(`Modified files length: ${modifiedFiles.length}`);

    const historyBudget = this.config.historyMaxBytes;
    const historyFit = fitHistoryToBudget(
      history,
      new Set(modifiedFiles.map(file => file.path)),
      historyBudget
    );
    if (historyFit.truncated) {
      core.warning(
        `Review history truncated to ${historyBudget} bytes; omitted ${historyFit.omittedComments} comment(s) and ${historyFit.omittedSummaries} summary(ies).`
      );
    }
    const previousReviews = historyFit.reviews.length > 0 ? historyFit.reviews : undefined;
    if (loadedHistory.length > 0) {
      const historyBytes = previousReviews ? Buffer.byteLength(JSON.stringify(previousReviews), 'utf8') : 0;
      core.debug(`Review history prompt is ${historyBytes} bytes (budget ${historyBudget})`);
    }

    // Get full content for each modified file (head version only — the diff
    // already encodes what changed, so fetching the base version too would
    // double the file-content tokens for redundant context).
    const filesWithContent = await Promise.all(
      modifiedFiles.map(async (file) => {
        const content = await this.githubService.getFileContent(file.path, prDetails.head);
        return {
          path: file.path,
          content,
          diff: file.diff,
        };
      })
    );

    // Get repository context (now using configured files)
    const contextFiles = await this.getRepositoryContext(prDetails.head);
    const repoInstructions = await this.getRepoInstructions(prDetails.base);

    // Policy comes from the trusted base; reviewed source comes from the pinned head.
    const projectContext = await this.getProjectContext(prDetails.base);

    const agenticReview = !!this.config.agenticReview;
    const agenticEnv = agenticReview
      ? makeAgenticEnv({
          github: this.githubService,
          ref: prDetails.head,
          excludePatterns: this.diffService.getExcludePatterns(),
          limits: this.config.agenticLimits,
        })
      : undefined;

    if (agenticReview) {
      core.info(`Agentic review enabled — model can call read_file (max ${agenticEnv!.limits.maxFiles} files / ${agenticEnv!.limits.maxBytesPerFile} bytes each / ${agenticEnv!.limits.maxTurns} turns)`);
    }

    const request: ReviewRequest = {
      files: filesWithContent,
      contextFiles,
      previousReviews,
      pullRequest: {
        title: prDetails.title,
        description: prDetails.description,
        base: prDetails.base,
        head: prDetails.head,
      },
      context: {
        repository: process.env.GITHUB_REPOSITORY ?? '',
        owner: process.env.GITHUB_REPOSITORY_OWNER ?? '',
        projectContext,
        repoInstructions,
        isUpdate,
        agenticReview,
        agenticLimits: agenticEnv?.limits,
      },
      tools: agenticEnv
        ? {
            readFile: (path, reason, args) => executeReadFile(agenticEnv, path, reason, args),
          }
        : undefined,
    };
    const inputBytes = Buffer.byteLength(buildSystemPrompt(request) + buildUserPayload(request), 'utf8');
    if (inputBytes > this.config.maxInputBytes) {
      throw new Error(`Review input is ${inputBytes} bytes; MAX_INPUT_BYTES is ${this.config.maxInputBytes}. Narrow the diff or context; no review was submitted.`);
    }
    // Retrying an entire agentic session would restart its turn budget.
    const review = agenticReview
      ? await this.aiProvider.review(request)
      : await withRetry(() => this.aiProvider.review(request), { label: 'aiProvider.review' });

    // Annotate usage with the files actually read so the step summary picks it up
    if (agenticEnv) {
      review.usage = {
        ...(review.usage ?? {}),
        filesRead: Array.from(agenticEnv.filesRead.keys()),
      };
    }

    if (review.usage) {
      await this.writeUsageSummary(review.usage);
    }

    // Add model name to summary
    const provider = this.config.providerLabel?.toUpperCase()
      || process.env.INPUT_AI_PROVIDER?.toUpperCase()
      || 'AI';
    const model = this.config.modelLabel
      || process.env.INPUT_AI_MODEL
      || '';
    const modelInfo = `_Code review performed by \`${provider}${model ? ` - ${model}` : ''}\`._`;
    review.summary = `${review.summary}\n\n------\n\n${modelInfo}`;

    const validLinesByPath = new Map(
      modifiedFiles.map(f => [f.path, f.validRightLines])
    );

    const filteredBySeverity = this.filterBySeverity(review.lineComments ?? []);
    const dedupedComments = this.dedupeAgainstPrevious(filteredBySeverity, history);
    const { kept: validatedComments, droppedBlockers } = this.dropInvalidLines(dedupedComments, validLinesByPath);
    const note = unpostedBlockerNote(droppedBlockers);
    if (note) review.summary = insertBeforeAttribution(review.summary, note);
    const sortedComments = this.sortBySeverityDesc(validatedComments);
    const cappedComments = this.config.maxComments > 0
      ? sortedComments.slice(0, this.config.maxComments)
      : sortedComments;

    const hasBlocker = cappedComments.some(c => c.severity === 'blocker');

    await this.githubService.submitReview(
      prNumber,
      {
        ...review,
        lineComments: cappedComments,
        suggestedAction: this.normalizeReviewEvent(review.suggestedAction, {
          hasBlocker,
          confidence: review.confidence,
        }),
      },
      validLinesByPath,
      prDetails.head
    );

    return review;
  }

  private async decideBaseline(
    prDetails: { base: string; head: string },
    history: readonly HistoryReview[],
  ): Promise<
    | { kind: 'skip' }
    | { kind: 'full'; baselineSha: string | null; known: Map<string, CommitReachability> }
    | { kind: 'incremental'; baselineSha: string; known: Map<string, CommitReachability> }
  > {
    const { candidate, mismatchedReviewIds } = selectBaseline(history, this.githubService.getReviewerId());
    for (const id of mismatchedReviewIds) {
      core.debug(`marker sha differs from commit_id review=${id}`);
    }

    if (!candidate) {
      core.info('no previous review, full review');
      return { kind: 'full', baselineSha: null, known: new Map() };
    }

    if (candidate.base.toLowerCase() !== prDetails.base.toLowerCase()) {
      core.info('baseline base changed, full review');
      return { kind: 'full', baselineSha: candidate.sha, known: new Map() };
    }

    if (candidate.sha.toLowerCase() === prDetails.head.toLowerCase()) {
      return { kind: 'skip' };
    }

    const compared = await this.githubService.compareCommits(candidate.sha, prDetails.head);
    const known = new Map<string, CommitReachability>([[candidate.sha.toLowerCase(), reachabilityOf(compared)]]);
    const status = compared.ok ? compared.status.trim().toLowerCase() : '';
    if (status === 'identical') return { kind: 'skip' };
    if (status === 'ahead') return { kind: 'incremental', baselineSha: candidate.sha, known };

    core.info(`baseline unreachable, full review: ${unreachableReason(compared)}`);
    return { kind: 'full', baselineSha: candidate.sha, known };
  }

  private async incrementalFiles(prNumber: number, prDetails: PRDetails, baselineSha: string) {
    const [files, pullRequestFiles] = await Promise.all([
      this.diffService.getRelevantFiles(prDetails, baselineSha),
      this.githubService.listPullRequestFiles(prNumber),
    ]);
    const patchByPath = new Map(pullRequestFiles.map(file => [file.path, file.patch]));
    const kept = [];
    for (const file of files) {
      if (!patchByPath.has(file.path)) continue;
      const pullRequestLines = rightLinesFromPatch(patchByPath.get(file.path));
      if (pullRequestLines === null) {
        core.info(`comment lines unknown, dropped: ${file.path}`);
      }
      kept.push(restrictToPullRequestLines(file, pullRequestLines));
    }
    core.info(`Incremental review kept ${kept.length} of ${files.length} files that are also in the pull request`);
    return kept;
  }

  private async markUnreachableFindings(
    history: readonly HistoryReview[],
    head: string,
    known: ReadonlyMap<string, CommitReachability>,
    baselineSha: string | null,
  ): Promise<HistoryReview[]> {
    const ordered = shasForReachability(history, baselineSha);
    if (ordered.length === 0) return [...history];
    const selected = ordered.slice(0, HISTORY_COMPARE_SHA_CAP);
    if (ordered.length > HISTORY_COMPARE_SHA_CAP) {
      core.warning(`history compare cap, ${HISTORY_COMPARE_SHA_CAP} SHAs`);
    }

    const reachability = new Map(known);
    const pending = selected.filter(sha => !reachability.has(sha.toLowerCase()));
    await mapWithConcurrency(pending, HISTORY_COMPARE_CONCURRENCY, async sha => {
      const result = await this.githubService.compareCommits(sha, head);
      reachability.set(sha.toLowerCase(), reachabilityOf(result));
    });
    return applyCommitReachability(history, reachability);
  }

  private dropInvalidLines(
    comments: NonNullable<ReviewResponse['lineComments']>,
    validLinesByPath: Map<string, Set<number>>
  ): { kept: NonNullable<ReviewResponse['lineComments']>; droppedBlockers: NonNullable<ReviewResponse['lineComments']> } {
    const kept: typeof comments = [];
    const droppedBlockers: typeof comments = [];
    let dropped = 0;
    for (const c of comments) {
      const valid = validLinesByPath.get(c.path);
      if (valid && valid.has(c.line)) {
        kept.push(c);
      } else {
        dropped++;
        if (c.severity === 'blocker') {
          droppedBlockers.push(c);
          core.warning(
            `Blocker comment dropped because line is outside the diff: ${c.path}:${c.line}`
          );
        }
      }
    }
    if (dropped > 0) {
      core.info(`Dropped ${dropped} comment(s) that are not commentable on the pull request diff`);
    }
    return { kept, droppedBlockers };
  }

  private filterBySeverity(
    comments: NonNullable<ReviewResponse['lineComments']>
  ): NonNullable<ReviewResponse['lineComments']> {
    const min = severityRank(this.config.minCommentSeverity);
    const before = comments.length;
    const kept = comments.filter(c => severityRank(c.severity) >= min);
    const dropped = before - kept.length;
    if (dropped > 0) {
      core.info(
        `Dropped ${dropped} comment(s) below MIN_COMMENT_SEVERITY=${this.config.minCommentSeverity}`
      );
    }
    return kept;
  }

  private sortBySeverityDesc(
    comments: NonNullable<ReviewResponse['lineComments']>
  ): NonNullable<ReviewResponse['lineComments']> {
    return [...comments].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  private dedupeAgainstPrevious(
    newComments: NonNullable<ReviewResponse['lineComments']>,
    previousReviews?: HistoryReview[]
  ): NonNullable<ReviewResponse['lineComments']> {
    if (!previousReviews || previousReviews.length === 0) {
      return newComments;
    }

    const seen = new Set<string>();
    for (const review of previousReviews) {
      for (const c of review.lineComments) {
        seen.add(findingDedupKey(c.path, c.line, c.originalLine, c.body));
      }
    }

    const kept: typeof newComments = [];
    let droppedCount = 0;
    for (const c of newComments) {
      const key = findingDedupKey(c.path, c.line, null, c.comment);
      if (seen.has(key)) {
        droppedCount++;
        continue;
      }
      seen.add(key);
      kept.push(c);
    }
    if (droppedCount > 0) {
      core.info(`Dropped ${droppedCount} duplicate comment(s) already posted in earlier reviews`);
    }
    return kept;
  }

  private async writeUsageSummary(usage: UsageReport): Promise<void> {
    const provider = this.config.providerLabel || 'AI';
    const model = this.config.modelLabel || '';
    const fmt = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—');
    try {
      const summary = core.summary
        .addHeading('AI review token usage', 3)
        .addTable([
          [
            { data: 'Provider', header: true },
            { data: 'Model', header: true },
            { data: 'Input', header: true },
            { data: 'Cached input', header: true },
            { data: 'Output', header: true },
            { data: 'Total', header: true },
            { data: 'Turns', header: true },
          ],
          [
            provider, model,
            fmt(usage.inputTokens), fmt(usage.cachedInputTokens),
            fmt(usage.outputTokens), fmt(usage.totalTokens),
            fmt(usage.turns),
          ],
        ]);
      if (usage.filesRead && usage.filesRead.length > 0) {
        summary
          .addHeading('Files read agentically', 4)
          .addList(usage.filesRead);
      }
      await summary.write();
    } catch (e) {
      core.debug(`Could not write summary: ${e}`);
    }
    core.info(
      `Tokens — input: ${fmt(usage.inputTokens)} (cached: ${fmt(usage.cachedInputTokens)}), output: ${fmt(usage.outputTokens)}, total: ${fmt(usage.totalTokens)}, turns: ${fmt(usage.turns)}`
    );
    if (usage.filesRead && usage.filesRead.length > 0) {
      core.info(`Agentic reads: ${usage.filesRead.join(', ')}`);
    }
  }

  private async getRepoInstructions(baseRef: string): Promise<string | undefined> {
    const shared = await this.fetchInstructionsUrl();
    const local = await this.fetchInstructionsFile(baseRef);

    if (shared && local) {
      return `${shared.trim()}\n\n---\n\n${local.trim()}`;
    }
    return shared || local;
  }

  private async fetchInstructionsFile(baseRef: string): Promise<string | undefined> {
    const path = this.config.instructionsFile?.trim();
    if (!path) return undefined;

    const content = await this.githubService.getFileContent(path, baseRef, { quiet: true });
    if (content && content.trim().length > 0) {
      core.info(`Loaded repo-specific reviewer instructions from ${path}`);
      return content;
    }
    return undefined;
  }

  private async fetchInstructionsUrl(): Promise<string | undefined> {
    const url = this.config.instructionsUrl?.trim();
    if (!url) return undefined;

    try {
      const headers: Record<string, string> = {
        'Accept': 'text/plain, text/markdown, */*',
      };
      const token = this.config.instructionsUrlToken?.trim();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        core.warning(
          `INSTRUCTIONS_URL fetch failed (${res.status} ${res.statusText}); skipping shared instructions`
        );
        return undefined;
      }
      const text = await res.text();
      if (text.trim().length > 0) {
        core.info(`Loaded shared reviewer instructions from ${url}`);
        return text;
      }
    } catch (error) {
      core.warning(`INSTRUCTIONS_URL fetch error: ${error}; skipping shared instructions`);
    }
    return undefined;
  }

  private async getProjectContext(baseRef: string): Promise<string | undefined> {
    const path = this.config.projectContextFile?.trim();
    if (path) {
      const content = await this.githubService.getFileContent(path, baseRef, { quiet: true });
      if (content && content.trim().length > 0) {
        core.info(`Loaded project context from ${path}`);
        return content;
      }
    }
    const inline = this.config.projectContext?.trim();
    return inline ? inline : undefined;
  }

  private async getRepositoryContext(headRef: string): Promise<Array<{path: string, content: string}>> {
    const results = [];

    for (const file of (this.config.contextFiles || [])) {
      try {
        const content = await this.githubService.getFileContent(file, headRef);
        if (content) {
          results.push({ path: file, content });
        }
      } catch (error) {
        // File might not exist, skip it
      }
    }

    return results;
  }

  private normalizeReviewEvent(
    action: string,
    signals: { hasBlocker: boolean; confidence: number }
  ): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
    if (signals.hasBlocker) {
      return 'REQUEST_CHANGES';
    }

    if (!this.config.approveReviews) {
      return 'COMMENT';
    }

    const normalized = (action || '').toLowerCase();
    const threshold = this.config.approveConfidenceThreshold ?? 80;
    const confidence = (typeof signals.confidence === 'number' && Number.isFinite(signals.confidence))
      ? signals.confidence
      : 0;

    if (normalized === 'approve') {
      if (confidence >= threshold) {
        return 'APPROVE';
      }
      core.info(
        `Downgrading approve to comment: confidence ${confidence} < threshold ${threshold}`
      );
      return 'COMMENT';
    }

    if (normalized === 'request_changes') {
      return 'REQUEST_CHANGES';
    }

    return 'COMMENT';
  }
}

function reachabilityOf(result: CompareCommitsResult): CommitReachability {
  if (!result.ok) return 'unreachable';
  const status = result.status.trim().toLowerCase();
  if (status === 'ahead' || status === 'identical') return status;
  return 'unreachable';
}

function unreachableReason(result: CompareCommitsResult): string {
  if (!result.ok) return `HTTP ${result.statusCode}`;
  const status = result.status.trim().toLowerCase();
  return status || 'unknown';
}
