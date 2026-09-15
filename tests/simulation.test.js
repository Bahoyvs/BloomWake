import { describe, it, expect, vi } from 'vitest';
import { Simulation } from '../src/core/simulation.js';
import { GameState, GAME_STATES } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';
import {
  UNIT_PX,
  WORLD,
  PLAYER_CFG,
  PHASE1,
  ORB_CFG,
  FRENZY_CFG,
  CARD_MODEL,
} from '../src/core/constants.js';
import { getEnemyCount, getWaveDuration } from '../src/core/wave.js';
import { CARDS, getCardById } from '../src/data/cards.js';
import { ENEMY_TYPES, getBossPhase } from '../src/data/enemies.js';

const STEP = 1 / 60;

/** Build a running Phase 1 simulation with a deterministic seed. */
function makeSim({ maxWaves = PHASE1.MAX_WAVES, seed = 42 } = {}) {
  const bus = new EventBus();
  const state = new GameState(bus, { maxWaves });
  const sim = new Simulation({ bus, state, seed });
  sim.startRun();
  return sim;
}

/**
 * Advance the simulation by a duration in fixed steps.
 * @param {Simulation} sim
 * @param {number} seconds
 * @param {{x: number, y: number}} [input]
 */
function advance(sim, seconds, input = { x: 0, y: 0 }) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) sim.update(STEP, input);
}

/**
 * Take the first offered card if a draft is open. A draft freezes the
 * simulation, so any helper that steps for a while has to resolve one.
 * @param {Simulation} sim
 * @returns {boolean} Whether a draft was resolved
 */
function autoPick(sim) {
  if (sim.state.currentState !== GAME_STATES.LEVEL_UP) return false;
  sim.state.chooseCard(sim.state.pendingDraft[0]);
  return true;
}

/**
 * Step until a condition holds, so tests never depend on float-exact timing.
 * @param {Simulation} sim
 * @param {(sim: Simulation) => boolean} predicate
 * @param {number} [maxSeconds] - Give-up budget
 * @returns {boolean} Whether the condition was reached
 */
function advanceUntil(sim, predicate, maxSeconds = 600) {
  const steps = Math.ceil(maxSeconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (predicate(sim)) return true;
    autoPick(sim);
    /*
     * God mode, for the wave-FLOW tests only (they set maxHp to 1e6).
     *
     * The boss branch has always been here: a level-1 starter weapon cannot
     * chew through 400+ boss HP inside a test budget, and these tests are
     * about the wave state machine, not about damage.
     *
     * The swarm branch is the same idea for the "clear the swarm" rule. A wave
     * no longer ends on a timer — it ends when the field is empty — so a
     * stationary dummy with one L1 weapon would sit in the clear-out tail
     * forever. Killing the stragglers once the spawn window has closed is the
     * scripted stand-in for the player doing it.
     */
    if (sim.state.player.maxHp > 1000) {
      const clearing = sim.state.spawnWindowClosed;
      for (const e of sim.enemies) {
        if (!e.alive) continue;
        if (e.isBoss || clearing) sim.damageEnemy(e, 99999);
      }
    }
    sim.update(STEP, { x: 0, y: 0 });
  }
  return predicate(sim);
}

