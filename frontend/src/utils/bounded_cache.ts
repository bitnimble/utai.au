/** A Map that forgets its oldest entry once it holds `limit`. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
  }
}
