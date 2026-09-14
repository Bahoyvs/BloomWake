/**
 * Active-skill tests.
 *
 * Runs in plain Node: the whole system is a state machine over a Simulation,
 * and neither knows the DOM or PixiJS exists. Everything here drives a real
 * Simulation rather than a mock, because the interesting failures are all in
 * the seams — a skill that pulls enemies the frame after updateEnemies has
 * already moved them, a cooldown that starts on expiry instead of on cast.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Simulation } from '../src/core/simulation.js';
import { GameState, GAME_STATES } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import {
  ActiveSkillSystem,
  PRE_CAST_FLASH_SEC,
  CAST_REJECTED,
  equipActiveSkill,
  describeActiveSkills,
} from '../src/core/active-skills.js';
import {
  ACTIVE_SKILLS,
  ACTIVE_SKILL_IDS,
  ACTIVE_SKILL_ORDER,
  DEFAULT_ACTIVE_SKILL_ID,
  getActiveSkillById,
} from '../src/data/active-skills.js';
import { createDefaultState, sanitizeState, loadState } from '../src/core/state.js';
import { WORLD, PLAYER_CFG } from '../src/core/constants.js';
import { ENEMY_TYPES } from '../src/data/enemies.js';

const DT = 1 / 60;

/** A running simulation with a live wave, ready to be cast into. */
function makeSim(skillId = DEFAULT_ACTIVE_SKILL_ID) {
  const bus = new EventBus();
  const state = new GameState(bus);
  const sim = new Simulation({ bus, state, seed: 4242 });
  sim.startRun();
  sim.activeSkills.equip(skillId);
  return sim;
}

/** Advance the skill system (and only it) by `seconds`. */
function tickSkills(sim, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) sim.activeSkills.update(DT);
}

/**
 * Drop an enemy at an exact spot, bypassing the spawn ring.
 *
 * Asserts the species actually exists: spawnEnemy falls back to a Xeno Larva
 * for an unknown id, which silently turns a "heavy enemy" test into a light
 * one that passes for the wrong reason.
 */
function placeEnemy(sim, typeId, x, y) {
  expect(Object.values(ENEMY_TYPES), `unknown species ${typeId}`).toContain(typeId);
  return sim.spawnEnemy(typeId, { x, y });
}

describe('Active skill data table', () => {
  it('defines all seven skills the brief specifies', () => {
    expect(ACTIVE_SKILL_ORDER).toHaveLength(7);
    for (const id of ACTIVE_SKILL_ORDER) {
      expect(ACTIVE_SKILLS[id], id).toBeDefined();
    }
  });

  it('gives every skill the cooldown and duration from the brief', () => {
    const expected = {
      afterburner: { cooldown: 8, duration: 2.2 },
      emp_shockwave: { cooldown: 12, duration: 0 },
      missile_salvo: { cooldown: 10, duration: 0 },
      phase_shift: { cooldown: 9, duration: 0.75 },
      singularity_anchor: { cooldown: 14, duration: 3.5 },
      overcharge_core: { cooldown: 15, duration: 4.0 },
      point_defense: { cooldown: 11, duration: 3.5 },
    };

    for (const [id, want] of Object.entries(expected)) {
      expect(ACTIVE_SKILLS[id].cooldown, `${id} cooldown`).toBe(want.cooldown);
      expect(ACTIVE_SKILLS[id].duration, `${id} duration`).toBe(want.duration);
    }
  });

  it('keeps every row self-describing for the UI', () => {
    for (const id of ACTIVE_SKILL_ORDER) {
      const def = ACTIVE_SKILLS[id];
      expect(def.id, id).toBe(id);
      expect(def.name, id).toBeTruthy();
      expect(def.description, id).toBeTruthy();
      expect(def.mark, id).toBeTruthy();
      expect(def.params, id).toBeTypeOf('object');
    }
  });

  it('resolves unknown ids to null rather than throwing', () => {
    expect(getActiveSkillById('not_a_skill')).toBeNull();
    expect(getActiveSkillById(ACTIVE_SKILL_IDS.AFTERBURNER)).toBe(
      ACTIVE_SKILLS.afterburner
    );
  });
});

