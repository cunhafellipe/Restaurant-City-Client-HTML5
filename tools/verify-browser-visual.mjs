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
const PUBLIC = path.join(REPO, 'public');
const WORK = path.join(REPO, 'tools', '.work', 'browser-visual');
const SCREENSHOT = path.join(WORK, 'restaurant-editor.png');
const WORLD_SCREENSHOT = path.join(WORK, 'restaurant-world.png');
const META = path.join(WORK, 'restaurant-editor.json');
const STACK_SCREENSHOT = path.join(WORK, 'restaurant-stack.png');
const STACK_META = path.join(WORK, 'restaurant-stack.json');
const FLOOR_SCREENSHOT = path.join(WORK, 'restaurant-floor.png');
const FLOOR_META = path.join(WORK, 'restaurant-floor.json');
const WALL_SCREENSHOT = path.join(WORK, 'restaurant-window.png');
const WALL_META = path.join(WORK, 'restaurant-window.json');
const DOOR_PROBE_SCREENSHOT = path.join(WORK, 'restaurant-door-probe.png');
const DOOR_PROBE_META = path.join(WORK, 'restaurant-door-probe.json');
const DOOR_LEFT_MASK_SCREENSHOT = path.join(
  WORK,
  'restaurant-door-left-mask-probe.png',
);
const DOOR_LEFT_MASK_META = path.join(
  WORK,
  'restaurant-door-left-mask-probe.json',
);
const DOOR_AUTH_SCREENSHOT = path.join(WORK, 'restaurant-door-authoritative.png');
const DOOR_AUTH_META = path.join(WORK, 'restaurant-door-authoritative.json');
const DOOR_LEFT_AUTH_SCREENSHOT = path.join(
  WORK,
  'restaurant-door-left-authoritative.png',
);
const DOOR_LEFT_AUTH_META = path.join(
  WORK,
  'restaurant-door-left-authoritative.json',
);
const DOOR_PROBE_GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-door-probe.json',
);
const STACK_GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-stack.json',
);
const FLOOR_GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-floor.json',
);
const WALL_GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-window.json',
);
const GOLDEN = path.join(
  REPO,
  'tests',
  'golden',
  'm2',
  'restaurant-editor-world.json',
);

const fixtureSeed = {
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
  floor_tiles: [],
  inventory: [
    {
      item_id: 3020163,
      owned: 2,
      placed: 1,
      available: 1,
    },
  ],
};
const doorProbeFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 1,
  items: [],
  floor_tiles: [],
  inventory: [],
};
const doorTopFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 2,
  items: [
    {
      instance_id: 1,
      item_id: 3010000,
      tile_x: 2,
      tile_y: 0,
      rotation: 1,
      room_index: 0,
    },
  ],
  floor_tiles: [],
  inventory: [
    { item_id: 3010000, owned: 1, placed: 1, available: 0 },
  ],
};
const doorLeftFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 2,
  items: [
    {
      instance_id: 1,
      item_id: 3010000,
      tile_x: 0,
      tile_y: 2,
      rotation: 0,
      room_index: 0,
    },
  ],
  floor_tiles: [],
  inventory: [
    { item_id: 3010000, owned: 1, placed: 1, available: 0 },
  ],
};
const wallFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 2,
  items: [
    {
      instance_id: 1,
      item_id: 3000001,
      tile_x: 2,
      tile_y: 0,
      rotation: 1,
      room_index: 0,
    },
  ],
  floor_tiles: [],
  inventory: [
    {
      item_id: 3000001,
      owned: 1,
      placed: 1,
      available: 0,
    },
  ],
};
const floorFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 1,
  items: [],
  floor_tiles: [
    {
      item_id: 3050000,
      tile_x: 2,
      tile_y: 3,
      room_index: 0,
    },
  ],
  inventory: [
    {
      item_id: 3050000,
      owned: 1,
      placed: 1,
      available: 0,
    },
  ],
};
const stackFixtureSeed = {
  room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
  next_instance_id: 3,
  items: [
    {
      instance_id: 1,
      item_id: 3030000,
      tile_x: 3,
      tile_y: 3,
      rotation: 0,
      room_index: 0,
    },
    {
      instance_id: 2,
      item_id: 3020179,
      tile_x: 3,
      tile_y: 3,
      rotation: 0,
      room_index: 0,
    },
  ],
  floor_tiles: [],
  inventory: [
    { item_id: 3030000, owned: 1, placed: 1, available: 0 },
    { item_id: 3020179, owned: 1, placed: 1, available: 0 },
  ],
};
let fixtureState = structuredClone(fixtureSeed);

function integerAttribute(value, field) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  throw new Error(`Visual fixture item has invalid ${field}: ${String(value)}`);
}

