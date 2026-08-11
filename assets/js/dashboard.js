/* ============================================================================
 *  dashboard.js — 분석 화면
 * ----------------------------------------------------------------------------
 *  이 화면은 "현황 파악" 전용입니다. 배치 시뮬레이션은 simulation.html 에 있습니다.
 *  모든 데이터는 HW.api 를 통해서만 가져옵니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW;
  var C = HW.core, api = HW.api;
  var $ = C.$, $$ = C.$$, esc = C.esc, fmt = C.fmt;

  var S = {
    meta: null,
    period: 'am',
    periodName: '출근',
    grid: null,          // { cells, kpi, ... }
    priorities: null,
    stops: [],
    routes: [],
    selectedCellId: null,
    selectedStopId: null,
    profile: null,
    focusRegion: null,
    map: null
  };

  /* =====================================================================
   * 1. 부팅
   * =================================================================== */
  function boot() {
    C.mountTopnav('dashboard');
    C.initTheme();
    C.wireHelp();
    HW.report.mount();
    HW.report.setContextProvider(function () {
      return {
        period: S.period,
        meta: S.meta,
        kpi: S.grid ? S.grid.kpi : null,
        priorities: S.priorities ? S.priorities.items : null,
        simulation: readSavedScenario()
      };
    });

    api.meta().then(function (meta) {
      S.meta = meta;
      renderPeriodTabs(meta.periods);
      renderFooter(meta);
      renderDataQuality(meta);
      /* 격자 크기는 서버 meta 를 따른다 — HTML 에 1km 를 박아두면 세분화 때 틀어진다 */
      var sub = $('#mapSub');
      if (sub && meta.grid && meta.grid.sizeMeters) {
        sub.textContent = '붉을수록 수요 대비 버스가 부족한 격자 · 격자 ' +
          (meta.grid.sizeMeters / 1000) + 'km · 실제 읍면동 경계';
      }
      S.map = HW.createMap({
        svg: $('#map'), legend: $('#legend'), meta: meta,
        onClearFocus: function () { focusRegion(null); },
        /* 격자를 클릭하면 그 격자로 파고듭니다 — 확대 + 그 격자의 정류장·노선만
           + 아래 카드에 노선 경유 순서. 전체 뷰에서 노선을 다 깔면 격자 색이
           덮이므로, 자세히는 클릭했을 때만 보여 줍니다. */
        onCellClick: function (cell) { enterCellFocus(cell.id); },
        onExitCellFocus: function () { renderCellRoutes(null); },
        onCellHover: function (cell, ev) { C.showTip(cellTip(cell), ev); },
        /* 정류장 위에 있는 격자도 선택되게 합니다.
           예전에는 정류장이 클릭을 가로채 그 격자를 고를 방법이 없었습니다. */
        onStopClick: function (stop, cell) {
          selectStop(stop.id, true);
          if (cell) selectCell(cell.id, false);
        }
      });
      return Promise.all([api.stops(), api.routes()]);
    }).then(function (r) {
      S.stops = r[0].stops;
      S.routes = r[1].routes;
      S.map.setData({ stops: S.stops, routes: S.routes });
      fillStopSelect();
      wireControls();
      return loadPeriod(S.period);
    }).then(function () {
      /* 최우선 격자를 초기 선택. 다만 확대·노선 표시까지 하지는 않습니다 —
         첫 화면은 화성시 전체의 미스매칭 분포를 보는 자리입니다. */
      renderCellRoutes(null);
      var first = S.priorities && S.priorities.items[0];
      if (first) selectCell(first.cellId, true);
      else selectStop(S.stops[0] && S.stops[0].id);
    }).catch(fail);
  }

  function fail(err) {
    console.error(err);
    var box = $('#bootError');
    if (box) {
      box.innerHTML = '<div class="errbox"><b>데이터를 불러오지 못했습니다.</b><br>' +
        esc(api.humanize(err)) +
        '<br><span style="font-size:11.5px;opacity:.8">서버가 켜져 있는지 확인해 주세요. ' +
        '주소를 바꿔 열었다면 주소창에 <b>?server=</b> 만 붙여 저장된 서버 주소를 초기화할 수 있습니다.</span>' +
        '<br><button class="btn sm" data-retry type="button" style="margin-top:8px">다시 시도</button></div>';
      box.style.display = '';
      var rb = box.querySelector('[data-retry]');
      /* 부팅(meta 로드) 전 실패면 이벤트 중복 배선을 피해 새로고침으로 재시도 */
      if (rb) rb.addEventListener('click', function () {
        if (S.meta) { clearFail(); loadPeriod(S.period); }
        else location.reload();
      });
    }
    C.toast('데이터 로드 실패 — ' + esc(api.humanize(err)), 'err', 7000);
  }

  /** 성공하면 에러 배너를 접습니다 — 일시 오류가 화면에 눌어붙지 않게 */
  function clearFail() {
    var box = $('#bootError');
    if (box) box.style.display = 'none';
  }

  /* =====================================================================
   * 2. 시간대 전환
   * =================================================================== */
  function renderPeriodTabs(periods) {
    var host = $('#periods');
    host.innerHTML = periods.map(function (p, i) {
      return '<button class="pbtn' + (i === 0 ? ' on' : '') + '" data-period="' + esc(p.id) +
        '" role="tab" aria-selected="' + (i === 0) + '"><b>' + esc(p.name) + '</b><span>' + esc(p.label) + '</span></button>';
    }).join('');
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-period]');
      if (!b) return;
      loadPeriod(b.getAttribute('data-period'));
    });
  }

  /* 탭을 빠르게 연달아 누르면 먼저 보낸 요청이 늦게 도착해 이전 시간대
     데이터가 화면을 덮을 수 있습니다. 마지막 요청만 반영합니다. */
  var loadSeq = 0;

  function loadPeriod(pid) {
    S.period = pid;
    var seq = ++loadSeq;
    var p = (S.meta.periods || []).filter(function (x) { return x.id === pid; })[0];
    S.periodName = p ? p.name : pid;
    $$('#periods [data-period]').forEach(function (b) {
      var on = b.getAttribute('data-period') === pid;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('#pchip').textContent = p ? (p.name + ' ' + p.label) : pid;

    return Promise.all([api.grid(pid), api.priorities(pid, 10)]).then(function (r) {
      if (seq !== loadSeq) return;   // 그사이 다른 탭으로 넘어갔으면 버립니다
      clearFail();
      S.grid = r[0];
      S.priorities = r[1];
      cellIdx = {};
      S.grid.cells.forEach(function (c) { cellIdx[c.id] = c; });
      S.map.setData({ cells: S.grid.cells, scale: S.grid.scale });
      paintKpi();
      paintBrief();
      paintRegions();
      paintPriorities();
      drawScatter();
      paintCellTable();
      /* 선택 상태를 새 시간대 기준으로 다시 그립니다 — 그냥 select 만 하면
         정류장 프로파일 음영과 시뮬레이션 링크의 period 가 이전 탭에 머뭅니다. */
      if (S.selectedCellId) selectCell(S.selectedCellId);
      if (S.selectedStopId) selectStop(S.selectedStopId);
    }).catch(function (err) {
      if (seq !== loadSeq) return;
      fail(err);
    });
  }

  /* =====================================================================
   * 3. KPI
   * =================================================================== */
  function paintKpi() {
    var k = S.grid.kpi;
    var top = S.priorities && S.priorities.items[0];
    $('#k1').innerHTML = fmt(k.needCells) + '<small>개</small>';
    $('#k1s').textContent = '전체 ' + fmt(k.totalCells) + '개 중 ' + k.needShare + '%' +
      (top ? ' · 최우선 ' + top.name : '');

    $('#k2').innerHTML = C.fmt1(k.potentialTripsPerDay / 10000) + '<small>만 통행/일</small>';
    $('#k2s').textContent = '고수요·저공급 격자의 잠재수요 합(거주인구 기반 추정)';

    $('#k3').innerHTML = fmt(k.elderlyTripsPerDay) + '<small>통행/일</small>';
    var share = k.potentialTripsPerDay > 0 ? (100 * k.elderlyTripsPerDay / k.potentialTripsPerDay) : 0;
    $('#k3s').textContent = '사각지대 잠재수요의 ' + share.toFixed(1) + '% · 교통약자 가중 근거';

    $('#k4').innerHTML = fmt(k.drtCells) + '<small>개</small>';
  }

  /* =====================================================================
   * 3-2. 한 줄 브리핑
   *   숫자만 나열하지 않고 "그래서 어디가 문제이고 무엇을 검토할지"를
   *   문장으로 먼저 제시합니다. 실무자가 첫 화면에서 판단을 시작할 수 있게.
   * =================================================================== */
  function paintBrief() {
    var k = S.grid.kpi;
    var items = S.priorities.items;
    /* 권역표는 사용자가 아무 컬럼으로나 정렬할 수 있습니다. 브리핑의
       "어디에 몰려 있다"는 정렬 상태와 무관하게 항상 need 최다 권역이어야 합니다. */
    var regions = aggregateRegions().slice().sort(function (a, b) { return b.need - a.need; });
    var top = regions.filter(function (r) { return r.need > 0; })[0];
    var periodLabel = (S.meta.periods || []).filter(function (p) { return p.id === S.period; })[0];
    periodLabel = periodLabel ? (periodLabel.name + ' 시간대(' + periodLabel.label + ')') : S.period;

    var lines = [];
    lines.push('<b>' + esc(periodLabel) + '</b> 기준, 전체 ' + fmt(k.totalCells) + '개 격자 중 ' +
      '<b>고수요·저공급이 ' + fmt(k.needCells) + '개</b>(' + k.needShare + '%)입니다.');

    /* "몰려 있다" 임계는 셀 수에 비례 — 1km(786셀)면 예전처럼 2개, 500m(~3천 셀)면 8개 */
    var clusterMin = Math.max(2, Math.round(S.grid.cells.length * 0.0025));
    if (top && top.need >= clusterMin) {
      lines.push('<b>' + esc(top.name) + '</b> 권역에 ' + top.need + '개가 몰려 있습니다.');
    }
    if (items[0]) {
      lines.push('최우선 대상은 <b>' + esc(items[0].name) + '</b>(' + esc(items[0].cellId) + ')이며 ' +
        esc(items[0].actionLabel) + ' 검토가 필요합니다.');
    }
    lines.push('사각지대 잠재수요는 일 ' + fmt(k.potentialTripsPerDay) + '통행, ' +
      '이 중 고령층 추정이 ' + fmt(k.elderlyTripsPerDay) + '통행입니다.');

    /* 상위 격자의 조치 유형 분포 → 무엇을 몇 건 검토해야 하는지 */
    var mix = {};
    items.forEach(function (r) { mix[r.actionLabel] = (mix[r.actionLabel] || 0) + 1; });
    var mixText = Object.keys(mix).map(function (kk) { return kk + ' ' + mix[kk] + '곳'; }).join(' · ');

    $('#brief').innerHTML =
      '<div class="brief-main">' + lines.join(' ') + '</div>' +
      (mixText ? '<div class="brief-act"><span class="brief-tag">검토 대상</span>' + esc(mixText) +
        ' <span class="brief-dim">(우선순위 상위 ' + items.length + '개 격자 기준)</span></div>' : '');
  }

  /* =====================================================================
   * 3-3. 권역별 요약
   *   공무원은 격자 번호가 아니라 읍면동 단위로 일합니다.
   *   격자를 권역으로 집계해 "어느 동네를 먼저 봐야 하는지" 보여줍니다.
   * =================================================================== */
  var regionSort = { key: 'need', desc: true };

  function aggregateRegions() {
    var by = {};
    S.grid.cells.forEach(function (c) {
      var r = by[c.region] || (by[c.region] = {
        name: c.region, cells: 0, need: 0, drt: 0, over: 0,
        trips: 0, elderly: 0, eldSum: 0, actions: {}, topCell: null, topMi: -99
      });
      r.cells++;
      r.eldSum += c.elderlyRatio;
      if (c.quadrant === 'need') {
        r.need++;
        r.trips += c.flowTripsPerDay;
        r.elderly += c.flowTripsPerDay * c.elderlyRatio;
        r.actions[c.actionLabel] = (r.actions[c.actionLabel] || 0) + 1;
        if (c.mi > r.topMi) { r.topMi = c.mi; r.topCell = c; }
      } else if (c.quadrant === 'drt') r.drt++;
      else if (c.quadrant === 'over') r.over++;
    });
    var list = Object.keys(by).map(function (k) {
      var r = by[k];
      r.elderlyRatio = r.eldSum / r.cells;
      r.action = Object.keys(r.actions).sort(function (a, b) { return r.actions[b] - r.actions[a]; })[0] ||
        (r.drt > 0 ? 'DRT 검토' : '—');
      return r;
    });
    return sortRegions(list);
  }

  function sortRegions(list) {
    var k = regionSort.key, d = regionSort.desc ? -1 : 1;
    return list.sort(function (a, b) {
      var av = k === 'name' ? a.name : a[k];
      var bv = k === 'name' ? b.name : b[k];
      if (k === 'name') return d * av.localeCompare(bv, 'ko');
      if (av === bv) return b.need - a.need;
      return d * (av - bv);
    });
  }

  function paintRegions() {
    var list = aggregateRegions();
    var maxNeed = Math.max.apply(null, list.map(function (r) { return r.need; }).concat([1]));
    var head = [
      ['name', '권역', 'left'], ['cells', '격자', ''], ['need', '사각지대', ''],
      ['drt', 'DRT 후보', ''], ['trips', '잠재수요(통행/일)', ''],
      ['elderly', '고령 통행', ''], ['elderlyRatio', '고령비', '']
    ];
    var html = '<table class="rgtbl"><thead><tr>' +
      head.map(function (h) {
        var on = regionSort.key === h[0];
        return '<th data-sort="' + h[0] + '" class="' + (on ? 'on' : '') + '" scope="col">' +
          esc(h[1]) + (on ? (regionSort.desc ? ' ▾' : ' ▴') : '') + '</th>';
      }).join('') + '<th scope="col">주 조치</th></tr></thead><tbody>' +
      list.map(function (r) {
        var pctBar = r.need > 0 ? (100 * r.need / maxNeed) : 0;
        return '<tr data-region="' + esc(r.name) + '"' +
          (S.focusRegion === r.name ? ' class="on"' : '') + '>' +
          '<td class="rg-name">' + esc(r.name) + '</td>' +
          '<td>' + fmt(r.cells) + '</td>' +
          '<td class="rg-need">' + (r.need > 0
            ? '<span class="rg-bar"><i style="width:' + pctBar.toFixed(0) + '%"></i></span><b>' + r.need + '</b>'
            : '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + (r.drt || '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + (r.trips ? fmt(r.trips) : '<span class="rg-zero">–</span>') + '</td>' +
          '<td>' + (r.elderly ? fmt(r.elderly) : '<span class="rg-zero">–</span>') + '</td>' +
          '<td>' + Math.round(r.elderlyRatio * 100) + '%</td>' +
          '<td>' + (r.need > 0 || r.drt > 0
            ? '<span class="tag ' + (r.action === 'DRT 검토' || r.action === 'DRT' ? 'drt' : r.action === '신설' ? 'new' : 'add') + '">' + esc(r.action) + '</span>'
            : '<span class="rg-zero">—</span>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
    $('#regionTbl').innerHTML = html;
  }

  /** 권역 행을 누르면 그 권역 격자만 지도에서 진하게 표시합니다 */
  function focusRegion(name) {
    S.focusRegion = (S.focusRegion === name) ? null : name;
    if (!S.focusRegion) {
      S.map.setEligible(null);
    } else {
      var set = new Set();
      S.grid.cells.forEach(function (c) { if (c.region === S.focusRegion) set.add(c.id); });
      S.map.setEligible(set, S.focusRegion + ' 권역만 강조 중');
      /* 그 권역에서 가장 시급한 격자를 함께 선택 */
      var top = S.priorities.items.filter(function (r) {
        var c = cellById(r.cellId);
        return c && c.region === S.focusRegion;
      })[0];
      if (top) selectCell(top.cellId, true);
    }
    paintRegions();
  }

  /* =====================================================================
   * 4. 우선순위 Top 10
   * =================================================================== */
  function paintPriorities() {
    var items = S.priorities.items;
    var host = $('#t10');
    if (!items.length) {
      host.innerHTML = '<div class="empty">현재 시간대에 고수요·저공급 격자가 없습니다.<br>다른 시간대를 확인해 보세요.</div>';
      return;
    }
    var mx = items[0].priorityScore || 1;
    host.innerHTML = items.map(function (r) {
      var tagClass = r.action === 'DRT' ? 'drt' : (r.action === 'NEW_STOP' ? 'new' : 'add');
      return '<button class="trow' + (r.cellId === S.selectedCellId ? ' sel' : '') + '" data-cell="' + esc(r.cellId) + '">' +
        '<span class="rk">' + r.rank + '</span>' +
        '<span class="nm">' + esc(r.name) + '<span>' + esc(r.cellId) + '</span></span>' +
        '<span class="mi">MI +' + r.mi.toFixed(2) + '</span>' +
        '<span class="sub2"><span>잠재 ' + fmt(r.flowTripsPerDay) + '통행/일</span>' +
        '<em>고령 ' + Math.round(r.elderlyRatio * 100) + '%</em></span>' +
        '<span class="bar"><i style="width:' + (100 * r.priorityScore / mx).toFixed(0) + '%"></i></span>' +
        '<span class="tag ' + tagClass + '">' + esc(r.actionLabel) + '</span>' +
        '</button>';
    }).join('');
  }

  /* =====================================================================
   * 5. 수요–공급 4분면 산점도
   * =================================================================== */
  var SC = { l: 56, r: 16, t: 30, b: 48, w: 520, h: 420 };
  function sx(z) { return SC.l + (C.clamp(z, -2.8, 2.8) + 2.8) / 5.6 * (SC.w - SC.l - SC.r); }
  function sy(z) { return SC.h - SC.b - (C.clamp(z, -2.8, 2.8) + 2.8) / 5.6 * (SC.h - SC.t - SC.b); }

  function drawScatter() {
    var cells = S.grid.cells, h = '';
    [-2, -1, 1, 2].forEach(function (z) {
      h += '<line class="gl" x1="' + sx(z) + '" y1="' + SC.t + '" x2="' + sx(z) + '" y2="' + (SC.h - SC.b) + '"/>';
      h += '<line class="gl" x1="' + SC.l + '" y1="' + sy(z) + '" x2="' + (SC.w - SC.r) + '" y2="' + sy(z) + '"/>';
      h += '<text class="tick" x="' + sx(z) + '" y="' + (SC.h - SC.b + 14) + '" text-anchor="middle">' + (z > 0 ? '+' + z : z) + '</text>';
      h += '<text class="tick" x="' + (SC.l - 8) + '" y="' + (sy(z) + 3) + '" text-anchor="end">' + (z > 0 ? '+' + z : z) + '</text>';
    });
    h += '<line class="zl" x1="' + sx(0) + '" y1="' + SC.t + '" x2="' + sx(0) + '" y2="' + (SC.h - SC.b) + '"/>';
    h += '<line class="zl" x1="' + SC.l + '" y1="' + sy(0) + '" x2="' + (SC.w - SC.r) + '" y2="' + sy(0) + '"/>';
    h += '<text class="qlab hot" x="' + (SC.l + 6) + '" y="' + (SC.t + 14) + '">고수요·저공급 → 증차·신설</text>';
    h += '<text class="qlab" x="' + (SC.w - SC.r - 6) + '" y="' + (SC.t + 14) + '" text-anchor="end">고수요·고공급 · 적정</text>';
    h += '<text class="qlab" x="' + (SC.l + 6) + '" y="' + (SC.h - SC.b - 8) + '">저수요·저공급 → DRT 검토</text>';
    h += '<text class="qlab" x="' + (SC.w - SC.r - 6) + '" y="' + (SC.h - SC.b - 8) + '" text-anchor="end">저수요·고공급 → 효율화</text>';
    h += '<text class="axlab" x="' + ((SC.l + SC.w - SC.r) / 2) + '" y="' + (SC.h - 10) + '" text-anchor="middle">공급지수 S (z)</text>';
    h += '<text class="axlab" transform="rotate(-90 14 ' + ((SC.t + SC.h - SC.b) / 2) + ')" x="14" y="' +
      ((SC.t + SC.h - SC.b) / 2) + '" text-anchor="middle">수요지수 D (z)</text>';

    /* 점 크기는 셀 수에 맞춰 줄입니다 — 격자 세분화(500m, ~3천 셀) 시 과밀 대응 */
    var dotR = cells.length > 1500 ? 2.2 : 3.8;
    cells.forEach(function (c) {
      h += '<circle class="dot c m' + c.bins.mi + '" data-cell="' + esc(c.id) + '" cx="' +
        sx(c.zSupply).toFixed(1) + '" cy="' + sy(c.zDemand).toFixed(1) + '" r="' + dotR + '"/>';
    });
    h += '<circle class="scatring" data-scatring r="7" cx="-99" cy="-99" visibility="hidden"/>';
    $('#scatter').innerHTML = h;
    placeScatterRing();
  }

  function placeScatterRing() {
    var ring = $('[data-scatring]');
    if (!ring) return;
    var c = S.selectedCellId && cellById(S.selectedCellId);
    if (!c) { ring.setAttribute('visibility', 'hidden'); return; }
    ring.setAttribute('cx', sx(c.zSupply).toFixed(1));
    ring.setAttribute('cy', sy(c.zDemand).toFixed(1));
    ring.setAttribute('visibility', 'visible');
  }

  /* 산점도 호버가 mousemove 마다 부르므로 선형 탐색 대신 색인을 씁니다.
     격자를 세분화하면(500m, ~3천 셀) 선형 탐색이 이벤트마다 수천 번 비교가 됩니다. */
  var cellIdx = {};
  function cellById(id) {
    return cellIdx[id] || null;
  }

  /* =====================================================================
   * 6. 정류장 시간대 프로파일
   * =================================================================== */
  var STC = { l: 44, r: 12, t: 26, b: 34, w: 640, h: 268 };

  var refreshStopOptions = null;   // 검색어로 선택 목록을 다시 채웁니다 (selectStop 에서도 사용)

  function fillStopSelect() {
    var sel = $('#stopSelect');
    var search = $('#stopSearch');
    var sorted = S.stops.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, 'ko');
    });
    refreshStopOptions = function (query) {
      var q = (query || '').trim().toLowerCase();
      var list = q ? sorted.filter(function (s) {
        return s.name.toLowerCase().indexOf(q) >= 0;
      }) : sorted;
      sel.innerHTML = list.map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
      }).join('');
      if (!list.length) return;
      var kept = list.some(function (s) { return s.id === S.selectedStopId; });
      /* 검색 결과에 현재 선택이 없으면 첫 결과를 바로 보여줍니다 */
      if (q && !kept) selectStop(list[0].id, true);
      else if (S.selectedStopId) sel.value = S.selectedStopId;
    };
    refreshStopOptions('');
    sel.addEventListener('change', function () { selectStop(sel.value, true); });
    /* 키 입력마다 API 호출·지도 이동이 일어나지 않게 잠깐 모아서 처리합니다 */
    if (search) {
      var debounceTimer = null;
      search.addEventListener('input', function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () { refreshStopOptions(search.value); }, 250);
      });
    }
  }

  /** focus 가 참이면 지도도 그 정류장이 화면 중심에 오게 이동합니다 (사용자 조작에서만) */
  function selectStop(stopId, focus) {
    if (!stopId) return;
    S.selectedStopId = stopId;
    var sel = $('#stopSelect');
    sel.value = stopId;
    /* 지도에서 클릭한 정류장이 검색으로 걸러져 있으면 검색을 풀어 목록에 보이게 합니다 */
    if (sel.value !== stopId && refreshStopOptions) {
      var search = $('#stopSearch');
      if (search) search.value = '';
      refreshStopOptions('');
      sel.value = stopId;
    }
    S.map.highlightStop(stopId);
    /* 사용자가 고른 정류장이면 그 정류장이 속한 격자로 파고듭니다 —
       격자 클릭과 같은 배율로 확대되고, 그 격자의 노선·정류장만 남으며,
       검색한 정류장은 선택 표시가 붙은 채로 보입니다.
       격자를 못 찾으면(경계 밖 등) 예전처럼 정류장 중심 이동만 합니다. */
    if (focus) {
      var cid = S.map.cellOfStop && S.map.cellOfStop(stopId);
      if (cid) enterCellFocus(cid, true);
      else if (S.map.focusStop) S.map.focusStop(stopId);
    }
    api.stopProfile(stopId, S.period).then(function (p) {
      /* 느린 이전 응답이 최신 선택을 덮지 않게 합니다 */
      if (S.selectedStopId !== stopId) return;
      S.profile = p;
      drawProfile(p);
    }).catch(function (err) {
      /* 프로파일 하나 실패로 전역 에러 배너를 띄우지 않습니다 — 위젯 단위 안내만 */
      console.error(err);
      C.toast('정류장 프로파일을 불러오지 못했습니다 — ' + esc(api.humanize(err)), 'err', 5000);
    });
  }

  function drawProfile(p) {
    var hours = p.hours, B = p.boardings, A = p.alightings;
    var mid = STC.t + (STC.h - STC.t - STC.b) / 2;
    var half = (STC.h - STC.t - STC.b) / 2 - 14;
    var vmax = Math.max.apply(null, B.concat(A).concat([10]));
    var nice = Math.ceil(vmax / 50) * 50 || 50;
    var yscale = function (v) { return v / nice * half; };
    var step = (STC.w - STC.l - STC.r) / hours.length;
    var bw = Math.min(22, step - 4);
    var hx = function (hr) { return STC.l + (hr - hours[0]) * step; };
    var h = '';

    /* 현재 선택된 시간대 음영 */
    var per = (S.meta.periods || []).filter(function (x) { return x.id === S.period; })[0];
    if (per && (!per.hours || per.hours.length < 2)) per = null;   /* hours 없는 메타 방어 */
    if (per) {
      var b0 = per.hours[0], b1 = Math.min(per.hours[1], hours[hours.length - 1] + 1);
      h += '<rect class="pband" x="' + hx(b0) + '" y="' + (STC.t - 4) + '" width="' +
        Math.max(0, (b1 - b0) * step) + '" height="' + (STC.h - STC.t - STC.b + 8) + '" rx="4"/>';
    }

    h += '<line class="gl" x1="' + STC.l + '" y1="' + (mid - yscale(nice)) + '" x2="' + (STC.w - STC.r) + '" y2="' + (mid - yscale(nice)) + '"/>';
    h += '<line class="gl" x1="' + STC.l + '" y1="' + (mid + yscale(nice)) + '" x2="' + (STC.w - STC.r) + '" y2="' + (mid + yscale(nice)) + '"/>';
    h += '<line class="zl" x1="' + STC.l + '" y1="' + mid + '" x2="' + (STC.w - STC.r) + '" y2="' + mid + '"/>';
    h += '<text class="tick" x="' + (STC.l - 6) + '" y="' + (mid - yscale(nice) + 3) + '" text-anchor="end">' + nice + '</text>';
    h += '<text class="tick" x="' + (STC.l - 6) + '" y="' + (mid + 3) + '" text-anchor="end">0</text>';
    h += '<text class="tick" x="' + (STC.l - 6) + '" y="' + (mid + yscale(nice) + 3) + '" text-anchor="end">' + nice + '</text>';

    var mb = 0, mbh = 0, ma = 0, mah = 0;
    B.forEach(function (v, k) { if (v > mb) { mb = v; mbh = k; } });
    A.forEach(function (v, k) { if (v > ma) { ma = v; mah = k; } });

    B.forEach(function (v, k) {
      var x = STC.l + k * step + (step - bw) / 2;
      if (v > 0) h += '<path class="stbar-b" d="' + C.barUp(x, mid - 1, bw, yscale(v)) + '"/>';
      if (A[k] > 0) h += '<path class="stbar-a" d="' + C.barDown(x, mid + 1, bw, yscale(A[k])) + '"/>';
    });
    /* 최댓값만 직접 라벨 — 모든 점에 숫자를 찍지 않습니다 */
    h += '<text class="dl2" x="' + (STC.l + mbh * step + step / 2) + '" y="' + (mid - 1 - yscale(mb) - 5) + '" text-anchor="middle">' + mb + '</text>';
    h += '<text class="dl2" x="' + (STC.l + mah * step + step / 2) + '" y="' + (mid + 1 + yscale(ma) + 12) + '" text-anchor="middle">' + ma + '</text>';

    [6, 9, 12, 15, 18, 21].forEach(function (hr) {
      if (hr < hours[0] || hr > hours[hours.length - 1]) return;
      h += '<text class="tick" x="' + (hx(hr) + step / 2) + '" y="' + (STC.h - 8) + '" text-anchor="middle">' + hr + '시</text>';
    });
    hours.forEach(function (hr, k) {
      h += '<rect class="colhit" data-hour="' + k + '" x="' + (STC.l + k * step) + '" y="' + STC.t +
        '" width="' + step + '" height="' + (STC.h - STC.t - STC.b) + '"/>';
    });

    $('#stchart').innerHTML = h;
    $('#ss1').textContent = fmt(p.summary.boardingsPerDay) + '명';
    $('#ss2').textContent = fmt(p.summary.alightingsPerDay) + '명';
    $('#ss3').textContent = p.summary.peakSharePct + '%';
    /* 실서버 프로파일의 routes 는 노선ID 목록 — 노선번호로 바꿔 보여줍니다. */
    var rn = {};
    S.routes.forEach(function (r) { rn[r.id] = r.name || r.id; });
    var rnames = (p.routes || []).map(function (id) { return rn[id] || id; });
    $('#ss4').textContent = !rnames.length ? '—'
      : rnames.length > 4 ? rnames.slice(0, 4).join(' · ') + ' 외 ' + (rnames.length - 4) + '개'
      : rnames.join(' · ') + '선';

    /* 시간대 프로파일이 추정치면 눈에 띄게 알립니다.
       교통카드 원자료는 일자별 집계라 시간대 정보가 없어, 유동인구 배율로 안분한 값입니다.
       실측인 것처럼 보이면 검증 단계에서 그대로 지적당합니다. */
    var badge = $('#stEstimated');
    if (badge) {
      badge.style.display = p.isEstimated ? '' : 'none';
      badge.title = p.isEstimated ? (p.estimationMethod || '추정치') : '';
    }

    $('#sttbl').innerHTML = '<tr><th>시각</th><th>승차</th><th>하차</th></tr>' +
      hours.map(function (hr, k) {
        return '<tr><td>' + hr + '시</td><td>' + fmt(B[k]) + '</td><td>' + fmt(A[k]) + '</td></tr>';
      }).join('');
  }

  /* =====================================================================
   * 7. 격자 데이터 표
   * =================================================================== */
  function paintCellTable() {
    var rows = S.grid.cells.slice().sort(function (a, b) { return b.mi - a.mi; }).slice(0, 40);
    $('#celltbl').innerHTML =
      '<tr><th>격자</th><th>권역</th><th>수요 D</th><th>공급 S</th><th>고령비</th><th>MI</th><th>분류</th><th>조치</th></tr>' +
      rows.map(function (c) {
        return '<tr><td>' + esc(c.id) + '</td><td>' + esc(c.name) + '</td><td>' + c.demand + '</td><td>' + c.supply +
          '</td><td>' + Math.round(c.elderlyRatio * 100) + '%</td><td>' + (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) +
          '</td><td>' + esc(c.quadrantLabel) + '</td><td>' +
          esc(c.quadrant === 'need' || c.quadrant === 'drt' ? c.actionLabel : '—') + '</td></tr>';
      }).join('');
  }

  /* =====================================================================
   * 8. 선택 연동
   * =================================================================== */
  /** focus 가 참이면 지도도 해당 위치(가까운 정류장, 없으면 격자)로 중심 이동합니다 */
  function selectCell(cellId, linkStation, focus) {
    S.selectedCellId = cellId;
    S.map.select(cellId);
    placeScatterRing();
    paintPriorities();
    var c = cellById(cellId);
    if (c) {
      var simPage = (HW.CONFIG.PAGES && HW.CONFIG.PAGES.simulation) || 'simulation.html';
      $('#simLink').href = simPage + '?cell=' + encodeURIComponent(cellId) + '&period=' + encodeURIComponent(S.period);
      $('#simLink').style.display = '';
      if (linkStation && c.nearestStopId) {
        if (c.nearestStopId !== S.selectedStopId) selectStop(c.nearestStopId, focus);
        else if (focus) S.map.focusStop(c.nearestStopId);
      } else if (focus) {
        S.map.focusCell(cellId);
      }
    }
  }

  /* =====================================================================
   * 8-1. 선택한 격자의 노선 경유 순서
   *
   * 지도만으로는 "몇 번 버스가 이 동네를 어떤 순서로 지나는가"를 못 읽습니다.
   * 선이 겹치고, 방향도 안 보이기 때문입니다. 네이버 지도 노선 화면처럼
   * 노선마다 세로선 하나에 정류장을 순서대로 꿰어 옆으로 늘어놓습니다.
   * =================================================================== */
  var BUS_SVG =
    '<svg class="bus" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="2.5" y="1.5" width="11" height="11" rx="2.2" fill="none" stroke="var(--sel)" stroke-width="1.4"/>' +
    '<rect x="4.4" y="3.6" width="7.2" height="3.6" rx="0.8" fill="var(--sel)" opacity=".35"/>' +
    '<circle cx="5.4" cy="10" r="1" fill="var(--sel)"/><circle cx="10.6" cy="10" r="1" fill="var(--sel)"/>' +
    '<path d="M4.6 12.5v1M11.4 12.5v1" stroke="var(--sel)" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg>';

  /** cellId 가 null 이면 안내 문구로 되돌립니다 */
  function renderCellRoutes(cellId) {
    var box = $('#routeStrip'), sub = $('#routeStripSub');
    if (!box) return;
    if (!cellId) {
      box.innerHTML = '<div class="empty">지도에서 격자를 클릭하면 그 격자를 지나는 ' +
        '버스와 정류장 순서가 여기에 나옵니다.</div>';
      if (sub) sub.textContent = '지도에서 격자를 클릭하면 그 격자를 지나는 버스와 정류장 순서가 나옵니다';
      return;
    }

    var cell = cellById(cellId);
    var inCell = S.map.stopsInCell(cellId);
    var idSet = {};
    inCell.forEach(function (s) { idSet[s.id] = s; });

    /* 승차량 상위 몇 곳은 점을 채워 강조 — 그 격자에서 실제로 사람이 타는 곳 */
    var busyCut = 0;
    var boards = inCell.map(function (s) { return +s.boardingsPerDay || 0; })
      .sort(function (a, b) { return b - a; });
    if (boards.length) busyCut = Math.max(1, boards[Math.floor(boards.length * 0.3)]);

    /* 노선별로 이 격자 안 정류장을 경유 순서대로 추립니다 */
    var lines = [];
    (S.routes || []).forEach(function (rt) {
      var ids = rt.stopIds || [];
      var seq = [], firstIdx = -1, lastIdx = -1;
      ids.forEach(function (id, i) {
        if (!idSet[id]) return;
        if (firstIdx < 0) firstIdx = i;
        lastIdx = i;
        seq.push(idSet[id]);
      });
      if (!seq.length) return;
      lines.push({
        name: rt.name || rt.id, n: seq.length, stops: seq,
        before: firstIdx > 0, after: lastIdx >= 0 && lastIdx < ids.length - 1
      });
    });
    /* 이 격자를 많이 지나는 노선이 먼저 — 동네 주력 노선이 왼쪽에 옵니다 */
    lines.sort(function (a, b) {
      return b.n - a.n || String(a.name).localeCompare(String(b.name), 'ko');
    });

    if (sub) {
      sub.textContent = (cell ? cell.name + ' · ' : '') +
        '정류장 ' + inCell.length + '개 · 경유 노선 ' + lines.length + '개';
    }
    if (!lines.length) {
      box.innerHTML = '<div class="empty"><b>' + esc(cell ? cell.name : cellId) + '</b><br>' +
        (inCell.length
          ? '정류장은 ' + inCell.length + '개 있지만 경유 노선 정보가 없습니다.'
          : '이 격자 안에 정류장이 없습니다.') +
        '<br><span class="mono" style="font-size:10.5px">' +
        '사각지대 후보 — 도보권 밖이거나 노선이 닿지 않는 구역입니다.</span></div>';
      return;
    }

    box.innerHTML = lines.map(function (L) {
      var items = L.stops.map(function (s) {
        var busy = (+s.boardingsPerDay || 0) >= busyCut && busyCut > 0;
        return '<li' + (busy ? ' class="busy"' : '') + ' title="' + esc(s.name) +
          ' · 일 승차 ' + fmt(Math.round(+s.boardingsPerDay || 0)) + '명">' +
          '<span class="snm">' + esc(s.name) + '</span></li>';
      }).join('');
      var tail = L.after ? '<div class="rtail">↓ 격자 밖으로 계속</div>' : '';
      var head = L.before ? '<div class="rtail" style="padding-bottom:2px">↑ 격자 밖에서 진입</div>' : '';
      return '<div class="rline">' +
        '<div class="rhead">' + BUS_SVG + '<span class="rno">' + esc(L.name) + '</span>' +
        '<span class="rkind">' + L.n + '개 정차</span></div>' +
        head + '<ul class="rstops">' + items + '</ul>' + tail +
        '</div>';
    }).join('');
  }

  /** 격자 하나로 파고듭니다 — 확대 + 그 격자의 정류장·노선만 + 경유 순서 카드
   *
   *  keepStop 이 참이면 지금 선택된 정류장을 그대로 둡니다. 정류장을 검색해서
   *  그 격자로 들어가는 흐름에서 필요합니다 — 기본값(거짓)이면 selectCell 이
   *  격자의 최근접 정류장으로 선택을 바꿔 버려서, 방금 검색한 정류장이 아니라
   *  엉뚱한 정류장이 선택된 채로 화면이 뜹니다. */
  function enterCellFocus(cellId, keepStop) {
    selectCell(cellId, !keepStop);
    S.map.setCellFocus(cellId);
    S.map.focusCell(cellId);
    renderCellRoutes(cellId);
    /* setCellFocus 가 노선·정류장 DOM 을 새로 그리므로 선택 표시를 다시 얹습니다
       (map.renderRoutes 도 복원하지만, 순서에 기대지 않고 여기서도 확실히 합니다) */
    if (keepStop && S.selectedStopId) S.map.highlightStop(S.selectedStopId);
  }

  function cellTip(c) {
    var adj = c.adjusted ? '<br><span class="mono" style="color:var(--sel)">배치 효과 반영됨</span>' : '';
    var qc = c.quadrant === 'need' ? 'new' : c.quadrant === 'drt' ? 'drt' : c.quadrant === 'over' ? 'eff' : 'ok';
    return '<b>' + esc(c.name) + '</b> <span class="mono">' + esc(c.id) + '</span><br>' +
      '수요 D <b>' + c.demand + '</b> · 공급 S <b>' + c.supply + '</b> · MI <b>' +
      (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) + '</b><br>' +
      '잠재수요 ' + fmt(c.flowTripsPerDay) + '통행/일 · 고령비 <b>' + Math.round(c.elderlyRatio * 100) + '%</b><br>' +
      '<span class="tag ' + qc + '">' + esc(c.quadrantLabel) + '</span>' + adj;
  }

  /* =====================================================================
   * 8-2. 지도 검색 — 읍면동 이름 또는 격자 ID
   *
   * 우선순위 표에는 "다사6707" 같은 격자 ID 가 나오는데, 지금까지는 그게
   * 지도 어디인지 찾으려면 표를 클릭하는 수밖에 없었습니다. 반대로 "봉담읍이
   * 어디지"를 지도에서 바로 찾을 방법도 없었습니다. 둘 다 여기서 받습니다.
   * =================================================================== */
  function wireMapSearch() {
    var inp = $('#regionSearch');
    if (!inp) return;

    /* 읍면동 목록은 격자가 로드된 뒤에야 알 수 있습니다. wireControls 는
       loadPeriod 보다 먼저 도므로 여기서 미리 읽으면 빈 배열이 잡힙니다 —
       쓸 때마다 지도에서 다시 가져옵니다. */
    function regionList() {
      return (S.map.regions && S.map.regions()) || [];
    }
    /* 자동완성 목록은 처음 검색창에 들어올 때 한 번만 채웁니다 */
    var listFilled = false;
    function fillRegionList() {
      var dl = $('#regionList');
      if (!dl || listFilled) return;
      var rs = regionList();
      if (!rs.length) return;         /* 아직 격자 로드 전 — 다음 기회에 */
      dl.innerHTML = rs.map(function (r) {
        return '<option value="' + esc(r) + '"></option>';
      }).join('');
      listFilled = true;
    }
    inp.addEventListener('focus', fillRegionList);

    function go() {
      fillRegionList();
      var regions = regionList();
      var q = (inp.value || '').trim();
      if (!q) {                       /* 비우면 강조 해제 + 전체 보기 */
        if (S.focusRegion) focusRegion(null);
        S.map.zoomReset();
        return;
      }

      /* 1순위: 격자 ID 정확 일치 — 그 칸으로 바로 파고듭니다 */
      var cell = cellById(q);
      if (cell) { enterCellFocus(cell.id); return; }

      /* 2순위: 읍면동 — 정확 → 접두 → 부분 일치 순 */
      var hit = regions.filter(function (r) { return r === q; })[0] ||
                regions.filter(function (r) { return r.indexOf(q) === 0; })[0] ||
                regions.filter(function (r) { return r.indexOf(q) >= 0; })[0];
      if (hit) {
        inp.value = hit;
        /* focusRegion 은 같은 이름을 다시 주면 해제되는 토글입니다.
           검색은 언제 눌러도 "그 권역을 본다"가 되어야 하므로 먼저 풀어 둡니다. */
        if (S.focusRegion === hit) S.focusRegion = null;
        focusRegion(hit);
        S.map.setCellFocus(null);     /* 한 격자만 보던 상태면 권역 보기로 넓힙니다 */
        renderCellRoutes(null);
        S.map.zoomToRegion(hit);      /* focusRegion 은 강조만 하므로 확대는 따로 */
        return;
      }

      C.toast('“' + esc(q) + '” 에 해당하는 읍면동·격자를 찾지 못했습니다.');
    }

    inp.addEventListener('change', go);        /* 자동완성에서 고른 경우 */
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
    var btn = $('#regionGo');
    if (btn) btn.addEventListener('click', go);
  }

  /* =====================================================================
   * 9. 컨트롤 배선
   * =================================================================== */
  function wireControls() {
    $('#layers').addEventListener('click', function (e) {
      var b = e.target.closest('[data-layer]');
      if (!b) return;
      $$('#layers [data-layer]').forEach(function (x) { x.classList.toggle('on', x === b); });
      S.map.setLayer(b.getAttribute('data-layer'));
    });
    $('#tgRoute').addEventListener('click', function (e) {
      var on = e.currentTarget.classList.toggle('on');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      S.map.setShowRoutes(on);
    });
    $('#tgLabel').addEventListener('click', function (e) {
      var on = e.currentTarget.classList.toggle('on');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      S.map.setShowLabels(on);
    });
    wireMapSearch();

    $('#regionTbl').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (th) {
        var k = th.getAttribute('data-sort');
        if (regionSort.key === k) regionSort.desc = !regionSort.desc;
        else { regionSort.key = k; regionSort.desc = true; }
        paintRegions();
        return;
      }
      var tr = e.target.closest('tr[data-region]');
      if (tr) focusRegion(tr.getAttribute('data-region'));
    });

    /* 우선순위 행도 지도 클릭과 같게 — 그 격자로 확대해 노선까지 보여 줍니다 */
    $('#t10').addEventListener('click', function (e) {
      var r = e.target.closest('[data-cell]');
      if (r) enterCellFocus(r.getAttribute('data-cell'));
    });
    $('#scatter').addEventListener('mousemove', function (e) {
      var d = e.target.closest('.dot');
      if (!d) return C.hideTip();
      var c = cellById(d.getAttribute('data-cell'));
      if (c) C.showTip(cellTip(c), e);
    });
    $('#scatter').addEventListener('mouseleave', C.hideTip);
    $('#scatter').addEventListener('click', function (e) {
      var d = e.target.closest('.dot');
      if (d) selectCell(d.getAttribute('data-cell'), true);
    });
    $('#stchart').addEventListener('mousemove', function (e) {
      var col = e.target.closest('.colhit');
      if (!col || !S.profile) return C.hideTip();
      var k = +col.getAttribute('data-hour');
      C.showTip('<b>' + S.profile.hours[k] + '시</b> · 승차 <b>' + fmt(S.profile.boardings[k]) +
        '</b> · 하차 <b>' + fmt(S.profile.alightings[k]) + '</b>', e);
    });
    $('#stchart').addEventListener('mouseleave', C.hideTip);
  }

  /* 시뮬레이션 화면이 localStorage 에 저장한 최근 시나리오를 읽습니다.
     보고서에 "시나리오 포함" 옵션을 쓰기 위한 연결 고리입니다. */
  function readSavedScenario() {
    try {
      var raw = localStorage.getItem('hw.lastSimulation');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /** 데이터 품질 안내 — 무엇이 실측이고 무엇이 추정인지 */
  function renderDataQuality(meta) {
    var dq = meta.dataQuality;
    var host = $('#dataQuality');
    if (!host) return;
    if (!dq) { host.style.display = 'none'; return; }
    var est = Object.keys(dq).filter(function (k) { return dq[k].level === 'estimated'; });
    if (!est.length) { host.style.display = 'none'; return; }
    host.innerHTML = est.map(function (k) {
      var d = dq[k];
      return '<span class="dq-item"><span class="dq-badge">추정</span>' +
        esc(d.label) + ' — ' + esc(d.method || d.note || '') + '</span>';
    }).join('') +
      '<button class="help" data-help="estimated" type="button">?</button>';
    C.wireHelp(host);
  }

  function renderFooter(meta) {
    var up = $('#updatedAt'); if (up) up.textContent = meta.updatedAt || '';
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
