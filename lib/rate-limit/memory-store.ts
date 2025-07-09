// Memory-based rate limit store for simplicity
// In production, consider using Redis for distributed systems

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export class MemoryStore {
  private store: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000);
  }

  increment(key: string, windowMs: number): { count: number; resetTime: number } {
    const now = Date.now();
    const resetTime = now + windowMs;
    
    const entry = this.store.get(key);
    
    if (!entry || entry.resetTime < now) {
      // New entry or expired
      const newEntry = { count: 1, resetTime };
      this.store.set(key, newEntry);
      return newEntry;
    }
    
    // Increment existing entry
    entry.count++;
    return entry;
  }

  get(key: string): RateLimitEntry | undefined {
    const entry = this.store.get(key);
    if (entry && entry.resetTime < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  reset(key: string): void {
    this.store.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.store.entries());
    for (const [key, entry] of entries) {
      if (entry.resetTime < now) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }

  // Get all entries for monitoring
  getAllEntries(): Map<string, RateLimitEntry> {
    this.cleanup(); // Clean up expired entries first
    return new Map(this.store);
  }

  // Get entries by pattern (e.g., all entries for a specific endpoint)
  getEntriesByPattern(pattern: string): Map<string, RateLimitEntry> {
    const matches = new Map<string, RateLimitEntry>();
    const now = Date.now();
    const entries = Array.from(this.store.entries());
    
    for (const [key, entry] of entries) {
      if (key.includes(pattern) && entry.resetTime >= now) {
        matches.set(key, entry);
      }
    }
    
    return matches;
  }
}

// Singleton instance
export const memoryStore = new MemoryStore();