describe('Simulation — Phase 1 core survival loop', () => {
  describe('Movement', () => {
    it('starts the Dewling centred in the arena', () => {
      const sim = makeSim();
      expect(sim.state.player.x).toBe(WORLD.WIDTH / 2);
      expect(sim.state.player.y).toBe(WORLD.HEIGHT / 2);
    });

    it('reaches exactly the configured speed in units/sec', () => {
      // Measured AFTER the ramp, not from a standing start. The ship has mass
      // now (PLAYER_CFG.ACCEL), so "moves at the configured speed" is a
      // statement about terminal velocity — which is the figure the GDD, the
      // kiting distance and the whole balance envelope actually depend on.
      const sim = makeSim();
      advance(sim, 1.0, { x: 1, y: 0 }); // spend the ramp

      const startX = sim.state.player.x;
      advance(sim, 1.0, { x: 1, y: 0 });

      expect(sim.state.player.x - startX).toBeCloseTo(sim.state.player.moveSpeed * UNIT_PX, 0);
    });

    it('ramps up rather than snapping to top speed', () => {
      const sim = makeSim();
      const speed = sim.state.player.moveSpeed * UNIT_PX;

      sim.update(STEP, { x: 1, y: 0 });

      // One frame in, the ship is moving but nowhere near top speed. This is
      // the whole difference between a ship and a cursor.
      expect(sim.playerVx).toBeGreaterThan(0);
      expect(sim.playerVx).toBeLessThan(speed * 0.5);
    });

    it('coasts to a stop instead of halting on the frame input ends', () => {
      const sim = makeSim();
      advance(sim, 1.0, { x: 1, y: 0 });
      const releasedAt = sim.state.player.x;

      // One frame of no input: still moving, because momentum does not vanish.
      sim.update(STEP, { x: 0, y: 0 });
      expect(sim.playerVx).toBeGreaterThan(0);
      expect(sim.state.player.x).toBeGreaterThan(releasedAt);

      // ...but it does settle, and settles to exactly zero rather than
      // creeping forever on an exponential tail.
      advance(sim, 1.5, { x: 0, y: 0 });
      expect(sim.playerVx).toBe(0);
      expect(sim.playerVy).toBe(0);
    });

    it('drifts through a hard reversal instead of teleporting into it', () => {
      const sim = makeSim();
      advance(sim, 1.0, { x: 1, y: 0 });

      // Slam the opposite direction. A cursor would be at full speed the other
      // way immediately; a ship has to bleed off what it had first.
      sim.update(STEP, { x: -1, y: 0 });
      expect(sim.playerVx).toBeGreaterThan(0);
    });

    it('does not bank momentum against the arena wall', () => {
      // Holding into an edge for a long time must not store thrust that then
      // has to be spent peeling away from it.
      const sim = makeSim();
      advance(sim, 40, { x: -1, y: 0 });

      expect(sim.state.player.x).toBe(PLAYER_CFG.RADIUS);
      expect(sim.playerVx).toBe(0);
    });

    it('reports movement INTENT, not velocity, to the animation director', () => {
      // The director drives idle-vs-move poses. A coasting ship has already
      // cut its engines, so it must read as idle even while still sliding.
      const sim = makeSim();
      advance(sim, 0.5, { x: 1, y: 0 });
      expect(sim.playerMoving).toBe(true);

      sim.update(STEP, { x: 0, y: 0 });
      expect(sim.playerMoving).toBe(false);
      expect(sim.playerVx).toBeGreaterThan(0);
    });

    it('normalizes diagonal input so it is no faster than cardinal', () => {
      const cardinal = makeSim();
      const diagonal = makeSim();

      advance(cardinal, 1.0, { x: 1, y: 0 });
      advance(diagonal, 1.0, { x: 1, y: 1 });

      const cardinalDist = Math.abs(cardinal.state.player.x - WORLD.WIDTH / 2);
      const diagonalDist = Math.hypot(
        diagonal.state.player.x - WORLD.WIDTH / 2,
        diagonal.state.player.y - WORLD.HEIGHT / 2
      );
      expect(diagonalDist).toBeCloseTo(cardinalDist, 4);
    });

    it('clamps the Dewling inside the arena bounds', () => {
      const sim = makeSim();
      advance(sim, 40, { x: -1, y: -1 });

      expect(sim.state.player.x).toBe(PLAYER_CFG.RADIUS);
      expect(sim.state.player.y).toBe(PLAYER_CFG.RADIUS);
    });
  });

  describe('Spawning', () => {
    it('populates the field and respects the wave enemy cap', () => {
      const sim = makeSim();
      advance(sim, 2);
      expect(sim.enemies.length).toBeGreaterThan(0);

      // Far more time than needed to fill; the cap must still hold.
      for (let i = 0; i < 2000; i++) {
        sim.update(STEP, { x: 0, y: 0 });
        expect(sim.enemies.length).toBeLessThanOrEqual(getEnemyCount(sim.state.wave));
      }
    });

    it('spawns only the Phase 1 enemy type', () => {
      const sim = makeSim();
      advance(sim, 10);

      expect(sim.enemies.length).toBeGreaterThan(0);
      for (const enemy of sim.enemies) {
        expect(enemy.typeId).toBe(PHASE1.ENEMY_TYPE);
      }
    });

    it('scales enemy HP with the wave multiplier', () => {
      const sim = makeSim();
      const waveOne = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
      expect(waveOne.maxHp).toBeCloseTo(10);

      sim.state.wave = 5;
      const waveFive = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
      expect(waveFive.maxHp).toBeCloseTo(10 * 1.48); // 1 + 4 * 0.12
    });
  });

  describe('Auto-attack (Dewdrop Barrage)', () => {
    it('fires without player input once an enemy is in range', () => {
      const sim = makeSim();
      const fired = vi.fn();
      sim.bus.on('weapon:fire', fired);

      sim.enemies.push(makeEnemyAt(sim, sim.state.player.x + 120, sim.state.player.y));
      sim.update(STEP);

      expect(fired).toHaveBeenCalledTimes(1);
      expect(sim.projectiles.length).toBe(1);
    });

    it('holds fire when no enemy is within acquisition range', () => {
      const sim = makeSim();
      sim.update(STEP);
      expect(sim.projectiles.length).toBe(0);
    });

    it('respects the card cooldown between volleys', () => {
      const sim = makeSim();
      const stats = getCardById('dewdrop_barrage').levels[0];
      sim.enemies.push(makeEnemyAt(sim, sim.state.player.x + 400, sim.state.player.y));

      sim.update(STEP);
      expect(sim.projectiles.length).toBe(1);

      advance(sim, stats.cooldown * 0.5);
      const midway = sim.projectiles.filter((p) => p.alive).length;
      expect(midway).toBeLessThanOrEqual(1);
    });

    it('kills an enemy and drops an XP orb at its position', () => {
      const sim = makeSim();
      const killed = vi.fn();
      sim.bus.on('enemy:killed', killed);

      // Placed beyond the orb attract radius so the drop stays where it fell.
      const enemy = makeEnemyAt(sim, sim.state.player.x + 200, sim.state.player.y);
      sim.enemies.push(enemy);

      // Level 1 barrage deals 12 vs Tarling's 10 HP: one hit is lethal.
      advance(sim, 0.6);

      expect(enemy.alive).toBe(false);
      expect(sim.state.kills).toBe(1);
      expect(sim.state.score).toBe(10);
      expect(killed).toHaveBeenCalledTimes(1);
      expect(sim.orbs.length).toBe(1);
      expect(sim.orbs[0].value).toBe(4);
    });
  });

  describe('XP orbs and levelling', () => {
    it('collects an orb on contact and awards XP', () => {
      const sim = makeSim();
      const player = sim.state.player;
      sim.spawnOrb(player.x + 5, player.y, 7);

      sim.update(STEP);

      expect(sim.orbs.length).toBe(0);
      expect(sim.state.player.xp).toBe(7);
    });

    it('pulls nearby orbs toward the Dewling', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const orbX = player.x + ORB_CFG.ATTRACT_RADIUS - 10;
      sim.spawnOrb(orbX, player.y, 1);

      sim.update(STEP);

      expect(sim.orbs[0].x).toBeLessThan(orbX);
    });

    it('leaves distant orbs where they fell', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const orbX = player.x + ORB_CFG.ATTRACT_RADIUS + 50;
      sim.spawnOrb(orbX, player.y, 1);

      sim.update(STEP);

      expect(sim.orbs[0].x).toBe(orbX);
    });

    it('opens a card draft on level up and freezes the run', () => {
      const sim = makeSim();
      const offered = vi.fn();
      sim.bus.on('draft:offer', offered);

      sim.state.addXp(20); // level 2

      expect(sim.state.player.level).toBe(2);
      expect(sim.state.currentState).toBe(GAME_STATES.LEVEL_UP);
      expect(offered).toHaveBeenCalledTimes(1);
      expect(sim.state.pendingDraft).toHaveLength(3);

      // Frozen: no movement, no spawning while the draft is open.
      const before = { x: sim.state.player.x, enemies: sim.enemies.length };
      advance(sim, 1, { x: 1, y: 0 });
      expect(sim.state.player.x).toBe(before.x);
      expect(sim.enemies.length).toBe(before.enemies);
    });

    it('applies the chosen card and resumes the run', () => {
      const sim = makeSim();
      sim.state.addXp(20);

      const choice = sim.state.pendingDraft[0];
      const levelBefore = sim.state.activeCards.get(choice) || 0;

      expect(sim.state.chooseCard(choice)).toBe(true);
      expect(sim.state.activeCards.get(choice)).toBe(levelBefore + 1);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
      expect(sim.state.pendingDraft).toBeNull();
    });

    it('rejects a card that was not offered', () => {
      const sim = makeSim();
      sim.state.addXp(20);

      const notOffered = CARDS.map((c) => c.id).find(
        (id) => !sim.state.pendingDraft.includes(id)
      );

      expect(sim.state.chooseCard(notOffered)).toBe(false);
      expect(sim.state.currentState).toBe(GAME_STATES.LEVEL_UP);
    });

    it('queues drafts when several level-ups land at once', () => {
      const sim = makeSim();

      // Enough XP in one go to clear levels 2 and 3 (20 then 27).
      sim.state.addXp(60);

      expect(sim.state.player.level).toBe(3);
      expect(sim.pendingLevelUps).toBe(2);
      expect(sim.state.currentState).toBe(GAME_STATES.LEVEL_UP);

      sim.state.chooseCard(sim.state.pendingDraft[0]);
      // Second draft opens immediately rather than being dropped.
      expect(sim.state.currentState).toBe(GAME_STATES.LEVEL_UP);

      sim.state.chooseCard(sim.state.pendingDraft[0]);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
      expect(sim.pendingLevelUps).toBe(0);
    });

    it('skips the draft when every card is maxed', () => {
      const sim = makeSim();
      for (const card of CARDS) {
        for (let lv = sim.state.activeCards.get(card.id) || 0; lv < card.maxLevel; lv++) {
          sim.state.selectCard(card.id);
        }
      }

      sim.state.addXp(20);

      expect(sim.state.player.level).toBe(2);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
      expect(sim.pendingLevelUps).toBe(0);
    });
  });

  describe('Contact damage', () => {
    it('damages the Dewling on touch, then grants invulnerability frames', () => {
      const sim = makeSim();
      const player = sim.state.player;
      const enemy = makeEnemyAt(sim, player.x, player.y);
      enemy.speed = 0;
      // Tanky enough to survive the auto-attack and keep applying contact damage.
      enemy.hp = 10000;
      enemy.maxHp = 10000;
      sim.enemies.push(enemy);

      sim.update(STEP);
      expect(player.hp).toBe(92); // 100 - 8 contact damage
      expect(sim.invulnTimer).toBeCloseTo(PLAYER_CFG.INVULN_SEC);

      // Still overlapping, but protected for the duration of the i-frames.
      advance(sim, PLAYER_CFG.INVULN_SEC * 0.5);
      expect(player.hp).toBe(92);

      advance(sim, PLAYER_CFG.INVULN_SEC);
      expect(player.hp).toBeLessThan(92);
    });

    it('ends the run when HP is exhausted', () => {
      const sim = makeSim();
      const gameOver = vi.fn();
      sim.bus.on('game:over', gameOver);

      sim.state.damagePlayer(100);

      expect(sim.state.currentState).toBe(GAME_STATES.GAME_OVER);
      expect(gameOver).toHaveBeenCalledTimes(1);

      // A finished run must not keep simulating.
      const before = sim.state.player.x;
      advance(sim, 1, { x: 1, y: 0 });
      expect(sim.state.player.x).toBe(before);
    });
  });

  describe('Run flow (fixed 5 waves)', () => {
    it('clears the field and advances after the wave break', () => {
      const sim = makeSim();
      const reached = advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.WAVE_COMPLETE);

      expect(reached).toBe(true);
      expect(sim.state.waveTimeRemaining).toBe(0);
      expect(sim.enemies.length).toBe(0);

      advance(sim, PHASE1.WAVE_BREAK_SEC + STEP);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
      expect(sim.state.wave).toBe(2);
      expect(sim.state.waveTimeRemaining).toBe(getWaveDuration(2));
    });

    it('still lets the player collect orbs during the wave break', () => {
      const sim = makeSim();
      advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.WAVE_COMPLETE);

      const player = sim.state.player;
      const xpBefore = player.xp;
      sim.spawnOrb(player.x + 5, player.y, 3);
      sim.update(STEP);

      expect(sim.state.currentState).toBe(GAME_STATES.WAVE_COMPLETE);
      expect(sim.state.player.xp).toBe(xpBefore + 3);
    });

    it('wins the run after surviving all 15 waves', () => {
      const sim = makeSim();
      const victory = vi.fn();
      sim.bus.on('game:victory', victory);

      // This test covers wave *flow*, not survival: make the Dewling unkillable
      // so contact damage cannot end the run early.
      sim.state.player.maxHp = 1e6;
      sim.state.player.hp = 1e6;

      const budget = PHASE1.MAX_WAVES * (getWaveDuration(1) + PHASE1.WAVE_BREAK_SEC) + 10;
      const won = advanceUntil(sim, (s) => s.state.currentState === GAME_STATES.VICTORY, budget);

      expect(won).toBe(true);
      expect(sim.state.wave).toBe(PHASE1.MAX_WAVES);
      expect(victory).toHaveBeenCalledTimes(1);
    });

    it('does not advance past the final wave', () => {
      const sim = makeSim();
      sim.state.wave = PHASE1.MAX_WAVES;
      sim.state.completeWave();

      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);

      advance(sim, PHASE1.WAVE_BREAK_SEC * 2);
      expect(sim.state.wave).toBe(PHASE1.MAX_WAVES);
      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);
    });

    it('runs endlessly when no wave limit is configured', () => {
      const sim = makeSim({ maxWaves: Infinity });
      sim.state.player.maxHp = 1e6;
      sim.state.player.hp = 1e6;

      const advanced = advanceUntil(sim, (s) => s.state.wave === 2, 60);

      expect(advanced).toBe(true);
      expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
    });

    it('resets entities and stats when a new run starts', () => {
      const sim = makeSim();
      advance(sim, 5);
      expect(sim.enemies.length).toBeGreaterThan(0);

      sim.startRun();

      expect(sim.enemies.length).toBe(0);
      expect(sim.projectiles.length).toBe(0);
      expect(sim.orbs.length).toBe(0);
      expect(sim.state.wave).toBe(1);
      expect(sim.state.kills).toBe(0);
      expect(sim.state.player.hp).toBe(100);
      expect(sim.state.activeCards.get('dewdrop_barrage')).toBe(1);
    });
  });

  describe('Playability sanity (Phase 1 acceptance)', () => {
    it('is winnable by a competent player and survives a full playthrough', () => {
      const sim = makeSim();

      /*
       * Competent player policy: kite away from threats, avoid arena edges,
       * upgrade owned cards.
       *
       * The 20-minute budget is not slack — a full run measures around 14
       * minutes now that a wave lasts its spawn window PLUS however long the
       * field takes to clear. It also guards the property that matters most
       * about the clear-the-swarm rule: this bot outruns most of the roster,
       * so without the clear-out frenzy (FRENZY_CFG) a single straggler it
       * cannot catch holds a wave open forever, and this test hangs on wave 2
       * rather than failing on damage numbers.
       */
      for (let step = 0; step < 60 * 60 * 20; step++) {
        const status = sim.state.currentState;
        if (status === GAME_STATES.VICTORY || status === GAME_STATES.GAME_OVER) break;

        if (sim.state.currentState === GAME_STATES.LEVEL_UP) {
          const pending = sim.state.pendingDraft;
          // Priority: 1. Upgrade owned card, 2. Bloomshield (survival), 3. First option
          let bestCard = pending[0];
          for (const cardId of pending) {
            if (sim.state.activeCards.has(cardId)) {
              bestCard = cardId;
              break;
            }
            if (cardId === 'bloomshield') {
              bestCard = cardId;
            }
          }
          sim.state.chooseCard(bestCard);
        }

        const player = sim.state.player;
        const boss = sim.enemies.find((e) => e.isBoss && e.alive);
        const threat = boss || sim.findNearestEnemy(600);

        let inputX = 0;
        let inputY = 0;
        let inTelegraph = false;
        // Evade Boss Telegraph AoE warning with highest priority
        if (sim.bossTelegraph.active) {
          const teleDx = player.x - sim.bossTelegraph.x;
          const teleDy = player.y - sim.bossTelegraph.y;
          const dist = Math.hypot(teleDx, teleDy);
          if (dist < sim.bossTelegraph.radius + 60) {
            inTelegraph = true;
            inputX = (teleDx / (dist || 1)) * 800;
            inputY = (teleDy / (dist || 1)) * 800;
          }
        }

        if (!inTelegraph) {
          // Evade Boss Death Ray laterally
          if (sim.deathRay?.active && boss) {
            const toBossX = player.x - boss.x;
            const toBossY = player.y - boss.y;
            inputX += -toBossY * 2.5;
            inputY += toBossX * 2.5;
          }

          if (threat) {
            const dx = threat.x - player.x;
            const dy = threat.y - player.y;
            const dist = Math.hypot(dx, dy);

            /*
             * The kite band is a STABLE ORBIT, and that is the point of it:
             * the bot circles at a fixed radius and the relative bearing to
             * its target stops changing. It is therefore the harshest possible
             * test of weapon geometry, because a shot that misses once misses
             * identically forever — no wobble to bail it out.
             *
             * It genuinely stalled here while the Phase Repeater fanned its
             * salvo around the aim line: at count 2 the pair straddled a
             * centred target past ~155px, so a single survivor inside this
             * band was unkillable and the wave never ended. Parallel wing
             * tracks (PROJECTILE_CFG.HARDPOINT_OFFSET) removed that, and this
             * band is left exactly as it was so it keeps proving it.
             */
            const minDist = threat.isBoss ? 240 : 180;
            const maxDist = threat.isBoss ? 400 : 360;

            if (dist < minDist) {
              inputX -= dx;
              inputY -= dy;
            } else if (dist > maxDist) {
              inputX += dx;
              inputY += dy;
            } else {
              inputX -= dy;
              inputY += dx;
            }
          }
        }

        // Steer away from walls if close to boundary
        const margin = 200;
        if (player.x < margin) inputX += (margin - player.x) * 3;
        if (player.x > WORLD.WIDTH - margin) inputX -= (player.x - (WORLD.WIDTH - margin)) * 3;
        if (player.y < margin) inputY += (margin - player.y) * 3;
        if (player.y > WORLD.HEIGHT - margin) inputY -= (player.y - (WORLD.HEIGHT - margin)) * 3;

        sim.update(STEP, { x: inputX, y: inputY });
      }

      expect(sim.state.currentState).toBe(GAME_STATES.VICTORY);
      expect(sim.state.kills).toBeGreaterThan(50);
      expect(sim.state.player.level).toBeGreaterThan(1);
    });
  });
});

