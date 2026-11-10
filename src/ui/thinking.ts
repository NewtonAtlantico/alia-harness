import pc from 'picocolors';
import { FrameName, SPRITE_WIDTH, renderSprite, spriteSupported } from './sprite.js';
import { brandLight, muted } from './theme.js';

const TICK_MS = 80;
const INDENT = 2;
const LABEL_WIDTH = 16;
const MAX_TRACK = 28;
const IDLE_TICKS = 10;
/** Terminal row (inside the sprite) where the status label is drawn. */
const LABEL_ROW = 4;

interface Step {
  x: number;
  mirrored: boolean;
  frame: FrameName;
}

/**
 * Builds one full loop of the animation:
 * stand (blinking) -> run right -> stand (blinking) -> run back, mirrored.
 */
function buildCycle(maxX: number): Step[] {
  const steps: Step[] = [];

  const stand = (x: number, mirrored: boolean) => {
    for (let i = 0; i < IDLE_TICKS; i++) {
      const blinking = i === IDLE_TICKS - 4 || i === IDLE_TICKS - 3;
      steps.push({ x, mirrored, frame: blinking ? 'blink' : 'idle' });
    }
  };
  const run = (from: number, to: number, mirrored: boolean) => {
    const dir = to >= from ? 1 : -1;
    for (let x = from + dir, n = 0; dir > 0 ? x <= to : x >= to; x += dir, n++) {
      steps.push({ x, mirrored, frame: n % 2 === 0 ? 'runA' : 'runB' });
    }
  };

  stand(0, false);
  run(0, maxX, false);
  stand(maxX, false);
  run(maxX, 0, true);
  return steps;
}

/**
 * Animated "thinking" indicator: the Alia mascot paces back and forth while
 * the model works. Falls back to a plain text line when the terminal can't
 * render it (no colour, not a TTY, or too narrow).
 */
export class ThinkingAnimation {
  private timer?: NodeJS.Timeout;
  private startedAt = 0;
  private tick = 0;
  private drawnLines = 0;
  private cycle: Step[] = [];
  private trackWidth = 0;
  private label: string;
  private onSigint = () => {
    this.stop();
    process.exit(130);
  };
  private onExit = () => {
    if (this.timer) process.stdout.write('\x1b[?25h');
  };

  constructor(label = 'Thinking') {
    this.label = label;
  }

  start(): this {
    this.startedAt = Date.now();
    const columns = process.stdout.columns || 80;
    this.trackWidth = Math.min(MAX_TRACK, columns - INDENT - 2 - LABEL_WIDTH);

    const animated =
      process.stdout.isTTY && spriteSupported && this.trackWidth >= SPRITE_WIDTH + 4;

    if (!animated) {
      process.stdout.write(muted(`${this.label}…\r`));
      this.timer = undefined;
      return this;
    }

    this.cycle = buildCycle(this.trackWidth - SPRITE_WIDTH);
    process.stdout.write('\x1b[?25l'); // hide cursor
    process.once('exit', this.onExit);
    process.once('SIGINT', this.onSigint);
    this.draw();
    this.timer = setInterval(() => {
      this.tick++;
      this.draw();
    }, TICK_MS);
    this.timer.unref?.();
    return this;
  }

  /** Stops the animation and erases it from the terminal. */
  stop(): void {
    if (!this.timer) {
      // Plain-text fallback: just wipe the status line.
      process.stdout.write('\r\x1b[K');
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener('SIGINT', this.onSigint);
    process.removeListener('exit', this.onExit);
    if (this.drawnLines > 0) process.stdout.write(`\x1b[${this.drawnLines}A`);
    process.stdout.write('\x1b[0J\x1b[?25h'); // clear below, show cursor
    this.drawnLines = 0;
  }

  private statusText(): string {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const dots = '.'.repeat((Math.floor(this.tick / 5) % 3) + 1).padEnd(3);
    const text = pc.bold(brandLight(this.label)) + brandLight(dots);
    return seconds >= 1 ? text + muted(` ${seconds}s`) : text;
  }

  private draw(): void {
    const step = this.cycle[this.tick % this.cycle.length];
    const sprite = renderSprite(step.frame, step.x, this.trackWidth, step.mirrored);
    const pad = ' '.repeat(INDENT);
    const ground = pad + muted('─'.repeat(this.trackWidth));

    const lines = sprite.map((row, i) =>
      i === LABEL_ROW ? `${pad}${row}  ${this.statusText()}` : `${pad}${row}`
    );
    lines.push(ground);

    let out = this.drawnLines > 0 ? `\x1b[${this.drawnLines}A` : '';
    for (const line of lines) out += `\r\x1b[2K${line}\n`;
    process.stdout.write(out);
    this.drawnLines = lines.length;
  }
}
