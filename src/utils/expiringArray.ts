export type ExpiringArrayConfig = {
    /** Time to live for each cache entry in milliseconds */
    ttlMs: number;
};

type CacheEntry<TValue> = {
    value: TValue;
    expiresAt: number;
};

export class ExpiringArray<TValue> {
    private readonly entries: CacheEntry<TValue>[] = [];
    private readonly ttlMs: number;

    constructor(config: ExpiringArrayConfig) {
        this.ttlMs = config.ttlMs;
    }

    /**
     * Adds a value to the cache with expiration
     * @param value The value to add to the cache
     * @param ttlMs Optional TTL override for this specific entry. If not provided, uses the default TTL from config
     */
    add(value: TValue, ttlMs?: number): this {
        const expiresAt = Date.now() + (ttlMs ?? this.ttlMs);
        this.entries.push({ value, expiresAt });
        return this;
    }

    /**
     * Clears all entries from the cache
     */
    clear(): void {
        this.entries.length = 0;
    }

    /**
     * Returns the number of non-expired entries in the cache
     */
    get size(): number {
        this.cleanup();
        return this.entries.length;
    }

    /**
     * Returns all non-expired values in the cache
     */
    values(): TValue[] {
        this.cleanup();
        return this.entries.map((entry) => entry.value);
    }

    /**
     * Removes expired entries from the cache
     */
    private cleanup(): void {
        const now = Date.now();
        const validEntries = this.entries.filter((entry) => now <= entry.expiresAt);
        this.entries.length = 0;
        this.entries.push(...validEntries);
    }
}
