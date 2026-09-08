import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { configPath, loadAuth, readJson } from '../state.mjs';

const cfg = readJson(configPath);
const sdk = new OpenAI({ baseURL: `http://127.0.0.1:${cfg.port}/v1`, apiKey: loadAuth().apiKey, maxRetries: 0, timeout: 300000 });
const tools = [
  { type: 'function', function: { name: 'read_local_test_record', description: 'Read the external client test record from its local disk. The record contains an unpredictable code. Only this tool can retrieve it.', parameters: {
    type: 'object', properties: { record_id: { type: 'string', enum: ['sample'] } }, required: ['record_id'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'sign_local_test_record', description: 'Compute the external client signature for the exact code returned by read_local_test_record. Call this tool instead of calculating the signature yourself.', parameters: {
    type: 'object', properties: { code: { type: 'string', minLength: 16 } }, required: ['code'], additionalProperties: false,
  } } },
];
const messages = [{ role: 'user', content: 'Read record_id sample with read_local_test_record. Then pass its returned code to sign_local_test_record. Finally reply exactly TOOL_BRIDGE_OK:<signature>, using the actual signature returned by the second tool. The data exists only on the external client. Do not use Feishu search, other tools, or guessed values.' }];
const start = Date.now();
const first = await sdk.chat.completions.create({ model: cfg.model, messages, tools, tool_choice: 'auto', stream: false }).withResponse();
assert.equal(first.response.headers.get('x-aily-tool-mode'), 'prompt-bridge');
assert.equal(first.data.choices[0].finish_reason, 'tool_calls');
assert.equal(first.data.choices[0].message.content, null);
const call = first.data.choices[0].message.tool_calls[0];
assert.equal(call.function.name, 'read_local_test_record');
assert.deepEqual(JSON.parse(call.function.arguments), { record_id: 'sample' });
const taskId = first.response.headers.get('x-aily-task-id');
console.log(JSON.stringify({ stage: 'json_tool_call', passed: true, tool: call.function.name, taskId }));

const directory = 'D:/ao/1gpt/temp/aily-openai';
await fs.mkdir(directory, { recursive: true });
const fixturePath = `${directory}/tool-fixture-${randomUUID()}.json`;
await fs.writeFile(fixturePath, JSON.stringify({ code: randomUUID() }));
const localRecord = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
messages.push(first.data.choices[0].message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(localRecord) });

async function streamedReply(choice) {
  const { data: stream, response } = await sdk.chat.completions.create({ model: cfg.model, messages, tools, tool_choice: choice,
    parallel_tool_calls: false, stream: true, stream_options: { include_usage: true } }).withResponse();
  assert.equal(response.headers.get('x-aily-task-id'), taskId, 'Tool result must continue the same Feishu task.');
  const calls = new Map();
  let text = '', finish, usage;
  for await (const chunk of stream) {
    const item = chunk.choices[0];
    if (item?.delta.content) text += item.delta.content;
    for (const delta of item?.delta.tool_calls || []) {
      const value = calls.get(delta.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (delta.id) value.id += delta.id;
      if (delta.function?.name) value.function.name += delta.function.name;
      if (delta.function?.arguments) value.function.arguments += delta.function.arguments;
      calls.set(delta.index, value);
    }
    if (item?.finish_reason) finish = item.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  assert.ok(!text.includes('<tool_call>'), 'Protocol markers must not reach client text.');
  return { text, calls: [...calls.values()], finish, usage };
}

const second = await streamedReply('auto');
assert.equal(second.finish, 'tool_calls');
assert.equal(second.text, '');
assert.equal(second.calls.length, 1);
assert.equal(second.calls[0].function.name, 'sign_local_test_record');
assert.deepEqual(JSON.parse(second.calls[0].function.arguments), { code: localRecord.code });
console.log(JSON.stringify({ stage: 'sse_tool_call', passed: true, tool: second.calls[0].function.name, nativeTaskReused: true }));
const signature = createHash('sha256').update(localRecord.code).digest('hex');
messages.push({ role: 'assistant', content: null, tool_calls: second.calls },
  { role: 'tool', tool_call_id: second.calls[0].id, content: JSON.stringify({ signature }) });
const final = await streamedReply('none');
assert.equal(final.finish, 'stop');
assert.equal(final.calls.length, 0);
assert.equal(final.text.trim(), `TOOL_BRIDGE_OK:${signature}`);
const report = { passed: true, jsonToolCalls: true, sseToolCalls: true, sseFinalAnswer: true, nativeTaskReused: true,
  autoToolSelection: true, chainedCalls: 2, localToolsExecuted: ['read_local_test_record', 'sign_local_test_record'],
  toolChoiceNoneHonored: true, client: 'OpenAI JavaScript SDK', finalAnswerVerified: true,
  elapsedMs: Date.now() - start, testedAt: new Date().toISOString(), taskId };
await fs.writeFile(`${directory}/external-tool-verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
