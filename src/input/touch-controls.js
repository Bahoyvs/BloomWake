/**
 * Touch movement for BloomWake — a floating, dynamic virtual joystick.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STICK FLOATS INSTEAD OF SITTING IN A FIXED CORNER
 * ---------------------------------------------------------------------------
 * A fixed on-screen pad demands the player look at their thumb to find it. A
 * survivor-arena asks the opposite: eyes on the swarm, never on the controls.
 * So the base is spawned wherever the thumb lands in the left zone and the
 * vector is measured from THAT point. The player never misses the stick,
 * because the stick is defined by where they pressed.
 *
 * ---------------------------------------------------------------------------
 * THE MATH IS SEPARATE FROM THE DOM, AND DELIBERATELY SO
 * ---------------------------------------------------------------------------
 * `computeJoystickVector` is a pure function of two deltas. Everything that can
 * be wrong about a joystick — a deadzone that snaps, a diagonal that travels
 * faster than a cardinal, a magnitude that exceeds 1 and outruns the balance
 * envelope — is wrong inside that function, and it is testable in Node with no
 * browser and no fake events. `TouchControls` below is only pointer plumbing.
 *
 * ---------------------------------------------------------------------------
 * MULTI-TOUCH IS THE WHOLE PROBLEM, NOT A DETAIL
 * ---------------------------------------------------------------------------
 * The failure this module exists to prevent: the player is holding a direction
 * with the left thumb, taps the skill socket with the right, and the ship
 * stops. It happens when a handler treats "a pointer went up" as "the stick was
 * released". Every handler here is gated on `pointerId` matching the one that
 * opened the stick, so a second, third or fourth finger anywhere on the screen
 * is simply not this module's event.
 *
 * The right-hand controls are NOT reimplemented here. The HUD already ships a
 * skill socket that casts on `pointerdown` and draws its own cooldown sweep,
 * and a second button in the same corner would overlap it. This module owns the
 * left thumb; hud.js owns the right.
 */

import './touch-controls.css';

/**
 * Stick geometry, in CSS pixels.
 *
 * RADIUS is the throw — the distance at which the stick reads full speed. 60px
 * is about the arc a thumb covers without the hand shifting on the phone.
 *
 * DEADZONE is the slop around the press point that reads as "no input". A
 * thumb resting on glass drifts a few pixels; without this the ship creeps
 * while the player is holding still. 8px is under the drift a stationary thumb
 * produces and well under an intentional push.
 */
export const JOYSTICK = {
  RADIUS: 60,
  DEADZONE: 8,
  KNOB_RADIUS: 24,
};

/**
 * How much of the screen width opens a stick.
 *
 * 55% rather than 50%: the right-hand controls are anchored in the bottom-right
 * corner, so the dead strip between the zones costs nothing on that side, while
 * a left-handed-ish grip that lands slightly past centre still steers.
 */
export const JOYSTICK_ZONE_RATIO = 0.55;

/**
 * Whether this device can produce touches at all.
 *
 * Deliberately a capability check and not a user-agent sniff: a Surface and a
 * touchscreen laptop both answer true and both should get the stick if the
 * player uses their finger. Nothing here disables the keyboard — the two input
 * paths are summed, so a tablet with a keyboard case drives either.
 *
 * @param {Window|Object} [win]
 * @returns {boolean}
 */
export function isTouchDevice(win = globalThis) {
  if (!win) return false;
  return 'ontouchstart' in win || (win.navigator?.maxTouchPoints ?? 0) > 0;
}

/**
 * Turn a drag delta into a direction vector.
 *
 * The magnitude is re-mapped from the band BEYOND the deadzone rather than
 * measured from the press point. Measuring from the press point makes the
 * stick jump to `deadzone / radius` speed the instant it crosses the threshold,
 * which on an 8/60 stick is a 13% lurch out of a standstill. Re-mapping means
 * the first pixel past the deadzone produces the first sliver of throttle.
 *
 * The vector is clamped to length 1, never scaled to it: a thumb pushed past
 * the throw is full speed, not more, and — because direction and magnitude are
 * derived separately from the same unit vector — a diagonal is exactly as fast
 * as a cardinal. A raw `{x, y}` delta passed to the simulation would make
 * diagonals 1.41x faster, which is the oldest bug in twin-stick movement.
 *
 * `knobX`/`knobY` are the thumb's position for the renderer, clamped to the
 * ring. They travel linearly with the finger and ignore the deadzone remap, so
 * the knob tracks the thumb exactly even where the ship is not yet moving.
 *
 * @param {number} dx - Pointer x minus the press-point x
 * @param {number} dy - Pointer y minus the press-point y
 * @param {Object} [opts]
 * @param {number} [opts.radius] - Full-throw distance
 * @param {number} [opts.deadzone] - Slop radius that reads as no input
 * @returns {{x: number, y: number, magnitude: number, knobX: number, knobY: number}}
 */