function loadFixtureFootprint(itemId) {
  const manifestPath = path.join(PUBLIC, 'assets', 'generated', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restaurant = manifest.data?.find((entry) => entry.id === 'restaurant');
  if (!restaurant?.itemDatabase) {
    throw new Error('Visual probe cannot locate generated restaurant ItemDatabase');
  }

  const databasePath = path.join(
    PUBLIC,
    'assets',
    'generated',
    String(restaurant.itemDatabase).replace(/^\/+/, ''),
  );
  const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  const item = database.groups
    ?.flatMap((group) => group.items ?? [])
    .find((candidate) => integerAttribute(candidate.attributes?.id, 'id') === itemId);
  if (!item) {
    throw new Error(`Visual fixture item #${itemId} is absent from restaurant ItemDatabase`);
  }

  const sizeX = integerAttribute(item.attributes?.sizeX, 'sizeX');
  const sizeY = integerAttribute(item.attributes?.sizeY, 'sizeY');
  if (sizeX <= 0 || sizeY <= 0) {
    throw new Error(`Visual fixture item #${itemId} has invalid footprint ${sizeX}x${sizeY}`);
  }
  return { sizeX, sizeY };
}

function rotatedFootprint(footprint, rotation) {
  return rotation % 2 === 0
    ? footprint
    : { sizeX: footprint.sizeY, sizeY: footprint.sizeX };
}

function tileCenterInCanvas(tileX, tileY, footprint) {
  const x = tileX + footprint.sizeX / 2;
  const y = tileY + footprint.sizeY / 2;
  return {
    x: 380 + (x - y) * 40,
    y: 105 + (x + y) * 20,
  };
}

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

async function readJsonBody(req, maxBytes = 4096) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Visual probe API body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function waitForRuntime(cdp, expression, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    last = evaluated.result?.value ?? null;
    if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

async function dispatchMouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
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

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (
    requestUrl.pathname === '/api/v1/restaurant' &&
    req.method === 'GET'
  ) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(fixtureState));
    return;
  }

  const placementMatch = requestUrl.pathname.match(
    /^\/api\/v1\/restaurant\/placements\/(\d+)$/,
  );
  if (placementMatch && req.method === 'PATCH') {
    try {
      if (!req.headers['idempotency-key']) {
        throw new Error('missing idempotency key');
      }
      const instanceId = Number.parseInt(placementMatch[1], 10);
      const body = await readJsonBody(req);
      const item = fixtureState.items.find(
        (candidate) => candidate.instance_id === instanceId,
      );
      if (!item) {
        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'UNPROCESSABLE' } }));
        return;
      }
      item.tile_x = integerAttribute(body.tile_x, 'tile_x');
      item.tile_y = integerAttribute(body.tile_y, 'tile_y');
      item.rotation = integerAttribute(body.rotation, 'rotation');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ outcome: 'applied', item }));
      return;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }));
      return;
    }
  }

  if (placementMatch && req.method === 'DELETE') {
    if (!req.headers['idempotency-key']) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }));
      return;
    }
    const instanceId = Number.parseInt(placementMatch[1], 10);
    const index = fixtureState.items.findIndex(
      (candidate) => candidate.instance_id === instanceId,
    );
    if (index < 0) {
      res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'UNPROCESSABLE' } }));
      return;
    }
    const [removed] = fixtureState.items.splice(index, 1);
    const inventory = fixtureState.inventory.find(
      (entry) => entry.item_id === removed.item_id,
    );
    if (inventory) {
      inventory.placed = Math.max(0, inventory.placed - 1);
      inventory.available = inventory.owned - inventory.placed;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ outcome: 'applied', item: removed }));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'VISUAL_PROBE_UNSUPPORTED' } }));
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
let browserProfile = null;
let cdp = null;
const goldenFailures = [];

