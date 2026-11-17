// 오른쪽 속성 패널. 선택한 구역·소품·경로 점, 또는 시나리오 전체 설정을 입력 칸으로 고친다.

import { formatScenario } from '../schema/format.js';
import { uniqueId } from './editor.js';

export const PROP_TYPES = {
  machine: '미싱',
  table: '작업대',
  cutter: '재단기',
  iron: '다리미판',
  rack: '랙',
  rolls: '원단 랙',
  pallet: '팔레트',
  cart: '카트',
  truck: '트럭',
  desk: '책상',
  board: '현황판',
  wall: '벽',
  door: '문·도크',
  worker: '작업자',
  manager: '관리직',
};
const SHAPES = {
  roll: '원단 롤',
  layers: '연단(겹친 띠)',
  pieces: '재단물(조각)',
  bundle: '번들(태그)',
  shirt: '티셔츠',
  box: '박스',
  circle: '원',
  square: '네모',
};
const MARKS = { '': '없음', check: '흰 체크', 'check-tape': '노란 체크' };

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {import('./editor.js').Editor} editor
   * @param {{validate:(text:string)=>any, renderIssues:(el:HTMLElement, issues:any[], onPick:(i:any)=>void)=>void}} deps
   */
  constructor(root, editor, deps) {
    this.root = root;
    this.editor = editor;
    this.deps = deps;
    this.tab = 'props';
    this.bindings = [];
    this.openEvents = new Set();
  }

  setTab(tab) {
    this.tab = tab;
    this.render();
  }

  /** 맵에서 끌어 옮긴 값 등을 입력 칸에 반영 (입력 중인 칸은 건드리지 않는다) */
  refreshValues() {
    for (const b of this.bindings) {
      if (document.activeElement === b.el) continue;
      const v = b.get();
      if (b.el.type === 'checkbox') b.el.checked = !!v;
      else b.el.value = v ?? '';
    }
  }

  render() {
    const ed = this.editor;
    this.bindings = [];
    this.root.replaceChildren();
    if (!ed.draft) this.tab = 'json'; // 파일에 오류가 있으면 JSON 으로만 고칠 수 있다

    const tabs = h('div', { class: 'panel-tabs' }, [
      h('button', { class: this.tab === 'props' ? 'active' : '', disabled: !ed.draft, onclick: () => this.setTab('props') }, '속성'),
      h('button', { class: this.tab === 'json' ? 'active' : '', onclick: () => this.setTab('json') }, 'JSON'),
    ]);
    this.root.append(tabs);

    const body = h('div', { class: 'panel-body' });
    this.root.append(body);
    if (this.tab === 'json') return this.renderJson(body);

    const sel = ed.selection;
    if (!sel) this.renderScenario(body);
    else if (sel.kind === 'zone' || sel.kind === 'slot') this.renderZone(body, sel.index);
    else if (sel.kind === 'prop') this.renderProp(body, sel.index);
    else if (sel.kind === 'point') this.renderPoint(body, sel.index);
  }

  // ---------- 입력 칸 도우미 ----------

  bind(el, get, set, key, { event = 'input', parse = (v) => v } = {}) {
    if (el.type === 'checkbox') el.checked = !!get();
    else el.value = get() ?? '';
    el.addEventListener(event, () => {
      const raw = el.type === 'checkbox' ? el.checked : el.value;
      const v = parse(raw);
      if (v === INVALID) return;
      this.editor.mutate(key, () => set(v));
    });
    this.bindings.push({ el, get });
    return el;
  }

  text(label, get, set, key, opts = {}) {
    const el = h('input', { type: 'text', placeholder: opts.placeholder ?? '' });
    this.bind(el, get, set, key);
    return field(label, el, opts.hint);
  }

  area(label, get, set, key, opts = {}) {
    const el = h('textarea', { rows: opts.rows ?? 3, placeholder: opts.placeholder ?? '' });
    this.bind(el, get, set, key);
    return field(label, el, opts.hint);
  }

  num(label, get, set, key, opts = {}) {
    const el = h('input', { type: 'number', step: opts.step ?? 'any', min: opts.min ?? '', max: opts.max ?? '', placeholder: opts.placeholder ?? '' });
    this.bind(el, get, set, key, {
      parse: (v) => {
        if (v === '') return opts.optional ? undefined : INVALID;
        const n = Number(v);
        return Number.isFinite(n) ? n : INVALID;
      },
    });
    return field(label, el, opts.hint);
  }

  /** 0~1 값을 % 로 보여준다 */
  pct(label, get, set, key, opts = {}) {
    return this.num(
      label,
      () => (get() == null ? '' : round(get() * 100, 2)),
      (v) => set(v === undefined ? undefined : v / 100),
      key,
      { ...opts, step: 1, min: 0, max: 100 },
    );
  }

  select(label, options, get, set, key) {
    const el = h('select', {}, Object.entries(options).map(([v, t]) => h('option', { value: v }, t)));
    this.bind(el, get, set, key, { event: 'change' });
    return field(label, el);
  }

  check(label, get, set, key, onAfter) {
    const el = h('input', { type: 'checkbox' });
    this.bind(el, get, set, key, { event: 'change' });
    if (onAfter) el.addEventListener('change', onAfter);
    return h('label', { class: 'check' }, [el, h('span', {}, label)]);
  }

  color(label, get, set, key) {
    const el = h('input', { type: 'color' });
    this.bind(el, () => expandHex(get() ?? '#dddddd'), set, key);
    return field(label, el);
  }

  rectFields(get, key) {
    const names = ['x', 'y', '너비', '높이'];
    return h(
      'div',
      { class: 'grid4' },
      names.map((n, i) =>
        this.num(n, () => get()[i], (v) => (get()[i] = v), `${key}-${i}`, { step: 1, min: i >= 2 ? 1 : '' }),
      ),
    );
  }

  // ---------- 화면별 ----------

  renderScenario(body) {
    const d = this.editor.draft;
    body.append(
      h('h3', {}, '시나리오'),
      field('id', h('input', { type: 'text', value: d.id, disabled: true }), '파일 이름과 같아요. 바꾸려면 복제로 새로 만드세요.'),
      this.text('이름', () => d.name, (v) => (d.name = v), 'name'),
      this.area('설명', () => d.description, (v) => (v ? (d.description = v) : delete d.description), 'desc', { rows: 2 }),
      this.select('종류', { factory: '공장 안', 'supply-chain': '바이어·벤더 오더 흐름' }, () => d.kind ?? 'factory', (v) => setOpt(d, 'kind', v === 'factory' ? undefined : v), 'kind'),
      h('div', { class: 'grid2' }, [
        this.num('맵 너비', () => d.layout.width, (v) => (d.layout.width = v), 'mw', { step: 10, min: 200 }),
        this.num('맵 높이', () => d.layout.height, (v) => (d.layout.height = v), 'mh', { step: 10, min: 200 }),
      ]),
      h('div', { class: 'grid2' }, [
        this.num('시작 위치 x', () => d.layout.start?.[0], (v) => setStart(d, 0, v), 'st-x', { optional: true, step: 10, placeholder: '가운데' }),
        this.num('시작 위치 y', () => d.layout.start?.[1], (v) => setStart(d, 1, v), 'st-y', { optional: true, step: 10, placeholder: '가운데' }),
      ]),

      h('h3', {}, '둘러보기'),
      h('div', { class: 'grid2' }, [
        this.num('걷는 속도(px/초)', () => d.view?.playerSpeed, (v) => setView(d, 'playerSpeed', v), 'v-ps', { optional: true, placeholder: '170' }),
        this.num('투어 머무는 시간(초)', () => d.view?.tourDwell, (v) => setView(d, 'tourDwell', v), 'v-td', { optional: true, placeholder: '14' }),
        this.num('알림 표시 시간(초)', () => d.view?.alertSeconds, (v) => setView(d, 'alertSeconds', v), 'v-as', { optional: true, placeholder: '9' }),
        this.num('재공 경고 개수', () => d.view?.wipWarn, (v) => setView(d, 'wipWarn', v), 'v-ww', { optional: true, step: 1, min: 1, placeholder: '6' }),
        this.num('따라가기 화면 폭(px)', () => d.view?.followSpan, (v) => setView(d, 'followSpan', v), 'v-fs', { optional: true, step: 10, min: 100, placeholder: '420', hint: '작을수록 크게 보여요' }),
      ]),

      h('h3', {}, '흐름'),
      h('div', { class: 'grid2' }, [
        this.num('투입 간격(초)', () => d.flow.spawnInterval, (v) => (d.flow.spawnInterval = v), 'si', { step: 0.1, min: 0.1 }),
        this.select(
          '투입 상태',
          Object.fromEntries(d.stages.map((s) => [s.id, s.label])),
          () => d.flow.spawnStage ?? d.stages[0]?.id,
          (v) => (d.flow.spawnStage = v),
          'ss',
        ),
        this.num('통로 속도(px/초)', () => d.flow.speed, (v) => setOpt(d.flow, 'speed', v), 'sp', { optional: true, placeholder: '60' }),
        this.num('물건 간격(px)', () => d.flow.gap, (v) => setOpt(d.flow, 'gap', v), 'gap', { optional: true, placeholder: '22' }),
        this.num('예열(초)', () => d.flow.warmup, (v) => setOpt(d.flow, 'warmup', v), 'wu', { optional: true, step: 10, min: 0, placeholder: '0', hint: '미리 돌린 뒤 지표를 0으로' }),
        this.select('게임 시각 형식', { time: '시:분 (08:00)', day: 'n주차 n일' }, () => d.flow.clockFormat ?? 'time', (v) => setOpt(d.flow, 'clockFormat', v === 'time' ? undefined : v), 'cf'),
        this.text('시작 시각', () => d.flow.startTime, (v) => setOpt(d.flow, 'startTime', v || undefined), 'stt', { placeholder: '08:00' }),
        this.num('시각 배율', () => d.flow.timeScale, (v) => setOpt(d.flow, 'timeScale', v), 'ts', { optional: true, placeholder: d.flow.clockFormat === 'day' ? '86400' : '60', hint: '60 = 1초가 1분, 86400 = 1초가 하루' }),
      ]),
      this.text('원단 색', () => (d.flow.fabrics ?? []).join(', '), (v) => {
        const list = v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        setOpt(d.flow, 'fabrics', list.length ? list : undefined);
      }, 'fab', { placeholder: '#34507a, #6b7a3a, …', hint: '물건마다 이 중 하나를 무작위로 받아요. 쉼표로 구분' }),
      h('p', { class: 'hint' }, `경로 점 ${d.flow.path.length}개 · 위 도구 막대의 '경로'로 점을 찍거나 옮겨요.`),
    );

    // 영역 (회사·현장 경계)
    body.append(h('h3', {}, ['영역', h('button', { class: 'mini', onclick: () => this.addArea() }, '+ 추가')]));
    const areas = d.layout.areas ?? [];
    if (!areas.length) body.append(h('p', { class: 'hint' }, '바이어 본사, 벤더 사무실처럼 구역을 묶는 큰 영역이에요. 구역 아래에 그려져요.'));
    areas.forEach((a, i) => {
      body.append(
        h('div', { class: 'card' }, [
          h('div', { class: 'grid2' }, [
            this.text('이름', () => a.name, (v) => (a.name = v), `ar-n-${i}`),
            this.text('아이콘', () => a.icon, (v) => setOpt(a, 'icon', v || undefined), `ar-i-${i}`, { placeholder: '🏢' }),
          ]),
          this.rectFields(() => a.rect, `ar-r-${i}`),
          h('button', { class: 'mini danger', onclick: () => {
            this.editor.mutate(null, () => {
              areas.splice(i, 1);
              if (!areas.length) delete d.layout.areas;
            });
            this.render();
          } }, '삭제'),
        ]),
      );
    });

    // 물건 상태
    body.append(h('h3', {}, ['물건 상태', h('button', { class: 'mini', onclick: () => this.addStage() }, '+ 추가')]));
    d.stages.forEach((st, i) => {
      const used = d.zones.some((z) => z.station?.stage === st.id || z.station?.workingStage === st.id) || d.flow.spawnStage === st.id;
      const idEl = h('input', { type: 'text', value: st.id });
      idEl.addEventListener('change', () => {
        if (idEl.value && idEl.value !== st.id) this.editor.renameStage(i, idEl.value.trim());
      });
      body.append(
        h('div', { class: 'card' }, [
          h('div', { class: 'grid2' }, [
            field('id', idEl),
            this.text('이름', () => st.label, (v) => (st.label = v), `st-l-${i}`),
            this.select('모양', SHAPES, () => st.shape, (v) => (st.shape = v), `st-s-${i}`),
            this.num('크기', () => st.size, (v) => setOpt(st, 'size', v), `st-z-${i}`, { optional: true, step: 1, min: 4, max: 40, placeholder: '14' }),
            this.select('표시', MARKS, () => st.mark ?? '', (v) => setOpt(st, 'mark', v || undefined), `st-m-${i}`),
          ]),
          this.check('원단 색 대신 정해진 색', () => !!st.color, (on) => (on ? (st.color = '#b98a52') : delete st.color), `st-cc-${i}`, () => this.render()),
          st.color ? this.color('색상', () => st.color, (v) => (st.color = v), `st-c-${i}`) : null,
          h(
            'button',
            {
              class: 'mini danger',
              disabled: used || d.stages.length <= 1,
              title: used ? '공정이나 투입 상태에서 쓰는 중이라 지울 수 없어요' : '',
              onclick: () => {
                this.editor.mutate(null, () => d.stages.splice(i, 1));
                this.render();
              },
            },
            '삭제',
          ),
        ]),
      );
    });

    // 돌발 상황
    body.append(h('h3', {}, ['돌발 상황', h('button', { class: 'mini', onclick: () => this.addEvent() }, '+ 추가')]));
    const timing = d.eventTiming;
    body.append(
      this.check('하나씩 차례로 자동 발생', () => !!timing, (on) => (on ? (d.eventTiming = { gap: [40, 65], afterManual: 45 }) : delete d.eventTiming), 'et', () => this.render()),
      timing
        ? h('div', { class: 'grid2' }, [
            this.num('끝난 뒤 최소(초)', () => timing.gap[0], (v) => (timing.gap[0] = v), 'et-0', { step: 1, min: 1 }),
            this.num('끝난 뒤 최대(초)', () => timing.gap[1], (v) => (timing.gap[1] = v), 'et-1', { step: 1, min: 1 }),
            this.num('버튼으로 일으킨 뒤(초)', () => timing.afterManual, (v) => setOpt(timing, 'afterManual', v), 'et-m', { optional: true, step: 1, min: 1, placeholder: '45' }),
          ])
        : h('p', { class: 'hint' }, '끄면 돌발 상황마다 정한 간격으로 따로 일어나요.'),
    );
    d.events.forEach((ev, i) => body.append(this.eventCard(ev, i)));
  }

  eventCard(ev, i) {
    const d = this.editor.draft;
    const open = this.openEvents.has(i);
    const header = h('button', { class: 'card-head', onclick: () => {
      if (open) this.openEvents.delete(i);
      else this.openEvents.add(i);
      this.render();
    } }, [h('span', {}, ev.label || ev.id), h('span', { class: 'muted' }, open ? '접기' : '펼치기')]);
    if (!open) return h('div', { class: 'card' }, [header]);

    const idEl = h('input', { type: 'text', value: ev.id });
    idEl.addEventListener('change', () => this.editor.mutate(null, () => (ev.id = idEl.value.trim())));
    const auto = !!ev.interval;
    const e = ev.effect;
    return h('div', { class: 'card' }, [
      header,
      h('div', { class: 'grid2' }, [
        field('id', idEl),
        this.text('이름', () => ev.label, (v) => (ev.label = v), `ev-l-${i}`),
        this.text('아이콘', () => ev.icon, (v) => setOpt(ev, 'icon', v || undefined), `ev-ic-${i}`, { placeholder: '🔧' }),
        this.num('지속 시간(초)', () => ev.duration, (v) => (ev.duration = v), `ev-du-${i}`, { step: 1, min: 1 }),
      ]),
      this.area('화면에서 보이는 것', () => ev.description, (v) => (v ? (ev.description = v) : delete ev.description), `ev-d-${i}`, { rows: 2 }),
      this.area('현장 포인트', () => ev.point, (v) => (v ? (ev.point = v) : delete ev.point), `ev-p-${i}`, { rows: 2 }),
      d.eventTiming ? null : this.check('자동으로 발생', () => auto, (v) => (v ? (ev.interval = [60, 120]) : delete ev.interval), `ev-a-${i}`, () => this.render()),
      d.eventTiming
        ? null
        : auto
        ? h('div', { class: 'grid2' }, [
            this.num('최소 간격(초)', () => ev.interval[0], (v) => (ev.interval[0] = v), `ev-i0-${i}`, { step: 1, min: 1 }),
            this.num('최대 간격(초)', () => ev.interval[1], (v) => (ev.interval[1] = v), `ev-i1-${i}`, { step: 1, min: 1 }),
          ])
        : h('p', { class: 'hint' }, '수동으로만 발생해요 (보기 화면의 돌발 상황 버튼).'),
      h('h4', {}, '영향'),
      h('div', { class: 'grid2' }, [
        this.num('투입 배수', () => e.spawnMultiplier, (v) => setOpt(e, 'spawnMultiplier', v), `ev-m-${i}`, { optional: true, step: 0.5, min: 0, hint: '2 = 두 배, 0 = 투입 중단' }),
        this.pct('검사 불량률(%)', () => e.defectRate, (v) => setOpt(e, 'defectRate', v), `ev-r-${i}`, { optional: true, hint: '진행 중에는 이 값으로 바뀌어요' }),
      ]),
      field(
        '정지시킬 구역',
        h(
          'div',
          { class: 'chips' },
          d.zones
            .filter((z) => z.station)
            .map((z) =>
              this.check(z.name, () => e.stopZones?.includes(z.id), (on) => {
                const set = new Set(e.stopZones ?? []);
                if (on) set.add(z.id);
                else set.delete(z.id);
                if (set.size) e.stopZones = [...set];
                else delete e.stopZones;
              }, null),
            ),
        ),
      ),
      e.defectRate != null
        ? field(
            '불량률을 바꿀 검사 구역 (고르지 않으면 모든 검사 구역)',
            h(
              'div',
              { class: 'chips' },
              d.zones
                .filter((z) => z.station?.inspect)
                .map((z) =>
                  this.check(z.name, () => e.defectZones?.includes(z.id), (on) => {
                    const set = new Set(e.defectZones ?? []);
                    if (on) set.add(z.id);
                    else set.delete(z.id);
                    if (set.size) e.defectZones = [...set];
                    else delete e.defectZones;
                  }, null),
                ),
            ),
          )
        : null,
      h('button', { class: 'mini danger', onclick: () => {
        this.editor.mutate(null, () => d.events.splice(i, 1));
        this.openEvents.clear();
        this.render();
      } }, '이 돌발 상황 삭제'),
    ]);
  }

  addArea() {
    const d = this.editor.draft;
    this.editor.mutate(null, () => {
      d.layout.areas ??= [];
      d.layout.areas.push({ name: '새 영역', rect: [20, 20, Math.min(400, d.layout.width - 40), Math.min(300, d.layout.height - 40)] });
    });
    this.render();
  }

  addStage() {
    const d = this.editor.draft;
    const id = uniqueId('stage', d.stages.map((s) => s.id));
    this.editor.mutate(null, () => d.stages.push({ id, label: '새 상태', shape: 'circle', size: 14 }));
    this.render();
  }

  addEvent() {
    const d = this.editor.draft;
    const id = uniqueId('event', d.events.map((e) => e.id));
    this.editor.mutate(null, () =>
      d.events.push({ id, label: '새 돌발 상황', icon: '⚠️', description: '', ...(d.eventTiming ? {} : { interval: [60, 120] }), duration: 10, effect: { spawnMultiplier: 1 } }),
    );
    this.openEvents.add(d.events.length - 1);
    this.render();
  }

  renderZone(body, i) {
    const ed = this.editor;
    const d = ed.draft;
    const z = d.zones[i];
    if (!z) return;
    const idEl = h('input', { type: 'text', value: z.id });
    idEl.addEventListener('change', () => {
      if (idEl.value && idEl.value !== z.id) ed.renameZone(i, idEl.value.trim());
    });
    z.content ??= {};
    const c = z.content;

    body.append(
      h('h3', {}, ['구역', h('span', { class: 'actions' }, [
        h('button', { class: 'mini', onclick: () => ed.duplicateSelection() }, '복제'),
        h('button', { class: 'mini danger', onclick: () => ed.deleteSelection() }, '삭제'),
      ])]),
      h('div', { class: 'grid2' }, [
        field('id', idEl),
        this.text('이름', () => z.name, (v) => (z.name = v), `z-n-${i}`),
        this.text('아이콘', () => z.icon, (v) => setOpt(z, 'icon', v || undefined), `z-ic-${i}`, { placeholder: '✂️' }),
        this.num('재공 경고 개수', () => z.wipWarn, (v) => setOpt(z, 'wipWarn', v), `z-ww-${i}`, { optional: true, step: 1, min: 1, placeholder: '기본값' }),
      ]),
      this.rectFields(() => z.rect, `z-r-${i}`),
      this.check('데이터가 모이는 곳 (공정 구역과 점선으로 이어요)', () => z.hub, (v) => setOpt(z, 'hub', v || undefined), `z-hub-${i}`),
      this.select(
        '연결할 시나리오',
        { '': '없음', ...(z.link ? { [z.link]: z.link } : {}), ...Object.fromEntries((this.deps.scenarioList?.() ?? []).filter((x) => x.id !== d.id).map((x) => [x.id, x.name])) },
        () => z.link ?? '',
        (v) => setOpt(z, 'link', v || undefined),
        `z-link-${i}`,
      ),
      h('p', { class: 'hint' }, `공정 투어 순서: ${i + 1}번째 (구역 목록 순서)`),

      h('h3', {}, '공정'),
      this.check('이 구역에서 물건을 처리해요', () => !!z.station, (on) => {
        if (on) z.station = { time: 2, variance: 0.2, stage: d.stages[d.stages.length - 1].id, capacity: 1 };
        else delete z.station;
      }, `z-st-${i}`, () => this.render()),
    );

    if (z.station) {
      const st = z.station;
      const stageOpts = Object.fromEntries(d.stages.map((s) => [s.id, s.label]));
      const line = st.speed != null;
      body.append(
        this.select('처리 방식', { slot: '자리에서 처리 (처리 시간)', line: '라인을 흐르며 처리 (속도)' }, () => (line ? 'line' : 'slot'), (v) => {
          if (v === 'line') {
            st.speed = 22;
            delete st.time;
            delete st.capacity;
            delete st.slots;
            delete st.inspect;
            delete st.defectRate;
            delete st.repair;
          } else {
            st.time = 2;
            delete st.speed;
          }
        }, `z-mode-${i}`),
      );
      // 처리 방식을 바꾸면 입력 칸이 달라진다
      body.lastChild.querySelector('select').addEventListener('change', () => this.render());
      body.append(
        h('div', { class: 'grid2' }, [
          line
            ? this.num('라인 속도(px/초)', () => st.speed, (v) => (st.speed = v), `z-sp-${i}`, { step: 1, min: 1 })
            : this.num('처리 시간(초)', () => st.time, (v) => (st.time = v), `z-t-${i}`, { step: 0.1, min: 0.1 }),
          line ? null : this.pct('편차(±%)', () => st.variance, (v) => setOpt(st, 'variance', v), `z-v-${i}`, { optional: true }),
          line ? null : this.num('동시 처리 수', () => st.capacity, (v) => setOpt(st, 'capacity', v), `z-cap-${i}`, { optional: true, step: 1, min: 1, placeholder: '1', hint: '작업자·장비 수' }),
          this.select('처리 후 상태', stageOpts, () => st.stage, (v) => (st.stage = v), `z-s-${i}`),
          this.select('처리 중 상태', { '': '처리 전 그대로', ...stageOpts }, () => st.workingStage ?? '', (v) => setOpt(st, 'workingStage', v || undefined), `z-ws-${i}`),
        ]),
      );
      if (line) {
        body.append(h('p', { class: 'hint' }, '물건이 구역 안을 이 속도로 흐르며 처리되고, 진행할수록 진하게 보여요.'));
      } else {
        body.append(this.check('검사 공정 (불량을 찾아내요)', () => st.inspect, (v) => setOpt(st, 'inspect', v || undefined), `z-in-${i}`, () => this.render()));
      }
      if (!line && st.inspect) {
        body.append(h('div', { class: 'grid2' }, [
          this.pct('기본 불량률(%)', () => st.defectRate, (v) => setOpt(st, 'defectRate', v), `z-dr-${i}`, { optional: true }),
          this.num('수선 시간(초)', () => st.repair, (v) => setOpt(st, 'repair', v), `z-rp-${i}`, { optional: true, step: 0.5, min: 0.5, placeholder: '없으면 버림', hint: '수선 뒤 다시 검사해요' }),
        ]));
      }
      const explicit = !!st.slots?.length;
      if (!line) body.append(
        h('div', { class: 'row' }, [
          h('span', { class: 'hint' }, explicit ? `처리 자리 ${st.slots.length}개를 직접 지정했어요. 맵에서 파란 점을 끌어 옮겨요.` : '처리 자리는 구역 안에 자동 배치돼요.'),
          explicit
            ? h('button', { class: 'mini', onclick: () => { ed.mutate(null, () => delete st.slots); this.render(); } }, '자동으로')
            : h('button', { class: 'mini', onclick: () => { ed.materializeSlots(i); this.render(); } }, '직접 지정'),
        ]),
      );
    }

    body.append(
      h('h3', {}, '설명 카드'),
      this.area('하는 일', () => c.does, (v) => (c.does = v), `z-does-${i}`, { rows: 2 }),
      this.text('현장 사람들', () => c.people, (v) => (c.people = v), `z-ppl-${i}`, { placeholder: '쉼표로 구분' }),
      this.area('시스템에 남는 데이터', () => (c.data ?? []).join('\n'), (v) => (c.data = v.split('\n').map((s) => s.trim()).filter(Boolean)), `z-data-${i}`, { rows: 3, hint: '한 줄에 하나씩' }),
      this.area('개발·디자인 포인트', () => c.point, (v) => (c.point = v), `z-pt-${i}`, { rows: 3 }),
    );
  }

  renderProp(body, i) {
    const ed = this.editor;
    const p = ed.draft.layout.props[i];
    if (!p) return;
    body.append(
      h('h3', {}, ['소품', h('span', { class: 'actions' }, [
        h('button', { class: 'mini', onclick: () => ed.duplicateSelection() }, '복제'),
        h('button', { class: 'mini danger', onclick: () => ed.deleteSelection() }, '삭제'),
      ])]),
      this.select('종류', PROP_TYPES, () => p.type, (v) => (p.type = v), `p-t-${i}`),
      this.text('이름표', () => p.label, (v) => setOpt(p, 'label', v || undefined), `p-l-${i}`, { placeholder: '없으면 비워 두세요' }),
      this.rectFields(() => p.rect, `p-r-${i}`),
    );
  }

  renderPoint(body, i) {
    const ed = this.editor;
    const path = ed.draft.flow.path;
    const p = path[i];
    if (!p) return;
    const name = i === 0 ? '투입 지점' : i === path.length - 1 ? '끝 지점' : `경로 점 ${i}`;
    body.append(
      h('h3', {}, [name, h('span', { class: 'actions' }, [
        h('button', { class: 'mini danger', disabled: path.length <= 2, onclick: () => ed.deleteSelection() }, '삭제'),
      ])]),
      h('div', { class: 'grid2' }, [
        this.num('x', () => p[0], (v) => (p[0] = v), `pt-x-${i}`, { step: 1 }),
        this.num('y', () => p[1], (v) => (p[1] = v), `pt-y-${i}`, { step: 1 }),
      ]),
      h('p', { class: 'hint' }, '경로 도구에서 빈 곳을 누르면 끝에 점이 붙고, 선 위를 누르면 사이에 점이 끼워져요. 점을 오른쪽 클릭하거나 Alt+클릭하면 지워져요.'),
    );
  }

  renderJson(body) {
    const ed = this.editor;
    const ta = h('textarea', { class: 'json' });
    ta.spellcheck = false;
    ta.value = this.jsonOverride ?? (ed.draft ? formatScenario(ed.draft) : this.deps.brokenText() ?? '');
    this.jsonOverride = null;
    const issuesEl = h('div', { class: 'issue-list' });
    const apply = h('button', { class: 'primary' }, '적용');
    const check = () => {
      const res = this.deps.validate(ta.value);
      this.deps.renderIssues(issuesEl, [...res.errors, ...res.warnings], (iss) => selectLine(ta, iss.line));
      return res;
    };
    apply.addEventListener('click', () => {
      const res = check();
      if (res.ok) this.deps.applyJson(res.data);
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') apply.click();
      if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      }
    });
    body.append(
      h('p', { class: 'hint' }, '시나리오 전체를 JSON 으로 고쳐요. 적용(⌘/Ctrl+Enter)하면 검사한 뒤 맵에 반영돼요.'),
      ta,
      h('div', { class: 'row' }, [apply]),
      issuesEl,
    );
    this.jsonTextarea = ta;
  }

  /** 오류 목록에서 고른 줄로 JSON 탭을 연다 */
  openJsonAt(line, text) {
    this.tab = 'json';
    if (text != null) this.jsonOverride = text;
    this.render();
    if (line) selectLine(this.jsonTextarea, line);
  }
}

const INVALID = Symbol('invalid');

function setStart(d, i, v) {
  if (v === undefined) return void delete d.layout.start;
  const W = d.layout.width;
  const H = d.layout.height;
  d.layout.start ??= [W / 2, H / 2];
  d.layout.start[i] = v;
}

function setView(d, key, v) {
  d.view ??= {};
  setOpt(d.view, key, v);
  if (!Object.keys(d.view).length) delete d.view;
}

function setOpt(obj, key, v) {
  if (v === undefined || v === '' || v === false) delete obj[key];
  else obj[key] = v;
}

function round(v, n) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

function expandHex(c) {
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`;
  return c;
}

function field(label, el, hint) {
  return h('label', { class: 'field' }, [h('span', { class: 'label' }, label), el, hint ? h('span', { class: 'hint' }, hint) : null]);
}

export function selectLine(ta, line) {
  if (!ta) return;
  const lines = ta.value.split('\n');
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
  const end = start + (lines[line - 1]?.length ?? 0);
  ta.focus();
  ta.setSelectionRange(start, end);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
  ta.scrollTop = Math.max(0, (line - 5) * lh);
}

/** 작은 DOM 도우미 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
