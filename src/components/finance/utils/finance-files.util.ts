/**
 * Квитанции к выплатам: ограничения загрузки и безопасная отдача файла.
 * Файлы хранятся приватными медиа и отдаются ТОЛЬКО гвардированными маршрутами.
 */

export const FINANCE_RECEIPT_MAX_FILES = 10;
export const FINANCE_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const FINANCE_RECEIPT_NAME_MAX = 200;

export const FINANCE_RECEIPT_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'application/pdf',
]);

/** Параметры FilesInterceptor для всех маршрутов с квитанциями. */
export const FINANCE_RECEIPT_UPLOAD_OPTIONS = {
  limits: { fileSize: FINANCE_RECEIPT_MAX_BYTES },
};

export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').trim().toLowerCase();
}

export function isAllowedReceiptMime(mime: string | null | undefined): boolean {
  return FINANCE_RECEIPT_MIME_TYPES.has(normalizeMime(mime));
}

export function receiptKind(mime: string | null | undefined): 'image' | 'pdf' | 'other' {
  const normalized = normalizeMime(mime);
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('image/')) return 'image';
  return 'other';
}

/**
 * multer (busboy) читает имя файла из заголовка как latin1, поэтому кириллица и
 * тайский приходят «кракозябрами». Если байты имени — валидный UTF-8, берём его.
 */
export function decodeMultipartFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  if (!name || !/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

/**
 * Имя без путей, управляющих символов и кавычек; ≤ 200 единиц UTF-16 (так считает
 * maxlength mongoose в схеме квитанции) с сохранением расширения, суррогатные пары не режутся.
 */
export function sanitizeReceiptName(originalName: string | null | undefined, mime?: string): string {
  const decoded = decodeMultipartFilename(String(originalName ?? ''));
  const base = decoded.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') {
    name = receiptKind(mime) === 'pdf' ? 'receipt.pdf' : 'receipt';
  }
  if (name.length > FINANCE_RECEIPT_NAME_MAX) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const keepExt = ext.length > 0 && ext.length <= 12 ? ext : '';
    const budget = FINANCE_RECEIPT_NAME_MAX - keepExt.length;
    let head = '';
    // for…of идёт по целым кодовым точкам: эмодзи либо целиком, либо не попадает
    for (const char of name) {
      if (head.length + char.length > budget) break;
      head += char;
    }
    name = head + keepExt;
  }
  return name;
}

/** `inline; filename*=UTF-8''…` (RFC 5987/6266). */
export function inlineContentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename*=UTF-8''${encoded}`;
}
