/* ============================================================================
 *  simulation.js — 정책 시뮬레이션 화면
 * ----------------------------------------------------------------------------
 *  담당 공무원이 "어디에 · 무엇을 · 얼마에 넣으면 · 무엇이 나아지는가"를
 *  한 화면에서 판단할 수 있도록 구성했습니다.
 *
 *    ① 지도에서 수단을 골라 클릭 → 배치안 작성
 *    ② 예산 대비 소요액 확인
 *    ③ 기준선 대비 KPI 변화 · 시간대별 전후 비교 · 비용 대비 효과
 *    ④ 정책 판단 요약(자동 문장) → AI 보고서로 내보내기
 *
 *  모든 계산은 서버(POST /simulations)가 합니다. 이 파일은 요청과 표시만 합니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW;
  var C = HW.core, api = HW.api;
  var $ = C.$, $$ = C.$$, esc = C.esc, fmt = C.fmt, won = C.won;

  var LS_SCENARIOS = 'hw.scenarios';
  var LS_LAST = 'hw.lastSimulation';

  var S = {
    meta: null,
    period: 'am',
    tool: null,
    placements: [],       // [{type, cellId, count}]
    budget: 0,
    name: '시나리오 1',
    result: null,         // 서버 시뮬레이션 결과
    map: null,
    effects: {},          // type → {label, icon, radiusKm, unitKrw}
    busy: false,
    pending: null,
    selectedCellId: null
  };

  /* =====================================================================
   * 1. 부팅
   * =================================================================== */
  function boot() {
    C.mountTopnav('simulation');
    C.initTheme();
    HW.report.mount();
    HW.report.setContextProvider(function () {
      return {
        period: S.period,
        meta: S.meta,
        kpi: currentPeriodBlock() ? currentPeriodBlock().kpi : null,
        priorities: null,
        simulation: S.result
      };
    });

    var q = new URLSearchParams(location.search);
    if (q.get('period')) S.period = q.get('period');

    api.meta().then(function (meta) {
      S.meta = meta;
      S.budget = (meta.cost && meta.cost.defaultBudget) || 0;
      (meta.effects || []).forEach(function (e) { S.effects[e.type] = e; });
      renderPeriodTabs(meta.periods);
      renderToolbar(meta.effects || []);
      renderBudgetInput();
      renderFooter(meta);

      S.map = HW.createMap({
        svg: $('#map'), legend: $('#legend'), meta: meta,
        onCellClick: onCellClick,
        onCellHover: function (cell, ev) { C.showTip(cellTip(cell), ev); },
        onStopClick: function () { /* 시뮬레이션 화면에서는 정류장 클릭 동작 없음 */ }
      });
      return Promise.all([api.stops(), api.routes(), api.grid(S.period)]);
    }).then(function (r) {
      S.map.setData({ stops: r[0].stops, routes: r[1].routes, cells: r[2].cells });
      wireControls();
      renderScenarioList();

      var cellId = q.get('cell');
      if (cellId) {
        S.selectedCellId = cellId;
        S.map.select(cellId);
        C.toast('대시보드에서 <b>' + esc(cellId) + '</b> 격자를 가져왔습니다. 수단을 골라 지도를 클릭하세요.');
      }
      return runSim();
    }).catch(fail);
  }

  function fail(err) {
    console.error(err);
    var box = $('#bootError');
    if (box) {
      box.innerHTML = '<div class="errbox"><b>데이터를 불러오지 못했습니다.</b><br>' +
        esc(api.humanize(err)) + '</div>';
      box.style.display = '';
    }
    C.toast('오류 — ' + esc(api.humanize(err)), 'err', 7000);
  }

  /* =====================================================================
   * 2. 상단 컨트롤
   * =================================================================== */
  function renderPeriodTabs(periods) {
    var host = $('#periods');
    host.innerHTML = periods.map(function (p) {
      return '<button class="pbtn' + (p.id === S.period ? ' on' : '') + '" data-period="' + esc(p.id) +
        '" role="tab" aria-selected="' + (p.id === S.period) + '"><b>' + esc(p.name) + '</b><span>' + esc(p.label) + '</span></button>';
    }).join('');
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-period]');
      if (!b) return;
      S.period = b.getAttribute('data-period');
      $$('#periods [data-period]').forEach(function (x) {
        var on = x.getAttribute('data-period') === S.period;
        x.classList.toggle('on', on);
        x.setAttribute('aria-selected', String(on));
      });
      paintAll();
    });
  }

  function renderToolbar(effects) {
    $('#tools').innerHTML = effects.map(function (e) {
      return '<button class="simtool" data-tool="' + esc(e.type) + '" type="button" aria-pressed="false">' +
        '<i>' + esc(e.icon) + '</i>' + esc(e.label) + '</button>';
    }).join('');
  }

  function renderBudgetInput() {
    var inp = $('#budgetInput');
    inp.value = Math.round(S.budget / 100000000);
    inp.addEventListener('change', function () {
      var v = Math.max(0, Number(inp.value) || 0);
      S.budget = v * 100000000;
      paintBudget();
    });
    $('#scenName').value = S.name;
    $('#scenName').addEventListener('input', function () { S.name = this.value || '이름 없는 시나리오'; });
  }

  /* =====================================================================
   * 3. 배치
   * =================================================================== */
  function onCellClick(cell) {
    S.selectedCellId = cell.id;
    S.map.select(cell.id);
    if (!S.tool) {
      C.toast('먼저 상단에서 배치할 수단을 선택하세요.');
      return;
    }
    /* 배차 증편은 기존 정류장이 가까운 격자에만 */
    if (S.tool === 'freq' && cell.coverage < 0.5) {
      C.toast('배차 증편은 기존 정류장이 가까운 격자에만 적용할 수 있습니다. 이 격자는 정류장 도보권 밖입니다.', 'err', 5000);
      return;
    }
    var same = S.placements.filter(function (p) { return p.type === S.tool && p.cellId === cell.id; })[0];
    if (same) same.count += 1;
    else S.placements.push({ type: S.tool, cellId: cell.id, cellName: cell.name, count: 1 });
    runSim();
  }

  function removePlacement(i) {
    S.placements.splice(i, 1);
    runSim();
  }

  function resetAll() {
    S.placements = [];
    runSim();
  }

  /* =====================================================================
   * 4. 시뮬레이션 실행
   * =================================================================== */
  function runSim() {
    if (S.busy) { S.pending = true; return Promise.resolve(); }
    S.busy = true;
    setRunning(true);
    return api.runSimulation({
      name: S.name,
      period: S.period,
      budgetKrw: S.budget,
      placements: S.placements.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      })
    }).then(function (res) {
      S.result = res;
      try { localStorage.setItem(LS_LAST, JSON.stringify(res)); } catch (e) { /* 용량 초과 등 */ }
      S.busy = false;
      setRunning(false);
      paintAll();
      if (S.pending) { S.pending = false; runSim(); }
    }).catch(function (err) {
      S.busy = false;
      setRunning(false);
      fail(err);
    });
  }

  function setRunning(v) {
    var el = $('#simStatus');
    if (el) el.textContent = v ? '계산 중…' : '';
    $('#btnSave').disabled = v;
  }

  function currentPeriodBlock() {
    if (!S.result) return null;
    for (var i = 0; i < S.result.periods.length; i++) {
      if (S.result.periods[i].period === S.period) return S.result.periods[i];
    }
    return S.result.periods[0];
  }

  /* =====================================================================
   * 5. 렌더링
   * =================================================================== */
  function paintAll() {
    if (!S.result) return;
    var cells = S.result.cellsByPeriod[S.period];
    if (cells) S.map.setData({ cells: cells });
    S.map.setPlacements(S.placements);
    if (S.selectedCellId) S.map.select(S.selectedCellId);
    paintKpi();
    paintPlacementList();
    paintBudget();
    drawCompareChart();
    drawCostChart();
    paintPolicy();
    paintDeltaTable();
  }

  function paintKpi() {
    var b = currentPeriodBlock();
    if (!b) return;
    var has = S.placements.length > 0;

    kpiTile('k1', fmt(b.kpi.needCells), '개',
      has ? b.delta.needCells : null, '개',
      '기준선 ' + fmt(b.baseline.needCells) + '개');
    /* 값은 '만 통행/일' 로 줄여 쓰지만 증감은 원 단위(통행/일)로 표기합니다.
       단위를 섞으면 "−14,936 만 통행" 처럼 1만 배 틀린 문장이 됩니다. */
    kpiTile('k2', C.fmt1(b.kpi.potentialTripsPerDay / 10000), '만 통행/일',
      has ? b.delta.potentialTripsPerDay : null, '통행/일',
      '기준선 ' + C.fmt1(b.baseline.potentialTripsPerDay / 10000) + '만 통행/일');
    kpiTile('k3', fmt(b.kpi.elderlyTripsPerDay), '통행/일',
      has ? b.delta.elderlyTripsPerDay : null, '통행/일',
      '기준선 ' + fmt(b.baseline.elderlyTripsPerDay) + '통행/일');

    var eff = S.result.effectiveness;
    $('#k4').innerHTML = eff.krwPerTripPerDay != null
      ? fmt(eff.krwPerTripPerDay) + '<small>원/통행</small>'
      : '<span style="color:var(--ink3)">–</span>';
    $('#k4d').className = 'dl';
    $('#k4d').textContent = has ? ('총 사업비 ' + won(S.result.cost.totalKrw)) : '기준선';
    $('#k4s').textContent = eff.resolvedTripsPerDay > 0
      ? ('전 시간대 합계 ' + fmt(eff.resolvedTripsPerDay) + '통행 해소 기준')
      : '배치를 추가하면 산출됩니다';
  }

  /**
   * KPI 타일 1개를 그립니다.
   * 이 화면의 지표는 모두 "줄어드는 것이 개선"이므로 음수 증감이 good 입니다.
   * @param deltaUnit 증감 라벨에 붙일 단위. 값 표시 단위와 다를 수 있음(위 주석 참고).
   */
  function kpiTile(id, value, unit, deltaVal, deltaUnit, subtext) {
    $('#' + id).innerHTML = value + '<small>' + esc(unit) + '</small>';
    var d = $('#' + id + 'd');
    if (deltaVal == null || deltaVal === 0) {
      d.className = 'dl';
      d.textContent = deltaVal === 0 ? '변화 없음' : '기준선';
    } else {
      d.className = 'dl ' + (deltaVal < 0 ? 'good' : 'bad');
      d.textContent = C.delta(deltaVal, ' ' + deltaUnit, true) + ' 기준선 대비';
    }
    $('#' + id + 's').textContent = subtext;
  }

  function paintPlacementList() {
    var host = $('#placeList');
    if (!S.placements.length) {
      host.innerHTML = '<div class="empty">아직 배치가 없습니다.<br>위에서 수단을 고른 뒤 지도의 격자를 클릭하세요.</div>';
      $('#btnReset').disabled = true;
      $('#btnUndo').disabled = true;
      return;
    }
    $('#btnReset').disabled = false;
    $('#btnUndo').disabled = false;
    host.innerHTML = '<ul class="plist">' + S.placements.map(function (p, i) {
      var e = S.effects[p.type] || {};
      var cell = S.map.cellById(p.cellId);
      return '<li><span class="ic">' + esc(e.icon || '●') + '</span>' +
        '<span class="tx"><b>' + esc(e.label || p.type) + (p.count > 1 ? ' ×' + p.count : '') + '</b>' +
        '<span>' + esc(cell ? cell.name : '') + ' · ' + esc(p.cellId) + ' · 반경 ' + (e.radiusKm || '?') + 'km</span></span>' +
        '<span class="cost">' + won((e.unitKrw || 0) * p.count) + '</span>' +
        '<button class="del" data-remove="' + i + '" type="button" aria-label="배치 삭제">×</button></li>';
    }).join('') + '</ul>';
  }

  function paintBudget() {
    var total = S.result ? S.result.cost.totalKrw : 0;
    var ratio = S.budget > 0 ? total / S.budget : 0;
    var over = total > S.budget && S.budget > 0;
    $('#budUsed').textContent = won(total);
    $('#budTotal').textContent = won(S.budget);
    var bar = $('#budBar');
    bar.style.width = Math.min(100, ratio * 100).toFixed(1) + '%';
    bar.classList.toggle('over', over);
    var note = $('#budNote');
    note.classList.toggle('over', over);
    note.textContent = S.budget <= 0 ? '예산 한도를 입력하면 집행률이 표시됩니다.'
      : over ? ('예산 초과 ' + won(total - S.budget) + ' — 배치를 조정하거나 한도를 상향해야 합니다.')
        : ('집행률 ' + (ratio * 100).toFixed(1) + '% · 잔여 ' + won(S.budget - total));
  }

  /* ---------------------------------------------------------------------
   * 전후 비교 차트
   *   기준선 = 점선 외곽선(고스트) 막대, 시나리오 = 채운 막대.
   *   색이 아니라 스타일로 구분하므로 색각 이상·흑백 인쇄에서도 읽힙니다.
   * ------------------------------------------------------------------- */
  var CM = { l: 42, r: 14, t: 20, b: 40, w: 640, h: 260 };
  function drawCompareChart() {
    if (!S.result) return;
    var P = S.result.periods;
    var maxV = 1;
    P.forEach(function (p) { maxV = Math.max(maxV, p.kpi.needCells, p.baseline.needCells); });
    var nice = Math.ceil(maxV / 10) * 10 || 10;
    var plotH = CM.h - CM.t - CM.b;
    var base = CM.h - CM.b;
    var step = (CM.w - CM.l - CM.r) / P.length;
    var bw = Math.min(46, step * 0.42);
    var yOf = function (v) { return v / nice * plotH; };
    var h = '';

    [0, .5, 1].forEach(function (f) {
      var y = base - plotH * f;
      h += '<line class="gl" x1="' + CM.l + '" y1="' + y + '" x2="' + (CM.w - CM.r) + '" y2="' + y + '"/>';
      h += '<text class="tick" x="' + (CM.l - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(nice * f) + '</text>';
    });
    h += '<line class="zl" x1="' + CM.l + '" y1="' + base + '" x2="' + (CM.w - CM.r) + '" y2="' + base + '"/>';

    P.forEach(function (p, i) {
      var cx = CM.l + step * i + step / 2;
      /* 2px 간격을 두고 나란히 — 기준선(왼쪽, 고스트) / 시나리오(오른쪽, 채움) */
      var xb = cx - bw - 1, xs = cx + 1;
      var hb = yOf(p.baseline.needCells), hs = yOf(p.kpi.needCells);

      if (hb > 0) h += '<path class="cmp-base" d="' + C.barUp(xb, base, bw, hb) + '"/>';
      var worse = p.delta.needCells > 0;
      if (hs > 0) h += '<path class="cmp-sim' + (worse ? ' worse' : '') + '" d="' + C.barUp(xs, base, bw, hs) + '"/>';

      h += '<text class="cmp-lab" x="' + (xb + bw / 2) + '" y="' + (base - hb - 5) + '" text-anchor="middle">' + p.baseline.needCells + '</text>';
      h += '<text class="cmp-lab" x="' + (xs + bw / 2) + '" y="' + (base - hs - 5) + '" text-anchor="middle">' + p.kpi.needCells + '</text>';
      h += '<text class="cmp-name" x="' + cx + '" y="' + (base + 16) + '" text-anchor="middle">' + esc(p.periodName) + '</text>';
      if (p.delta.needCells !== 0) {
        h += '<text class="tick" x="' + cx + '" y="' + (base + 30) + '" text-anchor="middle" fill="var(--' +
          (p.delta.needCells < 0 ? 'good' : 'bad') + ')">' +
          (p.delta.needCells > 0 ? '+' : '−') + Math.abs(p.delta.needCells) + '개</text>';
      }
      h += '<rect class="colhit" data-cmp="' + i + '" x="' + (cx - step / 2) + '" y="' + CM.t +
        '" width="' + step + '" height="' + plotH + '"/>';
    });
    h += '<text class="axlab" x="' + CM.l + '" y="' + (CM.t - 6) + '">고수요·저공급 격자 수 (개)</text>';
    $('#cmpChart').innerHTML = h;
  }

  /* --------------------------------------------------- 비용 대비 효과 */
  var CS = { l: 92, r: 96, t: 18, b: 26, w: 640, h: 170 };
  function drawCostChart() {
    if (!S.result) return;
    var bd = S.result.cost.breakdown;
    var host = $('#costChart');
    if (!bd.length) {
      host.innerHTML = '<text class="qlab" x="16" y="30">배치를 추가하면 수단별 소요액이 표시됩니다.</text>';
      return;
    }
    var max = bd.reduce(function (m, b) { return Math.max(m, b.amountKrw); }, 1);
    var rowH = Math.min(34, (CS.h - CS.t - CS.b) / bd.length);
    var barH = Math.min(18, rowH - 10);
    var plotW = CS.w - CS.l - CS.r;
    var h = '';
    bd.forEach(function (b, i) {
      var y = CS.t + i * rowH;
      var w = Math.max(2, (b.amountKrw / max) * plotW);
      h += '<text class="cmp-name" x="' + (CS.l - 8) + '" y="' + (y + barH - 3) + '" text-anchor="end">' + esc(b.label) + '</text>';
      h += '<path class="cost-bar" d="' + C.barRight(CS.l, y, barH, w) + '"/>';
      h += '<text class="cmp-lab" x="' + (CS.l + w + 8) + '" y="' + (y + barH - 3) + '">' + esc(won(b.amountKrw)) + '</text>';
    });
    var y2 = CS.t + bd.length * rowH + 6;
    h += '<line class="gl" x1="' + CS.l + '" y1="' + y2 + '" x2="' + (CS.w - CS.r) + '" y2="' + y2 + '"/>';
    h += '<text class="cmp-name" x="' + (CS.l - 8) + '" y="' + (y2 + 18) + '" text-anchor="end" font-weight="600">합계</text>';
    h += '<text class="cmp-lab" x="' + CS.l + '" y="' + (y2 + 18) + '" font-weight="600">' + esc(won(S.result.cost.totalKrw)) + '</text>';
    host.innerHTML = h;
  }

  /* ------------------------------------------------- 정책 판단 요약 */
  function paintPolicy() {
    var r = S.result, b = currentPeriodBlock();
    if (!r || !b) return;
    var host = $('#policy');
    if (!S.placements.length) {
      host.innerHTML = '<div class="pcard"><h3>배치안이 비어 있습니다</h3>' +
        '<p>지도에서 수단을 배치하면, 기준선 대비 개선 효과와 소요 예산을 근거 문장으로 정리해 드립니다. ' +
        '대시보드의 <b>노선 조정 우선순위 Top 10</b> 상위 격자부터 배치해 보는 것을 권장합니다.</p></div>';
      return;
    }

    var eff = r.effectiveness;
    var dn = b.delta.needCells, dt = b.delta.potentialTripsPerDay, de = b.delta.elderlyTripsPerDay;
    var over = S.budget > 0 && r.cost.totalKrw > S.budget;

    var verdict, verdictWhy;
    if (dn < 0 && !over) {
      verdict = '집행 가능 · 효과 확인됨';
      verdictWhy = '예산 범위 안에서 사각지대가 실제로 줄어듭니다.';
    } else if (dn < 0 && over) {
      verdict = '효과는 있으나 예산 초과';
      verdictWhy = '배치 수를 줄이거나 예산 한도 상향이 필요합니다.';
    } else if (dn === 0) {
      verdict = '효과 미미 — 위치 재검토 필요';
      verdictWhy = '배치 위치가 사각지대 중심에서 벗어나 있을 수 있습니다.';
    } else {
      verdict = '재검토 필요';
      verdictWhy = '해당 시간대 기준으로는 개선이 확인되지 않습니다.';
    }

    var byType = {};
    S.placements.forEach(function (p) {
      var lb = (S.effects[p.type] || {}).label || p.type;
      byType[lb] = (byType[lb] || 0) + p.count;
    });

    var h = '';
    h += '<div class="pcard"><h3>판단 요약 <span class="tag ' + (dn < 0 && !over ? 'eff' : 'new') + '">' + esc(verdict) + '</span></h3>' +
      '<p>' + esc(verdictWhy) + ' ' +
      Object.keys(byType).map(function (k) { return k + ' ' + byType[k] + '건'; }).join(', ') +
      '을 배치할 때 총 소요액은 <span class="num">' + esc(won(r.cost.totalKrw)) + '</span>입니다.</p></div>';

    h += '<div class="pcard"><h3>' + esc(b.periodName) + ' 시간대 효과</h3><ul>' +
      '<li>고수요·저공급 격자 <span class="num">' + fmt(b.baseline.needCells) + '개 → ' + fmt(b.kpi.needCells) + '개</span>' +
      (dn !== 0 ? ' (' + (dn < 0 ? fmt(-dn) + '개 해소' : fmt(dn) + '개 증가') + ')' : ' (변화 없음)') + '</li>' +
      '<li>사각지대 잠재수요 <span class="num">일 ' + fmt(b.baseline.potentialTripsPerDay) + ' → ' + fmt(b.kpi.potentialTripsPerDay) + '통행</span>' +
      (dt < 0 ? ' (' + fmt(-dt) + '통행 해소)' : '') + '</li>' +
      '<li>교통약자 수혜 <span class="num">일 ' + fmt(Math.max(0, -de)) + '통행</span> 추정</li>' +
      '</ul></div>';

    h += '<div class="pcard"><h3>비용 대비 효과</h3><ul>' +
      '<li>총 사업비 <span class="num">' + esc(won(r.cost.totalKrw)) + '</span>' +
      (S.budget > 0 ? ' / 한도 ' + esc(won(S.budget)) + (over ? ' <b style="color:var(--bad)">초과</b>' : '') : '') + '</li>' +
      '<li>전 시간대 해소 통행 <span class="num">' + fmt(eff.resolvedTripsPerDay) + '통행/일</span></li>' +
      '<li>' + (eff.krwPerTripPerDay != null
        ? '통행 1건당 <span class="num">' + fmt(eff.krwPerTripPerDay) + '원</span> (사업비 ÷ 해소 통행)'
        : '해소된 통행이 없어 단가를 산출할 수 없습니다') + '</li>' +
      '</ul></div>';

    h += '<div class="pcard"><h3>실행 로드맵(안)</h3><ul>' +
      '<li><b>단기(3개월)</b> — 배치 대상 격자 현장 실사, 운수업체·주민 의견 수렴</li>' +
      '<li><b>중기(6개월)</b> — ' +
      (byType['똑버스 배치'] ? '수요응답형 운행구역 조정 고시 및 차량 확보, ' : '') +
      '노선 조정안 교통위원회 상정</li>' +
      '<li><b>상시</b> — 교통카드 데이터 갱신 시 지표 재산출, 효과 사후 검증</li>' +
      '</ul></div>';

    host.innerHTML = h;
  }

  function paintDeltaTable() {
    if (!S.result) return;
    $('#deltaTbl').innerHTML =
      '<tr><th>시간대</th><th>사각지대(전)</th><th>사각지대(후)</th><th>증감</th>' +
      '<th>잠재수요(전)</th><th>잠재수요(후)</th><th>증감</th><th>평균 MI 변화</th></tr>' +
      S.result.periods.map(function (p) {
        return '<tr><td>' + esc(p.periodName) + '</td>' +
          '<td>' + fmt(p.baseline.needCells) + '</td><td>' + fmt(p.kpi.needCells) + '</td>' +
          '<td>' + (p.delta.needCells > 0 ? '+' : '') + p.delta.needCells + '</td>' +
          '<td>' + fmt(p.baseline.potentialTripsPerDay) + '</td><td>' + fmt(p.kpi.potentialTripsPerDay) + '</td>' +
          '<td>' + (p.delta.potentialTripsPerDay > 0 ? '+' : '') + fmt(p.delta.potentialTripsPerDay) + '</td>' +
          '<td>' + (p.delta.avgMi > 0 ? '+' : '') + p.delta.avgMi.toFixed(3) + '</td></tr>';
      }).join('');
  }

  function cellTip(c) {
    var e = S.tool ? S.effects[S.tool] : null;
    var hint = e ? '<br><span class="mono" style="color:var(--sel)">클릭 → ' + esc(e.label) + ' 배치 (반경 ' + e.radiusKm + 'km)</span>' : '';
    return '<b>' + esc(c.name) + '</b> <span class="mono">' + esc(c.id) + '</span><br>' +
      '수요 D <b>' + c.demand + '</b> · 공급 S <b>' + c.supply + '</b> · MI <b>' +
      (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) + '</b><br>' +
      '잠재수요 ' + fmt(c.flowTripsPerDay) + '통행/일 · 고령비 ' + Math.round(c.elderlyRatio * 100) + '%' +
      (c.adjusted ? '<br><span class="mono" style="color:var(--sel)">배치 효과 반영됨</span>' : '') + hint;
  }

  /* =====================================================================
   * 6. 시나리오 저장 · 비교
   * =================================================================== */
  function loadScenarios() {
    try { return JSON.parse(localStorage.getItem(LS_SCENARIOS) || '[]'); }
    catch (e) { return []; }
  }
  function saveScenarios(list) {
    try { localStorage.setItem(LS_SCENARIOS, JSON.stringify(list)); }
    catch (e) { C.toast('시나리오를 저장하지 못했습니다(브라우저 저장 공간).', 'err'); }
  }

  function saveCurrent() {
    if (!S.result) return;
    var list = loadScenarios();
    list.unshift({
      name: S.name,
      savedAt: C.nowStamp(),
      period: S.period,
      budgetKrw: S.budget,
      placements: S.placements.map(function (p) { return { type: p.type, cellId: p.cellId, count: p.count }; }),
      summary: {
        costKrw: S.result.cost.totalKrw,
        resolvedTrips: S.result.effectiveness.resolvedTripsPerDay,
        krwPerTrip: S.result.effectiveness.krwPerTripPerDay,
        needDelta: (currentPeriodBlock() || {}).delta ? currentPeriodBlock().delta.needCells : 0
      }
    });
    saveScenarios(list.slice(0, 12));
    renderScenarioList();
    C.toast('시나리오 <b>' + esc(S.name) + '</b> 을(를) 저장했습니다.');
  }

  function renderScenarioList() {
    var list = loadScenarios();
    var host = $('#scenList');
    if (!list.length) {
      host.innerHTML = '<div class="empty">저장된 시나리오가 없습니다.<br>배치안을 만든 뒤 [시나리오 저장]을 누르세요.</div>';
      return;
    }
    host.innerHTML = list.map(function (s, i) {
      return '<button class="scen" data-load="' + i + '" type="button">' +
        '<span class="snm">' + esc(s.name) + '</span>' +
        '<span class="sdel" data-del="' + i + '" role="button" aria-label="삭제">×</span>' +
        '<span class="smeta"><span>' + esc(s.savedAt) + '</span>' +
        '<span>배치 ' + s.placements.length + '건</span>' +
        '<span>' + esc(won(s.summary.costKrw)) + '</span>' +
        '<span>' + (s.summary.needDelta < 0 ? '사각지대 −' + Math.abs(s.summary.needDelta) + '개' : '변화 없음') + '</span>' +
        (s.summary.krwPerTrip != null ? '<span>' + fmt(s.summary.krwPerTrip) + '원/통행</span>' : '') +
        '</span></button>';
    }).join('');
  }

  function loadScenario(i) {
    var list = loadScenarios();
    var s = list[i];
    if (!s) return;
    S.name = s.name;
    S.period = s.period || S.period;
    S.budget = s.budgetKrw || S.budget;
    S.placements = (s.placements || []).map(function (p) { return { type: p.type, cellId: p.cellId, count: p.count }; });
    $('#scenName').value = S.name;
    $('#budgetInput').value = Math.round(S.budget / 100000000);
    $$('#periods [data-period]').forEach(function (x) {
      var on = x.getAttribute('data-period') === S.period;
      x.classList.toggle('on', on);
      x.setAttribute('aria-selected', String(on));
    });
    runSim();
    C.toast('시나리오 <b>' + esc(s.name) + '</b> 을(를) 불러왔습니다.');
  }

  function deleteScenario(i) {
    var list = loadScenarios();
    list.splice(i, 1);
    saveScenarios(list);
    renderScenarioList();
  }

  /* =====================================================================
   * 7. 배선
   * =================================================================== */
  function wireControls() {
    $('#tools').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tool]');
      if (!b) return;
      var t = b.getAttribute('data-tool');
      S.tool = (S.tool === t) ? null : t;
      $$('#tools [data-tool]').forEach(function (x) {
        var on = x.getAttribute('data-tool') === S.tool;
        x.classList.toggle('on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      S.map.setArmed(!!S.tool);
      var e2 = S.tool ? S.effects[S.tool] : null;
      $('#simhint').textContent = e2
        ? (e2.label + ' 모드 — 배치할 격자를 지도에서 클릭하세요. 반경 약 ' + e2.radiusKm + 'km에 파급됩니다. (단가 ' + won(e2.unitKrw) + ')')
        : '수단을 고른 뒤 지도를 클릭하면 배치되고, KPI가 기준선 대비 즉시 재계산됩니다.';
    });

    $('#layers').addEventListener('click', function (e) {
      var b = e.target.closest('[data-layer]');
      if (!b) return;
      $$('#layers [data-layer]').forEach(function (x) { x.classList.toggle('on', x === b); });
      S.map.setLayer(b.getAttribute('data-layer'));
    });

    $('#placeList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-remove]');
      if (b) removePlacement(+b.getAttribute('data-remove'));
    });
    $('#btnUndo').addEventListener('click', function () {
      S.placements.pop();
      runSim();
    });
    $('#btnReset').addEventListener('click', resetAll);
    $('#btnSave').addEventListener('click', saveCurrent);

    $('#scenList').addEventListener('click', function (e) {
      var d = e.target.closest('[data-del]');
      if (d) { e.stopPropagation(); deleteScenario(+d.getAttribute('data-del')); return; }
      var b = e.target.closest('[data-load]');
      if (b) loadScenario(+b.getAttribute('data-load'));
    });

    $('#cmpChart').addEventListener('mousemove', function (e) {
      var col = e.target.closest('[data-cmp]');
      if (!col || !S.result) return C.hideTip();
      var p = S.result.periods[+col.getAttribute('data-cmp')];
      C.showTip('<b>' + esc(p.periodName) + '</b><br>기준선 ' + p.baseline.needCells + '개 → 시나리오 ' +
        p.kpi.needCells + '개<br>잠재수요 ' + fmt(p.baseline.potentialTripsPerDay) + ' → ' +
        fmt(p.kpi.potentialTripsPerDay) + '통행/일', e);
    });
    $('#cmpChart').addEventListener('mouseleave', C.hideTip);
  }

  function renderFooter(meta) {
    if (!meta.isMockData) {
      ['#mockNote', '#mockBadge', '#mapMock'].forEach(function (s) {
        var el = $(s); if (el) el.style.display = 'none';
      });
    }
    var costList = $('#costNote');
    if (costList && meta.effects) {
      costList.innerHTML = meta.effects.map(function (e) {
        return '<span>' + esc(e.label) + ' ' + esc(won(e.unitKrw)) + '</span>';
      }).join('');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
