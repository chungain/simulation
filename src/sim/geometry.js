// 경로·사각형 계산. DOM 에 의존하지 않아 2D/3D 어디서든 재사용한다.

export function buildPath(points) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    segs.push({ ax, ay, bx, by, len, start: total });
    total += len;
  }
  return { points, segs, length: total };
}

export function pointAt(path, d) {
  const { segs } = path;
  if (segs.length === 0) return path.points[0] ? [...path.points[0]] : [0, 0];
  if (d <= 0) return [segs[0].ax, segs[0].ay];
  for (const s of segs) {
    if (d <= s.start + s.len) {
      const t = s.len === 0 ? 0 : (d - s.start) / s.len;
      return [s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t];
    }
  }
  const last = segs[segs.length - 1];
  return [last.bx, last.by];
}

export function rectContains(rect, x, y) {
  const [rx, ry, rw, rh] = rect;
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

/**
 * 경로가 사각형 안을 처음으로 지나는 구간 [enter, exit] (경로 위 거리).
 * 경로가 구역을 지나지 않으면 null.
 */
export function zoneSpan(path, rect, step = 1) {
  if (path.length === 0) return null;
  let enter = null;
  for (let d = 0; d <= path.length + step; d += step) {
    const dd = Math.min(d, path.length);
    const [x, y] = pointAt(path, dd);
    const inside = rectContains(rect, x, y);
    if (enter === null && inside) enter = dd;
    else if (enter !== null && !inside) return { enter, exit: dd };
    if (dd === path.length) break;
  }
  return enter === null ? null : { enter, exit: path.length };
}

/** 점에서 선분까지의 거리와 선분 위 비율 */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { dist: Math.hypot(px - x, py - y), t };
}