try {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Visual probe server did not expose a TCP port');
  }

  const browser = findBrowser();
  const url = `http://127.0.0.1:${address.port}/?visualProbe=1`;
  browserProfile = path.join(
    WORK,
    `profile-cdp-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(browserProfile, { recursive: true });
  const devToolsFile = path.join(browserProfile, 'DevToolsActivePort');
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
      `--user-data-dir=${browserProfile}`,
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
  if (
    !state.status.includes(
      'Loaded baseline 0.9.143a, 1 persisted object(s), and 0 authoritative floor tile(s).',
    )
  ) {
    throw new Error(`Unexpected editing status: ${state.status}`);
  }
  if (!state.selection.includes('#3020163') || !state.selection.includes('Cannon')) {
    throw new Error(`Recovered Cannon fixture was not selected: ${state.selection}`);
  }
  if (state.canvas?.width !== 760 || state.canvas?.height !== 600) {
    throw new Error(`Unexpected historical canvas size: ${JSON.stringify(state.canvas)}`);
  }

  const wallDiagnosticsEval = await cdp.send('Runtime.evaluate', {
    expression: `globalThis.__ANEWON_RC_VISUAL_DIAGNOSTICS__ ?? null`,
    returnByValue: true,
  });
  const wallDiagnostics = wallDiagnosticsEval.result?.value ?? null;
  if (!wallDiagnostics || !Array.isArray(wallDiagnostics.walls)) {
    throw new Error(
      `Restaurant City visual probe did not expose wall diagnostics: ${JSON.stringify(wallDiagnostics)}`,
    );
  }
  if (wallDiagnostics.walls.length !== 15) {
    throw new Error(
      `Expected 15 derived default wall sprites, got ${wallDiagnostics.walls.length}: ${JSON.stringify(wallDiagnostics.walls)}`,
    );
  }
  if (
    wallDiagnostics.walls.some(
      (wall) => wall.visible !== true || wall.alpha !== 1,
    )
  ) {
    throw new Error(
      `Default wall sprite visibility contract failed: ${JSON.stringify(wallDiagnostics.walls)}`,
    );
  }
  console.log(`WALL RUNTIME DIAGNOSTICS | ${JSON.stringify(wallDiagnostics)}`);

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
  const worldBlockMatch =
    worldQuantizedBlockSha256 === golden.expectedQuantizedBlockSha256;
  if (!worldBlockMatch) {
    goldenFailures.push(
      `world expected=${golden.expectedQuantizedBlockSha256} actual=${worldQuantizedBlockSha256}`,
    );
    console.log(
      `WORLD GOLDEN CANDIDATE | fixture=cannon-3020163-rotation-3-at-2-2 | pixel=${worldPixelSha256} | png=${sha256(WORLD_SCREENSHOT)} | block=${worldQuantizedBlockSha256}`,
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

  const fixtureItem = fixtureSeed.items[0];
  const baseFootprint = loadFixtureFootprint(fixtureItem.item_id);
  const initialFootprint = rotatedFootprint(
    baseFootprint,
    fixtureItem.rotation,
  );
  const initialCenter = tileCenterInCanvas(
    fixtureItem.tile_x,
    fixtureItem.tile_y,
    initialFootprint,
  );
  await dispatchMouseClick(
    cdp,
    state.canvas.x + initialCenter.x,
    state.canvas.y + initialCenter.y,
  );

  const selectedState = await waitForRuntime(
    cdp,
    `(() => {
      const selection = document.querySelector('.rc-hud-card');
      const buttons = [...document.querySelectorAll('.rc-control-button')];
      return {
        selection: selection?.textContent ?? '',
        removeDisabled:
          buttons.find((button) => button.textContent === 'Remove placed')?.disabled ?? true,
        cancelDisabled:
          buttons.find((button) => button.textContent === 'Cancel edit')?.disabled ?? true,
      };
    })()`,
    (value) =>
      value?.selection?.includes('Editing placed #1') &&
      value.removeDisabled === false &&
      value.cancelDisabled === false,
    5000,
    'placed Cannon selection',
  );

  const beforeRotateSelection = selectedState.selection;
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('.rc-control-button')]
        .find((candidate) => candidate.textContent === 'Rotate preview');
      if (!button) throw new Error('Rotate preview button is missing');
      button.click();
      return true;
    })()`,
    returnByValue: true,
  });

  const rotatedState = await waitForRuntime(
    cdp,
    `document.querySelector('.rc-hud-card')?.textContent ?? ''`,
    (value) =>
      typeof value === 'string' &&
      value.includes('Editing placed #1') &&
      value !== beforeRotateSelection,
    5000,
    'placed Cannon rotation preview',
  );

  const rotatedMatch = rotatedState.match(/rot\s+(\d+)/);
  if (!rotatedMatch) {
    throw new Error(`Rotated selection has no rotation: ${rotatedState}`);
  }
  const previewRotation = Number.parseInt(rotatedMatch[1], 10);
  const targetTile = { x: 4, y: 3 };
  // Pointer-to-tile conversion is anchored to the hovered tile, not the
  // footprint center. Using the center of a 1x1 target tile yields fractional
  // coordinates (x+.5,y+.5), which historical ActionScript int conversion
  // deterministically truncates back to the requested tile.
  const targetCenter = tileCenterInCanvas(
    targetTile.x,
    targetTile.y,
    { sizeX: 1, sizeY: 1 },
  );
  await dispatchMouseClick(
    cdp,
    state.canvas.x + targetCenter.x,
    state.canvas.y + targetCenter.y,
  );

  const transformedStatus = await waitForRuntime(
    cdp,
    `document.querySelector('.rc-status')?.textContent ?? ''`,
    (value) =>
      typeof value === 'string' &&
      value.includes('Edit #1 saved and reloaded from authority.'),
    8000,
    'authoritative transform reload',
  );

  const persistedAfterTransform = fixtureState.items[0];
  if (
    !persistedAfterTransform ||
    persistedAfterTransform.tile_x !== targetTile.x ||
    persistedAfterTransform.tile_y !== targetTile.y ||
    persistedAfterTransform.rotation !== previewRotation
  ) {
    throw new Error(
      `Browser transform did not update the authoritative fixture: ${JSON.stringify(fixtureState.items)}`,
    );
  }

  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('.rc-control-button')]
        .find((candidate) => candidate.textContent === 'Remove placed');
      if (!button || button.disabled) throw new Error('Remove placed button is unavailable');
      button.click();
      return true;
    })()`,
    returnByValue: true,
  });

  const removedStatus = await waitForRuntime(
    cdp,
    `(() => ({
      status: document.querySelector('.rc-status')?.textContent ?? '',
      selection: document.querySelector('.rc-hud-card')?.textContent ?? '',
    }))()`,
    (value) =>
      value?.status?.includes('Placed #1 removed and inventory reconciled.') &&
      !value?.selection?.includes('Editing placed #1'),
    8000,
    'authoritative removal reload',
  );

  if (fixtureState.items.length !== 0) {
    throw new Error(
      `Browser removal left authoritative fixture items: ${JSON.stringify(fixtureState.items)}`,
    );
  }
  const inventoryAfterRemove = fixtureState.inventory[0];
  if (
    inventoryAfterRemove?.owned !== 2 ||
    inventoryAfterRemove?.placed !== 0 ||
    inventoryAfterRemove?.available !== 2
  ) {
    throw new Error(
      `Browser removal did not reconcile inventory: ${JSON.stringify(inventoryAfterRemove)}`,
    );
  }

  fixtureState = structuredClone(floorFixtureSeed);
  await cdp.send('Page.reload', { ignoreCache: true });
  const floorState = await waitForRuntime(
    cdp,
    `(() => {
      const status = document.querySelector('.rc-status');
      const canvas = document.querySelector('#game-canvas-host canvas');
      return {
        phase: status?.dataset.phase ?? null,
        status: status?.textContent ?? '',
        canvas: canvas ? (() => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: canvas.width,
            height: canvas.height,
            x: rect.x,
            y: rect.y,
            cssWidth: rect.width,
            cssHeight: rect.height,
          };
        })() : null,
      };
    })()`,
    (value) =>
      value?.phase === 'editing' &&
      value?.status?.includes(
        'Loaded baseline 0.9.143a, 0 persisted object(s), and 1 authoritative floor tile(s).',
      ) &&
      value?.canvas?.width === 760 &&
      value?.canvas?.height === 600,
    8000,
    'Wood Panel authoritative floor',
  );
  await delay(300);

  const floorShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: floorState.canvas.x,
      y: floorState.canvas.y,
      width: floorState.canvas.cssWidth,
      height: floorState.canvas.cssHeight,
      scale: 1,
    },
  });
  if (typeof floorShot.data !== 'string' || floorShot.data.length === 0) {
    throw new Error('CDP did not return Wood Panel floor screenshot bytes');
  }
  fs.writeFileSync(FLOOR_SCREENSHOT, Buffer.from(floorShot.data, 'base64'));
  const floorPng = PNG.sync.read(fs.readFileSync(FLOOR_SCREENSHOT));
  const floorPixelSha256 = bufferSha256(floorPng.data);
  const floorQuantizedBlockSha256 = quantizedBlockSignature(floorPng, 8);
  const floorGolden = fs.existsSync(FLOOR_GOLDEN)
    ? JSON.parse(fs.readFileSync(FLOOR_GOLDEN, 'utf8'))
    : null;
  if (floorGolden) {
    if (
      floorGolden.schemaVersion !== 1 ||
      floorGolden.fixture !== 'wood-panel-3050000-at-2-3' ||
      floorGolden.canvas?.width !== floorPng.width ||
      floorGolden.canvas?.height !== floorPng.height ||
      floorGolden.blockSize !== 8 ||
      floorGolden.expectedQuantizedBlockSha256 !== floorQuantizedBlockSha256
    ) {
      goldenFailures.push(
        `floor expected=${floorGolden.expectedQuantizedBlockSha256} actual=${floorQuantizedBlockSha256}`,
      );
      console.log(
        `FLOOR GOLDEN CANDIDATE | fixture=wood-panel-3050000-at-2-3 | pixel=${floorPixelSha256} | png=${sha256(FLOOR_SCREENSHOT)} | block=${floorQuantizedBlockSha256}`,
      );
    }
  } else {
    console.log(
      `FLOOR GOLDEN CANDIDATE | fixture=wood-panel-3050000-at-2-3 | pixel=${floorPixelSha256} | block=${floorQuantizedBlockSha256}`,
    );
  }
  const floorMetadata = {
    schemaVersion: 1,
    fixture: 'wood-panel-3050000-at-2-3',
    state: floorState,
    screenshot: path.relative(REPO, FLOOR_SCREENSHOT).replaceAll('\\\\', '/'),
    pngSha256: sha256(FLOOR_SCREENSHOT),
    pixelSha256: floorPixelSha256,
    blockSize: 8,
    quantizedBlockSha256: floorQuantizedBlockSha256,
    goldenFrozen: Boolean(floorGolden),
  };
  fs.writeFileSync(FLOOR_META, `${JSON.stringify(floorMetadata, null, 2)}\n`);

  fixtureState = structuredClone(wallFixtureSeed);
  await cdp.send('Page.reload', { ignoreCache: true });
  const wallState = await waitForRuntime(
    cdp,
    `(() => {
      const status = document.querySelector('.rc-status');
      const canvas = document.querySelector('#game-canvas-host canvas');
      return {
        phase: status?.dataset.phase ?? null,
        status: status?.textContent ?? '',
        canvas: canvas ? (() => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: canvas.width,
            height: canvas.height,
            x: rect.x,
            y: rect.y,
            cssWidth: rect.width,
            cssHeight: rect.height,
          };
        })() : null,
      };
    })()`,
    (value) =>
      value?.phase === 'editing' &&
      value?.status?.includes(
        'Loaded baseline 0.9.143a, 1 persisted object(s), and 0 authoritative floor tile(s).',
      ) &&
      value?.canvas?.width === 760 &&
      value?.canvas?.height === 600,
    8000,
    'Simple Window authoritative wall attachment',
  );
  await delay(300);

  const wallShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: wallState.canvas.x,
      y: wallState.canvas.y,
      width: wallState.canvas.cssWidth,
      height: wallState.canvas.cssHeight,
      scale: 1,
    },
  });
  if (typeof wallShot.data !== 'string' || wallShot.data.length === 0) {
    throw new Error('CDP did not return Simple Window screenshot bytes');
  }
  fs.writeFileSync(WALL_SCREENSHOT, Buffer.from(wallShot.data, 'base64'));
  const wallPng = PNG.sync.read(fs.readFileSync(WALL_SCREENSHOT));
  const wallPixelSha256 = bufferSha256(wallPng.data);
  const wallQuantizedBlockSha256 = quantizedBlockSignature(wallPng, 8);
  const wallGolden = fs.existsSync(WALL_GOLDEN)
    ? JSON.parse(fs.readFileSync(WALL_GOLDEN, 'utf8'))
    : null;
  if (wallGolden) {
    if (
      wallGolden.schemaVersion !== 1 ||
      wallGolden.fixture !== 'simple-window-3000001-at-2-0' ||
      wallGolden.canvas?.width !== wallPng.width ||
      wallGolden.canvas?.height !== wallPng.height ||
      wallGolden.blockSize !== 8 ||
      wallGolden.expectedQuantizedBlockSha256 !== wallQuantizedBlockSha256
    ) {
      goldenFailures.push(
        `window expected=${wallGolden.expectedQuantizedBlockSha256} actual=${wallQuantizedBlockSha256}`,
      );
      console.log(
        `WINDOW GOLDEN CANDIDATE | fixture=simple-window-3000001-at-2-0 | pixel=${wallPixelSha256} | png=${sha256(WALL_SCREENSHOT)} | block=${wallQuantizedBlockSha256}`,
      );
    }
  } else {
    console.log(
      `WINDOW GOLDEN CANDIDATE | fixture=simple-window-3000001-at-2-0 | pixel=${wallPixelSha256} | png=${sha256(WALL_SCREENSHOT)} | block=${wallQuantizedBlockSha256}`,
    );
  }
  const wallMetadata = {
    schemaVersion: 1,
    fixture: 'simple-window-3000001-at-2-0',
    state: wallState,
    screenshot: path.relative(REPO, WALL_SCREENSHOT).replaceAll('\\\\', '/'),
    pngSha256: sha256(WALL_SCREENSHOT),
    pixelSha256: wallPixelSha256,
    blockSize: 8,
    quantizedBlockSha256: wallQuantizedBlockSha256,
    goldenFrozen: Boolean(wallGolden),
  };
  fs.writeFileSync(WALL_META, `${JSON.stringify(wallMetadata, null, 2)}\n`);

  fixtureState = structuredClone(stackFixtureSeed);
  await cdp.send('Page.reload', { ignoreCache: true });
  const stackState = await waitForRuntime(
    cdp,
    `(() => {
      const status = document.querySelector('.rc-status');
      const canvas = document.querySelector('#game-canvas-host canvas');
      return {
        phase: status?.dataset.phase ?? null,
        status: status?.textContent ?? '',
        canvas: canvas ? (() => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: canvas.width,
            height: canvas.height,
            x: rect.x,
            y: rect.y,
            cssWidth: rect.width,
            cssHeight: rect.height,
          };
        })() : null,
      };
    })()`,
    (value) =>
      value?.phase === 'editing' &&
      value?.status?.includes(
        'Loaded baseline 0.9.143a, 2 persisted object(s), and 0 authoritative floor tile(s).',
      ) &&
      value?.canvas?.width === 760 &&
      value?.canvas?.height === 600,
    8000,
    'Table + Violin authoritative stack',
  );
  await delay(300);

  const stackShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: stackState.canvas.x,
      y: stackState.canvas.y,
      width: stackState.canvas.cssWidth,
      height: stackState.canvas.cssHeight,
      scale: 1,
    },
  });
  if (typeof stackShot.data !== 'string' || stackShot.data.length === 0) {
    throw new Error('CDP did not return Table + Violin stack screenshot bytes');
  }
  fs.writeFileSync(STACK_SCREENSHOT, Buffer.from(stackShot.data, 'base64'));
  const stackPng = PNG.sync.read(fs.readFileSync(STACK_SCREENSHOT));
  const stackPixelSha256 = bufferSha256(stackPng.data);
  const stackQuantizedBlockSha256 = quantizedBlockSignature(stackPng, 8);
  const stackGolden = fs.existsSync(STACK_GOLDEN)
    ? JSON.parse(fs.readFileSync(STACK_GOLDEN, 'utf8'))
    : null;
  if (stackGolden) {
    if (
      stackGolden.schemaVersion !== 1 ||
      stackGolden.fixture !== 'table-3030000-plus-violin-3020179-at-3-3' ||
      stackGolden.canvas?.width !== stackPng.width ||
      stackGolden.canvas?.height !== stackPng.height ||
      stackGolden.blockSize !== 8 ||
      stackGolden.expectedQuantizedBlockSha256 !== stackQuantizedBlockSha256
    ) {
      goldenFailures.push(
        `stack expected=${stackGolden.expectedQuantizedBlockSha256} actual=${stackQuantizedBlockSha256}`,
      );
      console.log(
        `STACK GOLDEN CANDIDATE | fixture=table-3030000-plus-violin-3020179-at-3-3 | pixel=${stackPixelSha256} | png=${sha256(STACK_SCREENSHOT)} | block=${stackQuantizedBlockSha256}`,
      );
    }
  }
  const stackMetadata = {
    schemaVersion: 1,
    fixture: 'table-3030000-plus-violin-3020179-at-3-3',
    state: stackState,
    expectedHistoricalCurHeightPx: 25,
    screenshot: path.relative(REPO, STACK_SCREENSHOT).replaceAll('\\\\', '/'),
    pngSha256: sha256(STACK_SCREENSHOT),
    pixelSha256: stackPixelSha256,
    blockSize: 8,
    quantizedBlockSha256: stackQuantizedBlockSha256,
    goldenFrozen: Boolean(stackGolden),
  };
  fs.writeFileSync(STACK_META, `${JSON.stringify(stackMetadata, null, 2)}\n`);

  fixtureState = structuredClone(doorProbeFixtureSeed);
  await cdp.send('Page.navigate', { url: `${url}&doorProbe=1` });
  const doorProbeState = await waitForRuntime(
    cdp,
    `(() => {
      const status = document.querySelector('.rc-status');
      const canvas = document.querySelector('#game-canvas-host canvas');
      return {
        phase: status?.dataset.phase ?? null,
        status: status?.textContent ?? '',
        probe: globalThis.__ANEWON_RC_DOOR_PROBE__ ?? null,
        canvas: canvas ? (() => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: canvas.width,
            height: canvas.height,
            x: rect.x,
            y: rect.y,
            cssWidth: rect.width,
            cssHeight: rect.height,
          };
        })() : null,
      };
    })()`,
    (value) =>
      value?.phase === 'editing' &&
      value?.status?.includes(
        'Loaded baseline 0.9.143a, 0 persisted object(s), and 0 authoritative floor tile(s).',
      ) &&
      value?.probe?.rotation === 1 &&
      value?.probe?.wallFrame === 'indoor_asset/wall2/002' &&
      value?.probe?.maskFrame === 'indoor_asset/doorwaymask/001' &&
      value?.probe?.doorFrame === 'indoor_asset/door/002' &&
      value?.canvas?.width === 760 &&
      value?.canvas?.height === 600,
    8000,
    'Simple Door erase composition probe',
  );
  await delay(300);

  const doorShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: doorProbeState.canvas.x,
      y: doorProbeState.canvas.y,
      width: doorProbeState.canvas.cssWidth,
      height: doorProbeState.canvas.cssHeight,
      scale: 1,
    },
  });
  if (typeof doorShot.data !== 'string' || doorShot.data.length === 0) {
    throw new Error('CDP did not return Simple Door erase probe screenshot bytes');
  }
  fs.writeFileSync(
    DOOR_PROBE_SCREENSHOT,
    Buffer.from(doorShot.data, 'base64'),
  );
  const doorPng = PNG.sync.read(fs.readFileSync(DOOR_PROBE_SCREENSHOT));
  const doorPixelSha256 = bufferSha256(doorPng.data);
  const doorQuantizedBlockSha256 = quantizedBlockSignature(doorPng, 8);
  const doorPngSha256 = sha256(DOOR_PROBE_SCREENSHOT);
  const doorGolden = fs.existsSync(DOOR_PROBE_GOLDEN)
    ? JSON.parse(fs.readFileSync(DOOR_PROBE_GOLDEN, 'utf8'))
    : null;
  if (doorGolden) {
    if (
      doorGolden.schemaVersion !== 1 ||
      doorGolden.fixture !== 'simple-door-3010000-erase-probe-at-2-0' ||
      doorGolden.canvas?.width !== doorPng.width ||
      doorGolden.canvas?.height !== doorPng.height ||
      doorGolden.blockSize !== 8 ||
      doorGolden.expectedQuantizedBlockSha256 !== doorQuantizedBlockSha256
    ) {
      goldenFailures.push(
        `door expected=${doorGolden.expectedQuantizedBlockSha256} actual=${doorQuantizedBlockSha256}`,
      );
      console.log(
        `DOOR GOLDEN CANDIDATE | fixture=simple-door-3010000-erase-probe-at-2-0 | pixel=${doorPixelSha256} | png=${doorPngSha256} | block=${doorQuantizedBlockSha256} | maskLocal=${JSON.stringify(doorProbeState.probe.maskLocal)}`,
      );
    }
  } else {
    console.log(
      `DOOR GOLDEN CANDIDATE | fixture=simple-door-3010000-erase-probe-at-2-0 | pixel=${doorPixelSha256} | png=${doorPngSha256} | block=${doorQuantizedBlockSha256} | maskLocal=${JSON.stringify(doorProbeState.probe.maskLocal)}`,
    );
  }
  const doorProbeMetadata = {
    schemaVersion: 1,
    fixture: 'simple-door-3010000-erase-probe-at-2-0',
    state: doorProbeState,
    screenshot: path
      .relative(REPO, DOOR_PROBE_SCREENSHOT)
      .replaceAll('\\\\', '/'),
    pngSha256: doorPngSha256,
    pixelSha256: doorPixelSha256,
    blockSize: 8,
    quantizedBlockSha256: doorQuantizedBlockSha256,
    goldenFrozen: Boolean(doorGolden),
    golden: doorGolden
      ? {
          path: path.relative(REPO, DOOR_PROBE_GOLDEN).replaceAll('\\\\', '/'),
          expectedQuantizedBlockSha256:
            doorGolden.expectedQuantizedBlockSha256,
          quantizedBlockMatch:
            doorGolden.expectedQuantizedBlockSha256 === doorQuantizedBlockSha256,
          referencePixelSha256: doorGolden.referencePixelSha256 ?? null,
          exactPixelMatch:
            doorGolden.referencePixelSha256 === doorPixelSha256,
        }
      : null,
  };
  fs.writeFileSync(
    DOOR_PROBE_META,
    `${JSON.stringify(doorProbeMetadata, null, 2)}\n`,
  );

  fixtureState = structuredClone(doorProbeFixtureSeed);
  await cdp.send('Page.navigate', {
    url: `${url}&doorProbe=1&doorProbeRotation=0&doorMaskOnly=1`,
  });
  const doorLeftMaskState = await waitForRuntime(
    cdp,
    `(() => {
      const status = document.querySelector('.rc-status');
      const canvas = document.querySelector('#game-canvas-host canvas');
      return {
        phase: status?.dataset.phase ?? null,
        status: status?.textContent ?? '',
        probe: globalThis.__ANEWON_RC_DOOR_PROBE__ ?? null,
        canvas: canvas ? (() => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: canvas.width,
            height: canvas.height,
            x: rect.x,
            y: rect.y,
            cssWidth: rect.width,
            cssHeight: rect.height,
          };
        })() : null,
      };
    })()`,
    (value) =>
      value?.phase === 'editing' &&
      value?.probe?.rotation === 0 &&
      value?.probe?.tile?.x === 0 &&
      value?.probe?.tile?.y === 2 &&
      value?.probe?.maskOnly === true &&
      value?.probe?.wallFrame === 'indoor_asset/wall2/001' &&
      value?.probe?.maskFrame === 'indoor_asset/doorwaymask/001' &&
      value?.probe?.doorFrame === null &&
      value?.canvas?.width === 760 &&
      value?.canvas?.height === 600,
    8000,
    'Simple Door left-wall erase-mask probe',
  );
  await delay(300);

  const doorLeftMaskShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: doorLeftMaskState.canvas.x,
      y: doorLeftMaskState.canvas.y,
      width: doorLeftMaskState.canvas.cssWidth,
      height: doorLeftMaskState.canvas.cssHeight,
      scale: 1,
    },
  });
  if (
    typeof doorLeftMaskShot.data !== 'string' ||
    doorLeftMaskShot.data.length === 0
  ) {
    throw new Error('CDP did not return Simple Door left-wall mask screenshot');
  }
  fs.writeFileSync(
    DOOR_LEFT_MASK_SCREENSHOT,
    Buffer.from(doorLeftMaskShot.data, 'base64'),
  );
  const doorLeftMaskPng = PNG.sync.read(
    fs.readFileSync(DOOR_LEFT_MASK_SCREENSHOT),
  );
  const doorLeftMaskMetadata = {
    schemaVersion: 1,
    fixture: 'simple-door-3010000-left-mask-probe-at-0-2',
    state: doorLeftMaskState,
    screenshot: path
      .relative(REPO, DOOR_LEFT_MASK_SCREENSHOT)
      .replaceAll('\\\\', '/'),
    pngSha256: sha256(DOOR_LEFT_MASK_SCREENSHOT),
    pixelSha256: bufferSha256(doorLeftMaskPng.data),
    blockSize: 8,
    quantizedBlockSha256: quantizedBlockSignature(doorLeftMaskPng, 8),
    goldenFrozen: false,
  };
  fs.writeFileSync(
    DOOR_LEFT_MASK_META,
    `${JSON.stringify(doorLeftMaskMetadata, null, 2)}\n`,
  );
  console.log(
    `DOOR LEFT MASK PROBE CANDIDATE | fixture=simple-door-3010000-left-mask-probe-at-0-2 | pixel=${doorLeftMaskMetadata.pixelSha256} | png=${doorLeftMaskMetadata.pngSha256} | block=${doorLeftMaskMetadata.quantizedBlockSha256} | maskLocal=${JSON.stringify(doorLeftMaskState.probe.maskLocal)}`,
  );

  async function captureAuthoritativeDoor(
    seed,
    fixture,
    expectedFrame,
    screenshotFile,
    metadataFile,
  ) {
    fixtureState = structuredClone(seed);
    await cdp.send('Page.navigate', { url });
    const authorityState = await waitForRuntime(
      cdp,
      `(() => {
        const status = document.querySelector('.rc-status');
        const canvas = document.querySelector('#game-canvas-host canvas');
        const visual = globalThis.__ANEWON_RC_VISUAL_DIAGNOSTICS__ ?? null;
        return {
          phase: status?.dataset.phase ?? null,
          status: status?.textContent ?? '',
          committedFrame: visual?.committed?.[0]?.frame ?? null,
          committedDepth: visual?.committed?.[0]?.depth ?? null,
          canvas: canvas ? (() => {
            const rect = canvas.getBoundingClientRect();
            return {
              width: canvas.width,
              height: canvas.height,
              x: rect.x,
              y: rect.y,
              cssWidth: rect.width,
              cssHeight: rect.height,
            };
          })() : null,
        };
      })()`,
      (value) =>
        value?.phase === 'editing' &&
        value?.status?.includes(
          'Loaded baseline 0.9.143a, 1 persisted object(s), and 0 authoritative floor tile(s).',
        ) &&
        value?.committedFrame === expectedFrame &&
        value?.canvas?.width === 760 &&
        value?.canvas?.height === 600,
      8000,
      fixture,
    );
    await delay(300);

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: authorityState.canvas.x,
        y: authorityState.canvas.y,
        width: authorityState.canvas.cssWidth,
        height: authorityState.canvas.cssHeight,
        scale: 1,
      },
    });
    if (typeof shot.data !== 'string' || shot.data.length === 0) {
      throw new Error(`CDP did not return ${fixture} screenshot bytes`);
    }
    fs.writeFileSync(screenshotFile, Buffer.from(shot.data, 'base64'));
    const png = PNG.sync.read(fs.readFileSync(screenshotFile));
    const result = {
      schemaVersion: 1,
      fixture,
      state: authorityState,
      screenshot: path.relative(REPO, screenshotFile).replaceAll('\\\\', '/'),
      pngSha256: sha256(screenshotFile),
      pixelSha256: bufferSha256(png.data),
      blockSize: 8,
      quantizedBlockSha256: quantizedBlockSignature(png, 8),
      goldenFrozen: false,
    };
    fs.writeFileSync(
      metadataFile,
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(
      `DOOR AUTHORITY CANDIDATE | fixture=${fixture} | frame=${expectedFrame} | depth=${authorityState.committedDepth} | pixel=${result.pixelSha256} | png=${result.pngSha256} | block=${result.quantizedBlockSha256}`,
    );
    return result;
  }

  const doorAuthoritativeMetadata = await captureAuthoritativeDoor(
    doorTopFixtureSeed,
    'simple-door-3010000-authoritative-at-2-0',
    'indoor_asset/door/002',
    DOOR_AUTH_SCREENSHOT,
    DOOR_AUTH_META,
  );
  const doorLeftAuthoritativeMetadata = await captureAuthoritativeDoor(
    doorLeftFixtureSeed,
    'simple-door-3010000-authoritative-at-0-2',
    'indoor_asset/door/001',
    DOOR_LEFT_AUTH_SCREENSHOT,
    DOOR_LEFT_AUTH_META,
  );

  const metadata = {
    schemaVersion: 2,
    browser,
    rendererGate: 'Phaser.AUTO composited through Edge CDP at exact 760x600 CSS scale',
    fixture: 'cannon-3020163-rotation-3-at-2-2',
    viewport: { width: 1052, height: 656, deviceScaleFactor: 1 },
    state,
    diagnostics: diagnostics.slice(-20),
    wallRuntimeDiagnostics: wallDiagnostics,
    stackVisual: stackMetadata,
    floorVisual: floorMetadata,
    wallVisual: wallMetadata,
    doorProbeVisual: doorProbeMetadata,
    doorLeftMaskProbeVisual: doorLeftMaskMetadata,
    doorAuthoritativeVisual: doorAuthoritativeMetadata,
    doorLeftAuthoritativeVisual: doorLeftAuthoritativeMetadata,
    interaction: {
      selected: selectedState.selection,
      rotated: rotatedState,
      transformedStatus,
      removedStatus,
      targetTile,
      previewRotation,
      finalInventory: inventoryAfterRemove,
      passed: true,
    },
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
        quantizedBlockMatch: worldBlockMatch,
        referencePixelSha256: golden.referencePixelSha256,
        exactPixelMatch,
      },
    },
  };
  fs.writeFileSync(META, `${JSON.stringify(metadata, null, 2)}\n`);

  if (goldenFailures.length > 0) {
    throw new Error(
      `Restaurant City visual golden migration required: ${goldenFailures.join(' | ')}`,
    );
  }

  console.log(
    `BROWSER VISUAL GOLDEN + EDIT INTERACTION PASS | browser=${browser} | bytes=${stat.size} | sha256=${metadata.sha256} | worldPixel=${worldPixelSha256} | exactPixelMatch=${exactPixelMatch} | worldBlock=${worldQuantizedBlockSha256} | edit=select-transform-remove | floor=WoodPanel block=${floorQuantizedBlockSha256} frozen=${Boolean(floorGolden)} | window=SimpleWindow block=${wallQuantizedBlockSha256} frozen=${Boolean(wallGolden)} | stack=Table+Violin curHeight=25 block=${stackQuantizedBlockSha256} frozen=${Boolean(stackGolden)} | door=SimpleDoor block=${doorQuantizedBlockSha256} frozen=${Boolean(doorGolden)}`,
  );
} finally {
  try {
    cdp?.close();
  } catch {
    // Best effort during teardown.
  }
  if (browserProcess && !browserProcess.killed) {
    browserProcess.kill();
    await delay(150);
  }
  if (browserProfile) {
    try {
      fs.rmSync(browserProfile, { recursive: true, force: true });
    } catch {
      // A crashed Chromium may hold transient locks on Windows. Profiles are
      // unique per probe, so cleanup is best-effort and never blocks another run.
    }
  }
  await new Promise((resolve) => server.close(resolve));
}
