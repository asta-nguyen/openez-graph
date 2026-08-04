export interface RankedItem<T> {
  item: T;
  score: number;
}

export function reciprocalRankFusion<T extends { id: string }>(
  resultSets: Array<Array<RankedItem<T>>>,
  k = 60,
  weights: number[] = [],
  identity: (item: T) => string = (item) => item.id,
): Array<RankedItem<T>> {
  const map = new Map<string, RankedItem<T>>();

  resultSets.forEach((resultSet, resultSetIndex) => {
    resultSet.forEach((entry, index) => {
      const existing = map.get(identity(entry.item));
      const score = (weights[resultSetIndex] ?? 1) / (k + index + 1);
      if (existing) {
        existing.score += score;
      } else {
        map.set(identity(entry.item), {
          item: entry.item,
          score,
        });
      }
    });
  });

  return [...map.values()].sort((left, right) => right.score - left.score);
}
