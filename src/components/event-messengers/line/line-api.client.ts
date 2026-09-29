import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosResponse } from 'axios';
import {
  DEFAULT_LINE_API_BASE_URL,
  LINE_API_TIMEOUT_MS,
} from '../constants/event-messengers.constants';

const MAX_ERROR_LENGTH = 300;

/**
 * A failed LINE Messaging API call. `message` is short and safe to store/show: HTTP
 * status plus LINE's own `message`, or the network error code. It never contains the
 * channel access token (the request config is never stringified).
 */
export class LineApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, `null` when LINE was not reached (timeout, DNS, refused). */
    readonly status: number | null,
    /** LINE's `message` field from the error body, when there was one. */
    readonly lineMessage: string | null,
  ) {
    super(message);
    this.name = 'LineApiError';
  }

  /** The token was rejected (invalid, revoked or lacking permission). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type LineBotInfo = {
  userId: string | null;
  basicId: string | null;
  displayName: string | null;
};

export type LinePushResult = {
  /** `x-line-request-id` of the accepted push. */
  requestId: string | null;
  /** 409: a push with this retry key had already been accepted (an earlier attempt got through). */
  alreadyAccepted: boolean;
};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Thin LINE Messaging API client. The origin is `LINE_API_BASE_URL` (default
 * `https://api.line.me`), read on every call so tests can point it at a fake server.
 */
@Injectable()
export class LineApiClient {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  baseUrl(): string {
    const configured = (this.config.get<string>('LINE_API_BASE_URL') ?? '').trim().replace(/\/+$/, '');
    return configured || DEFAULT_LINE_API_BASE_URL;
  }

  /** `GET /v2/bot/info` — validates the token and names the bot. */
  async getBotInfo(channelAccessToken: string): Promise<LineBotInfo> {
    const response = await this.request('GET', '/v2/bot/info', channelAccessToken);
    const data = (response.data ?? {}) as Record<string, unknown>;
    return {
      userId: asText(data.userId),
      basicId: asText(data.basicId),
      displayName: asText(data.displayName),
    };
  }

  /** `GET /v2/bot/group/{groupId}/summary` — the group's name. */
  async getGroupSummary(channelAccessToken: string, groupId: string): Promise<{ groupName: string | null }> {
    const response = await this.request(
      'GET',
      `/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
      channelAccessToken,
    );
    const data = (response.data ?? {}) as Record<string, unknown>;
    return { groupName: asText(data.groupName) };
  }

  /** `POST /v2/bot/message/push` with one text message and `X-Line-Retry-Key`. */
  async pushText(channelAccessToken: string, to: string, text: string, retryKey: string): Promise<LinePushResult> {
    const response = await this.request(
      'POST',
      '/v2/bot/message/push',
      channelAccessToken,
      { to, messages: [{ type: 'text', text }] },
      { 'X-Line-Retry-Key': retryKey },
      [409],
    );
    return {
      requestId: asText(response.headers?.['x-line-request-id']),
      alreadyAccepted: response.status === 409,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    channelAccessToken: string,
    body?: unknown,
    headers: Record<string, string> = {},
    acceptedErrorStatuses: number[] = [],
  ): Promise<AxiosResponse> {
    let response: AxiosResponse;
    try {
      response = await this.http.axiosRef.request({
        method,
        url: `${this.baseUrl()}${path}`,
        data: body,
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        timeout: LINE_API_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      const code = asText((error as { code?: unknown })?.code);
      const reason = code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'timeout' : code ?? 'network error';
      throw new LineApiError(`LINE API unreachable (${reason})`, null, null);
    }
    if ((response.status >= 200 && response.status < 300) || acceptedErrorStatuses.includes(response.status)) {
      return response;
    }
    const data = response.data as { message?: unknown; details?: unknown } | string | undefined;
    const baseMessage = typeof data === 'object' && data ? asText(data.message) : null;
    const details =
      typeof data === 'object' && data && Array.isArray(data.details)
        ? (data.details as Array<{ message?: unknown; property?: unknown }>)
            .slice(0, 2)
            .map((item) => [asText(item?.property), asText(item?.message)].filter(Boolean).join(': '))
            .filter(Boolean)
        : [];
    const lineMessage = baseMessage && details.length ? `${baseMessage} (${details.join('; ')})` : baseMessage;
    const detail = lineMessage ?? asText(response.statusText) ?? 'request failed';
    const message = `LINE API ${response.status}: ${detail}`;
    throw new LineApiError(
      message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message,
      response.status,
      lineMessage ? lineMessage.slice(0, MAX_ERROR_LENGTH) : null,
    );
  }
}

/** Short, token-free text of any error for logs and `lastError`. */
export function describeMessengerError(error: unknown): string {
  if (error instanceof LineApiError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return (message || 'Unknown error').slice(0, MAX_ERROR_LENGTH);
}
