import { Simulation } from './sim/engine.js';
import { Renderer } from './render/renderer.js';
import { Explorer } from './view/explorer.js';
import { Editor, uniqueId } from './editor/editor.js';
import { Panel, h, PROP_TYPES } from './editor/panel.js';
import { validateScenarioText } from './schema/index.js';
import { formatScenario } from './schema/format.js';
import * as api from './api.js';

const $ = (s) => document.querySelector(s);
const SPEEDS = [1, 2, 4];
const KINDS = {
  factory: { title: '봉제 공장 둘러보기', step: '공정', label: '공장', intro: '원단이 들어와 옷이 되어 나가기까지 공장 안을 직접 걸어 다니며 봐요.' },
  'supply-chain': { title: '바이어·벤더 둘러보기', step: '단계', label: '바이어·벤더', intro: '바이어가 기획한 오더가 벤더와 공장을 거쳐 물류센터에 들어오기까지 따라가 봐요.' },
};
const kindOf = (s) => KINDS[s?.kind] ?? KINDS.factory;
const WELCOMED_KEY = 'factory-sim.welcomed';

const state = {
  list: [],
  id: null,
  savedText: '', // 마지막으로 불러오거나 저장한 파일 원문
  savedCanon: '', // 그 내용을 비교용으로 정규화한 것
  brokenText: null, // 파일에 오류가 있어 열지 못했을 때의 원문
  mode: 'view',
  sim: null,
  speed: 1,
  issues: { errors: [], warnings: [] },
  docVersion: 0,
  simVersion: -1,
  storage: 'server',
  // 둘러보기
  camMode: 'follow', // follow | overview
  followZoom: null, // 사용자가 바꾼 따라가기 배율 (없으면 기본값)
  alertsOn: true,
  card: null, // {kind:'welcome'} | {kind:'zone', zoneId}
  returnTo: null, // 연결된 시나리오로 들어갔을 때 돌아갈 곳 {id, name}
  cardFolded: false,
};

const canvas = $('#view');
const renderer = new Renderer(canvas);
const explorer = new Explorer(blankScenario(), {
  onZoneEnter: (zone) => {
    // 투어로 걸어가는 중에는 지나가는 구역 대신 도착한 구역 카드만 연다
    if (explorer.tour && explorer.tourZones[explorer.tour.index] !== zone) return;
    openZoneCard(zone);
  },
  onTourStop: (zone) => openZoneCard(zone),
  onTourEnd: (completed) => {
    updateViewControls();
    if (state.card?.kind === 'zone') renderCard();
    if (completed) showAlert({ title: '🏁 공정 투어를 마쳤어요', body: `${explorer.tourZones.length}개 구역을 모두 둘러봤어요. 맵을 눌러 자유롭게 다시 돌아보세요.`, kind: 'done', always: true });
  },
});
const editor = new Editor({
  onChange: (info) => onDocChanged(info),
  onSelect: () => {
    panel.render();
    updateToolbar();
  },
});
const panel = new Panel($('#panel'), editor, {
  validate: (text) => validateScenarioText(text, { file: fileOf(state.id), expectedId: state.id }),
  renderIssues,
  brokenText: () => state.brokenText,
  scenarioList: () => state.list,
  applyJson: (data) => {
    if (editor.draft) editor.replaceDraft(data);
    else recoverFromBroken(data);
  },
});

const doc = () => editor.draft;
const fileOf = (id) => `scenarios/${id}.json`;
const viewScenario = () => state.sim?.scenario ?? null;

// ======================================================================
// 시나리오 불러오기·저장
// ======================================================================

async function refreshList() {
  state.list = await api.listScenarios();
  const sel = $('#scenario-select');
  sel.replaceChildren(...state.list.map((s) => h('option', { value: s.id }, s.local ? `${s.name} (이 브라우저)` : s.name)));
  if (state.id) sel.value = state.id;
}

async function openScenario(id, opts = {}) {
  let text;
  try {
    text = await api.loadScenarioText(id);
  } catch (e) {
    toast(e.message, '', 'err');
    return;
  }
  applyText(id, text, opts);
  history.replaceState(null, '', `#${id}`);
}

/** 파일 원문을 검증해 화면에 올린다 */
function applyText(id, text, { keepCamera = false, live = false } = {}) {
  const res = validateScenarioText(text, { file: fileOf(id), expectedId: id });
  if (!res.ok && live && doc() && state.id === id) {
    // 실시간 미리보기 중 파일에 오류가 생기면 이전 화면을 유지하고 오류만 보여준다
    state.issues = res;
    state.liveError = true;
    showIssues(true);
    toast('파일에 오류가 있어 이전 화면을 유지해요', `${res.errors.length}개 오류 · 아래 목록에서 줄 번호를 확인하세요`, 'err');
    return;
  }

  const sameScenario = state.id === id;
  state.id = id;
  state.savedText = text;
  state.liveError = false;
  $('#scenario-select').value = id;
  state.issues = res;

  if (res.ok) {
    updateBrand(res.data);
    state.savedCanon = JSON.stringify(res.data);
    state.brokenText = null;
    editor.load(res.data);
    state.docVersion++;
    if (state.mode === 'view') startViewing({ keepPlayer: keepCamera && sameScenario });
    else if (!keepCamera) fitEdit(res.data);
    showIssues(false);
  } else {
    state.savedCanon = '';
    state.brokenText = text;
    editor.load(null);
    state.sim = null;
    closeCard();
    showIssues(true);
  }
  panel.render();
  updateDirty();
  if (live && res.ok) toast('파일 변경을 반영했어요', fileOf(id));
}

