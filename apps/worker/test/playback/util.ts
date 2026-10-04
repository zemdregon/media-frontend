/** Narrows a value the test knows is present; fails the test loudly otherwise. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value');
  return value;
}
