/*
 * The Lotus Arena e-mail shell (gradient header with the logo, white card, grey
 * footer line) shared by the transactional letters. Pure string builders, so a
 * letter can be rendered and eyeballed from a plain script.
 */

/** Escapes text that ends up inside the HTML (titles and names come from organizers). */
export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildBrandedEmailHtml(params: {
  logoUrl: string;
  title: string;
  subtitle: string;
  bodyRowsHtml: string;
  footer: string;
}): string {
  const brand = params.logoUrl
    ? `<img src="${params.logoUrl}" alt="Lotus Arena" style="height:32px;display:block;margin-bottom:12px;" />`
    : '<div style="font-size:18px;font-weight:700;margin-bottom:12px;">Lotus Arena</div>';
  return `
      <div style="font-family:Arial,sans-serif;background:#f3f4f6;padding:24px;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
          <div style="padding:20px;background:linear-gradient(90deg,#FAB67E 0%,#F48874 16%,#EF5880 32%,#E0185F 48%,#B13187 64%,#3E7BB8 82%,#5268AE 100%);color:#ffffff;">
            ${brand}
            <div style="font-size:24px;font-weight:700;line-height:1.2;">${params.title}</div>
            <div style="font-size:14px;opacity:.95;margin-top:8px;">${params.subtitle}</div>
          </div>
          <div style="padding:20px;color:#111827;">
            ${params.bodyRowsHtml}
            <div style="font-size:12px;color:#6b7280;margin-top:14px;">${params.footer}</div>
          </div>
        </div>
      </div>`;
}

export function emailDetailRow(label: string, value: string, emphasize = false): string {
  const valueStyle = emphasize
    ? 'font-size:15px;font-weight:600;color:#111827;margin-bottom:8px;'
    : 'font-size:14px;color:#4b5563;margin-bottom:8px;';
  return `<div style="${valueStyle}"><span style="color:#6b7280;">${label}:</span> ${value}</div>`;
}
