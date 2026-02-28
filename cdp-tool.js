#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = { host: '127.0.0.1', port: 9222 };
  const positional = [];
  for (const part of argv) {
    if (part.startsWith('--host=')) flags.host = part.slice('--host='.length);
    else if (part.startsWith('--port=')) flags.port = Number(part.slice('--port='.length));
    else if (part.startsWith('--target=')) flags.target = part.slice('--target='.length);
    else if (part.startsWith('--url-contains=')) flags.urlContains = part.slice('--url-contains='.length);
    else if (part.startsWith('--title-contains=')) flags.titleContains = part.slice('--title-contains='.length);
    else positional.push(part);
  }
  return { flags, positional };
}

async function getWebSocketCtor() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.default || mod.WebSocket;
  } catch (err) {
    throw new Error('WebSocket is unavailable. Use Node 22+ or run npm install in tool/ to add ws.');
  }
}

function usage() {
  console.log(`Usage:
  node cdp-tool.js list [--host=127.0.0.1 --port=9222]
  node cdp-tool.js open <url>
  node cdp-tool.js eval <js>
  node cdp-tool.js click <selector>
  node cdp-tool.js type <selector> <text>
  node cdp-tool.js screenshot <out.png>
  node cdp-tool.js logs

Selection flags for commands that target a tab:
  --target=<id>
  --url-contains=<part>
  --title-contains=<part>
`);
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Cannot connect to Chrome DevTools endpoint ${url}. Start Chrome with --remote-debugging-port=9222.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function listTargets(host, port) {
  const targets = await fetchJson(`http://${host}:${port}/json/list`);
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

function pickTarget(targets, flags) {
  if (targets.length === 0) throw new Error('No page targets found');
  if (flags.target) {
    const exact = targets.find((t) => t.id === flags.target);
    if (!exact) throw new Error(`Target id not found: ${flags.target}`);
    return exact;
  }

  let filtered = targets;
  if (flags.urlContains) {
    filtered = filtered.filter((t) => (t.url || '').includes(flags.urlContains));
  }
  if (flags.titleContains) {
    filtered = filtered.filter((t) => (t.title || '').includes(flags.titleContains));
  }

  if (filtered.length === 0) throw new Error('No targets matched the provided filters');
  return filtered[0];
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    const WebSocketCtor = await getWebSocketCtor();
    await new Promise((resolve, reject) => {
      const ws = new WebSocketCtor(this.wsUrl);
      this.ws = ws;

      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id) {
          const cb = this.pending.get(msg.id);
          if (!cb) return;
          this.pending.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else cb.resolve(msg.result || {});
          return;
        }
        if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) for (const h of handlers) h(msg.params || {});
        }
      });
      ws.on('close', () => {
        for (const [, cb] of this.pending) cb.reject(new Error('WebSocket closed'));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  on(method, handler) {
    const list = this.eventHandlers.get(method) || [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  close() {
    if (this.ws && this.ws.readyState === 1) this.ws.close();
  }
}

function jsStringLiteral(value) {
  return JSON.stringify(String(value));
}

function nextScreenshotPath(outPath) {
  const abs = path.resolve(outPath);
  if (!fs.existsSync(abs)) return abs;

  const parsed = path.parse(abs);
  const ext = parsed.ext || '.png';
  const base = parsed.name;
  for (let i = 1; i <= 9999; i += 1) {
    const suffix = String(i).padStart(3, '0');
    const candidate = path.join(parsed.dir, `${base}-${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find free screenshot name near ${abs}`);
}

async function withClient(flags, fn) {
  const targets = await listTargets(flags.host, flags.port);
  const target = pickTarget(targets, flags);
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await fn(client, target);
  } finally {
    client.close();
  }
}

async function cmdList(flags) {
  const targets = await listTargets(flags.host, flags.port);
  if (targets.length === 0) {
    console.log('No page targets.');
    return;
  }
  for (const t of targets) {
    console.log(`${t.id}
  title: ${t.title || '-'}
  url: ${t.url || '-'}
`);
  }
}

async function cmdOpen(flags, url) {
  await withClient(flags, async (client) => {
    await client.send('Page.navigate', { url });
    await client.send('Runtime.evaluate', {
      expression: 'new Promise(r => setTimeout(r, 250))',
      awaitPromise: true
    });
    console.log(`Navigated to ${url}`);
  });
}

async function cmdEval(flags, expression) {
  await withClient(flags, async (client) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      console.error('Evaluation failed');
      console.error(JSON.stringify(result.exceptionDetails, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result.result?.value, null, 2));
  });
}

async function cmdClick(flags, selector) {
  await withClient(flags, async (client) => {
    const expr = `(() => {
      const el = document.querySelector(${jsStringLiteral(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.click();
      return { ok: true };
    })()`;

    const out = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const val = out.result?.value;
    if (!val?.ok) throw new Error(`click failed: ${val?.reason || 'unknown'}`);
    console.log(`Clicked ${selector}`);
  });
}

async function cmdType(flags, selector, text) {
  await withClient(flags, async (client) => {
    const expr = `(() => {
      const el = document.querySelector(${jsStringLiteral(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.focus();
      if ('value' in el) {
        el.value = ${jsStringLiteral(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true };
    })()`;
    const out = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const val = out.result?.value;
    if (!val?.ok) throw new Error(`type failed: ${val?.reason || 'unknown'}`);
    console.log(`Typed into ${selector}`);
  });
}

async function cmdScreenshot(flags, outPath) {
  await withClient(flags, async (client) => {
    const data = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const abs = nextScreenshotPath(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(data.data, 'base64'));
    console.log(`Saved screenshot: ${abs}`);
  });
}

async function cmdLogs(flags) {
  await withClient(flags, async (client, target) => {
    console.log(`Streaming logs for: ${target.title || target.id}`);
    console.log('Press Ctrl+C to stop.');

    client.on('Runtime.consoleAPICalled', (params) => {
      const type = params.type || 'log';
      const parts = (params.args || []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type || 'unknown';
      });
      console.log(`[console.${type}] ${parts.join(' ')}`);
    });

    client.on('Runtime.exceptionThrown', (params) => {
      const text = params.exceptionDetails?.text || 'exception';
      console.log(`[exception] ${text}`);
    });

    await new Promise(() => {});
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  try {
    if (cmd === 'list') return await cmdList(flags);
    if (cmd === 'open') {
      const url = positional[1];
      if (!url) throw new Error('open requires <url>');
      return await cmdOpen(flags, url);
    }
    if (cmd === 'eval') {
      const expression = positional.slice(1).join(' ');
      if (!expression) throw new Error('eval requires <js>');
      return await cmdEval(flags, expression);
    }
    if (cmd === 'click') {
      const selector = positional[1];
      if (!selector) throw new Error('click requires <selector>');
      return await cmdClick(flags, selector);
    }
    if (cmd === 'type') {
      const selector = positional[1];
      const text = positional.slice(2).join(' ');
      if (!selector || !text) throw new Error('type requires <selector> <text>');
      return await cmdType(flags, selector, text);
    }
    if (cmd === 'screenshot') {
      const out = positional[1];
      if (!out) throw new Error('screenshot requires <path>');
      return await cmdScreenshot(flags, out);
    }
    if (cmd === 'logs') return await cmdLogs(flags);

    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