describe('Salvo geometry against a frozen bearing (regression)', () => {
  /*
   * The stalemate this suite exists to prevent, isolated from wave pacing.
   *
   * A lone enemy held at a fixed range and bearing is the worst case for any
   * aimed weapon: there is no relative motion to wobble a near-miss into a
   * hit, so a geometry that misses by a pixel misses for the rest of the run.
   * The old angular fan failed here past ~155px; these ranges bracket the band
   * the acceptance bot kites at.
   */
  /**
   * Time to kill one pinned target, or Infinity if it survives 30s.
   *
   * `level` defaults to 3 — the first Phase Repeater level with count 2, and
   * therefore the first with a dead zone under the old fan. Running this at the
   * card's starting level 1 would prove nothing: a single bolt goes straight
   * down the aim line and has always hit.
   *
   * @param {number} range - Distance the target is held at, px
   * @param {number} [bearing] - Bearing the target is held on, radians
   * @param {number} [level] - Phase Repeater level
   * @returns {number} Seconds to the kill, or Infinity
   */
  function killTime(range, bearing = 0, level = 3) {
    const sim = makeSim();
    sim.enemies.length = 0;
    sim.spawner.active = false;
    sim.state.activeCards.set('dewdrop_barrage', level);
    sim.cards.onCardChanged('dewdrop_barrage');

    const player = sim.state.player;
    const enemy = sim.spawnEnemy(ENEMY_TYPES.TARLING);
    enemy.hp = 40;
    enemy.maxHp = 40;

    for (let step = 0; step < 60 * 30; step++) {
      if (!enemy.alive) return step / 60;

      // Re-pin the target every frame so the bearing is held EXACTLY rather
      // than approximately. Letting it drift even slightly would let a near
      // miss wobble into a hit and hide the very defect this guards.
      enemy.x = player.x + Math.cos(bearing) * range;
      enemy.y = player.y + Math.sin(bearing) * range;
      enemy.vx = 0;
      enemy.vy = 0;

      sim.update(STEP, { x: 0, y: 0 });
    }
    return Infinity;
  }

  it('kills a stationary target held anywhere in the kite band', () => {
    // Every multi-bolt level, at every range the old fan straddled.
    for (const level of [3, 4, 5]) {
      for (const range of [180, 220, 260, 300, 420]) {
        expect(killTime(range, 0, level), `L${level} stationary at ${range}px`).toBeLessThan(30);
      }
    }
  });

  it('kills it on every bearing, not just along +X', () => {
    // The perpendicular hardpoint vector is n = (-sin, cos). Firing along +X
    // gives n = (0, 1) whichever way that is derived, so an axis-aligned test
    // passes even with the components swapped or the sign flipped. These
    // bearings are what actually exercise the vector maths.
    for (let i = 0; i < 8; i++) {
      const bearing = (i / 8) * Math.PI * 2;
      expect(killTime(240, bearing), `bearing ${i}/8`).toBeLessThan(30);
    }
  });

  it('is not expected to hit a target crossing faster than the bolt can lead', () => {
    /*
     * The boundary of the fix, asserted so it is not mistaken for a bug later.
     *
     * The Phase Repeater aims at where the target IS, never where it will be —
     * a deliberate design choice recorded in FRENZY_CFG's notes. At 240px a
     * bolt takes ~0.4s to arrive, so a target sweeping its bearing at 1 rad/s
     * has moved ~90px by then: far outside any hitbox, and nothing to do with
     * salvo geometry. Parallel tracks fixed the dead zone; they do not and
     * cannot substitute for target leading.
     */
    const sim = makeSim();
    sim.enemies.length = 0;
    sim.spawner.active = false;

    const player = sim.state.player;
    const enemy = sim.spawnEnemy(ENEMY_TYPES.TARLING);
    enemy.hp = 40;
    enemy.maxHp = 40;

    sim.state.activeCards.set('dewdrop_barrage', 3);
    sim.cards.onCardChanged('dewdrop_barrage');

    let angle = 0;
    let hit = false;
    for (let step = 0; step < 60 * 10 && !hit; step++) {
      angle += 1.0 * STEP;
      enemy.x = player.x + Math.cos(angle) * 240;
      enemy.y = player.y + Math.sin(angle) * 240;
      enemy.vx = 0;
      enemy.vy = 0;
      sim.update(STEP, { x: 0, y: 0 });
      hit = enemy.hp < enemy.maxHp;
    }

    expect(hit).toBe(false);
  });
});

