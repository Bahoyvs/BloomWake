/**
 * Minimal object pool for card-spawned entities.
 *
 * SCOPE: deliberately narrow. Phase 3 cards spawn objects in bursts — Petal
 * Storm throws 16 petals at once and Glasswing rebuilds its blade ring on every
 * level-up — so those allocations are recycled here. This is NOT the Phase 2
 * performance layer: no spatial hash, no enemy cap, no particle system.
 *
 * Pure JS, no DOM.
 */

export class ObjectPool {
  /**
   * @param {() => Object} factory - Creates a blank entity
   * @param {number} [initialSize] - Objects to pre-allocate
   */
  constructor(factory, initialSize = 0) {
    this.factory = factory;
    this.free = [];
    /** Objects ever constructed — a pool that keeps growing is a leak. */
    this.created = 0;
    this.reused = 0;

    for (let i = 0; i < initialSize; i++) {
      this.free.push(this.build());
    }
  }

  build() {
    this.created++;
    return this.factory();
  }

  /**
   * Take an object from the pool, constructing one only if none are free.
   * @returns {Object}
   */
  acquire() {
    const obj = this.free.pop();
    if (obj) {
      this.reused++;
      return obj;
    }
    return this.build();
  }

  /**
   * Return an object to the pool for reuse.
   * @param {Object} obj
   */
  release(obj) {
    obj.alive = false;
    this.free.push(obj);
  }

  /** Number of objects currently parked in the pool. */
  get available() {
    return this.free.length;
  }
}

/**
 * Compact a list of entities in place, returning dead ones to their pool.
 * Allocation-free: same swap-remove as `removeDead`, plus recycling.
 *
 * @param {Array<{alive: boolean}>} list
 * @param {ObjectPool} pool
 */
export function sweepToPool(list, pool) {
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const item = list[read];
    if (item.alive) {
      list[write] = item;
      write++;
    } else {
      pool.release(item);
    }
  }
  list.length = write;
}
