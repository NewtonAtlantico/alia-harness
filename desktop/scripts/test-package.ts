/**
 * Builds the app the way an installer would carry it (unpacked, with ASAR) and checks what only a packaged build can
 * show: the Electron fuses are set as the security checklist requires, and the same smoke test passes against the
 * executable. Run from desktop/: `npm run test:package`. Takes a minute or two (it downloads Electron on first use).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE;
const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { cwd: desktop, env: { ...env, ...extraEnv }, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600_000 });

console.log('\n=== building ===');
const build = run(['electron-vite', 'build']);
check('the app builds', build.status === 0, build.stderr.slice(-500));
const pack = run(['electron-builder', '--win', '--dir', '--publish', 'never']);
check('it packages (ASAR, unsigned)', pack.status === 0, (pack.stdout + pack.stderr).slice(-800));
const exe = path.join(desktop, 'dist', 'win-unpacked', 'alia Harness.exe');
check('the executable exists', fs.existsSync(exe));

if (fs.existsSync(exe)) {
  console.log('\n=== fuses ===');
  const wire = await getCurrentFuseWire(exe);
  const on = (o: FuseV1Options) => wire[o] === FuseState.ENABLE;
  const off = (o: FuseV1Options) => wire[o] === FuseState.DISABLE;
  check('ELECTRON_RUN_AS_NODE is ignored (runAsNode off)', off(FuseV1Options.RunAsNode));
  check('NODE_OPTIONS is ignored', off(FuseV1Options.EnableNodeOptionsEnvironmentVariable));
  check('--inspect and friends are ignored', off(FuseV1Options.EnableNodeCliInspectArguments));
  check('only app.asar is loaded, and its integrity is validated', on(FuseV1Options.OnlyLoadAppFromAsar) && on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation));
  check('file:// pages get no extra privileges (the app is served from its own protocol)', off(FuseV1Options.GrantFileProtocolExtraPrivileges));
  check('cookie storage is encrypted', on(FuseV1Options.EnableCookieEncryption));

  console.log('\n=== the packaged app works ===');
  const smoke = run(['tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/smoke-app.ts'], { ALIA_SMOKE_EXE: exe });
  check('the smoke test passes against the executable (renderer, engine, PDF, Word, deck)', smoke.status === 0, (smoke.stdout + smoke.stderr).slice(-1500));
  const asar = path.join(desktop, 'dist', 'win-unpacked', 'resources', 'app.asar');
  check('the code ships inside app.asar, with no node_modules beside it', fs.existsSync(asar) && !fs.existsSync(path.join(desktop, 'dist', 'win-unpacked', 'resources', 'app', 'node_modules')));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll packaging checks passed.');
