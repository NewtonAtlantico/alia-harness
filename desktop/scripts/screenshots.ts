/**
 * Takes a screenshot of every screen of the journey (settings, start, an approval, the changes panel, the pipeline intake, the
 * three gates, the final report and the publish dialog) into docs/screenshots/desktop/, for review against the design. It is the
 * journey test with a folder to keep the pictures in, so each picture is of a state the app really reached. Run from desktop/:
 * `npm run screenshots` (builds first). The fake model and the tmp project are the same as in the test: no real data is shown.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(desktop, '..', 'docs', 'screenshots', 'desktop');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const win = process.platform === 'win32';
const build = spawnSync(win ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: desktop, stdio: 'ignore', shell: win });
if (build.status !== 0) {
  console.error('The build failed.');
  process.exit(1);
}
const run = spawnSync(win ? 'npx.cmd' : 'npx', ['tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/test-journey-app.ts'], { cwd: desktop, stdio: 'inherit', shell: win, env: { ...process.env, ALIA_SHOTS: out, ALIA_JOURNEY_TMP: path.join(path.parse(os.tmpdir()).root, 'alia-demo') } });
fs.rmSync(path.join(path.parse(os.tmpdir()).root, 'alia-demo'), { recursive: true, force: true });
console.log(`\n${fs.readdirSync(out).length} screenshots in ${path.relative(path.resolve(desktop, '..'), out)}`);
process.exit(run.status ?? 1);
