import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PQueue from 'p-queue';
import type { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer';
import { shrinkImagesForPdf, waitForPageAssets } from './helpers/page-assets';

type RenderLabel = 'WebP' | 'PDF';

/** PDF images: at most 2 image pixels per CSS pixel; JPEG quality of the re-encoded ones. */
const PDF_IMAGE_SCALE = 2;
const PDF_IMAGE_JPEG_QUALITY = 0.8;

/** How long a job waits for its tab to close: a hung renderer must not hold the job forever. */
const PAGE_CLOSE_GRACE_MS = 2000;

/** How long a retired browser gets to close before its process is killed (a hung Chrome never answers). */
const BROWSER_CLOSE_GRACE_MS = 5000;

/**
 * A launched browser and the renders on it. Once retired it takes no new render and is closed
 * when its own renders end.
 */
type BrowserSlot = {
  browser: Browser;
  /** Renders started on it since its launch. */
  jobs: number;
  /** Renders on it not finished yet. */
  live: number;
  retired: boolean;
  closing: boolean;
  closeTimer?: NodeJS.Timeout;
};

/** Waits for `task` at most `ms`: true when it settled (either way) in time. */
async function settlesWithin(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultLaunchOptions: Parameters<typeof puppeteer.launch>[0] = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
  ],
};

