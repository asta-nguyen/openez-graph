export interface RankedItem<T> {
  item: T;
  score: number;
}

export function reciprocalRankFusion<T>(
  resultSets: Array<Array<RankedItem<T>>>,
  k = 60,
  weights: number[] = [],
  identity: (item: T) => string = (item: any) =>
    // SAFETY: ranked items are ChunkHit-shaped rows whose `id` or `path` is the stable identity key; both are coerced to string so a missing field yields "".
    String((item as any).id ?? (item as any).path ?? ""),
): Array<RankedItem<T>> {
  const map = new Map<string, RankedItem<T>>();

  resultSets.forEach((resultSet, resultSetIndex) => {
    resultSet.forEach((entry, index) => {
      const key = identity(entry.item);
      const existing = map.get(key);
      const score = (weights[resultSetIndex] ?? 1) / (k + index + 1);
      if (existing) {
        existing.score += score;
      } else {
        map.set(key, {
          item: entry.item,
          score,
        });
      }
    });
  });

  return [...map.values()].sort((left, right) => right.score - left.score);
}