/**
 * Build (but do not register) a Tarling at a fixed position.
 * @param {Simulation} sim
 */
function makeEnemyAt(sim, x, y) {
  const enemy = sim.spawnEnemy(PHASE1.ENEMY_TYPE);
  sim.enemies.pop();
  enemy.x = x;
  enemy.y = y;
  return enemy;
}

/* ==========================================================================
 * Wave flow: "clear the swarm to advance"
 * ======================================================================== */

describe('Clear the swarm to advance', () => {
  it('closes the spawn window on the clock without ending the wave', () => {
    const sim = makeSim();
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;

    advance(sim, getWaveDuration(1) + 1);

    expect(sim.state.spawnWindowClosed).toBe(true);
    expect(sim.spawner.active).toBe(false);
    // The whole point: a live field means the wave is still running.
    expect(sim.enemies.length).toBeGreaterThan(0);
    expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
  });

  it('stops producing new enemies once the window has closed', () => {
    const sim = makeSim();
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;

    advance(sim, getWaveDuration(1) + 1);
    for (const enemy of sim.enemies) sim.damageEnemy(enemy, 99999);
    advance(sim, 1 / 60);

    // Everything died and the field stayed empty — nothing refilled it.
    expect(sim.enemies.length).toBe(0);
  });

  it('completes the wave on the frame the last enemy dies', () => {
    const sim = makeSim();
    const complete = vi.fn();
    sim.bus.on('wave:complete', complete);
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;

    advance(sim, getWaveDuration(1) + 1);
    expect(complete).not.toHaveBeenCalled();

    for (const enemy of sim.enemies) sim.damageEnemy(enemy, 99999);
    advance(sim, 1 / 60);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(sim.state.currentState).toBe(GAME_STATES.WAVE_COMPLETE);
  });

  it('never ends a wave on the clock while enemies are alive', () => {
    // The regression this rule exists to prevent: cutting to the card screen
    // mid-fight, with a live swarm still on the field.
    const sim = makeSim();
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;

    advance(sim, getWaveDuration(1) + 30);

    expect(sim.enemies.length).toBeGreaterThan(0);
    expect(sim.state.currentState).toBe(GAME_STATES.RUNNING);
  });
});

