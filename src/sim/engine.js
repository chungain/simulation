// 시뮬레이션 엔진. 시나리오 객체만 읽고 DOM·Canvas 를 모른다.
// 렌더러(2D Canvas, 이후 Three.js)는 sim.items / sim.stations / sim.stats 를 읽어 그린다.

import { buildPath, pointAt, rectContains, zoneSpan } from './geometry.js';
import { createRng } from './rng.js';

const MAX_STEP = 0.05;
export const DEFAULT_FABRICS = ['#34507a', '#6b7a3a', '#8a2f3e', '#c99a2e', '#5b6068', '#2f7a74'];

export class Simulation {
  /**
   * @param {object} scenario 검증을 통과한 시나리오
   * @param {{seed?: number}} [opts]
   */
  constructor(scenario, opts = {}) {
    this.scenario = scenario;
    this.seed = opts.seed ?? (Math.random() * 2 ** 32) >>> 0;
    this.listeners = new Set();
    this.reset();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    if (this.muted) return;
    for (const fn of this.listeners) fn(type, payload);
  }

  reset() {
    const s = this.scenario;
    this.rng = createRng(this.seed);
    this.time = 0;
    this.clockStart = 0; // 예열이 끝난 시각. 게임 시각·가동률은 여기부터 센다
    this.nextItemId = 1;
    this.items = [];
    this.discarded = []; // 버려진 불량(화면에서 잠깐 보여주고 사라짐)
    this.spawnAcc = 1; // 시작하자마자 하나 투입
    this.stagesById = new Map(s.stages.map((st) => [st.id, st]));
    this.spawnStage = s.flow.spawnStage ?? s.stages[0].id;
    this.speed = s.flow.speed ?? 60;
    this.gap = s.flow.gap ?? 22;
    this.fabrics = s.flow.fabrics?.length ? s.flow.fabrics : DEFAULT_FABRICS;
    this.path = buildPath(s.flow.path);
    this.eventsEnabled = true;

    this.stations = [];
    for (const zone of s.zones) {
      if (!zone.station) continue;
      const span = zoneSpan(this.path, zone.rect, 1);
      if (!span) continue;
      const line = typeof zone.station.speed === 'number';
      const capacity = line ? Infinity : zone.station.capacity ?? 1;
      this.stations.push({
        zone,
        def: zone.station,
        span,
        line, // 라인 공정: 처리 자리 없이 구역 안을 천천히 흐르며 처리된다
        capacity,
        slots: line ? [] : slotPositions(zone, capacity),
        processing: [], // 처리 중·수선 중·나갈 자리를 기다리는 물건
        stopped: false,
        busyTime: 0,
        stoppedTime: 0,
        processed: 0,
        defects: 0,
        queue: 0, // 바로 앞 경로에서 기다리는 물건 수
        blocked: 0, // 처리를 끝냈지만 다음 자리가 막혀 못 나가는 물건 수
        pressure: 0, // 밀려 있는 정도(시간 평균). 병목 판단에 쓴다
      });
    }
    this.stations.sort((a, b) => a.span.enter - b.span.enter);
    this.stationByZone = new Map(this.stations.map((st) => [st.zone.id, st]));

    const timing = s.eventTiming;
    this.timing = timing ? { gap: timing.gap, afterManual: timing.afterManual ?? 45 } : null;
    this.events = (s.events ?? []).map((def) => ({
      def,
      active: false,
      manual: false,
      endsAt: 0,
      nextAt: !this.timing && def.interval ? this.time + this.rng.range(def.interval[0], def.interval[1]) : Infinity,
    }));
    this.nextAutoAt = this.timing ? this.time + this.rng.range(this.timing.gap[0], this.timing.gap[1]) : Infinity;
    this.effects = aggregateEffects([]);

    this.stats = { spawned: 0, shipped: 0, defects: 0, scrapped: 0, leadTimeSum: 0 };
  }

  /**
   * 시작 전에 seconds 만큼 미리 돌려 공장을 채운 뒤 지표를 0으로 되돌린다.
   * 예열 중에는 돌발 상황과 이벤트 알림을 내지 않는다.
   */
  warmUp(seconds = this.scenario.flow.warmup ?? 0) {
    if (!(seconds > 0)) return;
    this.eventsEnabled = false;
    this.muted = true;
    this.step(seconds);
    this.muted = false;
    this.eventsEnabled = true;
    this.clockStart = this.time;
    this.stats = { spawned: 0, shipped: 0, defects: 0, scrapped: 0, leadTimeSum: 0 };
    for (const st of this.stations) {
      st.busyTime = 0;
      st.stoppedTime = 0;
      st.processed = 0;
      st.defects = 0;
    }
    for (const ev of this.events) {
      if (ev.def.interval && !this.timing) ev.nextAt = this.time + this.rng.range(ev.def.interval[0], ev.def.interval[1]);
    }
    if (this.timing) this.nextAutoAt = this.time + this.rng.range(this.timing.gap[0], this.timing.gap[1]);
  }

