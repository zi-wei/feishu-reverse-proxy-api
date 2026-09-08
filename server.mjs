import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, normalizeRequest } from './bridge.mjs';
import { Portal } from './portal.mjs';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function authorized(req, key) {
  const expected = Buffer.from(`Bearer ${key}`);
  const actual = Buffer.from(req.headers.authorization || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1048576) throw new ApiError(413, 'request_too_large', 'Request body exceeds 1 MiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

export function createServer(config, auth, bridge, onStop = () => {}) {
  const portal = new Portal(config, auth);
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
    res.setHeader('access-control-expose-headers', 'X-Aily-Task-Id, X-Aily-Ignored-Parameters, X-Aily-Tool-Mode');
    res.setHeader('cache-control', 'no-store');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && portal.serve(url.pathname, res)) return;
    if (req.method === 'POST' && url.pathname === '/_local/bootstrap') {
      res.removeHeader('access-control-allow-origin');
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.origin && req.headers.origin !== origin) { json(res, 403, { error: { code: 'origin_rejected' } }); return; }
      try {
        const body = await readBody(req);
        const settings = typeof body?.token === 'string' ? portal.redeem(body.token, server.address().port) : null;
        if (!settings) json(res, 401, new ApiError(401, 'setup_expired', 'Open the local launcher again.').toJSON());
        else json(res, 200, settings);
      } catch (error) { json(res, error.status || 400, { error: { code: error.code || 'invalid_request' } }); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { status: 'ok', service: 'aily-openai', version: '1.0.0', portal: true, active: bridge.active }); return;
    }
    if (!authorized(req, auth.apiKey)) {
      json(res, 401, new ApiError(401, 'invalid_api_key', 'Invalid API key. Run aily-openai config.').toJSON()); return;
    }
    if (req.method === 'POST' && url.pathname === '/_local/setup') { json(res, 200, portal.issue(server.address().port)); return; }
    if (req.method === 'GET' && url.pathname === '/_local/check') {
      try {
        const detail = await bridge.client.call(`agenthub/agents/${config.agentId}/detail`);
        if (detail.detail?.has_permission !== true) throw new ApiError(403, 'agent_access_denied', 'Assistant access denied.');
        json(res, 200, { ok: true });
      } catch (error) { json(res, error.status || 502, { error: { code: error.code || 'upstream_connection_error' } }); }
      return;
    }
    const model = { id: config.model, object: 'model', created: 0, owned_by: 'aily' };
    if (req.method === 'GET' && url.pathname === '/v1/models') { json(res, 200, { object: 'list', data: [model] }); return; }
    if (req.method === 'GET' && url.pathname === `/v1/models/${config.model}`) { json(res, 200, model); return; }
    if (req.method === 'POST' && url.pathname === '/_local/stop') {
      if (bridge.active) { json(res, 409, new ApiError(409, 'gateway_busy', 'Wait for active requests to finish before stopping.').toJSON()); return; }
      json(res, 200, { stopped: true }); server.close(onStop); return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      json(res, 404, new ApiError(404, 'not_found', 'Supported endpoints: /v1/models and /v1/chat/completions.').toJSON()); return;
    }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new ApiError(499, 'client_disconnected', 'Client disconnected.')); };
    res.once('close', abort);
    const timer = setTimeout(() => controller.abort(new ApiError(504, 'upstream_timeout', 'Aily response timed out. The cloud task may still be running.')), config.timeoutMs || 300000);
    let heartbeat, streaming = false;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let input;
    const send = value => { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); };
    const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: config.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason }], ...(input.includeUsage ? { usage: null } : {}) });
    try {
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'invalid_content_type', 'Use Content-Type: application/json.');
      input = normalizeRequest(await readBody(req), config.model);
      if (input.externalTools) res.setHeader('x-aily-tool-mode', 'prompt-bridge');
      if (input.ignored.length) res.setHeader('x-aily-ignored-parameters', input.ignored.join(', '));
      const result = await bridge.complete(input, { signal: controller.signal,
        onStart(taskId) {
          res.setHeader('x-aily-task-id', taskId);
          if (input.stream) {
            streaming = true;
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
            res.flushHeaders();
            send(chunk({ role: 'assistant', content: '' }));
            heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 10000);
          }
        },
        onContent(text) { if (input.stream) send(chunk({ content: text })); },
      });
      const finishReason = result.toolCalls?.length ? 'tool_calls' : 'stop';
      if (input.stream) {
        if (result.toolCalls?.length) send(chunk({ tool_calls: result.toolCalls.map((call, index) => ({ index, ...call })) }));
        send(chunk({}, finishReason));
        if (input.includeUsage && result.usage) send({ id, object: 'chat.completion.chunk', created, model: config.model, choices: [], usage: result.usage });
        res.end('data: [DONE]\n\n');
      } else json(res, 200, { id, object: 'chat.completion', created, model: config.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.content, refusal: null, ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}) }, logprobs: null, finish_reason: finishReason }],
        ...(result.usage ? { usage: result.usage } : {}) });
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Gateway failed. Run aily-openai doctor.');
      if (!res.destroyed) {
        if (streaming) { send(failure.toJSON()); res.end('data: [DONE]\n\n'); }
        else json(res, failure.status, failure.toJSON());
      }
      process.stderr.write(`[${new Date().toISOString()}] ${failure.code}\n`);
    } finally { clearTimeout(timer); clearInterval(heartbeat); res.off('close', abort); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}
