import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.warn('\x1b[33mWarning: GITHUB_TOKEN environment variable is not set. Some GitHub API operations may be rate-limited without authentication.\x1b[0m');
}

const owner = process.argv[2];
const repo = process.argv[3];
const pr_number = Number(process.argv[4]);

if (!owner || !repo || !Number.isSafeInteger(pr_number) || pr_number <= 0) {
  console.error('Usage: ts-node generate-pr-payload.ts [owner] [repo] [pr_number]');
  process.exit(1);
}

async function generatePRPayload() {
  const octokit = new Octokit({ auth: token });
  
  // Get PR details
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pr_number,
  });

  // Get PR diff
  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pr_number,
  });

  // Format as GitHub webhook payload
  const payload = {
    action: 'opened',
    pull_request: {
      ...pr,
      files: files  // Add the files with their diffs
    },
    repository: {
      name: repo,
      owner: {
        login: owner
      }
    },
    number: pr_number
  };

  const fileName = `scripts/pull-requests/test-pr-payload-${pr_number}.json`;
  fs.mkdirSync('scripts/pull-requests', { recursive: true });
  fs.writeFileSync(fileName, JSON.stringify(payload, null, 2));
  console.log(`Payload saved to ${fileName}`);
}

generatePRPayload().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
