/**
 * Touch control tests.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE ACTUALLY GUARDING
 * ---------------------------------------------------------------------------
 * Two things, and they fail in completely different ways.
 *
 * The vector math is a balance contract. A stick that can return a vector
 * longer than 1 lets a phone player outrun the speed cap the whole game is
 * tuned against, and a stick whose diagonals are 1.41x its cardinals is the
 * oldest bug in twin-stick movement — both are silent, and neither shows up as
 * anything but "mobile feels different".
 *
 * The pointer bookkeeping is a correctness contract. The failure it prevents is
 * specific and reproducible: hold a direction with the left thumb, tap the
 * skill socket with the right, and the ship stops dead. It happens whenever a
 * handler treats "a pointer went up" as "the stick was released". That is the
 * `pointerId` guard, and the multi-touch block below is a direct reproduction
 * of the gesture that used to break it.
 *
 * `computeJoystickVector` is pure and needs no browser. `TouchControls` does,
 * so the DOM it touches is faked to the handful of properties it actually
 * reads — enough to drive the real handlers, and not a jsdom dependency for one
 * file in a suite that otherwise runs in Node.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  JOYSTICK,
  JOYSTICK_ZONE_RATIO,
  TouchControls,
  computeJoystickVector,
  isTouchDevice,
} from '../src/input/touch-controls.js';

/* Vite resolves the stylesheet import in the module under test; Vitest does
   not, so it is stubbed to nothing. */
vi.mock('../src/input/touch-controls.css', () => ({}));

const { RADIUS, DEADZONE } = JOYSTICK;

