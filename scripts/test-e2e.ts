import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Load environment variables
dotenv.config();

// Load the PR ID
const owner = process.argv[2];
const repo = process.argv[3];
const pr_number = Number(process.argv[4]);
const projectContext = process.argv[5] || '';

if (!owner || !repo || !Number.isSafeInteger(pr_number) || pr_number <= 0) {
  throw new Error('Usage: yarn test:e2e <owner> <repo> <pr_number> [project_context]');
}

// Read the PR payload
const prPayload = JSON.parse(
  readFileSync(resolve(__dirname, `./pull-requests/test-pr-payload-${pr_number}.json`), 'utf8')
);

// Set required environment variables for the action
process.env.GITHUB_EVENT_PATH = resolve(__dirname, `./pull-requests/test-pr-payload-${pr_number}.json`);
process.env.GITHUB_WORKSPACE = resolve(__dirname, '..');
process.env.GITHUB_REPOSITORY = `${owner}/${repo}`;
process.env.GITHUB_CONTEXT = JSON.stringify({
  event: prPayload,
  payload: prPayload
});

// IMPORTANT: Make sure the token is set before setting INPUT_GITHUB_TOKEN
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;

// Set action inputs (these would normally come from action.yml)
process.env.INPUT_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
process.env.INPUT_AI_PROVIDER = process.env.INPUT_AI_PROVIDER || process.env.AI_PROVIDER || 'openai';
process.env.INPUT_AI_API_KEY = process.env.INPUT_AI_API_KEY || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
process.env.INPUT_AI_MODEL = process.env.INPUT_AI_MODEL || process.env.AI_MODEL || 'gpt-4o-mini';
process.env.INPUT_AGENTIC_REVIEW = process.env.INPUT_AGENTIC_REVIEW || 'false';
process.env.INPUT_EXCLUDE_PATTERNS = '**/*.lock,**/*.json,**/*.md';
process.env.INPUT_APPROVE_REVIEWS = 'false';
process.env.INPUT_PROJECT_CONTEXT = projectContext;

// Run the action
require('../lib/src/main');
