// 둘러보기: 플레이어 이동(탭·키보드), 구역 진입 감지, 공정 투어.
// DOM 을 모르고 시나리오와 입력만 받는다. 시간은 실제 초(시뮬레이션 속도 배수와 무관).

import { rectContains } from '../sim/geometry.js';

const KEY_DIRS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

export class Explorer {
  /**
   * @param {object} scenario
   * @param {{onZoneEnter?:(zone:object)=>void, onTourStop?:(zone:object, index:number, total:number)=>void, onTourEnd?:(completed:boolean)=>void}} cb
   */
  constructor(scenario, cb = {}) {
    this.cb = cb;
    this.load(scenario);
  }

  load(scenario) {
    this.scenario = scenario;
    const { width: W, height: H } = scenario.layout;
    const [sx, sy] = scenario.layout.start ?? [W / 2, H / 2];
    this.player = { x: sx, y: sy };
    this.target = null;
    this.keys = new Set();
    this.tour = null; // {index, phase:'walk'|'dwell', left}
    this.zoneId = this.zoneAt(sx, sy)?.id ?? null;
  }

  get speed() {
    return this.scenario.view?.playerSpeed ?? 170;
  }

  get dwell() {
    return this.scenario.view?.tourDwell ?? 14;
  }

  zoneAt(x, y) {
    const zones = this.scenario.zones;
    for (let i = zones.length - 1; i >= 0; i--) if (rectContains(zones[i].rect, x, y)) return zones[i];
    return null;
  }

  clampToMap(x, y) {
    const { width: W, height: H } = this.scenario.layout;
    const m = 10;
    return [Math.max(m, Math.min(W - m, x)), Math.max(m, Math.min(H - m, y))];
  }

  /** 탭한 곳으로 걸어간다. 투어 중이면 투어를 멈춘다 */
  walkTo(x, y) {
    this.stopTour();
    const [cx, cy] = this.clampToMap(x, y);
    this.target = { x: cx, y: cy };
  }

  /** @returns {boolean} 이동 키였으면 true */
  keyDown(key) {
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (!KEY_DIRS[k]) return false;
    this.keys.add(k);
    this.target = null;
    this.stopTour();
    return true;
  }

  keyUp(key) {
    const k = key.length === 1 ? key.toLowerCase() : key;
    this.keys.delete(k);
  }

  releaseKeys() {
    this.keys.clear();
  }

  // ---------- 공정 투어 ----------

  get tourZones() {
    return this.scenario.zones;
  }

  startTour(from = 0) {
    this.keys.clear();
    this.tour = { index: from, phase: 'walk', left: this.dwell };
    this.goToStop();
  }

  /** 카드의 '다음 구역' 버튼 */
  nextStop() {
    if (!this.tour) return;
    if (this.tour.index >= this.tourZones.length - 1) return this.finishTour(true);
    this.tour.index++;
    this.tour.phase = 'walk';
    this.tour.left = this.dwell;
    this.goToStop();
  }

  goToStop() {
    const zone = this.tourZones[this.tour.index];
    const [x, y, w, h] = zone.rect;
    const [tx, ty] = this.clampToMap(x + w / 2, y + h / 2);
    this.target = { x: tx, y: ty };
  }

  stopTour() {
    if (!this.tour) return;
    this.tour = null;
    this.cb.onTourEnd?.(false);
  }

  finishTour(completed) {
    this.tour = null;
    this.target = null;
    this.cb.onTourEnd?.(completed);
  }

  // ---------- 매 프레임 ----------

  update(dt) {
    const p = this.player;
    let dx = 0;
    let dy = 0;
    for (const k of this.keys) {
      dx += KEY_DIRS[k][0];
      dy += KEY_DIRS[k][1];
    }
    const step = this.speed * dt;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      [p.x, p.y] = this.clampToMap(p.x + (dx / len) * step, p.y + (dy / len) * step);
    } else if (this.target) {
      const tx = this.target.x - p.x;
      const ty = this.target.y - p.y;
      const dist = Math.hypot(tx, ty);
      if (dist <= step) {
        p.x = this.target.x;
        p.y = this.target.y;
        this.target = null;
        if (this.tour?.phase === 'walk') {
          this.tour.phase = 'dwell';
          this.cb.onTourStop?.(this.tourZones[this.tour.index], this.tour.index, this.tourZones.length);
        }
      } else {
        p.x += (tx / dist) * step;
        p.y += (ty / dist) * step;
      }
    }

    if (this.tour?.phase === 'dwell') {
      this.tour.left -= dt;
      if (this.tour.left <= 0) this.nextStop();
    }

    const zone = this.zoneAt(p.x, p.y);
    const id = zone?.id ?? null;
    if (id !== this.zoneId) {
      this.zoneId = id;
      if (zone) this.cb.onZoneEnter?.(zone);
    }
  }
}
