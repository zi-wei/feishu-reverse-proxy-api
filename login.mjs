import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { AilyClient, ApiError } from './bridge.mjs';

export function browserExecutable() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap(root => [path.join(root, 'Google/Chrome/Application/chrome.exe'), path.join(root, 'Microsoft/Edge/Application/msedge.exe')]).find(file => fs.existsSync(file));
}

export function selectAssistant(members, preferredId) {
  const available = members.filter(member => member.enabled === true && ['aily_buddy', 'aily_team'].includes(member.agent?.providerType) && member.agent.status === 'enabled' && /^agent_[a-z0-9]+$/.test(member.agentId));
  if (preferredId) {
    const selected = available.find(member => member.agentId === preferredId);
    if (!selected) throw new ApiError(403, 'agent_access_denied', 'The selected assistant is unavailable for this account.');
    return selected;
  }
  if (!available.length) throw new ApiError(403, 'no_compatible_assistant', 'This account has no compatible Aily workbench assistant. Create or enable one in Feishu first.');
  return available[0];
}

export async function captureLogin({ profilePath, preferredAgentId, onProgress = () => {}, headless = false }) {
  const executablePath = browserExecutable();
  if (!executablePath) throw new ApiError(500, 'browser_missing', 'Install Microsoft Edge or Google Chrome first.');
  const browser = await chromium.launchPersistentContext(profilePath, { executablePath, headless, viewport: null, args: ['--start-maximized'] });
  const page = browser.pages()[0] || await browser.newPage();
  const candidates = new Map();
  page.on('request', request => {
    const url = new URL(request.url());
    const match = url.origin === 'https://aily.feishu.cn' && url.pathname.match(/^\/workbench\/api\/v[12]\/workspaces\/(\d+)\//);
    if (match) candidates.set(match[1], request);
  });
  try {
    onProgress('login');
    await page.goto('https://aily.feishu.cn/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + 300000;
    let workspaceId, observedHeaders, cookies;
    while (Date.now() < deadline && !page.isClosed()) {
      for (const [id, request] of candidates) {
        const headers = await request.allHeaders();
        const currentCookies = await browser.cookies('https://aily.feishu.cn');
        if (headers.cookie && currentCookies.some(cookie => cookie.name === 'lgw_csrf_token')) {
          workspaceId = id; observedHeaders = headers; cookies = currentCookies; break;
        }
      }
      if (workspaceId) break;
      await delay(500);
    }
    if (!workspaceId) throw new ApiError(408, 'login_incomplete', 'Feishu login was not completed within five minutes.');
    const headers = {
      cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
      'user-agent': observedHeaders['user-agent'],
      'x-lgw-csrf-token': cookies.find(cookie => cookie.name === 'lgw_csrf_token').value,
      origin: 'https://aily.feishu.cn', referer: 'https://aily.feishu.cn/',
      'x-lsc-bizid': '149', 'x-lsc-terminal': 'web', 'x-lsc-version': '1', 'x-lang': 'zh-CN',
    };
    onProgress('discover');
    const response = await browser.request.get(`https://aily.feishu.cn/workbench/api/v2/workspaces/${workspaceId}/members/allMembers?includeAgentMeta=true&includeRuntimeStatus=true&pageSize=100&includeModelConfig=true`, { headers, maxRedirects: 0, timeout: 30000 });
    if (!response.ok()) throw new ApiError(403, 'assistant_discovery_failed', 'Cannot read this account\'s available assistants.');
    const data = await response.json();
    if (data.code !== 0 || !Array.isArray(data.data?.members)) throw new ApiError(502, 'assistant_discovery_failed', 'Feishu did not return the expected assistant list.');
    const member = selectAssistant(data.data.members, preferredAgentId);
    const config = { workspaceId, agentId: member.agentId, agentName: member.agent.name || 'Aily', avatarUrl: member.agent.avatarUrl || '' };
    const client = new AilyClient(config, { headers });
    const detail = await client.call(`agenthub/agents/${config.agentId}/detail`);
    if (detail.detail?.has_permission !== true) throw new ApiError(403, 'agent_access_denied', 'This account cannot access the selected assistant.');
    return { config, headers, capturedAt: new Date().toISOString() };
  } finally { await browser.close(); }
}
