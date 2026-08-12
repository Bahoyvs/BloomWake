import { EventBus } from './event-bus.js';
import { getEnemyCount, getEnemyHpMultiplier, getEnemySpeedMultiplier, getWaveDuration, isBossWave } from './wave.js';
import { CARDS, getCardById } from '../data/cards.js';

export const GAME_STATES = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  WAVE_COMPLETE: 'WAVE_COMPLETE',
  GAME_OVER: 'GAME_OVER',
};

export const DEFAULT_PLAYER_STATS = {
  moveSpeed: 3.2,
  maxHp: 100,
  hp: 100,
  pickupRadius: 0.8,
};

export class GameState {
  /**
   * @param {EventBus} [bus] - EventBus instance
   */
  constructor(bus = new EventBus()) {
    this.bus = bus;
    this.reset();
  }

  /**
   * Reset game state to initial baseline
   */
  reset() {
    this.currentState = GAME_STATES.IDLE;
    this.wave = 1;
    this.waveTimeRemaining = getWaveDuration(1);
    this.score = 0;
    this.kills = 0;
    this.petalsEarned = 0;

    // Player Dewling statistics
    this.player = {
      ...DEFAULT_PLAYER_STATS,
      level: 1,
      xp: 0,
      xpToNextLevel: 20,
      x: 0,
      y: 0,
    };

    // Cards owned: Map of cardId -> currentLevel (1-5)
    this.activeCards = new Map();
    // Default starter weapon card: Dewdrop Barrage Level 1
    this.activeCards.set('dewdrop_barrage', 1);

    this.bus.emit('state:reset', this.getStateSummary());
  }

  /**
   * Start a new run
   */
  startRun() {
    this.reset();
    this.currentState = GAME_STATES.RUNNING;
    this.bus.emit('state:change', { from: GAME_STATES.IDLE, to: GAME_STATES.RUNNING });
    this.bus.emit('wave:start', this.getWaveData());
  }

  /**
   * Pause execution
   */
  pause() {
    if (this.currentState === GAME_STATES.RUNNING) {
      this.currentState = GAME_STATES.PAUSED;
      this.bus.emit('state:change', { from: GAME_STATES.RUNNING, to: GAME_STATES.PAUSED });
    }
  }

  /**
   * Resume execution
   */
  resume() {
    if (this.currentState === GAME_STATES.PAUSED) {
      this.currentState = GAME_STATES.RUNNING;
      this.bus.emit('state:change', { from: GAME_STATES.PAUSED, to: GAME_STATES.RUNNING });
    }
  }

  /**
   * Advance game loop by delta time (in seconds)
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    if (this.currentState !== GAME_STATES.RUNNING) return;

    this.waveTimeRemaining -= dt;
    if (this.waveTimeRemaining <= 0) {
      this.waveTimeRemaining = 0;
      this.completeWave();
    }
  }

  /**
   * Called when wave timer reaches zero or boss is defeated
   */
  completeWave() {
    this.currentState = GAME_STATES.WAVE_COMPLETE;
    this.bus.emit('wave:complete', {
      wave: this.wave,
      score: this.score,
      kills: this.kills,
    });
  }

  /**
   * Advance to next wave
   */
  nextWave() {
    this.wave += 1;
    this.waveTimeRemaining = getWaveDuration(this.wave);
    this.currentState = GAME_STATES.RUNNING;
    this.bus.emit('wave:start', this.getWaveData());
  }

  /**
   * Gain player XP
   * @param {number} amount - XP amount
   */
  addXp(amount) {
    if (amount <= 0 || this.player.hp <= 0) return;

    this.player.xp += amount;
    this.bus.emit('player:xp_gain', { xp: this.player.xp, gained: amount });

    while (this.player.xp >= this.player.xpToNextLevel) {
      this.player.xp -= this.player.xpToNextLevel;
      this.player.level += 1;
      this.player.xpToNextLevel = Math.floor(this.player.xpToNextLevel * 1.35);
      this.bus.emit('player:level_up', {
        level: this.player.level,
        xpToNextLevel: this.player.xpToNextLevel,
      });
    }
  }

  /**
   * Select or upgrade a card
   * @param {string} cardId - Card ID to acquire/upgrade
   */
  selectCard(cardId) {
    const cardDef = getCardById(cardId);
    if (!cardDef) return false;

    const currentLevel = this.activeCards.get(cardId) || 0;
    if (currentLevel >= cardDef.maxLevel) return false;

    const newLevel = currentLevel + 1;
    this.activeCards.set(cardId, newLevel);

    // Apply passive modifiers if Buddy Boost
    if (cardId === 'buddy_boost') {
      const levelData = cardDef.levels[newLevel - 1];
      this.player.moveSpeed = DEFAULT_PLAYER_STATS.moveSpeed * (1 + levelData.moveSpeedBonus);
    }

    this.bus.emit('card:selected', { cardId, level: newLevel });
    return true;
  }

  /**
   * Damage player Dewling
   * @param {number} amount - Damage points
   */
  damagePlayer(amount) {
    if (this.player.hp <= 0 || this.currentState !== GAME_STATES.RUNNING) return;

    this.player.hp = Math.max(0, this.player.hp - amount);
    this.bus.emit('player:damage', { damage: amount, remainingHp: this.player.hp });

    if (this.player.hp === 0) {
      this.triggerGameOver();
    }
  }

  /**
   * Trigger Game Over state
   */
  triggerGameOver() {
    this.currentState = GAME_STATES.GAME_OVER;
    this.bus.emit('game:over', {
      wave: this.wave,
      score: this.score,
      kills: this.kills,
      petalsEarned: this.petalsEarned,
    });
  }

  /**
   * Helper returning wave parameters
   */
  getWaveData() {
    return {
      wave: this.wave,
      maxEnemies: getEnemyCount(this.wave),
      hpMultiplier: getEnemyHpMultiplier(this.wave),
      speedMultiplier: getEnemySpeedMultiplier(this.wave),
      isBossWave: isBossWave(this.wave),
      duration: this.waveTimeRemaining,
    };
  }

  /**
   * Summary snapshot of state
   */
  getStateSummary() {
    return {
      state: this.currentState,
      wave: this.wave,
      timeRemaining: this.waveTimeRemaining,
      score: this.score,
      kills: this.kills,
      player: { ...this.player },
      activeCards: Object.fromEntries(this.activeCards),
    };
  }
}