function recoverFromBroken(data) {
  state.brokenText = null;
  editor.load(data);
  state.docVersion++;
  fitEdit(data);
  onDocChanged();
  panel.render();
}

function isDirty() {
  if (state.brokenText != null) return false;
  return !!doc() && JSON.stringify(doc()) !== state.savedCanon;
}

function updateDirty() {
  $('#dirty-dot').classList.toggle('hidden', !isDirty());
}

async function save() {
  if (!doc()) return toast('열린 시나리오에 오류가 있어 저장할 수 없어요', 'JSON 탭에서 고친 뒤 적용하세요', 'err');
  const text = formatScenario(doc());
  const res = validateScenarioText(text, { file: fileOf(state.id), expectedId: state.id });
  state.issues = res;
  if (!res.ok) {
    showIssues(true);
    return toast(`오류 ${res.errors.length}개를 고쳐야 저장돼요`, '목록을 누르면 해당 줄로 이동해요', 'err');
  }
  try {
    state.savingText = text;
    await api.saveScenarioText(state.id, text);
  } catch (e) {
    return toast(e.message, '', 'err');
  }
  state.savedText = text;
  state.savedCanon = JSON.stringify(res.data);
  updateDirty();
  await refreshList();
  toast(
    '저장했어요',
    state.storage === 'server' ? fileOf(state.id) : '정적 배포라 이 브라우저에만 저장돼요. 저장소에 넣으려면 내보내기를 쓰세요.',
  );
}

async function createScenario(kind) {
  const base = kind === 'duplicate' && doc() ? doc() : null;
  if (kind === 'duplicate' && !base) return toast('오류가 있는 시나리오는 복제할 수 없어요', '', 'err');
  const values = await askForm({
    title: kind === 'new' ? '새 시나리오' : '시나리오 복제',
    desc: kind === 'new' ? '빈 공장에서 시작해요. 구역과 경로를 맵 위에서 그려 넣으세요.' : `'${base.name}' 의 지금 내용(저장 안 한 변경 포함)을 새 파일로 복사해요.`,
    fields: [
      ...(base ? [] : [{ name: 'kind', label: '종류', type: 'select', value: 'factory', options: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])) }]),
      { name: 'name', label: '이름', value: base ? `${base.name} 복사본` : '새 공장' },
      { name: 'id', label: 'id (파일 이름)', value: uniqueId(base ? `${base.id}-copy` : 'new-factory', state.list.map((s) => s.id)), hint: '영문 소문자, 숫자, - 만 써요. 예: customer-a' },
    ],
    validate: (v) => validateNewId(v.id) ?? (v.name.trim() ? null : '이름을 입력하세요'),
    ok: kind === 'new' ? '만들기' : '복제',
  });
  if (!values) return;
  if (!(await confirmLeave())) return;
  const scenario = base ? structuredClone(base) : blankScenario(values.kind);
  scenario.id = values.id;
  scenario.name = values.name.trim();
  await saveNew(scenario);
}

function validateNewId(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return 'id 는 영문 소문자나 숫자로 시작하고 영문 소문자, 숫자, - 만 쓸 수 있어요';
  if (state.list.some((s) => s.id === id)) return `'${id}' 는 이미 있어요`;
  return null;
}

async function saveNew(scenario, text = formatScenario(scenario)) {
  try {
    state.savingText = text;
    await api.saveScenarioText(scenario.id, text);
  } catch (e) {
    return toast(e.message, '', 'err');
  }
  await refreshList();
  applyText(scenario.id, text);
  history.replaceState(null, '', `#${scenario.id}`);
  toast('새 시나리오를 만들었어요', state.storage === 'server' ? fileOf(scenario.id) : '이 브라우저에 저장했어요');
}

function blankScenario(kind = 'factory') {
  if (kind === 'supply-chain') return blankSupplyChain();
  return {
    $schema: '../src/schema/scenario.schema.json',
    id: 'new-factory',
    name: '새 공장',
    description: '',
    layout: { width: 960, height: 760, start: [480, 380], props: [] },
    view: { playerSpeed: 170, followSpan: 420, tourDwell: 14, alertSeconds: 9, wipWarn: 6 },
    stages: [
      { id: 'material', label: '자재', shape: 'roll', size: 14 },
      { id: 'product', label: '완성품', shape: 'shirt', size: 16 },
    ],
    zones: [
      {
        id: 'zone-1',
        name: '구역 1',
        icon: '📦',
        rect: [80, 80, 220, 160],
        station: { time: 2, variance: 0.2, stage: 'product', capacity: 1 },
        content: { does: '', people: '', data: [], point: '' },
      },
    ],
    flow: { spawnInterval: 3, spawnStage: 'material', speed: 60, gap: 22, path: [[40, 160], [600, 160]] },
    events: [],
  };
}

function blankSupplyChain() {
  return {
    $schema: '../src/schema/scenario.schema.json',
    id: 'new-supply-chain',
    name: '새 오더 흐름',
    description: '',
    kind: 'supply-chain',
    layout: {
      width: 960,
      height: 560,
      start: [480, 280],
      areas: [
        { name: '바이어', icon: '🏢', rect: [20, 20, 450, 520] },
        { name: '벤더', icon: '🗂️', rect: [490, 20, 450, 520] },
      ],
      props: [],
    },
    view: { playerSpeed: 170, followSpan: 420, tourDwell: 14, alertSeconds: 9, wipWarn: 6 },
    stages: [
      { id: 'po', label: 'PO', shape: 'doc', size: 14 },
      { id: 'order', label: '확정 오더', shape: 'doc', size: 16, mark: 'check' },
    ],
    zones: [
      { id: 'buyer', name: '바이어 MD', icon: '📋', rect: [60, 80, 200, 160], station: { time: 5, variance: 0.2, stage: 'po', capacity: 1 }, content: { does: '', people: '', data: [], point: '' } },
      { id: 'vendor', name: '벤더 영업', icon: '🤝', rect: [540, 80, 200, 160], station: { time: 4, variance: 0.2, stage: 'order', capacity: 1 }, content: { does: '', people: '', data: [], point: '' } },
    ],
    flow: { spawnInterval: 6, spawnStage: 'po', speed: 100, gap: 22, clockFormat: 'day', timeScale: 86400, path: [[40, 200], [900, 200]] },
    events: [],
  };
}

