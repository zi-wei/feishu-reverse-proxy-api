import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installFile = fileURLToPath(new URL('./installation.json', import.meta.url));
let installation = {};
try { installation = JSON.parse(fs.readFileSync(installFile, 'utf8')); } catch {}
const configuredDir = installation.dataDir?.replace(/%([A-Za-z_][A-Za-z0-9_]*)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, percent, braced, bare) => {
  const name = percent || braced || bare;
  return process.env[name] || match;
});
export const dataDir = process.env.AILY_DATA_DIR || configuredDir || fileURLToPath(new URL('./data', import.meta.url));
export const configPath = path.join(dataDir, 'config.json');
export const authPath = path.join(dataDir, process.platform === 'win32' ? 'credentials.dpapi' : 'credentials.json');
export const statePath = path.join(dataDir, 'conversations.json');

export function readJson(file, initial) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && initial !== undefined) return initial; throw error; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dpapi(value, decrypt) {
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error || result.status !== 0) throw new Error('Windows credential encryption failed.');
  return Buffer.from(result.stdout.trim(), 'base64');
}

export function saveAuth(auth) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (process.platform !== 'win32') { writeJson(authPath, auth); return; }
  const temp = `${authPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, dpapi(Buffer.from(JSON.stringify(auth)), false), { mode: 0o600 });
  fs.renameSync(temp, authPath);
}

export function loadAuth() {
  if (process.platform !== 'win32') return readJson(authPath);
  return JSON.parse(dpapi(fs.readFileSync(authPath), true).toString('utf8'));
}
