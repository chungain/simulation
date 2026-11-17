// 맵 위 편집: 구역·소품 끌어 옮기기/크기 바꾸기, 경로 점 찍기, 처리 자리 옮기기, 실행 취소.
// 편집 대상은 시나리오 객체(draft) 하나이고, 바뀔 때마다 onChange 를 부른다.

import { distToSegment } from '../sim/geometry.js';
import { slotPositions } from '../sim/engine.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const MIN_SIZE = 10;

export class Editor {
  constructor({ onChange, onSelect }) {
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.draft = null;
    this.selection = null; // {kind:'zone'|'prop'|'point'|'slot', index, slot?}
    this.tool = 'select'; // select | path | add-zone | add-prop
    this.newPropType = 'machine';
    this.snap = 10;
    this.undoStack = [];
    this.redoStack = [];
    this.drag = null;
    this.hover = null;
    this.lastMutateKey = null;
    this.lastMutateAt = 0;
  }

  load(scenario) {
    this.draft = scenario;
    this.selection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.drag = null;
    this.onSelect?.();
  }

  // ---------- 변경 기록 ----------

  checkpoint() {
    this.undoStack.push(JSON.stringify(this.draft));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastMutateKey = null;
  }

  /** 입력 칸처럼 연속으로 바뀌는 변경은 같은 key 면 실행 취소 한 번으로 묶는다 */
  mutate(key, fn) {
    const now = performance.now();
    if (key == null || key !== this.lastMutateKey || now - this.lastMutateAt > 1500) {
      this.checkpoint();
    }
    this.lastMutateKey = key;
    this.lastMutateAt = now;
    fn(this.draft);
    this.onChange();
  }

  replaceDraft(scenario) {
    this.checkpoint();
    this.draft = scenario;
    this.selection = null;
    this.onSelect?.();
    this.onChange();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(this.undoStack.pop());
    this.afterHistory();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(this.redoStack.pop());
    this.afterHistory();
  }

  afterHistory() {
    this.lastMutateKey = null;
    if (!this.selectionTarget()) this.selection = null;
    this.onSelect?.();
    this.onChange();
  }

  // ---------- 선택 ----------

  select(sel) {
    this.selection = sel;
    this.onSelect?.();
  }

  selectionTarget() {
    const s = this.selection;
    const d = this.draft;
    if (!s || !d) return null;
    if (s.kind === 'zone' || s.kind === 'slot') return d.zones[s.index] ?? null;
    if (s.kind === 'prop') return d.layout.props?.[s.index] ?? null;
    if (s.kind === 'point') return d.flow.path[s.index] ?? null;
    return null;
  }

  selectedRect() {
    const s = this.selection;
    if (!s) return null;
    if (s.kind === 'zone' || s.kind === 'slot') return this.draft.zones[s.index]?.rect ?? null;
    if (s.kind === 'prop') return this.draft.layout.props?.[s.index]?.rect ?? null;
    return null;
  }

  // ---------- 구조 변경 ----------

  addZone(rect) {
    const d = this.draft;
    const id = uniqueId('zone', d.zones.map((z) => z.id));
    const n = d.zones.length + 1;
    this.mutate(null, () => {
      d.zones.push({ id, name: `새 구역 ${n}`, icon: '📍', rect, content: { does: '', people: '', data: [], point: '' } });
    });
    this.select({ kind: 'zone', index: d.zones.length - 1 });
  }

  addProp(rect) {
    const d = this.draft;
    this.mutate(null, () => {
      d.layout.props ??= [];
      d.layout.props.push({ type: this.newPropType, rect });
    });
    this.select({ kind: 'prop', index: d.layout.props.length - 1 });
  }

  duplicateSelection() {
    const s = this.selection;
    const d = this.draft;
    if (!s) return;
    if (s.kind === 'zone') {
      const src = structuredClone(d.zones[s.index]);
      src.id = uniqueId(src.id.replace(/-\d+$/, ''), d.zones.map((z) => z.id));
      src.name = `${src.name} 복사본`;
      src.rect = [src.rect[0] + 20, src.rect[1] + 20, src.rect[2], src.rect[3]];
      if (src.station?.slots) src.station.slots = src.station.slots.map(([x, y]) => [x + 20, y + 20]);
      this.mutate(null, () => d.zones.push(src));
      this.select({ kind: 'zone', index: d.zones.length - 1 });
    } else if (s.kind === 'prop') {
      const src = structuredClone(d.layout.props[s.index]);
      src.rect = [src.rect[0] + 20, src.rect[1] + 20, src.rect[2], src.rect[3]];
      this.mutate(null, () => d.layout.props.push(src));
      this.select({ kind: 'prop', index: d.layout.props.length - 1 });
    }
  }

