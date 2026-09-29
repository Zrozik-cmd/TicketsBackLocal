import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FinanceArbiPayLiveBalance, FinanceProviderLiveBalances } from '../types/finance.types';
import { parseArbiPayBalanceAnswer } from '../utils/finance-arbipay-balance.util';

const REQUEST_TIMEOUT_MS = 20000;
/** Сколько держим удачный ответ: доска открыта у нескольких админов, ARBI Pay не дёргаем на каждый рендер. */
const CACHE_OK_MS = 30 * 1000;
/** Неудачу держим меньше, чтобы после сбоя баланс вернулся быстро. */
const CACHE_FAILED_MS = 10 * 1000;
/** Сколько текста ошибки микросервиса пишем в лог. */
const ERROR_PREVIEW_CHARS = 300;

/**
 * Живой баланс мерчанта ARBI Pay для финансовой доски админки.
 *
 * Спрашивает не ARBI Pay напрямую, а платёжный микросервис (`GET /balance/arbi` теми же
 * ключами PAYMENT_CLIENT_KEY/PAYMENT_API_SECRET, что и платежи): приватный ключ мерчанта
 * лежит только там. Баланс — на весь аккаунт мерчанта, по событиям не делится.
 * Никогда не бросает: сбой провайдера отдаётся как `status: 'unavailable'`, доска работает дальше.
 */
@Injectable()
export class FinanceArbiPayBalanceService {
  private readonly logger = new Logger(FinanceArbiPayBalanceService.name);
  private readonly serviceUrl: string;
  private readonly clientKey: string;
  private readonly apiSecret: string;
  private cached: { value: FinanceArbiPayLiveBalance; expiresAt: number } | null = null;
  /** Одновременные запросы делят один поход в микросервис. */
  private inFlight: Promise<FinanceArbiPayLiveBalance> | null = null;

  constructor(private readonly config: ConfigService) {
    this.serviceUrl = this.config.get<string>('PAYMENT_SERVICE_URL', '').trim().replace(/\/+$/, '');
    this.clientKey = this.config.get<string>('PAYMENT_CLIENT_KEY', '').trim();
    this.apiSecret = this.config.get<string>('PAYMENT_API_SECRET', '').trim();
  }

  async getLiveBalances(): Promise<FinanceProviderLiveBalances> {
    return { arbiPay: await this.getArbiPay() };
  }

  private getArbiPay(): Promise<FinanceArbiPayLiveBalance> {
    if (this.cached && this.cached.expiresAt > Date.now()) return Promise.resolve(this.cached.value);
    if (!this.inFlight) {
      this.inFlight = this.fetchArbiPay()
        .then((value) => {
          const ttl = value.status === 'ok' ? CACHE_OK_MS : CACHE_FAILED_MS;
          this.cached = { value, expiresAt: Date.now() + ttl };
          return value;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async fetchArbiPay(): Promise<FinanceArbiPayLiveBalance> {
    if (!this.serviceUrl || !this.clientKey || !this.apiSecret) {
      return { status: 'unavailable', reason: 'not_configured', fetchedAt: new Date().toISOString() };
    }
    const url = `${this.serviceUrl}/balance/arbi`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Client-Key': this.clientKey, 'X-Api-Secret': this.apiSecret },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        this.logger.warn(`ARBI Pay balance: ${url} → ${response.status} ${text.slice(0, ERROR_PREVIEW_CHARS)}`);
        return { status: 'unavailable', reason: 'request_failed', fetchedAt: new Date().toISOString() };
      }
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* не-JSON — ниже как неожиданный ответ */
      }
      const parsed = parseArbiPayBalanceAnswer(json);
      if (!parsed) {
        this.logger.warn(`ARBI Pay balance: unexpected answer ${text.slice(0, ERROR_PREVIEW_CHARS)}`);
        return { status: 'unavailable', reason: 'request_failed', fetchedAt: new Date().toISOString() };
      }
      return {
        status: 'ok',
        currency: parsed.currency,
        balance: parsed.balance,
        balances: parsed.balances,
        fetchedAt: parsed.fetchedAt ?? new Date().toISOString(),
      };
    } catch (e) {
      this.logger.warn(`ARBI Pay balance: ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 'unavailable', reason: 'request_failed', fetchedAt: new Date().toISOString() };
    }
  }
}
