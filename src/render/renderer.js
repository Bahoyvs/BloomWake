/**
 * Canvas 2D grey-box renderer for BloomWake Phase 1.
 *
 * Deliberately unthemed: the Development Plan puts the Frutiger Aero / Frutevil
 * visual layer in Phase 6, after the loop is proven fun in grey box. Everything
 * here is neutral greyscale plus one accent for the Dewling so readability can
 * be judged on shape and motion alone.
 */

import { WORLD, PLAYER_CFG } from '../core/constants.js';
import { clamp } from '../core/math.js';
import { ENEMIES } from '../data/enemies.js';

export const PALETTE = {
  void: '#0d0f12',
  floor: '#16191e',
  grid: '#20242b',
  border: '#39404a',
  enemy: '#8b93a1',
  enemyOutline: '#c3cad6',
  enemyFlash: '#ffffff',
  player: '#dff3ff',
  playerRing: '#7fd4ff',
  trail: '#7fd4ff',
  projectile: '#eaf6ff',
  orb: '#b9f3c8',
};

const GRID_SIZE = 100;
const TRAIL_SAMPLES = 10;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/simulation.js').Simulation} simulation
   */
  constructor(canvas, simulation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = simulation;
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.camera = { x: 0, y: 0 };
    this.trail = [];

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewWidth = window.innerWidth;
    this.viewHeight = window.innerHeight;
    this.canvas.width = Math.floor(this.viewWidth * dpr);
    this.canvas.height = Math.floor(this.viewHeight * dpr);
    this.canvas.style.width = `${this.viewWidth}px`;
    this.canvas.style.height = `${this.viewHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Camera follows the Dewling, clamped so the arena edge never leaves a gap. */
  updateCamera() {
    const player = this.sim.state.player;

    this.camera.x =
      this.viewWidth >= WORLD.WIDTH
        ? (WORLD.WIDTH - this.viewWidth) / 2
        : clamp(player.x - this.viewWidth / 2, 0, WORLD.WIDTH - this.viewWidth);

    this.camera.y =
      this.viewHeight >= WORLD.HEIGHT
        ? (WORLD.HEIGHT - this.viewHeight) / 2
        : clamp(player.y - this.viewHeight / 2, 0, WORLD.HEIGHT - this.viewHeight);
  }

  /** Record the Dewling's recent path — a readability aid, not the Phase 6 trail VFX. */
  recordTrail() {
    const player = this.sim.state.player;
    this.trail.push({ x: player.x, y: player.y });
    if (this.trail.length > TRAIL_SAMPLES) this.trail.shift();
  }

  render() {
    this.updateCamera();
    this.recordTrail();

    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawArena();
    this.drawOrbs();
    this.drawEnemies();
    this.drawProjectiles();
    this.drawPlayer();

    ctx.restore();
  }

  drawArena() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.floor;
    ctx.fillRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);

    // Grid gives the otherwise featureless arena a sense of speed and place.
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = Math.floor(this.camera.x / GRID_SIZE) * GRID_SIZE;
    const endX = Math.min(WORLD.WIDTH, this.camera.x + this.viewWidth);
    for (let x = Math.max(0, startX); x <= endX; x += GRID_SIZE) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD.HEIGHT);
    }
    const startY = Math.floor(this.camera.y / GRID_SIZE) * GRID_SIZE;
    const endY = Math.min(WORLD.HEIGHT, this.camera.y + this.viewHeight);
    for (let y = Math.max(0, startY); y <= endY; y += GRID_SIZE) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD.WIDTH, y);
    }
    ctx.stroke();

    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);
  }

  drawEnemies() {
    const ctx = this.ctx;

    for (const enemy of this.sim.enemies) {
      if (!enemy.alive) continue;
      const def = ENEMIES[enemy.typeId];
      const flashing = enemy.hitFlash > 0;

      ctx.fillStyle = flashing ? PALETTE.enemyFlash : PALETTE.enemy;
      ctx.strokeStyle = PALETTE.enemyOutline;
      ctx.lineWidth = 2;

      if (def.shape === 'square') {
        const size = enemy.radius * 2;
        ctx.fillRect(enemy.x - enemy.radius, enemy.y - enemy.radius, size, size);
        ctx.strokeRect(enemy.x - enemy.radius, enemy.y - enemy.radius, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Damage readout: enemies take multiple hits once wave HP scaling kicks in.
      if (enemy.hp < enemy.maxHp) {
        const barWidth = enemy.radius * 2;
        const ratio = Math.max(0, enemy.hp / enemy.maxHp);
        ctx.fillStyle = '#3b4049';
        ctx.fillRect(enemy.x - enemy.radius, enemy.y - enemy.radius - 8, barWidth, 3);
        ctx.fillStyle = '#e5eaf2';
        ctx.fillRect(enemy.x - enemy.radius, enemy.y - enemy.radius - 8, barWidth * ratio, 3);
      }
    }
  }

  drawProjectiles() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.projectile;

    for (const p of this.sim.projectiles) {
      if (!p.alive) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawOrbs() {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.orb;

    for (const orb of this.sim.orbs) {
      if (!orb.alive) continue;
      ctx.beginPath();
      ctx.moveTo(orb.x, orb.y - orb.radius);
      ctx.lineTo(orb.x + orb.radius, orb.y);
      ctx.lineTo(orb.x, orb.y + orb.radius);
      ctx.lineTo(orb.x - orb.radius, orb.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawPlayer() {
    const ctx = this.ctx;
    const player = this.sim.state.player;

    for (let i = 0; i < this.trail.length - 1; i++) {
      const point = this.trail[i];
      ctx.globalAlpha = (i / this.trail.length) * 0.35;
      ctx.fillStyle = PALETTE.trail;
      ctx.beginPath();
      ctx.arc(point.x, point.y, PLAYER_CFG.RADIUS * (i / this.trail.length), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Blink through invulnerability frames so the hit lands visually.
    if (this.sim.invulnTimer > 0 && Math.floor(this.sim.invulnTimer * 12) % 2 === 0) return;

    ctx.fillStyle = PALETTE.player;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_CFG.RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = PALETTE.playerRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_CFG.RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}