@Injectable()
export class PuppeteerBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerBrowserService.name);
  private readonly queue: PQueue;
  /** The browser new renders go to; `null` until the next job launches one. */
  private current: BrowserSlot | null = null;
  private connectPromise: Promise<BrowserSlot> | null = null;
  /** Every launched browser not closed yet: the current one and retired ones still draining. */
  private readonly openSlots = new Set<BrowserSlot>();

  /** Renders a browser serves before it is recycled. */
  private readonly MAX_JOBS = 50;

  constructor(private readonly config: ConfigService) {
    const concurrency = 2;
    this.queue = new PQueue({ concurrency });
  }

  private get maxWaiting(): number {
    return 300;
  }

  private get jobTimeoutMs(): number {
    return 8000;
  }

  /**
   * p-queue's own deadline, a safety net behind the one `renderJob` enforces itself: it
   * only fires when opening the browser or a tab hangs past the job deadline.
   */
  private get queueTimeoutMs(): number {
    return this.jobTimeoutMs + 5000;
  }

  async captureWebpFromHtml(html: string): Promise<Buffer> {
    if (this.maxWaiting > 0 && this.queue.size >= this.maxWaiting) {
      this.logger.warn(
        `WebP queue saturated: waiting=${this.queue.size} maxWaiting=${this.maxWaiting}`,
      );
      throw new ServiceUnavailableException('puppeteer_webp_queue_saturated');
    }

    return this.enqueue('WebP', () => this.screenshotWebpJob(html));
  }

  /**
   * One-page PDF of the HTML, the page sized to the rendered document (no blank A4
   * margins). Same shared browser, queue, saturation limit and timeout as the WebP.
   */
  async capturePdfFromHtml(html: string): Promise<Buffer> {
    if (this.maxWaiting > 0 && this.queue.size >= this.maxWaiting) {
      this.logger.warn(
        `PDF queue saturated: waiting=${this.queue.size} maxWaiting=${this.maxWaiting}`,
      );
      throw new ServiceUnavailableException('puppeteer_pdf_queue_saturated');
    }

    return this.enqueue('PDF', () => this.renderJob('PDF', html, (page) => this.printSizedPdf(page)));
  }

  /**
   * Queues a render. `throwOnTimeout`: without it p-queue resolves a timed-out job with
   * `undefined` (callers then fail on `.length`) and frees the slot while the render runs on.
   */
  private async enqueue(label: RenderLabel, job: () => Promise<Buffer>): Promise<Buffer> {
    try {
      return (await this.queue.add(job, {
        timeout: this.queueTimeoutMs,
        throwOnTimeout: true,
      })) as Buffer;
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') {
        this.logger.warn(`${label} job still not done after ${this.queueTimeoutMs} ms`);
        throw this.renderTimeoutError(label);
      }
      throw err;
    }
  }

  private renderTimeoutError(label: RenderLabel): ServiceUnavailableException {
    return new ServiceUnavailableException(`puppeteer_${label.toLowerCase()}_timeout`);
  }

  /**
   * The browser for a new render, counted on it: the current one, or a fresh launch on first
   * use and once the current one is retired or disconnected. After `MAX_JOBS` renders the
   * current browser is retired (recycled) whatever the load: the render still on it finishes
   * there, new ones go to the fresh browser. The checks and the counting run synchronously, so
   * two jobs never both retire it. A failed launch is not cached: the next job tries again.
   */
  private async acquireBrowser(): Promise<BrowserSlot> {
    if (this.current && this.current.jobs >= this.MAX_JOBS) {
      this.logger.log('Puppeteer browser recycled');
      this.retireBrowser(this.current);
    }

    let slot = this.current;
    if (!slot?.browser.isConnected()) {
      if (!this.connectPromise) {
        this.connectPromise = this.launchBrowser().finally(() => {
          this.connectPromise = null;
        });
      }
      slot = await this.connectPromise;
    }
    slot.jobs++;
    slot.live++;
    return slot;
  }

  private async launchBrowser(): Promise<BrowserSlot> {
    const browser = await puppeteer.launch(defaultLaunchOptions);
    const slot: BrowserSlot = { browser, jobs: 0, live: 0, retired: false, closing: false };
    this.openSlots.add(slot);
    this.current = slot;

    browser.on('disconnected', () => {
      // A retired browser is closed on purpose; otherwise Chrome crashed or was killed.
      if (slot.retired) return;
      this.logger.warn('Puppeteer browser disconnected; will relaunch on next job');
      this.retireBrowser(slot);
    });

    this.logger.log('Puppeteer shared browser launched');
    return slot;
  }

  /**
   * Takes a browser out of service: no new render goes to it, and it is closed once its own
   * renders end — at the latest when the last of them is past its deadline (its caller already
   * got a timeout), so a render stuck on a hung Chrome cannot keep it open.
   */
  private retireBrowser(slot: BrowserSlot): void {
    if (slot.retired) return;
    slot.retired = true;
    if (this.current === slot) {
      this.current = null;
    }
    if (slot.live === 0) {
      void this.closeBrowser(slot);
      return;
    }
    slot.closeTimer = setTimeout(
      () => void this.closeBrowser(slot),
      this.jobTimeoutMs + PAGE_CLOSE_GRACE_MS,
    );
  }

  /** A render on `slot` has ended: a retired browser closes with its last render. */
  private releaseBrowser(slot: BrowserSlot): void {
    slot.live--;
    if (slot.retired && slot.live === 0) {
      void this.closeBrowser(slot);
    }
  }

  /** Closes a browser for good; kills its process when Chrome does not answer the close. */
  private async closeBrowser(slot: BrowserSlot): Promise<void> {
    if (slot.closing) return;
    slot.closing = true;
    clearTimeout(slot.closeTimer);
    this.openSlots.delete(slot);
    if (!(await settlesWithin(slot.browser.close(), BROWSER_CLOSE_GRACE_MS))) {
      this.logger.warn('Puppeteer browser did not close in time; killing its process');
      slot.browser.process()?.kill('SIGKILL');
    }
  }

  private screenshotWebpJob(html: string): Promise<Buffer> {
    return this.renderJob('WebP', html, async (page) => {
      const shot = await page.screenshot({
        fullPage: true,
        type: 'webp',
        quality: 75,
      });

      if (!shot || (shot as Buffer).length === 0) {
        throw new Error('Screenshot failed: empty buffer');
      }

      return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
    });
  }

  /**
   * Prints the loaded page as a single PDF page exactly the size of the document, in
   * screen media, so it looks like the WebP rather than a print stylesheet on A4. Marked
   * images are downscaled / re-encoded first (`shrinkImagesForPdf`): Chrome would embed
   * them at full source size.
   */
  private async printSizedPdf(page: Page): Promise<Buffer> {
    await page.emulateMediaType('screen');
    await page.evaluate(shrinkImagesForPdf, {
      scale: PDF_IMAGE_SCALE,
      jpegQuality: PDF_IMAGE_JPEG_QUALITY,
    });
    const { width, height } = await page.evaluate(() => ({
      width: Math.ceil(document.documentElement.scrollWidth),
      height: Math.ceil(document.documentElement.scrollHeight),
    }));
    const pdf = await page.pdf({
      printBackground: true,
      width: `${width}px`,
      height: `${height}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      pageRanges: '1',
    });
    if (!pdf || pdf.length === 0) {
      throw new Error('PDF render failed: empty buffer');
    }
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  }

  /**
   * Loads the HTML into a fresh tab of the shared browser, waits for its fonts and images
   * and runs one capture on it, within `jobTimeoutMs` from the job's start. On expiry the
   * tab is closed, which makes the pending `setContent` / capture reject: the job really
   * ends and frees its queue slot, instead of rendering on in the background after the
   * caller gave up. A render that fails or overruns its deadline on a browser retires that
   * browser (it may be stuck or broken): new renders go to a fresh one, while the other render
   * on it finishes there.
   */
  private async renderJob(
    label: RenderLabel,
    html: string,
    capture: (page: Page) => Promise<Buffer>,
  ): Promise<Buffer> {
    let slot: BrowserSlot | null = null;
    let page: Page | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Only a browser the job already got: a slow launch is not the browser's fault.
      if (slot) {
        this.retireBrowser(slot);
      }
      void page?.close().catch(() => undefined);
    }, this.jobTimeoutMs);

    try {
      slot = await this.acquireBrowser();
      if (timedOut) {
        throw new Error('deadline passed before the browser was ready');
      }
      page = await slot.browser.newPage();
      if (timedOut) {
        throw new Error('deadline passed before the tab opened');
      }
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(waitForPageAssets);
      return await capture(page);
    } catch (err) {
      if (timedOut) {
        this.logger.warn(`${label} capture timed out after ${this.jobTimeoutMs} ms`);
        throw this.renderTimeoutError(label);
      }
      this.logger.error(`${label} capture failed: ${String(err)}`);
      if (slot) {
        this.retireBrowser(slot);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (page) {
        await settlesWithin(page.close(), PAGE_CLOSE_GRACE_MS);
      }
      if (slot) {
        this.releaseBrowser(slot);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.onIdle();
    const slots = [...this.openSlots];
    this.current = null;
    for (const slot of slots) {
      // Marked first, so their 'disconnected' listeners do not report a crash.
      slot.retired = true;
    }
    await Promise.all(slots.map((slot) => this.closeBrowser(slot)));
  }
}
