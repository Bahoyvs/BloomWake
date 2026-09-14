/**
 * Trauma-based screen shake (Phase 6).
 *
 * Shake is driven by a single 0..1 "trauma" value that decays continuously.
 * Offset scales with trauma SQUARED, which is what stops the screen from
 * jittering constantly during ordinary play: small hits produce almost no
 * movement while a boss eruption is unmistakable.
 *
 * Pure maths plus a deterministic-enough noise source; no DOM, no canvas.
 */

/** Trauma added per event kind. Tuned so routine hits stay near-invisible. */
export const TRAUMA = {
  ENEMY_HIT: 0.05,
  PLAYER_DAMAGE: 0.35,
  AOE_PULSE: 0.12,
  TIDEWAVE: 0.2,
  BOSS_SPAWN: 0.55,
  BOSS_ERUPT: 0.7,
  LEVEL_UP: 0.15,
  DEATH: 0.9,
};

export class ScreenShake {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxOffset] - Peak translation in px
   * @param {number} [options.maxRotation] - Peak rotation in radians
   * @param {number} [options.decay] - Trauma lost per second
   */
  constructor({ maxOffset = 26, maxRotation = 0.022, decay = 1.6, intensity = 1 } = {}) {
    this.maxOffset = maxOffset;
    this.maxRotation = maxRotation;
    this.decay = decay;

    /**
     * Player-facing intensity multiplier, from the accessibility settings.
     *
     * Scales the OUTPUT rather than the trauma, and that distinction matters:
     * trauma also drives how long the effect lasts, so damping it at the
     * source would make a player on Light spend less time shaken as well as
     * shaking less — the camera would settle at a different moment than
     * everybody else's. Scaling the offsets keeps the timing identical at
     * every setting and changes only the amplitude, which is the thing being
     * asked for.
     */
    this.intensity = intensity;

    this.trauma = 0;
    this.time = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.rotation = 0;
  }

  /**
   * Add trauma. Saturates at 1 so stacked events cannot produce nausea.
   * @param {number} amount
   */
  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);

    if (this.trauma <= 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.rotation = 0;
      return;
    }

    // Squared response: quiet at low trauma, dramatic at high.
    const magnitude = this.trauma * this.trauma * this.intensity;
    // Three different frequencies keep the motion from looking like a loop.
    this.offsetX = this.maxOffset * magnitude * noise(this.time * 31.7);
    this.offsetY = this.maxOffset * magnitude * noise(this.time * 27.3 + 100);
    this.rotation = this.maxRotation * magnitude * noise(this.time * 19.1 + 200);
  }

  /**
   * @param {number} value - 0 (off) to 1 (full)
   */
  setIntensity(value) {
    this.intensity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    // Settling the camera immediately matters: a player turning shake off
    // mid-eruption is doing it BECAUSE the screen is moving, and waiting for
    // the trauma to decay would leave it moving for another second.
    if (this.intensity === 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.rotation = 0;
    }
  }

  /**
   * Apply the shake to a canvas context. Caller is responsible for save/restore.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} pivotX - Screen-space pivot, usually the viewport centre
   * @param {number} pivotY
   */
  apply(ctx, pivotX, pivotY) {
    if (this.trauma <= 0) return;

    ctx.translate(pivotX + this.offsetX, pivotY + this.offsetY);
    ctx.rotate(this.rotation);
    ctx.translate(-pivotX, -pivotY);
  }

  reset() {
    this.trauma = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.rotation = 0;
  }
}

/**
 * Smooth pseudo-noise in [-1, 1]. Cheap, deterministic, and continuous, which
 * matters — sampling white noise per frame would look like static rather than
 * a camera being knocked around.
 * @param {number} t
 * @returns {number}
 */
function noise(t) {
  return Math.sin(t) * 0.6 + Math.sin(t * 2.13 + 1.7) * 0.3 + Math.sin(t * 4.07 + 0.3) * 0.1;
}
