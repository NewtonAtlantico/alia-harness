import { t } from '../i18n/pt-BR';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias", then the date. Calendar days, in local time. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return t.time.now; // also covers a clock that is slightly ahead
  if (minutes < 60) return t.time.minutes(minutes);
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return t.time.hours(Math.floor(minutes / 60));
  if (days === 1) return t.time.yesterday;
  if (days < 7) return t.time.days(days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(then.getDate())}/${p(then.getMonth() + 1)}/${then.getFullYear()}`;
}
