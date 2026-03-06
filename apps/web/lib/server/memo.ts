interface MemoEntry<T> {
  expiresAt: number;
  promise?: Promise<T>;
  value?: T;
}

const memoStore = new Map<string, MemoEntry<unknown>>();
const MAX_ENTRIES = 500;

export async function memoizeAsync<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const normalizedTtlMs = Math.max(0, Math.trunc(ttlMs));
  if (normalizedTtlMs <= 0) {
    return loader();
  }

  const now = Date.now();
  const existing = memoStore.get(key) as MemoEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    if (existing.value !== undefined) {
      return existing.value;
    }
    if (existing.promise) {
      return existing.promise;
    }
  }

  pruneExpiredEntries(now);

  const promise = loader()
    .then((value) => {
      memoStore.set(key, {
        expiresAt: Date.now() + normalizedTtlMs,
        value
      });
      return value;
    })
    .catch((error) => {
      memoStore.delete(key);
      throw error;
    });

  memoStore.set(key, {
    expiresAt: now + normalizedTtlMs,
    promise
  });

  return promise;
}

function pruneExpiredEntries(now: number): void {
  if (memoStore.size < MAX_ENTRIES) {
    for (const [key, entry] of memoStore.entries()) {
      if (entry.expiresAt <= now) {
        memoStore.delete(key);
      }
    }
    return;
  }

  for (const [key, entry] of memoStore.entries()) {
    if (entry.expiresAt <= now || memoStore.size > MAX_ENTRIES) {
      memoStore.delete(key);
    }
  }
}
