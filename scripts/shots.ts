/**
 * Screenshots the dashboard, so a design change can be looked at rather than
 * only compiled.
 *
 *   npm run shots            capture all screens at desktop and laptop
 *   npm run shots -- before  write them into a named folder for comparison
 *
 * Uses the Chromium that Playwright has already installed on this machine, via
 * playwright-core — so there is no browser download and nothing large added to
 * the repo's dependencies.
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const BASE = process.env.SHOTS_BASE_URL ?? 'http://localhost:3100';
const LABEL = process.argv[2] ?? 'current';
const OUT = join(process.cwd(), '.shots', LABEL);

const PAGES = [
  { path: '/', name: 'working-now' },
  { path: '/timesheets', name: 'timesheets' },
  { path: '/exceptions', name: 'exceptions' },
  { path: '/sites', name: 'sites' },
  { path: '/sync', name: 'odoo-sync' },
  { path: '/settings', name: 'settings' },
  { path: '/employees', name: 'employees' },
] as const;

const VIEWPORTS = [
  { name: 'desktop', width: 1680, height: 1050 },
  { name: 'laptop', width: 1280, height: 800 },
] as const;

/**
 * Finds the Chromium that Playwright already downloaded.
 *
 * playwright-core does not ship browsers and does not know where the full
 * `playwright` package put them, so the install directory is resolved by hand.
 * Prefers a full chromium build over the headless shell — the shell renders
 * fonts differently, which is exactly what these screenshots are checking.
 *
 * Every platform lays this out differently, and the cache root moves too, so
 * both are per-platform rather than one path with a swapped separator.
 */
function browserRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (process.platform === 'darwin') {
    return join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
  }
  return join(process.env.HOME ?? '', '.cache', 'ms-playwright');
}

/** Where the executable sits inside one downloaded browser directory. */
function executablesIn(dir: string): string[] {
  if (process.platform === 'win32') {
    return [
      join(dir, 'chrome-win', 'chrome.exe'),
      join(dir, 'chrome-win', 'headless_shell.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    // Both architectures, because a machine can run either and the directory
    // name is the only thing that says which was downloaded.
    return ['arm64', 'x64'].flatMap((arch) => [
      join(
        dir,
        `chrome-mac-${arch}`,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ),
      join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(dir, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'),
    ]);
  }
  return [
    join(dir, 'chrome-linux', 'chrome'),
    join(dir, 'chrome-linux', 'headless_shell'),
    join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  ];
}

/** Installed browsers of last resort, when Playwright has downloaded none. */
function systemBrowsers(): string[] {
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

async function chromiumPath(): Promise<string | undefined> {
  const root = browserRoot();
  const { access } = await import('node:fs/promises');

  const exists = async (exe: string) => {
    try {
      await access(exe);
      return true;
    } catch {
      return false;
    }
  };

  try {
    const dirs = await readdir(root);
    const full = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    const shell = dirs.filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse();

    for (const dir of [...full, ...shell]) {
      for (const exe of executablesIn(join(root, dir))) {
        if (await exists(exe)) return exe;
      }
    }
  } catch {
    // fall through to an installed browser below
  }

  for (const exe of systemBrowsers()) {
    if (await exists(exe)) return exe;
  }
  return undefined;
}

async function main(): Promise<void> {
  const executablePath = await chromiumPath();
  if (!executablePath) {
    console.error('No Chromium found. Install one with: npx playwright install chromium');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  console.log(`Browser: ${executablePath}`);
  console.log(`Writing to ${OUT}\n`);

  const browser = await chromium.launch({ executablePath });

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        // Retina, so hinting and letter-spacing are judged the way they will
        // actually be seen rather than on a blurry 1x raster.
        deviceScaleFactor: 2,
        colorScheme: 'dark',
      });
      const page = await context.newPage();

      for (const target of PAGES) {
        const url = `${BASE}${target.path}`;
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
          // Web fonts swap in after first paint; screenshotting before they
          // land would judge the fallback stack instead of the real design.
          // Evaluated in the browser, so `document` is not in this file's libs.
          await page.evaluate('document.fonts.ready');
          await page.waitForTimeout(400);

          const file = join(OUT, `${target.name}-${viewport.name}.png`);
          await page.screenshot({ path: file, fullPage: true });
          console.log(`  ✓ ${target.name} @ ${viewport.name}`);
        } catch (error) {
          console.error(
            `  ✗ ${target.name} @ ${viewport.name}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
