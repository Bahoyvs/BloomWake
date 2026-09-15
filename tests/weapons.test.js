import { describe, it, expect } from 'vitest';
import { PROJECTILE_CFG } from '../src/core/constants.js';
import { CardSystem } from '../src/core/cards.js';
import { CARDS } from '../src/data/cards.js';
import { ENEMIES } from '../src/data/enemies.js';
import { EventBus } from '../src/core/event-bus.js';

/**
 * Drive the Phase Repeater once and collect the salvo it produced.
 *
 * A stub rather than a full Simulation: the thing under test is pure spawn
 * GEOMETRY, and a real simulation would bring waves, collisions and an RNG
 * along with it — none of which can make a bolt come out at the wrong angle,
 * but all of which can make a failure hard to read.
 *
 * @param {number} level - Phase Repeater card level (1-5)
 * @param {{x: number, y: number}} target - Where the enemy is
 * @returns {Array<Object>} Spawned projectiles
 */
function fireSalvo(level, target = { x: 300, y: 0 }) {
  const spawned = [];

  // CardSystem reads the whole simulation through `this.sim`, so the stub has
  // to present that shape: state.player, state.activeCards, and the two spawn
  // hooks the volley handler touches.
  const sim = {
    bus: new EventBus(),
    rng: () => 0.5,
    state: {
      player: { x: 0, y: 0 },
      activeCards: new Map([['dewdrop_barrage', level]]),
    },
    findNearestEnemy: () => ({ ...target, id: 1, alive: true, radius: 12 }),
    spawnProjectile: (p) => spawned.push(p),
  };

  const sys = new CardSystem(sim);
  // One update long enough to clear any starting cooldown.
  sys.update(10);
  return spawned;
}

/** Perpendicular distance from a bolt's flight line to a point. */
function missDistance(bolt, px, py) {
  const speed = Math.hypot(bolt.vx, bolt.vy);
  const ux = bolt.vx / speed;
  const uy = bolt.vy / speed;
  const dx = px - bolt.x;
  const dy = py - bolt.y;
  // Reject bolts travelling away from the point: a line passes through a target
  // behind the ship too, and that is not a hit.
  const along = dx * ux + dy * uy;
  if (along < 0) return Infinity;
  return Math.abs(dx * uy - dy * ux);
}

describe('salvo hardpoint geometry', () => {
  it('never places a hardpoint wider than the smallest target it must not straddle', () => {
    /*
     * THE INVARIANT THE WHOLE REWORK RESTS ON. Two parallel bolts at +/-OFFSET
     * both miss a target sitting dead centre unless the offset is inside the
     * target's hit envelope. The Dart Ravager (radius 9) is the roster's
     * smallest, so it sets the ceiling — and if someone adds a smaller enemy
     * later, this fails rather than silently reopening the dead zone.
     */
    const smallest = Math.min(...Object.values(ENEMIES).map((e) => e.radius));
    expect(PROJECTILE_CFG.HARDPOINT_OFFSET).toBeLessThanOrEqual(
      smallest + PROJECTILE_CFG.RADIUS
    );
  });

  it('matches the brief: 10-12px offset, 20-24px track separation', () => {
    expect(PROJECTILE_CFG.HARDPOINT_OFFSET).toBeGreaterThanOrEqual(10);
    expect(PROJECTILE_CFG.HARDPOINT_OFFSET).toBeLessThanOrEqual(12);
  });
});

