import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/engine.js';
import { buildPath, pointAt, zoneSpan } from '../src/sim/geometry.js';
import { buyerVendor, standard } from './helpers.js';

const run = (scenario, seconds, seed = 7) => {
  const sim = new Simulation(scenario, { seed });
  sim.step(seconds);
  return sim;
};

describe('경로 계산', () => {
  it('거리로 위치를 구한다', () => {
    const p = buildPath([[0, 0], [100, 0], [100, 50]]);
    expect(p.length).toBe(150);
    expect(pointAt(p, 120)).toEqual([100, 20]);
  });

  it('구역을 지나는 구간을 찾는다', () => {
    const p = buildPath([[0, 10], [200, 10]]);
    const span = zoneSpan(p, [50, 0, 50, 20]);
    expect(span.enter).toBeCloseTo(50, 0);
    expect(span.exit).toBeCloseTo(101, 0);
    expect(zoneSpan(p, [50, 100, 10, 10])).toBeNull();
  });
});

const noEvents = () => ({ ...standard(), events: [], eventTiming: undefined });

describe('시뮬레이션', () => {
  it('같은 seed 면 결과가 같다', () => {
    const a = run(standard(), 300, 42).stats;
    const b = run(standard(), 300, 42).stats;
    expect(a).toEqual(b);
  });

  it('물건 수가 보존된다 (투입 = 출하 + 폐기 + 재공)', () => {
    const sim = run(standard(), 900);
    const { spawned, shipped, scrapped } = sim.stats;
    expect(spawned).toBe(shipped + scrapped + sim.wip);
    expect(shipped).toBeGreaterThan(200);
  });

  it('공정을 지나며 상태가 바뀌고 마지막엔 박스가 된다', () => {
    const sim = new Simulation(standard(), { seed: 1 });
    const seen = new Set();
    sim.on((type, item) => type === 'shipped' && seen.add(item.stage));
    sim.step(150);
    expect([...seen]).toEqual(['box']);
  });

  it('물건마다 원단 색 6가지 중 하나를 받는다', () => {
    const sim = run(standard(), 120);
    const all = [...sim.items, ...sim.stations.flatMap((st) => st.processing)];
    const colors = new Set(all.map((it) => it.fabric));
    expect(colors.size).toBeGreaterThan(2);
    for (const c of colors) expect(standard().flow.fabrics).toContain(c);
  });

  it('봉제 라인은 22px/초로 흐르며 봉제 중 → 완성품이 된다', () => {
    const sim = run(noEvents(), 120);
    const sew = sim.stationByZone.get('sew');
    expect(sew.line).toBe(true);
    const inLine = sim.items.filter((it) => it.line === sew);
    expect(inLine.length).toBeGreaterThan(3);
    for (const it of inLine) {
      expect(it.stage).toBe('sewing');
      expect(it.progress).toBeGreaterThanOrEqual(0);
      expect(it.progress).toBeLessThanOrEqual(1);
    }
    const it = inLine.find((x) => !x.waiting);
    const d0 = it.d;
    sim.step(0.5);
    expect(it.d - d0).toBeCloseTo(11, 0);
    expect(sew.processed).toBeGreaterThan(0);
  });

  it('미싱 고장이 나면 봉제 라인이 멈추고 앞에 줄이 생긴다', () => {
    const sim = run(noEvents(), 90);
    const sew = sim.stationByZone.get('sew');
    const s = { ...standard(), eventTiming: undefined };
    const sim2 = new Simulation(s, { seed: 7 });
    sim2.step(90);
    const sew2 = sim2.stationByZone.get('sew');
    const before = sew2.processed;
    sim2.triggerEvent('sewing-breakdown');
    expect(sew2.stopped).toBe(true);
    const ds = sim2.items.filter((it) => it.line === sew2).map((it) => it.d);
    sim2.step(9);
    expect(sew2.processed).toBe(before);
    expect(sim2.items.filter((it) => it.line === sew2).map((it) => it.d)).toEqual(ds);
    expect(sew2.queue).toBeGreaterThan(0);
    sim2.step(2);
    expect(sew2.stopped).toBe(false);
    expect(sew.processed).toBeGreaterThan(0);
  });

  it('긴급 오더는 투입 간격을 절반으로 줄이고 재단에 병목을 만든다', () => {
    const s = noEvents();
    const normal = run(s, 60);
    s.events = standard().events;
    s.events.find((e) => e.id === 'rush').duration = 60;
    const rush = new Simulation(s, { seed: 7 });
    rush.triggerEvent('rush');
    rush.step(60);
    // 앞 공정이 막히면 투입구도 막히니 정확히 두 배가 되지는 않는다
    expect(rush.stats.spawned).toBeGreaterThan(normal.stats.spawned * 1.25);
    expect(rush.bottleneck?.zone.id).toBe('cut');
  });

  it('원단 입고 지연 중에는 투입이 멈춘다', () => {
    const sim = run({ ...standard(), eventTiming: undefined }, 30);
    const n = sim.stats.spawned;
    sim.triggerEvent('fabric-delay');
    sim.step(10);
    expect(sim.stats.spawned).toBe(n);
  });

  it('평소에는 병목이 없다', () => {
    expect(run(noEvents(), 300).bottleneck).toBeNull();
  });

  it('검사 불량은 수선 4초 뒤 다시 검사하고 버리지 않는다', () => {
    const s = noEvents();
    const ins = s.zones.find((z) => z.id === 'inspect').station;
    ins.defectRate = 0.5;
    const sim = new Simulation(s, { seed: 3 });
    let repairSeen = false;
    for (let i = 0; i < 300; i++) {
      sim.step(1);
      if (sim.stationByZone.get('inspect').processing.some((it) => it.state === 'repair')) repairSeen = true;
    }
    expect(repairSeen).toBe(true);
    expect(sim.stats.defects).toBeGreaterThan(20);
    expect(sim.stats.scrapped).toBe(0);
    expect(sim.stats.spawned).toBe(sim.stats.shipped + sim.wip);
  });

  it('불량 다발은 불량률을 35% 로 바꾼다', () => {
    const base = run(noEvents(), 600).stats.defects;
    const s = { ...standard(), eventTiming: undefined };
    s.events.find((e) => e.id === 'defect-surge').duration = 600;
    const sim = new Simulation(s, { seed: 7 });
    sim.triggerEvent('defect-surge');
    sim.step(600);
    expect(sim.stats.defects).toBeGreaterThan(base * 3);
  });

  it('돌발 상황은 하나씩: 끝난 뒤 40~65초 사이에 다음 것이 일어난다', () => {
    const sim = new Simulation(standard(), { seed: 11 });
    const log = [];
    sim.on((type, p) => (type === 'event:start' || type === 'event:end') && log.push([type, sim.time, p.id]));
    sim.step(1200);
    expect(log.length).toBeGreaterThan(10);
    for (let i = 0; i < log.length - 1; i++) {
      // 시작 다음엔 반드시 끝 (동시에 둘 이상 진행하지 않음)
      if (log[i][0] === 'event:start') expect(log[i + 1][0]).toBe('event:end');
      if (log[i][0] === 'event:end') {
        const gap = log[i + 1][1] - log[i][1];
        expect(gap).toBeGreaterThanOrEqual(40 - 0.06);
        expect(gap).toBeLessThanOrEqual(65 + 0.06);
      }
    }
  });

  it('버튼으로 일으키면 진행 중인 것과 다른 종류를 고르고 다음 자동 발생을 45초 뒤로 맞춘다', () => {
    const sim = new Simulation(standard(), { seed: 2 });
    sim.step(10);
    const a = sim.triggerRandom();
    const b = sim.triggerRandom();
    expect(a.id).not.toBe(b.id);
    expect(sim.activeEvents).toHaveLength(2);
    expect(sim.nextAutoAt).toBeCloseTo(sim.time + 45, 5);
  });

  it('예열 90초 뒤 지표는 0 이고 공장은 차 있다', () => {
    const sim = new Simulation(standard(), { seed: 4 });
    const log = [];
    sim.on((type) => log.push(type));
    sim.warmUp();
    expect(sim.time).toBeCloseTo(90, 5);
    expect(sim.stats.spawned).toBe(0);
    expect(sim.stats.shipped).toBe(0);
    expect(sim.wip).toBeGreaterThan(15);
    expect(log).toEqual([]);
    expect(sim.activeEvents).toHaveLength(0);
    expect(sim.clockText).toBe('08:00');
    sim.step(90);
    expect(sim.clockText).toBe('09:30');
  });

  it('물건끼리 경로 위에서 겹치지 않는다', () => {
    const sim = new Simulation(standard(), { seed: 3 });
    for (let i = 0; i < 300; i++) {
      sim.step(1);
      const ds = sim.items.map((it) => it.d).sort((a, b) => a - b);
      for (let k = 1; k < ds.length; k++) expect(ds[k] - ds[k - 1]).toBeGreaterThanOrEqual(sim.gap - 1e-6);
    }
  });
});

