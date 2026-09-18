import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(REPO, 'dist');
const WORK = path.join(REPO, 'tools', '.work', 'browser-visual');
const SCREENSHOT = path.join(WORK, 'restaurant-editor.png');
const WORLD_SCREENSHOT = path.join(WORK, 'restaurant-world.png');
const META = path.join(WORK, 'restaurant-editor.json');
const GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-editor-world.json',
);

const fixture = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 2,
  items: [
    {
      instance_id: 1,
      item_id: 3020163,
      tile_x: 2,
      tile_y: 2,
      rotation: 3,
      room_index: 0,
    },
  ],
  inventory: [
    {
      item_id: 3020163,
      owned: 2,
      placed: 1,
      available: 1,
    },
  ],
};

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
    }[ext] ?? 'application/octet-stream'
  );
}

function browserCandidates() {
  const values = [
    process.env.RC_BROWSER_EXE,
    process.env['PROGRAMFILES(X86)']
      ? path.join(
          process.env['PROGRAMFILES(X86)'],
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        )
      : null,
    process.env.PROGRAMFILES
      ? path.join(
          process.env.PROGRAMFILES,
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        )
      : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(
          process.env['PROGRAMFILES(X86)'],
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : null,
    process.env.PROGRAMFILES
      ? path.join(
          process.env.PROGRAMFILES,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : null,
  ];
  return [...new Set(values.filter(Boolean))];
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No supported Chromium browser found. Set RC_BROWSER_EXE to Edge/Chrome.',
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file, timeoutMs, processState) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    if (processState.exited) {
      throw new Error(
        `Headless browser exited before DevTools became available. stderr: ${processState.stderr.slice(-4000)}`,
      );
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for Chromium DevTools endpoint. stderr: ${processState.stderr.slice(-4000)}`,
  );
}

async function waitForPageTarget(port, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        cache: 'no-store',
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (target) =>
            target.type === 'page' &&
            typeof target.url === 'string' &&
            target.url.startsWith(url),
        );
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // Chromium may not have bound the DevTools listener yet.
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for Restaurant City DevTools page target');
}

function connectCdp(webSocketDebuggerUrl, diagnostics) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node runtime does not provide the WebSocket API required for CDP');
  }

  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result ?? {});
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      diagnostics.push({
        type: 'exception',
        value:
          message.params?.exceptionDetails?.exception?.description ??
          message.params?.exceptionDetails?.text ??
          'unknown runtime exception',
      });
    }
    if (message.method === 'Log.entryAdded') {
      diagnostics.push({
        type: 'log',
        value: message.params?.entry?.text ?? 'unknown browser log entry',
      });
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    opened,
    send,
    close() {
      socket.close();
    },
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function bufferSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quantizedBlockSignature(png, blockSize = 8) {
  const compact = [];
  for (let y = 0; y < png.height; y += blockSize) {
    for (let x = 0; x < png.width; x += blockSize) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let pixels = 0;
      const maxY = Math.min(png.height, y + blockSize);
      const maxX = Math.min(png.width, x + blockSize);

      for (let py = y; py < maxY; py += 1) {
        for (let px = x; px < maxX; px += 1) {
          const offset = (py * png.width + px) * 4;
          red += png.data[offset];
          green += png.data[offset + 1];
          blue += png.data[offset + 2];
          pixels += 1;
        }
      }

      const quantize = (sum) =>
        Math.min(15, Math.max(0, Math.floor(sum / pixels / 16)));
      const qr = quantize(red);
      const qg = quantize(green);
      const qb = quantize(blue);
      compact.push((qr << 4) | qg, qb << 4);
    }
  }

  return bufferSha256(Buffer.from(compact));
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('Production dist is missing. Run npm run build before visual probe.');
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (requestUrl.pathname === '/api/v1/restaurant') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(fixture));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'VISUAL_PROBE_READ_ONLY' } }));
    return;
  }

  const relative =
    requestUrl.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
  const file = path.resolve(DIST, relative);
  if (file !== DIST && !file.startsWith(`${DIST}${path.sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browserProcess = null;
let cdp = null;

try {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Visual probe server did not expose a TCP port');
  }

  const browser = findBrowser();
  const url = `http://127.0.0.1:${address.port}/`;
  const profile = path.join(WORK, 'profile-cdp');
  const devToolsFile = path.join(profile, 'DevToolsActivePort');
  const processState = { exited: false, stderr: '' };

  browserProcess = spawn(
    browser,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1052,656',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      url,
    ],
    {
      cwd: REPO,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  browserProcess.stderr.setEncoding('utf8');
  browserProcess.stderr.on('data', (chunk) => {
    processState.stderr += chunk;
    if (processState.stderr.length > 32_000) {
      processState.stderr = processState.stderr.slice(-32_000);
    }
  });
  browserProcess.once('exit', () => {
    processState.exited = true;
  });
  browserProcess.once('error', (error) => {
    processState.stderr += `\nspawn error: ${error.message}`;
    processState.exited = true;
  });

  await waitForFile(devToolsFile, 10_000, processState);
  const [portText] = fs.readFileSync(devToolsFile, 'utf8').trim().split(/\r?\n/);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid Chromium DevTools port: ${portText}`);
  }

  const target = await waitForPageTarget(port, url, 10_000);
  const diagnostics = [];
  cdp = connectCdp(target.webSocketDebuggerUrl, diagnostics);
  await cdp.opened;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1052,
    height: 656,
    deviceScaleFactor: 1,
    mobile: false,
  });

  let state = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const status = document.querySelector('.rc-status');
        const selection = document.querySelector('.rc-hud-card');
        const canvas = document.querySelector('#game-canvas-host canvas');
        return {
          phase: status?.dataset.phase ?? null,
          status: status?.textContent ?? '',
          selection: selection?.textContent ?? '',
          canvas: canvas ? (() => {
            const rect = canvas.getBoundingClientRect();
            const webgl2 = canvas.getContext('webgl2');
            const webgl = webgl2 ? null : canvas.getContext('webgl');
            return {
              width: canvas.width,
              height: canvas.height,
              x: rect.x,
              y: rect.y,
              cssWidth: rect.width,
              cssHeight: rect.height,
              renderer: webgl2 ? 'webgl2' : webgl ? 'webgl' : 'canvas2d',
            };
          })() : null,
        };
      })()`,
      returnByValue: true,
    });
    state = evaluated.result?.value ?? null;

    if (state?.phase === 'editing') break;
    if (state?.phase === 'error') {
      throw new Error(
        `Restaurant City entered error phase: ${state.status}. Diagnostics: ${JSON.stringify(diagnostics.slice(-20))}`,
      );
    }
    await delay(100);
  }

  if (state?.phase !== 'editing') {
    throw new Error(
      `Visual probe timed out before editing. State: ${JSON.stringify(state)} Diagnostics: ${JSON.stringify(diagnostics.slice(-20))} Browser stderr: ${processState.stderr.slice(-4000)}`,
    );
  }
  if (!state.status.includes('Loaded baseline 0.9.143a and 1 persisted restaurant item(s).')) {
    throw new Error(`Unexpected editing status: ${state.status}`);
  }
  if (!state.selection.includes('#3020163') || !state.selection.includes('Cannon')) {
    throw new Error(`Recovered Cannon fixture was not selected: ${state.selection}`);
  }
  if (state.canvas?.width !== 760 || state.canvas?.height !== 600) {
    throw new Error(`Unexpected historical canvas size: ${JSON.stringify(state.canvas)}`);
  }

  await delay(250);

  if (
    Math.abs(state.canvas.cssWidth - 760) > 0.01 ||
    Math.abs(state.canvas.cssHeight - 600) > 0.01
  ) {
    throw new Error(
      `Visual gate must capture the world at 1:1 CSS scale; got ${JSON.stringify(state.canvas)}`,
    );
  }

  const worldShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: state.canvas.x,
      y: state.canvas.y,
      width: state.canvas.cssWidth,
      height: state.canvas.cssHeight,
      scale: 1,
    },
  });
  if (typeof worldShot.data !== 'string' || worldShot.data.length === 0) {
    throw new Error('CDP did not return Restaurant City world screenshot bytes');
  }
  fs.writeFileSync(WORLD_SCREENSHOT, Buffer.from(worldShot.data, 'base64'));
  const worldPng = PNG.sync.read(fs.readFileSync(WORLD_SCREENSHOT));
  if (worldPng.width !== 760 || worldPng.height !== 600) {
    throw new Error(
      `Unexpected composited world PNG dimensions: ${worldPng.width}x${worldPng.height}`,
    );
  }
  const worldPixelSha256 = bufferSha256(worldPng.data);
  const worldQuantizedBlockSha256 = quantizedBlockSignature(worldPng, 8);

  if (!fs.existsSync(GOLDEN)) {
    throw new Error(`Restaurant City M2 visual golden is missing: ${GOLDEN}`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  if (
    golden.schemaVersion !== 1 ||
    golden.fixture !== 'cannon-3020163-rotation-3-at-2-2' ||
    golden.canvas?.width !== worldPng.width ||
    golden.canvas?.height !== worldPng.height ||
    golden.blockSize !== 8 ||
    typeof golden.expectedQuantizedBlockSha256 !== 'string'
  ) {
    throw new Error('Restaurant City M2 visual golden contract is malformed');
  }
  if (worldQuantizedBlockSha256 !== golden.expectedQuantizedBlockSha256) {
    throw new Error(
      `Restaurant City M2 visual golden mismatch expected=${golden.expectedQuantizedBlockSha256} actual=${worldQuantizedBlockSha256} pixel=${worldPixelSha256}`,
    );
  }
  const exactPixelMatch = worldPixelSha256 === golden.referencePixelSha256;

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof shot.data !== 'string' || shot.data.length === 0) {
    throw new Error('CDP did not return screenshot bytes');
  }
  fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));

  const stat = fs.statSync(SCREENSHOT);
  if (stat.size < 10_000) {
    throw new Error(`Restaurant City screenshot is unexpectedly small: ${stat.size}`);
  }

  const metadata = {
    schemaVersion: 2,
    browser,
    rendererGate: 'Phaser.AUTO composited through Edge CDP at exact 760x600 CSS scale',
    fixture: 'cannon-3020163-rotation-3-at-2-2',
    viewport: { width: 1052, height: 656, deviceScaleFactor: 1 },
    state,
    diagnostics: diagnostics.slice(-20),
    screenshot: path.relative(REPO, SCREENSHOT).replaceAll('\\', '/'),
    bytes: stat.size,
    sha256: sha256(SCREENSHOT),
    nativeWorld: {
      screenshot: path.relative(REPO, WORLD_SCREENSHOT).replaceAll('\\', '/'),
      width: worldPng.width,
      height: worldPng.height,
      bytes: fs.statSync(WORLD_SCREENSHOT).size,
      pngSha256: sha256(WORLD_SCREENSHOT),
      pixelSha256: worldPixelSha256,
      blockSize: 8,
      quantizedBlockSha256: worldQuantizedBlockSha256,
      golden: {
        path: path.relative(REPO, GOLDEN).replaceAll('\\', '/'),
        expectedQuantizedBlockSha256: golden.expectedQuantizedBlockSha256,
        quantizedBlockMatch: true,
        referencePixelSha256: golden.referencePixelSha256,
        exactPixelMatch,
      },
    },
  };
  fs.writeFileSync(META, `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(
    `BROWSER VISUAL GOLDEN PASS | browser=${browser} | bytes=${stat.size} | sha256=${metadata.sha256} | worldPixel=${worldPixelSha256} | exactPixelMatch=${exactPixelMatch} | worldBlock=${worldQuantizedBlockSha256}`,
  );
} finally {
  try {
    cdp?.close();
  } catch {
    // Best effort during teardown.
  }
  if (browserProcess && !browserProcess.killed) {
    browserProcess.kill();
  }
  await new Promise((resolve) => server.close(resolve));
}
