import { describe, it, expect, beforeAll } from 'vitest';
import {
  Background,
  makeLiminalPoolTileTexture,
  makeCausticsTexture,
  makeSunbeamsTexture,
} from '../src/render/background.js';
import { THEME, contrastRatio, MIN_HERO_CONTRAST } from '../src/render/theme.js';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect: () => {},
          clearRect: () => {},
          beginPath: () => {},
          arc: () => {},
          fill: () => {},
          stroke: () => {},
          strokeRect: () => {},
          moveTo: () => {},
          lineTo: () => {},
          ellipse: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => {},
          createLinearGradient: () => ({ addColorStop: () => {} }),
          createRadialGradient: () => ({ addColorStop: () => {} }),
          bezierCurveTo: () => {},
          quadraticCurveTo: () => {},
          closePath: () => {},
        }),
      }),
    };
  }
});

describe('Background visual system', () => {
  it('instantiates background layers and procedural textures', () => {
    const bg = new Background(null);
    expect(bg.container).toBeDefined();
    expect(bg.tileLayer).toBeDefined();
    expect(bg.causticsA).toBeDefined();
    expect(bg.causticsB).toBeDefined();
    expect(bg.sunbeamsLayer).toBeDefined();
  });

  it('updates parallax tile offsets over time (baked fallback path)', () => {
    // The baked pipeline is now the Approach B FALLBACK rather than the default,
    // so this asserts it against an explicitly disabled shader. Its parallax
    // still has to work — it is what ships if the shader cannot be built.
    const bg = new Background(null);
    bg.setShaderEnabled(false);
    const initCausticAX = bg.causticsA.tilePosition.x;

    // Simulate 1 second update with camera at (100, 200)
    bg.update(1 / 60, 100, 200, 800, 600);

    expect(bg.tileLayer.tilePosition.x).toBe(-100 * 0.25);
    expect(bg.tileLayer.tilePosition.y).toBe(-200 * 0.25);
    expect(bg.causticsA.tilePosition.x).not.toBe(initCausticAX);
  });

  it('drives shader uniforms instead of tile offsets when the shader is live', () => {
    const bg = new Background(null);
    if (!bg.causticsMesh) return; // No shader in this environment; nothing to assert.

    bg.setShaderEnabled(true);
    const bakedBefore = bg.causticsA.tilePosition.x;

    bg.update(0.5, 100, 200, 1600, 800);

    expect(bg.causticsUniforms.uTime).toBeCloseTo(0.5, 6);
    expect(bg.causticsUniforms.uAspect).toBeCloseTo(2, 6);
    // The baked layers must not be doing hidden CPU work behind the shader.
    expect(bg.causticsA.tilePosition.x).toBe(bakedBefore);
  });

  it('shows exactly one caustics pipeline at a time', () => {
    const bg = new Background(null);
    if (!bg.causticsMesh) return;

    bg.setShaderEnabled(true);
    expect(bg.causticsMesh.visible).toBe(true);
    expect(bg.causticsA.visible).toBe(false);
    expect(bg.tileLayer.visible).toBe(false);

    // Two caustic patterns blended together read as noise, not as depth.
    bg.setShaderEnabled(false);
    expect(bg.causticsMesh.visible).toBe(false);
    expect(bg.causticsA.visible).toBe(true);
    expect(bg.tileLayer.visible).toBe(true);
  });

  it('scales the shader quad to the viewport on resize', () => {
    const bg = new Background(null);
    if (!bg.causticsMesh) return;

    bg.resize(1920, 1080);
    expect(bg.causticsMesh.scale.x).toBe(1920);
    expect(bg.causticsMesh.scale.y).toBe(1080);
  });

  it('handles resize cleanly', () => {
    const bg = new Background(null);
    bg.resize(1920, 1080);
    expect(bg.tileLayer.width).toBe(1920);
    expect(bg.tileLayer.height).toBe(1080);
    expect(bg.causticsA.width).toBe(1920);
    expect(bg.causticsB.height).toBe(1080);
  });

  it('preserves hero contrast ratio floor against background palette entries', () => {
    const heroCore = THEME.hero.core;
    for (const [key, color] of Object.entries(THEME.background)) {
      const contrast = contrastRatio(heroCore, color);
      expect(contrast, `Background ${key} (${color})`).toBeGreaterThanOrEqual(MIN_HERO_CONTRAST);
    }
  });

  it('creates non-null textures from procedural generators', () => {
    const tileTex = makeLiminalPoolTileTexture(null);
    const causticsTex = makeCausticsTexture(null);
    const sunbeamTex = makeSunbeamsTexture(null);

    expect(tileTex).toBeDefined();
    expect(causticsTex).toBeDefined();
    expect(sunbeamTex).toBeDefined();
  });
});
