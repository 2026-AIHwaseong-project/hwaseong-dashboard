/* AI 보고서 기록 계층 검증 — node tools/test-reports.js
 *
 * 이 저장소에는 CI 가 없습니다. 그래서 브라우저 없이 돌릴 수 있는 것만이라도
 * 남깁니다. 검증 대상은 report.js 의 기록 저장 계층 — 격자(약 400KB)를 빼고
 * 저장하는지, 브라우저 저장 공간이 찼을 때 조용히 넘어가지 않는지, 손상된
 * 저장본이 목록을 통째로 죽이지 않는지처럼 **조용히 틀리기 쉬운 자리**입니다.
 *
 * DOM 은 최소 스텁이라 화면 동작은 여기서 확인되지 않습니다 — 그쪽은 손으로
 * 확인해야 합니다(모달 열기 → 목록 → 생성 → 목록 → 기록 열기 → 삭제).
 */
const g = require('./_report-harness');
const R = g.HW.report._records;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const bigCells = Array.from({length: 786}, (_, i) => ({ id:'g'+i, name:'격자'+i, priorityScore: i/786, mi: 0.1 }));
const draft = { title:'화성시 대중교통 수급 불일치 분석 및 노선 조정 검토(안)',
  subtitle:'평일 · 출근 시간대(07–09) 기준', isAiGenerated:true,
  sections:[{key:'summary',body:'x'}],
  meta:{ cells: bigCells, kpi:{needCells:30}, priorities:[{name:'동탄7동',priorityScore:0.9}], formula:'f' } };

// ① 격자가 저장에서 빠지는가
const slim = R.slim(draft);
ok('slim 이 meta.cells 를 뺀다', !slim.meta.cells);
ok('slim 이 kpi·priorities·formula 는 남긴다', !!slim.meta.kpi && !!slim.meta.priorities && !!slim.meta.formula);
ok('원본은 안 건드린다', draft.meta.cells.length === 786);

// ② source 판별
ok('대시보드 판별', R.source({kpi:{}}) === 'dashboard');
ok('시뮬레이션 판별(값이 null 이어도)', R.source({recommendation:null}) === 'simulation');
ok('관리자 판별', R.source({meta:{},admin:{}}) === 'admin');

// ③ 적립 — 라벨이 subtitle 인가, 격자는 세션에만 가는가
const id1 = R.push(draft, { period:'am', daytype:'wd', cells:bigCells, kpi:{} }, false);
const list1 = R.load();
ok('기록 1건 적립', list1.length === 1);
ok('카드 라벨이 subtitle', list1[0].label === '평일 · 출근 시간대(07–09) 기준', list1[0].label);
ok('저장본에 격자 없음', !list1[0].draft.meta.cells);
ok('세션 맵에는 격자 있음', R.sessionCells[id1].length === 786);
const bytes = JSON.stringify(list1).length;
ok('1건이 10KB 미만 (' + bytes + '자)', bytes < 10000, bytes);

// ④ 덮어쓰기 — 격자 붙은 draft 를 넣어도 다시 슬림화되는가
const fat = JSON.parse(JSON.stringify(slim)); fat.meta.cells = bigCells; fat.sections=[{key:'summary',body:'고침'}];
R.update(id1, fat);
const after = R.load()[0];
ok('update 도 격자를 뺀다', !after.draft.meta.cells);
ok('update 가 본문을 반영', after.draft.sections[0].body === '고침');
ok('여전히 1건', R.load().length === 1);

// ⑤ 상한 20건 + 최신이 앞
for (let i = 0; i < 25; i++) R.push({ ...draft, subtitle:'건'+i }, { period:'am', cells:[] }, false);
ok('상한 20건', R.load().length === 20, R.load().length);
ok('최신이 맨 앞', R.load()[0].label === '건24', R.load()[0].label);

// ⑥ 삭제
const target = R.load()[3].id;
R.remove(target);
ok('삭제됨', !R.load().some(r => r.id === target));
ok('19건', R.load().length === 19);

// ⑦ 손상된 저장본이 목록을 죽이지 않는가
g.localStorage.setItem('hw.reports', '{"not":"array"}');
ok('배열 아니면 빈 배열', Array.isArray(R.load()) && R.load().length === 0);
g.localStorage.setItem('hw.reports', 'not json at all');
ok('깨진 JSON 이어도 빈 배열', R.load().length === 0);

// ⑧ 쿼터 초과 시 카드를 만들지 않는가
g.localStorage.setItem('hw.reports', '[]');
g.__toasts.length = 0;
const huge = { ...draft, sections:[{key:'summary', body:'x'.repeat(4_200_000)}] };
const bad = R.push(huge, { period:'am', cells:[] }, false);
ok('쿼터 초과 시 null 반환', bad === null, bad);
ok('사용자에게 알림', g.__toasts.some(t => /저장 공간/.test(t[0])), g.__toasts);


/* ── 목록 렌더링 ─────────────────────────────────────────────────
   브라우저가 없으므로 그려진 HTML 문자열을 직접 들여다봅니다. */
const RP = g.HW.report;
g.localStorage.setItem('hw.reports', '[]');
RP.setContextProvider(() => ({ period: 'am', daytype: 'wd', kpi: {} }));

RP.open();
let html = g.__els['[data-list]'].innerHTML;
ok('빈 목록에 안내가 나온다', /아직 만든 보고서가 없습니다/.test(html));
ok('빈 목록에도 생성 버튼이 있다', /data-gen-new/.test(html));
/* 열기만으로는 초안 본문을 손대지도, 생성 요청을 내지도 않습니다 —
   예전에는 open() 이 곧바로 generate() 를 불렀습니다. */
ok('열기만으로는 생성하지 않는다', !/AI가 분석 결과를/.test((g.__els['[data-body]'] || {}).innerHTML || ''));

R.push({ title:'T', subtitle:'평일 · 출근 시간대(07–09) 기준', isAiGenerated:true,
         sections:[], meta:{} }, { period:'am', cells:[] }, true);
R.push({ title:'T', subtitle:'주말 · 심야 시간대(22–24) 기준', isAiGenerated:false,
         sections:[], meta:{} }, { period:'night', recommendation:null, cells:[] }, false);
RP.open();
html = g.__els['[data-list]'].innerHTML;
ok('카드 2장', (html.match(/class="scen"/g) || []).length === 2);
ok('최신이 위(주말 심야)', html.indexOf('주말 · 심야') < html.indexOf('평일 · 출근'));
ok('출처 칩', /시뮬레이션/.test(html) && /대시보드/.test(html));
ok('서식 초안 표시', /서식 초안/.test(html));
ok('시나리오 포함 표시', /시나리오 포함/.test(html));
ok('격자 없으면 밝힌다', /원자료 없음/.test(html));
ok('삭제 버튼 분리', /class="sdel"/.test(html));

/* 라벨에 태그가 들어와도 그대로 심어지지 않는가 */
R.push({ title:'T', subtitle:'<img src=x onerror=alert(1)>', sections:[], meta:{} },
       { period:'am', cells:[] }, false);
RP.open();
ok('라벨을 이스케이프한다', !/<img /.test(g.__els['[data-list]'].innerHTML));

console.log('\n최종 ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
