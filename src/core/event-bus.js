/**
 * Pure JS EventBus implementation for BloomWake core simulation logic.
 * Zero DOM / window dependencies to ensure 100% pure Node testability.
 */
export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Listener function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Event callback must be a function');
    }
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);

    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event once
   * @param {string} event - Event name
   * @param {Function} callback - Listener function
   */
  once(event, callback) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      callback(...args);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Listener function to remove
   */
  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const list = this.listeners.get(event);
    const index = list.indexOf(callback);
    if (index !== -1) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Emit an event with data
   * @param {string} event - Event name
   * @param {*} [data] - Event payload
   */
  emit(event, data) {
    if (!this.listeners.has(event)) return;
    const list = [...this.listeners.get(event)];
    for (const callback of list) {
      try {
        callback(data);
      } catch (err) {
        console.error(`[EventBus] Error in listener for event "${event}":`, err);
      }
    }
  }

  /**
   * Clear all event listeners or listeners for a specific event
   * @param {string} [event] - Optional event name
   */
  clear(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

/**
 * Canonical event names.
 *
 * Every name here was already in use as a string literal; this catalog does not
 * rename anything, it just gives the strings one home so a typo becomes a
 * missing import instead of a listener that silently never fires.
 *
 * ANIMATION_STATE is the Phase 7 addition: core decides which semantic
 * animation state an entity is in and announces it here. The payload is
 * `{ entityId, state, previous }` and deliberately carries no frame index, no
 * sheet coordinate and no fps — core does not know those things exist.
 */
export const EVENTS = {
  ANIMATION_STATE: 'animation:state',

  STATE_CHANGE: 'state:change',
  STATE_RESET: 'state:reset',

  WAVE_START: 'wave:start',
  WAVE_COMPLETE: 'wave:complete',

  PLAYER_DAMAGE: 'player:damage',
  PLAYER_LEVEL_UP: 'player:level_up',
  PLAYER_XP_GAIN: 'player:xp_gain',

  ENEMY_DAMAGED: 'enemy:damaged',
  ENEMY_DEATH: 'enemy:death',
  ENEMY_KILLED: 'enemy:killed',

  BOSS_SPAWNED: 'boss:spawned',
  BOSS_TELEGRAPH_START: 'boss:telegraph_start',
  BOSS_TELEGRAPH_ERUPT: 'boss:telegraph_erupt',

  WEAPON_FIRE: 'weapon:fire',
  CARD_SELECTED: 'card:selected',

  DRAFT_OFFER: 'draft:offer',
  DRAFT_CHOICE: 'draft:choice',

  ORB_COLLECTED: 'orb:collected',
  GAME_OVER: 'game:over',
  GAME_VICTORY: 'game:victory',
};

// Global default singleton instance
export const globalBus = new EventBus();
