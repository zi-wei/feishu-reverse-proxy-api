import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AilyClient, ApiError, Bridge } from './bridge.mjs';
import { createServer } from './server.mjs';
import { captureLogin } from './login.mjs';
import { dataDir, configPath, authPath, statePath, readJson, writeJson, loadAuth, saveAuth } from './state.mjs';

const entry = fileURLToPath(import.meta.url);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const defaults = { model: 'aily-assistant', port: 8765, pollMs: 1000, timeoutMs: 300000, maxConcurrent: 2 };
const config = () => ({ ...defaults, ...readJson(configPath, {}) });
const endpoint = cfg => `http://127.0.0.1:${cfg.port}`;
const hasAccount = cfg => fs.existsSync(authPath) && cfg.workspaceId && cfg.agentId;

async function ownedHealth(cfg, auth) {
  try {
    const r = await fetch(`${endpoint(cfg)}/health`, { signal: AbortSignal.timeout(1000) });
    const result = await r.json();
    if (!r.ok || result.service !== 'aily-openai') return null;
    if (!auth) return result;
    const models = await fetch(`${endpoint(cfg)}/v1/models`, { headers: { authorization: `Bearer ${auth.apiKey}` }, signal: AbortSignal.timeout(1000) });
    return models.ok ? result : null;
  } catch { return null; }
}

async function stopGateway(cfg, auth) {
  if (!await ownedHealth(cfg, auth)) return { running: false };
  const response = await fetch(`${endpoint(cfg)}/_local/stop`, { method: 'POST', headers: { authorization: `Bearer ${auth.apiKey}` }, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.error?.code || 'gateway_busy', result.error?.message || 'Gateway refused stop.');
  return result;
}

function freePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function startGateway(cfg, auth, chooseFreePort = false) {
  if (await ownedHealth(cfg, auth)) return cfg;
  if (chooseFreePort) {
    const end = Math.min(65535, cfg.port + 100);
    while (!await freePort(cfg.port)) {
      if (cfg.port >= end) throw new ApiError(409, 'port_unavailable', 'No local port is available.');
      cfg = { ...cfg, port: cfg.port + 1 };
    }
  }
  writeJson(configPath, cfg);
  const logPath = path.join(dataDir, 'server.log');
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [entry, 'serve'], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env });
  let exited = false;
  child.once('exit', () => { exited = true; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); fs.closeSync(log);
  for (let n = 0; n < 30 && !exited; n++) {
    if (await ownedHealth(cfg, auth)) return cfg;
    await delay(300);
  }
  throw new ApiError(500, 'startup_failed', `Gateway did not start. Check ${logPath}.`);
}

async function login(cfg, { fresh = false, requestedAgent } = {}) {
  const oldAuth = fs.existsSync(authPath) ? loadAuth() : null;
  if (oldAuth) await stopGateway(cfg, oldAuth);
  const profileName = fresh ? `browser-profile-${Date.now()}` : (cfg.profileName || 'browser-profile');
  const capture = await captureLogin({ profilePath: path.join(dataDir, profileName), preferredAgentId: requestedAgent,
    onProgress(phase) { process.stderr.write(phase === 'login' ? '请在打开的飞书窗口中扫码并确认登录.\n' : '正在识别当前账号可用的助手.\n'); },
  });
  const sameScope = !fresh && cfg.workspaceId === capture.config.workspaceId && cfg.agentId === capture.config.agentId;
  const auth = { headers: capture.headers, apiKey: sameScope && oldAuth ? oldAuth.apiKey : `sk-aily-${randomBytes(24).toString('hex')}`, capturedAt: capture.capturedAt };
  const next = { ...cfg, ...capture.config, profileName };
  if (!sameScope) writeJson(statePath, {});
  saveAuth(auth); writeJson(configPath, next);
  return next;
}

async function checkUpstream(cfg, auth) {
  const detail = await new AilyClient(cfg, auth).call(`agenthub/agents/${cfg.agentId}/detail`);
  if (detail.detail?.has_permission !== true) throw new ApiError(403, 'agent_access_denied', 'This account cannot access the selected assistant.');
  return detail;
}

