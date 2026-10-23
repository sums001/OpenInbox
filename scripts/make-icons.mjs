// Renders the app icon (src/web/public/favicon.svg) to the PNG sizes the web app manifest needs.
// Uses Playwright's Chromium (a dev dependency): `npx playwright install chromium` first.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../src/web/public/favicon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Maskable icons need a safe zone: draw the mark at 80% on the brand background.
  await page.setContent(`<html><body style="margin:0;background:#5b52e8;display:grid;place-items:center;height:100vh">
    <div style="width:${Math.round(size * 0.8)}px;height:${Math.round(size * 0.8)}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: new URL(`../src/web/public/icon-${size}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
  await page.close();
  console.log(`icon-${size}.png`);
}
await browser.close();
