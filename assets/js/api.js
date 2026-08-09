/* ============================================================================
 *  api.js — 프론트엔드의 유일한 서버 통신 계층
 * ----------------------------------------------------------------------------
 *  화면 코드(dashboard.js / simulation.js / report.js)는 절대 fetch 를 직접
 *  호출하지 않습니다. 전부 이 파일의 HW.api.* 를 지나갑니다.
 *  덕분에 백엔드 연동은 config.js 의 값 두 개만 바꾸면 끝납니다.
 *
 *  ┌ 화면 ┐   ┌ api.js ┐   USE_MOCK=true  → mock.js (브라우저 안)
 *  │      │──▶│ 라우팅 │──▶
 *  └──────┘   └────────┘   USE_MOCK=false → fetch(BASE_URL + 경로)
 *
 *  오퍼레이션 ID ↔ HTTP 경로 대응은 아래 OPS 표에 한눈에 정리돼 있습니다.
 *  같은 표가 docs/API.md 에도 있습니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var CONFIG = HW.CONFIG;

  /* ------------------------------------------------------------------
   * 오퍼레이션 정의표 — 백엔드가 구현해야 할 엔드포인트 목록
   * ---------------------------------------------------------------- */
  var OPS = {
    'meta.get':        { method: 'GET',  path: '/meta' },
    'grid.list':       { method: 'GET',  path: '/grid' },                       // ?period=am
    'stops.list':      { method: 'GET',  path: '/stops' },
    'stops.profile':   { method: 'GET',  path: '/stops/{stopId}/profile' },     // ?period=am&date=
    'routes.list':     { method: 'GET',  path: '/routes' },
    'priorities.list': { method: 'GET',  path: '/priorities' },                 // ?period=am&limit=10
    'simulations.run': { method: 'POST', path: '/simulations' },
    'simulations.get': { method: 'GET',  path: '/simulations/{id}' },
    'recommendations.run': { method: 'POST', path: '/recommendations', long: true },  // 최적화 계산
    'reports.draft':   { method: 'POST', path: '/reports/draft',  long: true }, // AI 호출 → 타임아웃 김
    'reports.export':  { method: 'POST', path: '/reports/export', long: true, binary: true }
  };

  /* 경로의 {placeholder} 를 params 값으로 치환하고, 남은 params 는 쿼리스트링으로 */
  function buildPath(tpl, params) {
    var used = {};
    var path = tpl.replace(/\{(\w+)\}/g, function (_, k) {
      used[k] = true;
      return encodeURIComponent(params && params[k] != null ? params[k] : '');
    });
    var qs = [];
    for (var k in (params || {})) {
      if (used[k] || params[k] == null || params[k] === '') continue;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return path + (qs.length ? '?' + qs.join('&') : '');
  }

  function delay(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /* ------------------------------------------------------------- 오류 */
  function ApiError(message, status, opId, payload) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status || 0;
    e.opId = opId;
    e.payload = payload;
    return e;
  }

  /** 서버 오류 응답을 사람이 읽을 수 있는 문장으로 */
  function humanize(err) {
    if (!err) return '알 수 없는 오류가 발생했습니다.';
    if (err.name === 'AbortError') return '요청 시간이 초과되었습니다. 서버 상태를 확인해 주세요.';
    if (err.status === 0) return '서버에 연결하지 못했습니다. 주소와 네트워크를 확인해 주세요. (config.js 의 BASE_URL)';
    if (err.status === 401 || err.status === 403) return '접근 권한이 없습니다. 인증 설정을 확인해 주세요.';
    if (err.status === 404) return '요청한 API 경로를 찾을 수 없습니다. (' + (err.opId || '') + ')';
    if (err.status === 501) return err.message;
    if (err.status >= 500) return '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    return err.message || '요청을 처리하지 못했습니다.';
  }

  /* --------------------------------------------------------- 실제 호출 */
  function httpCall(op, opId, params, body, opts) {
    var url = CONFIG.url(buildPath(op.path, params));
    var headers = { 'Accept': op.binary ? 'application/octet-stream, application/json' : 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (CONFIG.AUTH && CONFIG.AUTH.enabled) {
      var tk = typeof CONFIG.AUTH.getToken === 'function' ? CONFIG.AUTH.getToken() : CONFIG.AUTH.getToken;
      if (tk) headers[CONFIG.AUTH.header] = (CONFIG.AUTH.scheme ? CONFIG.AUTH.scheme + ' ' : '') + tk;
    }

    var timeout = (opts && opts.timeout) || (op.long ? CONFIG.TIMEOUT_MS_REPORT : CONFIG.TIMEOUT_MS);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;

    return fetch(url, {
      method: op.method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(function (txt) {
          var detail = txt;
          try { var j = JSON.parse(txt); detail = j.message || j.detail || j.error || txt; } catch (e) { /* 평문 */ }
          throw ApiError(detail || ('HTTP ' + res.status), res.status, opId);
        });
      }
      if (op.binary) return res.blob();
      return res.text().then(function (txt) {
        if (!txt) return null;
        try { return JSON.parse(txt); }
        catch (e) { throw ApiError('응답을 JSON 으로 해석하지 못했습니다.', res.status, opId, txt.slice(0, 200)); }
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err.name === 'ApiError') throw err;
      if (err.name === 'AbortError') throw ApiError('요청 시간 초과', 0, opId);
      throw ApiError(err.message || '네트워크 오류', 0, opId);
    });
  }

  /* ---------------------------------------------------------- 목 호출 */
  function mockCall(opId, params, body) {
    var lat = CONFIG.MOCK_LATENCY_MS || 0;
    return delay(lat).then(function () {
      return HW.mock.handle(opId, params, body);
    });
  }

  /* ------------------------------------------------------------ 진입점 */
  function call(opId, params, body, opts) {
    var op = OPS[opId];
    if (!op) return Promise.reject(ApiError('정의되지 않은 오퍼레이션: ' + opId, 0, opId));
    if (CONFIG.useMock(opId)) {
      if (!HW.mock) return Promise.reject(ApiError('mock.js 가 로드되지 않았습니다.', 0, opId));
      return mockCall(opId, params, body);
    }
    return httpCall(op, opId, params, body, opts);
  }

  /* ------------------------------------------------------- 간단 캐시 */
  var cache = {};
  function cached(key, fn) {
    if (cache[key]) return cache[key];
    cache[key] = fn().catch(function (e) { delete cache[key]; throw e; });
    return cache[key];
  }
  function clearCache() { cache = {}; }

  /* =====================================================================
   * 백엔드 응답 어댑터
   * ---------------------------------------------------------------------
   * 실서버(FastAPI) 응답을 화면이 기대하는 스키마로 보정합니다.
   * 원칙: 백엔드가 주는 값이 기준. 여기서는 파생값 계산과 이름 맞춤만 하고
   * 새 수치를 만들어내지 않습니다.
   *  - 시뮬레이션: '사각지대 잠재수요' KPI 를 대시보드(/grid)와 같은 산식
   *    (need 격자의 flowTripsPerDay 합)으로 재계산해 delta 를 채웁니다.
   *    서버 kpi 의 잠재수요는 전체 격자 합이라 라벨·대시보드와 안 맞습니다.
   *  - 비용 breakdown 을 수단별로 집계합니다(서버는 배치 건별 1행).
   *  - 추천: summary·대안 목록 등 화면 필드를 서버 값에서 파생합니다.
   * 목 응답은 이미 완전한 스키마라 그대로 통과시킵니다.
   * =================================================================== */
  function needKpiOf(cells) {
    var trips = 0, eld = 0;
    (cells || []).forEach(function (c) {
      if (c.quadrant !== 'need') return;
      trips += c.flowTripsPerDay || 0;
      eld += (c.flowTripsPerDay || 0) * (c.elderlyRatio || 0);
    });
    return { trips: Math.round(trips), elderly: Math.round(eld) };
  }

  function aggregateBreakdown(list) {
    var by = {}, order = [];
    (list || []).forEach(function (b) {
      if (!by[b.type]) {
        by[b.type] = { type: b.type, label: b.label, unitKrw: b.unitKrw, count: 0, amountKrw: 0 };
        order.push(b.type);
      }
      by[b.type].count += b.count || 1;
      by[b.type].amountKrw += b.amountKrw || 0;
    });
    return order.map(function (k) { return by[k]; });
  }

  /** 4개 시간대 기준선 KPI(/grid)를 한 번만 불러와 캐시합니다. */
  function baselineKpis() {
    return cached('baselineKpis', function () {
      return api.meta().then(function (meta) {
        var ids = (meta.periods || []).map(function (p) { return p.id; });
        return Promise.all(ids.map(function (id) { return api.grid(id); })).then(function (grids) {
          var out = {};
          grids.forEach(function (g, i) { out[ids[i]] = (g && g.kpi) || {}; });
          return out;
        });
      });
    });
  }

  function adaptSimulation(res) {
    if (!res || !res.periods || !res.periods.length) return Promise.resolve(res);
    /* 목 응답 판별: delta 에 통행량 키가 이미 있으면 완전한 스키마 */
    var d0 = res.periods[0].delta;
    if (d0 && d0.potentialTripsPerDay != null) return Promise.resolve(res);

    if (res.cost) res.cost.breakdown = aggregateBreakdown(res.cost.breakdown);
    return baselineKpis().then(function (base) {
      res.periods.forEach(function (blk) {
        var cells = res.cellsByPeriod ? res.cellsByPeriod[blk.period] : null;
        var b = base[blk.period] || {};
        if (cells) {
          var now = needKpiOf(cells);
          blk.kpi.potentialTripsPerDay = now.trips;
          blk.kpi.elderlyTripsPerDay = now.elderly;
        }
        if (b.potentialTripsPerDay != null) {
          blk.baseline.potentialTripsPerDay = b.potentialTripsPerDay;
          blk.baseline.elderlyTripsPerDay = b.elderlyTripsPerDay;
        }
        blk.delta = blk.delta || {};
        blk.delta.potentialTripsPerDay =
          (blk.kpi.potentialTripsPerDay || 0) - (blk.baseline.potentialTripsPerDay || 0);
        blk.delta.elderlyTripsPerDay =
          (blk.kpi.elderlyTripsPerDay || 0) - (blk.baseline.elderlyTripsPerDay || 0);
      });
      return res;
    });
  }

  function adaptRecommendation(rec, body) {
    if (!rec || rec.summary) return Promise.resolve(rec);   /* 목 응답은 그대로 */
    var period = (body && body.period) || rec.period || 'am';
    var maxN = (body && body.maxPlacements) || 10;
    var simP = (rec.simulation && rec.simulation.periods)
      ? adaptSimulation(rec.simulation) : Promise.resolve(null);
    return Promise.all([simP, api.meta()]).then(function (r) {
      var sim = r[0], meta = r[1];
      var blk = null;
      if (sim) sim.periods.forEach(function (p) { if (p.period === period) blk = p; });
      var units = (meta.effects || []).map(function (e) { return e.unitKrw; });
      var minUnit = units.length ? Math.min.apply(null, units) : 42000000;

      var count = (rec.placements || []).length;
      var used = rec.usedKrw != null ? rec.usedKrw
        : (rec.placements || []).reduce(function (a, p) { return a + (p.costKrw || 0); }, 0);
      var budget = rec.budgetKrw != null ? rec.budgetKrw : ((body && body.budgetKrw) || 0);
      var remaining = rec.remainingKrw != null ? rec.remainingKrw : budget - used;

      var stopped;
      if (!count) stopped = budget < minUnit ? 'budget_too_small' : 'no_candidate';
      else if (count >= maxN) stopped = 'max_reached';
      else if (remaining < minUnit) stopped = 'budget_exhausted';
      else stopped = 'no_further_gain';

      rec.summary = {
        count: count,
        totalKrw: used,
        budgetKrw: budget,
        budgetUsedPct: budget > 0 ? +(100 * used / budget).toFixed(1) : 0,
        expectedResolvedCells: blk ? Math.max(0, -(blk.delta.needCells || 0)) : 0,
        expectedResolvedTrips: blk ? Math.max(0, -(blk.delta.potentialTripsPerDay || 0)) : 0,
        expectedResolvedElderlyTrips: blk ? Math.max(0, -(blk.delta.elderlyTripsPerDay || 0)) : 0,
        krwPerTrip: (sim && sim.effectiveness) ? sim.effectiveness.krwPerTripPerDay : null,
        stoppedBecause: stopped,
        /* 서버 그리디는 총사업비 1원당 개선량으로 순위를 매깁니다 */
        costCompareLabel: '총사업비 기준',
        costCompareNote: '예산 한도와 같은 기준(총사업비)으로 비교했습니다. '
          + '똑버스·증편은 이듬해에도 같은 예산이 필요합니다.'
      };
      rec.methodLabel = '예산 제약 하 한계효과 최대화';
      rec.methodNote = rec.note || '';
      rec.strategyNote = rec.note || '';
      rec.strategyBasisNote = '';
      rec.region = (body && body.region) || null;
      /* 배치를 AI 가 고른다고 오해하면 검증 단계에서 그대로 지적당합니다 */
      rec.producedBy = {
        placements: '최적화 알고리즘 (예산 제약 하 그리디)',
        narrative: 'AI (보고서 생성 시)',
        deterministic: true,
        deterministicNote: '같은 조건이면 항상 같은 결과가 나옵니다. '
          + '다른 안이 필요하면 난수가 아니라 전략(목적)을 바꿉니다.'
      };

      /* 대안 비교표 — 선택 전략을 포함해 전략 순서대로 */
      if (rec.alternatives) {
        var mix = { stop: 0, drt: 0, freq: 0 };
        (rec.placements || []).forEach(function (p) { if (mix[p.type] != null) mix[p.type]++; });
        var all = rec.alternatives.map(function (a) {
          return { strategy: a.strategy, label: a.label, count: a.count,
                   totalKrw: a.totalKrw, mix: a.mix, selected: false };
        });
        all.push({ strategy: rec.strategy, label: rec.strategyLabel, count: count,
                   totalKrw: used, mix: mix, selected: true });
        var ord = ['efficiency', 'equity', 'balance', 'quick'];
        all.sort(function (a, b) { return ord.indexOf(a.strategy) - ord.indexOf(b.strategy); });
        rec.alternatives = all;
      }
      return rec;
    });
  }

  /* =====================================================================
   * 공개 API — 화면 코드는 이 함수들만 씁니다.
   * =================================================================== */
  var api = {
    OPS: OPS,
    call: call,
    humanize: humanize,
    clearCache: clearCache,

    /** 지도 경계·시간대·산식 등 화면 구성에 필요한 메타 (캐시) */
    meta: function () {
      return cached('meta', function () { return call('meta.get'); });
    },

    /** 격자 목록 + 해당 시간대 KPI */
    grid: function (period) {
      return cached('grid:' + period, function () { return call('grid.list', { period: period }); });
    },

    /** 정류장 목록 (캐시) */
    stops: function () {
      return cached('stops', function () { return call('stops.list'); });
    },

    /** 정류장 시간대별 승하차 프로파일 */
    stopProfile: function (stopId, period) {
      /* 캐시 키에 period 가 빠지면 다른 시간대의 프로파일이 재사용됩니다 */
      return cached('stopProfile:' + stopId + ':' + period, function () {
        return call('stops.profile', { stopId: stopId, period: period });
      });
    },

    /** 노선 목록 (캐시) */
    routes: function () {
      return cached('routes', function () { return call('routes.list'); });
    },

    /** 노선 조정 우선순위 */
    priorities: function (period, limit) {
      return cached('pri:' + period + ':' + (limit || 10), function () {
        return call('priorities.list', { period: period, limit: limit || 10 });
      });
    },

    /**
     * 배치 시뮬레이션 실행.
     * body = { name, budgetKrw, placements:[{type:'stop'|'drt'|'freq', cellId, count}] }
     */
    runSimulation: function (body) {
      return call('simulations.run', null, body).then(adaptSimulation);
    },

    /**
     * 추천 배치안 산출 (예산 제약 하 한계효과 최대화).
     * body = { period, budgetKrw, maxPlacements, allowedTypes? }
     */
    recommend: function (body) {
      return call('recommendations.run', null, body).then(function (rec) { return adaptRecommendation(rec, body); });
    },

    /**
     * AI 보고서 초안 생성.
     * body = { period, format, sections, context:{ kpi, priorities, simulation } }
     */
    draftReport: function (body) {
      return call('reports.draft', null, body);
    },

    /**
     * 서버에서 파일을 직접 받아오는 경로(선택).
     * body = { format:'xlsx'|'hwpx'|'docx', draft:{...} } → Blob
     */
    exportReport: function (body) {
      return call('reports.export', null, body);
    }
  };

  HW.api = api;
})(window);
