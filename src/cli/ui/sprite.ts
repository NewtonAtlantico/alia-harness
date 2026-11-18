import { colorOn, trueColor } from './theme.js';

/**
 * Pixel-art mascot used by the "thinking" animation.
 *
 * Frames are 12x17 pixel maps. Letters index into PALETTE, "." is transparent.
 * Rendering packs two pixel rows into one terminal row with half-block glyphs.
 */

type RGB = [number, number, number];

const PALETTE: Record<string, { rgb: RGB; ansi256: number }> = {
  B: { rgb: [33, 61, 147], ansi256: 25 }, // hair / shirt
  S: { rgb: [253, 188, 183], ansi256: 217 }, // skin
  s: { rgb: [224, 167, 162], ansi256: 181 }, // skin shade
  K: { rgb: [38, 38, 38], ansi256: 235 }, // belt / socks
  O: { rgb: [239, 81, 35], ansi256: 202 }, // eyes / shoes
  D: { rgb: [33, 48, 92], ansi256: 17 }, // shorts shadow
  W: { rgb: [255, 255, 255], ansi256: 15 }, // eye whites
};

const HEAD = [
  '...BBBBBBB..',
  '..BBBBBBBB..',
  '.BBBBBBBBB..',
  '.BSBBBBWBWBB',
  'BSsSBBSOSOS.',
  'BSsSBSSSSSSS',
  'BBSSSSSsSSS.',
  '.BBSSSSSsss.',
  'B.BBBSSSSS..',
  '....BSSS....',
  '...BBBBK....',
  '..BBBBBBB...',
];

/** Original running frame. */
const RUN_A = [...HEAD, '..KKKKBBBB..', '.OsSSSBBBBKO', '.OsSSDDDDDKO', '.OsSS..BKKO.', '.OK.....OO..'];

/** Passing stride, bobbed up half a cell by the renderer. */
const RUN_B = [...HEAD, '..KKKKKKKK..', '...BBBBBBB..', '..OsS...sSS.', '..OOs...sS..', '.......OOOO.'];

/** Standing still, eyes open. */
const IDLE = [...HEAD, '..KKKKKKKK..', '...BBBBBBB..', '....sS.sS...', '....SS.SS...', '...OOO.OOO..'];

/** Standing still, mid-blink. */
const IDLE_BLINK = IDLE.map((row, i) =>
  i === 3 ? row.replace(/W/g, 'B') : i === 4 ? row.replace(/O/g, 'K') : row
);

export type FrameName = 'runA' | 'runB' | 'idle' | 'blink';

interface Frame {
  pixels: string[];
  /** Vertical offset in pixel rows inside the canvas (smaller = higher). */
  yOffset: number;
}

const FRAMES: Record<FrameName, Frame> = {
  runA: { pixels: RUN_A, yOffset: 1 },
  runB: { pixels: RUN_B, yOffset: 0 },
  idle: { pixels: IDLE, yOffset: 1 },
  blink: { pixels: IDLE_BLINK, yOffset: 1 },
};

export const SPRITE_WIDTH = 12;
/** Canvas height in pixel rows (17 sprite rows + 1 row of bob room). */
const CANVAS_PIXEL_ROWS = 18;
/** Terminal rows needed to draw the sprite. */
export const SPRITE_ROWS = CANVAS_PIXEL_ROWS / 2;

function fg(key: string): string {
  const c = PALETTE[key];
  return trueColor ? `\x1b[38;2;${c.rgb.join(';')}m` : `\x1b[38;5;${c.ansi256}m`;
}

function bg(key: string): string {
  const c = PALETTE[key];
  return trueColor ? `\x1b[48;2;${c.rgb.join(';')}m` : `\x1b[48;5;${c.ansi256}m`;
}

const RESET = '\x1b[0m';

/**
 * Draws a frame onto a canvas `width` columns wide, sprite's left edge at `x`.
 * Returns SPRITE_ROWS lines, each exactly `width` visible columns.
 */
export function renderSprite(
  name: FrameName,
  x: number,
  width: number,
  mirrored = false
): string[] {
  const frame = FRAMES[name];

  const pixelAt = (col: number, row: number): string | undefined => {
    const sx = col - x;
    const sy = row - frame.yOffset;
    if (sx < 0 || sx >= SPRITE_WIDTH || sy < 0 || sy >= frame.pixels.length) return undefined;
    const ch = frame.pixels[sy][mirrored ? SPRITE_WIDTH - 1 - sx : sx];
    return ch === '.' ? undefined : ch;
  };

  const lines: string[] = [];
  for (let line = 0; line < SPRITE_ROWS; line++) {
    let out = '';
    for (let col = 0; col < width; col++) {
      const top = pixelAt(col, line * 2);
      const bottom = pixelAt(col, line * 2 + 1);

      if (!top && !bottom) out += ' ';
      else if (top && !bottom) out += fg(top) + '▀' + RESET;
      else if (!top && bottom) out += fg(bottom) + '▄' + RESET;
      else if (top === bottom) out += fg(top!) + '█' + RESET;
      else out += fg(top!) + bg(bottom!) + '▀' + RESET;
    }
    lines.push(out);
  }
  return lines;
}

/** Whether the terminal can show the coloured sprite at all. */
export const spriteSupported = colorOn;