describe('Cast lifecycle', () => {
  let sim;
  beforeEach(() => {
    sim = makeSim(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);
  });

  it('starts ready, with a full charge and no active window', () => {
    const skills = sim.activeSkills;
    expect(skills.isReady).toBe(true);
    expect(skills.isActive).toBe(false);
    expect(skills.charges).toBe(1);
    expect(skills.charge).toBe(1);
  });

  it('opens the active window and starts the cooldown on cast', () => {
    const skills = sim.activeSkills;
    const def = getActiveSkillById(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);

    expect(skills.trigger().ok).toBe(true);
    expect(skills.activeTimer).toBeCloseTo(def.duration, 5);
    expect(skills.cooldownTimer).toBeCloseTo(def.cooldown, 5);
    expect(skills.isActive).toBe(true);
    expect(skills.isReady).toBe(false);
  });

  it('runs the cooldown from the CAST, not from the end of the active window', () => {
    const skills = sim.activeSkills;
    const def = getActiveSkillById(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);

    skills.trigger();
    // One frame short of the cooldown, measured from the press.
    tickSkills(sim, def.cooldown - DT);
    expect(skills.isReady).toBe(false);
    tickSkills(sim, DT * 2);
    expect(skills.isReady).toBe(true);
    // A cooldown that ran from expiry would need duration seconds more.
    expect(skills.cooldownTimer).toBe(0);
  });

  it('closes the active window after exactly `duration`', () => {
    const skills = sim.activeSkills;
    skills.trigger();

    tickSkills(sim, 4.0 - DT * 2);
    expect(skills.isActive).toBe(true);
    tickSkills(sim, DT * 3);
    expect(skills.isActive).toBe(false);
    expect(skills.activeTimer).toBe(0);
  });

  it('declines a second cast while cooling, and says why', () => {
    const skills = sim.activeSkills;
    skills.trigger();
    const second = skills.trigger();

    expect(second.ok).toBe(false);
    expect(second.reason).toBe(CAST_REJECTED.COOLING);
  });

  it('raises the pre-cast flash for its window and drops it after', () => {
    const skills = sim.activeSkills;
    skills.trigger();
    expect(skills.preCastFlash).toBe(true);

    tickSkills(sim, PRE_CAST_FLASH_SEC + DT);
    expect(skills.preCastFlash).toBe(false);
  });

  it('reports cooldown progress as 0..1 for the HUD radial', () => {
    const skills = sim.activeSkills;
    skills.trigger();
    expect(skills.charge).toBeCloseTo(0, 2);

    tickSkills(sim, 7.5);
    expect(skills.charge).toBeCloseTo(0.5, 1);

    tickSkills(sim, 7.5);
    expect(skills.charge).toBe(1);
  });

  it('emits cast and ready on the bus', () => {
    const seen = [];
    sim.bus.on('skill:cast', (d) => seen.push(['cast', d.skillId]));
    sim.bus.on('skill:ready', (d) => seen.push(['ready', d.skillId]));

    sim.activeSkills.trigger();
    tickSkills(sim, 15.1);

    expect(seen).toEqual([
      ['cast', ACTIVE_SKILL_IDS.OVERCHARGE_CORE],
      ['ready', ACTIVE_SKILL_IDS.OVERCHARGE_CORE],
    ]);
  });

  it('spends and refunds charges one at a time on a 2-charge loadout', () => {
    const skills = sim.activeSkills;
    skills.equip(ACTIVE_SKILL_IDS.OVERCHARGE_CORE, { maxCharges: 2 });
    expect(skills.charges).toBe(2);

    skills.trigger();
    expect(skills.charges).toBe(1);
    // The banked charge is spendable even though the refill clock is running.
    expect(skills.isReady).toBe(true);
    expect(skills.cooldownTimer).toBeGreaterThan(0);

    // Spending it must not restart the refill already in progress.
    const refillLeft = skills.cooldownTimer;
    expect(skills.trigger().ok).toBe(true);
    expect(skills.charges).toBe(0);
    expect(skills.cooldownTimer).toBeCloseTo(refillLeft, 5);
    expect(skills.isReady).toBe(false);

    // One charge back per full cooldown, not both at once.
    tickSkills(sim, 15.1);
    expect(skills.charges).toBe(1);
    tickSkills(sim, 15.1);
    expect(skills.charges).toBe(2);
    expect(skills.cooldownTimer).toBe(0);
  });

  it('rejects a cast with no charges left', () => {
    const skills = sim.activeSkills;
    skills.charges = 0;
    skills.cooldownTimer = 0;
    expect(skills.trigger().reason).toBe(CAST_REJECTED.NO_CHARGES);
  });

  it('blames the clock when the missing charge is still refilling', () => {
    const skills = sim.activeSkills;
    skills.trigger();
    expect(skills.charges).toBe(0);
    expect(skills.trigger().reason).toBe(CAST_REJECTED.COOLING);
  });
});