export function computeJoystickVector(dx, dy, opts = {}) {
  const radius = opts.radius ?? JOYSTICK.RADIUS;
  const deadzone = opts.deadzone ?? JOYSTICK.DEADZONE;
  const distance = Math.hypot(dx, dy);

  if (!(distance > deadzone)) {
    // NaN deltas land here too, via the negated comparison. A pointer event
    // with a junk coordinate should park the ship, not steer it somewhere.
    return { x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 };
  }

  const ux = dx / distance;
  const uy = dy / distance;
  // The band can be degenerate if a caller passes deadzone >= radius; treat
  // that as a digital stick rather than dividing by zero.
  const band = radius - deadzone;
  const magnitude = band > 0 ? Math.min((distance - deadzone) / band, 1) : 1;
  const knobDistance = Math.min(distance, radius);

  return {
    x: ux * magnitude,
    y: uy * magnitude,
    magnitude,
    knobX: ux * knobDistance,
    knobY: uy * knobDistance,
  };
}

/** The neutral vector, returned whenever no stick is open. */
const ZERO = Object.freeze({ x: 0, y: 0, magnitude: 0 });

export class TouchControls {
  /**
   * @param {HTMLElement} host - Container the joystick layer is appended to
   * @param {HTMLElement} surface - Element whose presses open a stick (the canvas)
   * @param {Object} [options]
   * @param {Window} [options.win]
   */
  constructor(host, surface, options = {}) {
    this.win = options.win ?? window;
    // Off the host rather than the global, so the class can be driven by a
    // stubbed node under Node. Every real Element carries `ownerDocument`.
    this.doc = host.ownerDocument ?? globalThis.document;
    this.surface = surface;
    this.enabled = false;

    /**
     * The pointer that owns the stick, or null.
     *
     * This single field is the entire multi-touch guard. Every move, up and
     * cancel handler compares against it before doing anything, so no other
     * finger on the glass can move, release or re-centre the stick.
     */
    this.pointerId = null;
    this.originX = 0;
    this.originY = 0;
    this.vector = { x: 0, y: 0, magnitude: 0 };

    this.layer = this.doc.createElement('div');
    this.layer.className = 'tjoy-layer';
    this.layer.innerHTML = `
      <div class="tjoy" data-tjoy="root" hidden>
        <div class="tjoy__ring" data-tjoy="ring"></div>
        <div class="tjoy__knob" data-tjoy="knob"></div>
      </div>
    `;
    host.appendChild(this.layer);

    this.root = this.layer.querySelector('[data-tjoy="root"]');
    this.knob = this.layer.querySelector('[data-tjoy="knob"]');

    this.onPointerDown = (event) => this.handleDown(event);
    this.onPointerMove = (event) => this.handleMove(event);
    this.onPointerUp = (event) => this.handleUp(event);

    this.surface.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    // Move and up go on the window, not the surface: a thumb that slides off
    // the canvas onto the HUD must keep steering, and a finger lifted outside
    // the surface must still release the stick rather than leaving it latched.
    this.win.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.win.addEventListener('pointerup', this.onPointerUp);
    this.win.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Open or close the stick for input.
   *
   * Driven by the run's state: a press on the menu's backdrop must not spawn a
   * joystick over the console. Disabling always releases, so pausing mid-drag
   * cannot leave the ship thrusting into the pause panel.
   *
   * @param {boolean} on
   */
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.release();
  }

  handleDown(event) {
    if (!this.enabled || this.pointerId !== null) return;
    if (event.pointerType === 'mouse') return;

    const rect = this.surface.getBoundingClientRect();
    if (event.clientX - rect.left > rect.width * JOYSTICK_ZONE_RATIO) return;

    event.preventDefault();
    this.pointerId = event.pointerId;
    this.originX = event.clientX;
    this.originY = event.clientY;
    this.vector = { x: 0, y: 0, magnitude: 0 };

    this.root.style.left = `${event.clientX}px`;
    this.root.style.top = `${event.clientY}px`;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.root.hidden = false;
  }

  handleMove(event) {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();

    const next = computeJoystickVector(
      event.clientX - this.originX,
      event.clientY - this.originY
    );
    this.vector = { x: next.x, y: next.y, magnitude: next.magnitude };
    this.knob.style.transform = `translate(calc(-50% + ${next.knobX}px), calc(-50% + ${next.knobY}px))`;
  }

  handleUp(event) {
    if (event.pointerId !== this.pointerId) return;
    this.release();
  }

  /** Drop the stick and park the ship. Safe to call when nothing is held. */
  release() {
    this.pointerId = null;
    this.vector = { x: 0, y: 0, magnitude: 0 };
    if (this.root) this.root.hidden = true;
  }

  /** @returns {boolean} Whether a finger is currently steering. */
  get isActive() {
    return this.pointerId !== null;
  }

  /**
   * Current direction, magnitude 0..1.
   * @returns {{x: number, y: number, magnitude: number}}
   */
  getDirection() {
    return this.pointerId === null ? ZERO : this.vector;
  }

  destroy() {
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.win.removeEventListener('pointermove', this.onPointerMove);
    this.win.removeEventListener('pointerup', this.onPointerUp);
    this.win.removeEventListener('pointercancel', this.onPointerUp);
    this.layer.remove();
  }
}
