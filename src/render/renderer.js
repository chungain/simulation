// Canvas 2D 렌더러. 시나리오(배치)와 시뮬레이션 상태를 위에서 내려다본 평면도로 그린다.
// 색은 모두 CSS 변수(디자인 토큰)에서 읽어 라이트·다크 모드를 따라간다.

import { DEFAULT_FABRICS } from '../sim/engine.js';
import { rectContains } from '../sim/geometry.js';

export const FONT = '"IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';
const TOKENS = ['bg', 'floor', 'zone', 'surface', 'head', 'headInk', 'ink', 'muted', 'line', 'path', 'tape', 'zoneEdge', 'accent', 'warn', 'bad'];
const FALLBACK = {
  bg: '#d9dfdb', floor: '#e4e9e5', zone: '#eef2ef', surface: '#f7f9f8', head: '#25333a', headInk: '#eef3f1', ink: '#1f2a30',
  muted: '#5e6b70', line: '#c3ccc8', path: '#b8c3be', tape: '#e2ae00', zoneEdge: '#c9a000', accent: '#1f7a72', warn: '#d98a1c', bad: '#d6453d',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cy: 0, zoom: 1 }; // 화면 가운데에 오는 월드 좌표와 배율
    this.goal = { cx: 0, cy: 0, zoom: 1 }; // 부드럽게 따라갈 목표
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.reducedMotion = false;
    this.refreshTheme();
  }

  /** CSS 변수에서 색을 다시 읽는다 (다크 모드·data-theme 이 바뀔 때) */
  refreshTheme() {
    const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    this.t = {};
    for (const k of TOKENS) this.t[k] = css?.getPropertyValue(`--${k}`).trim() || FALLBACK[k];
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  /** 편집기·입력 처리에서 쓰는 화면 변환 값 */
  get cam() {
    const { cx, cy, zoom } = this.view;
    return { zoom, ox: this.width / 2 - cx * zoom, oy: this.height / 2 - cy * zoom };
  }

  /** 맵 전체가 화면의 frac 비율 안에 들어오는 배율 */
  fitZoom(scenario, frac = 0.96) {
    const { width: W, height: H } = scenario.layout;
    return Math.max(0.05, Math.min((this.width * frac) / W, (this.height * frac) / H));
  }

  /** 맵 전체가 보이게 바로 맞춘다 (편집 화면). topInset 은 위에 떠 있는 도구 막대 높이 */
  fit(scenario, padding = 24, topInset = 0) {
    const { width: W, height: H } = scenario.layout;
    const zoom = clamp(Math.min((this.width - padding * 2) / W, (this.height - padding * 2 - topInset) / H), 0.15, 4);
    this.setView(W / 2, H / 2 - topInset / 2 / zoom, zoom, true);
  }

  setView(cx, cy, zoom, instant = false) {
    this.goal = { cx, cy, zoom };
    if (instant) this.view = { ...this.goal };
  }

  /** 위치는 초당 5, 배율은 초당 6 비율로 목표를 따라간다 */
  update(dt) {
    const a = 1 - Math.exp(-5 * dt);
    const b = 1 - Math.exp(-6 * dt);
    this.view.cx += (this.goal.cx - this.view.cx) * a;
    this.view.cy += (this.goal.cy - this.view.cy) * a;
    this.view.zoom += (this.goal.zoom - this.view.zoom) * b;
  }

  zoomAt(sx, sy, factor, min = 0.15, max = 6) {
    const z = clamp(this.view.zoom * factor, min, max);
    const [wx, wy] = this.toWorld(sx, sy);
    const cx = wx - (sx - this.width / 2) / z;
    const cy = wy - (sy - this.height / 2) / z;
    this.setView(cx, cy, z, true);
  }

  pan(dx, dy) {
    this.setView(this.view.cx - dx / this.view.zoom, this.view.cy - dy / this.view.zoom, this.view.zoom, true);
  }

  toWorld(sx, sy) {
    const { zoom, ox, oy } = this.cam;
    return [(sx - ox) / zoom, (sy - oy) / zoom];
  }

  toScreen(wx, wy) {
    const { zoom, ox, oy } = this.cam;
    return [wx * zoom + ox, wy * zoom + oy];
  }

  /**
   * @param {object} scenario
   * @param {import('../sim/engine.js').Simulation|null} sim
   * @param {{editing?:boolean, highlightZone?:string|null, overlay?:(ctx:CanvasRenderingContext2D, r:Renderer)=>void,
   *          clock?:number, player?:{x:number,y:number}|null, target?:{x:number,y:number}|null}} opts
   */
  render(scenario, sim, opts = {}) {
    const { ctx, t } = this;
    const { zoom, ox, oy } = this.cam;
    const clock = this.reducedMotion ? 0 : opts.clock ?? 0;
    const blink = this.reducedMotion ? true : Math.floor((opts.clock ?? 0) * 3) % 2 === 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.setTransform(this.dpr * zoom, 0, 0, this.dpr * zoom, this.dpr * ox, this.dpr * oy);

    const { width: W, height: H } = scenario.layout;
    ctx.fillStyle = t.floor;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H, zoom, t, opts.editing);

    const stations = new Map((sim?.stations ?? []).map((st) => [st.zone.id, st]));
    const stopped = new Set([...stations.values()].filter((st) => st.stopped).map((st) => st.zone.id));
    const warnDefault = scenario.view?.wipWarn ?? 6;

    // 회사·현장 영역
    for (const area of scenario.layout.areas ?? []) drawArea(ctx, area, t);
    // 구역 바닥과 테이프
    for (const zone of scenario.zones) drawZoneFloor(ctx, zone, t, opts.highlightZone === zone.id);
    // 사무실 ↔ 공정 데이터 선
    for (const hub of scenario.zones.filter((z) => z.hub)) drawHubLinks(ctx, hub, scenario.zones, t);

    drawPath(ctx, scenario.flow.path, t, clock, opts.editing);

    // 소품과 사람
    const props = scenario.layout.props ?? [];
    const broken = brokenProps(scenario, props, stopped);
    const fabrics = scenario.flow.fabrics?.length ? scenario.flow.fabrics : DEFAULT_FABRICS;
    props.forEach((p, i) => {
      drawProp(ctx, p, t, {
        index: i,
        clock,
        broken: broken.has(i) && blink,
        fabrics,
        station: p.type === 'board' ? stationAt(scenario, stations, p.rect) : null,
      });
    });

    // 구역 이름과 재공 배지 (소품 위에 보이게)
    for (const zone of scenario.zones) {
      drawZoneLabel(ctx, zone, t, {
        wip: sim && zone.station ? sim.zoneWip(zone) : null,
        warn: zone.wipWarn ?? warnDefault,
        editing: opts.editing,
      });
    }

    if (sim) {
      const stages = sim.stagesById;
      for (const st of sim.stations) {
        for (const item of st.processing) {
          drawItem(ctx, item.x, item.y, stages.get(item.stage), item.fabric, t, {
            repair: item.state === 'repair',
            blink,
          });
        }
      }
      for (const item of sim.items) {
        const inLine = item.line && item.progress != null;
        drawItem(ctx, item.x, item.y, stages.get(item.stage), item.fabric, t, {
          alpha: inLine ? 0.35 + 0.65 * item.progress : 1,
          tag: inLine,
        });
      }
      for (const d of sim.discarded) {
        drawItem(ctx, d.x, d.y - (1.5 - d.ttl) * 20, stages.get(d.stage), d.fabric, t, { alpha: Math.min(1, d.ttl), repair: true, blink: true });
      }
    }

    if (opts.target) drawTarget(ctx, opts.target, t, opts.clock ?? 0, this.reducedMotion);
    if (opts.player) drawPlayer(ctx, opts.player, t);
    if (opts.overlay) opts.overlay(ctx, this);
  }

  /** 월드 좌표의 구역 찾기 (위에 그려진 것부터) */
  hitZone(scenario, wx, wy) {
    for (let i = scenario.zones.length - 1; i >= 0; i--) {
      if (rectContains(scenario.zones[i].rect, wx, wy)) return scenario.zones[i];
    }
    return null;
  }
}

