import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadAuth, readJson, configPath } from '../state.mjs';

const cfg = readJson(configPath);
const auth = loadAuth();
const base = `http://127.0.0.1:${cfg.port}/v1`;
const headers = { authorization: `Bearer ${auth.apiKey}`, 'content-type': 'application/json' };
const code = `BRIDGE-${Date.now()}`;
const messages = [
  { role: 'system', content: 'You are answering a local API compatibility test. Reply concisely in plain text.' },
  { role: 'user', content: `Within this test conversation only, the verification code is ${code}. Reply only READY. Do not search or create files.` },
];
const models = await fetch(`${base}/models`, { headers });
assert.equal(models.status, 200);
assert.equal((await models.json()).data[0].id, cfg.model);
const firstStart = Date.now();
const first = await fetch(`${base}/chat/completions`, {
  method: 'POST', headers, signal: AbortSignal.timeout(300000),
  body: JSON.stringify({ model: cfg.model, messages, stream: false, temperature: 0.7 }),
});
const firstBody = await first.json();
assert.equal(first.status, 200, JSON.stringify(firstBody));
assert.equal(firstBody.object, 'chat.completion');
assert.match(firstBody.choices[0].message.content, /READY/);
assert.equal(first.headers.get('x-aily-ignored-parameters'), 'temperature');
const taskId = first.headers.get('x-aily-task-id');
console.log(JSON.stringify({ stage: 'non_stream', passed: true, taskId, elapsedMs: Date.now() - firstStart, content: firstBody.choices[0].message.content }));
messages.push({ role: 'assistant', content: firstBody.choices[0].message.content });
messages.push({ role: 'user', content: 'What was the verification code in my preceding message? Reply only the exact code. Do not search or create files.' });
const start = Date.now();
const response = await fetch(`${base}/chat/completions`, {
  method: 'POST', headers, signal: AbortSignal.timeout(300000),
  body: JSON.stringify({ model: cfg.model, messages, stream: true, stream_options: { include_usage: true } }),
});
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type'), /text\/event-stream/);
assert.equal(response.headers.get('x-aily-task-id'), taskId, 'Follow-up must reuse the first task.');
let buffer = '', result = '', done = false, finish = false, usage, firstContentMs, count = 0;
const decoder = new TextDecoder();
for await (const bytes of response.body) {
  buffer += decoder.decode(bytes, { stream: true });
  let end;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    if (!frame.startsWith('data: ')) continue;
    const data = frame.slice(6);
    if (data === '[DONE]') { done = true; continue; }
    const chunk = JSON.parse(data);
    assert.equal(chunk.error, undefined, JSON.stringify(chunk));
    assert.equal(chunk.object, 'chat.completion.chunk');
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) { result += delta; firstContentMs ??= Date.now() - start; count++; }
    if (chunk.choices[0]?.finish_reason === 'stop') finish = true;
    if (chunk.usage) usage = chunk.usage;
  }
}
assert.equal(done, true); assert.equal(finish, true); assert.ok(count > 0);
assert.ok(result.includes(code), `Expected ${code}; received ${result}`);
const unauthorized = await fetch(`${base}/models`, { headers: { authorization: 'Bearer wrong-key' } });
assert.equal(unauthorized.status, 401);
const report = { passed: true, model: cfg.model, nativeConversationReused: true, jsonReply: firstBody.choices[0].message.content,
  streamReply: result, sseDone: done, contentChunks: count, firstContentMs, streamTotalMs: Date.now() - start, usage,
  unauthorizedStatus: unauthorized.status, testedAt: new Date().toISOString() };
fs.mkdirSync('D:/ao/1gpt/temp/aily-openai', { recursive: true });
fs.writeFileSync('D:/ao/1gpt/temp/aily-openai/live-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
