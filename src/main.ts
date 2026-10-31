import * as core from '@actions/core';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import { ReviewService } from './services/ReviewService';
import { GitHubService } from './services/GitHubService';
import { resolveReviewerId } from './services/reviewMarker';
import { DiffService } from './services/DiffService';
import { readFileSync } from 'fs';

async function main() {
  try {
    if (isIdentityOnly()) {
      const githubToken = core.getInput('GITHUB_TOKEN', { required: true });
      const identity = await new GitHubService(githubToken).getBotIdentity();
      if (!identity) {
        throw new Error('Bot identity could not be resolved');
      }
      return;
    }

    // Get inputs
    const provider = core.getInput('AI_PROVIDER');
    const model = core.getInput('AI_MODEL', { required: true });
    const apiKey = core.getInput('AI_API_KEY', { required: true });
    const baseURL = core.getInput('AI_BASE_URL');
    const githubToken = core.getInput('GITHUB_TOKEN', { required: true });
    const temperature = parseNumberInput('AI_TEMPERATURE', 0, 0, 1);

    // Get new configuration inputs
    const approveReviews = core.getBooleanInput('APPROVE_REVIEWS');
    const approveConfidenceThreshold = parseNumberInput('APPROVE_CONFIDENCE_THRESHOLD', 80, 0, 100);
    const maxComments = parseNumberInput('MAX_COMMENTS', 0, 0, Number.MAX_SAFE_INTEGER, true);
    const minCommentSeverity = (core.getInput('MIN_COMMENT_SEVERITY') || 'minor').toLowerCase();

    validateInputs({ provider, minCommentSeverity });
    const projectContext = core.getInput('PROJECT_CONTEXT');
    const projectContextFile = core.getInput('PROJECT_CONTEXT_FILE');
    const instructionsFile = core.getInput('INSTRUCTIONS_FILE');
    const instructionsUrl = core.getInput('INSTRUCTIONS_URL');
    const instructionsUrlToken = core.getInput('INSTRUCTIONS_URL_TOKEN');
    const contextFilesInput = core.getInput('CONTEXT_FILES');
    const contextFiles = contextFilesInput ? contextFilesInput.split(',').map(f => f.trim()).filter(Boolean) : [];
    const excludePatterns = core.getInput('EXCLUDE_PATTERNS');
    const configFile = core.getInput('CONFIG_FILE');
    const agenticReview = core.getBooleanInput('AGENTIC_REVIEW');
    const agenticLimits = parseAgenticLimitsFromInputs();

    // Initialize services
    const aiProvider = getProvider(provider);
    await aiProvider.initialize({
      apiKey,
      model,
      temperature,
      baseURL: baseURL || undefined,
    });

    // Initialize services
    const githubService = new GitHubService(githubToken, {
      reviewerId: resolveReviewerId(core.getInput('REVIEWER_ID')),
    });
    const diffService = new DiffService(githubToken, excludePatterns);
    const reviewService = new ReviewService(
      aiProvider,
      githubService,
      diffService,
      {
        maxInputBytes: parseNumberInput('MAX_INPUT_BYTES', 1_000_000, 1, Number.MAX_SAFE_INTEGER, true),
        historyMaxBytes: parseOptionalIntegerInput('HISTORY_MAX_BYTES', 0, Number.MAX_SAFE_INTEGER),
        maxComments,
        approveReviews,
        approveConfidenceThreshold,
        projectContext,
        projectContextFile,
        contextFiles,
        instructionsFile,
        instructionsUrl,
        instructionsUrlToken,
        configFile,
        agenticReview,
        agenticLimits,
        providerLabel: provider,
        modelLabel: model,
        minCommentSeverity: minCommentSeverity as 'blocker' | 'major' | 'minor' | 'nit',
      }
    );

    // Get PR number from GitHub context
    const prNumber = getPRNumberFromContext();
    
    // Perform review
    const review = await reviewService.performReview(prNumber);
    
    core.info(`Review completed with ${review.lineComments?.length ?? 0} comments`);
    
  } catch (error: unknown) {
    core.setFailed(`Action failed: ${(error as Error).message}`);
  }
}

function isIdentityOnly(): boolean {
  const raw = core.getInput('IDENTITY_ONLY').trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`IDENTITY_ONLY must be true or false; got '${raw}'`);
}

const VALID_PROVIDERS = ['openai', 'anthropic', 'google'] as const;
const VALID_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

function validateInputs({ provider, minCommentSeverity }: { provider: string; minCommentSeverity: string }): void {
  if (!VALID_PROVIDERS.includes(provider.toLowerCase() as typeof VALID_PROVIDERS[number])) {
    throw new Error(`AI_PROVIDER must be one of [${VALID_PROVIDERS.join(', ')}]; got '${provider}'`);
  }
  if (!VALID_SEVERITIES.includes(minCommentSeverity as typeof VALID_SEVERITIES[number])) {
    throw new Error(`MIN_COMMENT_SEVERITY must be one of [${VALID_SEVERITIES.join(', ')}]; got '${minCommentSeverity}'`);
  }
}

function parseAgenticLimitsFromInputs(): { maxFiles?: number; maxBytesPerFile?: number; maxTurns?: number; maxTotalBytes?: number } {
  const out: { maxFiles?: number; maxBytesPerFile?: number; maxTurns?: number; maxTotalBytes?: number } = {};
  const maxFiles = parsePositiveInt(core.getInput('AGENTIC_MAX_FILES'), 'AGENTIC_MAX_FILES');
  if (maxFiles !== undefined) out.maxFiles = maxFiles;
  const maxBytes = parsePositiveInt(core.getInput('AGENTIC_MAX_BYTES_PER_FILE'), 'AGENTIC_MAX_BYTES_PER_FILE');
  if (maxBytes !== undefined) out.maxBytesPerFile = maxBytes;
  const maxTurns = parsePositiveInt(core.getInput('AGENTIC_MAX_TURNS'), 'AGENTIC_MAX_TURNS');
  if (maxTurns !== undefined) out.maxTurns = maxTurns;
  const maxTotalBytes = parsePositiveInt(core.getInput('AGENTIC_MAX_TOTAL_BYTES'), 'AGENTIC_MAX_TOTAL_BYTES');
  if (maxTotalBytes !== undefined) out.maxTotalBytes = maxTotalBytes;
  return out;
}

function parsePositiveInt(raw: string, label: string): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer; got '${raw}'`);
  }
  return n;
}

function parseOptionalIntegerInput(name: string, min: number, max: number): number | undefined {
  const raw = core.getInput(name).trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseNumberInput(name: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = core.getInput(name).trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function getProvider(provider: string) {
  switch (provider.toLowerCase()) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'google':
      return new GeminiProvider();
    default:
      throw new Error(`Unsupported AI provider: ${provider}`);
  }
}

function getPRNumberFromContext(): number {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error('GITHUB_EVENT_PATH is not set');
    }

    const { pull_request } = JSON.parse(
      readFileSync(eventPath, 'utf8')
    );

    if (!pull_request?.number) {
      throw new Error('Could not get pull request number from event payload');
    }

    return pull_request.number;
  } catch (error) {
    throw new Error(`Failed to get PR number: ${error}`);
  }
}

main().catch(error => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