async function importFile(file) {
  const text = await file.text();
  const res = validateScenarioText(text, { file: file.name });
  if (!res.ok) {
    state.issues = res;
    showIssues(true, { importing: true });
    return toast('가져올 파일에 오류가 있어요', `${file.name} · ${res.errors.length}개 오류`, 'err');
  }
  let scenario = res.data;
  let keepText = true;
  if (state.list.some((s) => s.id === scenario.id)) {
    const values = await askForm({
      title: '같은 id 가 이미 있어요',
      desc: `'${scenario.id}' 시나리오가 이미 있어요. 새 id 로 가져오거나, 같은 id 로 덮어쓸 수 있어요.`,
      fields: [{ name: 'id', label: '새 id', value: uniqueId(scenario.id, state.list.map((s) => s.id)) }],
      validate: (v) => (v.id === scenario.id ? null : validateNewId(v.id)),
      ok: '가져오기',
      extra: { label: '덮어쓰기', value: { id: scenario.id, overwrite: true } },
    });
    if (!values) return;
    if (values.id !== scenario.id) {
      scenario = { ...scenario, id: values.id };
      keepText = false;
    } else if (!values.overwrite) return;
  }
  if (!(await confirmLeave())) return;
  await saveNew(scenario, keepText ? text : formatScenario(scenario));
}