describe('바이어·벤더 오더 흐름', () => {
  const quiet = () => ({ ...buyerVendor(), events: [], eventTiming: undefined });

  it('오더가 기획부터 정산까지 가고 물건 수가 보존된다', () => {
    const sim = new Simulation(buyerVendor(), { seed: 5 });
    const seen = new Set();
    sim.on((type, item) => type === 'shipped' && seen.add(item.stage));
    sim.step(900);
    expect(sim.stats.shipped).toBeGreaterThan(100);
    expect([...seen]).toEqual(['received']);
    expect(sim.stats.spawned).toBe(sim.stats.shipped + sim.stats.scrapped + sim.wip);
  });

  it('공정 순서는 MD → 디자인 → 벤더 영업 → 샘플실 → 피팅 → 구매 → 생산 → 검품 → 선적 → 물류센터', () => {
    const ids = new Simulation(buyerVendor(), { seed: 1 }).stations.map((st) => st.zone.id);
    expect(ids).toEqual(['md', 'design', 'sales', 'sample', 'fitting', 'purchase', 'production', 'inspection', 'shipping', 'dc']);
  });

  it('샘플이 반려되면 수정 샘플로 다시 검토하고 버리지 않는다', () => {
    const sim = new Simulation(quiet(), { seed: 2 });
    sim.step(600);
    expect(sim.stationByZone.get('fitting').defects).toBeGreaterThan(10);
    expect(sim.stats.scrapped).toBe(0);
  });

  it('샘플 반려 다발은 피팅에만 적용되고 검품 불량률은 그대로다', () => {
    const s = { ...buyerVendor(), eventTiming: undefined };
    s.events.find((e) => e.id === 'sample-reject').duration = 2000;
    const a = new Simulation(s, { seed: 9 });
    a.triggerEvent('sample-reject');
    a.step(1200);
    const b = new Simulation(quiet(), { seed: 9 });
    b.step(1200);
    const rate = (sim, id) => sim.stationByZone.get(id).defects / sim.stationByZone.get(id).processed;
    expect(rate(a, 'fitting')).toBeGreaterThan(0.45);
    expect(rate(b, 'fitting')).toBeLessThan(0.35);
    expect(rate(a, 'inspection')).toBeLessThan(0.15);
  });

  it('평소에는 병목이 없다', () => {
    const sim = new Simulation(quiet(), { seed: 4 });
    sim.step(600);
    expect(sim.bottleneck).toBeNull();
  });

  it('게임 시각은 n주차 n일 (1초 = 1일)', () => {
    const sim = new Simulation(buyerVendor(), { seed: 1 });
    sim.warmUp();
    expect(sim.clockText).toBe('1주차 1일');
    sim.step(9.5);
    expect(sim.clockText).toBe('2주차 3일');
  });
});
