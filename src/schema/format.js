// 사람이 손으로 고치기 좋고 Git 비교가 쉬운 JSON 형식으로 저장한다.
// 짧은 배열([x, y, w, h])과 짧은 객체(소품, 물건 상태 등)는 한 줄로,
// 그보다 긴 것은 항목마다 한 줄로 쓴다.

const MAX_INLINE = 110;

export function formatScenario(value) {
  return `${fmt(value, '')}\n`;
}

function isPrimitive(v) {
  return v === null || typeof v !== 'object';
}

function fmt(v, indent) {
  if (isPrimitive(v)) return JSON.stringify(v);
  const next = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every(isPrimitive)) {
      const inline = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (inline.length + indent.length <= MAX_INLINE) return inline;
    }
    return `[\n${v.map((x) => next + fmt(x, next)).join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (keys.length === 0) return '{}';
  const inline = inlineObject(v, keys);
  if (inline && inline.length + indent.length <= MAX_INLINE) return inline;
  return `{\n${keys.map((k) => `${next}${JSON.stringify(k)}: ${fmt(v[k], next)}`).join(',\n')}\n${indent}}`;
}

/** 값이 모두 짧은 원시값·원시값 배열인 객체만 한 줄로 쓴다 */
function inlineObject(v, keys) {
  const parts = [];
  for (const k of keys) {
    const x = v[k];
    if (isPrimitive(x)) {
      if (typeof x === 'string' && x.length > 40) return null;
      parts.push(`${JSON.stringify(k)}: ${JSON.stringify(x)}`);
    } else if (Array.isArray(x) && x.every((e) => typeof e === 'number')) {
      parts.push(`${JSON.stringify(k)}: [${x.join(', ')}]`);
    } else return null;
  }
  return `{ ${parts.join(', ')} }`;
}
