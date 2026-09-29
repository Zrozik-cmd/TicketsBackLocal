import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';

const MAILCHIMP_TIMEOUT_MS = 15000;

/**
 * 'subscribed' — added to the audience immediately (explicit consent already given,
 * e.g. the checkout checkbox). 'pending' — Mailchimp sends a confirmation email and
 * only adds the address after the owner clicks it (double opt-in for the public
 * footer form, where anyone can type any address).
 */
export type MailchimpSubscribeStatus = 'subscribed' | 'pending';

/** Audience segmentation: how the address entered the list. One person can carry both. */
export type MailchimpSourceTag = 'buyer' | 'subscriber';

/**
 * Custom merge fields (audience columns) this integration writes. They must exist in
 * the audience before the API accepts values for them — ensured on module init.
 * Tag names are capped at 10 chars by Mailchimp.
 */
const CUSTOM_MERGE_FIELDS: Array<{ tag: string; name: string; type: string }> = [
  { tag: 'EVENT_ID', name: 'Event ID', type: 'number' },
  { tag: 'EVENT_NAME', name: 'Event name', type: 'text' },
  { tag: 'PURCHASED', name: 'Purchase date', type: 'text' },
];

/** "abc12345-us21" -> "abc1...us21": enough to recognise the key, useless to an attacker. */
function maskSecret(value: string): string {
  if (!value) return '(unset)';
  if (value.length < 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

@Injectable()
export class MailchimpService implements OnModuleInit {
  private readonly logger = new Logger(MailchimpService.name);
  private readonly apiKey: string;
  private readonly listId: string;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.apiKey = this.config.get<string>('MAILCHIMP_API_KEY', '');
    this.listId = this.config.get<string>('MAILCHIMP_LIST_ID', '');
    // The datacenter is the API key suffix ("...-us21"); an env override wins.
    const dc =
      this.config.get<string>('MAILCHIMP_SERVER_PREFIX', '') ||
      this.apiKey.split('-').pop() ||
      '';
    this.baseUrl = dc ? `https://${dc}.api.mailchimp.com/3.0` : '';

    // Startup config visibility; the key itself must never reach the logs.
    this.logger.log(
      `Mailchimp config: enabled=${this.isEnabled()}, apiKey=${maskSecret(this.apiKey)}, listId=${this.listId || '(unset)'}, dc=${dc || '(unset)'}, baseUrl=${this.baseUrl || '(unset)'}`,
    );
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey && this.listId && this.baseUrl);
  }

  /** Fire-and-forget: a Mailchimp hiccup at startup must not block the backend. */
  onModuleInit(): void {
    void this.ensureCustomMergeFields().catch((e) => {
      this.logger.warn(`Mailchimp merge-field init failed: ${(e as Error).message}`);
    });
  }

  /**
   * Creates the custom audience columns this integration writes into, if missing.
   * Idempotent: existing fields are left untouched, so restarts are safe.
   */
  private async ensureCustomMergeFields(): Promise<void> {
    if (!this.isEnabled()) return;
    const url = `${this.baseUrl}/lists/${this.listId}/merge-fields`;
    const auth = { username: 'anystring', password: this.apiKey };

    const existing = await firstValueFrom(
      this.http
        .get<{ merge_fields: Array<{ tag: string }> }>(url, {
          auth,
          params: { count: 100, fields: 'merge_fields.tag' },
        })
        .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
    );
    const existingTags = new Set(
      (existing.data.merge_fields ?? []).map((f) => f.tag),
    );

    for (const field of CUSTOM_MERGE_FIELDS) {
      if (existingTags.has(field.tag)) continue;
      await firstValueFrom(
        this.http
          .post(
            url,
            { tag: field.tag, name: field.name, type: field.type, required: false },
            { auth },
          )
          .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
      );
      this.logger.log(`Mailchimp merge field created: ${field.tag}`);
    }
  }

  /**
   * Idempotent upsert into the audience. `status_if_new` only applies when the member
   * does not exist yet: an existing member's status is never changed, so the footer
   * form can never downgrade a subscriber to pending, and someone who unsubscribed
   * is never force-resubscribed.
   */
  async upsertMember(params: {
    email: string;
    statusIfNew: MailchimpSubscribeStatus;
    fullname?: string;
    language?: string;
    /** Extra audience columns, e.g. EVENT_ID / EVENT_NAME / PURCHASED / PHONE. */
    mergeFields?: Record<string, string | number>;
    /** Source tag(s); applied in a follow-up call because PUT only tags new members. */
    tags?: MailchimpSourceTag[];
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn(
        'Mailchimp is not configured (MAILCHIMP_API_KEY, MAILCHIMP_LIST_ID); skipping subscribe',
      );
      return;
    }

    const email = params.email.trim().toLowerCase();
    const subscriberHash = createHash('md5').update(email).digest('hex');
    const url = `${this.baseUrl}/lists/${this.listId}/members/${subscriberHash}`;
    const auth = { username: 'anystring', password: this.apiKey };

    const [firstName, ...rest] = (params.fullname ?? '').trim().split(/\s+/);
    const mergeFields: Record<string, string | number> = {
      ...(firstName ? { FNAME: firstName } : {}),
      ...(firstName && rest.length ? { LNAME: rest.join(' ') } : {}),
      ...(params.mergeFields ?? {}),
    };
    const body = {
      email_address: email,
      status_if_new: params.statusIfNew,
      ...(params.language ? { language: params.language } : {}),
      ...(Object.keys(mergeFields).length ? { merge_fields: mergeFields } : {}),
    };

    let memberStatus = '';
    try {
      const res = await firstValueFrom(
        this.http
          .put<{ status?: string }>(url, body, { auth })
          .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
      );
      memberStatus = res.data?.status ?? '';
      this.logger.log(
        `Mailchimp upsert ok: ${email} (status_if_new=${params.statusIfNew}, status=${memberStatus})`,
      );
    } catch (e) {
      const err = e as AxiosError<{ title?: string; detail?: string }>;
      const title = err.response?.data?.title ?? '';
      const detail = err.response?.data?.detail ?? err.message;
      // Compliance state = the address unsubscribed/bounced before; not an error for us.
      if (title === 'Member In Compliance State') {
        this.logger.log(`Mailchimp skipped (compliance state): ${email}`);
        return;
      }
      // A merge-field validation reject (e.g. phone format) must not lose the subscriber:
      // retry once with the bare subscription and keep the warning for diagnostics.
      if (err.response?.status === 400 && Object.keys(mergeFields).length) {
        this.logger.warn(
          `Mailchimp merge fields rejected for ${email} (${detail}); retrying without them`,
        );
        try {
          await firstValueFrom(
            this.http
              .put(
                url,
                { email_address: email, status_if_new: params.statusIfNew },
                { auth },
              )
              .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
          );
          this.logger.log(`Mailchimp upsert ok without merge fields: ${email}`);
        } catch {
          this.logger.error(`Mailchimp retry without merge fields failed for ${email}`);
          throw new ServiceUnavailableException('newsletter_subscribe_failed');
        }
      } else {
        this.logger.error(
          `Mailchimp upsert failed for ${email}: ${title || err.response?.status || ''} ${detail}`,
        );
        throw new ServiceUnavailableException('newsletter_subscribe_failed');
      }
    }

    /*
      A footer signup that never clicked its confirmation email sits as 'pending'.
      status_if_new cannot change an existing member, so a later purchase with the
      consent checkbox (explicit consent + email verified by the OTP checkout flow)
      would leave them pending forever. Upgrade exactly that one transition —
      unsubscribed/cleaned members are never touched.
    */
    if (params.statusIfNew === 'subscribed' && memberStatus === 'pending') {
      try {
        await firstValueFrom(
          this.http
            .patch(url, { status: 'subscribed' }, { auth })
            .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
        );
        this.logger.log(`Mailchimp upgraded pending -> subscribed: ${email}`);
      } catch (e) {
        this.logger.warn(
          `Mailchimp pending->subscribed upgrade failed for ${email}: ${(e as Error).message}`,
        );
      }
    }

    if (params.tags?.length) {
      // Separate endpoint: PUT member only applies tags on create, this works for existing members too.
      try {
        await firstValueFrom(
          this.http
            .post(
              `${url}/tags`,
              { tags: params.tags.map((name) => ({ name, status: 'active' })) },
              { auth },
            )
            .pipe(timeout(MAILCHIMP_TIMEOUT_MS)),
        );
      } catch (e) {
        this.logger.warn(
          `Mailchimp tagging failed for ${email}: ${(e as Error).message}`,
        );
      }
    }
  }
}
