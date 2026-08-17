/**
 * Caustics shader — palette contract and GLSL shape.
 *
 * The shader cannot be executed in Node, but the thing most likely to go wrong
 * with it can still be checked here: the colours. A background that creeps
 * bright breaks the "Visual Soup" rule across the ENTIRE screen at once, which
 * is worse than any single sprite doing it, and it is the exact failure mode of
 * "make it look like nice water" edits.
 */

import { describe, it, expect } from 'vitest';
import {
  CAUSTICS_FRAGMENT,
  CAUSTICS_PALETTE,
  CAUSTICS_TUNING,
  CAUSTICS_VERTEX,
  buildCausticsFragment,
  createCausticsUniforms,
  hexToGlslVec3,
  paletteLuminance,
  validateFragmentShader,
} from '../src/render/caustics-shader.js';
import { THEME, contrastRatio, MIN_HERO_CONTRAST } from '../src/render/theme.js';

describe('caustics palette', () => {
  it('uses the art-directed floor, marine glow and cyan core', () => {
    expect(CAUSTICS_PALETTE.deep).toBe('#051121');
    expect(CAUSTICS_PALETTE.core).toBe('#40e0d0');
  });

  it('keeps the FLOOR colours below the Frutevil luminance ceiling', () => {
    // The large-area colours are the ones that set perceived screen
    // brightness, and they still obey the original contract outright.
    for (const name of ['deep', 'abyss', 'glow']) {
      const hex = CAUSTICS_PALETTE[name];
      expect(paletteLuminance(hex), `${name} (${hex})`).toBeLessThan(0.25);
    }
  });

  it('preserves the hero contrast floor against the large-area colours', () => {
    for (const name of ['deep', 'abyss', 'glow']) {
      const hex = CAUSTICS_PALETTE[name];
      const contrast = contrastRatio(THEME.hero.core, hex);
      expect(contrast, `${name} (${hex})`).toBeGreaterThanOrEqual(MIN_HERO_CONTRAST);
    }
  });

  /**
   * THE CORE IS A DELIBERATE EXCEPTION, AND THIS IS THE GUARD THAT REPLACES
   * THE OLD ONE.
   *
   * #40e0d0 is brighter than MAX_ENEMY_LUMINANCE and sits about at the
   * Dewling's own floor. As a flat fill it would destroy the Visual Soup rule.
   * It is acceptable ONLY as a hairline specular glint: peak luminance and
   * perceived screen luminance are different quantities, and the separation
   * between them is entirely a function of how few pixels the core covers.
   *
   * So the contract is no longer "this colour is dark". It is "the bright
   * colour stays rare". These tests pin the things that keep it rare; the
   * on-screen mean-luminance measurement is the empirical counterpart.
   */
  it('confines the bright core to a hairline', () => {
    expect(paletteLuminance(CAUSTICS_PALETTE.core)).toBeGreaterThan(0.25);

    // Sub-pixel-to-2px half-width. This is the only thing standing between a
    // specular glint and a neon wireframe.
    expect(CAUSTICS_TUNING.lineWidthPx).toBeLessThanOrEqual(1.0);
    // ...and it must stay far thinner than its own halo, or the "core" IS the
    // glow and the coverage argument collapses.
    expect(CAUSTICS_TUNING.lineWidthPx * 4).toBeLessThan(CAUSTICS_TUNING.glowWidthPx);
  });

  it('keeps the core additive weight well under full strength', () => {
    // A thread adds coreStrength * intensity of #40e0d0 on top of the floor;
    // a knot adds that plus nodeStrength * intensity again.
    //
    // The ceiling here is set from measurement rather than principle: at a
    // combined weight of ~0.34 the brightest on-screen pixel measured 0.36
    // luminance against the Dewling's 0.98, with under 1% of the screen above
    // 0.30. Raising it much further starts eating that separation.
    const thread = CAUSTICS_TUNING.coreStrength * CAUSTICS_TUNING.intensity;
    const knot = thread + CAUSTICS_TUNING.nodeStrength * CAUSTICS_TUNING.intensity;

    expect(thread).toBeLessThanOrEqual(0.25);
    expect(knot).toBeLessThanOrEqual(0.4);
    // Knots must actually out-glow plain threads, or the compounding is moot.
    expect(knot).toBeGreaterThan(thread);
  });

  it('keeps the WIDE layer marine blue rather than cyan', () => {
    // The halo covers many more pixels than the core, so it is the layer that
    // would actually turn the screen cyan. Blue must lead green here.
    const value = parseInt(CAUSTICS_PALETTE.glow.replace('#', ''), 16);
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    expect(g).toBeLessThan(b);
  });
});

