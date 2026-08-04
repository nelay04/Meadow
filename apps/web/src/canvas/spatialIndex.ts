/**
 * R-tree over object bounds, for viewport culling and hit-test candidate lookup.
 *
 * rbush removes entries by identity, not by value, so every inserted entry is kept in
 * a side map. Rebuilding the entry object on update and forgetting to remove the old
 * one leaks it into the tree, where it shows up much later as a phantom object that
 * can be clicked but not seen.
 */

import RBush from 'rbush'

import type { WorldRect } from './camera'

export type IndexEntry = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

export class SpatialIndex {
  private readonly tree = new RBush<IndexEntry>()
  private readonly entries = new Map<string, IndexEntry>()

  get size(): number {
    return this.entries.size
  }

  insert(id: string, bounds: WorldRect): void {
    this.remove(id)
    const entry: IndexEntry = { ...bounds, id }
    this.entries.set(id, entry)
    this.tree.insert(entry)
  }

  remove(id: string): void {
    const existing = this.entries.get(id)
    if (existing === undefined) return
    this.tree.remove(existing)
    this.entries.delete(id)
  }

  /** Bulk-load. Much faster than repeated inserts, so prefer it for a full resync. */
  reset(items: { id: string; bounds: WorldRect }[]): void {
    this.tree.clear()
    this.entries.clear()
    const entries = items.map(({ id, bounds }) => {
      const entry: IndexEntry = { ...bounds, id }
      this.entries.set(id, entry)
      return entry
    })
    this.tree.load(entries)
  }

  clear(): void {
    this.tree.clear()
    this.entries.clear()
  }

  /** Ids whose bounds intersect the rectangle. Order is unspecified. */
  search(rect: WorldRect): string[] {
    return this.tree.search(rect).map((entry) => entry.id)
  }

  boundsOf(id: string): WorldRect | undefined {
    return this.entries.get(id)
  }
}
