// 시나리오 저장소 접근.
// 개발 서버(npm run dev)에서는 scenarios/*.json 을 직접 읽고 쓴다.
// 정적 배포(npm run build)에서는 빌드에 포함된 시나리오를 읽기 전용으로 쓰고,
// 바꾼 내용은 이 브라우저에만 임시 저장한다(내보내기로 파일을 받아 저장소에 넣는다).

const bundled = import.meta.glob('../scenarios/*.json', { query: '?raw', import: 'default' });
const LOCAL_KEY = 'factory-sim:local-scenarios';

let mode = null; // 'server' | 'static'

async function detectMode() {
  if (mode) return mode;
  try {
    const res = await fetch('./api/scenarios', { cache: 'no-store' });
    mode = res.ok && res.headers.get('content-type')?.includes('json') ? 'server' : 'static';
  } catch {
    mode = 'static';
  }
  return mode;
}

export async function storageMode() {
  return detectMode();
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLocal(map) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
  } catch {
    throw new Error('브라우저 저장소를 쓸 수 없어요. 내보내기로 파일을 받아 두세요.');
  }
}

export async function listScenarios() {
  if ((await detectMode()) === 'server') {
    const res = await fetch('./api/scenarios', { cache: 'no-store' });
    return res.json();
  }
  const out = new Map();
  for (const [path, load] of Object.entries(bundled)) {
    const id = path.split('/').pop().slice(0, -5);
    let name = id;
    try {
      name = JSON.parse(await load()).name || id;
    } catch {
      // 목록에는 id 로 보여준다
    }
    out.set(id, { id, name });
  }
  for (const [id, text] of Object.entries(readLocal())) {
    let name = id;
    try {
      name = JSON.parse(text).name || id;
    } catch {
      // 목록에는 id 로 보여준다
    }
    out.set(id, { id, name, local: true });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadScenarioText(id) {
  if ((await detectMode()) === 'server') {
    const res = await fetch(`./api/scenarios/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`시나리오 '${id}' 를 찾을 수 없어요`);
    return res.text();
  }
  const local = readLocal()[id];
  if (local) return local;
  const load = bundled[`../scenarios/${id}.json`];
  if (!load) throw new Error(`시나리오 '${id}' 를 찾을 수 없어요`);
  return load();
}

export async function saveScenarioText(id, text) {
  if ((await detectMode()) === 'server') {
    const res = await fetch(`./api/scenarios/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    });
    if (!res.ok) throw new Error(`저장하지 못했어요 (${res.status})`);
    return;
  }
  const map = readLocal();
  map[id] = text;
  writeLocal(map);
}

export async function scenarioExists(id) {
  const list = await listScenarios();
  return list.some((s) => s.id === id);
}

/** 디스크의 시나리오 파일이 바뀌면 호출된다 (개발 서버에서만) */
export function onScenarioFileChanged(fn) {
  if (import.meta.hot) import.meta.hot.on('scenario:changed', (data) => fn(data.id));
}
