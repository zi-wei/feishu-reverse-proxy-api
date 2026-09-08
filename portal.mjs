import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/lucide.js', ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8']],
]);

export class Portal {
  constructor(config, auth) { this.config = config; this.auth = auth; this.tokens = new Map(); }
  serve(pathname, res) {
    const asset = files.get(pathname);
    if (!asset) return false;
    const content = fs.readFileSync(fileURLToPath(new URL(asset[0], import.meta.url)));
    res.writeHead(200, { 'content-type': asset[1], 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'" });
    res.end(content); return true;
  }
  issue(port) {
    const now = Date.now();
    for (const [key, expiry] of this.tokens) if (expiry <= now) this.tokens.delete(key);
    if (this.tokens.size >= 20) this.tokens.delete(this.tokens.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, now + 60000);
    return { url: `http://127.0.0.1:${port}/#connect=${token}` };
  }
  redeem(token, port) {
    const expiry = this.tokens.get(token); this.tokens.delete(token);
    if (!expiry || expiry <= Date.now()) return null;
    return this.settings(port);
  }
  settings(port) {
    return { base_url: `http://127.0.0.1:${port}/v1`, api_key: this.auth.apiKey, model: this.config.model,
      assistant_name: this.config.agentName || this.config.model, avatar_url: this.config.avatarUrl || '', local_only: true };
  }
}