// ---------------------------------------------------------------------
// 바닥·구역·통로
// ---------------------------------------------------------------------

function drawGrid(ctx, W, H, z, t, editing) {
  if (editing) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 10) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = 0; y <= H; y += 10) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.strokeStyle = t.line;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 0.5 / z;
    ctx.stroke();
  }
  ctx.beginPath();
  for (let x = 0; x <= W; x += 40) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.strokeStyle = t.line;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawArea(ctx, area, t) {
  const [x, y, w, h] = area.rect;
  ctx.fillStyle = t.zone;
  ctx.globalAlpha = 0.45;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = t.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `700 15px ${FONT}`;
  ctx.fillStyle = t.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(area.icon ? `${area.icon} ${area.name}` : area.name, x + 12, y + 22, w - 24);
}

function drawZoneFloor(ctx, zone, t, current) {
  const [x, y, w, h] = zone.rect;
  ctx.fillStyle = t.zone;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.setLineDash([14, 8]);
  ctx.strokeStyle = current ? t.accent : t.zoneEdge;
  ctx.lineWidth = current ? 4 : 3;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawZoneLabel(ctx, zone, t, { wip, warn, editing }) {
  const [x, y, w] = zone.rect;
  const pillText = !editing && wip != null ? `재공 ${wip}` : null;
  ctx.font = `600 11px ${FONT}`;
  const pw = pillText ? ctx.measureText(pillText).width + 14 : 0;
  ctx.font = `700 13px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = t.ink;
  const label = zone.icon ? `${zone.icon} ${zone.name}` : zone.name;
  // 재공 배지와 겹치지 않게 이름 폭을 줄인다
  ctx.fillText(label, x + 10, y + 18, Math.max(20, w - 20 - (pw ? pw + 4 : 0)));

  if (editing) {
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = t.muted;
    const st = zone.station;
    const meta = !st ? zone.id : st.speed != null ? `${zone.id} · 라인 ${st.speed}px/초` : `${zone.id} · ${st.time}초 × ${st.capacity ?? 1}`;
    ctx.fillText(meta, x + 10, y + 36, w - 20);
    return;
  }
  if (!pillText) return;
  const text = pillText;
  ctx.font = `600 11px ${FONT}`;
  const px = x + w - 8 - pw;
  ctx.fillStyle = wip >= warn ? t.bad : t.muted;
  roundRect(ctx, px, y + 9, pw, 18, 9);
  ctx.fill();
  ctx.fillStyle = t.surface;
  ctx.textAlign = 'center';
  ctx.fillText(text, px + pw / 2, y + 18.5);
}

function drawHubLinks(ctx, hub, zones, t) {
  const [hx, hy, hw, hh] = hub.rect;
  const a = [hx + hw / 2, hy + hh / 2];
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 6]);
  for (const z of zones) {
    if (z === hub || !z.station) continue;
    const [x, y, w, h] = z.rect;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(x + w / 2, y + h / 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPath(ctx, path, t, clock, editing) {
  if (path.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  ctx.strokeStyle = t.path;
  ctx.globalAlpha = editing ? 0.8 : 0.55;
  ctx.lineWidth = 16;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 60px 마다 진행 방향 화살표, 초당 20px 씩 흘러간다
  ctx.strokeStyle = t.floor;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const offset = (clock * 20) % 60;
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    const ang = Math.atan2(by - ay, bx - ax);
    let d = ((offset - acc) % 60 + 60) % 60;
    for (; d < len; d += 60) {
      const px = ax + ((bx - ax) * d) / len;
      const py = ay + ((by - ay) * d) / len;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-3, -4);
      ctx.lineTo(2, 0);
      ctx.lineTo(-3, 4);
      ctx.stroke();
      ctx.restore();
    }
    acc += len;
  }
}

// ---------------------------------------------------------------------
// 소품·사람
// ---------------------------------------------------------------------

/** 멈춘 구역마다 미싱 1대와 가장 가까운 작업자를 고장으로 표시한다 */
function brokenProps(scenario, props, stopped) {
  const out = new Set();
  if (!stopped.size) return out;
  for (const zone of scenario.zones) {
    if (!stopped.has(zone.id)) continue;
    const mi = props.findIndex((p) => p.type === 'machine' && rectContains(zone.rect, ...center(p.rect)));
    if (mi < 0) continue;
    out.add(mi);
    const [mx, my] = center(props[mi].rect);
    let best = -1;
    let bestD = 60;
    props.forEach((p, i) => {
      if (p.type !== 'worker') return;
      const [px, py] = center(p.rect);
      const d = Math.hypot(px - mx, py - my);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) out.add(best);
  }
  return out;
}

function stationAt(scenario, stations, rect) {
  const [cx, cy] = center(rect);
  const zone = scenario.zones.find((z) => z.station && rectContains(z.rect, cx, cy));
  return zone ? stations.get(zone.id) ?? null : null;
}

export function drawProp(ctx, p, t, o = {}) {
  const [x, y, w, h] = p.rect;
  const clock = o.clock ?? 0;
  const i = o.index ?? 0;
  ctx.fillStyle = t.line;
  ctx.strokeStyle = t.line;
  ctx.lineWidth = 1;
  switch (p.type) {
    case 'machine': {
      ctx.fillStyle = o.broken ? t.bad : t.line;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.fillStyle = o.broken ? '#fff' : t.muted;
      roundRect(ctx, x + w * 0.62, y + h * 0.18, w * 0.26, h * 0.64, 2);
      ctx.fill();
      ctx.fillRect(x + w * 0.12, y + h * 0.4, w * 0.5, h * 0.2);
      break;
    }
    case 'table':
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      break;
    case 'desk':
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.fillStyle = t.muted;
      roundRect(ctx, x + w * 0.3, y + 3, w * 0.4, h * 0.3, 1.5);
      ctx.fill();
      break;
    case 'cutter': {
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      // 재단기 헤드가 좌우로 움직인다
      const hx = x + 4 + (Math.sin(clock * 1.6) * 0.5 + 0.5) * (w - 18);
      ctx.fillStyle = t.muted;
      roundRect(ctx, hx, y - 3, 10, h + 6, 2);
      ctx.fill();
      break;
    }
    case 'iron': {
      // 다리미판: 한쪽이 뾰족한 판
      ctx.beginPath();
      ctx.moveTo(x, y + 3);
      ctx.lineTo(x + w * 0.72, y);
      ctx.quadraticCurveTo(x + w, y + h / 2, x + w * 0.72, y + h);
      ctx.lineTo(x, y + h - 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = t.muted;
      roundRect(ctx, x + w * 0.3, y + h * 0.28, w * 0.22, h * 0.44, 3);
      ctx.fill();
      if (clock) {
        // 다림질 김
        for (let k = 0; k < 3; k++) {
          const ph = (clock * 0.8 + k / 3 + i * 0.37) % 1;
          ctx.globalAlpha = 0.5 * (1 - ph);
          ctx.fillStyle = t.surface;
          ctx.beginPath();
          ctx.arc(x + w * 0.41 + Math.sin((ph + k) * 6) * 3, y - ph * 18, 2.5 + ph * 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      break;
    }
    case 'rack':
    case 'rolls': {
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = t.zone;
      ctx.lineWidth = 1.5;
      const rows = Math.max(1, Math.round(h / 18));
      ctx.beginPath();
      for (let r = 1; r < rows; r++) {
        ctx.moveTo(x, y + (h * r) / rows);
        ctx.lineTo(x + w, y + (h * r) / rows);
      }
      ctx.stroke();
      if (p.type === 'rolls') {
        // 원단 롤 단면을 원단 색으로
        const fabrics = o.fabrics ?? DEFAULT_FABRICS;
        const cols = Math.max(1, Math.floor(w / 14));
        let k = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const cx = x + (w * (c + 0.5)) / cols;
            const cy = y + (h * (r + 0.5)) / rows;
            const rad = Math.min(w / cols, h / rows) * 0.36;
            ctx.fillStyle = fabrics[(k++ * 7 + i) % fabrics.length];
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(cx, cy, rad * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;
    }
    case 'pallet': {
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = t.zone;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 1; k < 4; k++) {
        ctx.moveTo(x, y + (h * k) / 4);
        ctx.lineTo(x + w, y + (h * k) / 4);
      }
      ctx.stroke();
      break;
    }
    case 'cart':
      roundRect(ctx, x, y, w, h * 0.78, 3);
      ctx.fill();
      ctx.fillStyle = t.muted;
      ctx.beginPath();
      ctx.arc(x + w * 0.2, y + h * 0.88, h * 0.12, 0, Math.PI * 2);
      ctx.arc(x + w * 0.8, y + h * 0.88, h * 0.12, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'truck': {
      // 짐칸 + 운전석
      const cab = Math.min(w * 0.24, 30);
      roundRect(ctx, x, y, w - cab - 3, h, 3);
      ctx.fill();
      roundRect(ctx, x + w - cab, y + h * 0.12, cab, h * 0.76, 4);
      ctx.fill();
      ctx.fillStyle = t.muted;
      roundRect(ctx, x + w - cab * 0.45, y + h * 0.22, cab * 0.32, h * 0.56, 2);
      ctx.fill();
      break;
    }
    case 'board': {
      const st = o.station;
      ctx.fillStyle = t.surface;
      roundRect(ctx, x, y, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = t.line;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 10px ${FONT}`;
      ctx.fillStyle = t.muted;
      ctx.fillText('완성', x + 8, y + h * 0.32);
      ctx.font = `700 13px ${FONT}`;
      ctx.fillStyle = t.ink;
      ctx.fillText(String(st?.processed ?? 0), x + 8, y + h * 0.7);
      const down = st?.stopped;
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = down ? t.bad : t.accent;
      ctx.fillText(down ? '● 비가동' : '● 가동', x + w - 8, y + h / 2);
      break;
    }
    case 'wall':
      ctx.fillStyle = t.muted;
      ctx.fillRect(x, y, w, h);
      break;
    case 'door':
      ctx.strokeStyle = t.muted;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      break;
    case 'worker':
    case 'manager': {
      // 제자리에서 조금씩 움직인다
      const [cx0, cy0] = center(p.rect);
      const cx = cx0 + Math.sin(clock * 1.7 + i * 1.3) * 1.6;
      const cy = cy0 + Math.cos(clock * 1.3 + i * 0.7) * 1.2;
      ctx.fillStyle = o.broken ? t.bad : p.type === 'manager' ? t.warn : t.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.ink;
      ctx.beginPath();
      ctx.arc(cx, cy - 1, 3, 0, Math.PI * 2);
      ctx.fill();
      return; // 사람에는 이름표를 쓰지 않는다
    }
    default:
      ctx.fillRect(x, y, w, h);
  }
  if (p.label) {
    ctx.fillStyle = t.muted;
    ctx.font = `500 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(p.label, x + w / 2, y + h + 3, Math.max(w, 60));
  }
}

// ---------------------------------------------------------------------
// 물건
// ---------------------------------------------------------------------

/**
 * @param {object} stage stages 의 항목
 * @param {string} fabric 물건이 받은 원단 색
 * @param {{alpha?:number, tag?:boolean, repair?:boolean, blink?:boolean}} o
 */
export function drawItem(ctx, x, y, stage, fabric, t, o = {}) {
  const s = stage?.size ?? 14;
  const u = s / 14;
  const color = stage?.color ?? fabric ?? '#5b6068';
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  switch (stage?.shape) {
    case 'roll':
      ctx.beginPath();
      ctx.arc(x, y, 7 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 2 * u, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'layers':
      // 가로 16px 띠 4겹, 아래로 갈수록 옅게
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = shade(color, k * 0.18);
        ctx.fillRect(x - 8 * u, y - 6.5 * u + k * 3.5 * u, 16 * u, 2.8 * u);
      }
      break;
    case 'pieces':
      for (const [dx, dy, r] of [[-4, -2.5, -0.3], [3.5, -3.5, 0.25], [0, 3, 0.1]]) {
        ctx.save();
        ctx.translate(x + dx * u, y + dy * u);
        ctx.rotate(r);
        roundRect(ctx, -3.2 * u, -2.6 * u, 6.4 * u, 5.2 * u, 1.2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      break;
    case 'bundle':
      roundRect(ctx, x - 7 * u, y - 6 * u, 14 * u, 12 * u, 2);
      ctx.fill();
      ctx.stroke();
      // 흰 태그와 바코드 줄
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 4.5 * u, y - 1 * u, 9 * u, 5 * u);
      ctx.fillStyle = '#1f2a30';
      for (const bx of [-3.2, -1.8, -0.8, 0.6, 1.4, 2.8]) ctx.fillRect(x + bx * u, y + 0.2 * u, 0.7 * u, 2.6 * u);
      break;
    case 'shirt':
      shirtPath(ctx, x, y, u);
      ctx.fill();
      ctx.stroke();
      if (o.tag) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 1.6 * u, y - 4.2 * u, 3.2 * u, 2.4 * u);
      }
      break;
    case 'box':
      ctx.fillRect(x - 7 * u, y - 7 * u, 14 * u, 14 * u);
      ctx.strokeRect(x - 7 * u, y - 7 * u, 14 * u, 14 * u);
      // 원단 색 띠
      ctx.fillStyle = fabric ?? '#5b6068';
      ctx.fillRect(x - 7 * u, y - 1.5 * u, 14 * u, 3 * u);
      break;
    case 'doc':
      // 서류 한 장: 흰 종이, 위쪽 원단 색 띠, 글줄 3개
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 5.5 * u, y - 7 * u, 11 * u, 14 * u);
      ctx.strokeRect(x - 5.5 * u, y - 7 * u, 11 * u, 14 * u);
      ctx.fillStyle = stage?.color ?? fabric ?? '#5b6068';
      ctx.fillRect(x - 5.5 * u, y - 7 * u, 11 * u, 3 * u);
      ctx.fillStyle = '#9aa8a6';
      for (const ly of [-1.5, 1, 3.5]) ctx.fillRect(x - 3.5 * u, y + ly * u, 7 * u, 1 * u);
      break;
    case 'container':
      // 컨테이너: 긴 상자에 세로 골 무늬, 원단 색 띠
      ctx.fillRect(x - 10 * u, y - 5 * u, 20 * u, 10 * u);
      ctx.strokeRect(x - 10 * u, y - 5 * u, 20 * u, 10 * u);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      for (let k = -7; k <= 7; k += 2.8) {
        ctx.moveTo(x + k * u, y - 4 * u);
        ctx.lineTo(x + k * u, y + 4 * u);
      }
      ctx.stroke();
      ctx.fillStyle = fabric ?? '#5b6068';
      ctx.fillRect(x + 6 * u, y - 5 * u, 2.5 * u, 10 * u);
      break;
    case 'square':
      ctx.fillRect(x - 6 * u, y - 6 * u, 12 * u, 12 * u);
      ctx.strokeRect(x - 6 * u, y - 6 * u, 12 * u, 12 * u);
      break;
    default:
      ctx.beginPath();
      ctx.arc(x, y, 6 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
  }
  if (stage?.mark) {
    ctx.strokeStyle = stage.mark === 'check-tape' ? t.tape : stage.shape === 'doc' ? t.accent : '#fff';
    ctx.lineWidth = 2 * u;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 3.2 * u, y + 0.8 * u);
    ctx.lineTo(x - 0.8 * u, y + 3.2 * u);
    ctx.lineTo(x + 3.6 * u, y - 1.8 * u);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  if (o.repair && o.blink) {
    ctx.strokeStyle = t.bad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 10 * u + 1, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function shirtPath(ctx, x, y, u) {
  ctx.beginPath();
  ctx.moveTo(x - 2.6 * u, y - 6 * u);
  ctx.lineTo(x - 7 * u, y - 3.6 * u);
  ctx.lineTo(x - 5.4 * u, y - 0.4 * u);
  ctx.lineTo(x - 3.8 * u, y - 1.4 * u);
  ctx.lineTo(x - 3.8 * u, y + 6 * u);
  ctx.lineTo(x + 3.8 * u, y + 6 * u);
  ctx.lineTo(x + 3.8 * u, y - 1.4 * u);
  ctx.lineTo(x + 5.4 * u, y - 0.4 * u);
  ctx.lineTo(x + 7 * u, y - 3.6 * u);
  ctx.lineTo(x + 2.6 * u, y - 6 * u);
  ctx.quadraticCurveTo(x, y - 3.6 * u, x - 2.6 * u, y - 6 * u);
  ctx.closePath();
}

// ---------------------------------------------------------------------
// 플레이어
// ---------------------------------------------------------------------

function drawPlayer(ctx, p, t) {
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 9, 9, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.tape;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = t.head;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = t.head;
  ctx.font = `700 11px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('나', p.x, p.y + 0.5);
}

function drawTarget(ctx, p, t, clock, still) {
  const r = still ? 10 : 9 + Math.sin(clock * 5) * 3;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function shade(hex, amt) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const f = (c) => {
    const v = amt < 0 ? c * (1 + amt) : c + (255 - c) * amt;
    return Math.round(clamp(v, 0, 255));
  };
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function center([x, y, w, h]) {
  return [x + w / 2, y + h / 2];
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
