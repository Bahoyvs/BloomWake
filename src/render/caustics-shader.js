/**
 * Procedural water caustics — custom GLSL background shader (Approach A).
 *
 * WHY A SHADER AND NOT THE BAKED TEXTURE
 * The previous background baked a Voronoi caustics pattern into a canvas and
 * scrolled it on a TilingSprite. That can only ever TRANSLATE the pattern —
 * and real caustics do not translate, they DEFORM: cells morph, ridges pinch
 * and swell, bright knots form and dissolve. A panning bitmap reads as moving
 * wallpaper, which is exactly the "flat and unnatural" problem. Evaluating the
 * field per-pixel per-frame is what buys the deformation.
 *
 * SCOPE NOTE
 * Phase 7 Step B4 banned shaders for SWARM ENEMIES, where a pass would be paid
 * once per entity and multiply by the 200-enemy cap. This is one full-screen
 * background pass whose cost is independent of entity count, so it is outside
 * that rule rather than an exception to it.
 *
 * COST
 * Deliberately no multi-octave noise, no texture lookups, no loops. The whole
 * field is ten transcendentals and one pow per pixel — two warped sine lattices
 * whose interference ridges read as a caustic network. Multi-octave FBM would
 * look marginally better and cost several times more.
 *
 * The GLSL lives here as exported strings so the palette contract can be
 * asserted in Node without a GPU (see tests/caustics-shader.test.js).
 */

/**
 * Background palette, per the art direction for this pass.
 *
 * These are deliberately dark: the "Visual Soup" rule says the Dewling stays
 * findable in a 200-enemy swarm only because nothing else approaches its
 * luminance. A bright cyan pool floor would break that for the whole screen at
 * once, which is worse than any single sprite doing it.
 */
export const CAUSTICS_PALETTE = {
  /** Deep navy floor. */
  deep: '#051121',
  /** Even darker tone pushed into the vignette corners. */
  abyss: '#020912',

  /**
   * Soft halo around each thread — a vibrant marine blue bloom that falls off into
   * the floor colour. This is what the eye reads as "wet" and sun-drenched.
   */
  glow: '#227b9c',

  /**
   * The core of a caustic thread.
   */
  core: '#40e0d0',
};

export const CAUSTICS_TUNING = {
  /**
   * Lattice frequencies.
   */
  scaleA: 30.0,
  scaleB: 47.0,

  /**
   * Global time multiplier. Low: the water undulates, it does not churn.
   */
  timeScale: 0.12,

  /**
   * LAYER 1 — the core. Half-width in pixels.
   */
  lineWidthPx: 0.95,

  /** Anti-alias falloff and soft blur edge in pixels. Higher value = soft bloom blur. */
  lineSoftPx: 2.2,

  /**
   * LAYER 2 — the glow. Half-width in pixels, an order wider than the core.
   * Wide halo gives the pseudo-bloom sunlight dispersion effect.
   */
  glowWidthPx: 16.0,

  /**
   * Falloff exponent for the halo. Smooth falloff for wide bloom spread.
   */
  glowFalloff: 1.2,

  /**
   * Additive weight of the sharp core.
   */
  coreStrength: 0.85,

  /** Additive weight of the soft halo bloom. */
  glowStrength: 1.35,

  /**
   * Extra brightness where the two lattices cross.
   */
  nodeStrength: 0.7,

  /** Half-width of the intersection bloom, in pixels. */
  nodeWidthPx: 6.5,

  /**
   * Field units per UV unit.
   */
  gradCalibration: 0.34,

  /**
   * How far the lit threads travel from the base colour toward the caustic colour.
   */
  intensity: 0.04,

  /** Contribution of the broad sun shafts / god rays. */
  shaftStrength: 0.08,
};

/**
 * '#rrggbb' -> 'vec3(r, g, b)' in 0..1, for baking into GLSL source.
 * @param {string} hex
 * @returns {string}
 */
export function hexToGlslVec3(hex) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  return `vec3(${r.toFixed(5)}, ${g.toFixed(5)}, ${b.toFixed(5)})`;
}

/**
 * Relative luminance of a hex colour, matching the theme.js contract.
 * @param {string} hex
 * @returns {number}
 */
export function paletteLuminance(hex) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Vertex shader — the standard PixiJS v8 mesh transform.
 *
 * The quad is a unit square in local space; the Mesh's own transform stretches
 * it to the viewport, so the fragment shader gets clean 0..1 UVs regardless of
 * screen size.
 */
export const CAUSTICS_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;

out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
}
`;

/**
 * Build the fragment shader with the palette baked in as constants.
 *
 * Baking rather than passing colours as uniforms keeps the uniform group down
 * to the four values that actually change per frame, and lets the constant
 * folder do the rest at compile time.
 *
 * @param {Object} [palette]
 * @returns {string} GLSL source
 */
export function buildCausticsFragment(palette = CAUSTICS_PALETTE, tuning = CAUSTICS_TUNING) {
  const n = (value) => Number(value).toFixed(5);

  return /* glsl */ `
