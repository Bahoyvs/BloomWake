/**
 * Dark Liminal Pool — Background Visual System
 *
 * Frutiger Aero / Deep Underwater Pool aesthetic background pipeline for PixiJS v8.
 * Features zero-asset procedural Voronoi water caustics, clean pool tile grid,
 * 5-layer screen-space parallax scrolling, dual caustics counter-drift, soft bloom, and breathing sunbeams.
 *
 * Follows the "Visual Soup" luminance split contract (theme.js) to guarantee
 * hero readability against deep aquatic dark tones (#020b14 - #061d33).
 */

import { Container, Geometry, Graphics, Mesh, Shader, TilingSprite, Sprite, Texture } from 'pixi.js';
import { THEME } from './theme.js';
import {
  CAUSTICS_FRAGMENT,
  CAUSTICS_VERTEX,
  createCausticsUniforms,
  validateFragmentShader,
} from './caustics-shader.js';

export function createCausticsMesh(app = null) {
  try {
    const gl = app?.renderer?.gl ?? null;
    if (gl) {
      const check = validateFragmentShader(gl, CAUSTICS_FRAGMENT);
      if (!check.ok) {
        console.warn(
          `[BloomWake] Caustics shader failed to compile, using baked caustics.\n${check.log}`
        );
        return null;
      }
    }

    const geometry = new Geometry({
      attributes: {
        aPosition: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        aUV: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    const causticsUniforms = createCausticsUniforms();
    const shader = Shader.from({
      gl: { vertex: CAUSTICS_VERTEX, fragment: CAUSTICS_FRAGMENT },
      resources: { causticsUniforms },
    });

    const mesh = new Mesh({ geometry, shader });
    return { mesh, uniforms: shader.resources.causticsUniforms.uniforms };
  } catch (error) {
    console.warn('[BloomWake] Caustics shader unavailable, using baked caustics.', error);
    return null;
  }
}

function getViewportDimensions() {
  if (typeof window !== 'undefined') {
    return { width: window.innerWidth || 800, height: window.innerHeight || 600 };
  }
  return { width: 800, height: 600 };
}

function safeTextureFrom(canvas) {
  try {
    return Texture.from(canvas);
  } catch {
    return Texture.EMPTY;
  }
}

/**
 * Procedurally generates a 256x256 Dark Liminal Pool tile texture.
 * Features clean, subtle pool tile grid lines on a deep aquatic blue gradient base.
 *
 * @param {import('pixi.js').Application} app
 * @returns {import('pixi.js').Texture}
 */
export function makeLiminalPoolTileTexture(app) {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  const size = 256;

  // 1. Deep Ocean Pool Base Gradient (#020c18 -> #061e34)
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#020c18');
  grad.addColorStop(0.5, '#05192c');
  grad.addColorStop(1, '#031120');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // 2. Outer Tile Dark Border / Grout Stroke (thin 2px border)
  ctx.strokeStyle = 'rgba(2, 10, 18, 0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  // 3. Subtle Inner Tile Highlight Line
  ctx.strokeStyle = 'rgba(20, 75, 115, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(3, 3, size - 6, size - 6);

  return safeTextureFrom(canvas);
}

/**
 * Procedurally generates a 512x512 seamless Voronoi water caustics texture
 * with soft light diffusion and bloom halos around caustic lines.
 *
 * @param {import('pixi.js').Application} app
 * @returns {import('pixi.js').Texture}
 */
export function makeCausticsTexture(app) {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  const size = 512;
  const numCells = 8; // 8x8 grid of cells -> 64px per cell
  const cellSize = size / numCells;

  // Generate seed points for 8x8 cells with fixed deterministic offsets
  const points = [];
  let seed = 12345;
  const lcg = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let gy = 0; gy < numCells; gy++) {
    for (let gx = 0; gx < numCells; gx++) {
      const px = (gx + 0.2 + lcg() * 0.6) * cellSize;
      const py = (gy + 0.2 + lcg() * 0.6) * cellSize;
      points.push({ gx, gy, px, py });
    }
  }

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  // For each pixel, compute Voronoi d2 - d1 with seamless wrapping & soft bloom
  for (let y = 0; y < size; y++) {
    const gy = Math.floor(y / cellSize);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / cellSize);

      let d1 = Infinity;
      let d2 = Infinity;

      for (let dy = -1; dy <= 1; dy++) {
        const ngy = (gy + dy + numCells) % numCells;
        const wrapY = dy === -1 && gy === 0 ? -size : dy === 1 && gy === numCells - 1 ? size : 0;

        for (let dx = -1; dx <= 1; dx++) {
          const ngx = (gx + dx + numCells) % numCells;
          const wrapX = dx === -1 && gx === 0 ? -size : dx === 1 && gx === numCells - 1 ? size : 0;

          const idx = ngy * numCells + ngx;
          const p = points[idx];
          const px = p.px + wrapX;
          const py = p.py + wrapY;

          const distSq = (x - px) * (x - px) + (y - py) * (y - py);
          if (distSq < d1) {
            d2 = d1;
            d1 = distSq;
          } else if (distSq < d2) {
            d2 = distSq;
          }
        }
      }

      const distDiff = Math.sqrt(d2) - Math.sqrt(d1);

      // Multi-pass bloom calculation: soft halo + bright core
      const width = 22.0;
      const val = Math.max(0, 1.0 - distDiff / width);
      const glowIntensity = Math.pow(val, 1.4);
      const coreIntensity = Math.pow(val, 2.6);
      const intensity = Math.min(1.0, glowIntensity * 0.45 + coreIntensity * 0.75);

      const pixelIdx = (y * size + x) * 4;
      data[pixelIdx] = Math.round(140 * intensity); // R
      data[pixelIdx + 1] = Math.round(220 * intensity); // G
      data[pixelIdx + 2] = Math.round(255 * intensity); // B
      data[pixelIdx + 3] = Math.round(220 * intensity); // A
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return safeTextureFrom(canvas);
}

/**
 * Procedurally generates a 512x512 sunlight shafts (god rays) texture.
 *
 * @param {import('pixi.js').Application} app
 * @returns {import('pixi.js').Texture}
 */
export function makeSunbeamsTexture(app) {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.clearRect(0, 0, 512, 512);

  // Slanted vertical beam gradients
  const beams = [
    { x: 60, width: 45, opacity: 0.14 },
    { x: 180, width: 75, opacity: 0.18 },
    { x: 320, width: 60, opacity: 0.15 },
    { x: 440, width: 50, opacity: 0.12 },
  ];

  for (const b of beams) {
    const grad = ctx.createLinearGradient(b.x, 0, b.x + 90, 512);
    grad.addColorStop(0, `rgba(180, 240, 255, ${b.opacity})`);
    grad.addColorStop(0.5, `rgba(60, 180, 230, ${b.opacity * 0.45})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(b.x, 0);
    ctx.lineTo(b.x + b.width, 0);
    ctx.lineTo(b.x + b.width + 110, 512);
    ctx.lineTo(b.x + 110, 512);
    ctx.closePath();
    ctx.fill();
  }

  return safeTextureFrom(canvas);
}

/**
 * Procedurally generates a 512x512 top-anchored sunlight radial bloom texture.
 *
 * @param {import('pixi.js').Application} app
 * @returns {import('pixi.js').Texture}
 */
export function makeSunGlowTexture(app) {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.clearRect(0, 0, 512, 512);

  const glow = ctx.createRadialGradient(256, 0, 10, 256, 120, 500);
  glow.addColorStop(0, 'rgba(180, 240, 255, 0.28)');
  glow.addColorStop(0.35, 'rgba(60, 180, 235, 0.14)');
  glow.addColorStop(0.7, 'rgba(20, 90, 150, 0.05)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 512, 512);

  return safeTextureFrom(canvas);
}

export class Background {
  /**
   * @param {import('pixi.js').Application} app
   */
  constructor(app) {
    this.app = app;
    this.time = 0;

    this.container = new Container();

    // 1. Bake procedural textures
    this.textures = {
      tile: makeLiminalPoolTileTexture(app),
      caustics: makeCausticsTexture(app),
      sunbeams: makeSunbeamsTexture(app),
      sunGlow: makeSunGlowTexture(app),
    };

    const { width, height } = getViewportDimensions();

    // 2. Base Dark Vignette Layer
    this.baseGfx = new Graphics();
    this.container.addChild(this.baseGfx);

    // 3. Layer 2: Liminal Pool Tile TilingSprite (Parallax 0.25)
    this.tileLayer = new TilingSprite({
      texture: this.textures.tile,
      width,
      height,
    });
    this.tileLayer.alpha = 0.95;
    this.container.addChild(this.tileLayer);

    // 4. Layer 3: Coarse Surface Voronoi Caustics (Parallax 0.35, slow drift)
    this.causticsA = new TilingSprite({
      texture: this.textures.caustics,
      width,
      height,
    });
    this.causticsA.alpha = 0.24;
    this.container.addChild(this.causticsA);

    // 5. Layer 4: Fine Counter-Drift Voronoi Caustics (Parallax 0.55, light aqua tint)
    this.causticsB = new TilingSprite({
      texture: this.textures.caustics,
      width,
      height,
    });
    this.causticsB.tileScale.set(0.7, 0.7);
    this.causticsB.alpha = 0.16;
    this.causticsB.tint = 0x38bdf8;
    this.container.addChild(this.causticsB);

    // 6. Layer 5: God Rays Sunlight Shafts (Parallax 0.18, breathing opacity)
    this.sunbeamsLayer = new TilingSprite({
      texture: this.textures.sunbeams,
      width,
      height,
    });
    this.sunbeamsLayer.alpha = 0.16;
    this.container.addChild(this.sunbeamsLayer);

    // 7. Layer 6: Sunlight Radial Bloom Sprite
    this.sunGlowLayer = new Sprite(this.textures.sunGlow);
    this.sunGlowLayer.width = width;
    this.sunGlowLayer.height = height;
    this.sunGlowLayer.alpha = 0.85;
    this.container.addChild(this.sunGlowLayer);

    // 8. APPROACH A — the procedural caustics shader, on top of the baked
    // layers and covering them.
    const caustics = createCausticsMesh(app);
    this.causticsMesh = caustics?.mesh ?? null;
    this.causticsUniforms = caustics?.uniforms ?? null;
    this.usingShader = Boolean(this.causticsMesh);

    if (this.causticsMesh) {
      this.container.addChild(this.causticsMesh);
    }

    this.applyMode();
    this.drawBaseVignette(width, height);
    this.resize(width, height);
  }

  applyMode() {
    const baked = [this.tileLayer, this.causticsA, this.causticsB, this.sunbeamsLayer, this.sunGlowLayer];
    for (const layer of baked) {
      if (layer) layer.visible = !this.usingShader;
    }
    if (this.causticsMesh) this.causticsMesh.visible = this.usingShader;
    if (this.baseGfx) this.baseGfx.visible = !this.usingShader;
  }

  setShaderEnabled(enabled) {
    this.usingShader = Boolean(enabled) && Boolean(this.causticsMesh);
    this.applyMode();
  }

  drawBaseVignette(width, height) {
    const g = this.baseGfx;
    g.clear();

    // Dark Liminal Pool vignette background (#020a14)
    g.rect(0, 0, width, height);
    g.fill({ color: 0x020a14 });
  }

  /**
   * Update layer tile offsets and animation.
   *
   * @param {number} dt Delta time in seconds
   * @param {number} cameraX Camera world position X
   * @param {number} cameraY Camera world position Y
   * @param {number} width Screen viewport width
   * @param {number} height Screen viewport height
   */
  update(dt = 1 / 60, cameraX = 0, cameraY = 0, width = 800, height = 600) {
    this.time += dt;

    if (this.usingShader && this.causticsUniforms) {
      const u = this.causticsUniforms;
      u.uTime = this.time;
      u.uAspect = height > 0 ? width / height : 1;
      u.uCamera[0] = cameraX * 0.00007;
      u.uCamera[1] = cameraY * 0.00007;
      u.uPixelScale = height > 0 ? 1 / height : 1 / 720;
      return;
    }

    // 1. Pool Tile Scrolling (Parallax 0.25)
    if (this.tileLayer) {
      this.tileLayer.tilePosition.x = -cameraX * 0.25;
      this.tileLayer.tilePosition.y = -cameraY * 0.25;
    }

    // 2. Coarse Caustics Ripple (Parallax 0.35 + organic sine drift)
    if (this.causticsA) {
      this.causticsA.tilePosition.x =
        -cameraX * 0.35 + Math.sin(this.time * 0.3) * 30 + this.time * 4;
      this.causticsA.tilePosition.y =
        -cameraY * 0.35 + Math.cos(this.time * 0.25) * 25 + this.time * 3;
      this.causticsA.alpha = 0.24 + Math.sin(this.time * 0.4) * 0.04;
    }

    // 3. Fine Counter-Drift Caustics (Parallax 0.55 + counter drift)
    if (this.causticsB) {
      this.causticsB.tilePosition.x =
        -cameraX * 0.55 - Math.sin(this.time * 0.5) * 45 - this.time * 6;
      this.causticsB.tilePosition.y =
        -cameraY * 0.55 + Math.cos(this.time * 0.4) * 35 + this.time * 4;
    }

    // 4. God Rays Breathing Shafts (Parallax 0.18 + breathing opacity)
    if (this.sunbeamsLayer) {
      this.sunbeamsLayer.tilePosition.x =
        -cameraX * 0.18 + Math.sin(this.time * 0.15) * 20 + this.time * 2;
      this.sunbeamsLayer.alpha = 0.16 + Math.sin(this.time * 0.3) * 0.04;
    }
  }

  resize(width, height) {
    this.drawBaseVignette(width, height);
    const layers = [this.tileLayer, this.causticsA, this.causticsB, this.sunbeamsLayer];
    for (const layer of layers) {
      if (layer) {
        layer.width = width;
        layer.height = height;
      }
    }
    if (this.sunGlowLayer) {
      this.sunGlowLayer.width = width;
      this.sunGlowLayer.height = height;
    }

    if (this.causticsMesh) {
      this.causticsMesh.scale.set(width, height);
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
