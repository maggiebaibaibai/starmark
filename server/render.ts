import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright";
/** Render the interactive card with a dedicated, project-local browser profile. */
export class CardRenderer {
  private browser?: Promise<BrowserContext>;
  private workspace?: string;
  private pending = new Map<string, Promise<string>>();
  constructor(private readonly pathFor: (id: string) => string) {}
  async render(
    id: string,
    origin: string,
    options: { live?: boolean; force?: boolean } = {},
  ): Promise<string> {
    const existing = this.pending.get(id);
    if (existing) {
      if (!options.force) return existing;
      // Offline must not reuse an in-flight screenshot of the pre-offline state.
      await existing.catch(() => undefined);
      return this.render(id, origin, options);
    }
    const job = this.cachedCapture(id, origin, options).finally(() =>
      this.pending.delete(id),
    );
    this.pending.set(id, job);
    return job;
  }
  private async cachedCapture(
    id: string,
    origin: string,
    options: { live?: boolean; force?: boolean },
  ) {
    const file = this.pathFor(id);
    if (!options.force) {
      try {
        const age = Date.now() - (await stat(file)).mtimeMs;
        if (!options.live || (age >= 0 && age < 10_000)) return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      // A failed final export must not leave a stale live PNG cached forever.
      await rm(file, { force: true });
    }
    return this.capture(id, origin);
  }
  private async launch() {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".cache/ms-playwright");
    const root = resolve(".cache/tmp");
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, "starmark-render-"));
    this.workspace = workspace;
    const artifactsDir = join(workspace, "artifacts"),
      downloadsPath = join(workspace, "downloads");
    await mkdir(artifactsDir);
    await mkdir(downloadsPath);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    try {
      const { chromium } = await import("playwright");
      return await chromium.launchPersistentContext(
        join(workspace, "profile"),
        {
          channel: "chromium",
          headless: true,
          args: ["--disable-gpu"],
          artifactsDir,
          downloadsPath,
          env: { ...env, TMPDIR: workspace, TMP: workspace, TEMP: workspace },
          viewport: { width: 1080, height: 1350 },
          deviceScaleFactor: 1,
        },
      );
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      this.workspace = undefined;
      throw error;
    }
  }
  private async capture(id: string, origin: string) {
    this.browser ??= this.launch().catch((error) => {
      this.browser = undefined;
      throw error;
    });
    const page = await (await this.browser).newPage();
    try {
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      await page.goto(`${origin}/card/${encodeURIComponent(id)}?export=1`, {
        waitUntil: "networkidle",
      });
      await page.waitForFunction(
        () => document.documentElement.dataset.ready === "true",
      );
      await page.evaluate(() => document.fonts.ready);
      const file = this.pathFor(id);
      await page
        .locator("#card")
        .screenshot({
          path: file + ".tmp",
          type: "png",
          animations: "disabled",
        });
      await rename(file + ".tmp", file);
      return file;
    } finally {
      await page.close();
    }
  }
  async close() {
    await Promise.allSettled(this.pending.values());
    try {
      if (this.browser) await (await this.browser).close();
    } finally {
      if (this.workspace)
        await rm(this.workspace, { recursive: true, force: true });
    }
  }
}
