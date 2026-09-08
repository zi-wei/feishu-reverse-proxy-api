import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { Bridge, normalizeRequest, parseToolCall, conversationKey } from '../bridge.mjs';
import { createServer } from '../server.mjs';

const config = { model: 'aily-assistant', agentId: 'agent_test', pollMs: 1, timeoutMs: 1000 };
const user = { role: 'user', content: 'Read the test record.' };
const tool = { type: 'function', function: { name: 'read_record', parameters: {
  type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false,
} } };
const request = (extra = {}) => normalizeRequest({ model: config.model, messages: [user], tools: [tool], ...extra }, config.model);
const marker = (name = 'read_record', args = { id: 1 }) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
const call = (id) => ({ id, type: 'function', function: { name: 'read_record', arguments: '{"id":1}' } });
const event = (seq, type, id, values, extra = {}) => ({ id: `e${seq}`, seq, entityType: type, entityId: id,
  action: 'updated', actorId: config.agentId, actorType: 'agent',
  changes: Object.entries(values).map(([field, value]) => ({ field, toValue: JSON.stringify(value) })), ...extra });
function page(seq, text, trigger) {
  const runId = `r${seq}`;
  return { hasMore: false, items: [
    event(seq, 'run', runId, { status: 'queued', triggerEvents: [{ eventType: trigger ? 'comment.created' : 'task.created', entityId: trigger || 't1' }] }, { action: 'created' }),
    event(seq + 1, 'comment', `c${seq}`, { content: text }, { action: 'created', runId }),
    event(seq + 2, 'run', runId, { status: 'completed' }),
  ] };
}

test('validates tool declarations and choice before making upstream requests', () => {
  for (const extra of [
    { tools: [tool, tool] }, { tool_choice: { type: 'function', function: { name: 'unknown' } } },
    { tools: [], tool_choice: 'required' }, { parallel_tool_calls: 'false' },
    { tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'bogus' } } }] },
    { tools: [{ ...tool, function: { ...tool.function, parameters: { $ref: 'https://unavailable.example/schema' } } }] },
  ]) assert.throws(() => request(extra), e => e.status === 400);
  for (const choice of ['auto', 'required', 'none', { type: 'function', function: { name: 'read_record' } }]) assert.deepEqual(request({ tool_choice: choice }).toolChoice, choice);
});

test('validates JSON Schema arguments without coercion or removing extra properties', () => {
  const input = request();
  const result = parseToolCall(marker(), input);
  assert.match(result.id, /^call_aily_/);
  assert.equal(result.function.name, 'read_record');
  assert.equal(result.function.arguments, '{"id":1}');
  for (const args of [{}, { id: '1' }, { id: 0 }, { id: 1, extra: 'injected' }]) {
    assert.throws(() => parseToolCall(marker('read_record', args), input), e => e.code === 'invalid_tool_arguments');
  }
  assert.throws(() => parseToolCall(marker('undeclared'), input), e => e.code === 'unknown_tool_call');
});

test('enforces none, required, and named choice without silently accepting protocol errors', () => {
  assert.equal(parseToolCall('normal answer', request()), null);
  assert.throws(() => parseToolCall(marker(), request({ tool_choice: 'none' })), e => e.code === 'tool_choice_not_satisfied');
  assert.throws(() => parseToolCall('normal answer', request({ tool_choice: 'required' })), e => e.code === 'tool_choice_not_satisfied');
  const second = { ...tool, function: { ...tool.function, name: 'other_tool' } };
  const forced = request({ tools: [tool, second], tool_choice: { type: 'function', function: { name: 'other_tool' } } });
  assert.throws(() => parseToolCall(marker(), forced), e => e.code === 'tool_choice_not_satisfied');
  for (const content of ['<tool_call>{broken}</tool_call>', marker() + '\nextra', '<tool_call>{"name":"read_record","arguments":[]}</tool_call>']) {
    assert.throws(() => parseToolCall(content, request()), e => e.code === 'malformed_tool_call');
  }
});

test('accepts an exact JSON tool envelope without exposing prompt markers', () => {
  const input = request({ tool_choice: { type: 'function', function: { name: 'read_record' } } });
  const parsed = parseToolCall('{"name":"read_record","arguments":{"id":1}}', input);
  assert.equal(parsed.function.name, 'read_record');
  assert.equal(parsed.function.arguments, '{"id":1}');
  const explained = parseToolCall('调用请求如下:\n```json\n{"name":"read_record","arguments":{"id":1}}\n```', input);
  assert.equal(explained.function.arguments, '{"id":1}');
  assert.equal(parseToolCall('{"answer":"plain JSON"}', request()), null);
});

test('supports nested schemas and explicitly declared JSON Schema 2020-12', () => {
  const input = request({ tools: [{ type: 'function', function: { name: 'nested', parameters: {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { rows: { type: 'array', items: { $ref: '#/$defs/row' } } }, required: ['rows'],
    $defs: { row: { type: 'object', properties: { value: { enum: ['a', 'b'] } }, required: ['value'] } },
  } } }] });
  assert.equal(parseToolCall(marker('nested', { rows: [{ value: 'a' }] }), input).function.name, 'nested');
  assert.throws(() => parseToolCall(marker('nested', { rows: [{ value: 'c' }] }), input), e => e.code === 'invalid_tool_arguments');
});

