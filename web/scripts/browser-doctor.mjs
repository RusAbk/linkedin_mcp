import os from 'node:os';
import { chromium } from 'playwright';

const started = performance.now();
const headless = ['true', '1'].includes(process.env.LINKEDIN_HEADLESS ?? 'false');
const report = (stage, details = {}) => console.log(JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started), ...details }));
let context, session;
async function bounded(promise, milliseconds, stage) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${stage}: timeout after ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

try {
  report('environment', { node: process.version, cpus: os.availableParallelism(), headless, display: process.env.DISPLAY ?? 'unset', freeMemoryMiB: Math.round(os.freemem() / 1048576) });
  report('launching Chrome with a temporary profile');
  // Empty userDataDir lets Playwright create and remove its own temporary profile.
  context = await chromium.launchPersistentContext('', { channel: 'chrome', headless, timeout: 20_000, viewport: { width: 1440, height: 1000 } });
  report('Chrome ready', { version: context.browser()?.version() });
  const page = context.pages()[0] ?? await bounded(context.newPage(), 5_000, 'new page');
  await page.setContent('<!doctype html><title>Browser check</title><h1>LinkedIn MCP browser check</h1><p>Local page, no network or user session.</p>', { waitUntil: 'domcontentloaded', timeout: 5_000 });
  await bounded(page.bringToFront(), 5_000, 'bring page to front');
  session = await bounded(context.newCDPSession(page), 5_000, 'CDP connection');
  const firstFrame = new Promise(resolve => { session.once('Page.screencastFrame', event => resolve(event.data.length)); });
  await bounded(session.send('Page.enable'), 5_000, 'Page.enable');
  await bounded(session.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1120, maxHeight: 778 }), 5_000, 'start frame stream');
  const frameBytes = await bounded(firstFrame, 5_000, 'first frame');
  report('frame received', { base64Bytes: frameBytes });
  report('PASS');
} catch (error) { report('FAIL', { message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
finally {
  await bounded(session?.detach() ?? Promise.resolve(), 2_000, 'disconnect').catch(() => {});
  await bounded(context?.close() ?? Promise.resolve(), 5_000, 'close Chrome').catch(() => {});
  // Ensure a broken browser connection cannot keep this diagnostic running.
  process.exit(process.exitCode ?? 0);
}
