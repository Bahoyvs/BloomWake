/**
 * Particle system on pooled PIXI sprites (Phase 6b).
 *
 * Rewritten from the Phase 6 immediate-mode canvas version. Every particle is
 * now a Sprite drawn from `bubble_particle.png` or `lens_flare.png`, recycled
 * through an object pool and parked (visible = false) rather than destroyed —
 * a 200-enemy wipe must not allocate or touch the display list structure.
 *
 * Still purely decorative and still outside src/core/: particles never feed
 * back into the simulation.
 */

import { Container } from 'pixi.js';
import { ObjectPool } from '../core/pool.js';
import { ASSET_KEYS } from '../core/assets.js';
import { makeSprite, hexToPixi, NO_TINT } from './sprites.js';
import { THEME } from './theme.js';

export const PARTICLE_KINDS = {
  /** Fast streak sprayed on an enemy hit. */
  SPARK: 'spark',
  /** Slow drifting mote — Frutevil dissolving. */
  MOTE: 'mote',
  /** Rising Aero bubble for pickups and level-ups. */
  BUBBLE: 'bubble',
  /** Expanding flare ring for big moments. */
  RING: 'ring',
};

/** Hard ceiling: decoration must never be why a frame drops. */
const MAX_PARTICLES = 420;

export class ParticleSystem {
  /**
   * @param {import('../core/assets.js').AssetStore} assets
   */
  constructor(assets) {
    this.assets = assets;
    /** Added to the renderer's particle layer. */
    this.container = new Container();
    this.particles = [];

    this.pool = new ObjectPool(() => this.createParticle(), 160);
  }

  /** Pool factory: a parked sprite plus its motion state. */
  createParticle() {
    const sprite = makeSprite(this.assets.get(ASSET_KEYS.BUBBLE_PARTICLE));
    sprite.visible = false;
    this.container.addChild(sprite);

    return {
      sprite,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 1,
      size: 1,
      growth: 0,
      drag: 0.9,
      kind: PARTICLE_KINDS.SPARK,
      alive: false,
    };
  }

  /**
   * @param {Object} spec
   * @returns {Object|null} null when the budget is full
   */
  spawn(spec) {
    if (this.particles.length >= MAX_PARTICLES) return null;

    const p = this.pool.acquire();
    p.x = spec.x;
    p.y = spec.y;
    p.vx = spec.vx ?? 0;
    p.vy = spec.vy ?? 0;
    p.life = spec.life ?? 0.4;
    p.maxLife = p.life;
    p.size = spec.size ?? 3;
    p.growth = spec.growth ?? 0;
    p.drag = spec.drag ?? 0.9;
    p.kind = spec.kind ?? PARTICLE_KINDS.SPARK;
    p.alive = true;

    const flare = p.kind === PARTICLE_KINDS.RING;
    const texture = this.assets.get(
      flare ? ASSET_KEYS.LENS_FLARE : ASSET_KEYS.BUBBLE_PARTICLE
    );
    if (texture) p.sprite.texture = texture;

    p.sprite.visible = true;
    p.sprite.tint = spec.tint ?? NO_TINT;
    p.sprite.alpha = 1;
    p.sprite.rotation = 0;
    this.applyTransform(p, 1);

    this.particles.push(p);
    return p;
  }

  /**
   * Position/scale a particle for its current life fraction.
   * @param {Object} p
   * @param {number} t - Remaining life, 1 -> 0
   */
  applyTransform(p, t) {
    const sprite = p.sprite;
    sprite.x = p.x;
    sprite.y = p.y;

    const source = Math.max(sprite.texture?.width || 1, 1);
    const diameter =
      p.kind === PARTICLE_KINDS.RING
        ? (p.size + p.growth * (1 - t)) * 2
        : p.size * (p.kind === PARTICLE_KINDS.BUBBLE ? t : 1) * 2;

    sprite.scale.set(Math.max(diameter, 0.01) / source);

    if (p.kind === PARTICLE_KINDS.SPARK) {
      sprite.rotation = Math.atan2(p.vy, p.vx);
      // Stretch along travel so it reads as speed rather than confetti.
      sprite.scale.x *= 2.4;
    }
  }

  /**
   * Spray on an enemy hit.
   * @param {number} x
   * @param {number} y
   * @param {string} color - Hex string
   * @param {number} [count]
   */
  burst(x, y, color, count = 5) {
    const tint = hexToPixi(color);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 110;
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.22 + Math.random() * 0.2,
        size: 2 + Math.random() * 2.5,
        tint,
        kind: PARTICLE_KINDS.SPARK,
      });
    }
  }

  /**
   * Frutevil dissolving: dark motes plus a rim flash.
   * @param {number} x
   * @param {number} y
   * @param {{fill: string, rim: string}} palette
   * @param {number} [radius]
   */
  death(x, y, palette, radius = 12) {
    const fillTint = hexToPixi(palette.fill);
    for (let i = 0; i < 7; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 70;
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 20,
        life: 0.36 + Math.random() * 0.3,
        size: 2 + Math.random() * radius * 0.3,
        tint: fillTint,
        kind: PARTICLE_KINDS.MOTE,
        drag: 0.86,
      });
    }
    this.ring(x, y, radius * 2.4, palette.rim);
  }

  /**
   * Rising bubbles off a pickup or level-up.
   * @param {number} x
   * @param {number} y
   * @param {string} [color]
   * @param {number} [count]
   */
  bubbles(x, y, color = THEME.pickup.orb, count = 4) {
    const tint = hexToPixi(color);
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 14,
        y,
        vx: (Math.random() - 0.5) * 26,
        vy: -50 - Math.random() * 70,
        life: 0.5 + Math.random() * 0.4,
        size: 2 + Math.random() * 3.5,
        tint,
        kind: PARTICLE_KINDS.BUBBLE,
        drag: 0.97,
      });
    }
  }

  /**
   * Expanding lens-flare ring.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {string} color
   */
  ring(x, y, radius, color) {
    this.spawn({
      x,
      y,
      life: 0.42,
      size: radius * 0.35,
      growth: radius * 0.9,
      tint: hexToPixi(color),
      kind: PARTICLE_KINDS.RING,
    });
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    let write = 0;
    for (let read = 0; read < this.particles.length; read++) {
      const p = this.particles[read];
      p.life -= dt;

      if (p.life <= 0) {
        p.sprite.visible = false;
        this.pool.release(p);
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const damping = Math.pow(p.drag, dt * 60);
      p.vx *= damping;
      p.vy *= damping;

      const t = p.life / p.maxLife;
      p.sprite.alpha = Math.max(0, Math.min(1, t));
      this.applyTransform(p, t);

      this.particles[write] = p;
      write++;
    }
    this.particles.length = write;
  }

  clear() {
    for (const p of this.particles) {
      p.sprite.visible = false;
      this.pool.release(p);
    }
    this.particles.length = 0;
  }

  get count() {
    return this.particles.length;
  }
}
