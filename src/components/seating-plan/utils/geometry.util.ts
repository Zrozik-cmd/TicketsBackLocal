export type Geometry = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  // ### Размер посчитан холстом, а не задан растягиванием: при открытии проекта узел
  // ### раскладывается сам, а width/height здесь — только для правила вложенности
  autoSize?: boolean;
};

export type NormalizedGeometry = Required<Omit<Geometry, "autoSize">> & { autoSize?: true };

type Point = { x: number; y: number };

const num = (value: any, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function normalizeGeometry(geometry: Geometry = {}): NormalizedGeometry {
  return {
    x: num(geometry.x),
    y: num(geometry.y),
    width: Math.max(0, num(geometry.width)),
    height: Math.max(0, num(geometry.height)),
    rotation: num(geometry.rotation),
    zIndex: num(geometry.zIndex),
    ...(geometry.autoSize === true ? { autoSize: true as const } : {}),
  };
}

export function centerOf(geometry: Geometry): Point {
  const box = normalizeGeometry(geometry);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// ### Углы прямоугольника с учётом поворота вокруг собственного центра
export function cornersOf(geometry: Geometry): Point[] {
  const box = normalizeGeometry(geometry);
  const center = centerOf(box);
  const angle = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];

  if (!box.rotation) return corners;

  return corners.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    };
  });
}

// ### Точка внутри повёрнутого прямоугольника: разворачиваем её обратно и сравниваем
// ### с невернутыми границами — дешевле, чем гонять полигон.
export function containsPoint(container: Geometry, point: Point): boolean {
  const box = normalizeGeometry(container);
  if (!box.width || !box.height) return false;

  const center = centerOf(box);
  const angle = (-box.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const local = {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };

  return (
    local.x >= box.x &&
    local.x <= box.x + box.width &&
    local.y >= box.y &&
    local.y <= box.y + box.height
  );
}

// ### Вложенность объекта в сектор: считаем по всем четырём углам объекта.
// ### Источник истины по правилу вложенности — бек, фронт только показывает результат.
export function containsRect(container: Geometry, inner: Geometry): boolean {
  const box = normalizeGeometry(inner);
  if (!box.width && !box.height) {
    return containsPoint(container, { x: box.x, y: box.y });
  }

  return cornersOf(box).every((corner) => containsPoint(container, corner));
}

// ### Мягкий вариант для конструктора: объект относится к сектору, если внутри его центр
export function centerInside(container: Geometry, inner: Geometry): boolean {
  return containsPoint(container, centerOf(inner));
}
