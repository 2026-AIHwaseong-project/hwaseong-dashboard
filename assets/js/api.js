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
      return cached('stopProfile:' + stopId, function () {
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
      return call('simulations.run', null, body);
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
