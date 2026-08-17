/**
 * Step A1 — animation state is a core-emitted signal.
 *
 * These tests assert two things the render layer depends on absolutely:
 * that the right semantic state is chosen from existing game state, and that
 * a hit lasts exactly one tick (a hit that latched would leave the Dewling
 * permanently in its damage pose after the first scratch).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ANIM_STATES,
  AnimationDirector,
  BOSS_TIER_THRESHOLDS,
  DEWLING_ENTITY_ID,
  DEWLING_PRIORITY,
  RUSTWHALE_PRIORITY,
  bossTierForHpFraction,
  resolveDewlingState,
  resolveRustwhaleState,
  statePriority,
} from '../src/core/animation.js';
import { EventBus, EVENTS } from '../src/core/event-bus.js';
import { GameState } from '../src/core/game-state.js';
import { Simulation } from '../src/core/simulation.js';
import { PHASE1 } from '../src/core/constants.js';
import { ENEMY_TYPES } from '../src/data/enemies.js';

describe('resolveDewlingState', () => {
  it('reports move when velocity is non-zero', () => {
    expect(resolveDewlingState({ hp: 100, moving: true })).toBe(ANIM_STATES.MOVE);
  });

  it('reports idle when standing still', () => {
    expect(resolveDewlingState({ hp: 100, moving: false })).toBe(ANIM_STATES.IDLE);
  });

  it('reports hit when damage was taken, even while moving', () => {
    expect(resolveDewlingState({ hp: 60, moving: true, damaged: true })).toBe(ANIM_STATES.HIT);
  });

  it('reports death at zero HP, outranking every other signal', () => {
    expect(
      resolveDewlingState({ hp: 0, moving: true, damaged: true, attacking: true })
    ).toBe(ANIM_STATES.DEATH);
  });

  it('reports attack over move', () => {
    expect(resolveDewlingState({ hp: 100, moving: true, attacking: true })).toBe(
      ANIM_STATES.ATTACK
    );
  });

  it('is pure — repeated calls with the same signals give the same state', () => {
    const signals = { hp: 40, moving: true, attacking: true };
    const first = resolveDewlingState(signals);
    const second = resolveDewlingState(signals);
    expect(first).toBe(second);
    expect(signals).toEqual({ hp: 40, moving: true, attacking: true });
  });
});

describe('resolveRustwhaleState', () => {
  it('reports telegraph while the Black Tide is winding up', () => {
    expect(resolveRustwhaleState({ hp: 500, telegraphing: true })).toBe(ANIM_STATES.TELEGRAPH);
  });

  it('keeps telegraph over hit — a boss under fire must still show its wind-up', () => {
    // This is the ordering that keeps the fairness signal visible. A boss is
    // taking damage on nearly every tick of a telegraph, so if hit won here the
    // telegraph animation would essentially never play.
    expect(resolveRustwhaleState({ hp: 500, telegraphing: true, damaged: true })).toBe(
      ANIM_STATES.TELEGRAPH
    );
  });

  it('does not let a phase-up interrupt a telegraph', () => {
    expect(
      resolveRustwhaleState({ hp: 500, telegraphing: true, phaseUp: true })
    ).toBe(ANIM_STATES.TELEGRAPH);
  });

  it('reports phaseUp over hit', () => {
    expect(resolveRustwhaleState({ hp: 300, phaseUp: true, damaged: true })).toBe(
      ANIM_STATES.PHASE_UP
    );
  });

  it('reports death at zero HP over everything', () => {
    expect(
      resolveRustwhaleState({ hp: 0, telegraphing: true, phaseUp: true, damaged: true })
    ).toBe(ANIM_STATES.DEATH);
  });

  it('falls back to idle with no active signal', () => {
    expect(resolveRustwhaleState({ hp: 500 })).toBe(ANIM_STATES.IDLE);
  });
});

describe('boss tier thresholds', () => {
  it('splits a fight into three bands', () => {
    expect(bossTierForHpFraction(1.0)).toBe(0);
    expect(bossTierForHpFraction(0.9)).toBe(0);
    expect(bossTierForHpFraction(BOSS_TIER_THRESHOLDS[0])).toBe(1);
    expect(bossTierForHpFraction(0.5)).toBe(1);
    expect(bossTierForHpFraction(BOSS_TIER_THRESHOLDS[1])).toBe(2);
    expect(bossTierForHpFraction(0.0)).toBe(2);
  });

  it('rises monotonically as HP falls', () => {
    let previous = 0;
    for (let f = 1; f >= 0; f -= 0.05) {
      const tier = bossTierForHpFraction(f);
      expect(tier).toBeGreaterThanOrEqual(previous);
      previous = tier;
    }
  });
});

describe('statePriority', () => {
  it('ranks death above everything for the Dewling', () => {
    for (const state of [ANIM_STATES.HIT, ANIM_STATES.ATTACK, ANIM_STATES.MOVE]) {
      expect(statePriority(ANIM_STATES.DEATH, DEWLING_PRIORITY)).toBeLessThan(
        statePriority(state, DEWLING_PRIORITY)
      );
    }
  });

  it('ranks telegraph above hit for the Rustwhale', () => {
    expect(statePriority(ANIM_STATES.TELEGRAPH, RUSTWHALE_PRIORITY)).toBeLessThan(
      statePriority(ANIM_STATES.HIT, RUSTWHALE_PRIORITY)
    );
  });

  it('ranks an unknown state last rather than first', () => {
    expect(statePriority('nonsense', DEWLING_PRIORITY)).toBe(DEWLING_PRIORITY.length);
  });
});

describe('AnimationDirector emits on the event bus', () => {
  let bus;
  let events;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.on(EVENTS.ANIMATION_STATE, (data) => events.push(data));
  });

  /** Minimal Simulation stand-in — the director only reads these fields. */
  function fakeSim(overrides = {}) {
    return {
      state: { player: { hp: 100 } },
      enemies: [],
      bossTelegraph: { active: false },
      playerMoving: false,
      ...overrides,
    };
  }

  it('emits nothing but the initial state when nothing changes', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();

    director.update(sim);
    director.update(sim);
    director.update(sim);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: DEWLING_ENTITY_ID, state: ANIM_STATES.IDLE });
  });

  it('emits move when the Dewling starts moving, and only once', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();

    director.update(sim);
    sim.playerMoving = true;
    director.update(sim);
    director.update(sim);

    expect(events.map((e) => e.state)).toEqual([ANIM_STATES.IDLE, ANIM_STATES.MOVE]);
  });

  it('carries the previous state on the payload', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();
    director.update(sim);
    sim.playerMoving = true;
    director.update(sim);

    expect(events[1]).toMatchObject({
      state: ANIM_STATES.MOVE,
      previous: ANIM_STATES.IDLE,
    });
  });

  it('holds hit for exactly one tick, then returns to the real state', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim({ playerMoving: true });

    director.update(sim); // move
    bus.emit(EVENTS.PLAYER_DAMAGE, { amount: 10 });
    director.update(sim); // hit — the damage tick
    director.update(sim); // back to move — the latch was consumed

    expect(events.map((e) => e.state)).toEqual([
      ANIM_STATES.MOVE,
      ANIM_STATES.HIT,
      ANIM_STATES.MOVE,
    ]);
  });

  it('holds attack for exactly one tick after a weapon fires', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();

    director.update(sim); // idle
    bus.emit(EVENTS.WEAPON_FIRE, {});
    director.update(sim); // attack
    director.update(sim); // idle again

    expect(events.map((e) => e.state)).toEqual([
      ANIM_STATES.IDLE,
      ANIM_STATES.ATTACK,
      ANIM_STATES.IDLE,
    ]);
  });

  it('emits death once HP reaches zero and does not repeat it', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();

    director.update(sim);
    sim.state.player.hp = 0;
    director.update(sim);
    director.update(sim);

    expect(events.map((e) => e.state)).toEqual([ANIM_STATES.IDLE, ANIM_STATES.DEATH]);
  });

  it('emits death when the run ends, which polling alone cannot catch', () => {
    // Simulation.update() returns early once the state leaves RUNNING, so the
    // director stops being ticked at exactly the moment the Dewling dies.
    const director = new AnimationDirector(bus);
    const sim = fakeSim({ playerMoving: true });

    director.update(sim);
    bus.emit(EVENTS.GAME_OVER, { wave: 3 });

    expect(events[events.length - 1].state).toBe(ANIM_STATES.DEATH);
    expect(director.getState(DEWLING_ENTITY_ID)).toBe(ANIM_STATES.DEATH);
  });

  it('does not re-emit death if game:over fires twice', () => {
    const director = new AnimationDirector(bus);
    director.update(fakeSim());
    bus.emit(EVENTS.GAME_OVER, {});
    bus.emit(EVENTS.GAME_OVER, {});

    expect(events.filter((e) => e.state === ANIM_STATES.DEATH)).toHaveLength(1);
  });

  it('tracks a boss and emits phaseUp when it crosses a tier threshold', () => {
    const director = new AnimationDirector(bus);
    const boss = { id: 7, isBoss: true, hp: 1000, maxHp: 1000, alive: true };
    const sim = fakeSim({ enemies: [boss] });

    director.update(sim); // idle, tier 0 registered
    boss.hp = 600; // 0.6 -> below 2/3, tier 1
    director.update(sim);

    const bossEvents = events.filter((e) => e.entityId === 7);
    expect(bossEvents.map((e) => e.state)).toEqual([ANIM_STATES.IDLE, ANIM_STATES.PHASE_UP]);
  });

  it('emits telegraph for the boss while the Black Tide winds up', () => {
    const director = new AnimationDirector(bus);
    const boss = { id: 7, isBoss: true, hp: 1000, maxHp: 1000, alive: true };
    const sim = fakeSim({ enemies: [boss] });

    director.update(sim);
    sim.bossTelegraph.active = true;
    director.update(sim);

    const bossEvents = events.filter((e) => e.entityId === 7);
    expect(bossEvents[bossEvents.length - 1].state).toBe(ANIM_STATES.TELEGRAPH);
  });

  it('keeps the boss in telegraph while it is being shot', () => {
    const director = new AnimationDirector(bus);
    const boss = { id: 7, isBoss: true, hp: 1000, maxHp: 1000, alive: true };
    const sim = fakeSim({ enemies: [boss], bossTelegraph: { active: true } });

    director.update(sim);
    for (let i = 0; i < 5; i++) {
      bus.emit(EVENTS.ENEMY_DAMAGED, { id: 7, damage: 10 });
      director.update(sim);
    }

    const bossStates = events.filter((e) => e.entityId === 7).map((e) => e.state);
    expect(bossStates).toEqual([ANIM_STATES.TELEGRAPH]);
  });

  it('forgets a boss that leaves the field', () => {
    const director = new AnimationDirector(bus);
    const boss = { id: 7, isBoss: true, hp: 1000, maxHp: 1000, alive: true };
    const sim = fakeSim({ enemies: [boss] });

    director.update(sim);
    expect(director.getState(7)).toBe(ANIM_STATES.IDLE);

    sim.enemies = [];
    director.update(sim);
    expect(director.getState(7)).toBeUndefined();
  });

  it('ignores damage aimed at an entity it does not track', () => {
    const director = new AnimationDirector(bus);
    const sim = fakeSim();

    director.update(sim);
    bus.emit(EVENTS.ENEMY_DAMAGED, { id: 999, damage: 5 });
    director.update(sim);

    expect(events).toHaveLength(1);
  });
});

