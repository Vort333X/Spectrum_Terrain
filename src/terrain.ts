import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CustomBlending,
  DataTexture, DoubleSide, MathUtils, Mesh, MeshBasicMaterial, OneFactor, OneMinusSrcAlphaFactor, PerspectiveCamera, PlaneGeometry,
  LineSegments, Scene, SrcAlphaFactor, ShaderMaterial, Vector2, Vector3, WebGLRenderer, type ColorRepresentation,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BANDS, HISTORY_ROWS, HISTORY_SECONDS, SAMPLES_PER_SECOND } from './audio';
import { Axes } from './axes';
import type { EffectSettings } from './effects';
import { DEFAULT_PALETTE, PALETTES, type Palette } from './palettes';

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
const PLAYER_POSITION = new Vector3(17.0, 7.7, 16.0);
const PLAYER_LOOK_AT = new Vector3(-0.5, 2.75, 0);
const PLAYER_DISTANCE = PLAYER_POSITION.distanceTo(PLAYER_LOOK_AT);
const EMBEDDED_PLAYER_POSITION = new Vector3(14, 4.8, 20).sub(PLAYER_LOOK_AT).setLength(PLAYER_DISTANCE).add(PLAYER_LOOK_AT);
const PLAYER_BOUNDS = [
  ...[-SIDE, SIDE].flatMap((x) => [-FRONT, FRONT].flatMap((z) => [
    new Vector3(x, 0, z),
    new Vector3(x, HEIGHT, z),
  ])),
  new Vector3(-SIDE, DEPTH, -FRONT),
  new Vector3(-SIDE, DEPTH, FRONT),
];

function fitPlayerCamera(camera: PerspectiveCamera, reference: PerspectiveCamera, target: Vector3, width: number, height: number) {
  // Fit the current orbit at its default distance, leaving the user's wheel zoom intact.
  reference.position.copy(camera.position).sub(target).setLength(PLAYER_DISTANCE).add(target);
  reference.aspect = width / height;
  reference.lookAt(target);
  reference.updateProjectionMatrix();
  reference.updateMatrixWorld();

  const projected = new Vector3();
  let left = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const point of PLAYER_BOUNDS) {
    projected.copy(point).project(reference);
    left = Math.min(left, projected.x);
    right = Math.max(right, projected.x);
    top = Math.max(top, projected.y);
    bottom = Math.min(bottom, projected.y);
  }
  const horizontalPadding = Math.min(46, width * 0.04);
  const topPadding = height * 0.045;
  const bottomPadding = Math.min(42, height * 0.16);
  const scale = Math.min(
    2 * (width - 2 * horizontalPadding) / ((right - left) * width),
    2 * (height - topPadding - bottomPadding) / ((top - bottom) * height),
  );

  camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(reference.fov) / 2) / scale));
  const offsetX = (1 + left * scale) * width / 2 - horizontalPadding;
  const offsetY = (1 - (top + bottom) * scale / 2) * height / 2 - (topPadding + height - bottomPadding) / 2;
  camera.setViewOffset(width, height, offsetX, offsetY, width, height);
}

type SpectrumColors = readonly [ColorRepresentation, ColorRepresentation, ColorRepresentation];

