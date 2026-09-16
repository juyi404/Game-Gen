

export function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
