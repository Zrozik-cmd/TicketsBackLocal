/**
 * Кому слать письмо о пороге кассы: ровно адреса, сохранённые админом на странице
 * «Статистика по точкам», — без пустых строк, в нижнем регистре и без повторов.
 * Пустой список означает «никому»: запасных получателей (всех админов, адреса из
 * окружения) нет, чтобы письма не уходили тем, кого админ не указывал.
 */
export function resolveTillAlertRecipients(saved: ReadonlyArray<unknown> | null | undefined): string[] {
  const seen = new Set<string>();
  for (const value of saved ?? []) {
    if (typeof value !== 'string') continue;
    const email = value.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return Array.from(seen);
}