describe('computeJoystickVector', () => {
  it('is neutral inside the deadzone', () => {
    for (const [dx, dy] of [[0, 0], [3, 0], [0, -5], [5, 5]]) {
      const v = computeJoystickVector(dx, dy);
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(DEADZONE);
      expect(v).toEqual({ x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 });
    }
  });

  it('is neutral exactly on the deadzone boundary', () => {
    // The boundary belongs to the deadzone, not to the live band. A thumb
    // resting precisely at 8px must park the ship rather than creep.
    expect(computeJoystickVector(DEADZONE, 0).magnitude).toBe(0);
  });

  it('ramps from zero rather than snapping as it leaves the deadzone', () => {
    /*
     * The regression this pins: measuring magnitude from the press point rather
     * than from the deadzone edge makes the stick jump straight to
     * DEADZONE/RADIUS — 13% throttle on an 8/60 stick — the instant it crosses.
     * The ship lurches out of a standstill and fine positioning is impossible.
     */
    const justPast = computeJoystickVector(DEADZONE + 0.5, 0);
    expect(justPast.magnitude).toBeGreaterThan(0);
    expect(justPast.magnitude).toBeLessThan(0.02);
  });

  it('reaches exactly full throw at the ring', () => {
    const v = computeJoystickVector(RADIUS, 0);
    expect(v.magnitude).toBeCloseTo(1, 10);
    expect(v.x).toBeCloseTo(1, 10);
  });

  it('clamps beyond the ring instead of scaling past it', () => {
    const v = computeJoystickVector(RADIUS * 8, RADIUS * 8);
    expect(v.magnitude).toBe(1);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 10);
  });

  it('never returns a vector longer than 1, in any direction', () => {
    // The speed-cap contract, swept rather than spot-checked: the simulation
    // multiplies this straight into velocity.
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      for (const dist of [0, 4, 8, 12, 30, 59, 60, 61, 400]) {
        const v = computeJoystickVector(Math.cos(rad) * dist, Math.sin(rad) * dist);
        expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('gives a diagonal the same speed as a cardinal', () => {
    /*
     * A raw {dx, dy} delta would make this 1.41x the cardinal. The direction
     * and the magnitude are derived from the same unit vector precisely so that
     * distance travelled depends on how far the thumb is pushed and not on
     * which way it is pointed.
     */
    const diagonal = (RADIUS * Math.SQRT1_2);
    const cardinal = computeJoystickVector(RADIUS, 0);
    const diag = computeJoystickVector(diagonal, diagonal);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(Math.hypot(cardinal.x, cardinal.y), 10);
  });

  it('points where the thumb pushed', () => {
    const up = computeJoystickVector(0, -RADIUS);
    expect(up.x).toBeCloseTo(0, 10);
    expect(up.y).toBeCloseTo(-1, 10);

    const left = computeJoystickVector(-RADIUS, 0);
    expect(left.x).toBeCloseTo(-1, 10);
    expect(left.y).toBeCloseTo(0, 10);
  });

  it('clamps the knob to the ring while tracking the thumb inside it', () => {
    // The knob ignores the deadzone remap on purpose: it must sit under the
    // finger even where the ship is not yet moving.
    const inside = computeJoystickVector(20, 0);
    expect(inside.knobX).toBeCloseTo(20, 10);

    const outside = computeJoystickVector(500, 0);
    expect(outside.knobX).toBeCloseTo(RADIUS, 10);
  });

  it('honours caller-supplied geometry', () => {
    const v = computeJoystickVector(50, 0, { radius: 100, deadzone: 0 });
    expect(v.magnitude).toBeCloseTo(0.5, 10);
  });

  it('parks the ship on a junk coordinate rather than steering somewhere', () => {
    // A NaN delta reaching the velocity integrator poisons the player position
    // permanently — there is no frame that recovers from it.
    const v = computeJoystickVector(NaN, NaN);
    expect(v).toEqual({ x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 });
  });

  it('treats a degenerate deadzone as a digital stick instead of dividing by zero', () => {
    const v = computeJoystickVector(30, 0, { radius: 10, deadzone: 10 });
    expect(v.magnitude).toBe(1);
    expect(Number.isFinite(v.x)).toBe(true);
  });
});

describe('isTouchDevice', () => {
  const media = (matches) => ({ matchMedia: () => ({ matches }) });

  it('detects the three ways a browser reports touch', () => {
    expect(isTouchDevice({ ontouchstart: null, navigator: {} })).toBe(true);
    expect(isTouchDevice({ navigator: { maxTouchPoints: 5 } })).toBe(true);
    // The coarse-pointer probe is the one that carries DevTools device mode and
    // the Android WebViews that report maxTouchPoints: 0.
    expect(isTouchDevice({ navigator: { maxTouchPoints: 0 }, ...media(true) })).toBe(true);
  });

  it('is false for a plain mouse-only window', () => {
    expect(isTouchDevice({ navigator: { maxTouchPoints: 0 }, ...media(false) })).toBe(false);
    expect(isTouchDevice({ navigator: {} })).toBe(false);
    expect(isTouchDevice(null)).toBe(false);
  });

  it('survives a window with no matchMedia, or one that throws', () => {
    // Detection runs during boot; an exception here takes the whole game down
    // rather than costing a joystick.
    expect(isTouchDevice({ navigator: {} })).toBe(false);
    expect(
      isTouchDevice({
        navigator: {},
        matchMedia() {
          throw new Error('unsupported query');
        },
      })
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Pointer plumbing                                                          */
/* ------------------------------------------------------------------------ */

/** A DOM node stubbed to exactly what TouchControls reads off it. */
function fakeElement() {
  const listeners = new Map();
  return {
    listeners,
    style: {},
    hidden: true,
    children: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {},
  };
}

/**
 * Stand up a TouchControls over a fake 800x400 surface.
 *
 * The class reaches for its document through `host.ownerDocument`, so handing
 * it a stubbed host is the whole of the setup — no global patching, and no
 * jsdom for the one file in the suite that touches the DOM. Everything below
 * the seam is the real class, including every handler under test.
 */
function mountControls() {
  const root = fakeElement();
  const knob = fakeElement();
  const layer = fakeElement();
  layer.querySelector = (sel) => (sel.includes('root') ? root : knob);

  const host = fakeElement();
  host.ownerDocument = { createElement: () => layer };

  const surface = fakeElement();
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 400 });

  const win = fakeElement();
  const controls = new TouchControls(host, surface, { win });
  controls.setEnabled(true);

  return { controls, surface, win, root, knob };
}

/** A PointerEvent stubbed to the fields the handlers read. */
function pointer(id, x, y, type = 'touch') {
  return { pointerId: id, clientX: x, clientY: y, pointerType: type, preventDefault() {} };
}

describe('TouchControls', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens a stick anchored at the press point and steers from it', () => {
    const { controls, surface, win } = mountControls();

    surface.dispatch('pointerdown', pointer(1, 100, 200));
    expect(controls.isActive).toBe(true);
    // Anchored, not centred on a fixed pad: the vector is zero until the thumb
    // actually travels, however far from the screen's middle it landed.
    expect(controls.getDirection()).toMatchObject({ x: 0, y: 0 });

    win.dispatch('pointermove', pointer(1, 100 + RADIUS, 200));
    expect(controls.getDirection().x).toBeCloseTo(1, 10);
  });

  it('ignores presses in the right-hand zone', () => {
    const { controls, surface } = mountControls();
    // 800 * 0.55 = 440; 500 is the skill socket's half of the screen.
    surface.dispatch('pointerdown', pointer(1, 500, 200));
    expect(controls.isActive).toBe(false);
  });

  it('claims a press exactly on the zone boundary', () => {
    const { controls, surface } = mountControls();
    surface.dispatch('pointerdown', pointer(1, 800 * JOYSTICK_ZONE_RATIO, 200));
    expect(controls.isActive).toBe(true);
  });

  it('ignores a mouse, so a desktop reporting touch support is unaffected', () => {
    const { controls, surface } = mountControls();
    surface.dispatch('pointerdown', pointer(1, 100, 200, 'mouse'));
    expect(controls.isActive).toBe(false);
  });

  it('does nothing until enabled', () => {
    const { controls, surface } = mountControls();
    controls.setEnabled(false);
    surface.dispatch('pointerdown', pointer(1, 100, 200));
    expect(controls.isActive).toBe(false);
  });

  it('releases and parks the ship when disabled mid-drag', () => {
    // Pausing mid-drag must not leave the vector latched — the next resume would
    // start the ship already thrusting.
    const { controls, surface, win } = mountControls();
    surface.dispatch('pointerdown', pointer(1, 100, 200));
    win.dispatch('pointermove', pointer(1, 160, 200));
    expect(controls.getDirection().magnitude).toBe(1);

    controls.setEnabled(false);
    expect(controls.isActive).toBe(false);
    expect(controls.getDirection()).toMatchObject({ x: 0, y: 0, magnitude: 0 });
  });

  it('resets cleanly to zero on release', () => {
    const { controls, surface, win } = mountControls();
    surface.dispatch('pointerdown', pointer(1, 100, 200));
    win.dispatch('pointermove', pointer(1, 100, 100));
    expect(controls.getDirection().y).toBeCloseTo(-1, 10);

    win.dispatch('pointerup', pointer(1, 100, 100));
    expect(controls.isActive).toBe(false);
    expect(controls.getDirection()).toMatchObject({ x: 0, y: 0, magnitude: 0 });
  });

  it('releases on pointercancel, which is how a system gesture steals the touch', () => {
    const { controls, surface, win } = mountControls();
    surface.dispatch('pointerdown', pointer(1, 100, 200));
    win.dispatch('pointercancel', pointer(1, 100, 200));
    expect(controls.isActive).toBe(false);
  });

  describe('multi-touch isolation', () => {
    it('keeps steering while a second finger taps the skill side', () => {
      /*
       * THE regression. Left thumb holds north, right thumb taps the socket,
       * and a naive handler reads the second finger's up as a release and
       * stops the ship mid-dodge.
       */
      const { controls, surface, win } = mountControls();

      surface.dispatch('pointerdown', pointer(1, 100, 200));
      win.dispatch('pointermove', pointer(1, 100, 140));
      const steering = { ...controls.getDirection() };
      expect(steering.y).toBeCloseTo(-1, 10);

      // The whole life of a second finger, over on the right.
      surface.dispatch('pointerdown', pointer(2, 700, 350));
      win.dispatch('pointermove', pointer(2, 705, 352));
      win.dispatch('pointerup', pointer(2, 705, 352));

      expect(controls.isActive).toBe(true);
      expect(controls.getDirection()).toMatchObject(steering);
    });

    it('ignores a second finger that lands inside the joystick zone too', () => {
      // A palm or a stray finger on the left half must not re-anchor the stick
      // the player is already holding.
      const { controls, surface, win } = mountControls();

      surface.dispatch('pointerdown', pointer(1, 100, 200));
      win.dispatch('pointermove', pointer(1, 160, 200));
      expect(controls.getDirection().x).toBeCloseTo(1, 10);

      surface.dispatch('pointerdown', pointer(2, 300, 100));
      // Still owned by pointer 1, and still anchored where pointer 1 pressed.
      win.dispatch('pointermove', pointer(2, 300, 400));
      expect(controls.getDirection().x).toBeCloseTo(1, 10);
      expect(controls.getDirection().y).toBeCloseTo(0, 10);
    });

    it('hands the stick to a new finger only once the owner has lifted', () => {
      const { controls, surface, win } = mountControls();

      surface.dispatch('pointerdown', pointer(1, 100, 200));
      surface.dispatch('pointerdown', pointer(2, 300, 100));
      win.dispatch('pointerup', pointer(1, 100, 200));
      expect(controls.isActive).toBe(false);

      // Pointer 2 was never the owner, so its own lift is a no-op rather than a
      // second release.
      win.dispatch('pointerup', pointer(2, 300, 100));
      expect(controls.isActive).toBe(false);

      surface.dispatch('pointerdown', pointer(3, 200, 200));
      expect(controls.isActive).toBe(true);
    });

    it('ignores moves from fingers that never opened a stick', () => {
      const { controls, win } = mountControls();
      win.dispatch('pointermove', pointer(9, 400, 400));
      expect(controls.isActive).toBe(false);
      expect(controls.getDirection()).toMatchObject({ x: 0, y: 0 });
    });
  });

  it('unbinds every listener on destroy', () => {
    const { controls, surface, win } = mountControls();
    controls.destroy();
    expect(surface.listeners.get('pointerdown').size).toBe(0);
    expect(win.listeners.get('pointermove').size).toBe(0);
    expect(win.listeners.get('pointerup').size).toBe(0);
    expect(win.listeners.get('pointercancel').size).toBe(0);
  });
});
