import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Camera, Color, DoubleSide, DynamicDrawUsage, GridHelper,
  LineBasicMaterial, LineSegments, Mesh, PerspectiveCamera, Scene,
  ShaderMaterial, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BANDS, HISTORY_ROWS } from './audio';

const WIDTH = 14;
const DEPTH = 7.8;
const HEIGHT = 3.2;
const ROW_SUBDIVISIONS = 2;
const SURFACE_ROWS = (HISTORY_ROWS - 1) * ROW_SUBDIVISIONS + 1;
const ROW_STEP = DEPTH / (SURFACE_ROWS - 1);
const AUTO_ROTATE_SPEED = 1.5;
const MAX_PIXEL_RATIO = 2;
const FRONT = DEPTH / 2;
const SIDE = WIDTH / 2;
const START_POSITION = new Vector3(9.4, 7.5, 13.3);
const LOOK_AT = new Vector3(0, 0.87, 0);

const palettes = {
  ember: ['#331655', '#a53680', '#ffb484'],
  jade: ['#103e36', '#40cd98', '#cbffd7'],
  silver: ['#2c2b40', '#7b7e92', '#f8edf5'],
} as const;

export type Palette = keyof typeof palettes;

const vertexShader = `
  attribute float age;
  varying float vAge;
  varying float vHeight;
  varying vec3 vPosition;

  void main() {
    vAge = age;
    vHeight = position.y;
    vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform vec3 lowColor;
  uniform vec3 midColor;
  uniform vec3 highColor;
  varying float vAge;
  varying float vHeight;
  varying vec3 vPosition;

  void main() {
    float level = clamp(vHeight / ${HEIGHT.toFixed(1)}, 0.0, 1.0);
    vec3 color = mix(lowColor, midColor, smoothstep(0.0, 0.57, level));
    color = mix(color, highColor, smoothstep(0.37, 0.94, level));
    vec3 normal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
    if (!gl_FrontFacing) normal = -normal;
    float light = 0.72 + 0.35 * max(dot(normal, normalize(vec3(-0.65, 1.0, 0.8))), 0.0);
    float ageFade = mix(1.0, 0.34, smoothstep(0.04, 1.0, vAge));
    float contour = pow(0.5 + 0.5 * cos(vAge * 188.5), 18.0);
    vec3 phosphor = mix(midColor, highColor, 0.44);
    color = mix(color * light, phosphor, contour * (0.19 + 0.30 * level));
    float opacity = ageFade * (0.15 + 0.40 * level + 0.17 * contour);
    gl_FragColor = vec4(color, opacity);
  }
`;

const traceVertexShader = `
  uniform vec2 viewport;
  attribute vec2 neighbors;
  attribute float side;
  varying float vSide;
  varying float vLevel;

  vec4 projectPoint(vec3 point) {
    return projectionMatrix * modelViewMatrix * vec4(point, 1.0);
  }

  void main() {
    const float bandStep = ${(WIDTH / (BANDS - 1)).toFixed(6)};
    const float halfWidth = ${SIDE.toFixed(1)};
    vec4 center = projectPoint(position);
    vec4 prev = projectPoint(vec3(max(-halfWidth, position.x - bandStep), neighbors.x, position.z));
    vec4 next = projectPoint(vec3(min(halfWidth, position.x + bandStep), neighbors.y, position.z));
    vec2 tangent = (next.xy / next.w - prev.xy / prev.w) * viewport;
    vec2 normal = vec2(-tangent.y, tangent.x) / max(length(tangent), 0.001);
    center.xy += normal * side * 22.0 / viewport * center.w;
    vSide = side;
    vLevel = clamp(position.y / ${HEIGHT.toFixed(1)}, 0.0, 1.0);
    gl_Position = center;
  }
`;

const traceFragmentShader = `
  uniform vec3 glowColor;
  varying float vSide;
  varying float vLevel;

  void main() {
    float distanceSquared = vSide * vSide;
    float core = exp(-distanceSquared * 165.0);
    float halo = 0.45 * exp(-distanceSquared * 16.0) + 0.12 * exp(-distanceSquared * 4.0);
    float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));
    float intensity = mix(0.34, 1.0, smoothstep(0.0, 0.44, vLevel));
    vec3 color = mix(glowColor, vec3(0.94, 1.0, 0.98), core * 0.48);
    gl_FragColor = vec4(color, clamp((core + halo) * edge * intensity, 0.0, 1.0));
  }
`;

function makeTrace() {
  const positions = new Float32Array(BANDS * 2 * 3);
  const sides = new Float32Array(BANDS * 2);
  const neighbors = new Float32Array(BANDS * 2 * 2);
  const indices = new Uint16Array((BANDS - 1) * 6);

  for (let band = 0; band < BANDS; band++) {
    const first = band * 2;
    const x = -SIDE + band * WIDTH / (BANDS - 1);
    positions.set([x, 0, FRONT, x, 0, FRONT], first * 3);
    sides.set([-1, 1], first);
    if (band < BANDS - 1) {
      indices.set([first, first + 2, first + 1, first + 1, first + 2, first + 3], band * 6);
    }
  }

  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage))
    .setAttribute('neighbors', new BufferAttribute(neighbors, 2).setUsage(DynamicDrawUsage))
    .setAttribute('side', new BufferAttribute(sides, 1))
    .setIndex(new BufferAttribute(indices, 1));
}