  deleteSelection() {
    const s = this.selection;
    const d = this.draft;
    if (!s) return;
    if (s.kind === 'zone') {
      const id = d.zones[s.index].id;
      this.mutate(null, () => {
        d.zones.splice(s.index, 1);
        for (const ev of d.events) {
          for (const key of ['stopZones', 'defectZones']) {
            if (!ev.effect[key]) continue;
            ev.effect[key] = ev.effect[key].filter((z) => z !== id);
            if (!ev.effect[key].length) delete ev.effect[key];
          }
        }
      });
    } else if (s.kind === 'prop') {
      this.mutate(null, () => d.layout.props.splice(s.index, 1));
    } else if (s.kind === 'point') {
      if (d.flow.path.length <= 2) return; // 경로는 점 두 개 이상
      this.mutate(null, () => d.flow.path.splice(s.index, 1));
    } else if (s.kind === 'slot') {
      const st = d.zones[s.index].station;
      if (!st?.slots || st.slots.length <= 1) return;
      this.mutate(null, () => st.slots.splice(s.slot, 1));
      this.select({ kind: 'zone', index: s.index });
      return;
    }
    this.select(null);
  }

  /** 구역 id 를 바꾸면 돌발 상황의 참조도 같이 바꾼다 */
  renameZone(index, newId) {
    const d = this.draft;
    const old = d.zones[index].id;
    this.mutate(`zone-id-${index}`, () => {
      d.zones[index].id = newId;
      for (const ev of d.events) {
        for (const key of ['stopZones', 'defectZones']) {
          if (ev.effect[key]) ev.effect[key] = ev.effect[key].map((z) => (z === old ? newId : z));
        }
      }
    });
  }

  /** 상태 id 를 바꾸면 공정과 투입 상태의 참조도 같이 바꾼다 */
  renameStage(index, newId) {
    const d = this.draft;
    const old = d.stages[index].id;
    this.mutate(`stage-id-${index}`, () => {
      d.stages[index].id = newId;
      for (const z of d.zones) {
        if (z.station?.stage === old) z.station.stage = newId;
        if (z.station?.workingStage === old) z.station.workingStage = newId;
      }
      if (d.flow.spawnStage === old) d.flow.spawnStage = newId;
    });
  }

  /** 처리 자리를 직접 지정하도록 자동 배치 위치를 복사해 둔다 */
  materializeSlots(index) {
    const z = this.draft.zones[index];
    if (!z.station || z.station.speed != null) return;
    this.mutate(null, () => {
      z.station.slots = slotPositions({ ...z, station: { ...z.station, slots: undefined } }, z.station.capacity ?? 1).map(
        ([x, y]) => [Math.round(x), Math.round(y)],
      );
    });
  }

  // ---------- 포인터 ----------

  snapValue(v, e) {
    if (e?.altKey || !this.snap) return Math.round(v);
    return Math.round(v / this.snap) * this.snap;
  }

  /** @returns {boolean} 편집기가 처리했으면 true (아니면 화면 이동) */
  onPointerDown(wx, wy, e, r) {
    if (!this.draft) return false;
    const tol = 8 / r.cam.zoom;
    const d = this.draft;

    if (this.tool === 'add-zone' || this.tool === 'add-prop') {
      const x = this.snapValue(wx, e);
      const y = this.snapValue(wy, e);
      this.drag = { type: 'create', x0: x, y0: y, x1: x, y1: y };
      return true;
    }

    // 경로 점 (모든 도구에서 잡을 수 있다)
    const pi = this.hitPoint(wx, wy, tol);
    if (pi >= 0) {
      if (e.button === 2 || (this.tool === 'path' && (e.altKey || e.metaKey || e.ctrlKey))) {
        this.select({ kind: 'point', index: pi });
        this.deleteSelection();
        return true;
      }
      this.select({ kind: 'point', index: pi });
      this.startDrag({ type: 'point', index: pi, orig: [...d.flow.path[pi]], wx, wy });
      return true;
    }

    if (this.tool === 'path') {
      if (e.button === 2) return true;
      const seg = this.hitSegment(wx, wy, tol);
      if (seg >= 0) {
        // 선 위에 끼우는 점은 격자에 맞추지 않고 선 위에 그대로 둔다 (선이 꺾이지 않게)
        const [a, b] = [d.flow.path[seg], d.flow.path[seg + 1]];
        const { t } = distToSegment(wx, wy, a[0], a[1], b[0], b[1]);
        const p = [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)];
        this.mutate(null, () => d.flow.path.splice(seg + 1, 0, p));
        this.select({ kind: 'point', index: seg + 1 });
        this.startDrag({ type: 'point', index: seg + 1, orig: [...p], wx, wy, committed: true });
      } else {
        const p = [this.snapValue(wx, e), this.snapValue(wy, e)];
        this.mutate(null, () => d.flow.path.push(p));
        this.select({ kind: 'point', index: d.flow.path.length - 1 });
      }
      return true;
    }

