import { BufferAttribute, BufferGeometry, Camera, GridHelper, Group, LineBasicMaterial, LineSegments, Vector3 } from 'three';
import { HISTORY_SECONDS, MAX_HZ, MIN_HZ, WALLPAPER_BANDS } from './audio';

interface Dimensions {
  width: number;
  depth: number;
  height: number;
}

interface Label {
  element: HTMLSpanElement;
  anchor: Vector3;
}

function formatHz(hz: number) {
  return hz < 1000 ? `${hz} Hz` : `${Number((hz / 1000).toFixed(2))} kHz`;
}

export class Axes {
  readonly group = new Group();
  private frame = new LineSegments(new BufferGeometry(), new LineBasicMaterial({
    color: '#595f68',
    transparent: true,
    opacity: 0.73,
  }));
  private labels: Label[] = [];
  private projected = new Vector3();
  private maxHz = 0;
  private dirty = true;

  constructor(private root: HTMLElement, private dimensions: Dimensions, private wallpaper: boolean) {
    const grid = new GridHelper(dimensions.width, 14, '#353940', '#292d34');
    grid.position.y = -0.04;
    grid.scale.z = dimensions.depth / dimensions.width;
    const material = grid.material as LineBasicMaterial;
    material.transparent = true;
    material.opacity = 0.46;
    this.group.add(grid, this.frame);
    this.setMaxFrequency(MAX_HZ);
  }

  set visible(visible: boolean) {
    this.group.visible = visible;
    this.root.hidden = !visible;
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  setMaxFrequency(maxHz: number) {
    if (this.maxHz === maxHz) return;
    this.maxHz = maxHz;
    const { width, depth, height } = this.dimensions;
    const side = width / 2;
    const front = depth / 2;
    const points = [
      -side, 0, front, side, 0, front,
      side, 0, front, side, 0, -front,
      side, 0, -front, -side, 0, -front,
      -side, 0, -front, -side, 0, front,
      -side, 0, front, -side, height, front,
    ];

    this.labels = [];
    const addLabel = (text: string, x: number, y: number, z: number) => {
      const element = document.createElement('span');
      element.className = 'axis-tick';
      element.textContent = text;
      this.labels.push({ element, anchor: new Vector3(x, y, z) });
    };

    const frequencyTicks = this.wallpaper ? [1, WALLPAPER_BANDS, 16, 32, 48] : [
      MIN_HZ, maxHz, ...[100, 500, 1000, 5000].filter((hz) => hz < maxHz * 0.9),
    ];
    for (const tick of frequencyTicks) {
      const fraction = this.wallpaper ? (tick - 1) / (WALLPAPER_BANDS - 1) : Math.log(tick / MIN_HZ) / Math.log(maxHz / MIN_HZ);
      const x = -side + width * fraction;
      points.push(x, 0, front, x, 0, front + 0.16);
      addLabel(this.wallpaper ? String(tick) : formatHz(tick), x, 0, front + 0.50);
    }

    for (const seconds of [0, HISTORY_SECONDS, 1, 2]) {
      const z = front - depth * seconds / HISTORY_SECONDS;
      points.push(side, 0, z, side + 0.20, 0, z);
      addLabel(seconds === 0 ? '0 s' : `−${seconds} s`, side + 0.62, 0, z);
    }

    for (const percent of [100, 50, 25, 75]) {
      const y = height * percent / 100;
      points.push(-side, y, front, -side - 0.14, y, front);
      addLabel(`${percent}%`, -side - 0.56, y, front);
    }

    const legend = document.createElement('div');
    legend.className = 'axis-legend';
    legend.textContent = this.wallpaper
      ? '横轴 频段序号 · 纵深 时间 · 高度 相对强度'
      : '横轴 频率 · 纵深 时间 · 高度 相对强度';
    this.root.replaceChildren(...this.labels.map(({ element }) => element), legend);
    this.frame.geometry.dispose();
    this.frame.geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
    this.invalidate();
  }

  layout(camera: Camera, width: number, height: number) {
    if (!this.dirty || !this.group.visible) return;
    this.dirty = false;
    const occupied: [number, number][] = [];
    for (const { element, anchor } of this.labels) {
      const point = this.projected.copy(anchor).project(camera);
      const x = Math.round((point.x + 1) * width / 2);
      const y = Math.round((1 - point.y) * height / 2);
      const outside = point.z < -1 || point.z > 1 || x < 24 || x > width - 24 || y < 48 || y > height - 30;
      element.hidden = outside || occupied.some(([left, top]) => Math.abs(x - left) < 47 && Math.abs(y - top) < 15);
      if (!element.hidden) {
        occupied.push([x, y]);
        element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
    }
  }
}