describe('The clear-out frenzy', () => {
  it('leaves the roster alone while the spawn window is open', () => {
    // During the wave proper, the speed spread IS the roster.
    const sim = makeSim();
    advance(sim, 2);
    expect(sim.getFrenzyFloor()).toBe(0);
  });

  it('applies a balanced enrage multiplier to survivors during clear-out tail', () => {
    const sim = makeSim();
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;

    advance(sim, getWaveDuration(1) + 1);
    expect(sim.getFrenzyFloor()).toBeGreaterThan(0);

    // Wind the ramp forward rather than stepping through it: the dummy is
    // armed, and ten more seconds of live fire would clear the field and end
    // the wave before the assertion.
    sim.frenzyStart = sim.elapsed - FRENZY_CFG.RAMP_SEC;
    expect(sim.getFrenzyFloor()).toBeCloseTo(FRENZY_CFG.MAX_ENRAGE_MULTIPLIER, 3);
    expect(sim.getFrenzyFloor()).toBeLessThanOrEqual(1.10);
    expect(sim.getFrenzyFloor()).toBeGreaterThanOrEqual(1.05);

    // And it reaches the entities, not just the accessor.
    advance(sim, 1 / 60);
    const aliveEnemies = sim.enemies.filter((e) => e.alive && !e.isBoss);
    for (const enemy of aliveEnemies) {
      expect(enemy.speed).toBeCloseTo(enemy.baseSpeed * FRENZY_CFG.MAX_ENRAGE_MULTIPLIER, 2);
    }
  });

  it('does not override a stun', () => {
    // A frozen enemy must stay frozen: the Graviton EMP's whole value is the
    // seconds it buys, and a floor that lifted a stunned enemy would erase them.
    const sim = makeSim();
    sim.state.player.maxHp = 1e6;
    sim.state.player.hp = 1e6;
    advance(sim, getWaveDuration(1) + FRENZY_CFG.RAMP_SEC + 1);

    const victim = sim.enemies[0];
    expect(victim).toBeDefined();
    victim.stunTimer = 1.0;
    advance(sim, 1 / 60);

    expect(victim.speed).toBe(0);
  });
});

