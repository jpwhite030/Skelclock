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
 */
async function chromiumPath(): Promise<string | undefined> {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');

  const { access } = await import('node:fs/promises');

  try {
    const dirs = await readdir(root);
    const full = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    const shell = dirs.filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse();

    for (const dir of [...full, ...shell]) {
      for (const exe of [
        join(root, dir, 'chrome-win', 'chrome.exe'),
        join(root, dir, 'chrome-win', 'headless_shell.exe'),
      ]) {
        try {
          await access(exe);
          return exe;
        } catch {
          // try the next candidate
        }
      }
    }
  } catch {
    // fall through to the system Chrome below
  }

  for (const exe of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) {
    try {
      await access(exe);
      return exe;
    } catch {
      // keep looking
    }
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