describe('aesthetic tuning constraints', () => {
  it('keeps the lattice dense — a pool floor, not rolling plasma waves', () => {
    // The first pass used 6.0 / 9.5, which made cells read as giant waves
    // sweeping past the player instead of texture on a distant floor.
    expect(CAUSTICS_TUNING.scaleA).toBeGreaterThanOrEqual(24);
    expect(CAUSTICS_TUNING.scaleB).toBeGreaterThanOrEqual(24);
    // The two lattices must stay at different frequencies, or their
    // interference collapses into a visible regular grid.
    expect(CAUSTICS_TUNING.scaleB).not.toBe(CAUSTICS_TUNING.scaleA);
  });

  it('keeps threads razor-thin', () => {
    expect(CAUSTICS_TUNING.lineWidthPx).toBeLessThanOrEqual(1.5);
    expect(CAUSTICS_TUNING.lineWidthPx).toBeGreaterThan(0);
  });

  it('keeps the caustics faint — no neon', () => {
    // At 1.0 the threads would BE the caustic colour. They must stay a long
    // way short of it so they read as depth, not as light sources.
    expect(CAUSTICS_TUNING.intensity).toBeLessThanOrEqual(0.3);
    expect(CAUSTICS_TUNING.shaftStrength).toBeLessThanOrEqual(0.08);
  });

  it('undulates slowly', () => {
    expect(CAUSTICS_TUNING.timeScale).toBeLessThanOrEqual(0.2);
    expect(CAUSTICS_TUNING.timeScale).toBeGreaterThan(0);
  });

  it('keeps the broad halo — the layer that covers real area — very dim', () => {
    // The glow is additive over a ~6px band, so it is what sets the perceived
    // brightness of the water. Model what it actually adds to the floor.
    const parse = (hex) => {
      const v = parseInt(hex.replace('#', ''), 16);
      return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    };
    const base = parse(CAUSTICS_PALETTE.deep);
    const glow = parse(CAUSTICS_PALETTE.glow);
    const weight = CAUSTICS_TUNING.glowStrength * CAUSTICS_TUNING.intensity;
    const lit = base.map((c, i) => Math.min(255, c + glow[i] * weight));

    const toHex = (c) => Math.round(c).toString(16).padStart(2, '0');
    const litHex = `#${lit.map(toHex).join('')}`;

    // A haloed pixel must stay far below the Frutevil enemy ceiling — it is
    // background, so it has to lose to everything, not merely to the hero.
    expect(paletteLuminance(litHex)).toBeLessThan(0.05);
    // ...and still be distinguishable from the base, or there is no texture.
    expect(paletteLuminance(litHex)).toBeGreaterThan(paletteLuminance(CAUSTICS_PALETTE.deep));
  });

  it('holds thread width to about a pixel via an analytic gradient', () => {
    // At this lattice density a thread is roughly one pixel wide. Without
    // width control it breaks into crawling dashes as it drifts.
    expect(CAUSTICS_FRAGMENT).toContain('smoothstep(w - aa, w + aa, d)');
    expect(CAUSTICS_FRAGMENT).toContain('GRAD_APPROX * uPixelScale');
  });

  it('never calls a derivative builtin', () => {
    // PixiJS v8 compiles this as GLSL ES 1.00 even on a WebGL2 context, where
    // fwidth/dFdx need GL_OES_standard_derivatives — and an extension line
    // cannot be placed before Pixi's injected preamble. Using one silently
    // blanks the background, so it is banned outright.
    //
    // Comments explain WHY fwidth is absent, so only code is under test.
    const code = CAUSTICS_FRAGMENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(fwidth|dFdx|dFdy)\s*\(/);
  });

  it('bakes a calibrated gradient constant consistent with the lattice scales', () => {
    const raw = 0.62 * CAUSTICS_TUNING.scaleA + 0.38 * CAUSTICS_TUNING.scaleB;
    const expected = raw * CAUSTICS_TUNING.gradCalibration;
    expect(CAUSTICS_FRAGMENT).toContain(`const float GRAD_APPROX = ${expected.toFixed(5)}`);

    // The calibration exists because the raw frequency sum overestimates the
    // true gradient — three sines pointing different ways partly cancel. Using
    // the raw sum made the anti-alias term swamp the line width and shipped
    // 13px blobs where ~2px threads were wanted.
    expect(CAUSTICS_TUNING.gradCalibration).toBeLessThan(1);
    expect(CAUSTICS_TUNING.gradCalibration).toBeGreaterThan(0);
  });

  it('drives every animated term from one scaled clock', () => {
    // uTime is scaled once in main(); the layers must not each apply their own
    // multiplier or they drift out of step when the speed is retuned.
    expect(CAUSTICS_FRAGMENT).toContain('float t = uTime * TIME_SCALE');
  });

  it('bakes the tuning constants into the GLSL', () => {
    expect(CAUSTICS_FRAGMENT).toContain(`const float SCALE_A    = ${CAUSTICS_TUNING.scaleA.toFixed(5)}`);
    expect(CAUSTICS_FRAGMENT).toContain(`const float TIME_SCALE = ${CAUSTICS_TUNING.timeScale.toFixed(5)}`);
  });
});

