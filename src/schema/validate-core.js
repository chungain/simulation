// 시나리오 검증: JSON 문법 → JSON Schema → 참조·배치 점검.
// 오류마다 파일 이름, 줄, 칸, 항목 경로, 한국어 설명을 돌려준다.
// 브라우저와 Node(CLI·테스트) 양쪽에서 쓰므로 스키마는 인자로 받는다.

import Ajv from 'ajv';
import jsonMap from 'json-source-map';
import { buildPath, zoneSpan } from '../sim/geometry.js';

const TYPE_KO = {
  number: '숫자',
  integer: '정수',
  string: '문자열',
  boolean: 'true 또는 false',
  array: '배열 [ ]',
  object: '객체 { }',
};

export function createValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const check = ajv.compile(schema);

  /**
   * @param {string} text  시나리오 파일 원문
   * @param {object} [opts]
   * @param {string} [opts.file]        오류에 표시할 파일 이름
   * @param {string} [opts.expectedId]  파일 이름에서 온 id. 다르면 오류
   * @returns {{ok:boolean, data:any, errors:Issue[], warnings:Issue[]}}
   */
  return function validateText(text, opts = {}) {
    const file = opts.file ?? 'scenario.json';
    const errors = [];
    const warnings = [];

    let data;
    let pointers;
    try {
      ({ data, pointers } = jsonMap.parse(text));
    } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      const pos = m ? Number(m[1]) : text.length;
      const { line, column } = lineColAt(text, pos);
      const token = /Unexpected token (.)/.exec(e.message)?.[1];
      errors.push({
        severity: 'error',
        file,
        line,
        column,
        path: '',
        message: token
          ? `JSON 문법 오류: '${token}' 이(가) 올 자리가 아니에요 (쉼표·따옴표·괄호를 확인하세요)`
          : 'JSON 문법 오류: 파일이 중간에 끝났어요 (닫는 괄호를 확인하세요)',
      });
      return { ok: false, data: null, errors, warnings };
    }

    const at = (ptr, preferKey = false) => {
      const p = pointers[ptr] ?? pointers[''];
      const loc = (preferKey && p.key) || p.value;
      return { line: loc.line + 1, column: loc.column + 1 };
    };
    const push = (list, severity, ptr, message, preferKey) => {
      list.push({ severity, file, ...at(ptr, preferKey), path: readablePath(data, ptr), message });
    };

    // 1) JSON Schema
    if (!check(data)) {
      const seen = new Set();
      for (const err of check.errors) {
        let ptr = err.instancePath;
        let preferKey = false;
        if (err.keyword === 'additionalProperties') {
          ptr = `${ptr}/${escapePtr(err.params.additionalProperty)}`;
          preferKey = true;
        }
        const message = schemaMessage(err);
        if (!message) continue;
        const key = `${ptr}|${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        push(errors, 'error', ptr, message, preferKey);
      }
    }

    // 2) 참조·배치 점검 (스키마를 통과한 부분만 안전하게 본다)
    if (data && typeof data === 'object') semanticChecks(data, opts, (sev, ptr, msg) =>
      push(sev === 'error' ? errors : warnings, sev, ptr, msg),
    );

    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    warnings.sort((a, b) => a.line - b.line || a.column - b.column);
    return { ok: errors.length === 0, data, errors, warnings };
  };
}

function semanticChecks(s, opts, report) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const stages = arr(s.stages);
  const zones = arr(s.zones);
  const events = arr(s.events);
  const stageIds = new Set(stages.map((x) => x?.id));
  const zoneIds = new Set(zones.map((x) => x?.id));

  if (opts.expectedId && typeof s.id === 'string' && s.id !== opts.expectedId) {
    report('error', '/id', `id '${s.id}' 가 파일 이름(${opts.expectedId}.json)과 달라요`);
  }

  for (const [list, name] of [[stages, 'stages'], [zones, 'zones'], [events, 'events']]) {
    const seen = new Map();
    list.forEach((x, i) => {
      if (typeof x?.id !== 'string') return;
      if (seen.has(x.id)) report('error', `/${name}/${i}/id`, `id '${x.id}' 가 ${name}[${seen.get(x.id)}] 와 겹쳐요`);
      else seen.set(x.id, i);
    });
  }

  zones.forEach((z, i) => {
    const st = z?.station;
    if (!st || typeof st !== 'object') return;
    for (const key of ['stage', 'workingStage']) {
      if (typeof st[key] === 'string' && !stageIds.has(st[key])) {
        report('error', `/zones/${i}/station/${key}`, `stages 에 없는 상태 '${st[key]}' 예요 (있는 값: ${[...stageIds].join(', ')})`);
      }
    }
    if (st.time === undefined && st.speed === undefined) {
      report('error', `/zones/${i}/station`, '처리 시간(time)이나 라인 속도(speed) 중 하나는 있어야 해요');
    }
    if (st.speed !== undefined && st.inspect) {
      report('warning', `/zones/${i}/station/inspect`, '라인 공정(speed)에서는 검사를 하지 않아요. 검사는 처리 시간(time) 공정에서 쓰세요');
    }
  });

  const start = s.layout?.start;
  if (isPoint(start) && typeof s.layout.width === 'number' && (start[0] < 0 || start[1] < 0 || start[0] > s.layout.width || start[1] > s.layout.height)) {
    report('warning', '/layout/start', '플레이어 시작 위치가 맵 밖에 있어요');
  }
  arr(s.layout?.areas).forEach((a, i) => {
    if (!isRect(a?.rect)) return;
    const [x, y, w, h] = a.rect;
    if (typeof s.layout.width === 'number' && (x < 0 || y < 0 || x + w > s.layout.width || y + h > s.layout.height)) {
      report('warning', `/layout/areas/${i}/rect`, '영역이 맵 밖으로 나가요');
    }
  });
  zones.forEach((z, i) => {
    if (typeof z?.link === 'string' && z.link === s.id) report('error', `/zones/${i}/link`, '자기 자신은 연결할 수 없어요');
  });
  const gap = s.eventTiming?.gap;
  if (Array.isArray(gap) && gap.length === 2 && gap[0] > gap[1]) {
    report('error', '/eventTiming/gap', '간격은 [최소, 최대] 순서여야 해요');
  }

  const flow = s.flow;
  if (flow && typeof flow.spawnStage === 'string' && !stageIds.has(flow.spawnStage)) {
    report('error', '/flow/spawnStage', `stages 에 없는 상태 '${flow.spawnStage}' 예요`);
  }

  events.forEach((ev, i) => {
    arr(ev?.effect?.stopZones).forEach((zid, j) => {
      if (!zoneIds.has(zid)) report('error', `/events/${i}/effect/stopZones/${j}`, `zones 에 없는 구역 '${zid}' 예요`);
    });
    arr(ev?.effect?.defectZones).forEach((zid, j) => {
      if (!zoneIds.has(zid)) report('error', `/events/${i}/effect/defectZones/${j}`, `zones 에 없는 구역 '${zid}' 예요`);
      else if (!zones.find((z) => z?.id === zid)?.station?.inspect) {
        report('warning', `/events/${i}/effect/defectZones/${j}`, `'${zid}' 는 검사 공정이 아니라 불량률이 쓰이지 않아요`);
      }
    });
    const iv = ev?.interval;
    if (Array.isArray(iv) && iv.length === 2 && iv[0] > iv[1]) {
      report('error', `/events/${i}/interval`, '발생 간격은 [최소, 최대] 순서여야 해요');
    }
  });

  // 배치 경고: 맵 밖, 경로가 공정 구역을 지나지 않음
  const W = s.layout?.width;
  const H = s.layout?.height;
  const outside = (x, y) => typeof W === 'number' && typeof H === 'number' && (x < 0 || y < 0 || x > W || y > H);
  zones.forEach((z, i) => {
    if (!isRect(z?.rect)) return;
    const [x, y, w, h] = z.rect;
    if (outside(x, y) || outside(x + w, y + h)) report('warning', `/zones/${i}/rect`, '구역이 맵 밖으로 나가요');
  });
  arr(s.layout?.props).forEach((p, i) => {
    if (!isRect(p?.rect)) return;
    const [x, y, w, h] = p.rect;
    if (outside(x, y) || outside(x + w, y + h)) report('warning', `/layout/props/${i}/rect`, '소품이 맵 밖으로 나가요');
  });
  const pts = arr(flow?.path);
  pts.forEach((p, i) => {
    if (isPoint(p) && outside(p[0], p[1])) report('warning', `/flow/path/${i}`, '경로 점이 맵 밖에 있어요');
  });
  if (pts.length >= 2 && pts.every(isPoint)) {
    const path = buildPath(pts);
    const spans = [];
    zones.forEach((z, i) => {
      if (!z?.station || !isRect(z.rect)) return;
      const span = zoneSpan(path, z.rect, 2);
      if (!span) report('warning', `/zones/${i}/station`, `경로가 '${z.name ?? z.id}' 구역을 지나지 않아 이 공정은 동작하지 않아요`);
      else spans.push({ i, span });
    });
    spans.sort((a, b) => a.span.enter - b.span.enter);
    for (let k = 1; k < spans.length; k++) {
      if (spans[k].span.enter < spans[k - 1].span.exit) {
        report('warning', `/zones/${spans[k].i}/rect`, `공정 구역이 경로 위에서 zones[${spans[k - 1].i}] 와 겹쳐요`);
      }
    }
  }
}

function schemaMessage(err) {
  const p = err.params;
  switch (err.keyword) {
    case 'required':
      return `필수 항목 '${p.missingProperty}' 이(가) 없어요`;
    case 'additionalProperties':
      return `알 수 없는 항목 '${p.additionalProperty}' 이에요 (오타인지 확인하세요)`;
    case 'type':
      return `${TYPE_KO[p.type] ?? p.type} 이어야 해요`;
    case 'minimum':
      return `${p.limit} 이상이어야 해요`;
    case 'maximum':
      return `${p.limit} 이하여야 해요`;
    case 'exclusiveMinimum':
      return `${p.limit} 보다 커야 해요`;
    case 'exclusiveMaximum':
      return `${p.limit} 보다 작아야 해요`;
    case 'minItems':
      return `값이 ${p.limit}개 이상 있어야 해요`;
    case 'maxItems':
      return `값이 ${p.limit}개 이하여야 해요`;
    case 'minLength':
      return '비어 있으면 안 돼요';
    case 'minProperties':
      return '하나 이상 정해야 해요';
    case 'enum':
      return `다음 중 하나여야 해요: ${p.allowedValues.join(', ')}`;
    case 'pattern':
      if (p.pattern.startsWith('^#')) return '#RRGGBB 형식의 색상이어야 해요';
      return p.pattern.includes('_')
        ? '영문 소문자로 시작하고 영문 소문자, 숫자, -, _ 만 쓸 수 있어요'
        : '영문 소문자로 시작하고 영문 소문자, 숫자, - 만 쓸 수 있어요';
    case 'additionalItems':
      return `값이 ${p.limit}개 이하여야 해요`;
    case 'if':
    case 'anyOf':
    case 'oneOf':
      return null;
    default:
      return err.message;
  }
}

function lineColAt(text, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

function escapePtr(s) {
  return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** "/zones/2/station/time" → "zones[2](cut).station.time" */
export function readablePath(data, ptr) {
  if (!ptr) return '';
  const parts = ptr.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let out = '';
  let cur = data;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      out += `[${part}]`;
      cur = cur[Number(part)];
      if (cur && typeof cur === 'object' && typeof cur.id === 'string') out += `(${cur.id})`;
    } else {
      out += out ? `.${part}` : part;
      cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    }
  }
  return out;
}

const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number');
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number');
