import { urlKey } from './url-check'

/**
 * LRU map from image URL to the CDP request id of its response (design section 7).
 * Cleared on main-frame navigation. Pure data structure, no Electron.
 */
export class RequestMap {
  private readonly map = new Map<string, string>()

  constructor(private readonly capacity = 2000) {}

  set(url: string, requestId: string): void {
    const key = urlKey(url)
    this.map.delete(key)
    this.map.set(key, requestId)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  get(url: string): string | undefined {
    const key = urlKey(url)
    const id = this.map.get(key)
    if (id !== undefined) {
      // Refresh recency.
      this.map.delete(key)
      this.map.set(key, id)
    }
    return id
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