/* ==========================================================================
 * The six-class roster
 * ======================================================================== */

describe('Roster behaviours', () => {
  /** Put one enemy of a type on an otherwise empty field, near the player. */
  function soloEnemy(sim, typeId, offsetX = 300, offsetY = 0) {
    for (const e of sim.enemies) sim.enemyPool.release(e);
    sim.enemies.length = 0;
    return sim.spawnEnemy(typeId, {
      x: sim.state.player.x + offsetX,
      y: sim.state.player.y + offsetY,
    });
  }

  it('bursts a Brood Spore into four Xeno Larvae when it dies', () => {
    const sim = makeSim();
    const spore = soloEnemy(sim, ENEMY_TYPES.RUSTBLOOM);

    sim.killEnemy(spore);

    const larvae = sim.enemies.filter((e) => e.alive && e.typeId === ENEMY_TYPES.TARLING);
    expect(larvae).toHaveLength(4);
    // Thrown outward from the corpse, not stacked on it.
    for (const larva of larvae) {
      expect(Math.hypot(larva.x - spore.x, larva.y - spore.y)).toBeGreaterThan(10);
    }
  });

  it('runs the Dart Ravager through lock, brace and dash', () => {
    const sim = makeSim();
    const ravager = soloEnemy(sim, ENEMY_TYPES.CRACKED_WISP);
    ravager.chargeTimer = 0;

    // Next tick takes the lock and starts the wind-up.
    advance(sim, 1 / 60);
    expect(ravager.chargeState).toBe('windup');
    // Braced in place — this is the window the player dodges in.
    expect(ravager.speed).toBe(0);
    const lockedX = ravager.chargeDirX;
    const lockedY = ravager.chargeDirY;

    advance(sim, 0.6);
    expect(ravager.chargeState).toBe('dashing');
    expect(ravager.speed).toBeGreaterThan(ravager.baseSpeed * 1.5);
    // The dash flies the direction it LOCKED, not wherever the player has
    // since moved to. That commitment is what makes the wind-up worth reading.
    expect(ravager.chargeDirX).toBe(lockedX);
    expect(ravager.chargeDirY).toBe(lockedY);
  });

  it('cloaks a Phantom Stalker at range and reveals it in strike range', () => {
    const sim = makeSim();
    const stalker = soloEnemy(sim, ENEMY_TYPES.SMOGMOTH, 500);
    advance(sim, 1 / 60);

    expect(stalker.cloaked).toBe(true);
    expect(stalker.visibility).toBeCloseTo(0.2, 5);
    // Faster while dark: that is what it is buying with the exposure.
    expect(stalker.speed).toBeGreaterThan(stalker.baseSpeed);

    stalker.x = sim.state.player.x + 40;
    advance(sim, 1 / 60);
    expect(stalker.cloaked).toBe(false);
    expect(stalker.visibility).toBe(1);
  });

  it('strips a round of its pierce when it hits a Bio-Goliath', () => {
    /*
     * The species' entire reason to exist: it is a WALL, not just a big target.
     * A fully-levelled Phase Repeater needle stops in the armour instead of
     * carrying on through whatever is sheltering behind it.
     */
    const sim = makeSim();
    const guard = soloEnemy(sim, ENEMY_TYPES.BIO_GOLIATH, 60);

    const bolt = sim.spawnProjectile({
      x: guard.x,
      y: guard.y,
      vx: 400,
      vy: 0,
      damage: 5,
      radius: 5,
      life: 2,
      pierce: 2,
    });

    sim.spatialGrid.clear();
    sim.spatialGrid.insert(guard);
    sim.resolveCollisions();

    expect(bolt.pierce).toBe(0);
    expect(bolt.alive).toBe(false);
  });

  it('lets a pierced round carry on through ordinary chaff', () => {
    const sim = makeSim();
    const larva = soloEnemy(sim, ENEMY_TYPES.TARLING, 60);

    const bolt = sim.spawnProjectile({
      x: larva.x,
      y: larva.y,
      vx: 400,
      vy: 0,
      damage: 1,
      radius: 5,
      life: 2,
      pierce: 2,
    });

    sim.spatialGrid.clear();
    sim.spatialGrid.insert(larva);
    sim.resolveCollisions();

    expect(bolt.alive).toBe(true);
    expect(bolt.pierce).toBe(1);

    // ...and it does not chew the same target twice on the way through.
    const hp = larva.hp;
    sim.resolveCollisions();
    expect(larva.hp).toBe(hp);
  });

  it('knocks a struck enemy backward along the shot line', () => {
    // Impact is displacement, not deformation — see the header of juice.js.
    // Parked outside PROJECTILE_CFG.TARGET_RANGE so the auto-cannon cannot
    // reach it and top the impulse back up mid-assertion.
    const sim = makeSim();
    const larva = soloEnemy(sim, ENEMY_TYPES.TARLING, 700);
    larva.knockVx = 0;

    sim.damageEnemy(larva, 1, 400, 0);
    expect(larva.knockVx).toBeGreaterThan(0);
    expect(larva.knockVy).toBe(0);

    // ...and it rings out fast rather than becoming a shove.
    advance(sim, 0.5);
    expect(larva.knockVx).toBe(0);
  });
});