async function openConnectionPage(cfg, auth) {
  const response = await fetch(`${endpoint(cfg)}/_local/setup`, { method: 'POST', headers: { authorization: `Bearer ${auth.apiKey}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new ApiError(502, 'portal_unavailable', 'Restart the gateway to open the connection page.');
  const result = await response.json();
  const opener = process.platform === 'win32' ? (process.env.ComSpec || 'C:/Windows/System32/cmd.exe') : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', result.url] : [result.url];
  const child = spawn(opener, openerArgs, { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return result.url;
}

async function main() {
  const args = process.argv.slice(2), command = args.shift() || '--help';
  let cfg = config();
  const previousPort = cfg.port;
  let requestedAgent, output;
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (name === '--port' && /^\d+$/.test(value) && +value >= 1024 && +value <= 65535) cfg.port = +value;
    else if (name === '--agent' && /^agent_[a-z0-9]+$/.test(value)) requestedAgent = value;
    else if (name === '--output' && value) output = path.resolve(value);
    else throw new ApiError(400, 'invalid_option', `Invalid option: ${name}`);
  }
  if (['--help', 'help', '-h'].includes(command)) {
    emit({ tool: 'aily-openai', commands: {
      connect: '启动本地服务, 必要时扫码登录, 并打开连接配置页.', reconnect: '用新浏览器配置扫码登录并生成新 API Key.',
      login: '扫码登录并自动识别助手. 可选: --agent <id>.', start: '启动后台网关. 可选: --port <1024-65535>.',
      stop: '停止本地网关.', status: '查看网关状态.', doctor: '检查登录状态和助手权限.', config: '查看 Base URL, API Key 和模型名.',
      package: '构建不含账号数据的 Windows 分发包. 指定 --output <zip>.', 'package-linux': '构建不含账号数据的 Linux 分发包. 指定 --output <tar.gz>.',
    }, data_directory: dataDir }); return;
  }
  if (command === 'package' || command === 'package-linux') {
    if (!output) throw new ApiError(400, 'output_required', `Specify --output <${command === 'package-linux' ? 'tar.gz' : 'zip'}>.`);
    const builder = command === 'package-linux' ? './build-linux.mjs' : './build-portable.mjs';
    const { buildPortable } = await import(builder); emit(await buildPortable(output)); return;
  }
  if (command === 'login') { cfg = await login(cfg, { requestedAgent }); emit({ logged_in: true, workspace_id: cfg.workspaceId, model: cfg.model }); return; }
  if (command === 'status') { emit({ running: Boolean(hasAccount(cfg) && await ownedHealth(cfg, loadAuth())), base_url: `${endpoint(cfg)}/v1` }); return; }
  if (command === 'connect' || command === 'reconnect') {
    if (command === 'reconnect' || !hasAccount(cfg) || (requestedAgent && cfg.agentId !== requestedAgent)) cfg = await login(cfg, { fresh: command === 'reconnect', requestedAgent });
    let auth = loadAuth();
    try { await checkUpstream(cfg, auth); } catch (error) { if (error.code !== 'aily_login_required') throw error; cfg = await login(cfg, { requestedAgent }); auth = loadAuth(); }
    cfg = await startGateway(cfg, auth, true);
    const url = await openConnectionPage(cfg, auth);
    emit({ running: true, base_url: `${endpoint(cfg)}/v1`, model: cfg.model, connection_page_opened: true, connection_page: url }); return;
  }
  if (!hasAccount(cfg)) throw new ApiError(401, 'login_required', '请运行 aily-openai connect, 扫码登录自己的飞书账号.');
  const auth = loadAuth();
  if (command === 'config') { emit({ base_url: `${endpoint(cfg)}/v1`, api_key: auth.apiKey, model: cfg.model }); return; }
  if (command === 'doctor') { await checkUpstream(cfg, auth); emit({ ok: true, node: process.version, credentials: process.platform === 'win32' ? 'Windows DPAPI CurrentUser' : 'file mode 0600', upstream_authenticated: true, agent_access: true, running: Boolean(await ownedHealth(cfg, auth)), base_url: `${endpoint(cfg)}/v1`, model: cfg.model }); return; }
  if (command === 'start') {
    if (cfg.port !== previousPort && await ownedHealth({ ...cfg, port: previousPort }, auth)) throw new ApiError(409, 'server_running', 'Stop the current instance before changing ports.');
    cfg = await startGateway(cfg, auth); emit({ running: true, base_url: `${endpoint(cfg)}/v1`, model: cfg.model }); return;
  }
  if (command === 'stop') { emit(await stopGateway(cfg, auth)); return; }
  if (command === 'serve') {
    const bridge = new Bridge(cfg, new AilyClient(cfg, auth), readJson(statePath, {}), value => writeJson(statePath, value));
    const server = createServer(cfg, auth, bridge, () => process.exit(0));
    server.on('error', error => { emit({ error: { code: error.code, message: 'Cannot bind the local gateway port.' } }); process.exit(1); });
    server.listen(cfg.port, '127.0.0.1', () => emit({ listening: endpoint(cfg), model: cfg.model })); return;
  }
  throw new ApiError(400, 'unknown_command', 'Run aily-openai --help.');
}

main().catch(error => { emit(error instanceof ApiError ? error.toJSON() : { error: { code: error.code || 'cli_error', message: 'Local operation failed. Check the local configuration.' } }); process.exitCode = 1; });