describe('Phase Repeater salvo', () => {
  it('fires a single bolt from the nose, straight down the aim line', () => {
    const [bolt] = fireSalvo(1);
    expect(bolt.x).toBeCloseTo(0, 6);
    expect(bolt.y).toBeCloseTo(0, 6);
    expect(missDistance(bolt, 300, 0)).toBeCloseTo(0, 6);
  });

  it('fires the two-bolt salvo from opposite wingtips', () => {
    const salvo = fireSalvo(3);
    expect(salvo).toHaveLength(2);

    const offsets = salvo.map((b) => b.y).sort((a, b) => a - b);
    expect(offsets[0]).toBeCloseTo(-PROJECTILE_CFG.HARDPOINT_OFFSET, 6);
    expect(offsets[1]).toBeCloseTo(PROJECTILE_CFG.HARDPOINT_OFFSET, 6);
  });

  it('flies the two-bolt salvo on strictly parallel tracks', () => {
    // Not "roughly parallel". Any divergence at all restores the failure mode,
    // because the gap it opens grows without bound with range.
    const salvo = fireSalvo(3);
    const angles = salvo.map((b) => Math.atan2(b.vy, b.vx));
    expect(angles[0]).toBeCloseTo(angles[1], 12);
  });

  it('holds the track separation constant at every range', () => {
    const salvo = fireSalvo(3);
    const gapAt = (t) => {
      const a = { x: salvo[0].x + salvo[0].vx * t, y: salvo[0].y + salvo[0].vy * t };
      const b = { x: salvo[1].x + salvo[1].vx * t, y: salvo[1].y + salvo[1].vy * t };
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const expected = PROJECTILE_CFG.HARDPOINT_OFFSET * 2;
    for (const t of [0, 0.25, 1, 4]) expect(gapAt(t)).toBeCloseTo(expected, 6);
  });

  it('hits a centred target at every range the old fan missed', () => {
    /*
     * THE ACTUAL BUG, as a test. The old geometry straddled the aim line by
     * `range * sin(SPREAD_RAD / 2)`, so a dead-centre target survived past
     * ~155px. These are the ranges the kiting stalemate lived at.
     */
    for (const range of [60, 150, 180, 240, 300, 420, 520]) {
      const salvo = fireSalvo(3, { x: range, y: 0 });
      const envelope = 12 + PROJECTILE_CFG.RADIUS; // Tarling radius + bolt
      const closest = Math.min(...salvo.map((b) => missDistance(b, range, 0)));
      expect(closest, `range ${range}`).toBeLessThan(envelope);
    }
  });

  it('hits the smallest enemy in the roster dead centre', () => {
    const smallest = Math.min(...Object.values(ENEMIES).map((e) => e.radius));
    const salvo = fireSalvo(3, { x: 300, y: 0 });
    const closest = Math.min(...salvo.map((b) => missDistance(b, 300, 0)));
    expect(closest).toBeLessThan(smallest + PROJECTILE_CFG.RADIUS);
  });

  it('puts a bolt on the centreline once the salvo reaches three', () => {
    const salvo = fireSalvo(5);
    expect(salvo).toHaveLength(3);

    const onAxis = salvo.filter((b) => Math.abs(b.y) < 1e-9);
    expect(onAxis).toHaveLength(1);
    // The centre bolt is the one that may not be splayed.
    expect(Math.atan2(onAxis[0].vy, onAxis[0].vx)).toBeCloseTo(0, 12);
  });

  it('splays the three-bolt salvo only outward, and only slightly', () => {
    const salvo = fireSalvo(5);
    for (const bolt of salvo) {
      const angle = Math.atan2(bolt.vy, bolt.vx);
      expect(Math.abs(angle)).toBeLessThanOrEqual(PROJECTILE_CFG.SALVO_SPLAY_RAD + 1e-9);
      // Splay sign must follow the hardpoint: a bolt from the left wing that
      // turns right crosses its neighbour's track.
      if (Math.abs(bolt.y) > 1e-9) expect(Math.sign(angle)).toBe(Math.sign(bolt.y));
    }
  });

  it('keeps the whole geometry correct on an off-axis bearing', () => {
    // Everything above fires along +X, where a bug in the perpendicular vector
    // is invisible because n = (0, 1) either way. This is the case that catches
    // a swapped or unnormalised normal.
    const range = 300;
    const theta = Math.PI / 3;
    const target = { x: Math.cos(theta) * range, y: Math.sin(theta) * range };
    const salvo = fireSalvo(3, target);

    for (const bolt of salvo) {
      // Spawned exactly on the wing line: perpendicular to aim, at the offset.
      const lateral = -bolt.x * Math.sin(theta) + bolt.y * Math.cos(theta);
      expect(Math.abs(lateral)).toBeCloseTo(PROJECTILE_CFG.HARDPOINT_OFFSET, 6);
      // ...and with no forward/backward displacement along the aim vector.
      expect(bolt.x * Math.cos(theta) + bolt.y * Math.sin(theta)).toBeCloseTo(0, 6);
      // ...travelling on the aim bearing.
      expect(Math.atan2(bolt.vy, bolt.vx)).toBeCloseTo(theta, 12);
    }

    const closest = Math.min(...salvo.map((b) => missDistance(b, target.x, target.y)));
    expect(closest).toBeLessThan(12 + PROJECTILE_CFG.RADIUS);
  });

  it('leaves total bolt count and speed untouched, so the balance model still holds', () => {
    // tests/balance-sim.js scores this card as `damage * count * hits`, i.e. it
    // always assumed every bolt connects. The rework makes the implementation
    // match that assumption; it must not change the inputs to it.
    const levels = CARDS.find((c) => c.id === 'dewdrop_barrage').levels;
    for (const lv of levels) {
      const salvo = fireSalvo(lv.level);
      expect(salvo).toHaveLength(lv.count);
      for (const bolt of salvo) {
        expect(Math.hypot(bolt.vx, bolt.vy)).toBeCloseTo(
          lv.speed * PROJECTILE_CFG.SPEED_SCALE,
          6
        );
        expect(bolt.pierce).toBe(lv.pierce);
      }
    }
  });
});
