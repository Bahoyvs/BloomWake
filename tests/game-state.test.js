import { describe, it, expect, vi } from 'vitest';
import { GameState, GAME_STATES } from '../src/core/game-state.js';
import { EventBus } from '../src/core/event-bus.js';

describe('GameState Engine & Pure Simulation', () => {
  it('should initialize in IDLE state with default starter card', () => {
    const game = new GameState();
    const summary = game.getStateSummary();

    expect(summary.state).toBe(GAME_STATES.IDLE);
    expect(summary.wave).toBe(1);
    expect(summary.player.hp).toBe(100);
    expect(summary.activeCards).toEqual({ dewdrop_barrage: 1 });
  });

  it('should transition states and emit wave:start on startRun()', () => {
    const bus = new EventBus();
    const waveStartFn = vi.fn();
    bus.on('wave:start', waveStartFn);

    const game = new GameState(bus);
    game.startRun();

    expect(game.currentState).toBe(GAME_STATES.RUNNING);
    expect(waveStartFn).toHaveBeenCalledTimes(1);
    expect(waveStartFn).toHaveBeenCalledWith(expect.objectContaining({ wave: 1, maxEnemies: 14 }));
  });

  it('closes the spawn window on update() without ending the wave', () => {
    const bus = new EventBus();
    const waveCompleteFn = vi.fn();
    const spawnClosedFn = vi.fn();
    bus.on('wave:complete', waveCompleteFn);
    bus.on('wave:spawn_closed', spawnClosedFn);

    const game = new GameState(bus);
    game.startRun();
    const window = game.waveTimeRemaining;

    game.update(window - 1); // 1 second of spawning left
    expect(game.spawnWindowClosed).toBe(false);
    expect(game.currentState).toBe(GAME_STATES.RUNNING);

    game.update(2.0); // clock runs out
    expect(game.spawnWindowClosed).toBe(true);
    expect(spawnClosedFn).toHaveBeenCalledTimes(1);
    /*
     * THE WAVE IS NOT OVER. The clock only stops new arrivals; clearing the
     * field is what ends it, and only the simulation knows whether the field
     * is clear. Further ticks must not sneak a completion through.
     */
    expect(game.currentState).toBe(GAME_STATES.RUNNING);
    expect(waveCompleteFn).not.toHaveBeenCalled();

    game.update(10.0);
    expect(spawnClosedFn).toHaveBeenCalledTimes(1);
    expect(waveCompleteFn).not.toHaveBeenCalled();
  });

  it('should handle level up and XP thresholds', () => {
    const bus = new EventBus();
    const levelUpFn = vi.fn();
    bus.on('player:level_up', levelUpFn);

    const game = new GameState(bus);
    game.startRun();

    // Base xpToNextLevel = 20
    game.addXp(25);

    expect(game.player.level).toBe(2);
    expect(game.player.xp).toBe(5); // 25 - 20 = 5
    expect(levelUpFn).toHaveBeenCalledTimes(1);
    expect(levelUpFn).toHaveBeenCalledWith({ level: 2, xpToNextLevel: 27 });
  });

  it('should trigger GAME_OVER when player HP reaches 0', () => {
    const bus = new EventBus();
    const gameOverFn = vi.fn();
    bus.on('game:over', gameOverFn);

    const game = new GameState(bus);
    game.startRun();
    game.damagePlayer(150);

    expect(game.player.hp).toBe(0);
    expect(game.currentState).toBe(GAME_STATES.GAME_OVER);
    expect(gameOverFn).toHaveBeenCalledTimes(1);
  });
});
