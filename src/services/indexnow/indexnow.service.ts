import { Injectable, Logger } from '@nestjs/common';

/**
 * IndexNow push notifications (SEO audit task 22): Bing and Yandex learn about
 * a new/changed/finished event within minutes instead of days — critical when
 * a page only sells tickets for 3–6 weeks.
 *
 * Fire-and-forget by design: indexing pings must never fail or slow down the
 * event-save path. Disabled unless both env vars are present:
 *   INDEXNOW_KEY          — the key, also served as /<key>.txt on the frontend
 *   PUBLIC_FRONTEND_URL   — the public ticket-site origin (already configured)
 */
@Injectable()
export class IndexNowService {
  private readonly logger = new Logger(IndexNowService.name);

  private get key(): string {
    return process.env.INDEXNOW_KEY?.trim() ?? '';
  }

  private get origin(): string {
    return (process.env.PUBLIC_FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
  }

  /** Same slug rule the frontend canonicalises to: `{id}-{slugified EN title}`. */
  eventPath(id: number, titleEn?: string | null): string {
    const slug = (titleEn ?? '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 40);
    return `/events/${id}-${slug}`;
  }

  /**
   * Notify about changed locale-less paths (e.g. ['/events/34-loc-dog']).
   * Each is expanded to its /en /ru /th versions before submission: the site
   * serves every page under a locale prefix, and a locale-less URL only 307s —
   * IndexNow should receive final URLs, not redirects.
   */
  notifyPaths(paths: string[]): void {
    this.notifyAbsolutePaths(
      paths.flatMap((p) =>
        ['en', 'ru', 'th'].map((l) => (p === '/' ? `/${l}` : `/${l}${p}`)),
      ),
    );
  }

  private notifyAbsolutePaths(paths: string[]): void {
    const { key, origin } = this;
    if (!key || !origin) return;

    const host = origin.replace(/^https?:\/\//, '');
    const urlList = Array.from(new Set(paths)).map((p) => `${origin}${p}`);
    if (!urlList.length) return;

    void fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList,
      }),
    })
      .then((res) => {
        if (!res.ok) {
          this.logger.warn(`IndexNow responded ${res.status} for ${urlList.length} url(s)`);
        }
      })
      .catch((error: Error) => {
        this.logger.warn(`IndexNow ping failed: ${error.message}`);
      });
  }
}
