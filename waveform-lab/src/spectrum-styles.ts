import {
  AdditiveBlending, BoxGeometry, CustomBlending, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, SrcAlphaFactor,
} from 'three';
import { BANDS } from './audio';

export const BAR_ROWS = 36;
export const RIDGE_ROWS = 12;

interface StyleContext {
  uniforms: ShaderMaterial['uniforms'];
  sampleShader: string;
  width: number;
  depth: number;
  height: number;
}

function instanced(base: BoxGeometry | PlaneGeometry) {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(base.index);
  for (const [name, attribute] of Object.entries(base.attributes)) geometry.setAttribute(name, attribute);
  base.dispose();
  return geometry;
}

function material(uniforms: ShaderMaterial['uniforms'], vertexShader: string, fragmentShader: string) {
  return new ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    extensions: { derivatives: true },
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
}

export class FrequencyBars {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly frontTrace: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private columns = 0;

  constructor(private context: StyleContext) {
    const uniforms = {
      ...context.uniforms,
      barWidth: { value: 1 }, barDepth: { value: 1 }, bandsPerBar: { value: 2 },
    };
    const sampleBar = `
      uniform float bandsPerBar;
      ${context.sampleShader}
      float barLevel(float band, float age) {
        float row = age * historySpan + (1.0 - historyPhase);
        float newer = floor(row);
        float peak = 0.0;
        // Both the body and front trace use the same complete FFT buckets.
        for (int index = 0; index < 4; index++) {
          if (float(index) < bandsPerBar) {
            float column = band - (bandsPerBar - 1.0) + float(index) * 2.0;
            vec2 levels = adjacentLevels(column, newer);
            peak = max(peak, mix(levels.x, levels.y, fract(row)));
          }
        }
        return levelToHeight(peak);
      }
    `;
    this.mesh = new Mesh(new InstancedBufferGeometry(), material(uniforms, `
      attribute vec2 barCenter;
      attribute float barBand;
      attribute float barAge;
      uniform float barWidth;
      uniform float barDepth;
      varying vec3 vLocal;
      varying vec3 vFace;
      varying float vAge;
      varying float vPeak;
      ${sampleBar}
      void main() {
        float height = max(0.002, barLevel(barBand, barAge));
        vLocal = position + 0.5;
        vFace = normal;
        vAge = barAge;
        vPeak = height / ${context.height.toFixed(1)};
        vec3 point = vec3(barCenter.x + position.x * barWidth, vLocal.y * height, barCenter.y + position.z * barDepth);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
      }
    `, `
      uniform vec3 lowColor;
      uniform vec3 midColor;
      uniform vec3 highColor;
      uniform float surfaceOpacity;
      uniform float trailOpacity;
      uniform float glowStrength;
      uniform float glowRadius;
      uniform float displayStyle;
      varying vec3 vLocal;
      varying vec3 vFace;
      varying float vAge;
      varying float vPeak;
      void main() {
        if (vPeak < 0.002) discard;
        vec3 distance = min(vLocal, 1.0 - vLocal);
        vec3 pixel = max(fwidth(vLocal), vec3(0.00001));
        vec3 lines = 1.0 - smoothstep(pixel * 0.25, pixel * (0.8 + glowRadius * 0.12), distance);
        float edge = abs(vFace.y) > 0.5 ? max(lines.x, lines.z)
          : abs(vFace.x) > 0.5 ? max(lines.y, lines.z) : max(lines.x, lines.y);
        float level = clamp(vPeak * vLocal.y, 0.0, 1.0);
        vec3 color = mix(lowColor, midColor, smoothstep(0.0, 0.57, level));
        color = mix(color, highColor, smoothstep(0.37, 0.94, level));
        float light = 0.66 + 0.34 * max(dot(vFace, normalize(vec3(-0.65, 1.0, 0.8))), 0.0);
        float fade = mix(1.0, trailOpacity, smoothstep(0.0, 1.0, vAge));
        float alpha = surfaceOpacity * fade;
        if (displayStyle < 0.5) {
          color = mix(color * light, highColor, edge * glowStrength * 0.48);
          alpha *= 0.35 + 0.38 * vPeak + 0.25 * edge;
        } else if (displayStyle < 1.5) {
          color *= light + 0.18;
          alpha *= 0.90;
        } else {
          if (edge < 0.01) discard;
          color = mix(midColor, highColor, 0.35 + 0.5 * level);
          alpha *= edge * (0.55 + glowStrength * 0.45);
        }
        if (vAge < 0.001) {
          vec3 pale = mix(highColor, vec3(0.96, 1.0, 0.99), 0.78);
          color = mix(color, pale, 0.48 + vLocal.y * 0.40);
          if (displayStyle < 1.5) alpha = max(alpha, surfaceOpacity * (0.62 + 0.25 * vLocal.y));
        }
        gl_FragColor = vec4(color, alpha);
      }
    `));
    const frontMaterial = material(uniforms, `
      attribute vec2 barCenter;
      attribute float barBand;
      uniform float barWidth;
      uniform float barDepth;
      uniform vec2 viewport;
      uniform float glowRadius;
      varying vec2 vOffset;
      varying float vHalfLength;
      varying float vPeak;
      ${sampleBar}
      void main() {
        float height = max(0.002, barLevel(barBand, 0.0));
        float z = barCenter.y + barDepth * 0.5 + 0.006;
        vec4 center = projectionMatrix * modelViewMatrix * vec4(barCenter.x, height + 0.006, z, 1.0);
        vec4 left = projectionMatrix * modelViewMatrix * vec4(barCenter.x - barWidth * 0.5, height + 0.006, z, 1.0);
        vec4 right = projectionMatrix * modelViewMatrix * vec4(barCenter.x + barWidth * 0.5, height + 0.006, z, 1.0);
        vec2 span = (right.xy / right.w - left.xy / left.w) * viewport * 0.5;
        float spanLength = max(length(span), 0.001);
        vec2 tangent = span / spanLength;
        vec2 normal = vec2(-tangent.y, tangent.x);
        vHalfLength = spanLength * 0.5;
        vOffset = vec2(position.x * 2.0 * (vHalfLength + glowRadius * 0.5), position.y * glowRadius);
        center.xy += (tangent * vOffset.x + normal * vOffset.y) * 2.0 / viewport * center.w;
        vPeak = height / ${context.height.toFixed(1)};
        gl_Position = center;
      }
    `, `
      uniform vec3 highColor;
      uniform float glowStrength;
      uniform float glowRadius;
      uniform float surfaceOpacity;
      varying vec2 vOffset;
      varying float vHalfLength;
      varying float vPeak;
      void main() {
        if (vPeak < 0.002) discard;
        float end = max(abs(vOffset.x) - vHalfLength, 0.0);
        float distanceSquared = end * end + vOffset.y * vOffset.y;
        float normalizedDistance = distanceSquared / (glowRadius * glowRadius);
        float core = exp(-distanceSquared * 1.45);
        float halo = glowStrength * (0.56 * exp(-normalizedDistance * 12.0) + 0.18 * exp(-normalizedDistance * 3.5));
        float edge = (1.0 - smoothstep(0.35 * glowRadius, 0.5 * glowRadius, end))
          * (1.0 - smoothstep(0.65 * glowRadius, glowRadius, abs(vOffset.y)));
        float intensity = mix(0.34, 1.0, smoothstep(0.0, 0.35, vPeak));
        vec3 color = mix(highColor, vec3(0.96, 1.0, 0.99), 0.82);
        gl_FragColor = vec4(color, clamp((core + halo) * edge * intensity * surfaceOpacity, 0.0, 1.0));
      }
    `);
    frontMaterial.blending = AdditiveBlending;
    this.frontTrace = new Mesh(new InstancedBufferGeometry(), frontMaterial);
    this.frontTrace.frustumCulled = false;
    this.frontTrace.renderOrder = 2;
    this.mesh.add(this.frontTrace);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.configure(64, 28);
  }

