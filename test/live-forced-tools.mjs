import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { configPath, loadAuth, readJson } from '../state.mjs';

const cfg = readJson(configPath);
const sdk = new OpenAI({
  baseURL: `http://127.0.0.1:${cfg.port}/v1`,
  apiKey: loadAuth().apiKey,
  maxRetries: 0,
  timeout: 300000,
});
const tools = [
  {
    type: 'function',
    function: {
      name: 'read_local_test_record',
      description: 'Read the external client test record. Only this tool can retrieve its unpredictable code.',
      parameters: {
        type: 'object',
        properties: { record_id: { type: 'string', enum: ['sample'] } },
        required: ['record_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sign_local_test_record',
      description: 'Return the client signature for the exact code supplied by the preceding tool result.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', minLength: 16 } },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
];
const choice = name => ({ type: 'function', function: { name } });
const messages = [{
  role: 'user',
  content: 'Use the required external tools in order. Read record_id sample, sign the returned code, then reply exactly LELE_TOOL_OK:<signature>. Do not use Feishu tools or invent values.',
}];
const directory = 'D:/ao/1gpt/temp/aily-openai';
const reportPath = `${directory}/lele-forced-tool-verification.json`;
const startedAt = Date.now();

async function request(toolChoice) {
  return sdk.chat.completions.create({
    model: cfg.model,
    messages,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: false,
    stream: false,
  }).withResponse();
}

async function run() {
  await fs.mkdir(directory, { recursive: true });
  const fixture = { code: randomUUID() };
  const fixturePath = `${directory}/lele-tool-fixture-${randomUUID()}.json`;
  await fs.writeFile(fixturePath, JSON.stringify(fixture));

  const first = await request(choice('read_local_test_record'));
  assert.equal(first.response.headers.get('x-aily-tool-mode'), 'prompt-bridge');
  assert.equal(first.data.choices[0].finish_reason, 'tool_calls');
  const readCall = first.data.choices[0].message.tool_calls?.[0];
  assert.equal(readCall?.function.name, 'read_local_test_record');
  assert.deepEqual(JSON.parse(readCall.function.arguments), { record_id: 'sample' });
  const taskId = first.response.headers.get('x-aily-task-id');
  messages.push(first.data.choices[0].message, {
    role: 'tool',
    tool_call_id: readCall.id,
    content: JSON.stringify(fixture),
  });

  const second = await request(choice('sign_local_test_record'));
  assert.equal(second.response.headers.get('x-aily-task-id'), taskId);
  assert.equal(second.data.choices[0].finish_reason, 'tool_calls');
  const signCall = second.data.choices[0].message.tool_calls?.[0];
  assert.equal(signCall?.function.name, 'sign_local_test_record');
  assert.deepEqual(JSON.parse(signCall.function.arguments), fixture);
  const signature = createHash('sha256').update(fixture.code).digest('hex');
  messages.push(second.data.choices[0].message, {
    role: 'tool',
    tool_call_id: signCall.id,
    content: JSON.stringify({ signature }),
  });

  const final = await request('none');
  assert.equal(final.response.headers.get('x-aily-task-id'), taskId);
  assert.equal(final.data.choices[0].finish_reason, 'stop');
  assert.equal(final.data.choices[0].message.content.trim(), `LELE_TOOL_OK:${signature}`);
  return {
    passed: true,
    agentId: cfg.agentId,
    agentName: cfg.agentName,
    namedToolChoice: true,
    chainedCalls: 2,
    finalAnswerVerified: true,
    nativeTaskReused: true,
    taskId,
    elapsedMs: Date.now() - startedAt,
    testedAt: new Date().toISOString(),
  };
}

let report;
try {
  report = await run();
} catch (error) {
  report = {
    passed: false,
    agentId: cfg.agentId,
    agentName: cfg.agentName,
    error: {
      name: error.name,
      status: error.status,
      code: error.code,
      message: error.message,
    },
    elapsedMs: Date.now() - startedAt,
    testedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
}
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
