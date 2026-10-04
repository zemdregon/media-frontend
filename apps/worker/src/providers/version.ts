/** Version parsing for the IR-003 to IR-005 minimums (spike section 6). */

/** Leading numeric components of `12.1.0`, `4.10.1.0` or `1.43.4.10903-e5521bd8c`. */
export function parseVersion(raw: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)/.exec(raw.trim());
  if (!match?.[1]) return null;
  const parts = match[1].split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** True when `version` is at least `minimum` (missing components count as 0). */
export function versionAtLeast(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < Math.max(version.length, minimum.length); i++) {
    const a = version[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
