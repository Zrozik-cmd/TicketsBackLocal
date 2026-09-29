import type { Request } from 'express';

/*
 * Shared bits of request context for log lines. Checkout failures are reported by
 * customers, not by monitoring, so a log line is only useful if it says *who* hit it
 * and *from what* — an in-app webview behaves nothing like a real browser.
 */

/** Client IP behind nginx: X-Real-IP → last X-Forwarded-For entry → req.ip. */
export function clientIp(req: Request): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIp(realIp.trim());
  }
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedRaw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof forwardedRaw === 'string' && forwardedRaw.trim()) {
    const parts = forwardedRaw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[parts.length - 1]);
  }
  return normalizeIp(req.ip ?? 'unknown');
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * In-app browsers (Instagram, Facebook, Line, TikTok) get their own short-lived
 * storage, so a customer can be signed in on one screen and tokenless on the next.
 * Naming the webview in the log turns that from a guess into a fact.
 */
export function webviewMarker(userAgent: string): string {
  if (/Instagram/i.test(userAgent)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return 'facebook';
  if (/\bLine\//i.test(userAgent)) return 'line';
  if (/BytedanceWebview|musical_ly|TikTok/i.test(userAgent)) return 'tiktok';
  if (/\bWhatsApp\//i.test(userAgent)) return 'whatsapp';
  if (/\bwv\b/.test(userAgent)) return 'android-webview';
  return 'browser';
}

/**
 * Compact `ip=… client=… ua="…"` suffix shared by every diagnostic log line.
 *
 * Never throws: one caller sits in the checkout path ahead of order creation, and
 * a diagnostic string is not worth failing a customer's payment over.
 */
export function requestContext(req: Request): string {
  try {
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    const shortUa = userAgent.length > 120 ? `${userAgent.slice(0, 120)}…` : userAgent || 'none';
    return `ip=${clientIp(req)} client=${webviewMarker(userAgent)} ua="${shortUa}"`;
  } catch {
    return 'ip=unknown client=unknown ua="unreadable"';
  }
}