function exportCurrent() {
  const text = doc() ? formatScenario(doc()) : state.brokenText;
  if (text == null) return;
  const blob = new Blob([text], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${state.id}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function confirmLeave() {
  if (!isDirty()) return true;
  return confirm('저장하지 않은 변경이 있어요. 버리고 계속할까요?');
}

// 디스크의 파일이 바뀌면 바로 반영 (JSON 직접 편집 + 실시간 미리보기)
api.onScenarioFileChanged(async (id) => {
  await refreshList().catch(() => {});
  if (id !== state.id) return;
  let text;
  try {
    text = await api.loadScenarioText(id);
  } catch {
    return toast('열려 있는 시나리오 파일이 지워졌어요', fileOf(id), 'warn');
  }
  // 방금 이 화면에서 저장한 내용이면 무시 (단, 파일 오류를 보여주는 중이면 다시 반영)
  if (!state.liveError && (text === state.savedText || text === state.savingText)) return;
  if (isDirty()) {
    toast('디스크의 파일이 바뀌었어요', '편집 중인 변경이 있어 반영하지 않았어요', 'warn', {
      label: '디스크 내용 불러오기',
      run: () => applyText(id, text, { keepCamera: true }),
    });
    return;
  }
  applyText(id, text, { keepCamera: true, live: true });
});

// ======================================================================
// 둘러보기: 시뮬레이션·플레이어·카메라
// ======================================================================

/** 지금 문서로 시뮬레이션을 새로 만들고(예열 포함) 플레이어를 놓는다 */
function startViewing({ keepPlayer = false } = {}) {
  if (!doc() || state.issues.errors.length) return;
  const scenario = structuredClone(doc());
  const prev = keepPlayer ? { ...explorer.player } : null;
  state.sim = new Simulation(scenario);
  state.sim.warmUp();
  state.simVersion = state.docVersion;
  state.sim.on(onSimEvent);
  explorer.load(scenario);
  if (prev) {
    [explorer.player.x, explorer.player.y] = explorer.clampToMap(prev.x, prev.y);
    explorer.zoneId = explorer.zoneAt(prev.x, prev.y)?.id ?? null;
  }
  updateViewControls();
  updateMetrics();
  if (state.card?.kind === 'zone' && !scenario.zones.some((z) => z.id === state.card.zoneId)) closeCard();
  else if (state.card) renderCard();
  aimCamera(true);
}

function onSimEvent(type, payload) {
  if (type === 'event:start') {
    const parts = [payload.description, payload.point ? `현장 포인트: ${payload.point}` : null].filter(Boolean);
    showAlert({ title: `${payload.icon ?? '⚠️'} ${payload.label}`, body: parts[0] ?? '', point: parts[1] });
  }
  if (type === 'event:start' || type === 'event:end') updateBadges();
}

function defaultFollowZoom(scenario) {
  const span = scenario.view?.followSpan ?? 420;
  return Math.min(1.5, Math.min(renderer.width, renderer.height) / span);
}

function zoomRange(scenario) {
  return [renderer.fitZoom(scenario) * 0.9, 3];
}

/** 따라가기: 플레이어를 가운데에 두되 맵 가장자리 밖은 보이지 않게. 전체 보기: 맵 전체를 96% 안에 */
function aimCamera(instant = false) {
  const s = viewScenario();
  if (!s || !renderer.width) return;
  const { width: W, height: H } = s.layout;
  if (state.camMode === 'overview') {
    renderer.setView(W / 2, H / 2, renderer.fitZoom(s, 0.96), instant);
    return;
  }
  const [zmin, zmax] = zoomRange(s);
  const zoom = clamp(state.followZoom ?? defaultFollowZoom(s), zmin, zmax);
  const halfW = renderer.width / 2 / zoom;
  const halfH = renderer.height / 2 / zoom;
  const p = explorer.player;
  const cx = W <= halfW * 2 ? W / 2 : clamp(p.x, halfW, W - halfW);
  const cy = H <= halfH * 2 ? H / 2 : clamp(p.y, halfH, H - halfH);
  renderer.setView(cx, cy, zoom, instant);
}

/** 확대·축소: 전체 보기 중이면 따라가기로 바꾼다 */
function zoomBy(factor) {
  const s = viewScenario();
  if (!s) return;
  const [zmin, zmax] = zoomRange(s);
  const base = state.camMode === 'overview' ? renderer.goal.zoom : state.followZoom ?? defaultFollowZoom(s);
  state.followZoom = clamp(base * factor, zmin, zmax);
  state.camMode = 'follow';
  updateViewControls();
}

function toggleOverview() {
  state.camMode = state.camMode === 'overview' ? 'follow' : 'overview';
  updateViewControls();
}

function cycleSpeed() {
  state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
  updateViewControls();
}

function triggerEventButton() {
  const def = state.sim?.triggerRandom();
  if (!def) toast('일으킬 수 있는 돌발 상황이 없어요', '시나리오에 돌발 상황을 추가하거나 진행 중인 것이 끝나길 기다리세요', 'warn');
}

function toggleTour() {
  if (explorer.tour) explorer.stopTour();
  else {
    markWelcomed();
    explorer.startTour();
    state.camMode = 'follow';
  }
  updateViewControls();
  if (state.card) renderCard();
}

function updateViewControls() {
  const press = (el, on) => {
    el.setAttribute('aria-pressed', String(on));
  };
  press($('#tour-btn'), !!explorer.tour);
  $('#tour-btn').textContent = explorer.tour ? '투어 중단' : '공정 투어';
  press($('#overview-btn'), state.camMode === 'overview');
  $('#speed-btn').textContent = `속도 ${state.speed}×`;
  press($('#alerts-btn'), state.alertsOn);
  $('#alerts-btn').textContent = state.alertsOn ? '알림 켬' : '알림 끔';
  $('#event-btn').disabled = !state.sim?.events.length;
  const back = state.returnTo && state.returnTo.id !== state.id ? state.returnTo : null;
  $('#back-btn').classList.toggle('hidden', !back);
  if (back) $('#back-btn').textContent = `← ${back.name}로`;
}

function updateMetrics() {
  const sim = state.sim;
  const s = sim?.stats ?? { spawned: 0, shipped: 0, defects: 0 };
  $('#m-spawned').textContent = s.spawned;
  $('#m-wip').textContent = sim?.wip ?? 0;
  $('#m-shipped').textContent = s.shipped;
  $('#m-defects').textContent = s.defects;
  $('#clock').textContent = sim?.clockText ?? '--:--';
}

function updateBadges() {
  const sim = state.sim;
  const el = $('#badges');
  if (!sim || state.mode !== 'view') return el.replaceChildren();
  el.replaceChildren(
    ...sim.activeEvents.map((ev) =>
      h('span', { class: 'badge' }, `${ev.def.icon ?? '⚠️'} ${ev.def.label} 진행 중 · ${Math.max(0, Math.ceil(ev.endsAt - sim.time))}초`),
    ),
  );
}

// ======================================================================
// 구역 카드 (시작 안내 · 펼침 · 접힘)
// ======================================================================

function welcomed() {
  try {
    return localStorage.getItem(WELCOMED_KEY) === '1';
  } catch {
    return false;
  }
}

function markWelcomed() {
  try {
    localStorage.setItem(WELCOMED_KEY, '1');
  } catch {
    /* 저장소를 못 쓰면 이번 방문에서만 기억한다 */
  }
  if (state.card?.kind === 'welcome') closeCard();
}

function openZoneCard(zone) {
  if (state.mode !== 'view') return;
  if (state.card?.kind === 'welcome') markWelcomed();
  state.card = { kind: 'zone', zoneId: zone.id };
  renderCard();
}

function closeCard() {
  state.card = null;
  $('#zone-card').classList.add('hidden');
}

function renderCard() {
  const el = $('#zone-card');
  const s = viewScenario();
  if (!state.card || !s || state.mode !== 'view') return el.classList.add('hidden');
  el.classList.toggle('folded', state.cardFolded);
  el.classList.toggle('welcome', state.card.kind === 'welcome');

  const title = (icon, step, name) =>
    h('button', {
      class: 'card-title',
      'aria-expanded': String(!state.cardFolded),
      onclick: () => {
        state.cardFolded = !state.cardFolded;
        renderCard();
      },
    }, [
      h('span', { class: 'icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'names' }, [step ? h('span', { class: 'step' }, step) : null, h('span', { class: 'name' }, name)]),
      h('span', { class: 'fold' }, state.cardFolded ? '펼치기' : '접기'),
    ]);

  if (state.card.kind === 'welcome') {
    el.replaceChildren(
      title('👋', '처음 오셨나요?', `${s.name} 둘러보기`),
      h('div', { class: 'card-body' }, [
        h('p', {}, kindOf(s).intro),
        h('ul', {}, [
          h('li', {}, '맵을 누르면 그곳으로 걸어가요. 방향키나 WASD 도 돼요.'),
          h('li', {}, '구역에 들어가면 하는 일과 현장 포인트가 여기에 떠요.'),
          h('li', {}, `공정 투어를 시작하면 ${s.zones[0].name}부터 ${s.zones.at(-1).name}까지 차례로 데려다줘요.`),
        ]),
        h('button', { class: 'primary-btn', onclick: () => toggleTour() }, '공정 투어 시작'),
      ]),
    );
    el.classList.remove('hidden');
    return;
  }

  const zone = s.zones.find((z) => z.id === state.card.zoneId);
  if (!zone) return closeCard();
  const c = zone.content ?? {};
  const stationZones = s.zones.filter((z) => z.station);
  const stepNo = stationZones.indexOf(zone) + 1;
  const [zx, zy, zw, zh] = zone.rect;
  const [cx, cy] = [zx + zw / 2, zy + zh / 2];
  const area = (s.layout.areas ?? []).find(({ rect: [ax, ay, aw, ah] }) => cx >= ax && cx <= ax + aw && cy >= ay && cy <= ay + ah);
  const stepText = zone.station ? `${kindOf(s).step} ${stepNo} / ${stationZones.length}` : zone.hub ? '데이터가 모이는 곳' : '구역';
  const step = area ? `${area.name} · ${stepText}` : stepText;
  const linked = zone.link ? state.list.find((x) => x.id === zone.link) : null;
  const people = (c.people ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  const tour = explorer.tour;
  const isTourStop = tour && explorer.tourZones[tour.index] === zone;
  const last = tour && tour.index >= explorer.tourZones.length - 1;
  const liveText = h('span', { id: 'card-live' });

  el.replaceChildren(
    title(zone.icon ?? '📍', step, zone.name),
    h('div', { class: 'card-body' }, [
      c.does ? h('p', { class: 'does' }, c.does) : h('p', { class: 'does' }, '설명이 아직 없어요.'),
      people.length ? h('h3', {}, '현장 사람들') : null,
      people.length ? h('p', {}, people.join(', ')) : null,
      c.data?.length ? h('h3', {}, '시스템에 남는 데이터') : null,
      c.data?.length ? h('div', { class: 'tags' }, c.data.map((d) => h('span', { class: 'tag' }, d))) : null,
      c.point ? h('div', { class: 'point' }, [h('h3', {}, '개발·디자인 포인트'), h('p', {}, c.point)]) : null,
      zone.link
        ? h('div', { class: 'link-row' }, [
            h('button', {
              class: 'primary-btn',
              disabled: !linked,
              title: linked ? '' : `시나리오 '${zone.link}' 가 없어요`,
              onclick: () => enterLinked(zone.link),
            }, linked ? `${linked.name} 안으로 들어가기` : `'${zone.link}' 시나리오가 없어요`),
          ])
        : null,
      h('div', { class: 'live' }, [
        liveText,
        isTourStop ? h('button', { class: 'primary-btn', onclick: () => explorer.nextStop() }, last ? '투어 마치기' : '다음 구역 →') : null,
      ]),
    ]),
  );
  updateCardLive();
  el.classList.remove('hidden');
}

/** 카드 실시간 줄 (매 프레임) */
function updateCardLive() {
  const el = document.getElementById('card-live');
  if (!el || state.card?.kind !== 'zone') return;
  const s = viewScenario();
  const zone = s?.zones.find((z) => z.id === state.card.zoneId);
  if (!zone) return;
  const st = state.sim?.stationByZone.get(zone.id);
  let text;
  if (!zone.station) text = `공정 ${s.zones.filter((z) => z.station).length}곳의 기록이 이곳으로 모여요`;
  else text = `지금 이 구역 재공 ${state.sim?.zoneWip(zone) ?? 0}개${st?.stopped ? ' · 비가동' : ''}`;
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.toggle('down', !!st?.stopped);
  }
}

/** 헤더 제목·창 제목·캔버스 대체 텍스트를 시나리오 종류에 맞춘다 */
function updateBrand(s) {
  const k = kindOf(s);
  $('#brand').textContent = k.title;
  document.title = `${k.title} · ${s.name}`;
  canvas.setAttribute(
    'aria-label',
    `${s.name} 평면도. 구역: ${s.zones.map((z) => z.name).join(', ')}. 물건이 통로를 따라 구역을 지나며 모양이 바뀌어요. 맵을 누르면 그곳으로 걸어가고, 방향키나 WASD 로도 움직여요. 구역에 들어가면 설명 카드가 열려요.`,
  );
}

/** 구역 카드의 연결 버튼: 다른 시나리오(예: 공장 안)로 들어간다 */
async function enterLinked(id) {
  if (!(await confirmLeave())) return;
  const here = { id: state.id, name: doc()?.name ?? state.id };
  explorer.stopTour();
  closeCard();
  await openScenario(id);
  if (state.id === id) state.returnTo = here;
  updateViewControls();
}

async function goBack() {
  const back = state.returnTo;
  if (!back || !(await confirmLeave())) return;
  state.returnTo = null;
  explorer.stopTour();
  closeCard();
  await openScenario(back.id);
  updateViewControls();
}

// ======================================================================
// 알림 (돌발 상황 · 투어 완료)
// ======================================================================

let alertTimer = 0;
function showAlert({ title, body, point, kind = '', always = false }) {
  if (!always && !state.alertsOn) return;
  if (state.mode !== 'view') return;
  const el = $('#alert');
  el.className = `alert ${kind}`;
  el.replaceChildren(
    h('h2', {}, title),
    body ? h('p', {}, body) : null,
    point ? h('p', {}, point) : null,
    h('button', { class: 'x', 'aria-label': '알림 닫기', onclick: (e) => {
      e.stopPropagation();
      hideAlert();
    } }, '✕'),
  );
  // 같은 요소를 다시 쓰면 등장 효과가 다시 돌도록
  void el.offsetWidth;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(hideAlert, (viewScenario()?.view?.alertSeconds ?? 9) * 1000);
}

function hideAlert() {
  clearTimeout(alertTimer);
  $('#alert').classList.add('hidden');
}

$('#alert').addEventListener('click', hideAlert);

// ======================================================================
// 편집 모드
// ======================================================================

const TOOL_HINTS = {
  select: '끌어서 옮기고 모서리로 크기 조절 · Shift+화살표 10px · Delete 삭제 · ⌘D 복제 · Space+끌기 화면 이동',
  path: '빈 곳 클릭: 끝에 점 추가 · 선 위 클릭: 사이에 추가 · 오른쪽 클릭: 점 삭제',
  'add-zone': '맵 위를 끌어 새 구역을 그려요 (클릭만 하면 기본 크기)',
  'add-prop': '맵 위를 끌어 소품을 그려요 (사람은 클릭만)',
};

function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === 'view') {
    if (!doc()) return toast('시나리오에 오류가 있어 실행할 수 없어요', 'JSON 탭에서 고쳐 주세요', 'err');
    if (state.issues.errors.length) {
      showIssues(true);
      return toast(`오류 ${state.issues.errors.length}개를 고쳐야 실행돼요`, '', 'err');
    }
  }
  state.mode = mode;
  for (const b of document.querySelectorAll('#mode-toggle button')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const editing = mode === 'edit';
  $('#panel').classList.toggle('hidden', !editing);
  $('#edit-toolbar').classList.toggle('hidden', !editing);
  $('#view-controls').classList.toggle('hidden', editing);
  $('#edit-controls').classList.toggle('hidden', !editing);
  $('#metrics').classList.toggle('hidden', editing);
  $('#clock').classList.toggle('hidden', editing);
  $('#zoom-fit').classList.toggle('hidden', !editing);
  if (editing) {
    explorer.stopTour();
    explorer.releaseKeys();
    hideAlert();
    $('#zone-card').classList.add('hidden');
    panel.render();
    updateToolbar();
  } else {
    editor.tool = 'select';
    showIssues(false);
  }
  updateBadges();
  // 편집 패널이 열리고 닫히면 화면 너비가 바뀌니 맵을 다시 맞춘다
  requestAnimationFrame(() => {
    renderer.resize();
    if (editing) fitEdit();
    else if (state.simVersion !== state.docVersion || !state.sim) startViewing({ keepPlayer: true });
    else {
      aimCamera(true);
      renderCard();
    }
  });
}

function updateToolbar() {
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === editor.tool);
  $('#prop-type').classList.toggle('hidden', editor.tool !== 'add-prop');
  $('#undo').disabled = !editor.undoStack.length;
  $('#redo').disabled = !editor.redoStack.length;
  const n = state.issues.errors.length;
  const w = state.issues.warnings.length;
  const status = n ? ` · 오류 ${n}` : w ? ` · 경고 ${w}` : '';
  $('#tool-hint').textContent = TOOL_HINTS[editor.tool] + status;
}

let validateTimer = 0;
function onDocChanged(info = {}) {
  state.docVersion++;
  updateDirty();
  if (!info.live) panel.refreshValues();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(() => {
    if (!doc()) return;
    state.issues = validateScenarioText(formatScenario(doc()), { file: fileOf(state.id), expectedId: state.id });
    if ($('#issues').classList.contains('hidden') === false) showIssues(true);
    else if (!state.issues.errors.length) showIssues(false);
    updateToolbar();
  }, info.live ? 250 : 120);
  updateToolbar();
}

// ======================================================================
// 오류 목록
// ======================================================================

function renderIssues(el, issues, onPick) {
  el.replaceChildren(
    ...issues.map((iss) =>
      h('button', { class: `issue ${iss.severity}`, onclick: () => onPick(iss) }, [
        h('span', { class: 'sev' }, iss.severity === 'error' ? '오류' : '경고'),
        h('span', { class: 'loc' }, `${iss.file}:${iss.line}:${iss.column}${iss.path ? `  ${iss.path}` : ''}`),
        h('span', { class: 'msg' }, iss.message),
      ]),
    ),
  );
}

function showIssues(show, { importing = false } = {}) {
  const box = $('#issues');
  const { errors, warnings } = state.issues;
  if (!show || (!errors.length && !warnings.length)) {
    box.classList.add('hidden');
    return;
  }
  const list = h('div', { class: 'issue-list' });
  renderIssues(list, [...errors, ...warnings], (iss) => {
    if (importing) return;
    if (state.mode !== 'edit') setMode('edit');
    // 화면의 줄 번호는 지금 편집 중인 내용(또는 오류가 있는 원문) 기준
    panel.openJsonAt(iss.line, doc() ? null : state.brokenText);
  });
  const fixBtn = !doc() && !importing ? h('button', { class: 'mini primary', onclick: () => {
    setMode('edit');
    panel.openJsonAt(errors[0]?.line, state.brokenText);
  } }, 'JSON 에서 고치기') : null;
  box.replaceChildren(
    h('header', {}, [
      h('b', {}, `${importing ? '가져오기 실패 · ' : ''}오류 ${errors.length} · 경고 ${warnings.length}`),
      fixBtn,
      h('button', { class: 'mini', onclick: () => box.classList.add('hidden') }, '닫기'),
    ]),
    list,
  );
  box.classList.remove('hidden');
}

// ======================================================================
// 메시지·대화상자
// ======================================================================

function toast(title, detail = '', kind = '', action = null) {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, [
    h('div', {}, [h('b', {}, title), detail ? h('small', {}, detail) : null]),
    action ? h('button', { class: 'mini', onclick: () => { action.run(); el.remove(); } }, action.label) : null,
  ]);
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), action ? 10000 : kind === 'err' ? 6000 : 3500);
}

