export interface CacheEntry<T> {
    value: T;
    fetchedAt: number;
}

export interface Cache<T> {
    /** The last good value, whether or not it is stale. Null until the first success. */
    peek(): CacheEntry<T> | null;
    isStale(): boolean;
    /** Runs `produce` at most once concurrently, no matter how many callers arrive. */
    refresh(): Promise<CacheEntry<T>>;
    inFlight(): boolean;
}

export interface CacheDeps<T> {
    /** A thunk because a TTL can be floored or derived from a list that loads lazily. */
    ttlMs: number | (() => number);
    produce: () => Promise<T>;
    now?: () => number;
}

/**
 * One in-memory slot with single-flight refresh. Callers decide whether to serve a stale entry,
 * which is what keeps the last good render on screen while a refresh is failing.
 */
export function createCache<T>({ ttlMs, produce, now = Date.now }: CacheDeps<T>): Cache<T> {
    let entry: CacheEntry<T> | null = null;
    let pending: Promise<CacheEntry<T>> | null = null;
    const ttl = typeof ttlMs === 'function' ? ttlMs : () => ttlMs;

    return {
        peek: () => entry,
        isStale: () => entry === null || now() - entry.fetchedAt >= ttl(),
        inFlight: () => pending !== null,
        refresh() {
            if (pending) return pending;
            pending = produce()
                .then((value) => {
                    entry = { value, fetchedAt: now() };
                    return entry;
                })
                .finally(() => {
                    pending = null;
                });
            return pending;
        },
    };
}
