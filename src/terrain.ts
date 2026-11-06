import {
  BufferAttribute, BufferGeometry, Color, CustomBlending, DataTexture, DoubleSide,
  Mesh, OneMinusSrcAlphaFactor, PerspectiveCamera, Scene, SrcAlphaFactor,
  ShaderMaterial, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BANDS, HISTORY_ROWS, HISTORY_SECONDS, SAMPLES_PER_SECOND } from './audio';
import { Axes } from './axes';
import type { EffectSettings } from './effects';

const WIDTH = 14;
const DEPTH = 7.8;
const HEIGHT = 3.2;
const DISPLAY_BANDS = BANDS * 2 - 1;
const BAND_STEP = WIDTH / (DISPLAY_BANDS - 1);
const SURFACE_ROWS = HISTORY_SECONDS * SAMPLES_PER_SECOND + 1;
const ROW_STEP = DEPTH / (SURFACE_ROWS - 1);
const MAX_PIXEL_RATIO = 2;
const FRONT = DEPTH / 2;
const SIDE = WIDTH / 2;
const START_POSITION = new Vector3(9.4, 7.5, 13.3);
const LOOK_AT = new Vector3(0, 0.87, 0);

function gaussianWeights(radius: number, sigma: number) {
  const weights = Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-0.5 * ((index - radius) / sigma) ** 2));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

const DETAIL_WEIGHTS = gaussianWeights(3, 1.25);
const ENVELOPE_WEIGHTS = gaussianWeights(13, 5.0);

const palettes = {
  ember: ['#331655', '#a53680', '#ffb484'],
  jade: ['#103e36', '#40cd98', '#cbffd7'],
  silver: ['#2c2b40', '#7b7e92', '#f8edf5'],
} as const;

export type Palette = keyof typeof palettes;


const sampleHeight = `
uniform sampler2D heightMap;
  uniform float historyHead;
  uniform float historySpan;
  uniform float historyPhase;
  uniform float levelGain;
  uniform float frequencySmoothing;

  float levelAt(float column, float row) {
    const float columns = ${DISPLAY_BANDS.toFixed(1)};
    const float rows = ${HISTORY_ROWS.toFixed(1)};
    float ringRow = mod(historyHead + row, rows);
    vec4 encoded = texture2D(heightMap, vec2((column + 0.5) / columns, (ringRow + 0.5) / rows));
    const vec2 unpack = vec2(256.0, 1.0) * (255.0 / 65535.0);
    return mix(dot(encoded.rg, unpack), dot(encoded.ba, unpack), frequencySmoothing);
  }

  vec2 adjacentLevels(float column, float newer) {
    return vec2(levelAt(column, newer), levelAt(column, newer + 1.0));
  }

  float levelToHeight(float level) {
    return clamp(level * levelGain, 0.0, 1.0) * ${HEIGHT.toFixed(1)};
  }

  vec3 profileAt(float column, float age) {
    // Draw one sample behind so the rolling surface moves continuously between ticks.
    float row = age * historySpan + (1.0 - historyPhase);
    float newer = floor(row);
    float blend = fract(row);
    float left = max(0.0, column - 2.0);
    float right = min(${(DISPLAY_BANDS - 1).toFixed(1)}, column + 2.0);
    vec2 leftLevels = adjacentLevels(left, newer);
    vec2 rightLevels = adjacentLevels(right, newer);
    vec2 levels = adjacentLevels(column, newer);

    float height = levelToHeight(mix(levels.x, levels.y, blend));
    float leftHeight = levelToHeight(mix(leftLevels.x, leftLevels.y, blend));
    float rightHeight = levelToHeight(mix(rightLevels.x, rightLevels.y, blend));
    float slopeX = (rightHeight - leftHeight) / ((right - left) * ${BAND_STEP.toFixed(6)});
    float slopeZ = (levelToHeight(levels.x) - levelToHeight(levels.y)) * historySpan / ${DEPTH.toFixed(1)};
    return vec3(max(0.002, height), slopeX, slopeZ);
  }
`;

const vertexShader = `
  attribute float age;
  attribute float band;
  varying float vAge;
  varying float vHeight;
  varying vec3 vNormal;

  ${sampleHeight}

  void main() {
    vec3 profile = profileAt(band, age);
    vec3 point = vec3(position.x, profile.x, position.z);
    vAge = age;
    vHeight = point.y;
    vNormal = normalize(vec3(-0.65 * profile.y, 1.0, -0.45 * profile.z));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
  }
`;