describe('Simulation entry point', () => {
  it('refuses to cast outside a running state', () => {
    const sim = makeSim();
    sim.state.pause();
    expect(sim.state.currentState).toBe(GAME_STATES.PAUSED);

    const result = sim.triggerActiveSkill();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NOT_RUNNING');
    expect(sim.activeSkills.cooldownTimer).toBe(0);
  });

  it('casts through the simulation while running', () => {
    const sim = makeSim();
    expect(sim.triggerActiveSkill().ok).toBe(true);
    expect(sim.activeSkills.cooldownTimer).toBeGreaterThan(0);
  });

  it('restores a ready, full-charge slate on a new run', () => {
    const sim = makeSim();
    sim.triggerActiveSkill();
    expect(sim.activeSkills.isReady).toBe(false);

    sim.startRun();
    expect(sim.activeSkills.isReady).toBe(true);
    expect(sim.activeSkills.activeTimer).toBe(0);
    expect(sim.activeSkills.charges).toBe(1);
  });

  it('equips the skill named by meta-state at run start', () => {
    const sim = makeSim();
    const meta = createDefaultState();
    meta.activeSkillId = ACTIVE_SKILL_IDS.PHASE_SHIFT;

    sim.startRun(meta);
    expect(sim.activeSkills.skillId).toBe(ACTIVE_SKILL_IDS.PHASE_SHIFT);
  });

  it('falls back to the default when meta-state names a skill that does not exist', () => {
    const sim = makeSim();
    const meta = createDefaultState();
    meta.activeSkillId = 'deleted_in_a_later_patch';

    sim.startRun(meta);
    expect(sim.activeSkills.skillId).toBe(DEFAULT_ACTIVE_SKILL_ID);
  });
});

describe('Afterburner', () => {
  it('multiplies top speed for the duration and releases it after', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.AFTERBURNER);
    const boost = ACTIVE_SKILLS.afterburner.params.speedMultiplier;

    expect(sim.activeSkills.moveSpeedMultiplier).toBe(1);
    sim.triggerActiveSkill();
    expect(sim.activeSkills.moveSpeedMultiplier).toBe(boost);
    expect(sim.activeSkills.accelMultiplier).toBe(boost);

    tickSkills(sim, 2.3);
    expect(sim.activeSkills.moveSpeedMultiplier).toBe(1);
    expect(sim.activeSkills.accelMultiplier).toBe(1);
  });

  it('throws a light enemy clear of the hull and damages it', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.AFTERBURNER);
    const player = sim.state.player;
    const enemy = placeEnemy(sim, 'tarling', player.x + 30, player.y);
    const startHp = enemy.hp;

    sim.triggerActiveSkill();
    sim.activeSkills.update(DT);

    expect(enemy.x - player.x).toBeGreaterThan(150);
    expect(enemy.hp).toBeLessThan(startHp);
  });

  it('does not shove a heavy enemy', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.AFTERBURNER);
    const player = sim.state.player;
    // Bio-Goliath: well over the mass proxy the ram is gated on.
    const enemy = placeEnemy(sim, 'bio_goliath', player.x + 30, player.y);
    const startX = enemy.x;
    const startHp = enemy.hp;

    sim.triggerActiveSkill();
    sim.activeSkills.update(DT);

    expect(enemy.x).toBe(startX);
    expect(enemy.hp).toBe(startHp);
  });

  it('cannot juggle the same enemy every frame', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.AFTERBURNER);
    const player = sim.state.player;
    const enemy = placeEnemy(sim, 'tarling', player.x + 30, player.y);
    enemy.hp = 10000;

    sim.triggerActiveSkill();
    for (let i = 0; i < 10; i++) {
      // Drag it back into contact each frame; only the first should land.
      enemy.x = player.x + 30;
      sim.activeSkills.update(DT);
    }

    const ram = ACTIVE_SKILLS.afterburner.params.ramDamage;
    expect(10000 - enemy.hp).toBeLessThanOrEqual(ram * 2);
  });
});