precision highp float;

in vec2 vUV;
out vec4 finalColor;

uniform float uTime;
uniform float uAspect;
uniform vec2 uCamera;
uniform float uIntensity;
uniform float uPixelScale;

const vec3 DEEP  = ${hexToGlslVec3(palette.deep)};
const vec3 ABYSS = ${hexToGlslVec3(palette.abyss)};
const vec3 GLOW  = ${hexToGlslVec3(palette.glow)};
const vec3 CORE  = ${hexToGlslVec3(palette.core)};

const float SCALE_A    = ${n(tuning.scaleA)};
const float SCALE_B    = ${n(tuning.scaleB)};
const float TIME_SCALE = ${n(tuning.timeScale)};
const float LINE_W_PX  = ${n(tuning.lineWidthPx)};
const float LINE_AA_PX = ${n(tuning.lineSoftPx)};
const float GLOW_W_PX  = ${n(tuning.glowWidthPx)};
const float GLOW_FALL  = ${n(tuning.glowFalloff)};
const float CORE_STR   = ${n(tuning.coreStrength)};
const float GLOW_STR   = ${n(tuning.glowStrength)};
const float NODE_STR   = ${n(tuning.nodeStrength)};
const float NODE_W_PX  = ${n(tuning.nodeWidthPx)};
const float SHAFTS     = ${n(tuning.shaftStrength)};

/**
 * Field change per unit UV: the blended lattice frequencies, scaled by the
 * calibration factor that turns them into a real gradient magnitude.
 */
const float GRAD_APPROX = ${n(
    (0.62 * tuning.scaleA + 0.38 * tuning.scaleB) * tuning.gradCalibration
  )};

/**
 * One warped sine lattice.
 *
 * The two-sine domain warp is a cheap stand-in for a noise lookup: it bends the
 * lattice enough that the interference ridges curve and wander like a real
 * caustic web instead of forming an obvious grid.
 */
float causticField(vec2 p, float t) {
    p += vec2(sin(p.y * 1.7 + t), cos(p.x * 1.5 - t * 0.9)) * 0.45;

    float a = sin(p.x + t * 0.6);
    float b = sin(p.y * 1.1 - t * 0.5);
    float c = sin((p.x + p.y) * 0.8 + t * 0.4);
    return (a + b + c) * 0.33333;
}

/**
 * Two counter-drifting lattices, rendered as thin threads.
 *
 * WHY smoothstep AND NOT pow()
 * The web sits at ~30-47x lattice frequency, so a thread is around a pixel wide
 * in field terms. Thinning a ridge with a big pow() exponent makes the line
 * narrower than the pixel grid can represent, and it breaks into crawling
 * dashes the moment the pattern drifts — the classic shimmer.
 *
 * abs(field) is a distance-to-ridge measure, so thresholding it with a width
 * matched to one pixel keeps threads crisp and stable while they move.
 *
 * WHY THE WIDTH IS ANALYTIC AND NOT fwidth()
 * PixiJS v8 compiles this as GLSL ES 1.00 (it injects a "define in varying"
 * compatibility preamble even on a WebGL2 context), and in ES 1.00 the
 * derivative builtins need GL_OES_standard_derivatives. An extension directive
 * must precede all non-preprocessor tokens, and Pixi's preamble is already
 * there, so fwidth() simply cannot be reached from here.
 *
 * NOTE: no backticks in this block — it lives inside a JS template literal.
 *
 * The gradient is analytic anyway: the field is a sum of sines of known
 * frequency, so its change per pixel is GRAD_APPROX * (1 / viewportHeight).
 * That is what uPixelScale carries, and it holds the thread at a constant
 * width across every resolution.
 */
vec3 caustics(vec2 uv, float t) {
    float f1 = causticField(uv * SCALE_A, t);
    float f2 = causticField(uv * SCALE_B + 21.3, -t * 0.75);

    float d = abs(f1 * 0.62 + f2 * 0.38);

    // Field units per screen pixel. Every width is authored in pixels and
    // converted here, so threads keep the same apparent thickness whatever
    // the resolution or the lattice density.
    float perPx = GRAD_APPROX * uPixelScale;

    // LAYER 1 — the core. Tight threshold, hard edges, bright.
    float w  = LINE_W_PX * perPx;
    float aa = LINE_AA_PX * perPx;
    float core = 1.0 - smoothstep(w - aa, w + aa, d);

    // LAYER 2 — the halo. The SAME distance field, thresholded far wider and
    // eased so it falls off smoothly. Adding the two is what fakes a bloom:
    // a bright centre bleeding into the surrounding water, with no blur pass
    // and no render target.
    float glow = 1.0 - smoothstep(0.0, GLOW_W_PX * perPx, d);
    glow = pow(glow, GLOW_FALL);

    // INTERSECTIONS — the product is only large where BOTH lattices sit near a
    // ridge, so knots compound and plain threads do not. This is what real
    // caustics do where their wavefronts cross.
    float nodeW = NODE_W_PX * perPx;
    float n1 = 1.0 - smoothstep(0.0, nodeW, abs(f1));
    float n2 = 1.0 - smoothstep(0.0, nodeW, abs(f2));
    float node = n1 * n2;

    // Packed rather than returned separately so main() stays a single blend.
    return vec3(core, glow, node);
}

