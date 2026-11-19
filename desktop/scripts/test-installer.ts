/**
 * Builds the real distribution (the per-user NSIS installer and the portable zip) and looks inside what was built, without
 * installing anything on this computer: the installer asks for no administrator rights, the names carry the version, the skills
 * ship in resources, and the program from the zip passes the same smoke test as the unpacked one. Takes a few minutes.
 * Run from desktop/: `npm run test:installer`. A real install on a clean Windows 11 profile stays a manual step (backlog, A17).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const repo = path.resolve(desktop, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as { version: string };
const env = { ...process.env } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE;
const win = process.platform === 'win32';
// npx and npm are scripts on Windows and need a shell; a program with spaces in its path (7-zip, the installer) must not get one.
const run = (cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = desktop) => {
  const script = cmd === 'npx' || cmd === 'npm';
  return spawnSync(win && script ? `${cmd}.cmd` : cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', shell: win && script, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
};
/** electron-builder downloads its own 7-zip into its cache the first time it builds; use that one (or a 7z on the PATH). */
function find7za(): string {
  const cache = process.env.ELECTRON_BUILDER_CACHE ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^7za?.exe$/i.test(e.name)) hits.push(p);
    }
  };
  walk(cache, 0);
  return hits[0] ?? '7z';
}
const skillCount = fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(repo, 'skills', e.name, 'SKILL.md'))).length;

console.log('\n=== building the installer and the zip ===');
const dist = path.join(desktop, 'dist');
let sevenZip = '7z';
const build = run('npx', ['electron-vite', 'build']);
check('the app builds', build.status === 0, build.stderr.slice(-400));
const pack = run('npx', ['electron-builder', '--win', '--publish', 'never']);
check('electron-builder makes both, unsigned, with no certificate needed', pack.status === 0 && /signing is skipped/.test(pack.stdout + pack.stderr), (pack.stdout + pack.stderr).slice(-800));
sevenZip = find7za();
check('a 7-zip is there to look inside with', fs.existsSync(sevenZip) || sevenZip === '7z', sevenZip);
const setup = path.join(dist, `alia Harness Setup ${pkg.version}.exe`);
const zip = path.join(dist, `alia Harness-${pkg.version}-win.zip`);
check('the names carry the version from package.json', fs.existsSync(setup) && fs.existsSync(zip), `${pkg.version}: ${fs.existsSync(dist) ? fs.readdirSync(dist).join(', ') : ''}`);
check('both are real (tens of megabytes, with Electron inside), and there is a block map for updates', fs.statSync(setup).size > 50e6 && fs.statSync(zip).size > 50e6 && fs.existsSync(`${setup}.blockmap`));

console.log('\n=== the installer is per user ===');
{
  const bytes = fs.readFileSync(setup);
  const text = bytes.toString('latin1');
  check('it asks for no administrator rights (its manifest says asInvoker)', text.includes('asInvoker') && !text.includes('requireAdministrator'));
  const listing = run(sevenZip, ['l', setup]);
  check('it carries the program, the code in an ASAR and the skills', /alia Harness\.exe/.test(listing.stdout) && /resources[\\/]app\.asar/.test(listing.stdout) && /resources[\\/]skills[\\/]e2e-pipeline[\\/]SKILL\.md/.test(listing.stdout), listing.stdout.slice(-300));
}

console.log('\n=== inside the installer ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-installer-'));
try {
  const outer = path.join(tmp, 'outer');
  run(sevenZip, ['x', setup, `-o${outer}`, '-y']);
  // Older builders wrapped the program in app-64.7z; this one stores it in the installer directly.
  const wrapped = [path.join(outer, '$PLUGINSDIR', 'app-64.7z'), path.join(outer, 'app-64.7z')].find((p) => fs.existsSync(p));
  check('what would be installed can be taken out of it', !!wrapped || fs.existsSync(path.join(outer, 'alia Harness.exe')));
  {
    let inner = outer;
    if (wrapped) {
      inner = path.join(tmp, 'installed');
      run(sevenZip, ['x', wrapped, `-o${inner}`, '-y']);
    }
    const exe = path.join(inner, 'alia Harness.exe');
    check('the program, its code in an ASAR, and the skills are in what would be installed', fs.existsSync(exe) && fs.existsSync(path.join(inner, 'resources', 'app.asar')) && fs.existsSync(path.join(inner, 'resources', 'skills', 'e2e-pipeline', 'SKILL.md')));
    const shipped = fs.readdirSync(path.join(inner, 'resources', 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(inner, 'resources', 'skills', e.name, 'SKILL.md'))).length;
    check(`every skill ships (${skillCount})`, shipped === skillCount, `${shipped} of ${skillCount}`);
    const wire = await getCurrentFuseWire(exe);
    check('the fuses are set in what the installer carries', wire[FuseV1Options.RunAsNode] === FuseState.DISABLE && wire[FuseV1Options.OnlyLoadAppFromAsar] === FuseState.ENABLE && wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === FuseState.ENABLE);
  }

  console.log('\n=== the portable zip ===');
  const unzipped = path.join(tmp, 'zip');
  run(sevenZip, ['x', zip, `-o${unzipped}`, '-y']);
  const zexe = path.join(unzipped, 'alia Harness.exe');
  check('it unpacks to a program with the skills beside it', fs.existsSync(zexe) && fs.existsSync(path.join(unzipped, 'resources', 'skills', 'e2e-pipeline', 'SKILL.md')));
  const version = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${zexe}').VersionInfo.ProductVersion`], { encoding: 'utf8' });
  check('its version is the one in package.json', version.stdout.trim().startsWith(pkg.version), version.stdout.trim());
  const smoke = run('npx', ['tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/smoke-app.ts'], { ALIA_SMOKE_EXE: zexe });
  check('the program from the zip passes the smoke test (renderer, engine, PDF, Word, deck)', smoke.status === 0, (smoke.stdout + smoke.stderr).slice(-1200));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll installer checks passed.');
