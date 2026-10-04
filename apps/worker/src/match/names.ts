/**
 * Name folding for the people name-merge key (LLD-MATCH, ADR-0015, BR-10): case and diacritics
 * folded, punctuation dropped, whitespace collapsed.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The value stored in `sort_title` / `sort_name`: lower case, trimmed. */
export function sortKey(name: string, preferred?: string): string {
  const base = (preferred?.trim() ? preferred : name).trim().toLowerCase();
  return base === '' ? name.toLowerCase() : base;
}
