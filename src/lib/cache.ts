/* eslint-disable functional/immutable-data */
// TTL cache using Map. Mutation is confined to this module's IO boundary.

import { config } from "./config.js";

type CacheEntry<T> = {
  readonly value: T;
  readonly expiresAt: number;
};

type Cache<T> = Map<string, CacheEntry<T>>;

export const createCache = <T>(): Cache<T> => new Map();

const isValid = <T>(entry: CacheEntry<T>, now: number): boolean =>
  entry.expiresAt > now;

export const get = <T>(cache: Cache<T>, key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (!isValid(entry, Date.now())) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

export const set = <T>(
  cache: Cache<T>,
  key: string,
  value: T,
  ttlMs: number = config.cache.ttlMs
): void => {
  if (cache.size >= config.cache.maxEntries) {
    const now = Date.now();
    const keysToDelete = [...cache.entries()]
      .filter(([, entry]) => !isValid(entry, now))
      .map(([k]) => k);
    keysToDelete.forEach((k) => cache.delete(k));

    if (cache.size >= config.cache.maxEntries) {
      const oldest = [...cache.entries()]
        .reduce((min, curr) => (curr[1].expiresAt < min[1].expiresAt ? curr : min));
      cache.delete(oldest[0]);
    }
  }

  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

// Deterministic, deep serialization: object keys are sorted at EVERY level.
// (Passing a key array as JSON.stringify's replacer — the previous approach —
// acts as an allow-list applied to nested objects too, which silently dropped
// every nested field such as segments[].travelDate, so searches on different
// dates or routes collided on the same cache entry.)
const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableSerialize(v))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableSerialize(record[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? String(value);
};

export const buildCacheKey = (obj: unknown): string =>
  typeof obj === "object" && obj !== null ? stableSerialize(obj) : String(obj);