const fragmentShader = `
  uniform vec3 lowColor;
  uniform vec3 midColor;
  uniform vec3 highColor;
  uniform float surfaceOpacity;
  uniform float trailOpacity;
  varying float vAge;
  varying float vHeight;
  varying vec3 vNormal;

  void main() {
    float level = clamp(vHeight / ${HEIGHT.toFixed(1)}, 0.0, 1.0);
    vec3 color = mix(lowColor, midColor, smoothstep(0.0, 0.49, level));
    color = mix(color, highColor, smoothstep(0.29, 0.82, level));
    vec3 normal = normalize(vNormal);
    float light = 0.80 + 0.26 * max(dot(normal, normalize(vec3(-0.65, 1.0, 0.8))), 0.0);
    float ageFade = mix(1.0, trailOpacity, smoothstep(0.0, 1.0, vAge));
    float stripe = vAge * 188.5;
    float resolved = 1.0 - smoothstep(0.28, 1.0, fwidth(stripe));
    float contour = pow(0.5 + 0.5 * cos(stripe), 14.0) * resolved;
    color = mix(color * light, midColor, contour * 0.20 * (1.0 - vAge));
    float opacity = surfaceOpacity * ageFade * (0.24 + 0.62 * level + 0.12 * contour);
    gl_FragColor = vec4(color, opacity);
  }
`;

const traceVertexShader = `
  uniform vec2 viewport;
  uniform float glowRadius;
  attribute float band;
  attribute float side;
  varying float vSide;
  varying float vLevel;

  ${sampleHeight}

  vec4 projectPoint(float x, float height) {
    vec3 point = vec3(x, height + 0.024, position.z);
    return projectionMatrix * modelViewMatrix * vec4(point, 1.0);
  }

  void main() {
    const float bandStep = ${BAND_STEP.toFixed(6)};
    const float halfWidth = ${SIDE.toFixed(1)};
    const float maxBand = ${(DISPLAY_BANDS - 1).toFixed(1)};
    float centerHeight = profileAt(band, 0.0).x;
    vec4 center = projectPoint(position.x, centerHeight);
    vec4 prev = projectPoint(max(-halfWidth, position.x - bandStep), profileAt(max(0.0, band - 1.0), 0.0).x);
    vec4 next = projectPoint(min(halfWidth, position.x + bandStep), profileAt(min(maxBand, band + 1.0), 0.0).x);
    vec2 tangent = (next.xy / next.w - prev.xy / prev.w) * viewport;
    vec2 normal = vec2(-tangent.y, tangent.x) / max(length(tangent), 0.001);
    center.xy += normal * side * (2.0 * glowRadius) / viewport * center.w;
    vSide = side;
    vLevel = centerHeight / ${HEIGHT.toFixed(1)};
    gl_Position = center;
  }
`;

const traceFragmentShader = `
  uniform vec3 baseColor;
  uniform vec3 glowColor;
  uniform float glowRadius;
  uniform float glowStrength;
  varying float vSide;
  varying float vLevel;

  void main() {
    float distanceSquared = vSide * vSide;
    float core = exp(-distanceSquared * glowRadius * glowRadius * 2.0);
    float halo = glowStrength * (0.34 * exp(-distanceSquared * 16.0) + 0.09 * exp(-distanceSquared * 5.0));
    float edge = 1.0 - smoothstep(0.60, 1.0, abs(vSide));
    float intensity = mix(0.33, 0.93, smoothstep(0.0, 0.68, vLevel));
    vec3 color = mix(baseColor, glowColor, smoothstep(0.08, 0.76, vLevel));
    gl_FragColor = vec4(color, min(1.0, (0.84 * core + halo) * edge * intensity));
  }
`;

function makeTrace() {
  const positions = new Float32Array(DISPLAY_BANDS * 2 * 3);
  const sides = new Float32Array(DISPLAY_BANDS * 2);
  const bands = new Float32Array(DISPLAY_BANDS * 2);
  const indices = new Uint16Array((DISPLAY_BANDS - 1) * 6);

  for (let band = 0; band < DISPLAY_BANDS; band++) {
    const first = band * 2;
    const x = -SIDE + band * BAND_STEP;
    positions.set([x, 0, FRONT, x, 0, FRONT], first * 3);
    sides.set([-1, 1], first);
    bands.set([band, band], first);
    if (band < DISPLAY_BANDS - 1) {
      indices.set([first, first + 2, first + 1, first + 1, first + 2, first + 3], band * 6);
    }
  }

  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(positions, 3))
    .setAttribute('band', new BufferAttribute(bands, 1))
    .setAttribute('side', new BufferAttribute(sides, 1))
    .setIndex(new BufferAttribute(indices, 1));
}

