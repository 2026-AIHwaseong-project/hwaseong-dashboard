/* ============================================================================
 *  check-css.js — CSS 가 조용히 죽는 실수 3종을 잡습니다.
 * ----------------------------------------------------------------------------
 *      node tools/check-css.js
 *
 *  왜 필요한가. CSS 는 파서가 이해 못 하는 것을 조용히 버립니다. 주석을 한 번
 *  더 열지 않고 문장을 이어 쓰면, 그 텍스트가 바로 다음 규칙의 선택자에 붙어
 *  버려 **그 규칙 하나가 통째로 사라집니다.** 실제로 이 일이 있었습니다 —
 *  `.mapcard{grid-column:span 8}` 이 사라져 지도 카드가 8칸에서 1칸(98px)으로
 *  쪼그라들었는데, 브라우저 콘솔에는 아무 것도 안 찍혔습니다.
 *
 *  종료 코드 = 문제 수.
 * ========================================================================= */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'assets', 'css', 'app.css');
const src = fs.readFileSync(FILE, 'utf8');
const lineOf = (i) => src.slice(0, i).split('\n').length;

let bad = 0;
function fail(line, msg) { console.error(`FAIL app.css:${line}  ${msg}`); bad++; }

/* ── 1) 주석 짝 ─────────────────────────────────────────────────────────── */
let i = 0, opens = [];
while (i < src.length) {
  const o = src.indexOf('/*', i);
  if (o < 0) break;
  const c = src.indexOf('*/', o + 2);
  if (c < 0) { fail(lineOf(o), '/* 가 닫히지 않았습니다'); break; }
  opens.push([o, c]);
  i = c + 2;
}
/* 주석 밖에 남은 닫기표시 — 주석을 두 번 닫은 것. 앞 규칙이 통째로 죽습니다. */
const inComment = (idx) => opens.some(([o, c]) => idx > o && idx < c);
for (let k = src.indexOf('*/'); k >= 0; k = src.indexOf('*/', k + 2)) {
  if (!opens.some(([, c]) => c === k)) fail(lineOf(k), '짝 없는 */ — 이 뒤의 규칙 하나가 무시됩니다');
}

/* ── 2) 중괄호 짝 ───────────────────────────────────────────────────────── */
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
const nOpen = (stripped.match(/\{/g) || []).length;
const nClose = (stripped.match(/\}/g) || []).length;
if (nOpen !== nClose) fail(0, `{ ${nOpen}개 vs } ${nClose}개 — 짝이 안 맞습니다`);

/* ── 3) 반드시 살아 있어야 하는 레이아웃 규칙 ──────────────────────────────
 * 선택자와 선언이 같은 블록에 실제로 들어 있는지 봅니다. 주석 사고가 나면
 * 선택자가 앞 텍스트에 흡수돼 이 검사에서 걸립니다. */
const MUST = [
  ['.mapcard', 'grid-column:span 8'],
  ['.routecard', 'grid-column:span 8'],
  ['.sidecard', 'grid-column:span 4'],
  ['.sc-card', 'grid-column:span 5'],
  ['.st-card', 'grid-column:span 7'],
  ['.dashgrid .mapcard', 'grid-row:1'],
  ['.dashgrid .sidecard', 'grid-row:1 / span 2'],
  ['.grid', 'grid-template-columns:repeat(12'],
];
/* 규칙 = 선택자 + 선언 블록. 중첩 블록이 없는 평범한 CSS 라 이 정도로 충분합니다. */
const rules = [];
/* 앞 규칙의 } 를 먹으면 연속한 규칙이 한 칸씩 건너뛰어집니다 — 구분자를 소비하지 않습니다 */
const re = /([^{}]*)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(stripped)) !== null) {
  rules.push({ sel: m[1].trim(), body: m[2].replace(/\s+/g, '') });
}
MUST.forEach(([sel, decl]) => {
  const want = decl.replace(/\s+/g, '');
  const hit = rules.some(r =>
    r.sel.split(',').map(s => s.trim()).includes(sel) && r.body.includes(want));
  if (!hit) fail(0, `'${sel} { ${decl} }' 가 살아 있지 않습니다 — 주석 사고로 삼켜졌을 수 있습니다`);
  else console.log(`PASS: ${sel} { ${decl} }`);
});

if (!bad) console.log('CSS CHECK DONE — 문제 없음');
process.exit(bad);