describe('EMP Shockwave', () => {
  it('wipes every hostile round on the field', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.EMP_SHOCKWAVE);
    for (let i = 0; i < 12; i++) {
      sim.spawnEnemyBullet({
        x: 100 + i * 40,
        y: 100,
        vx: 0,
        vy: 40,
        damage: 5,
        radius: 6,
        life: 5,
      });
    }
    expect(sim.enemyBullets.some((b) => b.alive)).toBe(true);

    sim.triggerActiveSkill();
    expect(sim.enemyBullets.every((b) => !b.alive)).toBe(true);
  });

  it('stuns everything inside its radius and nothing outside it', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.EMP_SHOCKWAVE);
    const player = sim.state.player;
    const { radius, stun } = ACTIVE_SKILLS.emp_shockwave.params;

    const inside = placeEnemy(sim, 'tarling', player.x + radius * 0.5, player.y);
    const outside = placeEnemy(sim, 'tarling', player.x + radius + 200, player.y);
    inside.hp = 9999;
    outside.hp = 9999;

    sim.triggerActiveSkill();

    expect(inside.stunTimer).toBeCloseTo(stun, 5);
    expect(outside.stunTimer).toBe(0);
  });

  it('resolves instantly — no active window is left open', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.EMP_SHOCKWAVE);
    sim.triggerActiveSkill();
    expect(sim.activeSkills.isActive).toBe(false);
    expect(sim.activeSkills.cooldownTimer).toBeCloseTo(12, 5);
  });
});

describe('Micro-Missile Salvo', () => {
  it('launches exactly eight guided missiles', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.MISSILE_SALVO);
    placeEnemy(sim, 'tarling', sim.state.player.x + 200, sim.state.player.y);

    const before = sim.projectiles.length;
    sim.triggerActiveSkill();
    const fired = sim.projectiles.slice(before);

    expect(fired).toHaveLength(8);
    for (const p of fired) {
      expect(p.kind).toBe('missile');
      expect(p.turnRate).toBeGreaterThan(0);
    }
  });

  it('fans the launch headings around the full circle', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.MISSILE_SALVO);
    const before = sim.projectiles.length;
    sim.triggerActiveSkill();

    const angles = sim.projectiles
      .slice(before)
      .map((p) => Math.atan2(p.vy, p.vx))
      .sort((a, b) => a - b);

    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBe(8);
    // Eight evenly spaced headings cover more than three quarters of a turn
    // between the first and the last.
    expect(angles[angles.length - 1] - angles[0]).toBeGreaterThan(Math.PI * 1.5);
  });

  it('splits its seekers between the nearest and the toughest target', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.MISSILE_SALVO);
    const player = sim.state.player;

    const near = placeEnemy(sim, 'tarling', player.x + 60, player.y);
    const tough = placeEnemy(sim, 'bio_goliath', player.x + 400, player.y);
    tough.hp = 50000;

    const before = sim.projectiles.length;
    sim.triggerActiveSkill();
    const ids = new Set(sim.projectiles.slice(before).map((p) => p.targetId));

    expect(ids.has(near.id)).toBe(true);
    expect(ids.has(tough.id)).toBe(true);
  });

  it('still fires with an empty field', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.MISSILE_SALVO);
    const before = sim.projectiles.length;
    expect(() => sim.triggerActiveSkill()).not.toThrow();
    expect(sim.projectiles.length - before).toBe(8);
  });
});