function askForm({ title, desc, fields, validate, ok = '확인', extra = null }) {
  const dlg = $('#dialog');
  return new Promise((resolve) => {
    const inputs = {};
    const err = h('div', { class: 'error' });
    const form = h('form', { method: 'dialog' }, [
      h('h2', {}, title),
      desc ? h('p', {}, desc) : null,
      ...fields.map((f) => {
        const input =
          f.type === 'select'
            ? h('select', { name: f.name }, Object.entries(f.options).map(([v, t]) => h('option', { value: v, selected: v === f.value }, t)))
            : h('input', { type: 'text', value: f.value ?? '', name: f.name });
        inputs[f.name] = input;
        return h('label', { class: 'field' }, [h('span', { class: 'label' }, f.label), input, f.hint ? h('span', { class: 'hint' }, f.hint) : null]);
      }),
      err,
      h('div', { class: 'buttons' }, [
        h('button', { type: 'button', onclick: () => finish(null) }, '취소'),
        extra ? h('button', { type: 'button', class: 'danger', onclick: () => finish(extra.value) }, extra.label) : null,
        h('button', { type: 'submit', class: 'primary' }, ok),
      ]),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
      const msg = validate?.(values);
      if (msg) {
        err.textContent = msg;
        return;
      }
      finish(values);
    });
    const finish = (v) => {
      dlg.close();
      resolve(v);
    };
    dlg.onclose = () => resolve(null);
    dlg.replaceChildren(form);
    dlg.showModal();
    Object.values(inputs).find((el) => el.tagName === 'INPUT')?.select();
  });
}

