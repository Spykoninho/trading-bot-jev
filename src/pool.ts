// Au plus `size` tâches en vol ; les résultats gardent l'ordre des entrées et un échec n'annule pas les autres
export async function pool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) results[i] = (await Promise.allSettled([worker(items[i]!)]))[0]!;
    }),
  );
  return results;
}