describe('Phase Shift', () => {
  it('blinks 240px along the hull heading', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.PHASE_SHIFT);
    const player = sim.state.player;
    // Steer right for a frame so facing is a known unit vector.
    sim.updatePlayer(DT, { x: 1, y: 0 });

    const startX = player.x;
    sim.triggerActiveSkill();

    expect(player.x - startX).toBeCloseTo(ACTIVE_SKILLS.phase_shift.params.distance, 0);
  });

  it('never blinks outside the arena', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.PHASE_SHIFT);
    const player = sim.state.player;
    player.x = WORLD.WIDTH - 40;
    sim.updatePlayer(DT, { x: 1, y: 0 });

    sim.triggerActiveSkill();
    expect(player.x).toBeLessThanOrEqual(WORLD.WIDTH - PLAYER_CFG.RADIUS);
  });

  it('grants i-frames for the whole window, not just the jump frame', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.PHASE_SHIFT);
    const player = sim.state.player;

    sim.triggerActiveSkill();
    expect(sim.activeSkills.invulnerable).toBe(true);

    const hp = player.hp;
    sim.damagePlayer(40);
    expect(player.hp).toBe(hp);

    // Halfway through the window it is still up.
    tickSkills(sim, 0.4);
    sim.damagePlayer(40);
    expect(player.hp).toBe(hp);

    // And gone once it closes.
    tickSkills(sim, 0.5);
    expect(sim.activeSkills.invulnerable).toBe(false);
    sim.damagePlayer(40);
    expect(player.hp).toBeLessThan(hp);
  });
});

describe('Singularity Anchor', () => {
  it('plants the anomaly ahead of the ship and clears it when the window shuts', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR);
    const player = sim.state.player;
    sim.updatePlayer(DT, { x: 1, y: 0 });

    sim.triggerActiveSkill();
    const anchor = sim.activeSkills.anchor;

    expect(anchor.active).toBe(true);
    expect(anchor.x - player.x).toBeCloseTo(
      ACTIVE_SKILLS.singularity_anchor.params.throwDistance,
      0
    );

    tickSkills(sim, 3.6);
    expect(anchor.active).toBe(false);
  });

  it('hauls enemies toward its centre', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR);
    const player = sim.state.player;
    sim.updatePlayer(DT, { x: 1, y: 0 });
    sim.triggerActiveSkill();

    const anchor = sim.activeSkills.anchor;
    const enemy = placeEnemy(sim, 'tarling', anchor.x + 150, anchor.y);
    enemy.hp = 99999;
    const startDist = Math.hypot(enemy.x - anchor.x, enemy.y - anchor.y);

    tickSkills(sim, 0.5);

    const endDist = Math.hypot(enemy.x - anchor.x, enemy.y - anchor.y);
    expect(endDist).toBeLessThan(startDist);
    void player;
  });

  it('crushes what it holds on a repeating tick', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR);
    sim.updatePlayer(DT, { x: 1, y: 0 });
    sim.triggerActiveSkill();

    const anchor = sim.activeSkills.anchor;
    const enemy = placeEnemy(sim, 'tarling', anchor.x + 40, anchor.y);
    enemy.hp = 99999;
    const startHp = enemy.hp;

    tickSkills(sim, 1.0);
    expect(enemy.hp).toBeLessThan(startHp);
  });

  it('leaves enemies outside its radius alone', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.SINGULARITY_ANCHOR);
    sim.updatePlayer(DT, { x: 1, y: 0 });
    sim.triggerActiveSkill();

    const anchor = sim.activeSkills.anchor;
    const far = placeEnemy(sim, 'tarling', anchor.x + 600, anchor.y);
    far.hp = 99999;
    const startX = far.x;
    const startHp = far.hp;

    tickSkills(sim, 1.0);
    expect(far.x).toBe(startX);
    expect(far.hp).toBe(startHp);
  });
});

