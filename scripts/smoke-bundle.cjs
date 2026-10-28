const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Execute the shipped entry point with dummy credentials. Invalid inputs must
// fail before any GitHub or provider request; no event payload is supplied.
const cases = [
  ['AI_PROVIDER', 'invalid', /AI_PROVIDER must be one of/],
  ['AI_TEMPERATURE', 'NaN', /AI_TEMPERATURE must be/],
  ['APPROVE_CONFIDENCE_THRESHOLD', '101', /APPROVE_CONFIDENCE_THRESHOLD must be/],
  ['MAX_COMMENTS', '1.5', /MAX_COMMENTS must be/],
  ['AGENTIC_MAX_FILES', '2junk', /AGENTIC_MAX_FILES must be a positive integer/],
  ['AGENTIC_MAX_TOTAL_BYTES', '-1', /AGENTIC_MAX_TOTAL_BYTES must be a positive integer/],
  ['MAX_INPUT_BYTES', '0', /MAX_INPUT_BYTES must be/],
];

for (const [input, value, expected] of cases) {
  test(`bundle rejects invalid ${input}`, () => {
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      env: {
        INPUT_AI_PROVIDER: 'openai',
        INPUT_AI_MODEL: 'test-model',
        INPUT_AI_API_KEY: 'test-key',
        INPUT_GITHUB_TOKEN: 'test-token',
        INPUT_APPROVE_REVIEWS: 'false',
        INPUT_AGENTIC_REVIEW: 'false',
        [`INPUT_${input}`]: value,
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, expected);
  });
}