/** Slow light shafts angled down from the surface. */
float sunShafts(vec2 uv, float t) {
    float axis = uv.x * 0.75 + uv.y * 1.25;
    float band = sin(axis * 3.0 + sin(axis * 1.3 + t * 0.25)) * 0.5 + 0.5;
    // Fade out toward the floor so the rays feel like they come from above.
    return pow(band, 4.0) * smoothstep(1.0, 0.1, uv.y);
}

void main() {
    // Aspect-correct so caustic cells stay round on any window shape.
    vec2 uv = vUV;
    vec2 p = vec2(uv.x * uAspect, uv.y) + uCamera;

    // One clock for everything, kept slow so the water undulates rather than
    // churns. Scaling here rather than per-term keeps the layers in step.
    float t = uTime * TIME_SCALE;

    vec3 light = caustics(p, t);
    float shafts = sunShafts(uv, t);

    // Vignette, computed from the aspect-corrected centre offset.
    vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
    float vignette = 1.0 - clamp(dot(q, q) * 0.75, 0.0, 1.0);

    vec3 color = mix(ABYSS, DEEP, vignette);

    // Additive, widest and dimmest first, so the layers compound the way light
    // does: halo, then core on top of it, then extra lift at the knots.
    color += GLOW * light.y * GLOW_STR * uIntensity;
    color += CORE * light.x * CORE_STR * uIntensity;
    color += CORE * light.z * NODE_STR * uIntensity;
    color += GLOW * shafts * SHAFTS;

    // CORE is the ceiling. Intersections are allowed to reach it — that is the
    // point of them — but nothing may exceed the brightest authored colour, so
    // additive stacking cannot blow out into white.
    color = min(color, CORE);

    finalColor = vec4(color, 1.0);
}
`;
}

/** Default fragment source, built from the shipped palette. */
export const CAUSTICS_FRAGMENT = buildCausticsFragment();

/**
 * Uniform defaults, in the PixiJS v8 typed-uniform shape.
 * @returns {Object}
 */
export function createCausticsUniforms() {
  return {
    uTime: { value: 0, type: 'f32' },
    uAspect: { value: 1, type: 'f32' },
    uCamera: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uIntensity: { value: CAUSTICS_TUNING.intensity, type: 'f32' },
    /** 1 / viewport height — sets the thread width in pixels. */
    uPixelScale: { value: 1 / 720, type: 'f32' },
  };
}

/**
 * Compile-test the fragment source before handing it to PixiJS.
 *
 * WHY THIS EXISTS: Pixi logs a shader link failure to the console but does not
 * throw, so a try/catch around Shader.from() cannot see it. A broken shader
 * therefore left `usingShader` true and painted nothing — a blank screen rather
 * than the Approach B fallback it was supposed to degrade into.
 *
 * Compiling the source against the real context first turns that silent failure
 * into a normal fallback. The preamble mirrors the ES 1.00 compatibility shim
 * Pixi injects, so this sees the same dialect Pixi will.
 *
 * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
 * @param {string} source - Fragment source, without a Pixi preamble
 * @returns {{ok: boolean, log?: string}}
 */
export function validateFragmentShader(gl, source) {
  if (!gl || typeof gl.createShader !== 'function') return { ok: true };

  const preamble =
    '#ifdef GL_ES\n#define in varying\n#define finalColor gl_FragColor\n' +
    '#define texture texture2D\n#endif\nprecision mediump float;\n';

  // Pixi removes the `out vec4 <name>;` declaration on the ES 1.00 path, since
  // its preamble aliases that name to gl_FragColor. The probe has to do the
  // same or it reports a false failure on a shader Pixi compiles fine —
  // rejecting a working shader is just as bad as missing a broken one.
  const stripped = source.replace(/^[ \t]*out\s+vec4\s+\w+\s*;[ \t]*$/gm, '');

  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) return { ok: true };

  try {
    gl.shaderSource(shader, preamble + stripped);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return { ok: true };
    return { ok: false, log: gl.getShaderInfoLog(shader) || 'unknown compile error' };
  } finally {
    gl.deleteShader(shader);
  }
}
