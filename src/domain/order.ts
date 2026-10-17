import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
export function orderBetween(before?: string | null, after?: string | null): string {
  return generateKeyBetween(before ?? null, after ?? null);
}
export function ordersBetween(
  count: number,
  before?: string | null,
  after?: string | null,
): string[] {
  return generateNKeysBetween(before ?? null, after ?? null, count);
}
export const rankBetween = orderBetween;
export function rebalanceOrder(ids: string[]): Record<string, string> {
  const keys = generateNKeysBetween(null, null, ids.length);
  return Object.fromEntries(ids.map((id, i) => [id, keys[i]]));
}
export function compareOrder(
  a: { order: string; id: string },
  b: { order: string; id: string },
): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
