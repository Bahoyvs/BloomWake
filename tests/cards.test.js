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
  // baseSpeed, not speed: `speed` is derived every frame in updateEnemies now
  // (a stun or a charge multiplier scales it), so pinning it would last one
  // tick. baseSpeed is the authored figure the derivation starts from.
  enemy.baseSpeed = 0;
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

  describe('Tesla Arc — chain lightning', () => {
    it('damages nearest enemy in range and chains to nearby targets', () => {
      const sim = makeCardSim('sunbeam_lance');
      const target1 = placeEnemy(sim, 200, 0);
      const target2 = placeEnemy(sim, 280, 0);
      const outside = placeEnemy(sim, 800, 800);

      advance(sim, STEP * 2);

      expect(target1.hp).toBeLessThan(target1.maxHp);
      expect(target2.hp).toBeLessThan(target2.maxHp);
      expect(outside.hp).toBe(outside.maxHp);
    });

    it('deals damage according to level stats', () => {
      const sim = makeCardSim('sunbeam_lance');
      const stats = getCardById('sunbeam_lance').levels[0];
      const enemy = placeEnemy(sim, 200, 0);

      advance(sim, STEP * 2);

      const dealt = enemy.maxHp - enemy.hp;
      expect(dealt).toBeCloseTo(stats.damage, 5);
    });

    it('applies shock slow at level 3+', () => {
      const sim = makeCardSim('sunbeam_lance', 3);
      const stats = getCardById('sunbeam_lance').levels[2];
      const enemy = placeEnemy(sim, 200, 0);

      advance(sim, STEP * 2);

      expect(enemy.stunTimer).toBeGreaterThan(0);
      expect(enemy.stunTimer).toBeCloseTo(stats.shockDuration, 1);
    });

    it('respects its cooldown between activations', () => {
      const sim = makeCardSim('sunbeam_lance');
      const stats = getCardById('sunbeam_lance').levels[0];
      placeEnemy(sim, 200, 0);

      const rt = () => sim.cards.runtime.get('sunbeam_lance');

      advance(sim, STEP * 2);
      expect(rt().cooldown).toBeGreaterThan(0);

      advance(sim, stats.cooldown * 0.5);
      expect(rt().cooldown).toBeGreaterThan(0);

      advance(sim, stats.cooldown * 0.6);
      expect(rt().cooldown).toBeLessThanOrEqual(stats.cooldown);
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

  describe('Nanite Swarm — guided micro-missiles', () => {
    it('launches the level count of missiles', () => {
      const sim = makeCardSim('aurora_pulse');
      const stats = getCardById('aurora_pulse').levels[0];
      placeEnemy(sim, 300, 0);

      sim.update(STEP);

      const missiles = sim.projectiles.filter((p) => p.turnRate > 0);
      expect(missiles).toHaveLength(stats.count);
    });

    it('picks the highest-HP target, not the nearest', () => {
      /*
       * The card's whole identity, and the reason it is the answer to a
       * Bio-Goliath escort wall: every other weapon in the kit hits whatever
       * happens to be closest, which in that fight is deliberately the chaff.
       */
      const sim = makeCardSim('aurora_pulse');
      placeEnemy(sim, 80, 0, 50); // near and frail
      const fat = placeEnemy(sim, 320, 0, 9000); // far and tanky

      sim.update(STEP);

      const missiles = sim.projectiles.filter((p) => p.turnRate > 0);
      expect(missiles.length).toBeGreaterThan(0);
      for (const missile of missiles) expect(missile.targetId).toBe(fat.id);
    });

    it('fans the salvo out rather than firing it down one line', () => {
      // A missile launched straight at its target is a slow bolt wearing a
      // missile sprite; the arc back in is the effect.
      const sim = makeCardSim('aurora_pulse', 5);
      placeEnemy(sim, 300, 0);

      sim.update(STEP);

      const angles = sim.projectiles
        .filter((p) => p.turnRate > 0)
        .map((p) => Math.atan2(p.vy, p.vx));
      expect(new Set(angles.map((a) => a.toFixed(3))).size).toBe(angles.length);
    });

    it('steers a missile onto its target over time', () => {
      const sim = makeCardSim('aurora_pulse');
      const target = placeEnemy(sim, 400, 0);

      sim.update(STEP);
      const missile = sim.projectiles.find((p) => p.turnRate > 0);
      const before = Math.hypot(target.x - missile.x, target.y - missile.y);

      advance(sim, 0.6);
      const after = Math.hypot(target.x - missile.x, target.y - missile.y);
      expect(after).toBeLessThan(before);
    });

    it('re-acquires when its target dies mid-flight', () => {
      const sim = makeCardSim('aurora_pulse');
      const first = placeEnemy(sim, 300, 0, 9000);
      const second = placeEnemy(sim, 340, 40, 8000);

      sim.update(STEP);
      const missile = sim.projectiles.find((p) => p.turnRate > 0);
      expect(missile.targetId).toBe(first.id);

      sim.killEnemy(first);
      advance(sim, 0.2);

      // Flies on and finds the next-biggest thing, rather than stopping dead.
      expect(missile.targetId).toBe(second.id);
    });
  });

  describe('Graviton EMP — knockback and stun', () => {
    it('damages and pushes enemies outward', () => {
      const sim = makeCardSim('tidewave');
      const stats = getCardById('tidewave').levels[0];
      const enemy = placeEnemy(sim, 50, 0);

      sim.update(STEP);

      expect(enemy.maxHp - enemy.hp).toBeCloseTo(stats.damage, 5);
      // The push, plus the fraction of a frame of drift the enemy has already
      // taken from the ring's own knock impulse.
      expect(enemy.x - sim.state.player.x).toBeGreaterThanOrEqual(50 + stats.knockback - 2);
    });

    it('freezes what it catches for the flat stun duration', () => {
      const sim = makeCardSim('tidewave');
      const enemy = placeEnemy(sim, 50, 0);
      enemy.speed = 999;

      sim.update(STEP);
      expect(enemy.stunTimer).toBeGreaterThan(0);
      expect(enemy.stunTimer).toBeLessThanOrEqual(CARD_MODEL.EMP_STUN_SEC);

      // Checked on the NEXT frame: cards tick after the enemy pass, so the
      // stun applied this frame is honoured from the following one.
      sim.update(STEP);
      expect(enemy.speed).toBe(0);

      advance(sim, CARD_MODEL.EMP_STUN_SEC + 0.2);
      expect(enemy.stunTimer).toBeLessThanOrEqual(0);
    });

    it('refreshes a stun rather than stacking it', () => {
      // Overlapping EMPs must not compound into a permanent lock.
      const sim = makeCardSim('tidewave');
      const enemy = placeEnemy(sim, 50, 0);

      sim.cards.blast(200, 0, 0, CARD_MODEL.EMP_STUN_SEC);
      sim.cards.blast(200, 0, 0, CARD_MODEL.EMP_STUN_SEC);

      expect(enemy.stunTimer).toBeCloseTo(CARD_MODEL.EMP_STUN_SEC, 5);
    });

    it('never stuns the boss', () => {
      // A station that can be frozen out of its own attack patterns is not a
      // boss fight, it is a damage check.
      const sim = makeCardSim('tidewave');
      const boss = sim.spawnBoss();
      boss.x = sim.state.player.x + 40;
      boss.y = sim.state.player.y;

      sim.cards.blast(300, 0, 0, CARD_MODEL.EMP_STUN_SEC);

      expect(boss.stunTimer).toBe(0);
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

  describe('Hyperion Shield — hit negation', () => {
    it('negates an incoming hit outright, whatever its size', () => {
      // All or nothing: the barrier is a charge, not a pool, so there is no
      // overflow to compute and the player either got the save or did not.
      const sim = makeCardSim('bloomshield');

      expect(sim.cards.absorb(8)).toBe(0);
      expect(sim.cards.getShieldState().ready).toBe(false);
    });

    it('eats a hit far larger than the old shield pool could have', () => {
      const sim = makeCardSim('bloomshield');
      expect(sim.cards.absorb(9999)).toBe(0);
    });

    it('lets the next hit through while it is spent', () => {
      const sim = makeCardSim('bloomshield');
      const negated = vi.fn();
      sim.bus.on('card:shield_negate', negated);

      sim.cards.absorb(8);
      expect(sim.cards.absorb(30)).toBe(30);
      expect(negated).toHaveBeenCalledTimes(1);
    });

    it('re-arms after rechargeTime', () => {
      const sim = makeCardSim('bloomshield');
      const stats = getCardById('bloomshield').levels[0];
      sim.cards.absorb(10);
      expect(sim.cards.getShieldState().ready).toBe(false);

      advance(sim, stats.rechargeTime * 0.5);
      expect(sim.cards.getShieldState().ready).toBe(false);

      advance(sim, stats.rechargeTime);
      expect(sim.cards.getShieldState().ready).toBe(true);
      expect(sim.cards.shieldCharge).toBe(1);
    });

    it('buys frequency with levels, never size', () => {
      // A hit is a hit — the only thing a level can improve is how often the
      // barrier is there for one.
      const card = getCardById('bloomshield');
      let previous = Infinity;
      for (const level of card.levels) {
        expect(level.negates).toBe(1);
        expect(level.rechargeTime).toBeLessThan(previous);
        previous = level.rechargeTime;
      }
    });

    it('shields the player through the simulation damage path', () => {
      const sim = makeCardSim('bloomshield');
      placeEnemy(sim, 0, 0);

      sim.update(STEP);

      expect(sim.state.player.hp).toBe(100);
      expect(sim.cards.getShieldState().ready).toBe(false);
    });
  });

  describe('Tactical Wingman — escort drones', () => {
    it('flies the level count of drones', () => {
      const sim = makeCardSim('buddy_boost', 3);
      sim.update(STEP);
      expect(sim.cards.drones).toHaveLength(3 >= 3 ? 2 : 1);
    });

    it('reports no drones when the card is unowned', () => {
      const sim = makeCardSim('dewdrop_barrage');
      expect(sim.cards.drones).toHaveLength(0);
    });

    it('trails the Drifter rather than sitting on top of it', () => {
      const sim = makeCardSim('buddy_boost', 5);
      advance(sim, 1.0);

      const player = sim.state.player;
      for (const drone of sim.cards.drones) {
        const gap = Math.hypot(drone.x - player.x, drone.y - player.y);
        expect(gap).toBeGreaterThan(CARD_MODEL.WINGMAN_FOLLOW_DIST * 0.5);
      }
    });

    it('fires its own bolts at a target the Drifter is not aimed at', () => {
      const sim = makeCardSim('buddy_boost', 5);
      advance(sim, 0.5);
      placeEnemy(sim, 120, 0);
      advance(sim, 1.5);

      expect(sim.projectiles.length).toBeGreaterThan(0);
    });
  });

  describe('Tactical Wingman — stat half', () => {
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
      const plain = makeCardSim('tidewave');
      const boosted = makeCardSim('tidewave');
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

      // Spend the acceleration ramp first: the ship has mass, so the bonus is
      // a change to terminal speed rather than to the first frame's step.
      for (let i = 0; i < 60; i++) sim.update(STEP, { x: 1, y: 0 });
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

  it('does not refund a spent charge on level up', () => {
    /*
     * Levelling the barrier shortens its recharge; it does not hand back a
     * charge. Otherwise a player could bank a free hit by sitting on an XP orb
     * until they needed one.
     */
    const sim = makeCardSim('bloomshield');
    sim.cards.absorb(10);
    expect(sim.cards.getShieldState().ready).toBe(false);

    sim.state.selectCard('bloomshield');
    sim.cards.onCardChanged('bloomshield');

    expect(sim.cards.getShieldState().ready).toBe(false);
    // The shorter recharge does apply to the cycle already in flight.
    const l2 = getCardById('bloomshield').levels[1];
    expect(sim.cards.getShieldState().timer).toBeLessThanOrEqual(l2.rechargeTime);
  });

  it('does not re-arm a barrier that is mid-recharge', () => {
    const sim = makeCardSim('bloomshield');
    sim.cards.absorb(999); // spend it
    expect(sim.cards.getShieldState().ready).toBe(false);

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
