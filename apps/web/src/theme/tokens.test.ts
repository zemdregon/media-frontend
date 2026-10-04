// NFR-A11Y-001 / NFR-UX-001: reads tokens.css and checks the declared pairs against the WCAG 2.x
// ratios in UX §3.4 for each theme independently, so a bad token fails before a page renders.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest runs with the package as the working directory.
const css = readFileSync(resolve(process.cwd(), 'src/theme/tokens.css'), 'utf8');

function block(selectorStart: string): Record<string, string> {
  const start = css.indexOf(selectorStart);
  if (start < 0) throw new Error(`Missing block ${selectorStart}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/--cw-([\w-]+):\s*([^;]+);/g)) {
    out[m[1] ?? ''] = (m[2] ?? '').trim();
  }
  return out;
}

const dark = block(':root {');
const lightMedia = block(":root:not([data-theme='dark']) {");
const lightForced = block(":root[data-theme='light'] {");

function lum(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// [foreground, background, minimum ratio]: the UX §3.4 table plus the pairs the UI uses.
const PAIRS: [string, string, number][] = [
  ['text', 'bg', 4.5],
  ['text', 'surface-1', 4.5],
  ['text', 'surface-selected', 4.5],
  ['text-2', 'surface-1', 4.5],
  ['text-body', 'bg', 4.5],
  ['text-body', 'surface-selected-row', 4.5],
  ['text-body', 'surface-2', 4.5],
  ['text-muted', 'bg', 4.5],
  ['text-muted', 'surface-nav', 4.5],
  ['text-muted', 'surface-1', 4.5],
  ['text-muted', 'surface-2', 4.5],
  ['text-muted', 'surface-selected', 4.5],
  ['text-placeholder', 'bg', 4.5],
  ['text-placeholder', 'surface-1', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface-nav', 4.5],
  ['accent', 'surface-1', 4.5],
  ['accent-hover', 'bg', 4.5],
  ['on-accent', 'accent', 4.5],
  ['on-accent', 'accent-hover', 4.5],
  ['status-ok', 'surface-1', 4.5],
  ['status-ok', 'surface-selected-row', 4.5],
  ['status-warn', 'surface-1', 4.5],
  ['status-bad', 'surface-1', 4.5],
  ['status-bad', 'surface-selected-row', 4.5],
  ['accent', 'surface-selected', 3],
  ['border-control', 'bg', 3],
  ['border-control', 'surface-1', 3],
  ['border-control', 'surface-selected-row', 3],
];

describe.each([
  ['dark', dark],
  ['light (prefers-color-scheme)', { ...dark, ...lightMedia }],
  ['light (data-theme)', { ...dark, ...lightForced }],
])('%s theme', (_name, tokens) => {
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    const f = tokens[fg];
    const b = tokens[bg];
    expect(f, `token --cw-${fg}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(b, `token --cw-${bg}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(ratio(f ?? '', b ?? '')).toBeGreaterThanOrEqual(min);
  });
});

describe('token parity (UX §3.5: one token set, two value sets)', () => {
  it('both light blocks carry identical values', () => {
    for (const [k, v] of Object.entries(lightForced)) {
      if (k.startsWith('r-') || k.startsWith('font-')) continue;
      expect(lightMedia[k], `--cw-${k}`).toBe(v);
    }
  });

  it('every colour token has a light value', () => {
    const colours = Object.entries(dark).filter(([k, v]) => /^#/.test(v) && !k.includes('scrim'));
    for (const [k] of colours) expect(lightForced[k], `--cw-${k}`).toBeDefined();
  });
});
