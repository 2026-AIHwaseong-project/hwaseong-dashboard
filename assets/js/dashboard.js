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

  /* 정류장 프로파일 전용 숫자 표기.
     일평균을 19개 시간으로 나누면 저수요 정류장은 시간당 1명 미만이 됩니다.
     fmt() 는 정수로 반올림하므로 그런 값이 전부 '0' 이 되어, 기록이 있는데도
     없는 것처럼 읽힙니다. 10 미만이면 소수 한 자리까지 보여 줍니다. */
  function fmtSm(n) { return (Math.abs(n || 0) < 10) ? C.fmt1(n) : fmt(n); }

  var S = {
    meta: null,
    period: 'am',
    periodName: '출근',
    daytype: 'wd',
    grid: null,          // { cells, kpi, ... }
    priorities: null,
    stops: [],
    routes: [],
    selectedCellId: null,
    selectedStopId: null,
    profile: null,
    focusRegion: null,
    map: null,
    kpis: {}            // 시간대별 KPI 캐시 — KPI 미니차트(kspark)용
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
        daytype: S.daytype,
        meta: S.meta,
        kpi: S.grid ? S.grid.kpi : null,
        priorities: S.priorities ? S.priorities.items : null,
        cells: S.map ? S.map.cells() : null,
        simulation: readSavedScenario()
      };
    });

    api.meta().then(function (meta) {
      S.meta = meta;
      renderPeriodTabs(meta.periods);
      renderDaytypeToggle();
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
        onCellClick: function (cell) {
          /* 같은 격자를 다시 누르면 초점을 풉니다. zoomReset 이 cellFocus 를
             지우고 onExitCellFocus 까지 부르므로 범례의 [해제] 와 같은 경로입니다. */
          if (S.map.getCellFocus && S.map.getCellFocus() === cell.id) {
            /* 재클릭은 "이 격자 그만 보기" 입니다. '노선·정류장 전체' 가 켜져
               있으면 여기서 노선 200개·정류장 2,866개가 한꺼번에 되돌아와,
               해제인데 화면이 더 복잡해집니다. 함께 끄고 버튼 상태도 맞춥니다. */
            var tg = $('#tgRoute');
            if (tg && tg.classList.contains('on')) {
              tg.classList.remove('on');
              tg.setAttribute('aria-pressed', 'false');
              S.map.setShowRoutes(false);
            }
            S.map.zoomReset();
            return;
          }
          enterCellFocus(cell.id);
        },
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
      var first = S.priorities && S.priorities.items[0];
      if (first) {
        selectCell(first.cellId, true);
        /* 경유 노선 카드도 같이 채웁니다. 예전에는 renderCellRoutes(null) 이라
           지도·Top10·산점도·프로파일은 전부 '선택됨' 인데 이 카드만 "격자를
           클릭하세요" 라고 말해, 한 화면이 서로 모순된 상태를 주장했습니다.
           확대(focusCell)는 하지 않으므로 '첫 화면은 전체 분포' 원칙은 유지됩니다. */
        renderCellRoutes(first.cellId);
      } else {
        renderCellRoutes(null);
        selectStop(S.stops[0] && S.stops[0].id);
      }
      /* 챗봇의 nav 액션으로 이 화면에 왔으면(?focus=), 기본 선택 대신 그걸 보여줍니다.
         이어서 할 액션(after)이 있으면 — 지금은 이 화면엔 해당 사례가 없지만
         앞으로 생길 수 있으니 — 같은 방식으로 소비합니다. */
      var focus = new URLSearchParams(location.search).get('focus');
      if (focus && HW.chatActions.search) HW.chatActions.search(focus);
      var pending = HW.chat && HW.chat.consumePending && HW.chat.consumePending();
      if (pending) HW.chat.runAction(pending);
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

  /* 평일/주말 전환. 시간대(4개)와 별개 축이라 토글은 따로 두되, 전환 시
     loadPeriod 를 그대로 재사용합니다 — 격자·우선순위 재요청 로직이 같습니다. */
  var DAYTYPE_LABEL = { wd: '평일', we: '주말' };
  function renderDaytypeToggle() {
    var host = $('#daytype');
    if (!host) return;
    host.innerHTML = ['wd', 'we'].map(function (dt) {
      return '<button class="pbtn' + (dt === S.daytype ? ' on' : '') + '" data-daytype="' + dt +
        '" role="tab" aria-selected="' + (dt === S.daytype) + '"><b>' + DAYTYPE_LABEL[dt] + '</b></button>';
    }).join('');
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-daytype]');
      if (!b || b.getAttribute('data-daytype') === S.daytype) return;
      S.daytype = b.getAttribute('data-daytype');
      $$('#daytype [data-daytype]').forEach(function (x) {
        var on = x.getAttribute('data-daytype') === S.daytype;
        x.classList.toggle('on', on);
        x.setAttribute('aria-selected', String(on));
      });
      loadPeriod(S.period);
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
    $('#pchip').textContent = (DAYTYPE_LABEL[S.daytype] || '') + ' · ' + (p ? (p.name + ' ' + p.label) : pid);

    return Promise.all([api.grid(pid, S.daytype), api.priorities(pid, 10, S.daytype)]).then(function (r) {
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
    /* 부팅 자리표시자 '–' 에 준 .pending(흐리게, opacity:.4) 이 실제 값이 들어온
       뒤에도 안 벗겨졌습니다 — innerHTML 교체는 텍스트만 바꿀 뿐 class 는
       그대로 두는데, "innerHTML 교체로 자동 해제된다"고 잘못 가정했던 것입니다.
       실측: 값이 '30개'로 다 채워진 뒤에도 opacity 0.4 로 흐리게 남아 있었습니다. */
    $$('.kpi .vl.pending').forEach(function (el) { el.classList.remove('pending'); });
    $('#k1').innerHTML = fmt(k.needCells) + '<small>개</small>';
    $('#k1s').textContent = '전체 ' + fmt(k.totalCells) + '개 중 ' + k.needShare + '%' +
      (top ? ' · 최우선 ' + top.name : '');

    $('#k2').innerHTML = C.fmt1(k.potentialTripsPerDay / 10000) + '<small>만 통행/일</small>';
    $('#k2s').textContent = '고수요·저공급 격자의 잠재수요 합(거주인구 기반 추정)';

    $('#k3').innerHTML = fmt(k.elderlyTripsPerDay) + '<small>통행/일</small>';
    var share = k.potentialTripsPerDay > 0 ? (100 * k.elderlyTripsPerDay / k.potentialTripsPerDay) : 0;
    $('#k3s').textContent = '사각지대 잠재수요의 ' + share.toFixed(1) + '% · 교통약자 가중 근거';

    $('#k4').innerHTML = fmt(k.drtCells) + '<small>개</small>';

    /* 요일축이 섞이면 안 됩니다 — 평일 차트에 주말 값이 끼는 사고 방지로
       저장소를 daytype 별로 나눕니다. */
    (S.kpis[S.daytype] = S.kpis[S.daytype] || {})[S.period] = k;
    prefetchKpis();
    paintKsparks();
  }

  /* ── KPI 미니 비교차트 ────────────────────────────────────────────────
     타일의 숫자는 '지금 시간대' 하나뿐이라, 그 값이 큰 건지 작은 건지
     맥락이 없었습니다. 네 시간대 값을 막대로 나란히 놓고 평균선을 그어
     "심야가 유독 높다" 같은 패턴이 타일 안에서 바로 읽히게 합니다.
     막대 클릭 = 그 시간대로 전환(탭과 같은 경로).

     다른 시간대 KPI 는 백그라운드에서 미리 받아 둡니다 — api.grid 가
     캐시라 비용은 한 번뿐이고, 덤으로 시간대 탭 전환이 즉시가 됩니다. */
  var _prefetched = {};
  function prefetchKpis() {
    if (!S.meta || _prefetched[S.daytype]) return;
    _prefetched[S.daytype] = true;
    var dt = S.daytype;
    var store = S.kpis[dt] = S.kpis[dt] || {};
    (S.meta.periods || []).forEach(function (p) {
      if (store[p.id]) return;
      api.grid(p.id, dt).then(function (g) {
        store[p.id] = g.kpi;
        /* 받는 사이 축을 바꿨으면 그 축의 페인트가 이미 책임집니다 */
        if (S.daytype === dt) paintKsparks();
      }).catch(function () { /* 실패해도 타일 숫자는 그대로 — 차트만 비웁니다 */ });
    });
  }

  /* 만 단위가 넘는 값(잠재수요)은 '3.9만' 으로 줄여 씁니다 — 9px 라벨 자리 */
  function ksFmt(v) { return v >= 10000 ? C.fmt1(v / 10000) + '만' : fmt(Math.round(v)); }

  function paintKsparks() {
    if (!S.meta) return;
    var periods = S.meta.periods || [];
    [['kc1', 'needCells', '개'],
     ['kc2', 'potentialTripsPerDay', ' 통행/일'],
     ['kc3', 'elderlyTripsPerDay', ' 통행/일'],
     ['kc4', 'drtCells', '개']].forEach(function (def) {
      var host = $('#' + def[0]);
      if (!host) return;
      host.innerHTML = C.kspark({
        periods: periods,
        values: periods.map(function (p) { var k = (S.kpis[S.daytype] || {})[p.id]; return k ? k[def[1]] : null; }),
        current: S.period,
        unit: def[2],
        fmt: ksFmt
      });
    });
    C.wireKspark($('.kpis'));
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
        tripsAll: 0, trips: 0, elderly: 0, eldSum: 0, actions: {}, topCell: null, topMi: -99
      });
      r.cells++;
      r.eldSum += c.elderlyRatio;
      /* 권역 전체 잠재수요. 아래 trips/elderly 는 사각지대 격자만 더하므로,
         사각지대가 없는 권역은 0 이 됩니다 — 29개 중 13~14개가 그렇습니다.
         그 0 을 '수요가 없다' 로 읽지 않도록 전체값을 옆에 함께 놓습니다
         (격자 90개에 DRT 후보 9개인 우정읍이 실제로는 5,063통행/일 입니다). */
      r.tripsAll += c.flowTripsPerDay;
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
    /* 열 이름에 범위를 밝힙니다. 예전에는 '잠재수요(통행/일)' 이라고만 적었는데
       실제로는 사각지대 격자만 더한 값이라, 사각지대가 없는 권역의 0 이
       '수요가 없다' 로 읽혔습니다. KPI 카드도 '사각지대 잠재수요' 라고 씁니다. */
    var head = [
      ['name', '권역', 'left'], ['cells', '격자', ''], ['need', '사각지대', ''],
      ['drt', 'DRT 후보', ''], ['tripsAll', '권역 잠재수요', ''],
      ['trips', '사각지대 잠재수요', ''],
      ['elderly', '사각지대 고령통행', ''], ['elderlyRatio', '고령비', '']
    ];
    var html = '<table class="rgtbl"><thead><tr>' +
      head.map(function (h) {
        var on = regionSort.key === h[0];
        /* click 만 위임받아 키보드로는 정렬도 권역 강조도 못 했습니다 —
           같은 화면의 Top10 은 <button> 이라 정상인데 이 표만 예외였습니다.
           WCAG 2.1.1 Keyboard(Level A). tabindex + role + aria-sort 를 얹고
           아래에서 Enter/Space 를 click 으로 넘깁니다. */
        return '<th data-sort="' + h[0] + '" class="' + (on ? 'on' : '') + '" scope="col"' +
          ' tabindex="0" role="button"' +
          ' aria-sort="' + (on ? (regionSort.desc ? 'descending' : 'ascending') : 'none') + '">' +
          esc(h[1]) + (on ? (regionSort.desc ? ' ▾' : ' ▴') : '') + '</th>';
      }).join('') + '<th scope="col">주 조치</th></tr></thead><tbody>' +
      list.map(function (r) {
        var pctBar = r.need > 0 ? (100 * r.need / maxNeed) : 0;
        return '<tr data-region="' + esc(r.name) + '" tabindex="0" role="button"' +
          ' aria-label="' + esc(r.name) + ' 권역을 지도에서 강조"' +
          (S.focusRegion === r.name ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' +
          '<td class="rg-name">' + esc(r.name) + '</td>' +
          '<td>' + fmt(r.cells) + '</td>' +
          '<td class="rg-need">' + (r.need > 0
            ? '<span class="rg-bar"><i style="width:' + pctBar.toFixed(0) + '%"></i></span><b>' + r.need + '</b>'
            : '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + (r.drt || '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + fmt(r.tripsAll) + '</td>' +
          /* 아래 두 값이 0 이라는 것은 '사각지대 격자가 없어 합계가 0' 이라는
             뜻입니다 — 자료가 빠진 것이 아닙니다. 왼쪽의 권역 잠재수요와
             나란히 두어 그 차이가 바로 읽히게 했습니다. */
          '<td>' + (r.trips ? fmt(r.trips) : '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + (r.elderly ? fmt(r.elderly) : '<span class="rg-zero">0</span>') + '</td>' +
          '<td>' + Math.round(r.elderlyRatio * 100) + '%</td>' +
          '<td>' + (r.need > 0 || r.drt > 0
            ? '<span class="tag ' + (r.action === 'DRT 검토' || r.action === 'DRT' ? 'drt' : r.action === '신설' ? 'new' : 'add') + '">' + esc(r.action) + '</span>'
            : '<span class="rg-zero">–</span>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
    $('#regionTbl').innerHTML = html;
  }

  /** 권역 행을 누르면 그 권역 격자만 지도에서 진하게 표시합니다 */
  function focusRegion(name) {
    S.focusRegion = (S.focusRegion === name) ? null : name;
    S.map.setFocusRegion(S.focusRegion);
    if (!S.focusRegion) {
      S.map.setEligible(null);
    } else {
      /* 권역을 보러 들어가면 노선·격자 초점은 끝납니다 — "봉담읍 권역을 본다" 와
         "400번만 본다" 는 같이 설 수 없습니다. 안 풀면 지도는 400번만 그린 채
         남고 카드만 바뀌어, 화면 두 곳이 서로 다른 말을 합니다.
         호출부가 아니라 **여기** 한 곳에 두는 이유 — 권역 진입구가 검색창·권역 표
         행·범례 셋이라, 호출부마다 따로 두면 이번처럼 한 곳(표 행)만 빠집니다.
         setCellFocus(null) 하나로는 안 됩니다: map.js 는 cellId 가 truthy 일 때만
         routeFocus 를 지웁니다. 둘은 동시에 안 걸리므로 걸린 쪽만 부릅니다. */
      if (S.map.getRouteFocus()) { S.map.setRouteFocus(null); renderCellRoutes(null); }
      else if (S.map.getCellFocus()) { S.map.setCellFocus(null); renderCellRoutes(null); }
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
        /* 주 숫자는 **순위를 정한 값**이어야 합니다. 예전에는 MI 를 크게 찍었는데
           정렬·막대는 priorityScore(MI⁺ × 수요규모 × 교통약자 가중)로 매겨서,
           화면에 4위 MI +1.21 다음 5위 +1.40, 9위 +0.98 다음 10위 +1.03 이
           찍혔습니다 — 위에서 아래로 읽으면 정렬이 고장난 것처럼 보입니다.
           1위를 100 으로 둔 상대 점수를 올리고 MI 는 옆에 보조로 둡니다. */
        '<span class="pscore">' + Math.round(100 * r.priorityScore / mx) +
        '<small>점</small></span>' +
        '<span class="sub2"><span>MI +' + r.mi.toFixed(2) + '</span>' +
        '<span>잠재 ' + fmt(r.flowTripsPerDay) + '통행/일</span>' +
        /* 고령비가 높을 때만 색을 씁니다 — 전부 빨강이면 색이 값을 안 나릅니다.
           20% 는 화성시 전체 고령비(약 11%)의 두 배 수준입니다. */
        '<em' + (r.elderlyRatio >= 0.2 ? ' class="hi"' : '') + '>고령 ' +
        Math.round(r.elderlyRatio * 100) + '%</em></span>' +
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
    h += '<text class="axlab" x="' + ((SC.l + SC.w - SC.r) / 2) + '" y="' + (SC.h - 10) + '" text-anchor="middle">공급지수 S (z)</text>';
    h += '<text class="axlab" transform="rotate(-90 14 ' + ((SC.t + SC.h - SC.b) / 2) + ')" x="14" y="' +
      ((SC.t + SC.h - SC.b) / 2) + '" text-anchor="middle">수요지수 D (z)</text>';

    /* 점 크기는 셀 수에 맞춰 줄입니다 — 격자 세분화(500m, ~3천 셀) 시 과밀 대응 */
    var dotR = cells.length > 1500 ? 2.2 : 3.8;
    cells.forEach(function (c) {
      h += '<circle class="dot c m' + c.bins.mi + '" data-cell="' + esc(c.id) + '" cx="' +
        sx(c.zSupply).toFixed(1) + '" cy="' + sy(c.zDemand).toFixed(1) + '" r="' + dotR + '"/>';
    });
    /* 사분면 라벨은 **점 뒤에** 그립니다. SVG 에는 z-index 가 없어 문서 순서가
       곧 쌓임 순서인데, 예전에는 라벨을 먼저 찍어 우상단 라벨이 점 무더기에
       완전히 덮였습니다 — 사분면이 셋뿐인 것처럼 보였습니다. */
    h += '<text class="qlab hot" x="' + (SC.l + 6) + '" y="' + (SC.t + 14) + '">고수요·저공급 → 증차·신설</text>';
    h += '<text class="qlab" x="' + (SC.w - SC.r - 6) + '" y="' + (SC.t + 14) + '" text-anchor="end">고수요·고공급 · 적정</text>';
    h += '<text class="qlab" x="' + (SC.l + 6) + '" y="' + (SC.h - SC.b - 8) + '">저수요·저공급 → DRT 검토</text>';
    h += '<text class="qlab" x="' + (SC.w - SC.r - 6) + '" y="' + (SC.h - SC.b - 8) + '" text-anchor="end">저수요·고공급 → 효율화</text>';
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
    var vmax = Math.max.apply(null, B.concat(A).concat([0]));
    /* 축 최댓값을 50 단위로만 올리면 저수요 정류장이 통째로 백지가 됩니다 —
       사각지대(=저수요) 격자를 파고드는 것이 이 대시보드의 주 동선인데, 그
       종착점에서 막대가 한 개도 안 그려졌습니다(시간당 최대 6명인 정류장의
       축이 50). 데이터 크기에 맞는 단계로 올립니다. */
    /* 0.5·1 부터 두는 이유: 일평균을 19개 시간으로 나누면 저수요 정류장은
       시간당 1명 미만이라, 최소 단계가 2 면 막대가 축 높이의 14% 밑으로 눌려
       사실상 안 보입니다. 평균값이므로 소수 눈금이 맞습니다. */
    var STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];
    var nice = STEPS[STEPS.length - 1];
    for (var si = 0; si < STEPS.length; si++) {
      if (STEPS[si] >= vmax) { nice = STEPS[si]; break; }
    }
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
    /* 0 이면 라벨을 찍지 않습니다 — 막대가 없는데 '0' 두 개만 떠 있으면
       데이터 없음이 아니라 렌더가 실패한 것처럼 읽힙니다. */
    /* 시간당 값이 전부 0 이면 막대가 하나도 안 그려져 렌더 실패처럼 보입니다.
       사각지대(=저수요) 격자를 파고들면 자주 만나는 상태라, 빈 그림이 아니라
       "논할 분포가 없다" 는 결과임을 그림 안에서 밝힙니다. */
    if (vmax <= 0) {
      h += '<text class="qlab" x="' + (STC.w / 2) + '" y="' + mid +
        '" text-anchor="middle">시간대별 승하차가 기록되지 않았습니다 — 분포를 논하기 어려운 규모입니다</text>';
    }
    if (mb > 0) h += '<text class="dl2" x="' + (STC.l + mbh * step + step / 2) + '" y="' + (mid - 1 - yscale(mb) - 5) + '" text-anchor="middle">' + mb + '</text>';
    if (ma > 0) h += '<text class="dl2" x="' + (STC.l + mah * step + step / 2) + '" y="' + (mid + 1 + yscale(ma) + 12) + '" text-anchor="middle">' + ma + '</text>';

    [6, 9, 12, 15, 18, 21].forEach(function (hr) {
      if (hr < hours[0] || hr > hours[hours.length - 1]) return;
      h += '<text class="tick" x="' + (hx(hr) + step / 2) + '" y="' + (STC.h - 8) + '" text-anchor="middle">' + hr + '시</text>';
    });
    hours.forEach(function (hr, k) {
      h += '<rect class="colhit" data-hour="' + k + '" x="' + (STC.l + k * step) + '" y="' + STC.t +
        '" width="' + step + '" height="' + (STC.h - STC.t - STC.b) + '"/>';
    });

    $('#stchart').innerHTML = h;
    $('#ss1').textContent = fmtSm(p.summary.boardingsPerDay) + '명';
    $('#ss2').textContent = fmtSm(p.summary.alightingsPerDay) + '명';
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
        return '<tr><td>' + hr + '시</td><td>' + fmtSm(B[k]) + '</td><td>' + fmtSm(A[k]) + '</td></tr>';
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

  /* 카드 제목·운행정보 칸은 두 모드가 나눠 쓰므로 전환을 한 곳에서 합니다.
     이걸 각 렌더러가 따로 하면 격자 모드로 돌아왔을 때 노선 운행정보가 남습니다. */
  function setRouteCardMode(title) {
    var h = $('#routeStripTitle'), info = $('#routeInfo');
    if (h) h.textContent = title;
    if (info && title !== null) { info.hidden = true; info.innerHTML = ''; }
  }

  /** cellId 가 null 이면 안내 문구로 되돌립니다 */
  function renderCellRoutes(cellId) {
    var box = $('#routeStrip'), sub = $('#routeStripSub');
    if (!box) return;
    setRouteCardMode('이 격자를 지나는 노선');
    box.classList.remove('routemode');
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
        id: rt.id,                       /* 머리를 누르면 이 노선 전 구간으로 갑니다 */
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
        /* 값이 없을 때 "일 승차 0명" 이라고 적으면 실측 0 과 구분이 안 됩니다.
           숫자로 온 것만 수치로 적고, 없으면 자료 없음으로 둡니다 — 화면에
           나가는 수치는 전부 실측이어야 한다는 방침이 여기에도 걸립니다. */
        var b = (typeof s.boardingsPerDay === 'number' && isFinite(s.boardingsPerDay))
          ? s.boardingsPerDay : null;
        var busy = b !== null && busyCut > 0 && b >= busyCut;
        return '<li' + (busy ? ' class="busy"' : '') + ' title="' + esc(s.name) +
          ' · 일 승차 ' + (b === null ? '자료 없음' : fmt(Math.round(b)) + '명') + '">' +
          '<span class="snm">' + esc(s.name) + '</span></li>';
      }).join('');
      var tail = L.after ? '<div class="rtail">↓ 격자 밖으로 계속</div>' : '';
      var head = L.before ? '<div class="rtail" style="padding-bottom:2px">↑ 격자 밖에서 진입</div>' : '';
      /* 머리를 버튼으로 만듭니다 — 이 격자를 지나는 노선 중 하나를 골라 그 버스의
         전 구간·운행정보로 넘어가는 통로입니다. div 가 아니라 button 이라야 키보드
         Tab 으로도 닿고 Enter 로 눌립니다. */
      return '<div class="rline">' +
        '<button class="rhead rgo" type="button" data-route-id="' + esc(L.id) + '" ' +
        'title="' + esc(L.name) + '번 전 구간 보기">' +
        BUS_SVG + '<span class="rno">' + esc(L.name) + '</span>' +
        '<span class="rkind">' + L.n + '개 정차</span></button>' +
        head + '<ul class="rstops">' + items + '</ul>' + tail +
        '</div>';
    }).join('');
  }

  /* =====================================================================
   * 8-2. 노선 하나의 전 구간 (버스 번호로 검색했을 때)
   *
   * 위 renderCellRoutes 가 "이 격자에 몇 번이 지나는가"라면, 여기는 "그 버스가
   * 어디서 어디까지 어떻게 가는가"입니다. 정류장 목록·세로선 스타일(.rstops)과
   * 버스 아이콘은 그대로 씁니다.
   *
   * ⚠️ 노선 이용객 합계는 내지 않습니다. 정류장 승차량이 노선별로 나뉘어 있지
   *    않아서(정류장당 평균 3.3개 노선, 최대 30개) 경유 정류장 승차를 더하면
   *    전 노선 합이 실제의 10.7배가 됩니다. 정류장별 실측만 보여줍니다.
   * =================================================================== */
  var SEG = 20;   // 한 열에 담을 정류장 수. .rline 이 flex 라 열이 가로로 흐릅니다.
  /* routes.json 의 type — 05_load.py 의 route_type_str 이 내는 세 값입니다. */
  var ROUTE_TYPE_LABEL = { trunk: '일반 노선', local: '마을버스', drt: '똑버스(수요응답형)' };

  function routeById(routeId) {
    var list = S.routes || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === routeId) return list[i];
    return null;
  }

  /** 운행정보 한 칸. 값이 없으면 0 이 아니라 '자료 없음' — 원본에 실제로 결측이
      있습니다(막차 4건·출퇴근배차 16건·평시배차 27건). */
  function infoCell(label, value) {
    var has = value !== null && value !== undefined && value !== '';
    return '<div class="ri"><span class="rk">' + esc(label) + '</span>' +
      '<span class="rv' + (has ? '' : ' none') + '">' +
      (has ? esc(String(value)) : '자료 없음') + '</span></div>';
  }

  function renderRouteDetail(routeId) {
    var box = $('#routeStrip'), sub = $('#routeStripSub'), info = $('#routeInfo');
    if (!box) return;
    var rt = routeById(routeId);
    if (!rt) { renderCellRoutes(null); return; }

    setRouteCardMode(null);
    if ($('#routeStripTitle')) $('#routeStripTitle').textContent = rt.name + '번 전 구간';
    /* 방향 머리가 줄을 끊어야 해서 이 모드에서만 flex 를 감쌉니다(app.css) */
    box.classList.add('routemode');

    var ids = rt.stopIds || [];
    var byId = {};
    (S.stops || []).forEach(function (s) { byId[s.id] = s; });
    var seq = ids.map(function (id) { return byId[id]; })
                 .filter(function (s) { return !!s; });

    if (sub) {
      sub.textContent = (ROUTE_TYPE_LABEL[rt.type] || rt.type || '') +
        ' · 정류장 ' + seq.length + '개' +
        (seq.length < ids.length ? ' (좌표 확인된 것만)' : '');
    }

    if (info) {
      var hw = function (v) { return v === null || v === undefined ? null : v + '분'; };
      info.innerHTML =
        infoCell('기점 → 종점',
          rt.startStop && rt.endStop ? rt.startStop + ' → ' + rt.endStop : null) +
        infoCell('첫차 · 막차',
          rt.firstTime ? rt.firstTime + ' – ' + (rt.lastTime || '?') : null) +
        infoCell('출퇴근 배차', hw(rt.headwayPeak)) +
        infoCell('평시 배차', hw(rt.headwayOffpeak)) +
        infoCell('운수업체', rt.company);
      /* 번호는 같은데 아예 다른 노선이 4쌍 있습니다(운수업체·기종점이 전부 다름 —
         예: 9번이 제부여객 경진여객차고지→궁평항 과 오산교통 오산역→지곶동).
         검색은 그중 하나만 잡으므로, 나머지가 있다는 사실과 가는 길을 여기 답니다.
         없으면 아무것도 안 붙습니다. */
      var sibs = (S.routes || []).filter(function (x) {
        return x.name === rt.name && x.id !== rt.id;
      });
      if (sibs.length) {
        info.innerHTML += '<div class="rsib"><span class="rk">번호가 같은 다른 노선</span>' +
          sibs.map(function (x) {
            return '<button type="button" data-route-id="' + esc(x.id) + '">' +
              esc((x.startStop || '?') + ' → ' + (x.endStop || '?')) + '</button>';
          }).join('') + '</div>';
      }
      info.hidden = false;
    }

    if (!seq.length) {
      box.innerHTML = '<div class="empty">이 노선의 경유 정류장 정보가 없습니다.</div>';
      return;
    }

    /* 승차량 상위 30% 는 점을 채워 강조 — renderCellRoutes 와 같은 규칙 */
    var busyCut = 0;
    var boards = seq.map(function (s) { return +s.boardingsPerDay || 0; })
      .sort(function (a, b) { return b - a; });
    if (boards.length) busyCut = Math.max(1, boards[Math.floor(boards.length * 0.3)]);

    /* 가는 길 / 오는 길로 가릅니다. 한 노선 기록에 두 방향이 이어 담겨 있어서
       (200개 중 185개가 기점=종점) 안 가르면 같은 정류장 이름이 두 번씩 나오고
       지도에서도 선이 겹칩니다. 가르는 자리는 백엔드의 turnIdx.
       null 이면(편도·똑버스·예약제 18개) 한 덩이로 둡니다. */
    var t = rt.turnIdx;
    var legs = (t != null && t > 0 && t < seq.length - 1)
      ? [{ dir: 0, stops: seq.slice(0, t + 1), to: rt.endStop },
         { dir: 1, stops: seq.slice(t), to: rt.startStop }]
      : [{ dir: null, stops: seq, to: null }];

    var html = '';
    legs.forEach(function (leg) {
      /* 방향 머리 — 어디로 가는 구간인지. '상행/하행' 이라 쓰지 않습니다.
         그 표기는 원본(route_station.updown)에 있지만 정류장 수가 소스마다 달라
         우리 순서에 붙일 수 없었습니다. 기점·종점 이름은 실측이라 그걸 씁니다. */
      if (leg.dir !== null) {
        html += '<div class="rleg' + leg.dir + '">' +
          '<i></i>' + esc(leg.to || '반대 방향') + ' 방향' +
          '<b>' + leg.stops.length + '개</b></div>';
      }
      /* 정류장을 SEG 개씩 끊어 열로 나눕니다. 한 열에 151개를 넣으면 카드가
         세로로만 길어져 못 봅니다. 끊으면 .rstops 의 세로선도 열마다 깔끔하게
         시작·끝나므로(:first-child/:last-child) 별도 스타일이 필요 없습니다. */
      for (var i = 0; i < leg.stops.length; i += SEG) {
        var chunk = leg.stops.slice(i, i + SEG);
        var from = i + 1, to = i + chunk.length;
        var items = chunk.map(function (s, k) {
          var b = (typeof s.boardingsPerDay === 'number' && isFinite(s.boardingsPerDay))
            ? s.boardingsPerDay : null;
          var busy = b !== null && busyCut > 0 && b >= busyCut;
          /* 정류장마다 순번을 답니다. 열이 나뉘어도 20 다음이 21 로 이어지는 게
             보이면 "다른 버스인가?" 라는 의문이 생기지 않습니다. 몇 번째 정류장
             인지 자체도 쓸모가 있습니다. */
          return '<li' + (busy ? ' class="busy"' : '') + ' title="' + esc(s.name) +
            ' · 일 승차 ' + (b === null ? '자료 없음' : fmt(Math.round(b)) + '명') + '">' +
            '<span class="sno">' + (i + k + 1) + '</span>' +
            '<span class="snm">' + esc(s.name) + '</span></li>';
        }).join('');
        /* ⚠️ 여기에는 버스 아이콘·번호를 달지 않습니다. 격자 모드에서는 열 하나가
           노선 하나라서 그 표시가 '버스 한 대'를 뜻하는데, 같은 표시를 한 노선의
           구간마다 붙였더니 "같은 버스인데 왜 여러 개냐"고 읽혔습니다.
           노선 번호는 카드 제목이, 방향은 위 방향 머리가 이미 말하고 있습니다. */
        html += '<div class="rline seg' +
          (leg.dir !== null ? ' d' + leg.dir : '') + '">' +
          '<div class="rhead"><span class="rseg">' + from + '–' + to + '번째</span></div>' +
          '<ul class="rstops">' + items + '</ul></div>';
      }
    });
    box.innerHTML = html;
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
    /* 페이지를 대신 스크롤하지 않습니다. 지도든 Top10 이든, 누르는 순간
       화면이 저절로 움직이면 방금 누른 대상이 시야에서 밀려나 "튀었다"고
       느껴집니다. 경유 노선 카드는 지도 바로 아래에 있으므로, 필요하면
       사용자가 스스로 내려 봅니다. */
  }

  /** 노선 하나로 들어갑니다 — 그 노선만 그리고 전 구간이 담기게 확대 + 상세 카드.
   *
   *  격자 초점은 map.setRouteFocus 가 풀어 줍니다. 여기서 selectCell 을 부르지
   *  않는 이유 — 노선은 격자 하나에 속하지 않아서 "어느 칸을 고른 상태인가"에
   *  답이 없습니다. 격자 선택은 그대로 두고 노선만 얹습니다. */
  function enterRouteFocus(routeId) {
    S.map.setRouteFocus(routeId);
    renderRouteDetail(routeId);
  }

  /* 노선 머리(격자 모드)와 '번호가 같은 다른 노선' 버튼(노선 모드) 둘 다 여기서
     받습니다. 카드는 통째로 다시 그려지므로 개별 버튼이 아니라 카드에 한 번만
     겁니다(위임). #routeStrip 이 아니라 .routecard 에 거는 이유 — 운행정보(#routeInfo)
     는 strip 밖에 있어서 strip 에 걸면 그쪽 버튼이 안 먹습니다. */
  function wireRouteStripClicks() {
    var box = document.querySelector('.routecard');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-route-id]');
      if (!b) return;
      enterRouteFocus(b.getAttribute('data-route-id'));
    });
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
    /* 정류장 이름은 1,749개(중복 제외)입니다. 같은 이름이 양방향으로 두 개씩
       있는 경우가 1,019건이라, 자동완성에는 이름만 한 번씩 올립니다.
       어느 쪽 정류장인지는 프로파일 카드의 선택 목록에서 고릅니다. */
    function stopNames() {
      if (!S.stops) return [];
      var seen = {}, out = [];
      S.stops.forEach(function (st) {
        if (seen[st.name]) return;
        seen[st.name] = 1; out.push(st.name);
      });
      return out.sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    }
    /* 자동완성 목록은 처음 검색창에 들어올 때 한 번만 채웁니다 */
    var listFilled = false;
    function fillRegionList() {
      var dl = $('#regionList');
      if (!dl || listFilled) return;
      var rs = regionList();
      if (!rs.length) return;         /* 아직 격자 로드 전 — 다음 기회에 */
      /* 버스 번호를 앞에 둡니다. datalist 는 입력과 일치하는 항목을 목록 순서대로
         보여주므로, "40" 을 쳤을 때 정류장 이름 수십 개에 400·40-1 이 묻히지
         않게 하려면 노선이 먼저 와야 합니다. */
      var routeNames = (S.routes || []).map(function (r) { return String(r.name); });
      dl.innerHTML = routeNames.concat(rs, stopNames()).map(function (r) {
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

      /* 2순위: 버스 번호 정확 일치.
         정류장보다 **먼저** 봅니다 — "400" 을 치면 400번 버스를 찾는 것이지
         이름에 400 이 든 정류장을 찾는 게 아닙니다. 반대로 부분 일치는 맨
         뒤로 미룹니다(아래) — "봉담" 같은 지역 검색이 노선명에 걸려 가로채이면
         안 되기 때문입니다. */
      var rtHit = (S.routes || []).filter(function (r) { return r.name === q; })[0];
      if (rtHit) { enterRouteFocus(rtHit.id); return; }

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
        /* 한 격자·한 노선만 보던 상태를 권역 보기로 넓히는 일은 focusRegion 이 합니다
           (권역 표 행·범례와 같은 경로를 쓰려고 그쪽에 뒀습니다). 여기서는 확대만. */
        S.map.zoomToRegion(hit);      /* focusRegion 은 강조만 하므로 확대는 따로 */
        return;
      }

      /* 3순위: 정류장 — 정확 → 접두 → 부분 일치 */
      var ql = q.toLowerCase();
      var pick = function (test) {
        return (S.stops || []).filter(function (st) { return test(st.name.toLowerCase()); });
      };
      var hits = pick(function (n) { return n === ql; });
      if (!hits.length) hits = pick(function (n) { return n.indexOf(ql) === 0; });
      if (!hits.length) hits = pick(function (n) { return n.indexOf(ql) >= 0; });
      if (hits.length) {
        inp.value = hits[0].name;
        selectStop(hits[0].id, true);      /* 지도가 그 정류장의 격자로 파고듭니다 */
        /* 같은 이름이 여러 개면(양방향 등) 선택 목록을 그 후보들로 좁혀
           반대편 정류장을 바로 고를 수 있게 합니다. */
        if (refreshStopOptions) refreshStopOptions(q);
        return;
      }

      /* 마지막: 버스 번호 부분 일치. "50" 으로 50-2·50-4 를 찾는 경우입니다.
         정확 일치(위)와 달리 여기까지 내려온 것은 읍면동·정류장에서 아무것도
         못 찾았다는 뜻이라, 노선명을 넓게 봐도 다른 검색을 가로채지 않습니다. */
      var rtPart = (S.routes || []).filter(function (r) {
        return String(r.name).toLowerCase().indexOf(ql) >= 0;
      })[0];
      if (rtPart) { inp.value = rtPart.name; enterRouteFocus(rtPart.id); return; }

      C.toast('“' + esc(q) + '” 에 해당하는 읍면동·격자·정류장·버스 번호를 찾지 못했습니다.');
    }

    inp.addEventListener('change', go);        /* 자동완성에서 고른 경우 */
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
    var btn = $('#regionGo');
    if (btn) btn.addEventListener('click', go);
  }

  /* =====================================================================
   * 8-3. 챗봇이 화면을 옮길 때 쓰는 통로
   *
   * chat.js 는 이 네 개만 부릅니다. 액션 종류가 셋뿐이라(period·layer·show)
   * 여기 노출하는 것도 그만큼입니다 — 모델에게 화면 전체를 열어 주지 않습니다.
   *
   * search 가 핵심입니다. 검색창의 go() 를 그대로 쓰므로 격자ID·버스번호·읍면동·
   * 정류장 5단 우선순위가 공짜로 따라옵니다. 못 찾으면 기존 토스트가 뜹니다.
   * =================================================================== */
  function wireChatActions() {
    HW.chatActions = {
      period: function () { return S.period; },
      setPeriod: loadPeriod,
      setLayer: function (k) {
        S.map.setLayer(k);
        /* 지도만 바꾸면 층 버튼이 이전 상태로 남아 화면이 서로 다른 말을 합니다 */
        $$('#layers [data-layer]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-layer') === k);
        });
      },
      search: function (q) {
        var inp = $('#regionSearch');
        if (!inp) return;
        inp.value = q;
        var go = $('#regionGo');
        if (go) go.click();
      },
      /* 모델이 "지금 무엇을 보고 있는지" 알아야 "이 격자는 왜 빨간가" 에 답합니다 */
      context: function () {
        var c = S.selectedCellId ? cellById(S.selectedCellId) : null;
        return {
          현재화면: '대시보드',
          시간대: S.periodName,
          지도기준: S.map ? S.map.getLayer() : null,
          선택한격자: c ? { id: c.id, name: c.name, region: c.region, mi: c.mi,
                            demand: c.demand, supply: c.supply, coverage: c.coverage,
                            수단: c.actionLabel } : null,
          선택한정류장: S.selectedStopId || null,
          보고있는노선: S.map && S.map.getRouteFocus ? S.map.getRouteFocus() : null
        };
      }
    };
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
      /* 격자를 찍어 둔 채로 켜면 map.js 의 renderRoutes 가 여전히 그 격자로만
         제한합니다(cellFocus 가 showRoutes 보다 우선 판정됨) — "전체"를 눌러도
         그 칸 밖은 안 보였습니다. 격자 초점을 풀어야 이름대로 전체가 뜹니다.
         (지역 검색이 넓혀 볼 때 쓰는 것과 같은 처리 — wireMapSearch 참고.) */
      /* 노선 초점도 같은 이유로 풀어야 합니다. setRouteFocus 가 cellFocus 를 지워 두기
         때문에, 버스 번호로 찾아 들어온 상태에서는 위 getCellFocus() 가 null 이라 이
         분기를 그냥 지나쳤고 '전체'를 눌러도 renderRoutes 가 그 노선 하나만 그렸습니다.
         둘은 동시에 걸리지 않으므로(각 setter 가 상대를 지웁니다) 하나만 부르면 됩니다. */
      if (on && (S.map.getRouteFocus() || S.map.getCellFocus())) {
        if (S.map.getRouteFocus()) S.map.setRouteFocus(null);
        else S.map.setCellFocus(null);
        renderCellRoutes(null);
      }
      S.map.setShowRoutes(on);
    });
    $('#tgLabel').addEventListener('click', function (e) {
      var on = e.currentTarget.classList.toggle('on');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      S.map.setShowLabels(on);
    });
    wireMapSearch();
    wireRouteStripClicks();
    wireChatActions();

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
    /* Enter·Space 를 click 으로 넘깁니다. 위임이라 표를 다시 그려도 유지됩니다. */
    $('#regionTbl').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target.closest('th[data-sort],tr[data-region]');
      if (!t) return;
      e.preventDefault();
      t.click();
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
      C.showTip('<b>' + S.profile.hours[k] + '시</b> · 승차 <b>' + fmtSm(S.profile.boardings[k]) +
        '</b> · 하차 <b>' + fmtSm(S.profile.alightings[k]) + '</b>', e);
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
