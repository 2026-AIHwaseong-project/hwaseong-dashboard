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

  /* 대안 비교표에서 구성을 짧게 쓰기 위한 수단 약칭 */
  var TYPE_KO = { stop: '정류장', drt: '똑버스', freq: '증편' };

  var LS_SCENARIOS = 'hw.scenarios';
  var LS_LAST = 'hw.lastSimulation';

  var S = {
    meta: null,
    period: 'am',
    daytype: 'wd',
    tool: null,
    placements: [],       // [{type, cellId, count}]
    budget: 0,
    name: '시나리오 1',
    result: null,         // 서버 시뮬레이션 결과
    map: null,
    effects: {},          // type → {label, icon, radiusKm, unitKrw}
    busy: false,
    pending: null,
    selectedCellId: null,
    recommendation: null,   // 추천 결과 원본
    recEdited: false,       // 추천안을 사용자가 손봤는지
    recStrategy: 'efficiency',  // 어떤 목적으로 고를지 (효율/약자/균형/즉시)
    recTypes: new Set(['stop', 'drt', 'freq']),  // 추천에 쓸 수단 (기본 전부 — 지금까지의 동작과 같음)
    recRegion: null,        // 추천 범위 읍면동 (null = 화성시 전체)
    area: null,             // 분석 영역 안 격자 ID Set (null = 화성시 전체)
    baseCells: {},          // 시간대별 기준선 격자 — 영역 KPI 를 다시 세는 데 씁니다
    cmpPick: [],            // [비교]로 고른 저장 시나리오 index — 최대 2개
    removeMode: false       // [빼기] 켜짐 — 지도 클릭이 놓기 대신 빼기로 동작 (모바일엔 Shift+클릭이 없음)
  };

  /* =====================================================================
   * 분석 영역
   *   지도에서 사각형을 끌어 정한 범위입니다. 서버 KPI 는 화성시 전체 기준이라
   *   영역을 정하면 그 안의 격자만으로 다시 세야 합니다(섞으면 안 됩니다).
   * =================================================================== */
  function kpiOfCells(cells) {
    var need = 0, drt = 0, total = 0, trips = 0, eld = 0;
    (cells || []).forEach(function (c) {
      if (S.area && !S.area.has(c.id)) return;
      total++;
      if (c.quadrant === 'drt') drt++;
      if (c.quadrant !== 'need') return;
      need++;
      trips += c.flowTripsPerDay || 0;
      eld += (c.flowTripsPerDay || 0) * (c.elderlyRatio || 0);
    });
    return {
      needCells: need, drtCells: drt, totalCells: total,
      needShare: total ? +(100 * need / total).toFixed(1) : 0,
      potentialTripsPerDay: Math.round(trips),
      elderlyTripsPerDay: Math.round(eld)
    };
  }

  /** 화면이 쓸 시간대별 블록. 영역이 없으면 서버 값 그대로입니다. */
  function viewPeriods() {
    if (!S.result) return [];
    if (!S.area || !S.result.cellsByPeriod) return S.result.periods;
    return S.result.periods.map(function (p) {
      var sc = S.result.cellsByPeriod[p.period], bs = S.baseCells[p.period];
      if (!sc || !bs) return p;                     /* 기준선이 아직이면 전체 값 */
      var kpi = kpiOfCells(sc), base = kpiOfCells(bs);
      return {
        period: p.period, periodName: p.periodName, kpi: kpi, baseline: base,
        delta: {
          needCells: kpi.needCells - base.needCells,
          drtCells: kpi.drtCells - base.drtCells,
          needShare: +(kpi.needShare - base.needShare).toFixed(1),
          potentialTripsPerDay: kpi.potentialTripsPerDay - base.potentialTripsPerDay,
          elderlyTripsPerDay: kpi.elderlyTripsPerDay - base.elderlyTripsPerDay
        }
      };
    });
  }

  /** 영역 KPI 에 필요한 4개 시간대 기준선 격자를 받아 둡니다(api 가 캐시). */
  function ensureBaseCells() {
    var ids = (S.meta.periods || []).map(function (p) { return p.id; });
    return Promise.all(ids.map(function (id) {
      if (S.baseCells[id]) return null;
      return api.grid(id).then(function (g) { S.baseCells[id] = g.cells; });
    }));
  }

  /* 보고서·저장용 요약본. cellsByPeriod(전 셀×4시간대, 수 MB)를 떼어냅니다.
     통째로 넘기면 AI 프롬프트가 모델 한도를 넘고 localStorage 도 금방 찹니다. */
  function slimSimulation(res) {
    if (!res) return null;
    /* periods 는 화면과 **같은 기준**으로 넘겨야 합니다. 영역이 켜져 있을 때
       context.kpi 는 영역 기준(currentPeriodBlock→viewPeriods)인데 여기만 서버
       원본(화성시 전체)을 넘기면, AI 보고서 프롬프트 한 장 안에 같은 이름의
       needCells 가 서로 다른 스코프로 두 번 들어갑니다. */
    return {
      id: res.id, name: res.name, createdAt: res.createdAt,
      placements: res.placements, cost: res.cost, budgetKrw: res.budgetKrw,
      periods: viewPeriods(), effectiveness: res.effectiveness,
      scope: S.area ? { kind: 'area', cellCount: S.area.size } : { kind: 'city' }
    };
  }

  /* =====================================================================
   * 1. 부팅
   * =================================================================== */
  function boot() {
    C.mountTopnav('simulation');
    C.initTheme();
    C.wireHelp();
    HW.report.mount();
    HW.report.setContextProvider(function () {
      return {
        period: S.period,
        daytype: S.daytype,
        meta: S.meta,
        kpi: currentPeriodBlock() ? currentPeriodBlock().kpi : null,
        priorities: null,
        cells: S.map ? S.map.cells() : null,
        simulation: slimSimulation(S.result),
        recommendation: S.recommendation
          ? { placements: S.recommendation.placements, summary: S.recommendation.summary,
              methodLabel: S.recommendation.methodLabel, methodNote: S.recommendation.methodNote,
              /* 주말 기준선에 같은 배치를 적용했을 때의 효과 — 추천이 이미 반영해 고른 것을
                 보고서 문장이 설명할 수 있도록 근거로 같이 넘깁니다. */
              weekendImpact: S.recommendation.weekendImpact || null,
              edited: S.recEdited }
          : null
      };
    });

    var q = new URLSearchParams(location.search);
    if (q.get('period')) S.period = q.get('period');

    api.meta().then(function (meta) {
      S.meta = meta;
      /* URL 의 ?period= 가 엉뚱한 값이면 탭·KPI·지도가 서로 다른 시간대를
         보게 됩니다. 메타에 없는 값은 첫 시간대로 되돌립니다. */
      var valid = (meta.periods || []).some(function (p) { return p.id === S.period; });
      if (!valid) S.period = (meta.periods && meta.periods[0] && meta.periods[0].id) || 'am';
      S.budget = (meta.cost && meta.cost.defaultBudget) || 0;
      (meta.effects || []).forEach(function (e) { S.effects[e.type] = e; });
      renderPeriodTabs(meta.periods);
      renderDaytypeToggle();
      renderToolbar(meta.effects || []);
      renderRecTypes(meta.effects || []);
      wireRecTypes();
      renderBudgetInput();
      renderFooter(meta);

      S.map = HW.createMap({
        svg: $('#map'), legend: $('#legend'), meta: meta,
        placementLegend: true,   /* 범례에 배치 기호(●◆▲) 설명도 함께 */
        /* 기본 꺼짐 — 대시보드와 같습니다. "여기 이미 정류장이 있나"가 배치
           판단의 근거인 건 맞지만, 2,866개를 늘 깔면 지도 육지 픽셀의 16.6%가
           점이 되고(우선순위 1·3·6·7위가 몰린 동탄 회랑은 30.1%) 이 화면의
           본론인 "어느 칸이 붉은가"가 통째로 덮입니다. 툴바의 [노선·정류장
           전체] 로 필요할 때 켭니다. 격자를 클릭하면 그 격자 것만 켜집니다. */
        showRoutes: false,
        onClearFocus: function () { S.map.setEligible(null); },
        onAreaChange: onAreaChange,
        onAreaDraft: onAreaDraft,
        onCellClick: onCellClick,
        onCellHover: function (cell, ev) { C.showTip(cellTip(cell), ev); },
        /* 정류장을 눌러도 그 정류장이 놓인 격자에 배치됩니다.
           "이 정류장 증편하자"가 가장 자연스러운 동작인데 예전에는 무반응이었습니다. */
        onStopClick: function (stop, cell) {
          S.map.focusStop(stop.id);
          if (cell) onCellClick(cell);
        }
      });
      return Promise.all([api.stops(), api.routes(), api.grid(S.period)]);
    }).then(function (r) {
      S.map.setData({ stops: r[0].stops, routes: r[1].routes, cells: r[2].cells, scale: r[2].scale });
      /* 부트에서 받은 격자를 기준선 창고에 적립합니다 — 저장본 검증(sanePlacements)이
         추가 요청 없이 첫 클릭부터 동작합니다. */
      S.baseCells[S.period] = r[2].cells;
      wireControls();
      renderScenarioList();
      syncSideHeight();
      wireSideHeightSync();

      var cellId = q.get('cell');
      if (cellId) {
        S.selectedCellId = cellId;
        S.map.select(cellId);
        /* 특정 격자를 보러 온 사람의 질문은 "이 지역을 어떻게 고칠까"입니다.
           추천 범위를 그 격자의 읍면동으로 기본 설정합니다(칩에서 전체로 전환 가능). */
        var fromCell = S.map.cellById(cellId);
        if (fromCell && fromCell.region) {
          S.recRegion = fromCell.region;
          S.map.zoomToRegion(fromCell.region);   /* 그 동이 화면을 채우게 확대 */
          C.toast('대시보드에서 <b>' + esc(fromCell.region) + '</b>(' + esc(cellId) +
            ') 격자를 가져왔습니다. AI 추천도 <b>' + esc(fromCell.region) + '</b> 범위로 짭니다.');
        } else {
          C.toast('대시보드에서 <b>' + esc(cellId) + '</b> 격자를 가져왔습니다. 수단을 골라 지도를 클릭하세요.');
        }
      }
      paintRecScope();
      /* 챗봇의 nav 액션이 이어서 할 일(예: recommend)을 남겨 놨으면 여기서 소비합니다.
         wireChatActions() 뒤라 HW.chatActions.recommend 가 준비돼 있습니다. */
      var pending = HW.chat && HW.chat.consumePending && HW.chat.consumePending();
      if (pending) HW.chat.runActions(pending);   /* 배열 — nav.after 가 복수일 수 있습니다 */
      /* 공유 링크(?scenario=) — 부트 직후라 로컬 배치가 없어 확인 없이 엽니다.
         실패해도 기준선 화면은 그대로 살립니다(빈 화면이 최악입니다). */
      var shareId = q.get('scenario');
      if (shareId) {
        return api.getScenario(shareId).then(function (doc) {
          applySharedScenario(doc);
        }).catch(function (err) {
          C.toast('공유 시나리오를 열지 못했습니다 — ' + esc(api.humanize(err)), 'err', 8000);
        }).then(function () { return runSim(); });
      }
      return runSim();
    }).catch(fail);
  }

  /* 사이드카드(시나리오 패널) 높이를 지도 카드에 맞춥니다 — CSS 만으로는 안 됩니다.
     그리드의 auto 행 높이는 두 아이템의 내용을 다 고려해서 정해지므로, 사이드카드가
     지도보다 길어지면 min-height:0 + overflow:auto 를 걸어도 행 자체가 그만큼
     늘어나 버립니다(실측: 배치 여러 건 추가 시 행이 982 → 1198px 로 그대로 늘어남 —
     사이드카드 안에서 넘치는 게 아니라 행 전체가 커져 '수단별 소요액' 이 밀려납니다).
     지도 높이를 직접 재서 입혀야 행이 지도 크기에 묶이고, 사이드카드는 그 안에서만
     (overflow-y:auto) 넘칩니다. */
  function syncSideHeight() {
    var map = $('.mapcard'), side = $('.sidecard');
    if (!map || !side) return;
    var mapTop = map.getBoundingClientRect().top;
    var sideTop = side.getBoundingClientRect().top;
    /* 881px 미만은 한 줄로 쌓여 사이드카드가 지도 옆이 아니라 아래로 옵니다
       (app.css @media max-width:1020px/880px). 같은 줄이 아니면(top 이 다르면)
       맞출 대상이 없으므로 원래 높이(내용 높이)로 둡니다. */
    if (Math.abs(mapTop - sideTop) > 1) { side.style.height = ''; return; }
    side.style.height = map.getBoundingClientRect().height + 'px';
  }

  /* 지도 카드 크기가 바뀔 때마다(저장 시나리오가 늘어 지도 카드가 길어지거나,
     창 크기가 바뀌어 지도 SVG 의 높이가 달라지거나) 다시 맞춥니다. 사이드카드
     자신의 내용이 느는 것은 신경 쓰지 않습니다 — 그건 고정된 높이 안에서
     overflow-y:auto 가 알아서 스크롤시킵니다. */
  function wireSideHeightSync() {
    var map = $('.mapcard');
    if (!map) return;
    /* 881px 경계를 넘나들 때도 지도 카드의 렌더 크기(폭에 따라 SVG 높이도
       바뀝니다)가 함께 바뀌므로 관찰 하나로 잡힐 '거라고 예상했는데, 헤드리스
       리사이즈로 실측해 보니 ResizeObserver 콜백이 안 불리는 경우가 있었습니다
       (탭이 그려지지 않는 자동화 환경 — map.js 의 카카오 동기화가 document.hidden
       에서 겪은 것과 같은 종류의 문제로 보입니다). window resize 를 계속
       안전망으로 겹쳐 둡니다 — syncSideHeight 는 다시 불러도 비용이 없습니다. */
    if (global.ResizeObserver) {
      new global.ResizeObserver(syncSideHeight).observe(map);
    }
    global.addEventListener('resize', syncSideHeight);
    /* 저장하지 않은 배치안을 두고 화면을 떠나려 하면 한 번 묻습니다 — 관리자
       콘솔(admin.js)의 dirty 가드와 같은 이유입니다. S.placements 는 브라우저
       메모리에만 있어서, 회의 전 마지막으로 수치 하나 확인하러 대시보드로
       넘어가면 그대로 사라집니다. */
    global.addEventListener('beforeunload', function (e) {
      if (S.placements.length > 0) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
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

  /** 이후 요청이 성공하면 에러 배너를 접습니다 */
  function clearFail() {
    var box = $('#bootError');
    if (box) box.style.display = 'none';
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

  /* 요일축 — /simulations 가 daytype 을 받아 평일/주말 기준선 중 하나로
     전부(배치 효과·KPI·지도) 다시 계산한다(server/main.py SimRequest.daytype).
     그래서 배치가 있어도 자유롭게 전환할 수 있다 — 대시보드와 같은 뜻의
     컨트롤이라 같은 모양(.pbtn)을 그대로 쓴다. */
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
      if (!b) return;
      var dt = b.getAttribute('data-daytype');
      if (dt === S.daytype) return;
      S.daytype = dt;
      $$('#daytype [data-daytype]').forEach(function (x) {
        var on = x.getAttribute('data-daytype') === S.daytype;
        x.classList.toggle('on', on);
        x.setAttribute('aria-selected', String(on));
      });
      runSim();
    });
  }

  /** 토글 버튼을 S.daytype 에 맞춥니다 — 시나리오 불러오기·공유 링크처럼
      코드가 요일을 바꾸는 경로용. renderDaytypeToggle() 을 다시 부르면
      클릭 리스너가 중복으로 쌓이므로 표시만 따로 맞춥니다. */
  function syncDaytypeTabs() {
    $$('#daytype [data-daytype]').forEach(function (x) {
      var on = x.getAttribute('data-daytype') === S.daytype;
      x.classList.toggle('on', on);
      x.setAttribute('aria-selected', String(on));
    });
  }

  /* 수단 아이콘 — 서버 meta 의 글자기호(●◆▲)는 셋 다 추상 도형이라 뜻이
     안 잡혔습니다. 각 수단의 특징을 그림으로: 정류장 = 표지판(기둥),
     똑버스 = 호출 물결이 달린 승합차, 증편 = 버스에 + 뱃지. 색은 지도
     배치 마커(pmk)와 같은 초록/파랑/주황이라 지도와 버튼이 이어집니다.
     모르는 타입이면 서버 글자기호로 되돌아갑니다. */
  var TOOL_SVG = {
    stop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="4.2" y="1.8" width="7.6" height="5.2" rx="1.2"/>' +
      '<path d="M6.3 4.4h3.4M8 7v6.2M5.2 13.2h5.6"/></svg>',
    drt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="1.6" y="5.4" width="10.6" height="5.8" rx="1.6"/>' +
      '<path d="M1.6 8.3h10.6M13.4 2.6a3.4 3.4 0 0 1 1.8 3"/>' +
      '<circle cx="4.4" cy="12.6" r="1.25"/><circle cx="9.4" cy="12.6" r="1.25"/></svg>',
    freq: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="1.6" y="6" width="9.4" height="5.4" rx="1.4"/>' +
      '<path d="M1.6 8.7h9.4M13.2 1.9v4M11.2 3.9h4"/>' +
      '<circle cx="4.2" cy="12.8" r="1.2"/><circle cx="8.6" cy="12.8" r="1.2"/></svg>'
  };
  function toolIcon(type, fallback) {
    return TOOL_SVG[type]
      ? '<i class="tico tico-' + esc(type) + '">' + TOOL_SVG[type] + '</i>'
      : '<i class="tico">' + esc(fallback || '●') + '</i>';
  }

  function renderToolbar(effects) {
    $('#tools').innerHTML = effects.map(function (e) {
      return '<button class="simtool" data-tool="' + esc(e.type) + '" type="button" aria-pressed="false">' +
        toolIcon(e.type, e.icon) + esc(e.label) + '</button>';
    }).join('');
  }

  /* 추천에 쓸 수단 — 지도 위 .simtool(수동 배치 도구, 라디오)과 헷갈리기 쉽지만
     이건 별개의 다중 선택(체크박스) 상태다. 예전엔 이 UI 자체가 없어서 [AI 추천
     배치안]이 항상 서버 기본값(3종 전부)으로 나갔는데, 증편의 파급 효과가
     정류장·똑버스보다 수십~수백 배 커서(반경 안 정류장을 공유하는 모든 격자에
     영향) 예산이 아무리 남아도 그리디가 증편만 골랐다 — "지도엔 똑버스가 많은데
     추천엔 하나도 없다"는 문의가 실제로 있었다. README §3분 데모에도 이미
     "allowedTypes:['drt']로 따로 돌리는 편이 안전하다"고 적혀 있던 우회로를,
     화면에서 직접 고를 수 있게 만든 것이다.
     즉시 착수(quick)는 서버가 무조건 정류장만 쓰므로(_greedy: strategy=='quick'
     이면 allowed_types 를 무시) 그 목적일 때는 눌러도 반영이 안 된다는 걸
     disabled 로 미리 알린다. */
  function renderRecTypes(effects) {
    var host = $('#recTypes');
    if (!host) return;
    var quick = S.recStrategy === 'quick';
    host.innerHTML = '<span class="rs-lb">추천 수단</span>' + effects.map(function (e) {
      var on = quick ? (e.type === 'stop') : S.recTypes.has(e.type);
      return '<button class="simtool' + (on ? ' on' : '') + '" data-rectype="' + esc(e.type) + '"' +
        ' type="button" aria-pressed="' + on + '"' +
        (quick ? ' disabled title="즉시 착수는 정류장만 씁니다"' : '') + '>' +
        toolIcon(e.type, e.icon) + esc(e.label) + '</button>';
    }).join('');
  }

  function wireRecTypes() {
    var host = $('#recTypes');
    if (!host) return;
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rectype]');
      if (!b || b.disabled) return;
      var t = b.getAttribute('data-rectype');
      if (S.recTypes.has(t)) {
        /* 마지막 하나까지 끄면 서버가 400("allowedTypes 가 비어 있습니다")을
           내고, 그 앞에 즉시 착수처럼 "왜 추천이 하나도 안 나오지" 상태가 된다.
           끄기 전에 막는 게 요청 자체를 보내고 실패를 보여주는 것보다 낫다. */
        if (S.recTypes.size === 1) { C.toast('적어도 하나는 켜져 있어야 합니다.'); return; }
        S.recTypes.delete(t);
      } else {
        S.recTypes.add(t);
      }
      renderRecTypes(Object.keys(S.effects).map(function (k) { return S.effects[k]; }));
    });
  }

  function renderBudgetInput() {
    var inp = $('#budgetInput');
    inp.value = Math.round(S.budget / 100000000);
    inp.addEventListener('change', function () {
      var v = Math.max(0, Number(inp.value) || 0);
      inp.value = v;                 /* 음수 입력이 화면에 남지 않게 클램프 값을 되씁니다 */
      S.budget = v * 100000000;
      paintBudget();
      paintPolicy();                 /* '예산 초과' 판정도 새 한도로 다시 씁니다 */
      /* 서버 결과(저장본·보고서 컨텍스트)의 budgetKrw 도 새 한도로 맞춥니다.
         안 그러면 다음 배치 변경 전까지 화면 가드와 저장본이 서로 다른 한도를 봅니다. */
      if (S.result) runSim();
    });
    $('#scenName').value = S.name;
    $('#scenName').addEventListener('input', function () { S.name = this.value || '이름 없는 시나리오'; });
  }

  /** [지정 완료] 로 영역이 확정되거나 해제됐을 때 */
  function onAreaChange(ids) {
    S.area = ids;
    setAreaMode(false);
    $('#btnAreaClear').hidden = !ids;
    /* 영역 밖에 이미 놓인 배치는 결과와 어긋나므로 뺍니다 */
    if (ids) {
      var before = S.placements.length;
      S.placements = S.placements.filter(function (p) { return ids.has(p.cellId); });
      var dropped = before - S.placements.length;
      /* 추천안에서 배치를 덜어냈으면 '사용자 수정됨' 으로 표시해야 합니다.
         안 그러면 추천 박스는 서버 요약(10건·3,000억)을 그대로 띄우는데 실제
         배치는 4건인 상태가 되고, [추천 다시 받기] 때 교체 확인도 안 뜹니다.
         removePlacement·되돌리기는 이미 같은 처리를 합니다. */
      if (dropped && S.recommendation) S.recEdited = true;
      C.toast('분석 영역 <b>' + ids.size + '칸</b>을 지정했습니다. KPI·전후 비교가 이 영역 기준으로 다시 계산됩니다.' +
        (dropped ? ' 영역 밖 배치 ' + dropped + '건은 제외했습니다.' : ''));
    } else {
      C.toast('분석 영역을 해제했습니다. 화성시 전체 기준으로 돌아갑니다.');
    }
    paintAreaChip();
    refreshEligible();
    /* 영역 KPI 는 4개 시간대 기준선 격자가 있어야 셀 수 있습니다 */
    ensureBaseCells().then(function () { return runSim(); }).catch(fail);
  }

  function setAreaMode(on) {
    var b = $('#btnArea');
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', String(!!on));
    /* 지정 중에는 이 버튼이 '취소' 가 됩니다 — 확정은 [지정 완료] 가 합니다 */
    b.textContent = on ? '취소' : '영역 지정';
    $('#btnAreaDone').hidden = !on;
    S.map.setAreaMode(!!on);
    $('#simhint').textContent = on
      ? '끌어서 여러 칸을 한 번에, 격자를 눌러 한 칸씩 넣고 뺄 수 있습니다. 다 고르면 [지정 완료]를 누르세요.'
      : '수단을 고른 뒤 지도를 클릭하면 배치됩니다 — 클릭마다 1개씩 쌓이고 Shift+클릭으로 뺍니다. KPI는 기준선 대비 즉시 재계산됩니다.';
  }

  /** 고르는 중에 개수를 버튼에 실시간으로 보여 줍니다 */
  function onAreaDraft(n) {
    var b = $('#btnAreaDone');
    if (!b) return;
    b.textContent = n ? ('지정 완료 · ' + n + '칸') : '지정 완료';
    b.disabled = !n;
  }

  /** 지금 어느 범위를 보고 있는지 추천 칩 옆에 함께 알립니다 */
  function paintAreaChip() {
    var host = $('#recScope');
    if (!host) return;
    var old = host.querySelector('.rs-area');
    if (old) old.remove();
    if (!S.area) return;
    var el = document.createElement('span');
    el.className = 'rs-area';
    el.innerHTML = '분석 영역 <b>' + S.area.size + '칸</b>';
    host.appendChild(el);
  }

  /* =====================================================================
   * 3. 배치
   * =================================================================== */
  /* 한 격자에 같은 수단을 몇 개까지 쌓는가 — 서버 _validate_placements 의
     MAX_COUNT 와 같은 값입니다. 넘겨 보내면 400 이라 여기서 먼저 막습니다. */
  var MAX_COUNT = 20;

  function onCellClick(cell, ev) {
    S.selectedCellId = cell.id;
    S.map.select(cell.id);
    paintRecScope();   /* 선택한 격자의 동으로 추천 범위를 좁힐 수 있게 칩을 갱신 */
    if (S.removeMode) { removeAtCell(cell.id); return; }
    if (!S.tool) {
      C.toast('먼저 상단에서 배치할 수단을 선택하세요.');
      return;
    }
    var idx = -1;
    for (var i = 0; i < S.placements.length; i++) {
      if (S.placements[i].type === S.tool && S.placements[i].cellId === cell.id) { idx = i; break; }
    }
    /* 클릭할 때마다 1개씩 **쌓입니다**(중복 배치). 한때 토글(다시 누르면 취소)
       이었는데, 그 방식은 한 격자에 똑버스 2대 같은 시나리오를 지도에서 짤 수
       없었습니다. 토글로 갔던 이유(방금 누른 자리에서 바로 취소)는 Shift/Alt+
       클릭 = 1개 빼기로 보존합니다 — 배치 목록의 19px × 나 [되돌리기]까지 갈
       필요가 없습니다. */
    var undo = !!(ev && (ev.shiftKey || ev.altKey));
    if (undo) {
      /* 빼기는 제약 검사를 거치지 않습니다 — 놓을 때 이미 통과한 배치이고,
         영역을 나중에 바꿨더라도 제거는 언제나 허용돼야 합니다. */
      if (idx < 0) { C.toast('이 격자에는 뺄 ' + ((S.effects[S.tool] || {}).label || '배치') + '이(가) 없습니다.'); return; }
      var p0 = S.placements[idx];
      p0.count -= 1;
      /* 괄호 주의 — `+` 가 `||` 보다 우선이라 괄호가 없으면
         `label || ('배치 취소 — …')` 로 묶입니다. label 은 항상 있으므로
         지웠는데도 수단 이름만 떠서 배치한 것처럼 읽혔습니다. */
      if (p0.count <= 0) {
        S.placements.splice(idx, 1);
        C.toast(((S.effects[p0.type] || {}).label || '배치') + ' 취소 — ' + esc(cell.name));
      } else {
        C.toast(((S.effects[p0.type] || {}).label || '배치') + ' 1개 빼기 — ' +
          esc(cell.name) + ' (남은 수량 ' + p0.count + ')');
      }
    } else {
      /* 수단별 적용 제약 확인 (규칙은 서버 모델과 같은 값을 씁니다) */
      var guardMsg = guardFor(S.tool, cell);
      if (guardMsg) { C.toast(guardMsg, 'err', 6000); return; }
      if (idx >= 0) {
        var p1 = S.placements[idx];
        if (p1.count >= MAX_COUNT) {
          C.toast('한 격자에 같은 수단은 ' + MAX_COUNT + '개까지입니다.', 'err', 5000);
          return;
        }
        p1.count += 1;
        C.toast(((S.effects[p1.type] || {}).label || '배치') + ' ×' + p1.count + ' — ' +
          esc(cell.name) + ' (Shift+클릭으로 뺍니다)');
      } else {
        S.placements.push({ type: S.tool, cellId: cell.id, cellName: cell.name, count: 1 });
      }
    }
    if (S.recommendation) S.recEdited = true;
    runSim();
  }

  /* 수단별 커버리지 하한. 서버 규칙과 같은 값을 meta.effects.coverageRange 로
     내려받아 씁니다 — 하드코딩 복제였다가 서버와 어긋나는 사고를 막기 위한 것.
     메타에 없으면 예전 상수(freq 0.5 / stop 0.15)로 폴백합니다. */
  function coverageMin(type) {
    var e = S.effects[type] || {};
    if (e.coverageRange && typeof e.coverageRange[0] === 'number') return e.coverageRange[0];
    return type === 'freq' ? 0.5 : type === 'stop' ? 0.15 : 0;
  }

  /** 수단별 적용 제약. 위반이면 안내 문구를, 아니면 null 을 돌려줍니다. */
  function guardFor(type, cell) {
    if (S.area && !S.area.has(cell.id)) {
      return '지정한 분석 영역 밖입니다. 영역 안에서만 배치할 수 있습니다. ' +
        '(영역을 바꾸려면 [영역 지정]으로 다시 끌거나 [영역 해제]를 누르세요)';
    }
    if (type === 'freq' && cell.coverage < coverageMin('freq')) {
      return '배차 증편은 기존 정류장이 도보권(약 300m) 안에 있는 격자에만 적용할 수 있습니다. ' +
        '이 격자는 정류장 도보권 밖입니다.';
    }
    if (type === 'stop' && cell.coverage < coverageMin('stop')) {
      /* coverage = 1 − 최근접 정류장 거리/600m. 0.15 는 약 510m 에 해당합니다. */
      return '정류장 신설은 기존 정류장에서 약 500m 안쪽인 격자에만 적용할 수 있습니다. ' +
        '이보다 먼 고립 지역은 노선 신설·연장 또는 똑버스 검토 대상입니다.';
    }
    return null;
  }

  /* 적용 가능한 격자를 도구를 들었을 때 미리 표시합니다.
     예전에는 찍어 봐야 알 수 있었는데, 이제 도구를 들면 지도에서 바로 구분됩니다. */
  function refreshEligible() {
    if (!S.map) return;
    if (!S.tool) { S.map.setEligible(null); return; }
    /* 똑버스는 커버리지 제약이 없어 평소엔 강조하지 않지만,
       영역을 정했으면 그 안만 배치 가능하므로 함께 표시합니다. */
    if (S.tool === 'drt' && !S.area) { S.map.setEligible(null); return; }
    var set = new Set();
    S.map.cells().forEach(function (c) { if (!guardFor(S.tool, c)) set.add(c.id); });
    var label = (S.effects[S.tool] || {}).label || S.tool;
    S.map.setEligible(set, label + '이 가능한 격자만 강조 중');
  }

  function removePlacement(i) {
    S.placements.splice(i, 1);
    if (S.recommendation) S.recEdited = true;
    runSim();
  }

  /** [빼기] 모드에서 지도 클릭 시 호출됩니다. 그 격자가 어떤 수단인지 도구로
      미리 안 골라도 되므로(뺄 땐 이미 있는 걸 없애는 것뿐), 배열 뒤에서부터
      찾아 그 격자를 참조하는 가장 나중에 쌓인 배치 1건을 count -1 합니다 —
      onCellClick 의 Shift+클릭 분기와 동일한 처리를, 도구 선택 없이도 하는 것. */
  function removeAtCell(cellId) {
    for (var i = S.placements.length - 1; i >= 0; i--) {
      if (S.placements[i].cellId !== cellId) continue;
      var p = S.placements[i];
      var label = (S.effects[p.type] || {}).label || '배치';
      p.count -= 1;
      if (p.count <= 0) {
        S.placements.splice(i, 1);
        C.toast(label + ' 취소 — ' + esc(S.map.cellById(cellId).name));
      } else {
        C.toast(label + ' 1개 빼기 (남은 수량 ' + p.count + ')');
      }
      if (S.recommendation) S.recEdited = true;
      runSim();
      return;
    }
    C.toast('이 격자에는 뺄 배치가 없습니다.');
  }

  /* =====================================================================
   * 3-2. 추천 배치안
   *   위치 선정은 서버의 최적화 알고리즘이 합니다(언어모델이 아닙니다).
   *   결과는 그대로 배치 목록에 들어가며, 사용자가 자유롭게 고칠 수 있습니다.
   * =================================================================== */
  function requestRecommendation(strategy) {
    /* 수동 배치나 사용자가 고친 추천안이 있으면 확인 없이 지우지 않습니다 */
    var manual = S.placements.some(function (p) { return !p.fromAI; });
    if (S.placements.length && (manual || S.recEdited)) {
      if (!confirm('현재 배치 ' + S.placements.length + '건이 추천안으로 교체됩니다. 계속할까요?')) return;
    }
    if (strategy) S.recStrategy = strategy;
    /* 동 범위(읍면동 하나)에서만 '지역 균형'(동별 1건 상한 = 곧 1건 추천)이
       성립하지 않아 서버와 같은 규칙으로 미리 바꿉니다. 지도 영역(S.area)은
       여러 읍면동에 걸칠 수 있어 균형이 유효합니다 — 한때 영역까지 묶어서
       바꿨더니 영역을 지정하면 지역 균형을 고를 수 없는 버그가 됐습니다.
       (영역이 있으면 region 은 아예 전송되지 않으므로 recRegion 만 봐선 안 됩니다) */
    if (!S.area && S.recRegion && S.recStrategy === 'balance') S.recStrategy = 'efficiency';
    /* 목적 전환으로 quick 여부가 바뀌었을 수 있으니 수단 칸도 다시 그립니다
       (즉시 착수 ↔ 다른 목적 전환 시 disabled 상태가 맞아떨어져야 합니다). */
    renderRecTypes(Object.keys(S.effects).map(function (k) { return S.effects[k]; }));
    var btn = $('#btnRecommend');
    btn.disabled = true;
    btn.textContent = '계산 중…';
    $('#recBox').innerHTML = '<div class="rec-loading"><span class="spin" aria-hidden="true"></span>' +
      '예산 범위에서 효과가 가장 큰 지점을 찾고 있습니다…</div>';

    api.recommend({
      period: S.period,
      budgetKrw: S.budget,
      maxPlacements: 10,
      strategy: S.recStrategy,
      // quick 은 서버가 어차피 정류장으로 못박으니(_greedy) 그대로 알려 화면과
      // 요청이 같은 말을 하게 맞춥니다 — 실제 선택에 영향은 없습니다.
      allowedTypes: S.recStrategy === 'quick' ? ['stop'] : Array.from(S.recTypes),
      /* 지도에서 끈 영역이 있으면 그 안에서만 고릅니다(읍면동 범위보다 우선).
         영역 밖 지점을 추천하면 화면의 영역 KPI 와 어긋납니다. */
      cellIds: S.area ? Array.from(S.area) : undefined,
      region: (!S.area && S.recRegion) || undefined,   // 추천 범위 (없으면 화성시 전체)
      includeAlternatives: true    // 다른 목적으로 짜면 어떻게 되는지 함께
    }).then(function (rec) {
      if (!rec.placements.length) {
        /* 빈 추천으로 기존 작업을 덮지 않습니다 — 이전 상태를 그대로 복원 */
        btn.disabled = false;
        btn.innerHTML = HW.icon('spark') + (S.recommendation ? '추천 다시 받기' : 'AI 추천 배치안');
        paintRecBox();
        C.toast(rec.summary && rec.summary.stoppedBecause === 'budget_too_small'
          ? '예산이 최소 단가보다 작아 배치할 수 없습니다. 예산을 늘려 보세요.'
          : '현재 예산·조건에서 추천할 배치가 없습니다. 예산을 늘려 보세요.', 'err', 5000);
        return;
      }
      S.recommendation = rec;
      S.recEdited = false;
      /* 기존 배치는 교체합니다.
         영역이 켜져 있으면 응답을 한 번 더 거릅니다. cellIds 를 실어 보내지만
         그걸 모르는 백엔드는 pydantic 이 그 키를 조용히 버리므로, 그대로 받으면
         영역 밖 흐린 칸에 마커가 찍히고 예산은 전액 잡히는데 KPI 변화는 0 인
         화면이 됩니다 — 손으로 찍을 때는 "영역 밖입니다"로 막으면서 앱이 스스로
         그 규칙을 깨는 셈입니다. 서버 버전과 무관하게 불변식을 지킵니다. */
      var got = rec.placements;
      var kept = S.area ? got.filter(function (p) { return S.area.has(p.cellId); }) : got;
      if (kept.length < got.length) {
        C.toast('영역 밖 추천 ' + (got.length - kept.length) + '건을 제외했습니다 — ' +
          '서버가 영역 제한을 지원하지 않는 버전입니다.', 'err', 6000);
      }
      S.placements = kept.map(function (p) {
        return {
          type: p.type, cellId: p.cellId, cellName: p.cellName,
          count: p.count, fromAI: true, rank: p.rank, rationale: p.rationale
        };
      });
      btn.disabled = false;
      btn.innerHTML = HW.icon('spark') + '추천 다시 받기';
      /* 동 범위 추천이면 그 동으로 확대해 어디에 뭘 놓았는지 바로 보이게 합니다 */
      if (rec.region) S.map.zoomToRegion(rec.region);
      else S.map.zoomReset();
      C.toast('<b>' + esc(rec.strategyLabel || '추천') + '</b> 기준으로 <b>' +
        rec.placements.length + '건</b>을 짰습니다. 마음에 안 드는 항목은 지우셔도 됩니다.');
      runSim();
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = HW.icon('spark') + 'AI 추천 배치안';
      $('#recBox').innerHTML = '';
      C.toast('추천을 받지 못했습니다 — ' + esc(api.humanize(err)), 'err', 6000);
    });
  }

  /* 추천 범위 칩 — 어느 범위로 추천할지 버튼 위에 항상 보여 줍니다.
     대시보드에서 격자를 들고 넘어오면 그 읍면동이 기본값이 됩니다. */
  function paintRecScope() {
    var host = $('#recScope');
    if (!host) return;
    var selCell = (S.selectedCellId && S.map) ? S.map.cellById(S.selectedCellId) : null;
    var selRegion = selCell ? selCell.region : null;
    var h = '<span class="rs-lb">추천 범위</span>';
    /* 영역이 켜져 있으면 읍면동 범위는 무시됩니다(requestRecommendation 이
       region 을 undefined 로 눌러 보냅니다). 그런데도 '추천 범위 ○○동' 을
       계속 그리면 사용자는 동 범위로 나간다고 믿게 됩니다 — 실제 범위만 적습니다. */
    if (S.area) {
      host.innerHTML = h + '<b>분석 영역 ' + S.area.size + '칸</b>' +
        '<button class="rs-btn" data-scope="area-clear" type="button">영역 해제</button>';
      return;
    }
    if (S.recRegion) {
      h += '<b>' + esc(S.recRegion) + '</b>' +
        '<button class="rs-btn" data-scope="all" type="button">화성시 전체로</button>';
      if (selRegion && selRegion !== S.recRegion) {
        h += '<button class="rs-btn" data-scope="region" type="button">' + esc(selRegion) + '만</button>';
      }
    } else {
      h += '<b>화성시 전체</b>' +
        (selRegion
          ? '<button class="rs-btn" data-scope="region" type="button">' + esc(selRegion) + '만</button>'
          : '');
    }
    host.innerHTML = h;
    /* innerHTML 로 통째 교체했으니 영역 칩을 다시 붙입니다. 예전에는 이 호출이
       없어서, 영역을 지정한 뒤 아무 격자나 클릭하면(onCellClick 이 무조건
       paintRecScope 를 부릅니다) 칩이 사라진 채 돌아오지 않았습니다.
       위 S.area 분기를 타면 이미 영역을 적었으므로 여기는 안 옵니다. */
    paintAreaChip();
  }

  function paintRecBox() {
    var box = $('#recBox');
    var rec = S.recommendation;
    if (!rec) { box.innerHTML = ''; return; }
    var su = rec.summary;
    var reasonText = {
      budget_exhausted: '예산을 모두 소진해 중단',
      budget_too_small: '예산이 최소 단가보다 작아 배치 불가',
      max_reached: '요청한 건수를 채워 중단',
      no_further_gain: '더 이상 개선 효과가 없어 중단',
      no_candidate: '조건에 맞는 후보가 없음'
    }[su.stoppedBecause] || su.stoppedBecause;

    box.innerHTML =
      '<div class="rec-box">' +
      '<div class="rec-head"><span class="rec-badge">AI 추천</span>' +
      esc(rec.methodLabel) +
      (rec.region ? '<span class="rec-scope-tag">' + esc(rec.region) + '</span>' : '') +
      (S.recEdited ? '<span class="rec-edited">사용자 수정됨</span>' : '') + '</div>' +
      '<div class="rec-nums">' +
      '<span><b>' + su.count + '</b>건</span>' +
      '<span><b>' + esc(won(su.totalKrw)) + '</b> (예산의 ' + su.budgetUsedPct + '%)</span>' +
      '<span>사각지대 <b>' + fmt(su.expectedResolvedCells) + '</b>칸 해소</span>' +
      '<span>일 <b>' + fmt(su.expectedResolvedTrips) + '</b>통행</span>' +
      (su.krwPerTrip ? '<span><b>' + fmt(su.krwPerTrip) + '</b>원/통행</span>' : '') +
      '</div>' +
      '<div class="rec-note">' + esc(rec.methodNote) + ' (' + esc(reasonText) + ')</div>' +
      (su.costCompareLabel
        ? '<div class="rec-note rec-basis">비용 비교: <b>' + esc(su.costCompareLabel) + '</b> — ' +
          esc(su.costCompareNote || '') +
          '<button class="help" data-help="costBasis" type="button">?</button></div>'
        : '') +
      altTable(rec) +
      weekendImpactCard(rec) +
      producedByNote(rec) +
      '</div>';

    wireStrategyTabs(box);
    C.wireHelp(box);
  }

  /* 목적을 바꿔 다시 짜는 선택기.
     "이 안 말고 다른 안은 없나요"에 화면에서 바로 답합니다. 난수로 다른 답을
     만드는 게 아니라, 목적을 바꾸면 답이 달라지는 것을 보여줍니다.

     alternatives 는 api.js 가 이미 손질해 넘겨줍니다 — 서버는 지금 고른 목적을
     빼고 주는데(server/main.py 의 `if s == strategy: continue`), api.js 가
     현재 추천을 selected:true 로 도로 끼우고 전략 순서대로 정렬합니다.
     그래서 여기서는 네 칸을 그리기만 하면 됩니다.

     예전에는 이걸 비교표로 그렸습니다. 숫자는 읽히는데 **고르는 물건으로는
     안 보이는** 게 문제였습니다 — 누를 수 있는 건 칸 안의 점선 밑줄 글자
     하나뿐이었고, 고른 칸 표시도 9% 알파 배경이라 거의 티가 안 났습니다. */
  function altTable(rec) {
    var alts = rec.alternatives;
    if (!alts || alts.length < 2) return '';

    return '<div class="rec-alt">' +
      '<div class="rec-alt-head">어떤 목적으로 짤까요' +
        '<button class="help" data-help="strategy" type="button">?</button></div>' +
      '<div class="rec-pick" role="tablist" aria-label="추천 목적 선택">' +
      alts.map(function (a) {
        var mix = ['stop', 'drt', 'freq'].filter(function (k) { return a.mix && a.mix[k]; })
          .map(function (k) { return TYPE_KO[k] + a.mix[k]; }).join('+') || '—';
        return '<button class="rec-opt' + (a.selected ? ' is-on' : '') + '" type="button"' +
          ' role="tab" aria-selected="' + (a.selected ? 'true' : 'false') + '"' +
          (a.selected ? ' aria-current="true"' : '') +
          ' data-strategy="' + esc(a.strategy) + '">' +
          '<b>' + esc(a.label) + '</b>' +
          '<span class="rec-opt-num">' + fmt(a.count) + '건 · ' + esc(won(a.totalKrw)) + '</span>' +
          '<span class="rec-opt-mix">' + esc(mix) + '</span>' +
          '</button>';
      }).join('') +
      '</div>' +
      '<div class="rec-note">' + esc((rec.strategyNote || '') + ' ' + (rec.strategyBasisNote || '')) + '</div>' +
      '</div>';
  }

  /* 주말 영향 — 서버(_greedy)는 이미 평일+주말을 합산해 배치를 고른다
     (server/main.py "요일축" 주석 참고). 그런데 그 결과는 지금까지 화면에
     한 글자도 안 보이고 AI 보고서 프롬프트에만 조용히 실려 갔다 — 담당자가
     "이거 주말엔 어때?" 를 물어도 화면에서 답할 길이 없었다.
     시뮬레이션 자체를 평일/주말로 나누는 대신(그러려면 서버 엔진을 요일축으로
     확장해야 한다) 이미 계산돼 있는 이 결과를 카드로 꺼내는 쪽을 택했다 —
     "같은 배치 하나가 두 요일에 어떤 영향을 주는지" 를 보여주는 게 목적이라,
     쪼개서 두 개의 배치안을 만드는 것과는 다른 질문에 대한 답이다. */
  function weekendImpactCard(rec) {
    var wi = rec.weekendImpact;
    if (!wi) return '';
    var cellsWe = Math.max(0, -(wi.needCellsDelta || 0));
    var tripsWe = Math.max(0, -(wi.potentialTripsPerDayDelta || 0));
    var su = rec.summary || {};
    return '<div class="rec-alt rec-we">' +
      '<div class="rec-alt-head">주말도 함께 보면' +
        '<button class="help" data-help="weekendImpact" type="button">?</button></div>' +
      '<div class="rec-we-row"><span class="rec-we-lb">사각지대 해소</span>' +
        '<span class="rec-we-vl">평일 <b>' + fmt(su.expectedResolvedCells || 0) + '</b>칸' +
        ' · 주말 <b>' + fmt(cellsWe) + '</b>칸</span></div>' +
      '<div class="rec-we-row"><span class="rec-we-lb">해소 통행</span>' +
        '<span class="rec-we-vl">평일 <b>' + fmt(su.expectedResolvedTrips || 0) + '</b>통행/일' +
        ' · 주말 <b>' + fmt(tripsWe) + '</b>통행/일</span></div>' +
      '<div class="rec-note">' + esc(wi.note || '') + '</div>' +
      '</div>';
  }

  /* 무엇을 알고리즘이 하고 무엇을 AI 가 하는지 화면에 남깁니다.
     배치를 AI 가 고른다고 오해하면 검증 단계에서 그대로 지적당합니다. */
  function producedByNote(rec) {
    var pb = rec.producedBy;
    if (!pb) return '';
    return '<div class="rec-note rec-by">' +
      '배치 산출 <b>' + esc(pb.placements) + '</b> · 설명·보고서 <b>' + esc(pb.narrative) + '</b>' +
      (pb.deterministicNote ? '<br>' + esc(pb.deterministicNote) : '') +
      '</div>';
  }

  function wireStrategyTabs(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.rec-opt'), function (b) {
      b.addEventListener('click', function () {
        var sid = b.getAttribute('data-strategy');
        if (sid && sid !== S.recStrategy) requestRecommendation(sid);
      });
    });
  }

  function resetAll() {
    if (S.placements.length &&
        !confirm('배치 ' + S.placements.length + '건을 모두 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    S.placements = [];
    S.recommendation = null;
    S.recEdited = false;
    var btn = $('#btnRecommend');
    if (btn) btn.innerHTML = HW.icon('spark') + 'AI 추천 배치안';
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
      daytype: S.daytype,
      budgetKrw: S.budget,
      placements: S.placements.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      })
    }).then(function (res) {
      S.result = res;
      clearFail();
      try { localStorage.setItem(LS_LAST, JSON.stringify(slimSimulation(res))); } catch (e) { /* 용량 초과 등 */ }
      S.busy = false;
      setRunning(false);
      paintAll();
      if (S.pending) { S.pending = false; runSim(); }
    }).catch(function (err) {
      S.busy = false;
      setRunning(false);
      /* 진행 중 요청이 실패했는데 그사이 배치가 또 바뀌었으면(pending),
         화면과 배치 목록이 어긋난 채 남습니다. 최신 상태로 한 번 더 시도합니다. */
      var retry = S.pending;
      S.pending = false;
      fail(err);
      if (retry) runSim();
    });
  }

  function setRunning(v) {
    var el = $('#simStatus');
    if (el) el.textContent = v ? '계산 중…' : '';
    $('#btnSave').disabled = v;
  }

  function currentPeriodBlock() {
    if (!S.result) return null;
    var ps = viewPeriods();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].period === S.period) return ps[i];
    }
    return ps[0];
  }

  /* =====================================================================
   * 5. 렌더링
   * =================================================================== */
  function paintAll() {
    if (!S.result) return;
    var cells = S.result.cellsByPeriod[S.period];
    if (cells) S.map.setData({ cells: cells });
    refreshEligible();
    S.map.setPlacements(S.placements);
    if (S.selectedCellId) S.map.select(S.selectedCellId);
    paintKpi();
    paintRecBox();
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

    /* dashboard.js 와 같은 버그 — 부팅 자리표시자의 .pending(opacity:.4) 이
       innerHTML 교체로는 안 벗겨집니다(class 는 안 건드리므로). 여기서 한 번에 뗍니다. */
    $$('.kpi .vl.pending').forEach(function (el) { el.classList.remove('pending'); });

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

    var eff = S.result.effectiveness || {};
    /* 분모(해소 통행)가 한 자릿수면 단가는 배치를 한 칸만 옮겨도 몇 배로
       요동칩니다. 실제로 배치 2건에서 해소 4통행/일이 나와 18,788,767원/통행
       이라는 8자리가 화면에서 유일하게 움직인 숫자가 됐습니다 — 앞 세 타일이
       전부 '변화 없음' 이라 그게 이 배치안의 첫인상이 됐습니다.
       아래 '정책 판단 요약' 은 같은 상황을 '효과 미미' 로 헤지하는데 KPI 만
       단정적인 숫자를 내밀던 것을 맞춥니다(0 건 처리와 같은 규칙). */
    var rtrips = eff.resolvedTripsPerDay || 0;
    var MIN_TRIPS_FOR_UNIT = 10;
    $('#k4').innerHTML = (eff.krwPerTripPerDay != null && rtrips >= MIN_TRIPS_FOR_UNIT)
      ? fmt(eff.krwPerTripPerDay) + '<small>원/통행</small>'
      : '<span style="color:var(--ink3)">' + (rtrips > 0 ? '산출 보류' : '–') + '</span>';
    $('#k4d').className = 'dl';
    $('#k4d').textContent = has ? ('총 사업비 ' + won(S.result.cost.totalKrw)) : '기준선';
    /* effectiveness 는 서버가 화성시 전체로 계산한 값입니다. 바로 옆 k1~k3 은
       영역이 켜져 있으면 영역 기준이라, 표기가 없으면 서로 다른 모수의 숫자를
       나란히 읽게 됩니다("영역에 3,000억 써서 통행당 880원"). 기준을 적습니다. */
    $('#k4s').textContent = rtrips >= MIN_TRIPS_FOR_UNIT
      ? ('전 시간대 합계 ' + fmt(rtrips) + '통행 해소 기준' + (S.area ? ' · 화성시 전체' : ''))
      : (rtrips > 0
          ? ('해소 ' + fmt(rtrips) + '통행/일 — 단가를 논하기엔 표본이 작습니다')
          : '배치를 추가하면 산출됩니다');
  
    paintKsparks();
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
    /* 배치 전에는 증감줄이 이미 '기준선' 이라고 말하므로, 부제까지 '기준선 32개'
       라고 적으면 네 줄을 써서 숫자 하나를 전하게 됩니다(값 32개를 그대로 반복).
       비교 대상이 생겼을 때만 기준선 값을 함께 보여 줍니다. */
    $('#' + id + 's').textContent = (deltaVal == null) ? '' : subtext;
  }

  /* ── KPI 미니 비교차트 (dashboard.js 와 같은 컴포넌트) ────────────────
     여기 값은 viewPeriods() 를 씁니다 — 배치가 있으면 '시나리오 적용 후'
     값이라, 이 배치안이 어느 시간대를 얼마나 살리는지가 막대에도 보입니다.
     영역을 지정하면 영역 기준으로 같이 좁혀집니다(타일 숫자와 같은 모수).
     k4(해소 통행당 사업비)는 시간대 비교가 성립하지 않는 지표라 뺍니다. */
  function ksFmt(v) { return v >= 10000 ? C.fmt1(v / 10000) + '만' : fmt(Math.round(v)); }

  function paintKsparks() {
    if (!S.meta || !S.result) return;
    var periods = S.meta.periods || [];
    var byId = {};
    viewPeriods().forEach(function (p) { byId[p.period] = p; });
    [['kc1', 'needCells', '개'],
     ['kc2', 'potentialTripsPerDay', ' 통행/일'],
     ['kc3', 'elderlyTripsPerDay', ' 통행/일']].forEach(function (def) {
      var host = $('#' + def[0]);
      if (!host) return;
      host.innerHTML = C.kspark({
        periods: periods,
        values: periods.map(function (p) {
          return byId[p.id] ? byId[p.id].kpi[def[1]] : null;
        }),
        current: S.period,
        unit: def[2],
        fmt: ksFmt
      });
    });
    /* k4 는 원/통행이라 시간대 비교가 성립하지 않지만, 그 단가의 분모(해소
       통행)는 시간대별로 존재합니다 — 이 배치안이 어느 시간대를 얼마나
       살리는지를 여기 그립니다. 평균선은 뜻이 없어 끕니다. */
    var k4 = $('#kc4');
    if (k4) {
      var hasPl = S.placements.length > 0;
      k4.innerHTML = C.kspark({
        periods: periods,
        values: periods.map(function (p) {
          var b = byId[p.id];
          if (!b || !hasPl) return null;      /* 배치 전 — 값이 없다는 뜻의 '–' */
          return Math.max(0, -(b.delta.potentialTripsPerDay || 0));
        }),
        current: S.period,
        unit: ' 통행/일 해소',
        fmt: ksFmt,
        avgLine: false,
        head: hasPl ? '시간대별 해소 통행' : '배치하면 해소량이 표시됩니다'
      });
    }
    C.wireKspark($('.kpis'));
  }

  function paintPlacementList() {
    var host = $('#placeList');
    if (!S.placements.length) {
      host.innerHTML = '<div class="empty">아직 배치가 없습니다.<br>위에서 수단을 고른 뒤 지도의 격자를 클릭하세요.</div>';
      $('#btnReset').disabled = true;
      $('#btnUndo').disabled = true;
      $('#btnShare').disabled = true;   /* 빈 시나리오는 서버도 400 으로 거절합니다 */
      /* 배치가 없으면 저장할 내용도 없습니다. S.result 는 부팅 시 기준선
         계산으로 이미 차 있어서, 예전에는 눌리면 실제로 '배치 0건 · 0원 ·
         변화 없음' 짜리 빈 시나리오가 저장됐습니다 — 같은 패널의 되돌리기·
         초기화는 정확히 잠겨 있는데 저장만 열려 있어 규칙이 깨져 있었습니다. */
      $('#btnSave').disabled = true;
      return;
    }
    $('#btnReset').disabled = false;
    $('#btnUndo').disabled = false;
    $('#btnSave').disabled = false;
    $('#btnShare').disabled = false;
    /* 10건이 넘으면 스크롤 아래에 숨습니다 — 총량은 항상 위에 보여 줍니다 */
    var totalCnt = S.placements.reduce(function (a, p) { return a + p.count; }, 0);
    var totalKrw = S.placements.reduce(function (a, p) {
      return a + ((S.effects[p.type] || {}).unitKrw || 0) * p.count;
    }, 0);
    host.innerHTML = '<div class="plist-head">배치 <b>' + totalCnt + '건</b> · 합계 <b>' +
      esc(won(totalKrw)) + '</b></div>' +
      '<ul class="plist">' + S.placements.map(function (p, i) {
      var e = S.effects[p.type] || {};
      var cell = S.map.cellById(p.cellId);
      return '<li' + (p.fromAI ? ' class="from-ai"' : '') + '><span class="ic">' + toolIcon(p.type, e.icon) + '</span>' +
        '<span class="tx"><b>' + esc(e.label || p.type) + (p.count > 1 ? ' ×' + p.count : '') +
        (p.fromAI ? '<span class="ai-tag">추천 ' + p.rank + '순위</span>' : '') + '</b>' +
        '<span>' + esc(cell ? cell.name : '') + ' · ' + esc(p.cellId) + ' · 반경 ' + (e.radiusKm || '?') + 'km</span>' +
        (p.rationale ? '<span class="why">' + esc(p.rationale) + '</span>' : '') + '</span>' +
        '<span class="cost">' + won((e.unitKrw || 0) * p.count) + '</span>' +
        '<button class="del" data-remove="' + i + '" type="button" aria-label="배치 삭제">' +
        HW.icon('close', 14) + '</button></li>';
    }).join('') + '</ul>';
  }

  function paintBudget() {
    var total = S.result ? S.result.cost.totalKrw : 0;
    var ratio = S.budget > 0 ? total / S.budget : 0;
    var over = total > S.budget && S.budget > 0;
    $('#budUsed').textContent = won(total);
    $('#budTotal').textContent = won(S.budget);
    var bar = $('#budBar');
    /* 폭 대신 가로 배율로 그립니다 — 폭을 애니메이션하면 매 프레임 레이아웃을
       다시 계산합니다. 값을 여기서 직접 넣습니다(CSS 변수를 거치지 않습니다). */
    bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, ratio)).toFixed(4) + ')';
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
    var P = viewPeriods();
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
      /* 2px 간격을 두고 나란히 — 기준선(왼쪽, 빨강) / 시나리오(오른쪽, 파랑) */
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
      /* 좌상단 구석에 박혀 있어 아래 '적용 단가' 블록과 붕 떠 보였습니다.
         다른 카드의 빈 상태(가운데 정렬)와 생김새를 맞춥니다. */
      host.innerHTML = '<text class="qlab" x="' + (CS.w / 2) + '" y="' + (CS.h / 2) +
        '" text-anchor="middle">배치를 추가하면 수단별 소요액이 표시됩니다.</text>';
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

    var eff = r.effectiveness || {};
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
    /* 서버가 증감 값을 안 채워 보내는 경우가 있어 없는 값은 '–' 로 표시합니다 */
    function sgn(v, digits) {
      if (typeof v !== 'number' || !isFinite(v)) return '–';
      return (v > 0 ? '+' : '') + (digits != null ? v.toFixed(digits) : fmt(v));
    }
    $('#deltaTbl').innerHTML =
      /* 평균 MI 열은 뺐습니다. 기준통계가 시간대별 z 라 평균이 항상 ≈0 인
         항등식이어서 백엔드가 avgMi 를 응답에서 제거했고, 그대로 두면
         p.delta.avgMi 가 undefined 라 toFixed 에서 터집니다.
         대신 실제로 의미가 있는 고령 통행 증감을 보여줍니다. */
      '<tr><th>시간대</th><th>사각지대(전)</th><th>사각지대(후)</th><th>증감</th>' +
      '<th>잠재수요(전)</th><th>잠재수요(후)</th><th>증감</th><th>고령 통행 증감</th></tr>' +
      viewPeriods().map(function (p) {
        var d = p.delta || {};
        return '<tr><td>' + esc(p.periodName) + '</td>' +
          '<td>' + fmt(p.baseline.needCells) + '</td><td>' + fmt(p.kpi.needCells) + '</td>' +
          '<td>' + sgn(d.needCells) + '</td>' +
          '<td>' + fmt(p.baseline.potentialTripsPerDay) + '</td><td>' + fmt(p.kpi.potentialTripsPerDay) + '</td>' +
          '<td>' + sgn(d.potentialTripsPerDay) + '</td>' +
          '<td>' + sgn(d.elderlyTripsPerDay) + '</td></tr>';
      }).join('');
  }

  function cellTip(c) {
    var e = S.tool ? S.effects[S.tool] : null;
    var hint = e ? '<br><span class="mono" style="color:var(--sel)">클릭 → ' + esc(e.label) + ' 배치 (반경 ' + e.radiusKm + 'km)</span>' : '';
    var mi = typeof c.mi === 'number' ? (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) : '–';
    return '<b>' + esc(c.name) + '</b> <span class="mono">' + esc(c.id) + '</span><br>' +
      '수요 D <b>' + c.demand + '</b> · 공급 S <b>' + c.supply + '</b> · MI <b>' + mi + '</b><br>' +
      '잠재수요 ' + fmt(c.flowTripsPerDay) + '통행/일 · 고령비 ' + Math.round((c.elderlyRatio || 0) * 100) + '%' +
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

  /* ── 시나리오 파일 내보내기/가져오기 ─────────────────────────────────
     공유 링크(서버 저장)와 별개의 **파일 경로**입니다. localStorage 는 이
     브라우저에 갇히고 공유 링크는 서버가 살아 있어야 열립니다 — 시연 PC 이동·
     백업·오프라인 전달은 파일이 맡습니다. */
  var SCEN_FILE_FORMAT = 'hw.scenarios';

  function exportScenarios() {
    var list = loadScenarios();
    if (!list.length) {
      C.toast('내보낼 저장 시나리오가 없습니다 — 먼저 [시나리오 저장]을 누르세요.');
      return;
    }
    var doc = { format: SCEN_FILE_FORMAT, version: 1, exportedAt: C.nowStamp(),
                scenarios: list };
    C.downloadBlob(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }),
      /* toISOString 은 UTC — KST 오전 9시 이전에 내보내면 파일명만 전날이 됩니다.
         화면의 저장시각(C.nowStamp)과 같은 로컬 기준 헬퍼를 씁니다. */
      '화성-시나리오-' + C.todayISO() + '.json');
    C.toast('시나리오 <b>' + list.length + '건</b>을 파일로 내보냈습니다.');
  }

  /** 파일에서 온 항목을 저장 목록 모양으로 걸러 만듭니다. localStorage 와 같은
      신뢰 수준(사용자 소유 데이터)이지만, 형태가 깨진 항목 하나가 목록 렌더·
      불러오기를 통째로 죽이면 안 되므로 키를 화이트리스트로 옮겨 담습니다. */
  function saneImported(x) {
    if (!x || typeof x !== 'object' || !x.name || !Array.isArray(x.placements)) return null;
    var pls = x.placements.map(function (p) {
      return p && p.cellId ? {
        type: String(p.type || 'stop'), cellId: String(p.cellId),
        /* 상한 20 = 서버 MAX_COUNT — 파일을 손으로 고쳐 999 를 넣어도 400 대신 여기서 잘립니다 */
        count: Math.max(1, Math.min(20, Math.round(Number(p.count) || 1))),
        fromAI: !!p.fromAI, rank: p.rank, rationale: p.rationale
      } : null;
    }).filter(Boolean);
    if (!pls.length) return null;
    return {
      name: String(x.name).slice(0, 40),
      savedAt: typeof x.savedAt === 'string' ? x.savedAt.slice(0, 32) : C.nowStamp(),
      period: ['am', 'day', 'pm', 'night'].indexOf(x.period) >= 0 ? x.period : 'am',
      daytype: x.daytype === 'we' ? 'we' : 'wd',
      budgetKrw: Math.max(0, Math.round(Number(x.budgetKrw) || 0)),
      placements: pls,
      recommendation: (x.recommendation && typeof x.recommendation === 'object') ? x.recommendation : null,
      summary: (x.summary && typeof x.summary === 'object') ? x.summary : null
    };
  }

  function importScenarios(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var doc;
      try { doc = JSON.parse(String(rd.result)); }
      catch (e) {
        C.toast('JSON 파일이 아닙니다 — [내보내기]로 받은 파일을 고르세요.', 'err', 6000);
        return;
      }
      var arr = (doc && doc.format === SCEN_FILE_FORMAT && Array.isArray(doc.scenarios))
        ? doc.scenarios
        : (Array.isArray(doc) ? doc : null);   /* 손으로 만든 맨 배열도 받아줍니다 */
      if (!arr) {
        C.toast('시나리오 파일 형식이 아닙니다 — format: "' + SCEN_FILE_FORMAT + '" 문서나 배열이어야 합니다.', 'err', 7000);
        return;
      }
      var list = loadScenarios();
      var names = {};
      list.forEach(function (s) { names[s.name] = 1; });
      var added = 0, dup = 0, broken = 0, over = 0;
      for (var i = 0; i < arr.length; i++) {
        var s = saneImported(arr[i]);
        if (!s) { broken++; continue; }
        if (names[s.name]) { dup++; continue; }        /* 같은 이름은 기존 것을 지킵니다 */
        if (list.length >= 12) { over++; continue; }   /* 저장 상한 — 기존 것을 밀어내지 않습니다 */
        names[s.name] = 1;
        list.push(s);   /* 목록 앞자리는 이 브라우저의 최근 저장이 지킵니다 */
        added++;
      }
      if (added) saveScenarios(list);
      renderScenarioList();
      var parts = [added ? '<b>' + added + '건</b> 가져옴' : '가져온 시나리오가 없습니다'];
      if (dup) parts.push(dup + '건은 같은 이름이 있어 건너뜀');
      if (over) parts.push(over + '건은 저장 상한(12개) 초과로 제외');
      if (broken) parts.push(broken + '건은 형식이 깨져 제외');
      C.toast(parts.join(' · '), added ? null : 'err', 7000);
    };
    rd.onerror = function () { C.toast('파일을 읽지 못했습니다.', 'err', 5000); };
    rd.readAsText(file);
  }

  function saveCurrent() {
    if (!S.result) return;
    var list = loadScenarios();
    /* 같은 이름을 조용히 쌓으면 어느 카드가 최신인지 구분할 수 없습니다 */
    var dup = -1;
    list.forEach(function (s, idx) { if (dup < 0 && s.name === S.name) dup = idx; });
    if (dup >= 0) {
      if (!confirm('같은 이름 「' + S.name + '」 이(가) 이미 있습니다. 덮어쓸까요?')) {
        C.toast('이름을 바꾼 뒤 다시 저장하세요.');
        return;
      }
      list.splice(dup, 1);
    }
    if (list.length >= 12) {
      C.toast('저장은 최대 12개입니다 — 가장 오래된 <b>' +
        esc(list[list.length - 1].name) + '</b> 이(가) 삭제됩니다.', 'err', 5000);
    }
    list.unshift({
      name: S.name,
      savedAt: C.nowStamp(),
      period: S.period,
      daytype: S.daytype,      /* 요일 토글 도입 전 저장본은 이 키가 없음 → 'wd' */
      budgetKrw: S.budget,
      placements: S.placements.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count,
          fromAI: p.fromAI, rank: p.rank, rationale: p.rationale };
      }),
      /* AI 추천으로 짠 시나리오면 그 설명(rec-box)도 함께 저장합니다 — 수동
         배치였으면 애초에 S.recommendation 이 null 이라 그대로 null 로 남습니다. */
      recommendation: S.recommendation || null,
      summary: {
        costKrw: S.result.cost.totalKrw,
        resolvedTrips: (S.result.effectiveness || {}).resolvedTripsPerDay,
        krwPerTrip: (S.result.effectiveness || {}).krwPerTripPerDay,
        needDelta: (currentPeriodBlock() || {}).delta ? currentPeriodBlock().delta.needCells : 0
      }
    });
    saveScenarios(list.slice(0, 12));
    renderScenarioList();
    C.toast('시나리오 <b>' + esc(S.name) + '</b> 을(를) 저장했습니다.');
  }

  /* 시나리오는 저장 당시의 period id('am' 등)만 들고 있습니다. 목록 카드에서
     "이게 출근인지 퇴근인지"를 이름만 보고는 알 수 없었습니다 — 표시용 이름은
     meta 에서 그때그때 찾습니다(예전 저장본이라 meta 에 없는 id 면 원래 값 그대로). */
  function periodName(pid) {
    var p = ((S.meta && S.meta.periods) || []).filter(function (x) { return x.id === pid; })[0];
    return p ? p.name : (pid || '–');
  }

  /* =====================================================================
   * 시나리오 비교
   *   저장된 시나리오 2개를 같은 엔진(POST /simulations)으로 다시 계산해
   *   기준선과 나란히 놓습니다. 숫자는 전부 결정론 — AI 는 [소견 생성]을
   *   눌렀을 때 문장만 씁니다. "어느 안이 낫다"는 단정하지 않고 지표별
   *   우위만 표시합니다. 효율은 A, 교통약자는 B 가 앞설 수 있고, 그 사이의
   *   선택이 담당자의 정책 판단이기 때문입니다.
   * =================================================================== */
  function togglePick(i) {
    var at = S.cmpPick.indexOf(i);
    if (at >= 0) S.cmpPick.splice(at, 1);
    else if (S.cmpPick.length >= 2) {
      C.toast('비교는 한 번에 2개까지입니다 — 먼저 하나를 해제하세요.');
      return;
    }
    else S.cmpPick.push(i);
    $$('#scenList [data-pick]').forEach(function (b) {
      var on = S.cmpPick.indexOf(+b.getAttribute('data-pick')) >= 0;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    syncCmpBar();
  }

  function syncCmpBar() {
    var b = $('#btnCompare');
    if (b) b.hidden = S.cmpPick.length !== 2;
  }

  /** 저장본을 저장 당시 조건 그대로 다시 계산합니다(화성시 전체 기준). */
  function simOf(s) {
    return api.runSimulation({
      name: s.name,
      period: s.period || S.period,
      /* 요일축을 빼먹으면 서버가 평일(SimRequest.daytype 기본 'wd')로 계산해,
         주말 저장본이 카드 불러오기(46개)와 비교 모달(30개)에서 다른 수를
         말합니다 — 저장·불러오기·공유는 daytype 을 다루는데 비교만 빠져 있었습니다. */
      daytype: s.daytype || 'wd',
      budgetKrw: s.budgetKrw,
      placements: (s.placements || []).map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      })
    });
  }

  /* 격자 데이터셋이 개편되면서(분할격자 a~d 접미사 시절) 오래된 저장본이 지금
     없는 격자 id 를 들고 있을 수 있습니다 — 서버로 보내 400 으로 죽느니 여기서
     고치거나 뺍니다. 접미사만 떼면 지금 격자와 일치하는 배치는 옮겨 살립니다.
     (현행 786개 id 중 영문자로 끝나는 것은 없어 오인 수선 여지가 없습니다.) */
  function sanePlacements(list) {
    var valid = null;
    for (var k in S.baseCells) {
      if (S.baseCells[k] && S.baseCells[k].length) {
        valid = {};
        S.baseCells[k].forEach(function (c) { valid[c.id] = 1; });
        break;
      }
    }
    /* 검증 재료가 아직 없으면 손대지 않습니다 — 잘못 고치느니 그대로 보냅니다 */
    if (!valid) return { placements: list || [], repaired: 0, dropped: 0 };
    var out = [], repaired = 0, dropped = 0;
    (list || []).forEach(function (p) {
      if (valid[p.cellId]) { out.push(p); return; }
      var fix = String(p.cellId || '').replace(/[a-z]$/i, '');
      if (fix !== p.cellId && valid[fix]) {
        var q = {};
        for (var key in p) q[key] = p[key];
        q.cellId = fix;
        out.push(q);
        repaired++;
      }
      else dropped++;
    });
    return { placements: out, repaired: repaired, dropped: dropped };
  }

  function saneNote(name, sane) {
    if (!sane.repaired && !sane.dropped) return '';
    return '<div class="cmp-warn">「' + esc(name) + '」 은 격자 개편 전 저장본입니다 — ' +
      (sane.repaired ? '배치 ' + sane.repaired + '건을 지금 격자로 옮기고 ' : '') +
      (sane.dropped ? sane.dropped + '건은 대응 격자가 없어 제외하고 ' : '') +
      '계산했습니다.</div>';
  }

  var cmpModal = null;
  function ensureCmpModal() {
    if (cmpModal) return;
    cmpModal = document.createElement('div');
    cmpModal.className = 'modal';
    cmpModal.id = 'cmp-modal';
    cmpModal.innerHTML =
      '<div class="veil" data-cmp-close></div>' +
      '<div class="sheet cmp-sheet" role="dialog" aria-modal="true" aria-label="시나리오 비교">' +
      '<header><h2>시나리오 비교</h2><span class="hs" id="cmpSub"></span><span class="sp"></span>' +
      '<button class="xbtn" data-cmp-close type="button" aria-label="닫기">' + HW.icon('close', 17) + '</button></header>' +
      '<div class="body" id="cmpBody"></div></div>';
    document.body.appendChild(cmpModal);
    cmpModal.addEventListener('click', function (e) {
      if (e.target.closest('[data-cmp-close]')) closeCmp();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && cmpModal.classList.contains('open')) closeCmp();
    });
  }
  function closeCmp() { if (cmpModal) cmpModal.classList.remove('open'); }

  function runCompare() {
    var list = loadScenarios();
    var A = list[S.cmpPick[0]], B = list[S.cmpPick[1]];
    if (!A || !B) { C.toast('비교할 시나리오 2개를 먼저 선택하세요.'); return; }
    ensureCmpModal();
    $('#cmpSub').textContent = periodName(S.period) + ' 시간대 · 화성시 전체 기준';
    $('#cmpBody').innerHTML = '<div class="empty">두 시나리오를 같은 조건으로 다시 계산하는 중…</div>';
    cmpModal.classList.add('open');
    /* 기준선 격자를 먼저 확보해야 저장본 검증(sanePlacements)이 가능합니다 —
       api.grid 가 캐시라 두 번째부터는 즉시 지나갑니다. */
    ensureBaseCells().then(function () {
      var sa = sanePlacements(A.placements), sb = sanePlacements(B.placements);
      /* 수선본으로 계산하고 표시도 수선본 기준으로 — 표의 배치 구성과 서버
         계산이 서로 다른 배치를 말하면 안 됩니다. */
      var A2 = { name: A.name, period: A.period, daytype: A.daytype,
                 budgetKrw: A.budgetKrw, placements: sa.placements };
      var B2 = { name: B.name, period: B.period, daytype: B.daytype,
                 budgetKrw: B.budgetKrw, placements: sb.placements };
      return Promise.all([simOf(A2), simOf(B2)]).then(function (r) {
        /* 기다리다 닫았으면 조용히 버립니다 — 닫힌 모달을 다시 채우지 않습니다 */
        if (!cmpModal.classList.contains('open')) return;
        paintCompare(A2, B2, r[0], r[1], saneNote(A.name, sa) + saneNote(B.name, sb));
      });
    }).catch(function (err) {
      var b = $('#cmpBody');
      if (b) b.innerHTML = '<div class="empty">비교 계산에 실패했습니다 — ' + esc(api.humanize(err)) + '</div>';
    });
  }

  function paintCompare(A, B, ra, rb, notes) {
    var pid = S.period, pn = periodName(pid);
    function blk(r) {
      return (r.periods || []).filter(function (p) { return p.period === pid; })[0] || {};
    }
    var ba = blk(ra), bb = blk(rb);
    var base = ba.baseline || {};
    var effA = ra.effectiveness || {}, effB = rb.effectiveness || {};

    function compo(s) {
      var byType = {};
      (s.placements || []).forEach(function (p) {
        byType[p.type] = (byType[p.type] || 0) + (p.count || 1);
      });
      var parts = Object.keys(byType).map(function (t) {
        return (TYPE_KO[t] || t) + ' ' + byType[t];
      });
      return (s.placements || []).length + '건' + (parts.length ? ' — ' + parts.join(' · ') : '');
    }

    /* dir: 'lo' 낮을수록 우위 · 'hi' 높을수록 우위 · null 우위 표시 없음.
       한쪽이라도 값이 없거나 동률이면 우위를 매기지 않습니다. 우위 횟수는
       tally 에 모아 위 요약 카드의 "지표 우위 n개"가 됩니다. */
    var tally = { a: 0, b: 0 };
    function row(label, baseVal, aVal, bVal, dir, f, unit) {
      var win = null;
      if (dir && aVal != null && bVal != null && aVal !== bVal) {
        win = ((dir === 'lo') === (aVal < bVal)) ? 'a' : 'b';
        tally[win]++;
      }
      /* 기준선 대비 증감 칩(▼ 12) — "30에서 18이면 얼마나 좋아진 거지"를
         읽는 사람이 암산하지 않게 합니다. 개선 방향이면 초록, 악화면 빨강. */
      function chip(v) {
        if (!dir || baseVal == null || v == null) return '';
        var d = v - baseVal;
        if (!d) return '';
        var better = (dir === 'lo') ? d < 0 : d > 0;
        return ' <i class="dchip ' + (better ? 'good' : 'bad') + '">' +
          (d < 0 ? '▼' : '▲') + ' ' + f(Math.abs(d)) + '</i>';
      }
      return '<tr><td>' + label + '</td><td class="base">' +
        (baseVal == null ? '—' : f(baseVal) + (unit || '')) + '</td>' +
        '<td class="' + (win === 'a' ? 'win a' : '') + '">' +
        (aVal == null ? '—' : f(aVal) + (unit || '') + chip(aVal)) + '</td>' +
        '<td class="' + (win === 'b' ? 'win b' : '') + '">' +
        (bVal == null ? '—' : f(bVal) + (unit || '') + chip(bVal)) + '</td></tr>';
    }
    function sec(t) { return '<tr class="sec"><td colspan="4">' + t + '</td></tr>'; }
    function kpi(b, k) { return (b.kpi || {})[k]; }

    var warn = (A.budgetKrw !== B.budgetKrw)
      ? '<div class="cmp-warn">두 안의 설정 예산이 다릅니다(' + won(A.budgetKrw) + ' vs ' +
        won(B.budgetKrw) + ') — 총액보다 <b>해소 통행당 사업비</b>로 비교하세요.</div>'
      : '';

    var tbl = '<div class="cmp-scroll"><table class="cmp2"><thead><tr><th>지표</th><th class="base">기준선(현행)</th>' +
      '<th title="' + esc(A.name) + '"><i class="cdot a"></i>' + esc(A.name) + '</th>' +
      '<th title="' + esc(B.name) + '"><i class="cdot b"></i>' + esc(B.name) + '</th></tr></thead><tbody>' +
      sec('투입') +
      row('총 사업비', 0, (ra.cost || {}).totalKrw, (rb.cost || {}).totalKrw, null, won) +
      '<tr><td>배치 구성</td><td class="base">—</td><td class="wrapok">' + esc(compo(A)) +
      '</td><td class="wrapok">' + esc(compo(B)) + '</td></tr>' +
      sec('성과 — ' + pn + ' 시간대') +
      row('공급 부족(사각지대) 격자', base.needCells,
        kpi(ba, 'needCells'), kpi(bb, 'needCells'), 'lo', fmt, '개') +
      row('사각지대 잠재수요', base.potentialTripsPerDay,
        kpi(ba, 'potentialTripsPerDay'), kpi(bb, 'potentialTripsPerDay'), 'lo', fmt, ' 통행/일') +
      row('사각지대 고령 통행', base.elderlyTripsPerDay,
        kpi(ba, 'elderlyTripsPerDay'), kpi(bb, 'elderlyTripsPerDay'), 'lo', fmt, ' 통행/일') +
      sec('효율 — 전 시간대 합') +
      row('해소 통행량', null, effA.resolvedTripsPerDay, effB.resolvedTripsPerDay, 'hi', fmt, ' 통행/일') +
      row('해소 통행당 사업비', null, effA.krwPerTripPerDay, effB.krwPerTripPerDay, 'lo', fmt, '원') +
      '</tbody></table></div>' +
      '<p class="cmp-note">색 굵은 값 = 그 지표에서 앞서는 안(색은 안 이름의 ● 와 동일) · ' +
      '▼▲ = 기준선 대비 증감 · 숫자는 모두 같은 엔진으로 다시 계산한 값입니다.</p>';

    /* 요약 카드 — 표를 읽기 전에 결론의 뼈대(해소량·사업비·단가·우위 수)가
       보이게 합니다. tally 는 위 표를 만들며 채워졌습니다. */
    function card(nm, r, eff, n, cls) {
      var rt = eff.resolvedTripsPerDay;
      return '<div class="cmp-card ' + cls + '">' +
        '<div class="nm"><i class="cdot ' + cls + '"></i>' + esc(nm) + '</div>' +
        '<div class="big">' + (rt == null ? '—' : fmt(rt)) + '<small> 통행/일 해소</small></div>' +
        '<div class="sub">사업비 ' + won((r.cost || {}).totalKrw) +
        (eff.krwPerTripPerDay != null ? ' · 통행당 ' + fmt(eff.krwPerTripPerDay) + '원' : '') + '</div>' +
        '<div class="tag">지표 우위 ' + n + '개</div></div>';
    }
    var sum = '<div class="cmp-sum">' + card(A.name, ra, effA, tally.a, 'a') +
      '<span class="vs">vs</span>' + card(B.name, rb, effB, tally.b, 'b') + '</div>';

    /* 시간대별 사각지대 미니차트 — KPI 타일과 같은 문법(kspark)이라 따로 안 배워도 읽힙니다 */
    var mp = (S.meta && S.meta.periods) || [];
    function ks(r, nm, cls) {
      return '<div><h4 title="' + esc(nm) + '"><i class="cdot ' + cls + '"></i>' + esc(nm) + '</h4>' + C.kspark({
        periods: mp,
        values: mp.map(function (p) {
          var b2 = (r.periods || []).filter(function (x) { return x.period === p.id; })[0];
          return b2 ? (b2.kpi || {}).needCells : null;
        }),
        current: pid, unit: '개', fmt: fmt
      }) + '</div>';
    }
    var ksHtml = mp.length
      ? '<div class="cmp-diff"><h4>시간대별 사각지대 — 배치 적용 후 (개)</h4>' +
        '<div class="cmp-ks">' + ks(ra, A.name, 'a') + ks(rb, B.name, 'b') + '</div></div>'
      : '';

    /* 해소 격자 diff — 표가 "얼마나"를 말한다면 이 단락은 "어디가"를 말합니다 */
    var cellsA = (ra.cellsByPeriod || {})[pid], cellsB = (rb.cellsByPeriod || {})[pid];
    var bs = S.baseCells[pid];
    var diffHtml = '';
    if (cellsA && cellsB && bs) {
      var afterA = {}, afterB = {};
      cellsA.forEach(function (c) { afterA[c.id] = c.quadrant; });
      cellsB.forEach(function (c) { afterB[c.id] = c.quadrant; });
      var onlyA = [], onlyB = [], both = 0;
      bs.forEach(function (c) {
        if (c.quadrant !== 'need') return;
        var a = afterA[c.id] != null && afterA[c.id] !== 'need';
        var b2 = afterB[c.id] != null && afterB[c.id] !== 'need';
        if (a && b2) both++;
        else if (a) onlyA.push(c);
        else if (b2) onlyB.push(c);
      });
      function chips(arr) {
        if (!arr.length) return '<span class="cmp-chip">없음</span>';
        return arr.slice(0, 4).map(function (c) {
          return '<span class="cmp-chip">' + esc((c.region ? c.region + ' ' : '') + c.id) + '</span>';
        }).join('') + (arr.length > 4
          ? '<span class="cmp-chip">외 ' + (arr.length - 4) + '칸</span>' : '');
      }
      diffHtml = '<div class="cmp-diff"><h4>' + pn + ' 시간대 해소 격자 — 어디가 다른가</h4>' +
        '<div class="row"><span class="lbl">둘 다 해소</span>' + both + '칸</div>' +
        '<div class="row"><span class="lbl"><i class="cdot a"></i>' + esc(A.name) + '만</span>' + chips(onlyA) + '</div>' +
        '<div class="row"><span class="lbl"><i class="cdot b"></i>' + esc(B.name) + '만</span>' + chips(onlyB) + '</div></div>';
    }

    var aiHtml = '<div class="cmp-ai">' +
      '<button class="minib" id="cmpAiBtn" type="button">' + HW.icon('spark') + 'AI 소견 생성</button>' +
      '<p class="cmp-note">위 표의 수치만 근거로 요약 소견을 씁니다 — 채택 판단은 담당자의 몫입니다.</p>' +
      '<div id="cmpAiOut"></div></div>';

    $('#cmpBody').innerHTML = (notes || '') + warn + sum + tbl + ksHtml + diffHtml + aiHtml;

    /* AI 소견에 넘길 요약 — 표에 있는 숫자 그대로, 그 이상은 주지 않습니다 */
    function pack(s, b, eff, r) {
      return {
        name: s.name, costKrw: (r.cost || {}).totalKrw, placements: compo(s),
        needCells: kpi(b, 'needCells'), potentialTripsPerDay: kpi(b, 'potentialTripsPerDay'),
        elderlyTripsPerDay: kpi(b, 'elderlyTripsPerDay'),
        resolvedTripsPerDay: eff.resolvedTripsPerDay, krwPerTripPerDay: eff.krwPerTripPerDay
      };
    }
    var model = {
      period: pn,
      baseline: {
        needCells: base.needCells,
        potentialTripsPerDay: base.potentialTripsPerDay,
        elderlyTripsPerDay: base.elderlyTripsPerDay
      },
      scenarios: [pack(A, ba, effA, ra), pack(B, bb, effB, rb)]
    };
    $('#cmpAiBtn').addEventListener('click', function () { cmpAiOpinion(model, this); });
  }

  function cmpAiOpinion(model, btn) {
    var out = $('#cmpAiOut');
    if (!out || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '생성 중…';
    api.chat({
      mode: 'help',
      period: S.period,
      messages: [{
        role: 'user',
        content: 'context.compare 는 두 배치안을 같은 엔진으로 재계산해 비교한 결과입니다. ' +
          '공무원 보고 관점에서 두 안의 차이와 상충 지점(비용 대 효과 · 교통약자)을 ' +
          '4문장 이내 소견으로 정리해 주세요. 수치는 context 에 있는 것만 쓰고, ' +
          '최종 채택 판단은 내리지 마세요.'
      }],
      context: { compare: model }
    }).then(function (r) {
      out.innerHTML = '<div class="cmp-ai-out">' +
        esc((r && r.reply) || '(빈 응답)').replace(/\n/g, '<br>') +
        '<span class="by">AI 생성 초안 — 수치 검증은 위 표 기준 · 채택 판단은 담당자</span></div>';
    }).catch(function (err) {
      out.innerHTML = '<div class="cmp-ai-out">소견을 받지 못했습니다 — ' +
        esc(api.humanize(err)) + '</div>';
    }).then(function () {
      btn.disabled = false;
      btn.innerHTML = HW.icon('spark') + 'AI 소견 생성';
    });
  }

  function renderScenarioList() {
    var list = loadScenarios();
    var host = $('#scenList');
    /* 저장·삭제로 목록 순서가 바뀌면 index 로 든 선택이 다른 카드를 가리키게
       됩니다 — 어긋난 선택으로 엉뚱한 두 안을 비교하느니 다시 고르게 합니다. */
    S.cmpPick = [];
    syncCmpBar();
    if (!list.length) {
      host.innerHTML = '<div class="empty">저장된 시나리오가 없습니다.<br>배치안을 만든 뒤 [시나리오 저장]을 누르세요.</div>';
      return;
    }
    /* 삭제 버튼을 불러오기 버튼 안에 중첩하면(HTML 위반) 키보드로 삭제할 수 없습니다.
       카드 = div, 불러오기·삭제 = 각각 실제 button 으로 분리합니다. */
    host.innerHTML = list.map(function (s, i) {
      var su = s.summary || {};   /* 구버전 저장본에 summary 가 없어도 목록이 죽지 않게 */
      return '<div class="scen">' +
        '<button class="sload" data-load="' + i + '" type="button" title="' + esc(s.name) + '">' +
        '<span class="snm">' + esc(s.name) + '</span>' +
        '<span class="smeta"><span>' + esc(s.savedAt) + '</span>' +
        '<span>' + esc(periodName(s.period)) + '</span>' +
        '<span>배치 ' + (s.placements || []).length + '건</span>' +
        '<span>' + esc(won(su.costKrw)) + '</span>' +
        '<span>' + (su.needDelta < 0 ? '사각지대 −' + Math.abs(su.needDelta) + '개' : '변화 없음') + '</span>' +
        (su.krwPerTrip != null ? '<span>' + fmt(su.krwPerTrip) + '원/통행</span>' : '') +
        '</span></button>' +
        '<button class="spick" data-pick="' + i + '" type="button" aria-pressed="false"' +
        ' aria-label="' + esc(s.name) + ' 비교 대상으로 선택">비교</button>' +
        '<button class="sdel" data-del="' + i + '" type="button" aria-label="시나리오 삭제">' +
        HW.icon('close', 14) + '</button>' +
        '</div>';
    }).join('');
  }

  /** 현재 배치를 서버에 저장하고 공유 링크를 클립보드에 복사합니다.
      [시나리오 저장](localStorage)과 별개 경로입니다 — 로컬 저장은 이 브라우저에만
      남아 다른 사람이 못 봅니다. 링크(?scenario=id)를 받은 사람은 열기만 하면
      같은 배치·예산·시간대가 복원됩니다. */
  function shareCurrent() {
    if (!S.placements.length) { C.toast('먼저 배치를 한 건 이상 놓으세요.'); return; }
    var btn = $('#btnShare');
    btn.disabled = true;
    btn.textContent = '링크 만드는 중…';
    api.saveScenario({
      name: S.name,
      period: S.period,
      daytype: S.daytype,
      budgetKrw: S.budget,
      placements: S.placements.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      })
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = '공유 링크';
      var u = new URL(location.href);
      u.searchParams.set('scenario', res.id);
      u.searchParams.delete('cell');   /* 격자 딥링크가 남으면 받은 쪽에서 안내가 두 번 뜹니다 */
      u.hash = '';
      var link = u.toString();
      function done() {
        C.toast('공유 링크를 복사했습니다 — 받는 사람은 링크만 열면 같은 배치안을 봅니다.', null, 6000);
      }
      /* 클립보드는 https·localhost 밖에서 막힐 수 있습니다 — 막히면 링크를
         직접 보여 주고 사람이 복사하게 합니다(조용히 실패하는 게 최악입니다). */
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, function () {
          window.prompt('자동 복사가 막혔습니다 — 아래 링크를 직접 복사하세요:', link);
        });
      } else {
        window.prompt('아래 링크를 복사하세요:', link);
      }
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = '공유 링크';
      C.toast('공유 링크를 만들지 못했습니다 — ' + esc(api.humanize(err)), 'err', 6000);
    });
  }

  /** 공유 링크(?scenario=)로 받은 서버 저장본을 화면에 복원합니다.
      loadScenario 와 같은 절차이되 부트 직후 전용이라 교체 확인이 없고,
      서버 저장본에는 추천 설명·요약이 없어 배치·예산·시간대만 복원합니다. */
  function applySharedScenario(doc) {
    S.name = doc.name || '';
    S.period = doc.period || S.period;
    S.daytype = doc.daytype || 'wd';
    S.budget = doc.budgetKrw || S.budget;
    var sane = sanePlacements(doc.placements);
    S.placements = sane.placements.map(function (p) {
      return { type: p.type, cellId: p.cellId, count: p.count };
    });
    $('#scenName').value = S.name;
    $('#budgetInput').value = Math.round(S.budget / 100000000);
    $$('#periods [data-period]').forEach(function (x) {
      var on = x.getAttribute('data-period') === S.period;
      x.classList.toggle('on', on);
      x.setAttribute('aria-selected', String(on));
    });
    syncDaytypeTabs();
    if (sane.repaired || sane.dropped) {
      C.toast('격자 개편 전 공유본 — ' +
        (sane.repaired ? '배치 ' + sane.repaired + '건을 지금 격자로 옮기고 ' : '') +
        (sane.dropped ? sane.dropped + '건은 제외하고 ' : '') + '열었습니다.', 'err', 6000);
    }
    C.toast('공유 시나리오 <b>' + esc(S.name || doc.id) + '</b> 을(를) 열었습니다.');
  }

  function loadScenario(i) {
    var list = loadScenarios();
    var s = list[i];
    if (!s) return;
    if (S.placements.length &&
        !confirm('불러오면 현재 배치 ' + S.placements.length + '건이 교체됩니다. 계속할까요?')) return;
    /* 저장된 추천 설명(rec-box)을 함께 복원합니다 — 수동 배치로 저장한
       시나리오는 애초에 recommendation 이 없어 null 그대로 남습니다. */
    S.recommendation = s.recommendation || null;
    S.recEdited = false;
    var rbtn = $('#btnRecommend');
    if (rbtn) rbtn.innerHTML = HW.icon('spark') + (S.recommendation ? '추천 다시 받기' : 'AI 추천 배치안');
    S.name = s.name;
    S.period = s.period || S.period;
    S.daytype = s.daytype || 'wd';   /* 토글 도입 전 저장본은 평일 기준이었다 */
    S.budget = s.budgetKrw || S.budget;
    /* 영역이 켜져 있으면 영역 밖 배치는 복원하지 않습니다. guardFor 의 영역
       제약은 지도 클릭 경로에만 걸려서, 그대로 되살리면 예산은 쓰였는데 영역
       기준 KPI 변화는 0 인 상태가 됩니다. */
    /* 구버전 저장본의 사라진 격자 id 는 여기서도 400 을 만듭니다 — 비교와
       같은 규칙으로 옮기거나 뺀 뒤 복원합니다(부트에서 기준선을 적립해 둠). */
    var sane = sanePlacements(s.placements);
    S.placements = sane.placements
      .filter(function (p) { return !S.area || S.area.has(p.cellId); })
      .map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count,
          fromAI: p.fromAI, rank: p.rank, rationale: p.rationale };
      });
    if (sane.repaired || sane.dropped) {
      C.toast('격자 개편 전 저장본 — ' +
        (sane.repaired ? '배치 ' + sane.repaired + '건을 지금 격자로 옮기고 ' : '') +
        (sane.dropped ? sane.dropped + '건은 제외하고 ' : '') + '불러왔습니다.', 'err', 6000);
    }
    if (S.area && sane.placements.length !== S.placements.length) {
      C.toast('영역 밖 배치 ' + (sane.placements.length - S.placements.length) +
        '건은 불러오지 않았습니다.', 'err', 5000);
    }
    $('#scenName').value = S.name;
    $('#budgetInput').value = Math.round(S.budget / 100000000);
    $$('#periods [data-period]').forEach(function (x) {
      var on = x.getAttribute('data-period') === S.period;
      x.classList.toggle('on', on);
      x.setAttribute('aria-selected', String(on));
    });
    syncDaytypeTabs();
    runSim();
    C.toast('시나리오 <b>' + esc(s.name) + '</b> 을(를) 불러왔습니다.');
  }

  function deleteScenario(i) {
    var list = loadScenarios();
    var s = list[i];
    if (!s) return;
    if (!confirm('시나리오 「' + s.name + '」 을(를) 삭제할까요?')) return;
    list.splice(i, 1);
    saveScenarios(list);
    renderScenarioList();
    C.toast('시나리오 <b>' + esc(s.name) + '</b> 을(를) 삭제했습니다.');
  }

  /* =====================================================================
   * 7. 배선
   * =================================================================== */
  /* 도움 챗봇(chat.js)이 "지금 화면" 을 읽는 자리 — dashboard.js 와 같은 계약입니다.
     이게 없으면 chat.js 의 getBody() 가 빈 컨텍스트만 보내서, 시나리오를 짜 놓고
     "설명해줘" 라고 물어도 모델은 배치·예산·효과를 하나도 못 봅니다. */
  /* 수단 선택 — 툴바 클릭과 챗봇(place 액션)이 같이 씁니다. 표시·무장·힌트는
     syncToolButtons() 한 곳이 맡습니다(빼기 모드와의 배타 처리도 거기 있습니다) —
     상태만 바꾸고 그 함수를 안 부르면 버튼과 지도가 서로 다른 말을 합니다. */
  function setTool(t) {
    S.tool = t || null;
    if (S.tool) S.removeMode = false;      /* 놓기와 빼기는 동시에 켜지지 않습니다 */
    syncToolButtons();
  }

  /** (수단, 격자)의 현재 배치 수량 — place 액션이 "실제로 늘었는가"를 확인합니다. */
  function countOf(tool, cellId) {
    for (var i = 0; i < S.placements.length; i++) {
      if (S.placements[i].type === tool && S.placements[i].cellId === cellId) {
        return S.placements[i].count;
      }
    }
    return 0;
  }

  var STRAT_KO = { efficiency: '효율 최우선', equity: '교통약자 우선',
                   balance: '지역 균형', quick: '즉시 착수' };

  function wireChatActions() {
    HW.chatActions = {
      period: function () { return S.period; },
      /* 요일 토글이 생기면서 챗봇도 화면과 같은 요일축을 알아야 합니다 —
         없으면 주말 기준선을 보며 물어도 <사실> 팩이 평일 수치로 답합니다. */
      daytype: function () { return S.daytype; },
      setPeriod: function (pid) {
        S.period = pid;
        $$('#periods [data-period]').forEach(function (x) {
          var on = x.getAttribute('data-period') === S.period;
          x.classList.toggle('on', on);
          x.setAttribute('aria-selected', String(on));
        });
        paintAll();
      },
      setLayer: function (k) {
        S.map.setLayer(k);
        $$('#layers [data-layer]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-layer') === k);
        });
      },
      /* 버튼과 똑같은 함수를 그대로 재사용 — 전략 인자 없이 부르면 지금
         S.recStrategy(기본값)로 계산해, 버튼을 누른 것과 동일하게 동작합니다. */
      recommend: requestRecommendation,

      /* ── 아래는 챗봇이 이 화면을 실제로 조작하는 자리 ────────────────────
         원칙 셋:
         ① 사용자가 클릭으로 하는 것과 **같은 함수**를 부른다(가드·표시·재계산이
            한 벌로 따라오게 — 상태만 직접 만지면 화면이 서로 다른 말을 한다).
         ② 못 한 일은 문구를 돌려주지 않는다(null·false) — 챗이 "했습니다" 라고
            말해 놓고 화면은 그대로인 거짓말을 막는다.
         ③ 되돌릴 수 있는 것만 연다. 서버에 쓰는 것(시나리오 저장·공유)은 주지
            않는다 — 모델이 오해하면 되돌리기 어려운 쪽이다. */
      setDaytype: function (dt) {
        if (dt === S.daytype) return;
        var b = $('#daytype [data-daytype="' + dt + '"]');
        if (b) b.click();
      },
      setBudget: function (eok) {
        var inp = $('#budgetInput');
        if (!inp) return;
        inp.value = eok;
        /* change 를 직접 일으켜 renderBudgetInput 의 리스너를 그대로 태웁니다 —
           클램프·집행률·정책 문구·재계산이 한 번에 따라옵니다. */
        inp.dispatchEvent(new Event('change'));
      },
      /* 배치 — 지도 클릭과 같은 경로(onCellClick)를 타므로 수단별 커버리지 가드와
         영역 제약이 그대로 걸립니다. 가드에 막히면 배치가 안 생기므로 그때는
         null 을 돌려 챗이 성공을 주장하지 못하게 합니다.
         **어디에 놓을지는 여전히 사용자(또는 recommend 알고리즘)가 정합니다** —
         이 액션은 "말한 곳에 놓기"만 합니다. */
      place: function (tool, cellId, count) {
        var cell = S.map && S.map.cellById(cellId);
        if (!cell) return null;
        var before = countOf(tool, cellId);
        setTool(tool);
        for (var i = 0; i < count; i++) onCellClick(cell);
        var after = countOf(tool, cellId);
        if (after <= before) return null;          /* 가드에 막혔습니다 */
        var label = (S.effects[tool] || {}).label || tool;
        return label + ' ' + (after - before) + '개를 ' + (cell.name || cellId) + '에 놓았습니다';
      },
      undo: function () {
        if (!S.placements.length) return false;
        $('#btnUndo').click();
        return true;
      },
      /* 초기화는 confirm 이 뜹니다 — 파괴적 조작이라 사람 확인을 남겨 둡니다
         (챗이 조용히 다 지우면 그게 가장 놀라운 동작입니다). */
      reset: function () {
        if (!S.placements.length) return false;
        var n = S.placements.length;
        resetAll();
        return S.placements.length < n;
      },
      setStrategy: function (v) {
        if (v === 'balance' && (S.area || S.recRegion)) {
          return null;   /* 범위가 지정되면 지역 균형은 성립하지 않습니다(서버 계약) */
        }
        requestRecommendation(v);
        return (STRAT_KO[v] || v) + ' 기준으로 다시 짭니다';
      },
      /* 추천 범위 — 읍면동 이름이면 그 동으로, 비우면 화성시 전체로. 지도에서 끈
         영역(S.area)이 있으면 그쪽이 우선이라 여기서 손대지 않습니다. */
      setScope: function (name) {
        if (S.area) return null;
        if (!name) {
          S.recRegion = null;
          S.map.zoomReset();
          paintRecScope();
          return '추천 범위를 화성시 전체로 되돌렸습니다';
        }
        var ok = (S.map.cells() || []).some(function (c) { return c.region === name; });
        if (!ok) return null;
        S.recRegion = name;
        if (S.recStrategy === 'balance') S.recStrategy = 'efficiency';
        S.map.zoomToRegion(name);
        paintRecScope();
        return '추천 범위를 ' + name + '으로 좁혔습니다';
      },
      report: function () {
        var b = document.querySelector('[data-report-open]');
        if (b) b.click();
      },
      /* 모델이 지금 짠 시나리오를 봐야 "이 배치 설명해줘" 에 답합니다.
         S.result 전체(격자별 배열)는 안 싣습니다 — 크기도 크고, 필요한 건
         요약 수치뿐입니다(saveCurrent 가 저장하는 summary 와 같은 선택). */
      context: function () {
        var b = currentPeriodBlock();
        var eff = (S.result && S.result.effectiveness) || {};
        return {
          현재화면: '시뮬레이션',
          시나리오이름: S.name,
          시간대: periodName(S.period),
          예산한도: S.budget,
          배치목록: S.placements.map(function (p) {
            return { 수단: TYPE_KO[p.type] || p.type, 격자: p.cellName || p.cellId, 수량: p.count };
          }),
          AI추천기준: S.recommendation ? (S.recommendation.methodLabel || null) : null,
          AI추천설명: S.recommendation ? (S.recommendation.methodNote || null) : null,
          효과: S.result ? {
            집행예정액: S.result.cost && S.result.cost.totalKrw,
            일해소통행: eff.resolvedTripsPerDay,
            통행당사업비: eff.krwPerTripPerDay,
            이시간대_사각지대_기준선: b ? b.baseline.needCells : null,
            이시간대_사각지대_배치후: b ? b.kpi.needCells : null
          } : null,
          선택한격자: S.selectedCellId
        };
      }
    };
  }

  /* 도구 선택(S.tool)과 빼기 모드(S.removeMode)는 서로 배타적입니다 — 지도
     클릭이 동시에 두 뜻일 수 없습니다. 버튼 상태·지도 무장·힌트 문구를
     한곳에서만 맞추도록 두 클릭 핸들러가 이 함수 하나를 공유합니다. */
  function syncToolButtons() {
    $$('#tools [data-tool]').forEach(function (x) {
      var on = x.getAttribute('data-tool') === S.tool;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    var rm = $('#btnRemoveMode');
    rm.classList.toggle('on', S.removeMode);
    rm.setAttribute('aria-pressed', String(S.removeMode));
    var active = S.removeMode || !!S.tool;
    S.map.setArmed(active);
    /* 배치·빼기 모드에서는 정류장이 격자 클릭을 가로채지 않게 합니다 */
    S.map.setStopsInteractive(!active);
    refreshEligible();
    var e2 = S.tool ? S.effects[S.tool] : null;
    $('#simhint').textContent = S.removeMode
      ? '빼기 모드 — 지도에서 배치된 격자를 누르면 가장 최근에 놓은 배치부터 1개씩 빠집니다.'
      : e2
      ? (e2.label + ' 모드 — 배치할 격자를 지도에서 클릭하세요. 반경 약 ' + e2.radiusKm + 'km에 파급됩니다. (단가 ' + won(e2.unitKrw) + ')' +
         (S.tool !== 'drt' ? ' 적용 가능한 격자만 또렷하게 표시됩니다.' : ''))
      : '수단을 고른 뒤 지도를 클릭하면 배치됩니다 — [빼기]를 켜면 지도에서 바로 뺄 수 있습니다. KPI는 기준선 대비 즉시 재계산됩니다.';
  }

  function wireControls() {
    wireChatActions();
    $('#tools').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tool]');
      if (!b) return;
      var t = b.getAttribute('data-tool');
      setTool(S.tool === t ? null : t);      /* 같은 버튼 재클릭 = 해제(토글) */
    });

    $('#btnRemoveMode').addEventListener('click', function () {
      S.removeMode = !S.removeMode;
      if (S.removeMode) S.tool = null;
      syncToolButtons();
    });

    $('#tgRoute').addEventListener('click', function (e) {
      var on = e.currentTarget.classList.toggle('on');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      S.map.setShowRoutes(on);
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
      if (!S.placements.length) return;
      S.placements.pop();
      /* 추천안을 되돌리기로 고친 것도 '사용자 수정'입니다 — 표시와 교체 확인이 걸리게 */
      if (S.recommendation) S.recEdited = true;
      runSim();
    });
    $('#btnArea').addEventListener('click', function () {
      setAreaMode(!$('#btnArea').classList.contains('on'));
    });
    $('#btnAreaDone').addEventListener('click', function () { S.map.commitArea(); });
    $('#btnAreaClear').addEventListener('click', function () { S.map.clearArea(); });
    $('#btnReset').addEventListener('click', resetAll);
    /* 직접 바인딩하면 MouseEvent 가 strategy 인자로 들어가 전략이 초기화됩니다 */
    $('#btnRecommend').addEventListener('click', function () { requestRecommendation(); });

    $('#recScope').addEventListener('click', function (e) {
      var b = e.target.closest('[data-scope]');
      if (!b) return;
      if (b.getAttribute('data-scope') === 'area-clear') { S.map.clearArea(); return; }
      if (b.getAttribute('data-scope') === 'all') {
        S.recRegion = null;
      } else {
        var c = S.selectedCellId ? S.map.cellById(S.selectedCellId) : null;
        if (c && c.region) S.recRegion = c.region;
      }
      /* 영역(S.area)이 켜져 있으면 region 은 전송되지 않으므로 바꾸지 않습니다 —
         지역 균형은 여러 동에 걸친 영역에서 유효합니다(requestRecommendation 참고) */
      if (!S.area && S.recRegion && S.recStrategy === 'balance') S.recStrategy = 'efficiency';
      /* 범위 전환에 맞춰 지도도 따라갑니다 */
      if (S.recRegion) S.map.zoomToRegion(S.recRegion);
      else S.map.zoomReset();
      paintRecScope();
    });
    $('#btnSave').addEventListener('click', saveCurrent);
    $('#btnShare').addEventListener('click', shareCurrent);
    $('#btnScenExport').addEventListener('click', exportScenarios);
    $('#btnScenImport').addEventListener('click', function () { $('#scenFile').click(); });
    $('#scenFile').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = '';          /* 같은 파일을 다시 골라도 change 가 오게 */
      if (f) importScenarios(f);
    });
    $('#btnCompare').addEventListener('click', runCompare);

    $('#scenList').addEventListener('click', function (e) {
      var pk = e.target.closest('[data-pick]');
      if (pk) { e.stopPropagation(); togglePick(+pk.getAttribute('data-pick')); return; }
      var d = e.target.closest('[data-del]');
      if (d) { e.stopPropagation(); deleteScenario(+d.getAttribute('data-del')); return; }
      var b = e.target.closest('[data-load]');
      if (b) loadScenario(+b.getAttribute('data-load'));
    });

    $('#cmpChart').addEventListener('mousemove', function (e) {
      var col = e.target.closest('[data-cmp]');
      if (!col || !S.result) return C.hideTip();
      var p = viewPeriods()[+col.getAttribute('data-cmp')];
      C.showTip('<b>' + esc(p.periodName) + '</b><br>기준선 ' + p.baseline.needCells + '개 → 시나리오 ' +
        p.kpi.needCells + '개<br>잠재수요 ' + fmt(p.baseline.potentialTripsPerDay) + ' → ' +
        fmt(p.kpi.potentialTripsPerDay) + '통행/일', e);
    });
    $('#cmpChart').addEventListener('mouseleave', C.hideTip);
  }

  function renderFooter(meta) {
    var costList = $('#costNote');
    if (costList && meta.effects) {
      costList.innerHTML = meta.effects.map(function (e) {
        /* 실서버 meta.effects 에는 각주 문구가 없어 basis/lifeYears 로 파생합니다. */
        var basisLabel = e.costBasisLabel ||
          (e.basis === 'capital' ? '1회성 자본비(내용연수 ' + (e.lifeYears || 1) + '년)' :
           e.basis === 'operating' ? '연간 운영비' : '');
        return '<span>' + esc(e.label) + ' <b>' + esc(won(e.unitKrw)) + '</b> ' +
          '<i>' + esc(basisLabel) + '</i></span>';
      }).join('');
      /* 단가가 확정되지 않았으면 분명히 알립니다. 실제 사업비로 오해하면 안 됩니다.
         셋 다 미확정이던 시절에는 "모두 미확정" 이라고 적었는데, 2026-08-14 에
         똑버스·증편이 공개자료 대조로 확인되면서 사실과 어긋나게 됐습니다.
         남은 것만 이름으로 짚어 줍니다 — 무엇이 근거가 있고 무엇이 없는지가
         이 배지의 존재 이유입니다. */
      if (meta.effects.some(function (e) { return e.costAssumed; }) || HW.CONFIG.costIsAssumed()) {
        var unconfirmed = ['stop', 'drt', 'freq'].filter(function (t) {
          var c = HW.CONFIG.COST[t];
          return c && c.confirmed === false;
        }).map(function (t) { return HW.CONFIG.COST[t].label.split(' ')[0]; });
        costList.innerHTML += '<span class="cost-assumed">' +
          '<span class="dq-badge">가정값</span>' +
          (unconfirmed.length ? esc(unconfirmed.join('·')) + ' 단가 미확정' : '단가 미확정') +
          '<button class="help" data-help="assumedCost" type="button">?</button></span>';
        C.wireHelp(costList);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