test('matches every returned tool result to a unique pending call', () => {
  const assistant = { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] };
  const result = id => ({ role: 'tool', tool_call_id: id, content: 'data' });
  const valid = request({ messages: [user, assistant, result('b'), result('a')] });
  assert.equal(valid.turnStart, 2);
  assert.equal(valid.messages[2].tool_call_id, 'b');
  assert.deepEqual(valid.messages[1], { role: 'assistant', tool_calls: [call('a'), call('b')] });
  for (const history of [
    [user, result('a')], [user, assistant, result('a')], [user, assistant, result('a'), result('a')],
    [user, assistant, result('a'), user], [user, { ...assistant, tool_calls: [call('a'), call('a')] }, result('a')],
  ]) assert.throws(() => request({ messages: history }), e => e.status === 400);
});

test('tool markers remain buffered and tool results reuse the saved native conversation after restart', async () => {
  let comments = 0, created = 0, saved;
  const client = {
    async create(prompt) { created++; assert.ok(prompt.includes('Declared client tools:')); return { task: { taskId: 't1' } }; },
    async comment(taskId, prompt) {
      comments++; assert.equal(taskId, 't1'); assert.ok(prompt.includes('"tool_call_id"')); assert.ok(prompt.includes('local-result'));
      return { comment: { commentId: 'u2' } };
    },
    async timeline(taskId, seq) { return seq === 1 ? page(1, marker()) : comments ? page(4, 'FINAL local-result', 'u2') : { items: [], hasMore: false }; },
    async usage() {},
  };
  const chunks = [];
  const first = await new Bridge(config, client, {}, value => { saved = JSON.parse(JSON.stringify(value)); }).complete(request({ stream: true }), { onContent: text => chunks.push(text) });
  assert.equal(first.content, null); assert.equal(first.toolCalls.length, 1); assert.deepEqual(chunks, []);
  const history = [user, { role: 'assistant', content: null, tool_calls: first.toolCalls }, { role: 'tool', tool_call_id: first.toolCalls[0].id, content: 'local-result' }];
  const final = await new Bridge(config, client, saved).complete(request({ messages: history, tool_choice: 'none', stream: true }), { onContent: text => chunks.push(text) });
  assert.equal(final.content, 'FINAL local-result'); assert.equal(final.toolCalls, undefined);
  assert.equal(created, 1); assert.equal(comments, 1); assert.deepEqual(chunks, ['FINAL local-result']);
});

test('a batch of tool results continues once and includes every result', async () => {
  const assistant = { role: 'assistant', tool_calls: [call('a'), call('b')] };
  const state = { [conversationKey([user, assistant], config.model)]: { taskId: 't1', nextSeq: 4, externalTools: true } };
  let sent = false;
  const client = {
    async timeline() { return sent ? page(4, 'both processed', 'u2') : { items: [], hasMore: false }; },
    async comment(taskId, prompt) { assert.ok(prompt.includes('result-a')); assert.ok(prompt.includes('result-b')); sent = true; return { comment: { commentId: 'u2' } }; },
    async usage() {},
  };
  const result = await new Bridge(config, client, state).complete(request({ messages: [user, assistant,
    { role: 'tool', tool_call_id: 'b', content: 'result-b' }, { role: 'tool', tool_call_id: 'a', content: 'result-a' }] }));
  assert.equal(result.content, 'both processed');
});

test('OpenAI SDK consumes JSON and SSE tool calls and receives malformed-output errors', async t => {
  let output = marker();
  const client = { async create() { return { task: { taskId: 't1' } }; }, async timeline() { return page(1, output); }, async usage() {} };
  const bridge = new Bridge(config, client);
  const server = createServer(config, { apiKey: 'test-key' }, bridge);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const sdk = new OpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 });
  const body = { model: config.model, messages: [user], tools: [tool] };
  const json = await sdk.chat.completions.create(body);
  assert.equal(json.choices[0].finish_reason, 'tool_calls');
  assert.equal(json.choices[0].message.content, null);
  assert.equal(json.choices[0].message.tool_calls[0].function.name, 'read_record');
  const chunks = [];
  for await (const chunk of await sdk.chat.completions.create({ ...body, stream: true })) chunks.push(chunk);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"id":1}');
  assert.ok(chunks.every(chunk => !chunk.choices[0].delta.content));
  output = marker('read_record', { id: 'bad-type' });
  await assert.rejects(sdk.chat.completions.create(body), error => error.status === 502 && error.code === 'invalid_tool_arguments');
  await assert.rejects(async () => {
    for await (const chunk of await sdk.chat.completions.create({ ...body, stream: true })) assert.ok(!chunk.choices[0].delta.content);
  }, error => error.code === 'invalid_tool_arguments');
});
