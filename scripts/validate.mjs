#!/usr/bin/env node
// 시나리오 파일 검증 CLI.  npm run validate [파일...]
// 인자가 없으면 scenarios/*.json 전체를 검사한다. 오류가 있으면 종료 코드 1.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from '../src/schema/validate-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(readFileSync(join(root, 'src/schema/scenario.schema.json'), 'utf8'));
const validate = createValidator(schema);

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(join(root, 'scenarios')).filter((f) => f.endsWith('.json')).map((f) => join(root, 'scenarios', f));

let failed = 0;
for (const f of files) {
  const rel = relative(process.cwd(), f);
  const res = validate(readFileSync(f, 'utf8'), { file: rel, expectedId: basename(f, '.json') });
  for (const i of [...res.errors, ...res.warnings]) {
    const tag = i.severity === 'error' ? '오류' : '경고';
    console.log(`${i.file}:${i.line}:${i.column}  ${tag}  ${i.path ? `${i.path} — ` : ''}${i.message}`);
  }
  if (!res.ok) failed++;
  else console.log(`${rel}  통과${res.warnings.length ? ` (경고 ${res.warnings.length})` : ''}`);
}
process.exit(failed ? 1 : 0);
