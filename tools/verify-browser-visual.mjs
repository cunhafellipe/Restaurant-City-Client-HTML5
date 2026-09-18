import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(REPO, 'dist');
const WORK = path.join(REPO, 'tools', '.work', 'browser-visual');
const SCREENSHOT = path.join(WORK, 'restaurant-editor.png');
const META = path.join(WORK, 'restaurant-editor.json');

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

function runBrowser(browser, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, {
      cwd: REPO,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Headless browser failed with exit ${code}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function baseBrowserArgs(profile, url) {
  return [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,720',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=8000',
    `--user-data-dir=${profile}`,
    url,
  ];
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

try {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Visual probe server did not expose a TCP port');
  }

  const browser = findBrowser();
  const url = `http://127.0.0.1:${address.port}/`;
  const dumpProfile = path.join(WORK, 'profile-dom');
  const shotProfile = path.join(WORK, 'profile-shot');

  const dom = await runBrowser(browser, [
    ...baseBrowserArgs(dumpProfile, url),
    '--dump-dom',
  ]);

  if (!/data-phase="editing"/.test(dom.stdout)) {
    throw new Error(
      `Visual probe never reached editing phase. DOM: ${dom.stdout.slice(-4000)}`,
    );
  }
  if (!dom.stdout.includes('Loaded baseline 0.9.143a and 1 persisted restaurant item(s).')) {
    throw new Error('Visual probe did not load the authoritative persisted fixture');
  }
  if (!dom.stdout.includes('#3020163') || !dom.stdout.includes('Cannon')) {
    throw new Error('Visual probe did not select the recovered Cannon fixture');
  }

  await runBrowser(browser, [
    ...baseBrowserArgs(shotProfile, url),
    `--screenshot=${SCREENSHOT}`,
  ]);

  if (!fs.existsSync(SCREENSHOT)) {
    throw new Error('Headless browser did not produce the Restaurant City screenshot');
  }
  const stat = fs.statSync(SCREENSHOT);
  if (stat.size < 10_000) {
    throw new Error(`Restaurant City screenshot is unexpectedly small: ${stat.size}`);
  }

  const metadata = {
    schemaVersion: 1,
    browser,
    fixture: 'cannon-3020163-rotation-3-at-2-2',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    phase: 'editing',
    screenshot: path.relative(REPO, SCREENSHOT).replaceAll('\\', '/'),
    bytes: stat.size,
    sha256: sha256(SCREENSHOT),
  };
  fs.writeFileSync(META, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(
    `BROWSER VISUAL PROBE PASS | browser=${browser} | bytes=${stat.size} | sha256=${metadata.sha256}`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
