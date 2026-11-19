import fs from 'node:fs';
const edit = (file, pairs) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(`missing in ${file}: ${a.slice(0, 80)}`); s = s.replace(a, () => b); }
  fs.writeFileSync(file, s);
};
edit('scripts/test-timeline-app.ts', [
  [
    "  check('it keeps the live rows of its second run, from disk',",
    "  const reopenedWrite = (await page.locator('[data-tool=\"write_file\"]').innerText()).replace(/\s+/g, ' ');\n  const reopenedEdit = (await page.locator('[data-tool=\"edit_file\"]').innerText()).replace(/\s+/g, ' ');\n  check('a conversation reopened from disk shows what each call changed, as it did live (+2 for the write, +2 −1 for the edit)', reopenedWrite.includes('Gravou out/novo.md') && reopenedWrite.includes('+2') && reopenedEdit.includes('+2') && reopenedEdit.includes('−1'), `${reopenedWrite} | ${reopenedEdit}`);\n  check('...and how long each took', /\d+(,\d)? (ms|s)/.test(reopenedWrite) && /\d+(,\d)? (ms|s)/.test(await page.locator('[data-tool=\"run_bash\"]').last().innerText()));\n  check('it keeps the live rows of its second run, from disk',",
  ],
]);

edit('scripts/test-interactions-app.ts', [
  [
    "    // R8: a background conversation\n    bash('echo fundo', 'b8'),\n    { content: 'fundo ok' },",
    "    // R8: a background conversation\n    bash('echo fundo', 'b8'),\n    { content: 'fundo ok' },\n    // R9: the app stops while a card is open\n    bash('echo queda', 'b9'),",
  ],
  [
    "  console.log('\n=== accessibility ===');",
    "  console.log('\n=== the app stops while a card is open ===');\n  await page.getByRole('list', { name: 'Conversas de projeto' }).getByRole('button', { name: /rode e eu vou cancelar/ }).click();\n  await box().waitFor();\n  await said('rode antes da queda');\n  await card().waitFor({ timeout: 15000 });\n  await app.evaluate(() => (globalThis as any).__aliaTest.engine.crashForTest());\n  const interrupted = page.locator('[data-notice=\"interrupted\"]');\n  await interrupted.waitFor({ timeout: 30000 });\n  check('the card is gone (nothing is waiting any more), and the conversation says it was interrupted', (await card().count()) === 0 && (await interrupted.innerText()).includes('foi interrompida') && (await interrupted.innerText()).includes('1 chamada'), await interrupted.innerText());\n  check('the command that was waiting is shown as cancelled, not as waiting for an approval nobody can give', (await page.locator('[data-tool=\"run_bash\"]').last().innerText()).includes('cancelado') && !(await page.locator('[data-tool=\"run_bash\"]').last().innerText()).includes('aguardando'));\n  check('nothing is left pending, no dot, and the box is ready to carry on', (await ok('interaction.pending')).length === 0 && (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0 && (await page.getByRole('button', { name: 'Enviar' }).count()) === 1);\n\n  console.log('\n=== accessibility ===');",
  ],
]);
console.log('e2e patched');
