import { EventBus } from './event-bus.js';
import { getEnemyCount, getEnemyHpMultiplier, getEnemySpeedMultiplier, getWaveDuration, isBossWave } from './wave.js';
import { CARDS, getCardById } from '../data/cards.js';

export const GAME_STATES = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  WAVE_COMPLETE: 'WAVE_COMPLETE',
  /** Card draft open; the simulation is frozen until a card is chosen. */
  LEVEL_UP: 'LEVEL_UP',
  GAME_OVER: 'GAME_OVER',
  VICTORY: 'VICTORY',
};

export const DEFAULT_PLAYER_STATS = {
  moveSpeed: 4.8,
  maxHp: 100,
  hp: 100,
  pickupRadius: 0.8,
};

export class GameState {
  /**
   * @param {EventBus} [bus] - EventBus instance
   * @param {Object} [options]
   * @param {number} [options.maxWaves] - Run length; clearing this wave wins the run.
   *   Defaults to Infinity (endless), Phase 1 passes 5.
   */
  constructor(bus = new EventBus(), options = {}) {
    this.bus = bus;
    this.maxWaves = options.maxWaves ?? Infinity;
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

    // Card IDs currently on offer, null when no draft is open.
    this.pendingDraft = null;
    this.stateBeforeDraft = null;

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
      isFinalWave: this.wave >= this.maxWaves,
    });

    if (this.wave >= this.maxWaves) {
      this.triggerVictory();
    }
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

    // Passive stat modifiers are owned by the card system (src/core/cards.js),
    // which reads them live rather than baking them into player stats here.
    this.bus.emit('card:selected', { cardId, level: newLevel });
    return true;
  }

  /**
   * Open a card draft, freezing the run until a choice is made.
   * @param {Array<string>} cardIds - Cards on offer
   */
  offerDraft(cardIds) {
    if (!cardIds || cardIds.length === 0) return false;

    this.pendingDraft = [...cardIds];
    this.stateBeforeDraft = this.currentState;
    this.currentState = GAME_STATES.LEVEL_UP;
    this.bus.emit('draft:offer', {
      cards: this.pendingDraft,
      level: this.player.level,
    });
    return true;
  }

  /**
   * Take a card from the open draft and resume whatever was running before.
   * @param {string} cardId - Must be one of the offered cards
   * @returns {boolean} Whether the choice was accepted
   */
  chooseCard(cardId) {
    if (this.currentState !== GAME_STATES.LEVEL_UP) return false;
    if (!this.pendingDraft || !this.pendingDraft.includes(cardId)) return false;
    if (!this.selectCard(cardId)) return false;

    this.pendingDraft = null;
    this.currentState = this.stateBeforeDraft ?? GAME_STATES.RUNNING;
    this.stateBeforeDraft = null;
    this.bus.emit('draft:choice', {
      cardId,
      level: this.activeCards.get(cardId),
    });
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
   * Record an enemy kill and its score contribution
   * @param {number} [scoreValue] - Points awarded for the kill
   */
  registerKill(scoreValue = 0) {
    this.kills += 1;
    this.score += scoreValue;
    this.bus.emit('enemy:killed', { kills: this.kills, score: this.score });
  }

  /**
   * Trigger Victory state — the run's final wave was cleared alive
   */
  triggerVictory() {
    this.currentState = GAME_STATES.VICTORY;
    this.bus.emit('game:victory', {
      wave: this.wave,
      score: this.score,
      kills: this.kills,
      level: this.player.level,
    });
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
