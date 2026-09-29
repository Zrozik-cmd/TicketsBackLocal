import {
  EVENT_SPONSOR_LOGO_MAX_BYTES,
  EVENT_SPONSOR_LOGO_MIME_TYPES,
  EVENT_SPONSOR_URL_MAX_LENGTH,
} from '../constants/event-sponsors.constant';

/**
 * `true` for an absolute http(s) URL without whitespace. It is the only kind of link a
 * ticket PDF may carry: anything else (`javascript:`, `data:`, relative) is rejected.
 */
export function isSponsorHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > EVENT_SPONSOR_URL_MAX_LENGTH) return false;
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const LOGO_SIGNATURES: Record<(typeof EVENT_SPONSOR_LOGO_MIME_TYPES)[number], (head: Buffer) => boolean> = {
  'image/png': (head) =>
    head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  'image/webp': (head) =>
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Checks an uploaded sponsor logo: a base64 data URL of a png/jpeg/webp image (declared type
 * and file signature must agree) of at most `EVENT_SPONSOR_LOGO_MAX_BYTES` decoded bytes.
 * Returns the normalized MIME type, or `null` when the upload is not acceptable.
 */
export function parseSponsorLogoDataUrl(dataUrl: unknown): { mimeType: string; bytes: number } | null {
  if (typeof dataUrl !== 'string') return null;
  const trimmed = dataUrl.trim();
  // Cheap bound before the regex: base64 needs 4 chars per 3 bytes, plus the header.
  if (trimmed.length > Math.ceil(EVENT_SPONSOR_LOGO_MAX_BYTES / 3) * 4 + 64) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(trimmed);
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase() as (typeof EVENT_SPONSOR_LOGO_MIME_TYPES)[number];
  if (!EVENT_SPONSOR_LOGO_MIME_TYPES.includes(mimeType)) return null;
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > EVENT_SPONSOR_LOGO_MAX_BYTES) return null;
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (!LOGO_SIGNATURES[mimeType](head)) return null;
  return { mimeType, bytes };
}
