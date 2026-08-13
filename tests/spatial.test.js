import { describe, it, expect } from 'vitest';
import { SpatialHashGrid } from '../src/core/spatial.js';

describe('Spatial Hash Grid (GDD Section 5 Broadphase)', () => {
  it('should insert entities and query them by radius', () => {
    const grid = new SpatialHashGrid(64);
    const e1 = { id: 1, x: 100, y: 100, radius: 10 };
    const e2 = { id: 2, x: 110, y: 100, radius: 10 };
    const e3 = { id: 3, x: 500, y: 500, radius: 10 };

    grid.insert(e1);
    grid.insert(e2);
    grid.insert(e3);

    const query1 = Array.from(grid.queryRadius(105, 100, 20));
    expect(query1).toContain(e1);
    expect(query1).toContain(e2);
    expect(query1).not.toContain(e3);
  });

  it('should handle entities spanning multiple grid cells', () => {
    const grid = new SpatialHashGrid(64);
    const largeEntity = { id: 99, x: 64, y: 64, radius: 45 };

    grid.insert(largeEntity);

    // Query adjacent cells
    const query = Array.from(grid.queryRadius(30, 30, 10));
    expect(query).toContain(largeEntity);
  });

  it('should clear all entries', () => {
    const grid = new SpatialHashGrid(64);
    const e1 = { id: 1, x: 100, y: 100, radius: 10 };
    grid.insert(e1);

    grid.clear();
    const query = Array.from(grid.queryRadius(100, 100, 50));
    expect(query).toHaveLength(0);
  });
});
