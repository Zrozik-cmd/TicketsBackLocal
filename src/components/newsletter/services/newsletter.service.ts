import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../../services/redis/redis.service';
import { MailchimpService } from './mailchimp.service';

const REDIS_KEY_IP = (ip: string) => `newsletter:subscribe:ip:${ip}`;
const REDIS_KEY_EMAIL = (emailHash: string) => `newsletter:subscribe:email:${emailHash}`;

/** Max footer-form subscribe attempts per IP per window. */
const IP_LIMIT = 5;
const IP_WINDOW_SEC = 60;
/** The same address is forwarded to Mailchimp at most once per this period. */
const EMAIL_DEDUP_TTL_SEC = 6 * 60 * 60;

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly mailchimp: MailchimpService,
  ) {}

  /**
   * Public footer-form subscribe: double opt-in (Mailchimp emails a confirmation
   * link; the address enters the audience only after the owner clicks it).
   * Always resolves to the same shape so callers can't probe which addresses exist.
   */
  async subscribeFromFooter(params: {
    email: string;
    ip: string;
    locale?: string;
    /** Honeypot field: humans never fill it, bots do. */
    website?: string;
  }): Promise<{ ok: true }> {
    if (params.website?.trim()) {
      this.logger.warn(`Newsletter honeypot triggered (ip=${params.ip})`);
      return { ok: true };
    }

    await this.assertIpNotRateLimited(params.ip);

    const email = params.email.trim().toLowerCase();
    const emailHash = createHash('md5').update(email).digest('hex');
    const emailKey = REDIS_KEY_EMAIL(emailHash);
    if (await this.redis.get(emailKey)) {
      // Recently forwarded already; Mailchimp upsert is idempotent anyway.
      return { ok: true };
    }

    await this.mailchimp.upsertMember({
      email,
      statusIfNew: 'pending',
      language: params.locale,
      tags: ['subscriber'],
    });
    await this.redis.set(emailKey, '1', EMAIL_DEDUP_TTL_SEC);
    return { ok: true };
  }

  private async assertIpNotRateLimited(ip: string): Promise<void> {
    const key = REDIS_KEY_IP(ip);
    const attempts = await this.redis.incr(key);
    if (attempts === 1) {
      await this.redis.expire(key, IP_WINDOW_SEC);
    }
    if (attempts > IP_LIMIT) {
      throw new HttpException('too_many_requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