  configure(columns: number, gap: number) {
    const { width, depth } = this.context;
    const fill = 1 - gap / 100;
    this.mesh.material.uniforms.barWidth.value = width / columns * fill;
    this.mesh.material.uniforms.barDepth.value = depth / BAR_ROWS * fill;
    this.mesh.material.uniforms.bandsPerBar.value = BANDS / columns;
    if (this.columns === columns) return;
    this.columns = columns;
    const geometry = instanced(new BoxGeometry(1, 1, 1));
    const count = columns * BAR_ROWS;
    const centers = new Float32Array(count * 2);
    const bands = new Float32Array(count);
    const ages = new Float32Array(count);
    // Draw old rows first for alpha blending. All columns share one draw call.
    for (let instance = 0; instance < count; instance++) {
      const row = BAR_ROWS - 1 - Math.floor(instance / columns);
      const column = instance % columns;
      centers.set([-width / 2 + (column + 0.5) * width / columns, depth / 2 - (row + 0.5) * depth / BAR_ROWS], instance * 2);
      bands[instance] = column * BANDS / columns * 2 + BANDS / columns - 1;
      ages[instance] = row / (BAR_ROWS - 1);
    }
    geometry.setAttribute('barCenter', new InstancedBufferAttribute(centers, 2));
    geometry.setAttribute('barBand', new InstancedBufferAttribute(bands, 1));
    geometry.setAttribute('barAge', new InstancedBufferAttribute(ages, 1));
    geometry.instanceCount = count;
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    const front = instanced(new PlaneGeometry(1, 2));
    front.setAttribute('barCenter', new InstancedBufferAttribute(centers.subarray((count - columns) * 2), 2));
    front.setAttribute('barBand', new InstancedBufferAttribute(bands.subarray(count - columns), 1));
    front.instanceCount = columns;
    this.frontTrace.geometry.dispose();
    this.frontTrace.geometry = front;
  }
}

