import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultNodeRuntime = process.env.AILY_LINUX_NODE_RUNTIME || (process.platform === 'linux' ? process.execPath : null);
const required = ['cli.mjs', 'bridge.mjs', 'server.mjs', 'state.mjs', 'login.mjs', 'portal.mjs', 'installation.json', 'package.json', 'package-lock.json'];
const optional = ['README.md', 'public', 'connect-feishu.sh', 'connect-lele.sh', 'start-gateway.sh', 'reconnect-account.sh', 'stop-gateway.sh'];
const runtimePackages = ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'lucide', 'playwright-core', 'require-from-string'];

function copyFile(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (mode) fs.chmodSync(destination, mode);
}
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else copyFile(from, to);
  }
}

function archiveEntries(directory, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const archivePath = path.posix.join(relative.replaceAll('\\', '/'), name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) entries.push({ full, archivePath: `${archivePath}/`, stat, directory: true }, ...archiveEntries(full, archivePath));
    else if (stat.isFile()) entries.push({ full, archivePath, stat, directory: false });
  }
  return entries;
}

async function writeArchive(directory, output) {
  const pack = tar.pack();
  const completed = pipeline(pack, createGzip({ level: 9 }), fs.createWriteStream(output));
  for (const item of archiveEntries(directory)) {
    const executable = item.directory || item.archivePath === 'runtime/node' || item.archivePath.endsWith('.sh');
    const header = { name: item.archivePath, type: item.directory ? 'directory' : 'file', mode: executable ? 0o755 : 0o644,
      size: item.directory ? 0 : item.stat.size, uid: 0, gid: 0, mtime: new Date(0) };
    await new Promise((resolve, reject) => {
      const entry = pack.entry(header, error => error ? reject(error) : resolve());
      if (item.directory) { entry.end(); return; }
      const input = fs.createReadStream(item.full);
      input.once('error', reject); entry.once('error', reject); input.pipe(entry);
    });
  }
  pack.finalize();
  await completed;
}

export async function buildPortable(output, nodeRuntime = defaultNodeRuntime) {
  if (!nodeRuntime || !fs.existsSync(nodeRuntime)) throw new Error('Linux Node runtime missing. Set AILY_LINUX_NODE_RUNTIME to a Linux x64 node binary.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = path.join(path.dirname(output), `.aily-openai-linux-package-${process.pid}`);
  if (fs.existsSync(temp)) throw new Error(`Temporary package directory already exists: ${temp}`);
  fs.mkdirSync(temp, { recursive: true });
  try {
    copyFile(nodeRuntime, path.join(temp, 'runtime', 'node'), 0o755);
    for (const file of required) copyFile(path.join(root, file), path.join(temp, 'app', file));
    fs.writeFileSync(path.join(temp, 'app', 'installation.json'), JSON.stringify({ dataDir: '$HOME/.local/state/aily-openai' }, null, 2) + '\n', 'utf8');
    for (const item of optional) {
      const source = path.join(root, item);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(temp, item === 'public' ? 'app/public' : item);
      fs.statSync(source).isDirectory() ? copyTree(source, destination) : copyFile(source, destination, item.endsWith('.sh') ? 0o755 : undefined);
    }
    for (const dependency of runtimePackages) copyTree(path.join(root, 'node_modules', dependency), path.join(temp, 'app/node_modules', dependency));
    await writeArchive(temp, path.resolve(output));
    return { package: path.resolve(output), bytes: fs.statSync(output).size, containsCredentials: false, launcher: 'connect-feishu.sh', nodeRuntime: 'linux-x64' };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) { process.stderr.write('Usage: node build-linux.mjs <output.tar.gz>\n'); process.exit(2); }
  try { process.stdout.write(JSON.stringify(await buildPortable(path.resolve(output))) + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