// ======================================================================
// 입력
// ======================================================================

const pointers = new Map();
let gesture = null; // {type:'pan'|'pinch'|'edit'|'click', ...}
let spaceHeld = false;

function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = localPos(e);
  pointers.set(e.pointerId, [sx, sy]);
  if (pointers.size === 2) {
    if (gesture?.type === 'edit') editor.onPointerUp();
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (pointers.size > 2) return;
  const editing = state.mode === 'edit';
  if (editing && (e.button === 1 || spaceHeld)) {
    gesture = { type: 'pan', last: [sx, sy] };
    return;
  }
  const [wx, wy] = renderer.toWorld(sx, sy);
  if (editing && editor.onPointerDown(wx, wy, e, renderer)) {
    gesture = { type: 'edit' };
    return;
  }
  gesture = { type: 'click', start: [sx, sy], last: [sx, sy], moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  const [sx, sy] = localPos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
  const [wx, wy] = renderer.toWorld(sx, sy);
  const editing = state.mode === 'edit';

  if (gesture?.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (editing) {
      renderer.pan(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
      renderer.zoomAt(mid[0], mid[1], dist / gesture.dist);
    } else {
      zoomBy(dist / gesture.dist);
    }
    gesture.dist = dist;
    gesture.mid = mid;
    return;
  }
  if (gesture?.type === 'pan' || gesture?.type === 'click') {
    const [lx, ly] = gesture.last;
    if (gesture.type === 'click' && Math.hypot(sx - gesture.start[0], sy - gesture.start[1]) > 6) gesture.moved = true;
    // 편집 화면에서만 끌어서 화면을 옮긴다 (둘러보기는 카메라가 플레이어를 따라간다)
    if (editing && (gesture.type === 'pan' || gesture.moved)) {
      renderer.pan(sx - lx, sy - ly);
      canvas.style.cursor = 'grabbing';
    }
    gesture.last = [sx, sy];
    return;
  }
  if (editing) {
    editor.onPointerMove(wx, wy, e, renderer);
    canvas.style.cursor = spaceHeld ? 'grab' : editor.cursorAt(wx, wy, renderer);
  } else {
    canvas.style.cursor = 'pointer';
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (pointers.size === 0) gesture = null;
    return;
  }
  if (gesture.type === 'edit') editor.onPointerUp();
  if (gesture.type === 'click' && !gesture.moved && state.mode === 'view' && state.sim && e.type === 'pointerup') {
    const [wx, wy] = renderer.toWorld(...localPos(e));
    explorer.walkTo(wx, wy);
    updateViewControls();
  }
  gesture = null;
  canvas.style.cursor = '';
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const [sx, sy] = localPos(e);
    if (state.mode === 'view') {
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      return;
    }
    if (e.ctrlKey || e.metaKey || !e.deltaX) {
      renderer.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      renderer.pan(-e.deltaX, -e.deltaY);
    }
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
    return;
  }
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || $('#dialog').open) return;

  if (state.mode === 'view') {
    if (mod || e.altKey) return;
    if (explorer.keyDown(e.key)) {
      e.preventDefault();
      updateViewControls();
    } else if (e.key === 'Escape') hideAlert();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    spaceHeld = true;
    return;
  }
  if (editor.onKeyDown(e)) {
    updateToolbar();
    return;
  }
  const tools = { v: 'select', p: 'path', z: 'add-zone' };
  if (!mod && tools[e.key.toLowerCase()]) setTool(tools[e.key.toLowerCase()]);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceHeld = false;
  explorer.keyUp(e.key);
});
window.addEventListener('blur', () => explorer.releaseKeys());

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) e.preventDefault();
});

