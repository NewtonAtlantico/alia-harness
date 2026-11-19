import fs from 'node:fs';
let t = fs.readFileSync('scripts/test-timeline.ts', 'utf8');
const rep = (a, b) => { if (!t.includes(a)) throw new Error('missing: ' + a.slice(0, 70)); t = t.replace(a, () => b); };
rep("tool('edit_file', { path: 'a.txt', old_string: 'alfa', new_string: 'ALFA\nbeta2' }, 'e1')", "tool('edit_file', { path: 'a.txt', target: 'alfa', replacement: 'ALFA\nbeta2' }, 'e1')");
rep("top[0].subagent.status === 'done'", "top[0].subagent.status === 'completed'");
rep("fs.rmSync(tmp, { recursive: true, force: true });\nif (failures", "try {\n  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });\n} catch {\n  /* a command killed a moment ago may still hold its folder; the OS temp folder is cleaned later */\n}\nif (failures");
fs.writeFileSync('scripts/test-timeline.ts', t);