function makeSurface() {
  const position = new Float32Array(SURFACE_ROWS * DISPLAY_BANDS * 3);
  const ages = new Float32Array(SURFACE_ROWS * DISPLAY_BANDS);
  const bands = new Float32Array(SURFACE_ROWS * DISPLAY_BANDS);
  const triangles = new Uint16Array((SURFACE_ROWS - 1) * (DISPLAY_BANDS - 1) * 6);
  let triangleOffset = triangles.length;

  for (let row = 0; row < SURFACE_ROWS; row++) {
    for (let band = 0; band < DISPLAY_BANDS; band++) {
      const index = row * DISPLAY_BANDS + band;
      position[index * 3] = -SIDE + band * BAND_STEP;
      position[index * 3 + 2] = FRONT - row * ROW_STEP;
      ages[index] = row / (SURFACE_ROWS - 1);
      bands[index] = band;

      if (row === SURFACE_ROWS - 1 || band === DISPLAY_BANDS - 1) continue;
      triangleOffset -= 6;
      triangles.set([index, index + 1, index + DISPLAY_BANDS, index + 1, index + DISPLAY_BANDS + 1, index + DISPLAY_BANDS], triangleOffset);
    }
  }

  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(position, 3))
    .setAttribute('age', new BufferAttribute(ages, 1))
    .setAttribute('band', new BufferAttribute(bands, 1))
    .setIndex(new BufferAttribute(triangles, 1));
}

function writeLevel(destination: Uint8Array, offset: number, level: number) {
  const packed = Math.round(level * 65535);
  destination[offset] = packed >> 8;
  destination[offset + 1] = packed & 255;
}

function tangent(left: number, right: number) {
  return left * right > 0 ? 2 * left * right / (left + right) : 0;
}

function packCurve(destination: Uint8Array, offset: number, levels: Float32Array, start: number) {
  let previousRise = 0;
  for (let band = 0; band < BANDS - 1; band++) {
    const first = levels[start + band];
    const second = levels[start + band + 1];
    const rise = second - first;
    const nextRise = band + 2 < BANDS ? levels[start + band + 2] - second : 0;
    // A monotone Hermite midpoint rounds each segment without overshooting its endpoints.
    const midpoint = (first + second) * 0.5 + (tangent(previousRise, rise) - tangent(rise, nextRise)) * 0.125;
    writeLevel(destination, offset, first);
    writeLevel(destination, offset + 4, midpoint);
    offset += 8;
    previousRise = rise;
  }
  writeLevel(destination, offset, levels[start + BANDS - 1]);
}

