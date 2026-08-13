import { describe, it, expect, vi } from 'vitest';
import { Simulation } from '../src/core/simulation.js';
import { GameState } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import { CARD_MODEL, WORLD, PHASE1 } from '../src/core/constants.js';
import { getCardById } from '../src/data/cards.js';

const STEP = 1 / 60;

/**
 * Simulation carrying exactly one card, so an effect can be observed without
 * the starter weapon interfering.
 * @param {string} cardId
 * @param {number} [level]
 */
function makeCardSim(cardId, level = 1) {
  const bus = new EventBus();
  const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
  const sim = new Simulation({ bus, state, seed: 7 });
  sim.startRun();

  state.activeCards.clear();
  sim.cards.runtime.clear();
  for (let i = 0; i < level; i++) state.selectCard(cardId);
  sim.cards.onCardChanged(cardId);

  // Spawning would add uncontrolled enemies mid-test.
  sim.updateSpawning = () => {};
  return sim;
}

/**
 * Park a tanky enemy at an offset from the Dewling so it survives long enough
 * to be measured.
 */
function placeEnemy(sim, offsetX, offsetY, hp = 100000) {
  const enemy = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
  enemy.x = sim.state.player.x + offsetX;
  enemy.y = sim.state.player.y + offsetY;
  enemy.hp = hp;
  enemy.maxHp = hp;
  enemy.speed = 0;
  return enemy;
}

function advance(sim, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) sim.update(STEP, { x: 0, y: 0 });
}

