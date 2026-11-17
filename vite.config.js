import { defineConfig } from 'vite';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCENARIO_DIR = resolve(__dirname, 'scenarios');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 시나리오 저장소 API (Git 저장소의 scenarios/*.json 을 그대로 읽고 쓴다)
 *   GET  /api/scenarios          목록 [{id, name}]
 *   GET  /api/scenarios/:id      파일 원문
 *   PUT  /api/scenarios/:id      파일 저장 (본문 = 파일 원문)
 * 그리고 파일이 바뀌면 브라우저에 'scenario:changed' 를 보내 화면을 바로 갱신한다.
 */
function scenarioStore() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/scenarios')) return next();
    const id = decodeURIComponent(url.pathname.slice('/api/scenarios'.length).replace(/^\//, ''));

    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-store');
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (!id) {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      const list = readdirSync(SCENARIO_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const sid = f.slice(0, -5);
          let name = sid;
          try {
            name = JSON.parse(readFileSync(join(SCENARIO_DIR, f), 'utf8')).name || sid;
          } catch {
            // 문법 오류가 있는 파일도 목록에는 보여주고, 열 때 오류를 안내한다
          }
          return { id: sid, name };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return send(200, list);
    }

    if (!ID_RE.test(id)) return send(400, { error: 'invalid id' });
    const file = join(SCENARIO_DIR, `${id}.json`);

    if (req.method === 'GET') {
      if (!existsSync(file)) return send(404, { error: 'not found' });
      return send(200, readFileSync(file, 'utf8'), 'text/plain; charset=utf-8');
    }
    if (req.method === 'PUT') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          JSON.parse(body);
        } catch {
          return send(400, { error: 'invalid json' });
        }
        writeFileSync(file, body);
        send(200, { ok: true });
      });
      return;
    }
    return send(405, { error: 'method not allowed' });
  };

  return {
    name: 'scenario-store',
    configureServer(server) {
      server.middlewares.use(middleware);
      server.watcher.add(SCENARIO_DIR);
      const notify = (file) => {
        if (!file.startsWith(SCENARIO_DIR) || !file.endsWith('.json')) return;
        const id = file.slice(SCENARIO_DIR.length + 1, -5);
        server.ws.send({ type: 'custom', event: 'scenario:changed', data: { id } });
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);
      server.watcher.on('unlink', notify);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    // 시나리오 JSON 을 바꿨다고 페이지 전체를 새로고침하지 않는다 (앱이 직접 다시 읽는다)
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(SCENARIO_DIR)) return [];
    },
  };
}

export default defineConfig({
  plugins: [scenarioStore()],
  base: './',
  test: {
    environment: 'node',
  },
});