describe('Overcharge Core', () => {
  it('trades a quarter of the ship\'s speed for double fire rate', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);
    const skills = sim.activeSkills;

    expect(skills.moveSpeedMultiplier).toBe(1);
    expect(skills.fireRateMultiplier).toBe(1);

    sim.triggerActiveSkill();
    expect(skills.moveSpeedMultiplier).toBe(0.75);
    expect(skills.fireRateMultiplier).toBe(2);

    tickSkills(sim, 4.1);
    expect(skills.moveSpeedMultiplier).toBe(1);
    expect(skills.fireRateMultiplier).toBe(1);
  });

  it('actually doubles how fast the starter weapon recovers', () => {
    const baseline = makeSim(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);
    const charged = makeSim(ACTIVE_SKILL_IDS.OVERCHARGE_CORE);
    charged.triggerActiveSkill();

    for (const sim of [baseline, charged]) {
      placeEnemy(sim, 'tarling', sim.state.player.x + 120, sim.state.player.y);
    }

    // Same wall-clock window for both; the overcharged one should have spent
    // roughly twice as much of its weapon cooldown.
    for (let i = 0; i < 30; i++) {
      baseline.cards.update(DT);
      charged.cards.update(DT);
    }

    const a = baseline.cards.runtime.get('dewdrop_barrage');
    const b = charged.cards.runtime.get('dewdrop_barrage');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b.cooldown).toBeLessThan(a.cooldown);
  });
});

describe('Point-Defense Overdrive', () => {
  it('deploys two blades for the window and stows them after', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.POINT_DEFENSE);
    expect(sim.activeSkills.blades).toHaveLength(0);

    sim.triggerActiveSkill();
    expect(sim.activeSkills.blades).toHaveLength(2);

    tickSkills(sim, 3.6);
    expect(sim.activeSkills.blades).toHaveLength(0);
  });

  it('slices an enemy that comes into the bubble', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.POINT_DEFENSE);
    const player = sim.state.player;
    const { orbitRadius } = ACTIVE_SKILLS.point_defense.params;
    const enemy = placeEnemy(sim, 'tarling', player.x + orbitRadius, player.y);
    enemy.hp = 99999;
    const startHp = enemy.hp;

    sim.triggerActiveSkill();
    tickSkills(sim, 1.0);

    expect(enemy.hp).toBeLessThan(startHp);
  });

  it('eats hostile rounds that reach the bubble, and only those', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.POINT_DEFENSE);
    const player = sim.state.player;

    const close = sim.spawnEnemyBullet({
      x: player.x + 20,
      y: player.y,
      vx: 0,
      vy: 0,
      damage: 5,
      radius: 6,
      life: 9,
    });
    const far = sim.spawnEnemyBullet({
      x: player.x + 600,
      y: player.y,
      vx: 0,
      vy: 0,
      damage: 5,
      radius: 6,
      life: 9,
    });

    sim.triggerActiveSkill();
    sim.activeSkills.update(DT);

    expect(close.alive).toBe(false);
    expect(far.alive).toBe(true);
  });

  it('does not consume the Aegis Satellites\' own re-hit window', () => {
    const sim = makeSim(ACTIVE_SKILL_IDS.POINT_DEFENSE);
    const player = sim.state.player;
    const enemy = placeEnemy(sim, 'tarling', player.x + 52, player.y);
    enemy.hp = 99999;

    sim.triggerActiveSkill();
    tickSkills(sim, 0.5);

    // Point defence uses its own clock, so the satellites' is untouched.
    expect(enemy.pdCooldown).toBeGreaterThan(0);
    expect(enemy.orbitCooldown).toBe(0);
  });
});

