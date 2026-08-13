/**
 * Spatial Hash Grid for BloomWake (GDD Section 5).
 * Broadphase collision optimization partitioning world space into 64px cells.
 * Reduces collision checks from O(n^2) to ~O(n).
 * Zero DOM / window dependencies.
 */

export class SpatialHashGrid {
  /**
   * @param {number} cellSize - Size of grid cells in pixels (default 64)
   */
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  /**
   * Convert world coordinates to grid cell key
   * @param {number} x
   * @param {number} y
   * @returns {string} Cell key "cellX,cellY"
   */
  getKey(x, y) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  /**
   * Clear all entities from the grid
   */
  clear() {
    this.grid.clear();
  }

  /**
   * Insert an entity into the grid
   * @param {Object} entity - Must have x, y properties (and optional radius)
   */
  insert(entity) {
    const radius = entity.radius || 0;
    const minCx = Math.floor((entity.x - radius) / this.cellSize);
    const maxCx = Math.floor((entity.x + radius) / this.cellSize);
    const minCy = Math.floor((entity.y - radius) / this.cellSize);
    const maxCy = Math.floor((entity.y + radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        let list = this.grid.get(key);
        if (!list) {
          list = [];
          this.grid.set(key, list);
        }
        list.push(entity);
      }
    }
  }

  /**
   * Query all entities within a circular radius around (x, y)
   * @param {number} x - Center X
   * @param {number} y - Center Y
   * @param {number} radius - Search radius
   * @returns {Set<Object>} Unique entities in range
   */
  queryRadius(x, y, radius) {
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);

    const results = new Set();
    const radiusSq = radius * radius;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        const list = this.grid.get(key);
        if (list) {
          for (let i = 0; i < list.length; i++) {
            const entity = list[i];
            const dx = entity.x - x;
            const dy = entity.y - y;
            if (dx * dx + dy * dy <= (radius + (entity.radius || 0)) ** 2) {
              results.add(entity);
            }
          }
        }
      }
    }

    return results;
  }
}
