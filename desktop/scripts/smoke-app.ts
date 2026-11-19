/**
 * `npm run smoke` (in desktop/): launches the BUILT app, with the same bundles an installer would carry, and checks
 * the whole stack answers: renderer -> preload -> main -> engine (utility process) -> core. The engine also reads a
 * PDF, a Word file and a deck and creates a session, because those are what bundling and packaging tend to break.
 *
 * It opens a real window for a moment. Needs `npm run build` first (the `smoke` npm script does it).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf } from '../../scripts/lib/pdfFixture.js';
import { makeDocx, makePptx, w } from '../../scripts/lib/officeFixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-desktop-smoke-'));

fs.writeFileSync(path.join(dir, 'sample.pdf'), makePdf([['Primeira página'], ['Segunda página']]));
fs.writeFileSync(path.join(dir, 'sample.docx'), makeDocx({ body: w.h(1, 'Requisitos') + w.p('O portal deve permitir login.') }));
fs.writeFileSync(path.join(dir, 'sample.pptx'), makePptx({ slides: [{ title: 'Visão geral', notes: 'Falar do prazo' }] }));

if (!process.env.ALIA_SMOKE_EXE && !fs.existsSync(path.join(desktop, 'out', 'main', 'index.js'))) {
  console.error('The app is not built. Run `npm run build` in desktop/ first.');
  process.exit(2);
}

// ALIA_SMOKE_EXE: run a packaged app (dist/win-unpacked/alia Harness.exe) instead of the dev build in out/.
const packaged = process.env.ALIA_SMOKE_EXE;
const electronBinary: string = packaged ?? createRequire(path.join(desktop, 'package.json'))('electron'); // the executable's path
// ELECTRON_RUN_AS_NODE is set when this runs from VS Code's terminal; with it, the binary would behave as plain Node.
const env = { ...process.env, ALIA_DESKTOP_SMOKE: dir, ALIA_DESKTOP_DATA_DIR: path.join(dir, 'data'), ELECTRON_RENDERER_URL: '' } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, packaged ? [] : ['.'], { cwd: packaged ? os.tmpdir() : desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const killer = setTimeout(() => child.kill(), 90_000);
const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
clearTimeout(killer);

const lines = out.split(/\r?\n/);
const line = lines.find((l) => l.startsWith('SMOKE_RESULT '));
fs.rmSync(dir, { recursive: true, force: true });
if (!line) {
  console.log('  ✘ the app printed no result\n' + out.slice(-2000));
  process.exit(1);
}
const result = JSON.parse(line.slice('SMOKE_RESULT '.length));
const show = (ok: boolean, name: string, detail?: string) => console.log(`  ${ok ? '✔' : '✘'} ${name}${!ok && detail ? ` (${detail})` : ''}`);

show(result.viaRenderer?.pong === true, 'renderer -> preload -> main -> engine round trip');
show(result.viaRenderer?.pid !== undefined && result.viaRenderer.pid !== result.mainPid, 'the engine is a separate process from main', `engine ${result.viaRenderer?.pid}, main ${result.mainPid}`);
show(result.viaRenderer?.coreStages === 4, 'core is bundled into the engine');
for (const c of result.selfTest?.checks ?? []) show(c.ok, c.name, c.detail);
if (!result.ok && result.why) console.log(`  ✘ ${result.why}`);

if (code !== 0 || !result.ok) {
  const tail = lines.filter((l) => l.trim() && !l.startsWith('SMOKE_RESULT')).slice(-40);
  console.log(`\n--- app output ---\n${tail.join('\n')}`);
  console.log('\nThe desktop smoke test failed.');
  process.exit(1);
}
console.log('\nThe desktop smoke test passed.');