export class Terrain {
  private renderer: WebGLRenderer;
  private camera = new PerspectiveCamera(45, 1, 0.1, 80);
  private scene = new Scene();
  private controls: OrbitControls;
  private historyBytes = new Uint8Array(DISPLAY_BANDS * HISTORY_ROWS * 4);
  private rowBytes = new Uint8Array(DISPLAY_BANDS * 4);
  private heightMap = new DataTexture(this.historyBytes, DISPLAY_BANDS, HISTORY_ROWS);
  private rowTexture = new DataTexture(this.rowBytes, DISPLAY_BANDS, 1);
  private rowOffset = new Vector2();
  private filteredRow = new Float32Array(BANDS);
  private heightUniforms = {
    heightMap: { value: this.heightMap },
    historyHead: { value: 0 },
    historySpan: { value: 0 },
    historyPhase: { value: 0 },
    levelGain: { value: 1 },
    frequencySmoothing: { value: 0 },
  };
  private geometry = makeSurface();
  private material = new ShaderMaterial({
    uniforms: {
      ...this.heightUniforms,
      lowColor: { value: new Color() },
      midColor: { value: new Color() },
      highColor: { value: new Color() },
      surfaceOpacity: { value: 0 },
      trailOpacity: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    extensions: { derivatives: true },
    // Draw both sides once and blend older rows without adding their light together.
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
    depthWrite: false,
    side: DoubleSide,
  });
  private surface = new Mesh(this.geometry, this.material);
  private trace = new Mesh(makeTrace(), new ShaderMaterial({
    uniforms: {
      ...this.heightUniforms,
      baseColor: { value: new Color() },
      glowColor: { value: new Color() },
      glowRadius: { value: 8 },
      glowStrength: { value: 0 },
      viewport: { value: new Vector2(1, 1) },
    },
    vertexShader: traceVertexShader,
    fragmentShader: traceFragmentShader,
    transparent: true,
    depthWrite: false,
  }));
  private width = 1;
  private height = 1;
  private axes: Axes;
  private orbitSpeed = 9;

  constructor(stage: HTMLElement, sampleRate: number, wallpaper: boolean) {
    this.heightUniforms.historySpan.value = HISTORY_SECONDS * sampleRate;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    stage.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 8.5;
    this.controls.maxDistance = 34;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.resetCamera();

    this.axes = new Axes(stage.querySelector('#axes')!, { width: WIDTH, depth: DEPTH, height: HEIGHT }, wallpaper);
    this.controls.addEventListener('change', () => this.axes.invalidate());
    this.surface.frustumCulled = false;
    this.trace.frustumCulled = false;
    this.trace.renderOrder = 2;
    this.surface.add(this.trace);
    this.scene.add(this.axes.group, this.surface);
    this.setPalette('jade');
    const resize = () => this.resize(stage.clientWidth, stage.clientHeight);
    new ResizeObserver(resize).observe(stage);
    resize();
  }

  setPalette(name: Palette) {
    const [low, mid, high] = palettes[name];
    this.material.uniforms.lowColor.value.set(low);
    this.material.uniforms.midColor.value.set(mid);
    this.material.uniforms.highColor.value.set(high);
    this.trace.material.uniforms.baseColor.value.set(mid);
    this.trace.material.uniforms.glowColor.value.set(high);
  }

  applyEffects(settings: EffectSettings) {
    this.axes.visible = settings.axes;
    this.material.uniforms.surfaceOpacity.value = settings.opacity / 100;
    this.material.uniforms.trailOpacity.value = settings.trail / 100;
    this.trace.material.uniforms.glowStrength.value = settings.glow / 100;
    this.trace.material.uniforms.glowRadius.value = settings.radius;
    this.heightUniforms.levelGain.value = settings.gain / 100;
    this.heightUniforms.frequencySmoothing.value = 1 - (1 - settings.smoothing / 100) ** 3;
    this.orbitSpeed = settings.orbitspeed;
  }

  setMaxFrequency(maxHz: number) {
    this.axes.setMaxFrequency(maxHz);
  }

  get autoRotate() {
    return this.controls.autoRotate;
  }

  set autoRotate(enabled: boolean) {
    this.controls.autoRotate = enabled;
  }

  resetCamera() {
    this.controls.reset();
    this.camera.position.copy(START_POSITION);
    this.controls.target.copy(LOOK_AT);
    this.controls.update();
  }

  private packRow(destination: Uint8Array, offset: number, levels: Float32Array, start: number) {
    // Store both envelopes so the smoothing control also works on frozen history.
    this.filterRow(levels, start, DETAIL_WEIGHTS);
    packCurve(destination, offset, this.filteredRow, 0);
    this.filterRow(levels, start, ENVELOPE_WEIGHTS);
    packCurve(destination, offset + 2, this.filteredRow, 0);
  }

  private filterRow(levels: Float32Array, start: number, weights: number[]) {
    const radius = (weights.length - 1) / 2;
    for (let band = 0; band < BANDS; band++) {
      let value = 0;
      for (let index = 0; index < weights.length; index++) {
        const sourceBand = Math.max(0, Math.min(BANDS - 1, band + index - radius));
        value += levels[start + sourceBand] * weights[index];
      }
      this.filteredRow[band] = value;
    }
  }

  replaceHistory(levels: Float32Array) {
    for (let row = 0; row < HISTORY_ROWS; row++) {
      this.packRow(this.historyBytes, row * this.rowBytes.length, levels, row * BANDS);
    }
    this.heightUniforms.historyHead.value = 0;
    this.heightMap.needsUpdate = true;
  }

  pushRow(row: number, levels: Float32Array) {
    this.packRow(this.rowBytes, 0, levels, 0);
    this.historyBytes.set(this.rowBytes, row * this.rowBytes.length);
    this.heightUniforms.historyHead.value = row;
    this.rowOffset.y = row;
    if (!this.renderer.getContext().isContextLost()) {
      this.renderer.copyTextureToTexture(this.rowOffset, this.rowTexture, this.heightMap);
    }
  }

  render(delta: number, phase: number) {
    // The r147 controls advance auto-rotation once per update.
    // Compensate for differing display refresh rates.
    this.controls.autoRotateSpeed = this.orbitSpeed / 6 * delta * 60;
    this.controls.update();
    this.heightUniforms.historyPhase.value = phase;
    this.renderer.render(this.scene, this.camera);

    this.axes.layout(this.camera, this.width, this.height);
  }

  private resize(width: number, height: number) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    this.camera.fov = Math.min(68, 45 * Math.max(1, 1.22 / aspect));
    this.camera.updateProjectionMatrix();
    this.trace.material.uniforms.viewport.value.set(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(this.width, this.height);
    this.axes.invalidate();
  }
}
