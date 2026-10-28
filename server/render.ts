import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
/** Render exactly the interactive card page; mock exports make no external requests. */
export class CardRenderer {
  private browser?: Promise<Browser>;
  private pending = new Map<string, Promise<string>>();
  constructor(private readonly pathFor: (id: string) => string) {}
  async render(id: string, origin: string) {
    const existing = this.pending.get(id); if (existing) return existing;
    const job = this.capture(id, origin).finally(() => this.pending.delete(id));
    this.pending.set(id, job); return job;
  }
  private async capture(id: string, origin: string) {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/ms-playwright');
    process.env.TMPDIR = resolve('.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true });
    this.browser ??= import('playwright').then(p => p.chromium.launch({ headless: true })).catch(error => { this.browser = undefined; throw error; });
    const browser = await this.browser;
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    try {
      // Font files are cached locally during setup; no third-party network needed for PNG.
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/card/${encodeURIComponent(id)}?export=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
      await page.evaluate(() => document.fonts.ready);
      const file = this.pathFor(id);
      await page.locator('#card').screenshot({ path: file + '.tmp', type: 'png', animations: 'disabled' });
      await rename(file + '.tmp', file); return file;
    } finally { await page.close(); }
  }
  async close() { await Promise.allSettled(this.pending.values()); if (this.browser) await (await this.browser).close(); }
}
