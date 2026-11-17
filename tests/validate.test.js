import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { validateScenarioText } from '../src/schema/index.js';
import { formatScenario } from '../src/schema/format.js';
import { buyerVendor, root, standard, standardText } from './helpers.js';

const v = (obj, opts) => validateScenarioText(typeof obj === 'string' ? obj : formatScenario(obj), { file: 't.json', ...opts });

describe('시나리오 검증', () => {
  it('저장소의 모든 시나리오가 통과한다', () => {
    for (const f of readdirSync(`${root}scenarios`).filter((x) => x.endsWith('.json'))) {
      const res = validateScenarioText(readFileSync(`${root}scenarios/${f}`, 'utf8'), { file: f, expectedId: f.slice(0, -5) });
      expect(res.errors, f).toEqual([]);
    }
  });

  it('표준 공장은 10개 구역과 돌발 상황 4종을 가진다', () => {
    const s = standard();
    expect(s.zones).toHaveLength(10);
    expect(s.events).toHaveLength(4);
  });

  it('JSON 문법 오류의 줄과 칸을 알려준다', () => {
    const text = '{\n  "id": "a",\n  "name": "x",,\n}';
    const res = v(text);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatchObject({ file: 't.json', line: 3, severity: 'error' });
    expect(res.errors[0].message).toContain('JSON 문법 오류');
  });

  it('빠진 필수 항목은 그 객체가 있는 줄을 가리킨다', () => {
    const s = standard();
    delete s.zones[3].rect;
    const text = formatScenario(s);
    const res = v(text);
    const err = res.errors.find((e) => e.message.includes("'rect'"));
    expect(err).toBeTruthy();
    expect(err.path).toBe('zones[3](cut)');
    expect(text.split('\n')[err.line - 1]).toContain('{');
  });

  it('잘못된 값은 정확한 줄과 읽기 쉬운 경로를 알려준다', () => {
    const s = standard();
    s.zones[3].station.time = -1;
    const text = formatScenario(s);
    const res = v(text);
    const err = res.errors.find((e) => e.path === 'zones[3](cut).station.time');
    expect(err.message).toBe('0 보다 커야 해요');
    expect(text.split('\n')[err.line - 1]).toContain('"time": -1');
  });

  it('알 수 없는 항목은 키가 있는 줄을 가리킨다', () => {
    const s = standard();
    s.flow.speeed = 3;
    const text = formatScenario(s);
    const err = v(text).errors[0];
    expect(err.message).toContain("'speeed'");
    expect(text.split('\n')[err.line - 1]).toContain('"speeed"');
  });

  it('없는 상태·구역 참조와 겹치는 id 를 잡는다', () => {
    const s = standard();
    s.zones[4].station.stage = 'nope';
    s.events[1].effect.stopZones = ['ghost'];
    s.zones[5].id = 'cut';
    const msgs = v(s).errors.map((e) => `${e.path} ${e.message}`);
    expect(msgs.some((m) => m.includes('station.stage') && m.includes("'nope'"))).toBe(true);
    expect(msgs.some((m) => m.includes('stopZones[0]') && m.includes("'ghost'"))).toBe(true);
    expect(msgs.some((m) => m.includes("id 'cut'") && m.includes('겹쳐요'))).toBe(true);
  });

  it('파일 이름과 id 가 다르면 오류', () => {
    const res = v(standardText(), { expectedId: 'other' });
    expect(res.errors.some((e) => e.path === 'id')).toBe(true);
  });

  it('경로가 지나지 않는 공정은 경고로 알려준다', () => {
    const s = standard();
    s.zones[3].rect = [440, 470, 100, 40];
    const res = v(s);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.path === 'zones[3](cut).station' && w.message.includes('지나지 않아'))).toBe(true);
  });

  it('색상 형식 오류를 한국어로 설명한다', () => {
    const s = standard();
    s.stages[0].color = 'blue';
    expect(v(s).errors[0].message).toBe('#RRGGBB 형식의 색상이어야 해요');
  });

  it('공정에 처리 시간도 라인 속도도 없으면 오류', () => {
    const s = standard();
    delete s.zones[3].station.time;
    expect(v(s).errors.some((e) => e.path === 'zones[3](cut).station' && e.message.includes('time'))).toBe(true);
  });

  it('처리 중 상태와 돌발 상황 간격도 검사한다', () => {
    const s = standard();
    s.zones[5].station.workingStage = 'ghost';
    s.eventTiming.gap = [70, 30];
    const paths = v(s).errors.map((e) => e.path);
    expect(paths).toContain('zones[5](sew).station.workingStage');
    expect(paths).toContain('eventTiming.gap');
  });
});

describe('바이어·벤더 시나리오 검증', () => {
  it('11개 구역, 영역 3개, 공장 연결', () => {
    const s = buyerVendor();
    expect(s.kind).toBe('supply-chain');
    expect(s.zones).toHaveLength(11);
    expect(s.layout.areas).toHaveLength(3);
    expect(s.zones.find((z) => z.id === 'production').link).toBe('standard-factory');
    const res = v(s);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('연결 id 형식과 자기 연결을 잡는다', () => {
    const s = buyerVendor();
    s.zones[7].link = 'Bad Id';
    expect(v(s).errors.some((e) => e.path === 'zones[7](production).link')).toBe(true);
    s.zones[7].link = 'buyer-vendor';
    expect(v(s).errors.some((e) => e.message.includes('자기 자신'))).toBe(true);
  });

  it('맵 밖 영역과 검사 공정이 아닌 불량률 대상을 경고한다', () => {
    const s = buyerVendor();
    s.layout.areas[2].rect = [800, 20, 500, 720];
    s.events[0].effect.defectZones = ['ghost', 'sales'];
    const res = v(s);
    expect(res.warnings.some((w) => w.path === 'layout.areas[2].rect')).toBe(true);
    expect(res.errors.some((e) => e.path === 'events[0](sample-reject).effect.defectZones[0]')).toBe(true);
    expect(res.warnings.some((w) => w.message.includes("'sales' 는 검사 공정이 아니라"))).toBe(true);
  });
});

describe('저장 형식', () => {
  it('저장했다 다시 읽으면 내용이 같다', () => {
    const s = standard();
    expect(JSON.parse(formatScenario(s))).toEqual(s);
  });

  it('사각형과 점은 한 줄로 쓴다', () => {
    const text = formatScenario(standard());
    expect(text).toContain('"rect": [390, 30, 170, 170]');
    expect(text).toMatch(/\n\s+\[770, 140\],\n/);
  });
});