export function createRidges(context: StyleContext) {
  const geometry = instanced(new PlaneGeometry(context.width, 2, BANDS * 2 - 2, 1));
  geometry.setAttribute('ridgeAge', new InstancedBufferAttribute(Float32Array.from(
    { length: RIDGE_ROWS }, (_, index) => (RIDGE_ROWS - 1 - index) / (RIDGE_ROWS - 1),
  ), 1));
  geometry.instanceCount = RIDGE_ROWS;
  const mesh = new Mesh(geometry, material(context.uniforms, `
    attribute float ridgeAge;
    uniform vec2 viewport;
    uniform float glowRadius;
    varying float vSide;
    varying float vLevel;
    varying float vAge;
    ${context.sampleShader}
    vec4 projected(float column) {
      float height = profileAt(column, ridgeAge).x;
      vec3 point = vec3(column / ${(BANDS * 2 - 2).toFixed(1)} * ${context.width.toFixed(1)} - ${(context.width / 2).toFixed(1)},
        height, ${(context.depth / 2).toFixed(1)} - ridgeAge * ${context.depth.toFixed(1)});
      return projectionMatrix * modelViewMatrix * vec4(point, 1.0);
    }
    void main() {
      float band = uv.x * ${(BANDS * 2 - 2).toFixed(1)};
      vec4 center = projected(band);
      vec4 before = projected(max(0.0, band - 1.0));
      vec4 after = projected(min(${(BANDS * 2 - 2).toFixed(1)}, band + 1.0));
      vec2 tangent = (after.xy / after.w - before.xy / before.w) * viewport;
      vec2 normal = vec2(-tangent.y, tangent.x) / max(length(tangent), 0.001);
      float widthScale = ridgeAge < 0.001 ? 1.0 : 0.75;
      center.xy += normal * position.y * 2.0 * glowRadius * widthScale / viewport * center.w;
      vSide = position.y;
      vLevel = profileAt(band, ridgeAge).x / ${context.height.toFixed(1)};
      vAge = ridgeAge;
      gl_Position = center;
    }
  `, `
    uniform vec3 lowColor;
    uniform vec3 midColor;
    uniform vec3 highColor;
    uniform float surfaceOpacity;
    uniform float trailOpacity;
    uniform float glowRadius;
    uniform float glowStrength;
    uniform float displayStyle;
    varying float vSide;
    varying float vLevel;
    varying float vAge;
    void main() {
      float distance = vSide * vSide;
      float core = exp(-distance * glowRadius * glowRadius * 1.45);
      float halo = glowStrength * (0.45 * exp(-distance * 12.0) + 0.10 * exp(-distance * 3.5));
      float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));
      float front = 1.0 - step(0.001, vAge);
      vec3 color = mix(midColor, highColor, 0.22);
      color = mix(color, mix(highColor, vec3(0.96, 1.0, 0.99), 0.72), front);
      float fade = mix(1.0, trailOpacity, smoothstep(0.0, 1.0, vAge));
      float alpha = core + halo * mix(0.04, 1.0, front);
      if (displayStyle > 0.5 && displayStyle < 1.5) alpha = exp(-distance * glowRadius * glowRadius * 0.55);
      if (displayStyle > 1.5) {
        color = mix(color, vec3(1.0), core * front * 0.24);
        alpha = core + halo * mix(0.04, 1.5, front);
      }
      alpha *= mix(0.62, 1.0, front) * edge * fade * surfaceOpacity * mix(0.25, 1.0, smoothstep(0.0, 0.3, vLevel));
      gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    }
  `));
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}
