import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { selectAssistant } from '../login.mjs';
import { Portal } from '../portal.mjs';
import { createServer } from '../server.mjs';

const compatible = (id, name = id) => ({ enabled: true, agentId: id, agent: { name, providerType: 'aily_buddy', status: 'enabled' } });

test('selects only an enabled compatible assistant and honors an accessible explicit ID', () => {
  const members = [
    { enabled: true, agentId: 'agent_other', agent: { name: 'Other', providerType: 'legacy', status: 'enabled' } },
    compatible('agent_first', 'First'), compatible('agent_second', 'Second'),
    { enabled: true, agentId: 'agent_team', agent: { name: 'Team', providerType: 'aily_team', status: 'enabled' } },
  ];
  assert.equal(selectAssistant(members).agentId, 'agent_first');
  assert.equal(selectAssistant(members, 'agent_second').agent.name, 'Second');
  assert.equal(selectAssistant(members, 'agent_team').agent.name, 'Team');
  assert.throws(() => selectAssistant(members, 'agent_missing'), error => error.code === 'agent_access_denied');
  assert.throws(() => selectAssistant([], undefined), error => error.code === 'no_compatible_assistant');
});

test('connection-page tokens expire, are bounded, and can be redeemed only once', () => {
  const portal = new Portal({ model: 'aily-assistant', agentName: 'Test' }, { apiKey: 'secret' });
  const token = new URL(portal.issue(8765).url).hash.split('=')[1];
  const first = portal.redeem(token, 8765);
  assert.equal(first.api_key, 'secret');
  assert.equal(first.assistant_name, 'Test');
  assert.equal(portal.redeem(token, 8765), null);
  for (let i = 0; i < 30; i++) portal.issue(8765);
  assert.ok(portal.tokens.size <= 20);
});

test('portal keeps the API key behind a one-time bootstrap token', async t => {
  const config = { model: 'aily-assistant', agentId: 'agent_test', agentName: 'Test Assistant' };
  const auth = { apiKey: 'private-test-key' };
  const bridge = { active: 0, client: { async call() { return { detail: { has_permission: true } }; } } };
  const server = createServer(config, auth, bridge);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!html.includes(auth.apiKey));
  const setup = await fetch(base + '/_local/setup', { method: 'POST', headers: { authorization: `Bearer ${auth.apiKey}` } });
  const token = new URL((await setup.json()).url).hash.split('=')[1];
  const boot = await fetch(base + '/_local/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
  assert.equal((await boot.json()).api_key, auth.apiKey);
  const reused = await fetch(base + '/_local/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
  assert.equal(reused.status, 401);
  const foreign = await fetch(base + '/_local/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ token: 'x' }) });
  assert.equal(foreign.status, 403);
});
