export function normalizeTelegramUsername(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value.startsWith('@')) {
    value = `@${value}`;
  }
  return value;
}

export function isValidTelegramUsername(normalized: string): boolean {
  if (!normalized.startsWith('@')) {
    return false;
  }
  const name = normalized.slice(1);
  if (name.length < 5) {
    return false;
  }
  return /^[a-z0-9_]+$/.test(name);
}

export function normalizeTelegramUsernameFromBot(raw?: string | null): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}