  /** 예열 뒤로 흐른 시뮬레이션 시간(초) */
  get elapsed() {
    return this.time - this.clockStart;
  }

  /** 게임 시각 "HH:MM" */
  get clockText() {
    if (this.scenario.flow.clockFormat === 'day') {
      // 하루 단위: timeScale 은 시뮬레이션 1초가 게임 몇 초인지 (86400 = 1초에 하루)
      const day = Math.floor((this.elapsed * (this.scenario.flow.timeScale ?? 86400)) / 86400);
      return `${Math.floor(day / 7) + 1}주차 ${(day % 7) + 1}일`;
    }
    const [hh, mm] = (this.scenario.flow.startTime ?? '08:00').split(':').map(Number);
    const total = Math.floor((hh * 3600 + mm * 60 + this.elapsed * (this.scenario.flow.timeScale ?? 60)) / 60);
    const m = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /** 현재 공장 안에 있는 물건 수(재공) */
  get wip() {
    return this.items.length + this.stations.reduce((n, st) => n + st.processing.length, 0);
  }

  /** 구역 안에 있는 물건 수 */
  zoneWip(zone) {
    let n = 0;
    for (const it of this.items) if (rectContains(zone.rect, it.x, it.y)) n++;
    for (const st of this.stations) for (const it of st.processing) if (rectContains(zone.rect, it.x, it.y)) n++;
    return n;
  }

  get activeEvents() {
    return this.events.filter((e) => e.active);
  }

  triggerEvent(id) {
    const ev = this.events.find((e) => e.def.id === id);
    if (!ev) return null;
    this.startEvent(ev, true);
    return ev.def;
  }

  /** 진행 중이 아닌 돌발 상황 하나를 골라 일으킨다 (돌발 상황 버튼) */
  triggerRandom() {
    const pool = this.events.filter((e) => !e.active);
    if (!pool.length) return null;
    const ev = pool[Math.floor(this.rng() * pool.length)];
    this.startEvent(ev, true);
    return ev.def;
  }

  stopEvent(id) {
    const ev = this.events.find((e) => e.def.id === id);
    if (ev?.active) this.endEvent(ev);
  }

  startEvent(ev, manual = false) {
    const wasActive = ev.active;
    ev.active = true;
    ev.manual = manual;
    ev.endsAt = this.time + ev.def.duration;
    ev.nextAt = Infinity;
    if (manual && this.timing) this.nextAutoAt = this.time + this.timing.afterManual;
    this.refreshEffects();
    if (!wasActive) this.emit('event:start', { ...ev.def, manual });
  }

  endEvent(ev) {
    ev.active = false;
    if (this.timing) {
      // 자동으로 일어난 것이 끝나면 다음 자동 발생을 잡는다. 버튼으로 일으킨 것은 afterManual 로 이미 잡혀 있다
      if (!ev.manual) this.nextAutoAt = this.time + this.rng.range(this.timing.gap[0], this.timing.gap[1]);
    } else {
      ev.nextAt = ev.def.interval ? this.time + this.rng.range(ev.def.interval[0], ev.def.interval[1]) : Infinity;
    }
    this.refreshEffects();
    this.emit('event:end', ev.def);
  }

  refreshEffects() {
    this.effects = aggregateEffects(this.activeEvents.map((e) => e.def.effect));
    for (const st of this.stations) st.stopped = this.effects.stopZones.has(st.zone.id);
  }

  step(dt) {
    while (dt > 1e-9) {
      const h = Math.min(dt, MAX_STEP);
      this.tick(h);
      dt -= h;
    }
  }

  tick(dt) {
    this.time += dt;
    this.updateEvents();
    this.updateStations(dt);
    this.moveItems(dt);
    this.spawn(dt);
    this.updatePressure(dt);
    this.discarded = this.discarded.filter((d) => (d.ttl -= dt) > 0);
  }

  updateEvents() {
    for (const ev of this.events) {
      if (ev.active && this.time >= ev.endsAt) this.endEvent(ev);
      else if (this.eventsEnabled && !this.timing && !ev.active && this.time >= ev.nextAt) this.startEvent(ev);
    }
    if (this.eventsEnabled && this.timing && this.events.length && this.time >= this.nextAutoAt && !this.events.some((e) => e.active)) {
      const ev = this.events[Math.floor(this.rng() * this.events.length)];
      this.nextAutoAt = Infinity;
      this.startEvent(ev);
    }
  }

  updateStations(dt) {
    for (const st of this.stations) {
      if (st.line) {
        const n = this.items.filter((it) => it.line === st).length;
        if (st.stopped) st.stoppedTime += dt;
        else if (n) st.busyTime += dt;
        continue;
      }
      let working = 0;
      for (const item of st.processing) {
        if (item.state !== 'processing' && item.state !== 'repair') continue;
        working++;
        if (st.stopped) continue;
        item.timer -= dt;
        if (item.timer > 0) continue;
        if (item.state === 'repair') this.inspect(st, item);
        else this.finishProcessing(st, item);
      }
      if (st.stopped) st.stoppedTime += dt;
      else st.busyTime += (dt * working) / st.capacity;

      // 처리가 끝난 물건은 출구 자리가 비면 경로로 나간다
      for (const item of [...st.processing]) {
        if (item.state === 'scrap') {
          st.processing.splice(st.processing.indexOf(item), 1);
          this.discarded.push({ x: item.x, y: item.y, stage: item.stage, fabric: item.fabric, ttl: 1.5 });
          this.stats.scrapped++;
          continue;
        }
        if (item.state !== 'finished') continue;
        if (!this.isClear(st.span.exit)) continue;
        st.processing.splice(st.processing.indexOf(item), 1);
        this.leaveStation(st, item, st.span.exit);
        this.items.push(item);
      }
    }
  }

  leaveStation(st, item, d) {
    item.state = 'moving';
    item.d = d;
    item.next = this.stations.indexOf(st) + 1;
    [item.x, item.y] = pointAt(this.path, item.d);
  }

  finishProcessing(st, item) {
    st.processed++;
    item.stage = st.def.stage;
    if (st.def.inspect) this.inspect(st, item);
    else item.state = 'finished';
  }

  /** 검사: 불량이면 수선(있으면) 뒤 다시 검사하고, 없으면 버린다 */
  inspect(st, item) {
    const rate = Math.min(1, this.effects.defectByZone.get(st.zone.id) ?? this.effects.defectRate ?? st.def.defectRate ?? 0);
    if (this.rng() >= rate) {
      item.state = 'finished';
      item.stage = st.def.stage;
      return;
    }
    this.stats.defects++;
    st.defects++;
    this.emit('defect', { zone: st.zone, item });
    if (st.def.repair) {
      item.state = 'repair';
      item.timer = st.def.repair;
      item.duration = st.def.repair;
    } else {
      item.state = 'scrap';
    }
  }

  moveItems(dt) {
    for (const st of this.stations) st.queue = 0;
    this.items.sort((a, b) => b.d - a.d); // 앞선 물건부터
    const done = [];
    let aheadD = Infinity;
    for (const item of this.items) {
      const st = this.stations[item.next];
      const inLine = st?.line && item.d >= st.span.enter;
      const v = inLine ? (st.stopped ? 0 : st.def.speed) : this.speed;
      let target = item.d + v * dt;
      target = Math.min(target, aheadD - this.gap);

      if (st && !st.line && target >= st.span.enter) {
        if (!st.stopped && st.processing.length < st.capacity && item.d >= st.span.enter - this.gap) {
          this.enterStation(st, item);
          continue; // 경로에서 빠졌으니 뒤 물건의 기준이 되지 않는다
        }
        target = Math.min(target, st.span.enter);
      }
      if (st?.line && !inLine && st.stopped) target = Math.min(target, st.span.enter - 0.01); // 멈춘 라인 앞에서 기다린다

      const moved = target > item.d + 1e-6;
      if (moved) item.d = target;
      item.waiting = !moved;
      if (st && item.waiting && item.d < st.span.enter + 1e-6) st.queue++;

      // 라인 공정: 들어가면 처리 중 상태가 되고, 끝에 닿으면 처리 후 상태가 된다
      if (st?.line) {
        if (item.d >= st.span.enter && !item.line) {
          item.line = st;
          if (st.def.workingStage) item.stage = st.def.workingStage;
        }
        if (item.line === st) item.progress = Math.min(1, (item.d - st.span.enter) / (st.span.exit - st.span.enter));
        if (item.d >= st.span.exit) {
          item.line = null;
          item.progress = undefined;
          item.stage = st.def.stage;
          item.next++;
          st.processed++;
        }
      }

      [item.x, item.y] = pointAt(this.path, item.d);
      aheadD = item.d;

      if (item.d >= this.path.length - 1e-6) done.push(item);
    }
    this.items = this.items.filter((it) => it.state === 'moving' && !done.includes(it));
    for (const item of done) {
      this.stats.shipped++;
      this.stats.leadTimeSum += this.time - item.born;
      this.emit('shipped', item);
    }
  }

  enterStation(st, item) {
    item.state = 'processing';
    const variance = st.def.variance ?? 0;
    item.timer = st.def.time * (1 + variance * (this.rng() * 2 - 1));
    item.duration = item.timer;
    if (st.def.workingStage) item.stage = st.def.workingStage;
    const used = new Set(st.processing.map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    item.slot = slot;
    [item.x, item.y] = st.slots[slot % st.slots.length];
    st.processing.push(item);
  }

  isClear(d) {
    return this.items.every((it) => Math.abs(it.d - d) >= this.gap);
  }

  spawn(dt) {
    const mult = this.effects.spawnMultiplier;
    this.spawnAcc = Math.min(1, this.spawnAcc + (dt * mult) / this.scenario.flow.spawnInterval);
    if (this.spawnAcc < 1 || !this.isClear(0)) return;
    this.spawnAcc -= 1;
    const [x, y] = pointAt(this.path, 0);
    this.items.push({
      id: this.nextItemId++,
      stage: this.spawnStage,
      fabric: this.fabrics[Math.floor(this.rng() * this.fabrics.length)],
      state: 'moving',
      d: 0,
      x,
      y,
      next: 0,
      born: this.time,
      waiting: false,
    });
    this.stats.spawned++;
  }

  /**
   * 공정마다 밀려 있는 정도를 계산한다.
   * 앞 공정이 처리를 끝내고도 못 나가고 있으면(막힘) 그 밀림까지 이 공정 몫으로 친다.
   * 경로 위 대기 공간이 짧아 줄이 앞 공정 안으로 번져도 원인 공정을 짚기 위해서다.
   */
  updatePressure(dt) {
    const alpha = 1 - Math.exp(-dt / 4);
    let carried = 0;
    for (const st of this.stations) {
      st.blocked = st.processing.filter((i) => i.state === 'finished').length;
      const busy = st.stopped || st.processing.length >= st.capacity || (st.line && st.queue > 0);
      const own = st.queue + carried;
      const p = busy && st.blocked === 0 ? own : 0;
      st.pressure += (p - st.pressure) * alpha;
      carried = st.blocked > 0 ? own + st.blocked : 0;
    }
  }

  /** 가장 밀려 있는 공정 (병목). 없으면 null */
  get bottleneck() {
    let best = null;
    for (const st of this.stations) if (st.pressure >= 2 && (!best || st.pressure > best.pressure)) best = st;
    return best;
  }
}

function aggregateEffects(effects) {
  const out = { stopZones: new Set(), spawnMultiplier: 1, defectRate: undefined, defectByZone: new Map() };
  for (const e of effects) {
    for (const z of e.stopZones ?? []) out.stopZones.add(z);
    if (typeof e.spawnMultiplier === 'number') out.spawnMultiplier *= e.spawnMultiplier;
    if (typeof e.defectRate !== 'number') continue;
    if (e.defectZones?.length) {
      // 정한 검사 구역에만 적용
      for (const z of e.defectZones) out.defectByZone.set(z, Math.max(out.defectByZone.get(z) ?? 0, e.defectRate));
    } else out.defectRate = Math.max(out.defectRate ?? 0, e.defectRate);
  }
  return out;
}

/** 처리 중인 물건이 놓일 자리. station.slots 가 없으면 구역 안에 격자로 배치한다. */
export function slotPositions(zone, capacity) {
  if (zone.station.slots?.length) return zone.station.slots.map((p) => [p[0], p[1]]);
  const [x, y, w, h] = zone.rect;
  const top = 34; // 구역 이름 자리
  const innerH = Math.max(10, h - top - 8);
  const innerW = Math.max(10, w - 16);
  const cols = Math.max(1, Math.min(capacity, Math.round(Math.sqrt((capacity * innerW) / innerH))));
  const rows = Math.ceil(capacity / cols);
  const out = [];
  for (let i = 0; i < capacity; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push([x + 8 + (innerW * (c + 0.5)) / cols, y + top + (innerH * (r + 0.5)) / rows]);
  }
  return out;
}