/* ==========================================================================
 * The Dreadnought Station
 * ======================================================================== */

describe('Boss encounter', () => {
  /** Jump straight to a boss wave with a live Dreadnought on the field. */
  function bossSim() {
    const sim = makeSim();
    sim.state.wave = 5;
    sim.state.waveTimeRemaining = getWaveDuration(5);
    sim.bus.emit('wave:start', sim.state.getWaveData());
    const boss = sim.spawnBoss();
    return { sim, boss };
  }

  it('isolates the arena: no chaff spawns on a boss wave', () => {
    const sim = makeSim();
    advance(sim, 3);
    expect(sim.enemies.length).toBeGreaterThan(0);

    sim.state.wave = 5;
    sim.bus.emit('wave:start', sim.state.getWaveData());

    // Everything that was on the field is gone, and the spawner is shut.
    expect(sim.enemies.length).toBe(0);
    expect(sim.spawner.active).toBe(false);

    advance(sim, 20);
    // Only the boss and the escorts it called itself may be present.
    for (const enemy of sim.enemies) {
      expect(enemy.isBoss || enemy.typeId === ENEMY_TYPES.CRACKED_WISP, enemy.typeId).toBe(
        true
      );
    }
  });

  it('sprays a radial bullet ring from phase 1', () => {
    const { sim } = bossSim();
    advance(sim, 3);
    expect(sim.enemyBullets.length).toBeGreaterThan(0);

    // Evenly spread, not a cone: the ring has to threaten every direction.
    const angles = sim.enemyBullets.filter((b) => b.alive).map((b) => Math.atan2(b.vy, b.vx));
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThan(Math.PI);
  });

  it('accumulates its phases rather than trading them', () => {
    // A boss that swaps one attack for another gets EASIER as it dies.
    expect(getBossPhase(1.0)).toMatchObject({ phase: 1, escort: false, ray: false });
    expect(getBossPhase(0.6)).toMatchObject({ phase: 2, escort: true, ray: false });
    expect(getBossPhase(0.2)).toMatchObject({ phase: 3, escort: true, ray: true });
    for (const fraction of [1.0, 0.6, 0.2]) {
      expect(getBossPhase(fraction).radial).toBe(true);
    }
  });

  it('calls four Dart Ravager escorts in phase 2', () => {
    const { sim, boss } = bossSim();
    boss.hp = boss.maxHp * 0.5;
    boss.escortTimer = 0;
    advance(sim, 1 / 60);

    const escorts = sim.enemies.filter(
      (e) => e.alive && e.typeId === ENEMY_TYPES.CRACKED_WISP
    );
    expect(escorts).toHaveLength(4);
  });

  it('telegraphs the death ray before it does any damage', () => {
    const { sim, boss } = bossSim();
    boss.hp = boss.maxHp * 0.2;
    boss.rayTimer = 0;
    advance(sim, 1 / 60);

    expect(sim.deathRay.active).toBe(true);
    expect(sim.deathRay.firing).toBe(false);

    // Standing in the cone costs nothing while it is only a warning.
    const x = sim.deathRay.x + Math.cos(sim.deathRay.angle) * 300;
    const y = sim.deathRay.y + Math.sin(sim.deathRay.angle) * 300;
    expect(sim.pointInRay(x, y, PLAYER_CFG.RADIUS)).toBe(false);

    advance(sim, 2.0);
    expect(sim.deathRay.firing).toBe(true);
    expect(sim.pointInRay(sim.deathRay.x + Math.cos(sim.deathRay.angle) * 300,
      sim.deathRay.y + Math.sin(sim.deathRay.angle) * 300, PLAYER_CFG.RADIUS)).toBe(true);
  });

  it('stops the death ray when the station dies', () => {
    const { sim, boss } = bossSim();
    boss.hp = boss.maxHp * 0.2;
    boss.rayTimer = 0;
    advance(sim, 2.0);
    expect(sim.deathRay.active).toBe(true);

    sim.damageEnemy(boss, 99999);
    advance(sim, 1 / 60);
    expect(sim.deathRay.active).toBe(false);
  });
});