describe('Skill loadout persistence', () => {
  it('defaults a fresh save to the default skill', () => {
    expect(createDefaultState().activeSkillId).toBe(DEFAULT_ACTIVE_SKILL_ID);
  });

  it('keeps a valid stored choice through a load', () => {
    const stored = { ...createDefaultState(), activeSkillId: ACTIVE_SKILL_IDS.POINT_DEFENSE };
    expect(loadState(stored).activeSkillId).toBe(ACTIVE_SKILL_IDS.POINT_DEFENSE);
  });

  it('repairs a save naming a skill that no longer exists', () => {
    const broken = { ...createDefaultState(), activeSkillId: 'removed_skill' };
    expect(sanitizeState(broken).activeSkillId).toBe(DEFAULT_ACTIVE_SKILL_ID);
  });

  it('repairs a save with no skill field at all', () => {
    const legacy = createDefaultState();
    delete legacy.activeSkillId;
    expect(sanitizeState(legacy).activeSkillId).toBe(DEFAULT_ACTIVE_SKILL_ID);
  });
});

describe('Hangar loadout', () => {
  it('lists all seven with the equipped one flagged', () => {
    const state = { ...createDefaultState(), activeSkillId: ACTIVE_SKILL_IDS.EMP_SHOCKWAVE };
    const rows = describeActiveSkills(state);

    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.equipped).map((r) => r.id)).toEqual([
      ACTIVE_SKILL_IDS.EMP_SHOCKWAVE,
    ]);
    for (const row of rows) {
      expect(row.name, row.id).toBeTruthy();
      expect(row.cooldown, row.id).toBeGreaterThan(0);
    }
  });

  it('equips without mutating the state it was handed', () => {
    const before = createDefaultState();
    const result = equipActiveSkill(before, ACTIVE_SKILL_IDS.POINT_DEFENSE);

    expect(result.ok).toBe(true);
    expect(result.state.activeSkillId).toBe(ACTIVE_SKILL_IDS.POINT_DEFENSE);
    // The caller's object is untouched, like every other meta action.
    expect(before.activeSkillId).toBe(DEFAULT_ACTIVE_SKILL_ID);
  });

  it('refuses an id that is not a skill', () => {
    const state = createDefaultState();
    const result = equipActiveSkill(state, 'nonsense');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNKNOWN_SKILL');
    expect(result.state).toBe(state);
  });

  it('carries a hangar choice all the way into a run', () => {
    const equipped = equipActiveSkill(createDefaultState(), ACTIVE_SKILL_IDS.MISSILE_SALVO).state;
    const sim = makeSim();
    sim.startRun(equipped);

    expect(sim.activeSkills.skillId).toBe(ACTIVE_SKILL_IDS.MISSILE_SALVO);
    expect(sim.activeSkills.isReady).toBe(true);
  });
});

describe('System isolation', () => {
  it('builds against a Simulation without touching the DOM or PixiJS', () => {
    const sim = makeSim();
    const system = new ActiveSkillSystem(sim);
    expect(system.getSnapshot()).toMatchObject({
      skillId: DEFAULT_ACTIVE_SKILL_ID,
      ready: true,
      active: false,
    });
  });

  it('every skill casts and runs its window out without throwing', () => {
    for (const id of ACTIVE_SKILL_ORDER) {
      const sim = makeSim(id);
      const player = sim.state.player;
      placeEnemy(sim, 'tarling', player.x + 80, player.y);
      placeEnemy(sim, 'bio_goliath', player.x - 120, player.y + 60);
      sim.spawnEnemyBullet({
        x: player.x + 30,
        y: player.y,
        vx: 10,
        vy: 0,
        damage: 4,
        radius: 5,
        life: 4,
      });

      expect(() => {
        sim.triggerActiveSkill();
        for (let i = 0; i < 300; i++) sim.update(DT, { x: 1, y: 0 });
      }, id).not.toThrow();

      expect(sim.activeSkills.isActive, id).toBe(false);
    }
  });
});