function setTool(tool) {
  editor.tool = tool;
  editor.newPropType = $('#prop-type').value;
  updateToolbar();
}

// 버튼 연결
$('#scenario-actions').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'save') save();
  if (act === 'new') createScenario('new');
  if (act === 'duplicate') createScenario('duplicate');
  if (act === 'export') exportCurrent();
  if (act === 'import') $('#import-file').click();
});
$('#import-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importFile(f);
});
$('#scenario-select').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!(await confirmLeave())) {
    e.target.value = state.id;
    return;
  }
  explorer.stopTour();
  state.returnTo = null;
  await openScenario(id);
  updateViewControls();
});
$('#mode-toggle').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.mode;
  if (m) setMode(m);
});
$('#back-btn').addEventListener('click', goBack);
$('#tour-btn').addEventListener('click', toggleTour);
$('#overview-btn').addEventListener('click', toggleOverview);
$('#speed-btn').addEventListener('click', cycleSpeed);
$('#event-btn').addEventListener('click', triggerEventButton);
$('#alerts-btn').addEventListener('click', () => {
  state.alertsOn = !state.alertsOn;
  if (!state.alertsOn && !$('#alert').classList.contains('done')) hideAlert();
  updateViewControls();
});
$('#prop-type').replaceChildren(...Object.entries(PROP_TYPES).map(([v, t]) => h('option', { value: v }, t)));
$('#tools').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tool;
  if (t) setTool(t);
});
$('#prop-type').addEventListener('change', (e) => (editor.newPropType = e.target.value));
$('#undo').addEventListener('click', () => editor.undo());
$('#redo').addEventListener('click', () => editor.redo());
$('#snap').addEventListener('change', (e) => (editor.snap = e.target.checked ? 10 : 0));
$('#zoom-in').addEventListener('click', () => (state.mode === 'view' ? zoomBy(1.25) : renderer.zoomAt(renderer.width / 2, renderer.height / 2, 1.25)));
$('#zoom-out').addEventListener('click', () => (state.mode === 'view' ? zoomBy(1 / 1.25) : renderer.zoomAt(renderer.width / 2, renderer.height / 2, 1 / 1.25)));
$('#zoom-fit').addEventListener('click', () => fitEdit());

