/* ============================================================================
 *  e2e-live.js — 실서버 왕복 E2E (프론트 통신 계층 + 어댑터 검증)
 * ----------------------------------------------------------------------------
 *  백엔드를 켜 두고 실행합니다. 격자 크기(1km/500m)와 무관하게 동작하도록
 *  기대값을 서버 meta 에서 파생합니다 — 리터럴 셀 수·금액을 박지 않습니다.
 *
 *      node tools/e2e-live.js                     # http://127.0.0.1:8000
 *      node tools/e2e-live.js http://127.0.0.1:8768
 *
 *  종료 코드 = 실패 수. Node 18+ (fetch 내장) 필요.
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const F = path.join(__dirname, '..', 'assets', 'js') + path.sep;

global.window = global;
global.location = { protocol: 'http:', hostname: '127.0.0.1' };
eval(fs.readFileSync(F + 'config.js', 'utf8'));
/* 인자로 받은 서버만 봅니다 — 후보 탐색을 건너뛰고 고정합니다.
   (useServer 가 없는 구버전 config.js 와도 돌아가게 대입도 남겨 둡니다) */
if (typeof window.HW.CONFIG.useServer === 'function') window.HW.CONFIG.useServer(BASE);
else window.HW.CONFIG.BASE_URL = BASE;
eval(fs.readFileSync(F + 'api.js', 'utf8'));
const api = window.HW.api;

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); fails++; }
  else { console.log('PASS: ' + msg); }
}

