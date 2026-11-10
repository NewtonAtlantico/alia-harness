import pc from 'picocolors';

/**
 * Central place for the Alia visual identity in the terminal.
 * Uses 24-bit colour when the terminal supports it and degrades to the
 * basic 16-colour palette (via picocolors) otherwise.
 */

export const colorOn = pc.isColorSupported;

export const trueColor =
  colorOn &&
  (/truecolor|24bit/i.test(process.env.COLORTERM ?? '') ||
    !!process.env.WT_SESSION || // Windows Terminal
    process.env.TERM_PROGRAM === 'vscode' ||
    process.env.TERM_PROGRAM === 'iTerm.app');

export type Painter = (text: string) => string;

/** Builds a painter that uses RGB when available, or `fallback` otherwise. */
export function rgb(r: number, g: number, b: number, fallback: Painter): Painter {
  if (!colorOn) return (t) => t;
  if (!trueColor) return fallback;
  return (t) => `\x1b[38;2;${r};${g};${b}m${t}\x1b[39m`;
}

/** Linear interpolation between two RGB colours, `t` in [0, 1]. */
export function mix(
  from: [number, number, number],
  to: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

// Brand blues sampled from the Alia logo.
export const BRAND_LIGHT: [number, number, number] = [86, 150, 232];
export const BRAND_DEEP: [number, number, number] = [30, 84, 168];

export const brand = rgb(...BRAND_DEEP, pc.blue);
export const brandLight = rgb(...BRAND_LIGHT, pc.cyan);
export const accent = rgb(255, 196, 61, pc.yellow);
export const success = rgb(86, 211, 140, pc.green);
export const danger = rgb(244, 107, 107, pc.red);
export const muted = rgb(130, 142, 163, pc.dim);

/** Foreground colour for a given 0..1 position along the brand gradient. */
export function brandGradient(t: number): Painter {
  const [r, g, b] = mix(BRAND_LIGHT, BRAND_DEEP, t);
  return rgb(r, g, b, t < 0.5 ? pc.cyan : pc.blue);
}

/** Length of a string once ANSI escape sequences are removed. */
export function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

/** Truncates plain text to `max` visible chars, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}
