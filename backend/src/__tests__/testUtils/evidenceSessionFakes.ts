/**
 * In-memory stand-ins for the two shared backends evidence-upload-session.service
 * now depends on (Redis for manifest/chunk-index state, S3 for chunk bytes), so
 * the service's tests exercise real state transitions without a live Redis
 * server or object store. Reset between tests via `.clear()`.
 */

export class FakeRedisStore {
  private strings = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  clear(): void {
    this.strings.clear();
    this.sets.clear();
  }

  get = async (key: string): Promise<string | null> => this.strings.get(key) ?? null;

  set = async (key: string, value: string): Promise<"OK"> => {
    this.strings.set(key, value);
    return "OK";
  };

  del = async (...keys: string[]): Promise<number> => {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return removed;
  };

  sadd = async (key: string, ...members: string[]): Promise<number> => {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added += 1;
      set.add(m);
    }
    this.sets.set(key, set);
    return added;
  };

  srem = async (key: string, ...members: string[]): Promise<number> => {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed += 1;
    }
    return removed;
  };

  smembers = async (key: string): Promise<string[]> => Array.from(this.sets.get(key) ?? []);
}

export class FakeEvidenceObjectStore {
  private objects = new Map<string, Buffer>();

  clear(): void {
    this.objects.clear();
  }

  put(key: string, body: Buffer): void {
    this.objects.set(key, body);
  }

  get(key: string): Buffer {
    const found = this.objects.get(key);
    if (!found) throw new Error(`Evidence object not found: ${key}`);
    return found;
  }

  delete(keys: string[]): void {
    for (const key of keys) this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