// 다크 모드·data-theme·동작 줄이기 설정을 따라간다
const darkMq = matchMedia('(prefers-color-scheme: dark)');
darkMq.addEventListener('change', () => renderer.refreshTheme());
new MutationObserver(() => renderer.refreshTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const motionMq = matchMedia('(prefers-reduced-motion: reduce)');
renderer.reducedMotion = motionMq.matches;
motionMq.addEventListener('change', () => (renderer.reducedMotion = motionMq.matches));

// ======================================================================
// 그리기 반복
// ======================================================================

let last = performance.now();
let uiTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const sim = state.sim;
  const viewing = state.mode === 'view';

  try {
    if (viewing && sim) {
      sim.step(dt * state.speed);
      explorer.update(dt);
      aimCamera();
      renderer.update(dt);
      renderer.render(sim.scenario, sim, {
        highlightZone: explorer.zoneId,
        clock: now / 1000,
        player: explorer.player,
        target: explorer.target,
      });
      updateCardLive();
      uiTimer += dt;
      if (uiTimer >= 0.2) {
        uiTimer = 0;
        updateMetrics();
        updateBadges();
      }
    } else if (doc()) {
      renderer.render(doc(), null, { editing: true, overlay: (ctx, r) => editor.drawOverlay(ctx, r) });
    } else {
      drawEmpty();
    }
  } catch (err) {
    // 편집 중 잠깐 잘못된 값이 들어와도 그리기 반복은 멈추지 않는다
    console.warn(err);
  }
  requestAnimationFrame(frame);
}

function drawEmpty() {
  const ctx = renderer.ctx;
  const t = renderer.t;
  ctx.setTransform(renderer.dpr, 0, 0, renderer.dpr, 0, 0);
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, renderer.width, renderer.height);
  ctx.fillStyle = t.muted;
  ctx.font = '500 15px "IBM Plex Sans KR", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.brokenText != null ? '시나리오 파일에 오류가 있어 열 수 없어요. 오류 목록을 확인하세요.' : '시나리오를 불러오는 중…', renderer.width / 2, renderer.height / 2);
}

/** 편집 화면: 도구 막대 아래로 맵 전체를 맞춘다 */
function fitEdit(scenario = doc()) {
  if (!scenario) return;
  const bar = $('#edit-toolbar');
  renderer.fit(scenario, 24, bar.classList.contains('hidden') ? 0 : bar.offsetHeight + 12);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// ======================================================================
// 시작
// ======================================================================

new ResizeObserver(() => {
  renderer.resize();
  if (state.mode === 'view') aimCamera(true);
}).observe($('#stage'));

async function start() {
  renderer.resize();
  state.storage = await api.storageMode();
  await refreshList();
  if (!state.list.length) {
    drawEmpty();
    return toast('시나리오가 없어요', '편집 화면의 새로 만들기로 시작하세요', 'warn');
  }
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const id = state.list.some((s) => s.id === fromHash) ? fromHash : state.list.some((s) => s.id === 'standard-factory') ? 'standard-factory' : state.list[0].id;
  await openScenario(id);
  if (!welcomed() && state.sim) {
    state.card = { kind: 'welcome' };
    renderCard();
  }
  if (state.storage === 'static') {
    toast('읽기 전용 배포판이에요', '저장한 내용은 이 브라우저에만 남아요. 저장소에 넣으려면 내보내기를 쓰세요.', 'warn');
  }
  requestAnimationFrame(frame);
}

start();

// 개발 서버에서만: 자동 테스트와 콘솔 디버깅용
if (import.meta.env.DEV) window.__factory = { state, editor, renderer, explorer, doc };
