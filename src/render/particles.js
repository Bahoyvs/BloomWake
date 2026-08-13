/**
 * Particle system (Phase 6).
 *
 * Lives in the render layer on purpose: particles are pure decoration and must
 * never influence the simulation, so keeping them out of src/core/ preserves
 * both the determinism of the sim and the DOM-free rule.
 *
 * Recycled through the same ObjectPool as card-spawned entities — a wave of 200
 * enemy deaths must not allocate.
 */

import { ObjectPool } from '../core/pool.js';
import { THEME, withAlpha } from './theme.js';

/** How particles are drawn and how they move. */
export const PARTICLE_KINDS = {
  /** Sharp shard sprayed on an enemy hit. */
  SPARK: 'spark',
  /** Soft blob that drifts and fades — Frutevil dissolving. */
  MOTE: 'mote',
  /** Rising Aero bubble, used for pickups and level-ups. */
  BUBBLE: 'bubble',
  /** Expanding ring outline. */
  RING: 'ring',
};

const MAX_PARTICLES = 420;

export class ParticleSystem {
  constructor() {
    this.pool = new ObjectPool(makeParticle, 160);
    this.particles = [];
  }

  /**
   * @param {Object} spec
   * @returns {Object|null} The particle, or null when the budget is full
   */
  spawn(spec) {
    // Hard budget: decoration must never be the reason a frame drops.
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
    p.color = spec.color ?? THEME.hero.core;
    p.kind = spec.kind ?? PARTICLE_KINDS.SPARK;
    p.alive = true;

    this.particles.push(p);
    return p;
  }

  /**
   * Spray on an enemy taking a hit.
   * @param {number} x
   * @param {number} y
   * @param {string} color
   * @param {number} [count]
   */
  burst(x, y, color, count = 5) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 110;
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.22 + Math.random() * 0.2,
        size: 1.5 + Math.random() * 2,
        color,
        kind: PARTICLE_KINDS.SPARK,
      });
    }
  }

  /**
   * Frutevil dissolving on death: dark motes plus a thin rim flash.
   * @param {number} x
   * @param {number} y
   * @param {{fill: string, rim: string}} palette
   * @param {number} [radius]
   */
  death(x, y, palette, radius = 12) {
    for (let i = 0; i < 7; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 70;
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 20,
        life: 0.36 + Math.random() * 0.3,
        size: 2 + Math.random() * radius * 0.28,
        color: palette.fill,
        kind: PARTICLE_KINDS.MOTE,
        drag: 0.86,
      });
    }
    this.spawn({
      x,
      y,
      life: 0.3,
      size: radius * 0.7,
      growth: radius * 3.2,
      color: palette.rim,
      kind: PARTICLE_KINDS.RING,
    });
  }

  /**
   * Aqua bubbles rising off a pickup or level-up.
   * @param {number} x
   * @param {number} y
   * @param {string} [color]
   * @param {number} [count]
   */
  bubbles(x, y, color = THEME.pickup.orb, count = 4) {
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 14,
        y,
        vx: (Math.random() - 0.5) * 26,
        vy: -50 - Math.random() * 70,
        life: 0.5 + Math.random() * 0.4,
        size: 1.5 + Math.random() * 3,
        color,
        kind: PARTICLE_KINDS.BUBBLE,
        drag: 0.97,
      });
    }
  }

  /**
   * Expanding shock ring.
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
      size: radius * 0.4,
      growth: radius * 1.6,
      color,
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
        this.pool.release(p);
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Frame-rate independent drag.
      const damping = Math.pow(p.drag, dt * 60);
      p.vx *= damping;
      p.vy *= damping;

      this.particles[write] = p;
      write++;
    }
    this.particles.length = write;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = Math.max(0, Math.min(1, t));

      if (p.kind === PARTICLE_KINDS.RING) {
        ctx.strokeStyle = withAlpha(p.color, alpha * 0.7);
        ctx.lineWidth = 1 + 2 * alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + p.growth * (1 - t), 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      ctx.fillStyle = withAlpha(p.color, alpha);

      if (p.kind === PARTICLE_KINDS.SPARK) {
        // Streak along the direction of travel: reads as speed, not confetti.
        const len = Math.min(9, Math.hypot(p.vx, p.vy) * 0.035);
        const angle = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(angle);
        ctx.fillRect(-len, -p.size * 0.35, len, p.size * 0.7);
        ctx.restore();
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (p.kind === PARTICLE_KINDS.BUBBLE ? t : 1), 0, Math.PI * 2);
      ctx.fill();

      if (p.kind === PARTICLE_KINDS.BUBBLE) {
        ctx.strokeStyle = withAlpha(THEME.hero.core, alpha * 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  clear() {
    for (const p of this.particles) this.pool.release(p);
    this.particles.length = 0;
  }

  get count() {
    return this.particles.length;
  }
}

function makeParticle() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 1,
    growth: 0,
    drag: 0.9,
    color: '#ffffff',
    kind: PARTICLE_KINDS.SPARK,
    alive: false,
  };
}