describe('hexToGlslVec3', () => {
  it('converts to normalised GLSL vec3', () => {
    expect(hexToGlslVec3('#000000')).toBe('vec3(0.00000, 0.00000, 0.00000)');
    expect(hexToGlslVec3('#ffffff')).toBe('vec3(1.00000, 1.00000, 1.00000)');
  });

  it('round-trips the palette within a quantisation step', () => {
    for (const hex of Object.values(CAUSTICS_PALETTE)) {
      const parsed = hexToGlslVec3(hex)
        .replace(/vec3\(|\)/g, '')
        .split(',')
        .map(Number);
      const value = parseInt(hex.replace('#', ''), 16);
      const expected = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((c) => c / 255);

      for (let i = 0; i < 3; i++) expect(parsed[i]).toBeCloseTo(expected[i], 4);
    }
  });
});

describe('GLSL source', () => {
  it('bakes the palette in as constants', () => {
    expect(CAUSTICS_FRAGMENT).toContain(hexToGlslVec3(CAUSTICS_PALETTE.deep));
    expect(CAUSTICS_FRAGMENT).toContain(hexToGlslVec3(CAUSTICS_PALETTE.glow));
    expect(CAUSTICS_FRAGMENT).toContain(hexToGlslVec3(CAUSTICS_PALETTE.core));
  });

  it('clamps output to the core colour so additive stacking cannot blow out', () => {
    // The last line of defence. Three additive layers plus shafts could
    // otherwise sum past the brightest authored colour and clip toward white,
    // which is exactly how a subtle glow turns into a neon wireframe.
    expect(CAUSTICS_FRAGMENT).toContain('min(color, CORE)');
  });

  it('layers the bloom widest-and-dimmest first', () => {
    // Halo, then core on top, then the intersection lift — light compounds in
    // that order, and the additive blend has to follow it.
    const glowAt = CAUSTICS_FRAGMENT.indexOf('color += GLOW * light.y');
    const coreAt = CAUSTICS_FRAGMENT.indexOf('color += CORE * light.x');
    const nodeAt = CAUSTICS_FRAGMENT.indexOf('color += CORE * light.z');

    expect(glowAt).toBeGreaterThan(-1);
    expect(glowAt).toBeLessThan(coreAt);
    expect(coreAt).toBeLessThan(nodeAt);
  });

  it('derives both bloom layers from one distance field', () => {
    // The whole trick: threshold the SAME d twice. Computing a second field
    // for the glow would double the trig cost for no visual gain.
    const code = CAUSTICS_FRAGMENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect((code.match(/float d = abs\(/g) || []).length).toBe(1);
    expect(code).toContain('smoothstep(w - aa, w + aa, d)');
    expect(code).toContain('smoothstep(0.0, GLOW_W_PX * perPx, d)');
  });

  it('compounds intersections by multiplying the two ridge fields', () => {
    // A sum would brighten every thread; only a product isolates the knots.
    expect(CAUSTICS_FRAGMENT).toContain('float node = n1 * n2;');
  });

  it('declares the PixiJS v8 mesh interface', () => {
    expect(CAUSTICS_VERTEX).toContain('aPosition');
    expect(CAUSTICS_VERTEX).toContain('aUV');
    expect(CAUSTICS_VERTEX).toContain('uProjectionMatrix');
    expect(CAUSTICS_VERTEX).toContain('uWorldTransformMatrix');
    expect(CAUSTICS_VERTEX).toContain('uTransformMatrix');
    expect(CAUSTICS_FRAGMENT).toContain('out vec4 finalColor');
  });

  it('declares every uniform it is given, and no more', () => {
    const uniforms = createCausticsUniforms();
    for (const name of Object.keys(uniforms)) {
      expect(CAUSTICS_FRAGMENT, `${name} is unused`).toContain(name);
    }
  });

  it('stays cheap — no loops, no texture lookups, no multi-octave noise', () => {
    // The performance contract, as far as source inspection can enforce it.
    expect(CAUSTICS_FRAGMENT).not.toMatch(/\bfor\s*\(/);
    expect(CAUSTICS_FRAGMENT).not.toMatch(/\bwhile\s*\(/);
    expect(CAUSTICS_FRAGMENT).not.toMatch(/texture2D|texture\s*\(/);
    expect(CAUSTICS_FRAGMENT).not.toMatch(/\bfbm\b/i);
  });

  it('keeps the transcendental count in budget', () => {
    // Every sin/cos here is paid per pixel per frame at full screen. This is a
    // tripwire, not a style rule: if a future edit doubles this, the frame-time
    // gate is what will actually catch it, but this says so sooner.
    //
    // Comments discuss pow() at length, so only code is counted.
    const code = CAUSTICS_FRAGMENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const trig = (code.match(/\b(sin|cos|tan)\s*\(/g) || []).length;
    expect(trig).toBeLessThanOrEqual(14);

    const pows = (code.match(/\bpow\s*\(/g) || []).length;
    expect(pows).toBeLessThanOrEqual(3);

    // The bloom is four smoothsteps on an already-computed field, which is the
    // cheap way to fake it — no blur pass, no second render target.
    const smoothsteps = (code.match(/\bsmoothstep\s*\(/g) || []).length;
    expect(smoothsteps).toBeLessThanOrEqual(6);
  });
});

describe('validateFragmentShader — the guard against a silent blank screen', () => {
  /**
   * Minimal fake GL context. Pixi does not throw on a bad shader, so this
   * compile-test is the only thing standing between a broken shader and a
   * background that renders nothing at all.
   *
   * @param {boolean} compiles
   * @returns {Object}
   */
  function fakeGl(compiles) {
    return {
      FRAGMENT_SHADER: 1,
      COMPILE_STATUS: 2,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => compiles,
      getShaderInfoLog: () => "ERROR: 0:67: 'fwidth' : no matching overloaded function found",
      deleteShader: () => {},
    };
  }

  it('passes a shader that compiles', () => {
    expect(validateFragmentShader(fakeGl(true), CAUSTICS_FRAGMENT)).toEqual({ ok: true });
  });

  it('reports the compile log when it fails', () => {
    const result = validateFragmentShader(fakeGl(false), CAUSTICS_FRAGMENT);
    expect(result.ok).toBe(false);
    expect(result.log).toContain('fwidth');
  });

  it('compiles against the same ES 1.00 preamble PixiJS injects', () => {
    // If the probe used a different dialect it would green-light shaders that
    // Pixi then rejects, which is exactly the failure it exists to prevent.
    let captured = '';
    const gl = { ...fakeGl(true), shaderSource: (_s, src) => { captured = src; } };
    validateFragmentShader(gl, CAUSTICS_FRAGMENT);

    expect(captured).toContain('#define in varying');
    expect(captured).toContain('#define finalColor gl_FragColor');
    expect(captured).toContain('precision mediump float;');
    expect(captured).toContain('void main()');
  });

  it('strips the out declaration exactly as PixiJS does', () => {
    // The preamble aliases finalColor to gl_FragColor, so leaving the
    // `out vec4 finalColor;` line in makes it `out vec4 gl_FragColor;` — two
    // errors, and a working shader wrongly rejected.
    let captured = '';
    const gl = { ...fakeGl(true), shaderSource: (_s, src) => { captured = src; } };
    validateFragmentShader(gl, CAUSTICS_FRAGMENT);

    expect(CAUSTICS_FRAGMENT).toContain('out vec4 finalColor;');
    expect(captured).not.toContain('out vec4 finalColor;');
    // The assignment inside main() must survive — only the declaration goes.
    expect(captured).toContain('finalColor = vec4(color, 1.0);');
  });

  it('stays out of the way when there is no GL context', () => {
    expect(validateFragmentShader(null, CAUSTICS_FRAGMENT)).toEqual({ ok: true });
    expect(validateFragmentShader({}, CAUSTICS_FRAGMENT)).toEqual({ ok: true });
  });
});

describe('uniforms', () => {
  it('exposes the four per-frame values in PixiJS v8 typed shape', () => {
    const uniforms = createCausticsUniforms();
    expect(uniforms.uTime).toEqual({ value: 0, type: 'f32' });
    expect(uniforms.uAspect).toEqual({ value: 1, type: 'f32' });
    expect(uniforms.uIntensity.type).toBe('f32');
    expect(uniforms.uCamera.type).toBe('vec2<f32>');
    expect(uniforms.uCamera.value).toBeInstanceOf(Float32Array);
    expect(uniforms.uPixelScale.type).toBe('f32');
  });

  it('hands out a fresh set each call, so two backgrounds cannot share state', () => {
    const a = createCausticsUniforms();
    const b = createCausticsUniforms();
    a.uCamera.value[0] = 5;
    expect(b.uCamera.value[0]).toBe(0);
  });
});

describe('buildCausticsFragment', () => {
  it('accepts a palette override for retuning without editing GLSL', () => {
    const source = buildCausticsFragment({
      deep: '#000000',
      glow: '#112233',
      core: '#445566',
      abyss: '#010101',
    });
    expect(source).toContain(hexToGlslVec3('#112233'));
    expect(source).toContain(hexToGlslVec3('#445566'));
    expect(source).not.toContain(hexToGlslVec3(CAUSTICS_PALETTE.core));
  });
});