interface PaletteTransition {
  from: Color[];
  to: Color[];
  duration: number;
  elapsed: number;
}

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
    vec3 color = mix(lowColor, midColor, smoothstep(0.0, 0.57, level));
    color = mix(color, highColor, smoothstep(0.37, 0.94, level));
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
  uniform vec3 glowColor;
  uniform float glowRadius;
  uniform float glowStrength;
  varying float vSide;
  varying float vLevel;

  void main() {
    float distanceSquared = vSide * vSide;
    float core = exp(-distanceSquared * glowRadius * glowRadius * 1.45);
    float halo = glowStrength * (0.56 * exp(-distanceSquared * 12.0) + 0.18 * exp(-distanceSquared * 3.5));
    float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));
    float intensity = mix(0.34, 1.0, smoothstep(0.0, 0.44, vLevel));
    vec3 color = mix(glowColor, vec3(0.94, 1.0, 0.98), core * 0.48);
    gl_FragColor = vec4(color, clamp((core + halo) * edge * intensity, 0.0, 1.0));
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
  private resizeObserver: ResizeObserver;
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
      glowColor: { value: new Color() },
      glowRadius: { value: 8 },
      glowStrength: { value: 0 },
      viewport: { value: new Vector2(1, 1) },
    },
    vertexShader: traceVertexShader,
    fragmentShader: traceFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  }));
  private width = 1;
  private height = 1;
  private axes: Axes;
  private orbitSpeed = 9;
  private coverMaterial?: MeshBasicMaterial;
  private framingCamera?: PerspectiveCamera;
  private framingDirty = false;
  private paletteTransition?: PaletteTransition;
  private readonly colors: readonly [Color, Color, Color] = [
    this.material.uniforms.lowColor.value,
    this.material.uniforms.midColor.value,
    this.material.uniforms.highColor.value,
  ];

  constructor(stage: HTMLElement, sampleRate: number, wallpaper: boolean, private readonly view: 'terrain' | 'player' | 'embedded-player' = 'terrain') {
    this.heightUniforms.historySpan.value = HISTORY_SECONDS * sampleRate;
    const embedded = this.view === 'embedded-player';
    this.renderer = new WebGLRenderer({ antialias: true, alpha: embedded, powerPreference: 'high-performance' });
    if (embedded) {
      this.renderer.setClearAlpha(0);
      // The transparent drawing buffer composites over the player's own gradient.
      this.material.blendSrcAlpha = OneFactor;
      const glow = this.trace.material;
      glow.blending = CustomBlending;
      glow.blendSrc = SrcAlphaFactor;
      glow.blendDst = OneFactor;
      glow.blendSrcAlpha = OneFactor;
      glow.blendDstAlpha = OneMinusSrcAlphaFactor;
    }
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    stage.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 8.5;
    this.controls.maxDistance = 34;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.view !== 'terrain') {
      this.controls.autoRotate = false;
      this.controls.minDistance = 13;
      this.controls.minAzimuthAngle = 0.32;
      this.controls.maxAzimuthAngle = 1.20;
      this.controls.minPolarAngle = 0.78;
      this.framingCamera = new PerspectiveCamera(45, 1);
      this.addCoverWall();
    }

    this.resetCamera();

    this.axes = new Axes(stage.querySelector('[data-spectrum-axes], #axes')!, { width: WIDTH, depth: DEPTH, height: HEIGHT }, wallpaper);
    this.controls.addEventListener('change', () => {
      this.axes.invalidate();
      if (this.framingCamera) this.framingDirty = true;
    });
    this.surface.frustumCulled = false;
    this.trace.frustumCulled = false;
    this.trace.renderOrder = 2;
    this.surface.add(this.trace);
    this.scene.add(this.axes.group, this.surface);
    this.setPalette(DEFAULT_PALETTE);
    const resize = () => this.resize(stage.clientWidth, stage.clientHeight);
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(stage);
    resize();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.coverMaterial?.map?.dispose();
    this.heightMap.dispose();
    this.rowTexture.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh || object instanceof LineSegments)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  setPalette(name: Palette) {
    this.setColors(PALETTES[name].colors);
  }

  setColors(colors: SpectrumColors, duration = 0) {
    if (duration > 0) {
      this.paletteTransition = {
        from: this.colors.map((color) => color.clone()),
        to: colors.map((color) => new Color(color)),
        duration,
        elapsed: 0,
      };
      return;
    }
    this.paletteTransition = undefined;
    this.colors.forEach((color, index) => color.set(colors[index]));
    this.trace.material.uniforms.glowColor.value.copy(this.colors[2]);
  }

  setCover(canvas: HTMLCanvasElement) {
    if (!this.coverMaterial) return;
    const texture = new CanvasTexture(canvas);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.coverMaterial.map?.dispose();
    this.coverMaterial.map = texture;
    this.coverMaterial.needsUpdate = true;
  }

  private addCoverWall() {
    this.coverMaterial = new MeshBasicMaterial({ toneMapped: false });
    const cover = new Mesh(new PlaneGeometry(DEPTH, DEPTH), this.coverMaterial);
    cover.rotation.y = Math.PI / 2;
    cover.position.set(-SIDE, DEPTH / 2, 0);
    cover.renderOrder = -2;

    const backing = new Mesh(
      new BoxGeometry(0.07, DEPTH, DEPTH),
      new MeshBasicMaterial({ color: '#25252e', toneMapped: false }),
    );
    backing.position.copy(cover.position);
    backing.position.x -= 0.04;
    backing.renderOrder = -3;
    this.scene.add(backing, cover);
  }

  private advancePalette(delta: number) {
    const transition = this.paletteTransition;
    if (!transition) return;
    transition.elapsed += delta;
    const time = Math.min(1, transition.elapsed / transition.duration);
    const blend = time * time * (3 - 2 * time);
    this.colors.forEach((color, index) => color.lerpColors(transition.from[index], transition.to[index], blend));
    this.trace.material.uniforms.glowColor.value.copy(this.colors[2]);
    if (time === 1) this.paletteTransition = undefined;
  }

  applyEffects(settings: EffectSettings) {
    this.axes.visible = settings.axes;
    this.material.uniforms.surfaceOpacity.value = settings.opacity / 100;
    this.material.uniforms.trailOpacity.value = settings.trail / 100;
    this.trace.material.uniforms.glowStrength.value = settings.glow / 100;
    this.trace.material.uniforms.glowRadius.value = settings.radius;
    this.heightUniforms.levelGain.value = settings.gain / 100;
    this.heightUniforms.frequencySmoothing.value = settings.smoothing / 100;
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
    const damping = this.controls.enableDamping;
    if (this.view !== 'terrain') this.controls.enableDamping = false;
    this.controls.reset();
    const position = this.view === 'embedded-player' ? EMBEDDED_PLAYER_POSITION : PLAYER_POSITION;
    this.camera.position.copy(this.view === 'terrain' ? START_POSITION : position);
    this.controls.target.copy(this.view === 'terrain' ? LOOK_AT : PLAYER_LOOK_AT);
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  private packRow(destination: Uint8Array, offset: number, levels: Float32Array, start: number) {
    const last = BANDS - 1;
    for (let band = 0; band < BANDS; band++) {
      const nearLeft = levels[start + Math.max(0, band - 1)];
      const nearRight = levels[start + Math.min(last, band + 1)];
      const farLeft = levels[start + Math.max(0, band - 2)];
      const farRight = levels[start + Math.min(last, band + 2)];
      this.filteredRow[band] = (farLeft + farRight + 4 * (nearLeft + nearRight) + 6 * levels[start + band]) / 16;
    }
    // RG stores the raw curve, BA stores its weighted average for live blending.
    packCurve(destination, offset, levels, start);
    packCurve(destination, offset + 2, this.filteredRow, 0);
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
    if (this.framingCamera && this.framingDirty) {
      fitPlayerCamera(this.camera, this.framingCamera, this.controls.target, this.width, this.height);
      this.framingDirty = false;
    }
    this.advancePalette(delta);
    this.heightUniforms.historyPhase.value = phase;
    this.renderer.render(this.scene, this.camera);

    this.axes.layout(this.camera, this.width, this.height);
  }

  private resize(width: number, height: number) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    if (this.framingCamera) {
      this.framingDirty = true;
    } else {
      this.camera.fov = Math.min(68, 45 * Math.max(1, 1.22 / aspect));
      this.camera.updateProjectionMatrix();
    }
    this.trace.material.uniforms.viewport.value.set(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(this.width, this.height);
    this.axes.invalidate();
  }
}
