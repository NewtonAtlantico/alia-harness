import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const axeSource = fs.readFileSync(createRequire(path.join(here, '..', '..', 'package.json')).resolve('axe-core/axe.min.js'), 'utf8');

export interface Violation {
  id: string;
  impact: string;
  help: string;
  nodes: Array<{ target: string; summary: string }>;
}

/**
 * Runs axe-core (WCAG 2.0/2.1 A and AA, plus its best practices) on what the page shows now. The script is run through the
 * debugger protocol, so the page's own content security policy (which allows no inline script) does not get in the way.
 */
export async function audit(page: Page, options: { include?: string; skip?: string[] } = {}): Promise<Violation[]> {
  await page.evaluate(axeSource);
  const result = await page.evaluate(
    async ({ include, skip }) => {
      const run = (window as any).axe.run(include ? { include: [include] } : document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
        rules: Object.fromEntries(skip.map((id) => [id, { enabled: false }])),
      });
      const r = await run;
      return r.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        help: v.help,
        nodes: v.nodes.slice(0, 6).map((n: any) => ({ target: String(n.target), summary: String(n.failureSummary ?? '').split('\n').slice(0, 3).join(' | ') })),
      }));
    },
    { include: options.include, skip: options.skip ?? [] }
  );
  return (result as Violation[]).map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isKnown(v.id, n.target)) })).filter((v) => v.nodes.length > 0);
}

/**
 * What is accepted on purpose, and why. The composer is a text box that offers a list while you type (@ for files, / for commands);
 * it is a combobox in the ARIA authoring practices, but axe only allows that role on an input, not on a textarea. A textarea is
 * needed (several lines), and screen readers announce the list through aria-controls, so this one is left as it is.
 */
function isKnown(rule: string, target: string): boolean {
  return rule === 'aria-allowed-role' && /^textarea/.test(target);
}

export const describeViolations = (list: Violation[]): string => list.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => `${n.target} [${n.summary}]`).join('; ')}`).join('\n');

/**
 * Keyboard users have to see where they are: every control that can take the focus must show it (an outline or a ring) when it
 * has it. Returns the ones that do not. A real Tab press first, so the page is in keyboard mode and :focus-visible applies.
 */
export async function focusAudit(page: Page): Promise<string[]> {
  await page.keyboard.press('Tab');
  return page.evaluate(() => {
    const bad: string[] = [];
    const selector = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || (el as HTMLButtonElement).disabled || getComputedStyle(el).visibility === 'hidden' || el.closest('[inert], [aria-hidden="true"]')) continue;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) continue;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const ring = cs.boxShadow !== 'none';
      // A text box may show it on the box around it (focus-within): that counts, it is what the user sees.
      let around = false;
      for (let p = el.parentElement, depth = 0; p && depth < 3 && !around; p = p.parentElement, depth++) {
        const ps = getComputedStyle(p);
        around = p.matches(':focus-within') && ((ps.outlineStyle !== 'none' && parseFloat(ps.outlineWidth) > 0) || ps.boxShadow !== 'none');
      }
      if (!outline && !ring && !around) bad.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return bad;
  });
}
