/*
 * Font size of one sponsor name on the ticket.
 *
 * The name is a single 200px line under the logo, and its 24px row height feeds the side
 * notches and the page-break geometry of `templates/ticket.html`, so a name that does not fit
 * is shrunk — never wrapped — and cut off with an ellipsis only once it cannot shrink further.
 * `EVENT_SPONSOR_NAME_MAX_LENGTH` (15) is chosen so that the ellipsis never happens: the ladder
 * below returns the largest size the name still fits at, and every 15-character name fits at
 * one of them.
 *
 * Widths are estimated, not measured — rendering a page to pick a font size is not an option.
 * The ticket asks for "SF Pro Display-Medium", Helvetica; the first family never exists in the
 * render, so Chrome falls back to Helvetica metrics (the production image ships ttf-freefont /
 * FreeSans, a Nimbus Sans clone, a developer machine substitutes Arial — both metric-compatible
 * with Helvetica). The table below is the Adobe Helvetica AFM, which is never narrower than
 * those, so the estimate is an upper bound and the size it picks always fits.
 */

/** Width of the name line (`.frame .sponsor-name` in `templates/ticket.html`). */
const SPONSOR_NAME_LINE_WIDTH_PX = 200;

/** Slack kept against that line: sub-pixel rounding must not be what brings the ellipsis back. */
const SPONSOR_NAME_LINE_SLACK_PX = 1;

/**
 * The sizes a name may be printed at, largest first. 22px is the Figma size of the block; 13px,
 * the smallest, is what a legacy name stored before the 15-character limit falls back to — below
 * that the name would be unreadable, so there the ellipsis takes over instead.
 */
const SPONSOR_NAME_FONT_SIZES = [22, 20, 18, 16, 14, 13] as const;

/**
 * Advance widths of Helvetica (= Arial = FreeSans) for ASCII 0x20…0x7E, per 1000 em, in code
 * point order: space ! " # $ % & ' ( ) * + , - . / 0-9 : ; < = > ? @ A-Z [ \ ] ^ _ ` a-z { | } ~
 */
const ASCII_ADVANCE_PER_MILLE: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/**
 * Everything outside ASCII counts as one full em — the width of a CJK ideograph, the widest
 * glyph a name can realistically hold. Thai, Cyrillic, Greek and accented Latin are narrower
 * than that, so they are printed a tier smaller than they would strictly need.
 */
const NON_ASCII_EM = 1;

/** A non-BMP code point (emoji and their kin) is drawn wider than one em. */
const ASTRAL_EM = 1.5;

/**
 * A mark that hangs on the previous glyph and adds no advance of its own: Latin/Cyrillic/Greek
 * diacritics, Hebrew points, Arabic harakat, Thai vowels and tones (a Thai name is mostly these).
 */
function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0e31 ||
    (code >= 0x0e34 && code <= 0x0e3a) ||
    (code >= 0x0e47 && code <= 0x0e4e) ||
    (code >= 0x20d0 && code <= 0x20f0)
  );
}

/** Upper bound of one code point's advance, in em. */
function charWidthEm(code: number): number {
  if (code >= 0x20 && code <= 0x7e) return ASCII_ADVANCE_PER_MILLE[code - 0x20] / 1000;
  if (code > 0xffff) return ASTRAL_EM;
  if (isCombiningMark(code)) return 0;
  return NON_ASCII_EM;
}

/** Upper bound of the whole name's width, in em (multiply by the font size for pixels). */
export function sponsorNameWidthEm(name: string): number {
  let em = 0;
  for (const char of name) em += charWidthEm(char.codePointAt(0) ?? 0);
  return em;
}

/**
 * Font size in px for the sponsor name printed on the ticket: the largest of
 * `SPONSOR_NAME_FONT_SIZES` whose estimated width still fits the line, and the smallest of them
 * when none does (a legacy name longer than today's limit, which the ellipsis then cuts).
 */
export function sponsorNameFontSize(name: string): number {
  const em = sponsorNameWidthEm(name);
  const budget = SPONSOR_NAME_LINE_WIDTH_PX - SPONSOR_NAME_LINE_SLACK_PX;
  for (const size of SPONSOR_NAME_FONT_SIZES) {
    if (em * size <= budget) return size;
  }
  return SPONSOR_NAME_FONT_SIZES[SPONSOR_NAME_FONT_SIZES.length - 1];
}
