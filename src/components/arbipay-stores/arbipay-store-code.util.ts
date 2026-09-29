/**
 * Код точки (slug) ARBIPAY для события: только латинские буквы, 1-12 символов.
 * Номер события цифрами передать нельзя, поэтому он кодируется буквами.
 */

/** Ограничение ARBIPAY на длину кода точки. */
export const ARBIPAY_STORE_CODE_MAX_LENGTH = 12;

/**
 * Буквы, с которых начинается код каждой точки Lotus Arena (`la` = Lotus Arena):
 * отделяет наши коды от прочих точек мерчанта. Один на все среды: локальная база и
 * dev-сервер, работающие с одним мерчантом ARBIPAY, спорят за один код — кто первый
 * создал точку для номера события, тот её и получил, второй получит 409.
 */
export const ARBIPAY_STORE_CODE_PREFIX = 'la';

/**
 * Номер события → буквы (двадцатишестеричная система без нуля): 1 → `a`, 26 → `z`,
 * 27 → `aa`, 32 → `af`. Уникальность кода даёт сам номер события.
 */
export function eventIdToLetters(eventId: number): string {
  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new Error(`Invalid event id for an ARBIPAY store code: ${eventId}`);
  }
  let rest = eventId;
  let letters = '';
  while (rest > 0) {
    rest -= 1;
    letters = String.fromCharCode(97 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26);
  }
  return letters;
}

/**
 * Код точки события: `<префикс><номер события буквами>`, для события 32 — `laaf`.
 * `null`, если код не влезает в 12 символов (номер события за пределами ~10^12).
 */
export function arbiPayStoreCodeForEvent(
  eventId: number,
  prefix = ARBIPAY_STORE_CODE_PREFIX,
): string | null {
  const code = `${prefix}${eventIdToLetters(eventId)}`;
  return code.length <= ARBIPAY_STORE_CODE_MAX_LENGTH ? code : null;
}