function makeSurface() {
  const position = new Float32Array(SURFACE_ROWS * BANDS * 3);
  const ages = new Float32Array(SURFACE_ROWS * BANDS);
  const triangles = new Uint16Array((SURFACE_ROWS - 1) * (BANDS - 1) * 6);
  let triangleOffset = 0;

  for (let row = 0; row < SURFACE_ROWS; row++) {
    for (let band = 0; band < BANDS; band++) {
      const index = row * BANDS + band;
      position[index * 3] = -SIDE + band * WIDTH / (BANDS - 1);
      position[index * 3 + 2] = FRONT - row * ROW_STEP;
      ages[index] = row / (SURFACE_ROWS - 1);

      if (row === SURFACE_ROWS - 1 || band === BANDS - 1) continue;
      triangles.set([index, index + 1, index + BANDS, index + 1, index + BANDS + 1, index + BANDS], triangleOffset);
      triangleOffset += 6;
    }
  }

  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(position, 3).setUsage(DynamicDrawUsage))
    .setAttribute('age', new BufferAttribute(ages, 1))
    .setIndex(new BufferAttribute(triangles, 1));
}

function makeFrame() {
  const points = [
    -SIDE, 0, FRONT, SIDE, 0, FRONT,
    SIDE, 0, FRONT, SIDE, 0, -FRONT,
    SIDE, 0, -FRONT, -SIDE, 0, -FRONT,
    -SIDE, 0, -FRONT, -SIDE, 0, FRONT,
  ];
  return new LineSegments(
    new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(points), 3)),
    new LineBasicMaterial({ color: '#665270', transparent: true, opacity: 0.66 }),
  );
}

function projectLabel(camera: Camera, world: Vector3, point: Vector3, label: HTMLElement, width: number, height: number) {
  point.copy(world).project(camera);
  label.style.transform = `translate(${Math.round((point.x + 1) * width / 2)}px, ${Math.round((1 - point.y) * height / 2)}px) translate(-50%, -50%)`;
}

export class Terrain {
  private renderer: WebGLRenderer;
  private camera = new PerspectiveCamera(45, 1, 0.1, 80);
  private scene = new Scene();
  private controls: OrbitControls;
  private geometry = makeSurface();
  private material = new ShaderMaterial({
    uniforms: {
      lowColor: { value: new Color() },
      midColor: { value: new Color() },
      highColor: { value: new Color() },
    },
    vertexShader,
    fragmentShader,
    extensions: { derivatives: true },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  private surface = new Mesh(this.geometry, this.material);
  private trace = new Mesh(makeTrace(), new ShaderMaterial({
    uniforms: {
      glowColor: { value: new Color() },
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
  private projected = new Vector3();
  private labels: [HTMLElement, Vector3][];

  constructor(stage: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    stage.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 8.5;
    this.controls.maxDistance = 34;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    this.resetCamera();

    const grid = new GridHelper(WIDTH, 14, '#40334e', '#3b2d48');
    grid.position.y = -0.04;
    grid.scale.z = DEPTH / WIDTH;
    const gridMaterial = grid.material as LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.46;
    this.surface.frustumCulled = false;
    this.surface.renderOrder = 1;
    this.trace.frustumCulled = false;
    this.trace.renderOrder = 2;
    this.surface.add(this.trace);
    this.scene.add(grid, makeFrame(), this.surface);

    this.labels = [
      [stage.querySelector('[data-axis="low"]')!, new Vector3(-SIDE - 0.25, 0, FRONT + 0.55)],
      [stage.querySelector('[data-axis="high"]')!, new Vector3(SIDE + 0.28, 0, FRONT + 0.55)],
      [stage.querySelector('[data-axis="now"]')!, new Vector3(SIDE + 0.62, 0, FRONT - 0.9)],
      [stage.querySelector('[data-axis="past"]')!, new Vector3(SIDE + 0.62, 0, -FRONT)],
    ];

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
    this.trace.material.uniforms.glowColor.value.set(high);
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

  updateHeights(history: Float32Array, head: number) {
    const positions = this.geometry.getAttribute('position') as BufferAttribute;
    for (let row = 0; row < SURFACE_ROWS; row++) {
      const age = row / ROW_SUBDIVISIONS;
      const sampleRow = Math.floor(age);
      const newer = ((head + sampleRow) % HISTORY_ROWS) * BANDS;
      const older = ((head + Math.min(sampleRow + 1, HISTORY_ROWS - 1)) % HISTORY_ROWS) * BANDS;
      const blend = age - sampleRow;
      const destination = row * BANDS;
      for (let band = 0; band < BANDS; band++) {
        const level = history[newer + band] + (history[older + band] - history[newer + band]) * blend;
        positions.setY(destination + band, Math.max(0.002, level * HEIGHT));
      }
    }
    const tracePositions = this.trace.geometry.getAttribute('position') as BufferAttribute;
    const neighbors = this.trace.geometry.getAttribute('neighbors') as BufferAttribute;
    const lift = 0.024;
    for (let band = 0; band < BANDS; band++) {
      const first = band * 2;
      const height = positions.getY(band) + lift;
      const previous = positions.getY(Math.max(0, band - 1)) + lift;
      const next = positions.getY(Math.min(BANDS - 1, band + 1)) + lift;
      tracePositions.setY(first, height);
      tracePositions.setY(first + 1, height);
      neighbors.setXY(first, previous, next);
      neighbors.setXY(first + 1, previous, next);
    }
    positions.needsUpdate = true;
    tracePositions.needsUpdate = true;
    neighbors.needsUpdate = true;
  }

  render(delta: number, phase: number) {
    // The r147 controls advance auto-rotation once per update.
    // Compensate for differing display refresh rates.
    this.controls.autoRotateSpeed = AUTO_ROTATE_SPEED * delta * 60;
    this.controls.update();
    this.surface.position.z = -phase * ROW_STEP * ROW_SUBDIVISIONS;
    this.renderer.render(this.scene, this.camera);

    for (const [label, world] of this.labels) {
      projectLabel(this.camera, world, this.projected, label, this.width, this.height);
    }
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
  }
}