    // 선택한 대상의 크기 조절 손잡이
    const rect = this.selectedRect();
    if (rect && this.selection.kind !== 'slot') {
      const h = hitHandle(rect, wx, wy, tol);
      if (h) {
        this.startDrag({ type: 'resize', handle: h, orig: [...rect], wx, wy, sel: this.selection });
        return true;
      }
    }

    // 선택한 구역의 처리 자리
    const sel = this.selection;
    if (sel && (sel.kind === 'zone' || sel.kind === 'slot')) {
      const slots = d.zones[sel.index]?.station?.slots;
      if (slots) {
        const si = slots.findIndex(([x, y]) => Math.hypot(x - wx, y - wy) <= tol * 1.2);
        if (si >= 0) {
          this.select({ kind: 'slot', index: sel.index, slot: si });
          this.startDrag({ type: 'slot', index: sel.index, slot: si, orig: [...slots[si]], wx, wy });
          return true;
        }
      }
    }

    // 소품 → 구역 순서(위에 그려진 것부터)
    const props = d.layout.props ?? [];
    for (let i = props.length - 1; i >= 0; i--) {
      if (inRect(props[i].rect, wx, wy)) {
        this.select({ kind: 'prop', index: i });
        this.startDrag({ type: 'move', orig: [...props[i].rect], wx, wy, sel: this.selection });
        return true;
      }
    }
    for (let i = d.zones.length - 1; i >= 0; i--) {
      if (inRect(d.zones[i].rect, wx, wy)) {
        this.select({ kind: 'zone', index: i });
        const z = d.zones[i];
        this.startDrag({
          type: 'move',
          orig: [...z.rect],
          origSlots: z.station?.slots?.map((p) => [...p]),
          wx,
          wy,
          sel: this.selection,
          withProps: e.shiftKey,
        });
        return true;
      }
    }

