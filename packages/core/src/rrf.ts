export interface RankedItem<T> {
  item: T;
  score: number;
}

export function reciprocalRankFusion<T extends { id: string }>(
  resultSets: Array<Array<RankedItem<T>>>,
  k = 60
): Array<RankedItem<T>> {
  const map = new Map<string, RankedItem<T>>();

  resultSets.forEach((resultSet) => {
    resultSet.forEach((entry, index) => {
      const existing = map.get(entry.item.id);
      const score = 1 / (k + index + 1);
      if (existing) {
        existing.score += score;
      } else {
        map.set(entry.item.id, {
          item: entry.item,
          score
        });
      }
    });
  });

  return [...map.values()].sort((left, right) => right.score - left.score);
}
