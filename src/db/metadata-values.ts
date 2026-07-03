export function rowRecord(row: unknown): Record<string, unknown> {
  return row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
}

export function fieldValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value != null);
}

export function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = fieldValue(record, ...keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = fieldValue(record, ...keys);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
}
