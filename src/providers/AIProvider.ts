export interface AIProviderConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  baseURL?: string;
}

export interface ReviewRequest {
  files: Array<{
    path: string;
    content: string;
    diff?: string;
  }>;
  contextFiles?: Array<{
    path: string;
    content: string;
  }>;
  previousReviews?: Array<{
    commit: string | null;
    summary: string;
    lineComments: Array<{
      path: string;
      line: number;
      comment: string;
      resolved?: boolean;
    }>;
  }>;
  pullRequest: {
    title: string;
    description: string;
    base: string;
    head: string;
  };
  context: {
    repository: string;
    owner: string;
    projectContext?: string;
    repoInstructions?: string;
    isUpdate?: boolean;
    agenticReview?: boolean;
    /** Caps on the agentic loop. Only meaningful when agenticReview is true. */
    agenticLimits?: {
      maxFiles: number;
      maxBytesPerFile: number;
      maxTurns: number;
      maxTotalBytes: number;
    };
  };
  /**
   * When set, providers should drive a tool-use loop calling these
   * functions instead of expecting the model to return JSON in one
   * shot. The terminator tool is `submit_review`.
   */
  tools?: {
    readFile: (
      path: string,
      reason: string,
      args?: { startLine?: number; endLine?: number },
    ) => Promise<string>;
  };
}

export type CommentSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export type CommentCategory =
  | 'security'
  | 'bug'
  | 'performance'
  | 'maintainability'
  | 'style'
  | 'docs'
  | 'test'
  | 'other';

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  /**
   * Files the model fetched via read_file during agentic review.
   * Empty / undefined for non-agentic single-shot reviews.
   */
  filesRead?: string[];
  /** How many model turns the session took (1 for non-agentic). */
  turns?: number;
}

export interface ReviewResponse {
  summary: string;
  lineComments?: Array<{
    path: string;
    line: number;
    comment: string;
    severity?: CommentSeverity;
    category?: CommentCategory;
  }>;
  suggestedAction: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  confidence: number;
  usage?: UsageReport;
}

export interface AIProvider {
  initialize(config: AIProviderConfig): Promise<void>;
  review(request: ReviewRequest): Promise<ReviewResponse>;
}