    this.select(null);
    return false;
  }

  startDrag(drag) {
    this.drag = { ...drag, moved: false, committed: drag.committed ?? false };
  }

  onPointerMove(wx, wy, e, r) {
    const drag = this.drag;
    if (!drag) {
      this.hover = this.draft ? { wx, wy, seg: this.tool === 'path' ? this.hitSegment(wx, wy, 8 / r.cam.zoom) : -1 } : null;
      return;
    }
    const d = this.draft;
    if (drag.type === 'create') {
      drag.x1 = this.snapValue(wx, e);
      drag.y1 = this.snapValue(wy, e);
      return;
    }
    const dx = wx - drag.wx;
    const dy = wy - drag.wy;
    if (!drag.moved && Math.hypot(dx, dy) * r.cam.zoom < 3) return;
    if (!drag.committed) {
      this.checkpoint();
      drag.committed = true;
    }
    drag.moved = true;

    if (drag.type === 'point') {
      d.flow.path[drag.index] = [this.snapValue(drag.orig[0] + dx, e), this.snapValue(drag.orig[1] + dy, e)];
    } else if (drag.type === 'slot') {
      d.zones[drag.index].station.slots[drag.slot] = [this.snapValue(drag.orig[0] + dx, e), this.snapValue(drag.orig[1] + dy, e)];
    } else if (drag.type === 'move') {
      const target = this.selectedRect();
      const nx = this.snapValue(drag.orig[0] + dx, e);
      const ny = this.snapValue(drag.orig[1] + dy, e);
      target[0] = nx;
      target[1] = ny;
      if (drag.origSlots) {
        const sx = nx - drag.orig[0];
        const sy = ny - drag.orig[1];
        d.zones[drag.sel.index].station.slots = drag.origSlots.map(([x, y]) => [x + sx, y + sy]);
      }
    } else if (drag.type === 'resize') {
      const target = this.selectedRect();
      let [x, y, w, h] = drag.orig;
      let x2 = x + w;
      let y2 = y + h;
      const hd = drag.handle;
      if (hd.includes('w')) x = Math.min(this.snapValue(drag.orig[0] + dx, e), x2 - MIN_SIZE);
      if (hd.includes('e')) x2 = Math.max(this.snapValue(x2 + dx, e), x + MIN_SIZE);
      if (hd.includes('n')) y = Math.min(this.snapValue(drag.orig[1] + dy, e), y2 - MIN_SIZE);
      if (hd.includes('s')) y2 = Math.max(this.snapValue(y2 + dy, e), y + MIN_SIZE);
      target[0] = x;
      target[1] = y;
      target[2] = x2 - x;
      target[3] = y2 - y;
    }
    this.onChange({ live: true });
  }

  onPointerUp() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.type === 'create') {
      let x = Math.min(drag.x0, drag.x1);
      let y = Math.min(drag.y0, drag.y1);
      let w = Math.abs(drag.x1 - drag.x0);
      let h = Math.abs(drag.y1 - drag.y0);
      const isZone = this.tool === 'add-zone';
      const person = !isZone && (this.newPropType === 'worker' || this.newPropType === 'manager');
      if (person) {
        // 사람은 크기가 정해져 있다 (누른 곳이 가운데)
        [x, y, w, h] = [drag.x1 - 7, drag.y1 - 7, 14, 14];
      } else if (w < 20 || h < 20) {
        // 클릭만 했으면 기본 크기로 만든다
        [w, h] = isZone ? [180, 140] : [60, 36];
      }
      if (isZone) this.addZone([x, y, w, h]);
      else this.addProp([x, y, w, h]);
      this.tool = 'select';
      this.onSelect?.();
      return;
    }
    if (drag.moved) this.onChange();
  }

  onKeyDown(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelection();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelection();
      return true;
    }
    if (e.key === 'Escape') {
      if (this.tool !== 'select') this.tool = 'select';
      this.select(null);
      return true;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && this.selection) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const [ax, ay] = arrows[e.key];
      this.nudge(ax * step, ay * step);
      return true;
    }
    return false;
  }

  nudge(dx, dy) {
    const s = this.selection;
    const d = this.draft;
    this.mutate('nudge', () => {
      if (s.kind === 'point') {
        d.flow.path[s.index][0] += dx;
        d.flow.path[s.index][1] += dy;
      } else if (s.kind === 'slot') {
        const p = d.zones[s.index].station.slots[s.slot];
        p[0] += dx;
        p[1] += dy;
      } else {
        const r = this.selectedRect();
        r[0] += dx;
        r[1] += dy;
        if (s.kind === 'zone') {
          const slots = d.zones[s.index].station?.slots;
          if (slots) for (const p of slots) {
            p[0] += dx;
            p[1] += dy;
          }
        }
      }
    });
  }

  cursorAt(wx, wy, r) {
    if (!this.draft) return 'default';
    if (this.drag) return this.drag.type === 'resize' ? CURSORS[this.drag.handle] : 'grabbing';
    if (this.tool === 'add-zone' || this.tool === 'add-prop') return 'crosshair';
    const tol = 8 / r.cam.zoom;
    if (this.hitPoint(wx, wy, tol) >= 0) return 'move';
    if (this.tool === 'path') return this.hitSegment(wx, wy, tol) >= 0 ? 'copy' : 'crosshair';
    const rect = this.selectedRect();
    if (rect && this.selection.kind !== 'slot') {
      const h = hitHandle(rect, wx, wy, tol);
      if (h) return CURSORS[h];
    }
    const d = this.draft;
    if ((d.layout.props ?? []).some((p) => inRect(p.rect, wx, wy)) || d.zones.some((z) => inRect(z.rect, wx, wy))) return 'move';
    return 'grab';
  }

  hitPoint(wx, wy, tol) {
    const path = this.draft.flow.path;
    for (let i = path.length - 1; i >= 0; i--) {
      if (Math.hypot(path[i][0] - wx, path[i][1] - wy) <= tol) return i;
    }
    return -1;
  }

  hitSegment(wx, wy, tol) {
    const path = this.draft.flow.path;
    let best = -1;
    let bestDist = tol;
    for (let i = 0; i < path.length - 1; i++) {
      const { dist } = distToSegment(wx, wy, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
      if (dist <= bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    return best;
  }

  // ---------- 그리기 ----------

  drawOverlay(ctx, r) {
    const d = this.draft;
    if (!d) return;
    const z = r.cam.zoom;
    const px = 1 / z;

    // 선택 표시
    const rect = this.selectedRect();
    if (rect) {
      const [x, y, w, h] = rect;
      ctx.strokeStyle = '#2a6fdb';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, w, h);
      if (this.selection.kind !== 'slot') {
        for (const hd of HANDLES) {
          const [hx, hy] = handlePos(rect, hd);
          const s = 8 * px;
          ctx.fillStyle = '#fff';
          ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
          ctx.strokeRect(hx - s / 2, hy - s / 2, s, s);
        }
      }
      ctx.fillStyle = '#2a6fdb';
      ctx.font = `${11 * px}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${x}, ${y}  ${w}×${h}`, x, y - 3 * px);
    }

    // 선택한 구역의 처리 자리
    const sel = this.selection;
    if (sel && (sel.kind === 'zone' || sel.kind === 'slot')) {
      const zone = d.zones[sel.index];
      if (zone?.station && zone.station.speed == null) {
        const explicit = !!zone.station.slots?.length;
        const slots = explicit ? zone.station.slots : slotPositions(zone, zone.station.capacity ?? 1);
        slots.forEach(([x, y], i) => {
          ctx.beginPath();
          ctx.arc(x, y, 7 * px, 0, Math.PI * 2);
          ctx.fillStyle = sel.kind === 'slot' && sel.slot === i ? '#2a6fdb' : explicit ? 'rgba(42,111,219,0.25)' : 'rgba(0,0,0,0.08)';
          ctx.fill();
          ctx.strokeStyle = explicit ? '#2a6fdb' : 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1.5 * px;
          ctx.setLineDash(explicit ? [] : [3 * px, 3 * px]);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }
    }

    // 경로 점
    const path = d.flow.path;
    if (this.tool === 'path' && this.hover && this.hover.seg >= 0 && !this.drag) {
      const a = path[this.hover.seg];
      const b = path[this.hover.seg + 1];
      const { t } = distToSegment(this.hover.wx, this.hover.wy, a[0], a[1], b[0], b[1]);
      ctx.beginPath();
      ctx.arc(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 5 * px, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(42,111,219,0.5)';
      ctx.fill();
    }
    path.forEach(([x, y], i) => {
      const selected = sel?.kind === 'point' && sel.index === i;
      ctx.beginPath();
      ctx.arc(x, y, (selected ? 8 : 6) * px, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#2f9e72' : i === path.length - 1 ? '#d9534f' : '#fff';
      ctx.fill();
      ctx.strokeStyle = '#2a6fdb';
      ctx.lineWidth = (selected ? 3 : 2) * px;
      ctx.stroke();
      ctx.fillStyle = '#1d3f80';
      ctx.font = `600 ${10 * px}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(i === 0 ? '투입' : i === path.length - 1 ? '끝' : String(i), x + 8 * px, y - 4 * px);
    });

    // 새로 그리는 사각형
    if (this.drag?.type === 'create') {
      const { x0, y0, x1, y1 } = this.drag;
      ctx.strokeStyle = '#2a6fdb';
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
  }
}

function inRect([x, y, w, h], px, py) {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

function handlePos([x, y, w, h], hd) {
  const cx = hd.includes('w') ? x : hd.includes('e') ? x + w : x + w / 2;
  const cy = hd.includes('n') ? y : hd.includes('s') ? y + h : y + h / 2;
  return [cx, cy];
}

function hitHandle(rect, wx, wy, tol) {
  for (const hd of HANDLES) {
    const [hx, hy] = handlePos(rect, hd);
    if (Math.abs(hx - wx) <= tol && Math.abs(hy - wy) <= tol) return hd;
  }
  return null;
}

export function uniqueId(base, existing) {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