describe('AnimationDirector inside the real simulation', () => {
  /** @returns {Simulation} */
  function makeSim() {
    const bus = new EventBus();
    const state = new GameState(bus, { maxWaves: PHASE1.MAX_WAVES });
    const sim = new Simulation({ bus, state, seed: 5 });
    sim.startRun();
    return sim;
  }

  it('moves the Dewling out of idle when the player gives input', () => {
    const sim = makeSim();
    const seen = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => {
      if (data.entityId === DEWLING_ENTITY_ID) seen.push(data.state);
    });

    sim.update(1 / 60, { x: 0, y: 0 });
    sim.update(1 / 60, { x: 1, y: 0 });

    expect(seen).toContain(ANIM_STATES.MOVE);
  });

  it('treats input into a wall as moving', () => {
    const sim = makeSim();
    // Pin the Dewling against the left edge so its position cannot change.
    sim.state.player.x = 0;
    const seen = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => {
      if (data.entityId === DEWLING_ENTITY_ID) seen.push(data.state);
    });

    sim.update(1 / 60, { x: -1, y: 0 });

    expect(seen).toContain(ANIM_STATES.MOVE);
  });

  it('emits death for the Dewling when the player actually dies', () => {
    const sim = makeSim();
    const seen = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => {
      if (data.entityId === DEWLING_ENTITY_ID) seen.push(data.state);
    });

    sim.update(1 / 60, { x: 1, y: 0 });
    sim.damagePlayer(9999);
    sim.update(1 / 60, { x: 0, y: 0 });

    expect(seen[seen.length - 1]).toBe(ANIM_STATES.DEATH);
  });

  it('emits death for a boss killed by damage', () => {
    const sim = makeSim();
    const boss = sim.spawnBoss();
    const seen = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => {
      if (data.entityId === boss.id) seen.push(data.state);
    });

    sim.update(1 / 60, { x: 0, y: 0 });
    sim.damageEnemy(boss, boss.hp + 1);
    sim.update(1 / 60, { x: 0, y: 0 });

    expect(seen).toContain(ANIM_STATES.DEATH);
  });

  it('emits telegraph while the real boss telegraph is active', () => {
    const sim = makeSim();
    const boss = sim.spawnBoss();
    const seen = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => {
      if (data.entityId === boss.id) seen.push(data.state);
    });

    sim.update(1 / 60, { x: 0, y: 0 });
    sim.triggerBossTelegraph(sim.state.player.x, sim.state.player.y);
    sim.update(1 / 60, { x: 0, y: 0 });

    expect(seen[seen.length - 1]).toBe(ANIM_STATES.TELEGRAPH);
  });

  it('never emits a frame index, fps or sheet name — core stays semantic', () => {
    const sim = makeSim();
    const payloads = [];
    sim.bus.on(EVENTS.ANIMATION_STATE, (data) => payloads.push(data));

    for (let i = 0; i < 120; i++) sim.update(1 / 60, { x: i % 2 ? 1 : 0, y: 0 });

    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual(['entityId', 'previous', 'state']);
      expect(Object.values(ANIM_STATES)).toContain(payload.state);
    }
  });
});

describe('core stays DOM-free', () => {
  it('animation.js references no browser API', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../src/core/animation.js', import.meta.url), 'utf8');
    // Comments are prose and legitimately say things like "fairness window";
    // only executable code is under test here.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const pattern of [
      /\bdocument\b/,
      /\bwindow\b/,
      /\brequestAnimationFrame\b/,
      /\bcanvas\b/i,
      /from ['"]pixi/,
      /\blocalStorage\b/,
    ]) {
      expect(code).not.toMatch(pattern);
    }
  });

  it('animation.js imports only from core', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/core/animation.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);

    for (const specifier of imports) {
      expect(specifier.startsWith('./')).toBe(true);
    }
  });
});
