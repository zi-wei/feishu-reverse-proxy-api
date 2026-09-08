import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const nodeRuntime = 'C:/Users/YI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const nodeLicense = 'D:/ao/1gpt/temp/node-v24.19.0-LICENSE';
const required = ['cli.mjs', 'bridge.mjs', 'server.mjs', 'state.mjs', 'login.mjs', 'portal.mjs', 'installation.json', 'package.json', 'package-lock.json'];
const optional = ['README.md', 'public', 'Connect to Feishu.cmd', 'Connect to Lele.cmd', 'Start Gateway.cmd', 'Reconnect Account.cmd', 'Stop Gateway.cmd'];
const runtimePackages = ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'lucide', 'playwright-core', 'require-from-string'];

function copyFile(source, destination) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else copyFile(from, to);
  }
}

export function buildPortable(output) {
  if (!fs.existsSync(nodeRuntime)) throw new Error(`Bundled Node runtime missing: ${nodeRuntime}`);
  const temp = path.join(path.dirname(output), `.aily-openai-package-${process.pid}`);
  if (fs.existsSync(temp)) throw new Error(`Temporary package directory already exists: ${temp}`);
  fs.mkdirSync(temp, { recursive: true });
  try {
    copyFile(nodeRuntime, path.join(temp, 'runtime', 'node.exe'));
    if (fs.existsSync(nodeLicense)) copyFile(nodeLicense, path.join(temp, 'runtime', 'LICENSE'));
    for (const file of required) copyFile(path.join(root, file), path.join(temp, 'app', file));
    const installation = { dataDir: '%LOCALAPPDATA%\\AilyOpenAI' };
    fs.writeFileSync(path.join(temp, 'app', 'installation.json'), JSON.stringify(installation, null, 2) + '\n', 'utf8');
    for (const item of optional) {
      const source = path.join(root, item);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(temp, item === 'public' ? 'app/public' : item);
      fs.statSync(source).isDirectory() ? copyTree(source, destination) : copyFile(source, destination);
    }
    for (const dependency of runtimePackages) copyTree(path.join(root, 'node_modules', dependency), path.join(temp, 'app/node_modules', dependency));
    const ps = `$ErrorActionPreference='Stop'; Compress-Archive -Path '${temp.replace(/'/g, "''")}\\*' -DestinationPath '${output.replace(/'/g, "''")}' -Force`;
    const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (result.status !== 0) throw new Error(result.stderr || 'Compress-Archive failed.');
    return { package: output, bytes: fs.statSync(output).size, containsCredentials: false, launcher: 'Connect to Feishu.cmd' };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) { process.stderr.write('Usage: node build-portable.mjs <output.zip>\n'); process.exit(2); }
  try { process.stdout.write(JSON.stringify(buildPortable(path.resolve(output))) + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
