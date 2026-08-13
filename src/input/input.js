/**
 * Keyboard input for BloomWake (desktop).
 * Mobile floating joystick arrives in Phase 7 — this module is the seam where
 * it plugs in: anything producing a {x, y} direction satisfies the simulation.
 */

const MOVE_KEYS = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Draft picks. A 4th slot exists for the Phase 5 meta-upgrade. */
const SLOT_KEYS = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
};

export class KeyboardInput {
  /**
   * @param {Object} [handlers]
   * @param {() => void} [handlers.onConfirm] - Enter/Space: start or restart
   * @param {() => void} [handlers.onPause] - Escape/P
   * @param {(index: number) => void} [handlers.onSlot] - Digit keys 1-4, zero-based
   * @param {EventTarget} [target]
   */
  constructor(handlers = {}, target = window) {
    this.pressed = new Set();
    this.handlers = handlers;
    this.target = target;

    this.onKeyDown = (event) => {
      if (event.repeat) return;

      if (MOVE_KEYS[event.code]) {
        this.pressed.add(event.code);
        event.preventDefault();
        return;
      }
      if (event.code === 'Enter' || event.code === 'Space') {
        this.handlers.onConfirm?.();
        event.preventDefault();
        return;
      }
      const slot = SLOT_KEYS[event.code];
      if (slot !== undefined) {
        this.handlers.onSlot?.(slot);
        event.preventDefault();
        return;
      }
      if (event.code === 'Escape' || event.code === 'KeyP') {
        this.handlers.onPause?.();
        event.preventDefault();
      }
    };

    this.onKeyUp = (event) => this.pressed.delete(event.code);
    // Keys held while the tab loses focus would otherwise stick down.
    this.onBlur = () => this.pressed.clear();

    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  /**
   * Current movement direction (unnormalized; the simulation normalizes).
   * @returns {{x: number, y: number}}
   */
  getDirection() {
    let x = 0;
    let y = 0;
    for (const code of this.pressed) {
      const vec = MOVE_KEYS[code];
      if (vec) {
        x += vec[0];
        y += vec[1];
      }
    }
    return { x, y };
  }

  destroy() {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }
}