(async () => {
  const meta = await api.meta();
  assert(meta.periods && meta.periods.length === 4, 'meta.periods 4개');
  assert(meta.grid && meta.grid.sizeMeters > 0, 'meta.grid.sizeMeters = ' + (meta.grid && meta.grid.sizeMeters));
  const nCells = meta.grid.cellCount;
  assert(nCells > 100, 'meta.grid.cellCount = ' + nCells);

  const grid = await api.grid('am');
  assert(grid.cells.length === nCells, 'grid.cells(' + grid.cells.length + ') == meta.cellCount(' + nCells + ')');
  assert(grid.kpi.totalCells === nCells, 'kpi.totalCells == cellCount');

  // 0-2) /stops·/routes 계약 — 지도가 하드 의존하는 필드만 확인한다.
  //      예전에는 이 둘을 아예 안 쳐서, 목록 항목의 boardingsPerDay 가 빠지면
  //      전 정류장 툴팁이 "일 승차 0명" 이 되는 회귀를 못 잡았다.
  const stops = (await api.stops()).stops;
  assert(Array.isArray(stops) && stops.length > 0, '/stops 목록 = ' + ((stops || []).length) + '개');
  const s0 = stops[0];
  assert(s0 && s0.id && typeof s0.lon === 'number' && typeof s0.lat === 'number',
    '/stops 항목에 id·lon·lat');
  const withB = stops.filter(s => typeof s.boardingsPerDay === 'number').length;
  assert(withB === stops.length,
    '/stops 전 항목에 boardingsPerDay (' + withB + '/' + stops.length + ')');
  const routes = (await api.routes()).routes;
  assert(Array.isArray(routes) && routes.length > 0, '/routes 목록 = ' + ((routes || []).length) + '개');
  assert(routes[0] && Array.isArray(routes[0].stopIds) && routes[0].stopIds.length > 0,
    '/routes 항목에 stopIds (경유 순서 카드가 이걸로 그린다)');

  // 1) 빈 배치 시뮬레이션: KPI 가 대시보드(/grid)와 일치해야 함
  const budget = (meta.cost && meta.cost.defaultBudget) || 3000000000;
  const empty = await api.runSimulation({ name: 'e2e', period: 'am', budgetKrw: budget, placements: [] });
  const b0 = empty.periods.find(p => p.period === 'am');
  assert(b0.delta.potentialTripsPerDay === 0, 'empty delta.potentialTripsPerDay === 0 (' + b0.delta.potentialTripsPerDay + ')');
  assert(b0.delta.elderlyTripsPerDay === 0, 'empty delta.elderlyTripsPerDay === 0 (' + b0.delta.elderlyTripsPerDay + ')');
  assert(b0.kpi.potentialTripsPerDay === grid.kpi.potentialTripsPerDay,
    'sim kpi(' + b0.kpi.potentialTripsPerDay + ') == grid kpi(' + grid.kpi.potentialTripsPerDay + ')');
  assert(b0.kpi.elderlyTripsPerDay === grid.kpi.elderlyTripsPerDay, 'sim elderly == grid elderly');
  assert(b0.baseline.needCells === grid.kpi.needCells, 'baseline needCells == grid needCells');

  // 2) 배치 2건(같은 수단): breakdown 집계 + 비용 = 단가×2 + delta 부호
  const stopUnit = ((meta.effects || []).find(e => e.type === 'stop') || {}).unitKrw;
  assert(stopUnit > 0, 'meta.effects stop unitKrw = ' + stopUnit);
  const need = grid.cells.filter(c => c.quadrant === 'need').slice(0, 2);
  assert(need.length === 2, 'need 격자 2개 확보');
  const sim = await api.runSimulation({
    name: 'e2e', period: 'am', budgetKrw: budget,
    placements: need.map(c => ({ type: 'stop', cellId: c.id, count: 1 }))
  });
  const b2 = sim.periods.find(p => p.period === 'am');
  assert(typeof b2.delta.potentialTripsPerDay === 'number', 'delta.potentialTripsPerDay 존재');
  assert(b2.delta.potentialTripsPerDay <= 0, '배치 후 사각지대 잠재수요 증가 없음 (' + b2.delta.potentialTripsPerDay + ')');
  assert(sim.cost.breakdown.length === 1, 'breakdown 수단별 집계 (' + sim.cost.breakdown.length + '행)');
  assert(sim.cost.breakdown[0].count === 2, 'breakdown count=2');
  assert(sim.cost.totalKrw === stopUnit * 2, 'totalKrw == 단가×2 (' + sim.cost.totalKrw + ')');
  assert(sim.cellsByPeriod && sim.cellsByPeriod.am.length === nCells, 'cellsByPeriod.am 전 셀 포함');

  // 3) 추천: summary 등 화면 필수 필드 (어댑터 통과 후)
  const rec = await api.recommend({ period: 'am', budgetKrw: Math.round(budget / 6), maxPlacements: 3, strategy: 'efficiency', includeAlternatives: true });
  ['count', 'totalKrw', 'budgetUsedPct', 'expectedResolvedCells', 'expectedResolvedTrips',
   'expectedResolvedElderlyTrips', 'krwPerTrip', 'stoppedBecause'].forEach(k => {
    assert(rec.summary && rec.summary[k] !== undefined, 'summary.' + k + ' = ' + (rec.summary ? rec.summary[k] : 'X'));
  });
  assert(typeof rec.methodLabel === 'string' && rec.methodLabel.length > 0, 'methodLabel');
  assert(rec.methodNote !== undefined && rec.strategyNote !== undefined, 'methodNote/strategyNote');
  assert('region' in rec, 'region 키');
  assert(rec.alternatives && rec.alternatives.length === 4, 'alternatives 4개 (' + (rec.alternatives || []).length + ')');
  assert(rec.alternatives.some(a => a.selected), 'selected 플래그 존재');
  assert(rec.placements.length > 0 && rec.placements[0].cellName, 'placements[0].cellName');

  // 4) 지역 범위 추천 — 존재하지 않는 지역은 빈 추천 + 사유
  const rec2 = await api.recommend({ period: 'am', budgetKrw: Math.round(budget / 6), maxPlacements: 2, strategy: 'efficiency', region: '없는동네' });
  assert(rec2.summary.stoppedBecause === 'no_candidate', '없는 지역 → no_candidate (' + rec2.summary.stoppedBecause + ')');

  console.log(fails ? ('E2E FAILED: ' + fails) : 'E2E DONE — 전부 통과');
  process.exit(fails);
})().catch(e => { console.error('ERROR: ' + (e && e.message)); process.exit(1); });