describe('Card effects', () => {
  describe('Dewdrop Barrage — homing volley', () => {
    it('fires the level count of projectiles at the nearest enemy', () => {
      const sim = makeCardSim('dewdrop_barrage', 3); // count 2
      placeEnemy(sim, 200, 0);

      sim.update(STEP);

      expect(sim.projectiles).toHaveLength(2);
      // Aimed right: both projectiles travel toward the enemy.
      for (const p of sim.projectiles) expect(p.vx).toBeGreaterThan(0);
    });

    it('holds fire with no target in range', () => {
      const sim = makeCardSim('dewdrop_barrage');
      advance(sim, 2);
      expect(sim.projectiles).toHaveLength(0);
    });
  });

  describe('Sunbeam Lance — beam', () => {
    it('damages enemies inside the strip and spares those outside', () => {
      const sim = makeCardSim('sunbeam_lance');
      const inBeam = placeEnemy(sim, 300, 0);
      const outside = placeEnemy(sim, 300, 400);

      advance(sim, CARD_MODEL.BEAM_TICK_SEC * 1.5);

      expect(inBeam.hp).toBeLessThan(inBeam.maxHp);
      expect(outside.hp).toBe(outside.maxHp);
    });

    it('ticks at the rate the balance model assumes', () => {
      const sim = makeCardSim('sunbeam_lance');
      const stats = getCardById('sunbeam_lance').levels[0];
      const enemy = placeEnemy(sim, 300, 0);

      // Run exactly one activation.
      advance(sim, stats.duration);

      const expectedTicks = Math.floor(stats.duration / CARD_MODEL.BEAM_TICK_SEC);
      const dealt = enemy.maxHp - enemy.hp;
      expect(dealt).toBeCloseTo(expectedTicks * stats.damage, 5);
    });

    it('respects its cooldown between activations', () => {
      const sim = makeCardSim('sunbeam_lance');
      const stats = getCardById('sunbeam_lance').levels[0];
      placeEnemy(sim, 300, 0);

      const rt = () => sim.cards.runtime.get('sunbeam_lance');

      advance(sim, stats.duration + STEP);
      expect(rt().active).toBe(false);

      advance(sim, stats.cooldown * 0.5);
      expect(rt().active).toBe(false);

      // Step to the re-fire rather than jumping a fixed span: overshooting a
      // full cooldown lands in the NEXT idle window, not the active one.
      let reactivated = false;
      for (let i = 0; i < Math.ceil(stats.cooldown / STEP) + 2; i++) {
        sim.update(STEP, { x: 0, y: 0 });
        if (rt().active) {
          reactivated = true;
          break;
        }
      }
      expect(reactivated).toBe(true);
    });
  });

  describe('Glasswing — orbit', () => {
    it('spawns one blade per level count', () => {
      const sim = makeCardSim('glasswing', 3); // count 4
      sim.update(STEP);
      expect(sim.cards.blades).toHaveLength(4);
    });

    it('damages an enemy caught in the blade ring', () => {
      const sim = makeCardSim('glasswing');
      const stats = getCardById('glasswing').levels[0];
      const enemy = placeEnemy(sim, stats.radius, 0);

      sim.update(STEP);

      expect(enemy.hp).toBeLessThan(enemy.maxHp);
    });

    it('leaves enemies outside the ring alone', () => {
      const sim = makeCardSim('glasswing');
      const enemy = placeEnemy(sim, 400, 0);

      advance(sim, 1);

      expect(enemy.hp).toBe(enemy.maxHp);
    });

    it('gates re-hits on the same enemy by ORBIT_HIT_COOLDOWN', () => {
      const sim = makeCardSim('glasswing');
      const stats = getCardById('glasswing').levels[0];
      const enemy = placeEnemy(sim, stats.radius, 0);

      sim.update(STEP);
      const afterFirst = enemy.hp;
      expect(enemy.orbitCooldown).toBeCloseTo(CARD_MODEL.ORBIT_HIT_COOLDOWN, 5);

      // Still inside the ring, but locked out until the cooldown lapses.
      advance(sim, CARD_MODEL.ORBIT_HIT_COOLDOWN * 0.5);
      expect(enemy.hp).toBe(afterFirst);
    });
  });

  describe('Petal Storm — radial burst', () => {
    it('throws the level count of petals in a single salvo', () => {
      const sim = makeCardSim('petal_storm', 5); // count 16

      sim.update(STEP);

      expect(sim.projectiles).toHaveLength(16);
    });

    it('scatters petals rather than firing them as one stream', () => {
      const sim = makeCardSim('petal_storm', 5);
      sim.update(STEP);

      const angles = sim.projectiles.map((p) => Math.atan2(p.vy, p.vx));
      expect(new Set(angles.map((a) => a.toFixed(3))).size).toBeGreaterThan(8);
    });
  });

  describe('Aurora Pulse — AoE', () => {
    it('damages every enemy inside the radius and none outside', () => {
      const sim = makeCardSim('aurora_pulse');
      const stats = getCardById('aurora_pulse').levels[0];
      const near = placeEnemy(sim, stats.radius * 0.5, 0);
      const far = placeEnemy(sim, stats.radius + 200, 0);

      sim.update(STEP);

      expect(near.maxHp - near.hp).toBeCloseTo(stats.damage, 5);
      expect(far.hp).toBe(far.maxHp);
    });

    it('leaves a ring effect for the renderer', () => {
      const sim = makeCardSim('aurora_pulse');
      sim.update(STEP);
      expect(sim.effects.some((fx) => fx.kind === 'pulse')).toBe(true);
    });
  });

  describe('Tidewave — AoE knockback', () => {
    it('damages and pushes enemies outward', () => {
      const sim = makeCardSim('tidewave');
      const stats = getCardById('tidewave').levels[0];
      const enemy = placeEnemy(sim, 50, 0);

      sim.update(STEP);

      expect(enemy.maxHp - enemy.hp).toBeCloseTo(stats.damage, 5);
      expect(enemy.x - sim.state.player.x).toBeCloseTo(50 + stats.knockback, 5);
    });

    it('keeps pushed enemies inside the arena', () => {
      const sim = makeCardSim('tidewave', 5);
      const enemy = placeEnemy(sim, 50, 0);
      enemy.x = WORLD.WIDTH - 5;
      sim.state.player.x = WORLD.WIDTH - 60;

      sim.update(STEP);

      expect(enemy.x).toBeLessThanOrEqual(WORLD.WIDTH);
    });
  });

  describe('Bloomshield — mitigation', () => {
    it('absorbs damage before the Dewling loses HP', () => {
      const sim = makeCardSim('bloomshield');
      const stats = getCardById('bloomshield').levels[0]; // 20 HP

      const remaining = sim.cards.absorb(8);

      expect(remaining).toBe(0);
      expect(sim.cards.shieldCharge).toBe(stats.shieldHp - 8);
    });

    it('passes through the overflow once the shield breaks', () => {
      const sim = makeCardSim('bloomshield');
      const broken = vi.fn();
      sim.bus.on('card:shield_broken', broken);

      const remaining = sim.cards.absorb(30); // shield is 20

      expect(remaining).toBe(10);
      expect(sim.cards.shieldCharge).toBe(0);
      expect(broken).toHaveBeenCalledTimes(1);
    });

    it('recharges to full after rechargeTime', () => {
      const sim = makeCardSim('bloomshield');
      const stats = getCardById('bloomshield').levels[0];
      sim.cards.absorb(stats.shieldHp);
      expect(sim.cards.shieldCharge).toBe(0);

      advance(sim, stats.rechargeTime * 0.5);
      expect(sim.cards.shieldCharge).toBe(0);

      advance(sim, stats.rechargeTime);
      expect(sim.cards.shieldCharge).toBe(stats.shieldHp);
    });

    it('sustains the HP/sec rate the balance model credits it with', () => {
      const stats = getCardById('bloomshield').levels[4];
      // Balance model scores mitigation as shieldHp / rechargeTime.
      expect(stats.shieldHp / stats.rechargeTime).toBeCloseTo(9.0, 5);
    });

    it('shields the player through the simulation damage path', () => {
      const sim = makeCardSim('bloomshield');
      const enemy = placeEnemy(sim, 0, 0);

      sim.update(STEP);

      expect(sim.state.player.hp).toBe(100);
      expect(sim.cards.shieldCharge).toBe(20 - enemy.contactDamage);
    });
  });

  describe('Buddy Boost — passive', () => {
    it('is a no-op when unowned', () => {
      const sim = makeCardSim('dewdrop_barrage');
      expect(sim.cards.damageMultiplier).toBe(1);
      expect(sim.cards.moveSpeedMultiplier).toBe(1);
    });

    it('multiplies damage and movement at its level values', () => {
      const sim = makeCardSim('buddy_boost', 5);
      const stats = getCardById('buddy_boost').levels[4];

      expect(sim.cards.damageMultiplier).toBeCloseTo(1 + stats.damageBonus, 5);
      expect(sim.cards.moveSpeedMultiplier).toBeCloseTo(1 + stats.moveSpeedBonus, 5);
    });

    it('boosts damage dealt by other cards', () => {
      const plain = makeCardSim('aurora_pulse');
      const boosted = makeCardSim('aurora_pulse');
      boosted.state.selectCard('buddy_boost');
      boosted.state.selectCard('buddy_boost');
      boosted.cards.onCardChanged('buddy_boost');

      const a = placeEnemy(plain, 40, 0);
      const b = placeEnemy(boosted, 40, 0);
      plain.update(STEP);
      boosted.update(STEP);

      expect(b.maxHp - b.hp).toBeGreaterThan(a.maxHp - a.hp);
    });

    it('makes the Dewling move faster', () => {
      const sim = makeCardSim('buddy_boost', 5);
      const stats = getCardById('buddy_boost').levels[4];
      const startX = sim.state.player.x;

      for (let i = 0; i < 60; i++) sim.update(STEP, { x: 1, y: 0 });

      const moved = sim.state.player.x - startX;
      const base = sim.state.player.moveSpeed * 32;
      expect(moved).toBeCloseTo(base * (1 + stats.moveSpeedBonus), 0);
    });
  });
});

