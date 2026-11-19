import { t } from '../i18n/pt-BR';

/** "Bom dia, Newton" by the hour: morning from 5, afternoon from 12, evening from 18. */
export function greetingFor(now: Date, name: string): string {
  const hour = now.getHours();
  const word = hour >= 5 && hour < 12 ? t.greeting.morning : hour >= 12 && hour < 18 ? t.greeting.afternoon : t.greeting.evening;
  const who = name.trim();
  return who ? `${word}, ${who}` : word;
}