describe('The damage flash is gated so the swarm stays dark', () => {
  /*
   * The flash is pure white, which is the only tint that can brighten a
   * near-black carapace (a Pixi tint multiplies and cannot add light). The cost
   * is that a flashing enemy shows its UNTINTED source frame, and the Kenney
   * hulls are white with red and yellow accents.
   *
   * A maxed build lands several hits a second on everything in reach, so
   * without a refractory gap the flash never expires and the whole swarm sits
   * permanently white-and-red — the palette's darkness contract switching
   * itself off exactly when the screen is busiest.
   */
  function soloTarget(sim) {
    for (const e of sim.enemies) sim.enemyPool.release(e);
    sim.enemies.length = 0;
    const enemy = sim.spawnEnemy(ENEMY_TYPES.BIO_GOLIATH, {
      x: sim.state.player.x + 200,
      y: sim.state.player.y,
    });
    enemy.hp = 1e6;
    enemy.maxHp = 1e6;
    return enemy;
  }

  it('flashes on a hit', () => {
    const sim = makeSim();
    const enemy = soloTarget(sim);
    sim.damageEnemy(enemy, 1);
    expect(enemy.hitFlash).toBeGreaterThan(0);
  });

  it('refuses to re-flash inside the refractory window', () => {
    const sim = makeSim();
    const enemy = soloTarget(sim);

    sim.damageEnemy(enemy, 1);
    const firstFlashAt = enemy.lastHitTime;

    // A second weapon connecting on the very next tick must not extend it.
    advance(sim, 1 / 60);
    sim.damageEnemy(enemy, 1);
    expect(enemy.lastHitTime).toBe(firstFlashAt);
  });

  it('holds the swarm dark for most of a second under sustained fire', () => {
    // The property that actually matters, measured the way the player sees it.
    const sim = makeSim();
    const enemy = soloTarget(sim);

    let litFrames = 0;
    const frames = 300; // five seconds
    for (let i = 0; i < frames; i++) {
      sim.damageEnemy(enemy, 1); // every single frame
      advance(sim, 1 / 60);
      if (enemy.hitFlash > 0) litFrames++;
    }

    expect(litFrames / frames).toBeLessThan(0.35);
    // ...but it is not suppressed into invisibility either.
    expect(litFrames).toBeGreaterThan(0);
  });
});

describe('Tesla Arc targets the nearest enemy and chains', () => {
  it('automatically targets the nearest enemy within range regardless of ship facing', () => {
    const sim = makeSim();
    sim.updateSpawning = () => {};
    for (const e of sim.enemies) sim.enemyPool.release(e);
    sim.enemies.length = 0;
    sim.state.activeCards.clear();
    sim.cards.runtime.clear();
    for (let i = 0; i < 5; i++) sim.state.selectCard('sunbeam_lance');
    sim.cards.onCardChanged('sunbeam_lance');

    // Place an enemy to the right (+X), while pointing the ship straight up (-Y)
    const enemy = sim.enemyPool.acquire();
    enemy.alive = true;
    enemy.x = sim.state.player.x + 150;
    enemy.y = sim.state.player.y;
    enemy.hp = 1000;
    enemy.maxHp = 1000;
    sim.enemies.push(enemy);

    // Point ship straight up (-Y)
    advance(sim, 0.5, { x: 0, y: -1 });
    let beam = null;
    for (let i = 0; i < 300 && !beam; i++) {
      sim.update(1 / 60, { x: 0, y: -1 });
      beam = sim.cards.getBeamState();
    }

    expect(beam).not.toBeNull();
    expect(beam.chain.length).toBeGreaterThan(0);
    expect(beam.chain[0].x).toBeCloseTo(enemy.x, 1);
  });

  it('keeps its heading when the ship comes to a stop', () => {
    // Velocity goes to zero when the player lets go; facing must not, or a
    // parked ship would fire sideways along +X.
    const sim = makeSim();
    advance(sim, 0.5, { x: 0, y: -1 });
    advance(sim, 3.0, { x: 0, y: 0 });

    expect(sim.playerVy).toBe(0);
    expect(sim.getFacing().y).toBeCloseTo(-1, 5);
  });
});