describe('Card stacking and levelling', () => {
  it('upgrades an owned card instead of wasting the pick', () => {
    const sim = makeCardSim('glasswing');
    expect(sim.state.activeCards.get('glasswing')).toBe(1);

    sim.state.selectCard('glasswing');

    expect(sim.state.activeCards.get('glasswing')).toBe(2);
    expect(sim.state.activeCards.size).toBe(1);
  });

  it('applies the new level stats immediately', () => {
    const sim = makeCardSim('glasswing');
    const l1 = getCardById('glasswing').levels[0];
    const l2 = getCardById('glasswing').levels[1];

    sim.update(STEP);
    expect(sim.cards.blades).toHaveLength(l1.count);

    sim.state.selectCard('glasswing');
    sim.update(STEP);
    expect(sim.cards.blades).toHaveLength(l2.count);
  });

  it('refuses to level past maxLevel', () => {
    const sim = makeCardSim('petal_storm', 5);
    expect(sim.state.activeCards.get('petal_storm')).toBe(5);

    expect(sim.state.selectCard('petal_storm')).toBe(false);
    expect(sim.state.activeCards.get('petal_storm')).toBe(5);
  });

  it('tops the shield up to the new capacity on level up', () => {
    const sim = makeCardSim('bloomshield');
    const l2 = getCardById('bloomshield').levels[1];

    sim.state.selectCard('bloomshield');
    sim.cards.onCardChanged('bloomshield');

    expect(sim.cards.shieldCharge).toBe(l2.shieldHp);
  });

  it('does not refill a shield that is mid-recharge', () => {
    const sim = makeCardSim('bloomshield');
    sim.cards.absorb(999); // break it
    expect(sim.cards.shieldCharge).toBe(0);

    sim.state.selectCard('bloomshield');
    sim.cards.onCardChanged('bloomshield');

    expect(sim.cards.shieldCharge).toBe(0);
  });

  it('starts a run with only the starter card at level 1', () => {
    const bus = new EventBus();
    const state = new GameState(bus, { maxWaves: 5 });
    const sim = new Simulation({ bus, state, seed: 1 });
    sim.startRun();

    expect([...state.activeCards.entries()]).toEqual([['dewdrop_barrage', 1]]);
    expect(sim.cards.runtime.has('dewdrop_barrage')).toBe(true);
  });
});
