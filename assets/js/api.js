/* ============================================================================
 *  api.js — 프론트엔드의 유일한 서버 통신 계층
 * ----------------------------------------------------------------------------
 *  화면 코드(dashboard.js / simulation.js / report.js)는 절대 fetch 를 직접
 *  호출하지 않습니다. 전부 이 파일의 HW.api.* 를 지나갑니다.
 *
 *  ┌ 화면 ┐   ┌ api.js ┐
 *  │      │──▶│ 라우팅 │──▶ fetch(BASE_URL + 경로)  — 백엔드 FastAPI
 *  └──────┘   └────────┘
 *
 *  오퍼레이션 ID ↔ HTTP 경로 대응은 아래 OPS 표에 한눈에 정리돼 있습니다.
 *  엔드포인트 계약의 정본은 백엔드 docs/API_SPEC.md 입니다.
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
    'stops.profile':   { method: 'GET',  path: '/stops/{stopId}/profile' },     // 경로 파라미터만 — 응답은 전 시간대(5~23시)
    'routes.list':     { method: 'GET',  path: '/routes' },
    'priorities.list': { method: 'GET',  path: '/priorities' },                 // ?period=am&limit=10
    'simulations.run': { method: 'POST', path: '/simulations' },
    'scenarios.save':  { method: 'POST', path: '/scenarios' },                  // 공유 링크의 실체
    'scenarios.get':   { method: 'GET',  path: '/scenarios/{id}' },
    'recommendations.run': { method: 'POST', path: '/recommendations', long: true },  // 최적화 계산
    'reports.draft':   { method: 'POST', path: '/reports/draft',  long: true }, // AI 호출 → 타임아웃 김
    'reports.export':  { method: 'POST', path: '/reports/export', long: true, binary: true },
    'chat.send':       { method: 'POST', path: '/chat', long: true },           // AI 호출 → 타임아웃 김

    /* 관리자 콘솔 (admin.html 전용 — ADMIN_TOKEN 을 설정한 서버에서는 쓰기가 401).
       메서드를 GET/POST 로만 쓰는 이유: 서버 CORS allow_methods 가 GET/POST 라
       PUT 을 쓰면 교차 출처(Pages 배포)에서 프리플라이트가 막힌다.

       이 표에 없는 관리자 경로가 하나 있다: GET /admin/upload/template.
       JSON 이 아니라 Content-Disposition: attachment 로 내려오는 파일이라
       api.call(fetch → res.json())로 받을 수 없고, admin.js 가 <a href> 를
       직접 만든다(CONFIG.url 로 조합). 빠뜨린 게 아니라 성격이 다른 경로다. */
    'admin.status':    { method: 'GET',  path: '/admin/status' },
    'admin.params':    { method: 'GET',  path: '/admin/params' },
    'admin.save':      { method: 'POST', path: '/admin/params' },
    'admin.gridOverrides':      { method: 'GET',  path: '/admin/grid-overrides' },
    'admin.gridOverrideSave':   { method: 'POST', path: '/admin/grid-overrides' },
    'admin.gridOverrideRevoke': { method: 'POST', path: '/admin/grid-overrides/revoke' },
    'admin.refresh':   { method: 'POST', path: '/admin/refresh', long: true },  // 재계산 수 분
    'admin.upload':    { method: 'POST', path: '/admin/upload',  long: true },  // 원본 CSV 접수
    'admin.history':   { method: 'GET',  path: '/admin/history' }
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
    if (err.status === 409) return err.message || '다른 작업이 실행 중입니다. 끝난 뒤 다시 시도해 주세요.';
    if (err.status === 413) return err.message || '파일이 너무 큽니다.';
    if (err.status === 429) return err.message || '잠시 후 다시 시도해 주세요.';
    if (err.status === 501) return err.message;
    if (err.status >= 500) return '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    return err.message || '요청을 처리하지 못했습니다.';
  }

  /* 헤더 구성 — 일반 호출과 스트리밍 호출이 같이 씁니다. 두 곳에 복붙해 두면
     ngrok 우회 헤더나 토큰 규칙이 바뀔 때 한쪽만 고치는 사고가 납니다. */
  /* 토큰을 거른 적이 있으면 한 번만 경고합니다(요청마다 찍으면 콘솔이 묻힙니다) */
  var authWithheldWarned = false;

  function buildHeaders(op, body, accept, url) {
    var headers = { 'Accept': accept ||
      (op.binary ? 'application/octet-stream, application/json' : 'application/json') };
    if (body) headers['Content-Type'] = 'application/json';
    /* ngrok 경고 페이지 우회 등 서버 주소에 따라 필요한 추가 헤더 (config.js) */
    for (var hk in (CONFIG.EXTRA_HEADERS || {})) headers[hk] = CONFIG.EXTRA_HEADERS[hk];
    if (CONFIG.AUTH && CONFIG.AUTH.enabled) {
      /* 토큰은 허용 목록 출처로 가는 요청에만 붙입니다. config.js 가 ?server= 를
         이미 거르지만, 주소는 useServer()·SERVER_URL 같은 다른 길로도 바뀔 수
         있어서 실제로 나가는 URL 로 한 번 더 묻습니다. 판정 함수가 없는 구버전
         config.js 와 섞이면 예전처럼 붙입니다. */
      var allowed = typeof CONFIG.isAllowedServer !== 'function' || CONFIG.isAllowedServer(url);
      var tk = typeof CONFIG.AUTH.getToken === 'function' ? CONFIG.AUTH.getToken() : CONFIG.AUTH.getToken;
      if (tk && allowed) {
        headers[CONFIG.AUTH.header] = (CONFIG.AUTH.scheme ? CONFIG.AUTH.scheme + ' ' : '') + tk;
      } else if (tk && !authWithheldWarned) {
        authWithheldWarned = true;
        console.warn('[api] 허용 목록 밖의 서버라 관리자 토큰을 붙이지 않았습니다: ' + url);
      }
    }
    return headers;
  }

  /* --------------------------------------------------------- 실제 호출 */
  function httpCall(op, opId, params, body, opts) {
    var url = CONFIG.url(buildPath(op.path, params));
    var headers = buildHeaders(op, body, null, url);

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

  /* ----------------------------------------------- 스트리밍(SSE) 호출 */
  /*  서버가 event: delta / event: done 두 종류만 보냅니다.
   *    delta — 지금까지 자란 답변 글자. 화면에 이어 붙이면 됩니다.
   *    done  — 최종 구조(reply · action · draft). 이걸 못 받으면 미완성입니다.
   *  브라우저가 스트림을 못 읽거나 서버가 구버전이면 통짜 JSON 으로 조용히 내려갑니다.
   */
  function canStream() {
    return typeof TextDecoder !== 'undefined' &&
           typeof ReadableStream !== 'undefined' &&
           typeof fetch !== 'undefined';
  }

  function readSse(res, onDelta, resetIdle) {
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    var last = null;

    function drain() {
      var i;
      /* SSE 는 빈 줄 하나로 덩어리를 가릅니다. CRLF 로 보내는 프록시가 있어 먼저 폅니다. */
      buf = buf.replace(/\r\n/g, '\n');
      while ((i = buf.indexOf('\n\n')) >= 0) {
        var block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        var ev = '', data = '';
        var lines = block.split('\n');
        for (var k = 0; k < lines.length; k++) {
          if (lines[k].indexOf('event: ') === 0) ev = lines[k].slice(7);
          else if (lines[k].indexOf('data: ') === 0) data += lines[k].slice(6);
        }
        if (!data) continue;
        var payload;
        try { payload = JSON.parse(data); } catch (e) { continue; }
        if (ev === 'delta') { if (onDelta && payload.text) onDelta(payload.text); }
        else if (ev === 'done') last = payload;
      }
    }

    function pump() {
      return reader.read().then(function (r) {
        if (resetIdle) resetIdle();
        if (r.value) { buf += dec.decode(r.value, { stream: true }); drain(); }
        if (r.done) { buf += dec.decode(); drain(); return last; }
        return pump();
      });
    }
    return pump();
  }

  function streamCall(opId, body, onDelta) {
    var op = OPS[opId];
    if (!op) return Promise.reject(ApiError('정의되지 않은 오퍼레이션: ' + opId, 0, opId));
    /* call() 과 같은 이유로 주소가 정해진 뒤에 나갑니다(그 함수 주석 참고). */
    if (typeof CONFIG.ready === 'function') {
      return CONFIG.ready().then(function () {
        return CONFIG.ARCHIVE ? archiveCall(opId, null, body) : streamRun(op, opId, body, onDelta);
      });
    }
    return streamRun(op, opId, body, onDelta);
  }

  function streamRun(op, opId, body, onDelta) {
    var sent = {};
    for (var k in body) sent[k] = body[k];
    sent.stream = true;

    var url = CONFIG.url(buildPath(op.path, null));
    var headers = buildHeaders(op, sent, 'text/event-stream, application/json', url);

    /* 타임아웃은 **조각이 안 올 때만** 셉니다. 총량으로 재면 긴 답변이 중간에 잘립니다. */
    var idle = (CONFIG.TIMEOUT_MS_REPORT || 120000);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    function resetIdle() {
      if (!ctrl) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { ctrl.abort(); }, idle);
    }
    resetIdle();

    return fetch(url, {
      method: op.method, headers: headers, body: JSON.stringify(sent),
      signal: ctrl ? ctrl.signal : undefined, credentials: 'same-origin'
    }).then(function (res) {
      if (!res.ok) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (txt) {
          var detail = txt;
          try { var j = JSON.parse(txt); detail = j.message || j.detail || j.error || txt; } catch (e) { /* 평문 */ }
          throw ApiError(detail || ('HTTP ' + res.status), res.status, opId);
        });
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('text/event-stream') < 0 || !res.body || !res.body.getReader) {
        /* 서버가 stream 을 모르는 구버전 → 통짜 JSON 으로 왔다고 보고 그대로 읽습니다. */
        if (timer) clearTimeout(timer);
        return res.text().then(function (t) { return t ? JSON.parse(t) : null; });
      }
      return readSse(res, onDelta, resetIdle).then(function (out) {
        if (timer) clearTimeout(timer);
        return out;
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err.name === 'ApiError') throw err;
      if (err.name === 'AbortError') throw ApiError('요청 시간 초과', 0, opId);
      throw ApiError(err.message || '네트워크 오류', 0, opId);
    });
  }

  /* =====================================================================
   * 보관판 — 서버가 없을 때 archive/ 의 녹화본을 서버 응답처럼 돌려줍니다.
   *   config.js 가 서버 후보를 다 두드려도 응답이 없으면 CONFIG.ARCHIVE 를 켭니다.
   *   녹화: tools/record-archive.py. 녹화된 조건 밖의 요청은 501 + 안내 문장으로
   *   거절합니다 — humanize() 가 그 문장을 그대로 보여 줍니다.
   * =================================================================== */
  var archFiles = {};
  function archRaw(name) {
    if (!archFiles[name]) {
      archFiles[name] = fetch(CONFIG.ARCHIVE_DIR + name).then(function (res) {
        if (!res.ok) throw ApiError('보관판에 없는 자료입니다 (' + name + ')', 404);
        return res.json();
      });
      archFiles[name]['catch'](function () { delete archFiles[name]; });
    }
    return archFiles[name];
  }
  /* 화면 코드가 응답을 고쳐 쓰는 곳이 있어(adaptSimulation 등) 녹화본은 복사해서 줍니다 */
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function archFile(name) { return archRaw(name).then(copy); }
  function archOff(why, opId) {
    return Promise.reject(ApiError('포트폴리오 보관판이라 ' + why, 501, opId));
  }

  /* 녹화기(record-archive.py sim_key)와 같은 규칙 — 같은 (수단, 격자)는 수량을 합칩니다 */
  function simKey(dt, placements) {
    var agg = {};
    (placements || []).forEach(function (p) {
      var k = p.type + ':' + p.cellId;
      agg[k] = (agg[k] || 0) + (Number(p.count) || 1);
    });
    return dt + '|' + Object.keys(agg).sort().map(function (k) { return k + ':' + agg[k]; }).join('|');
  }

  /* 요일 기준선 + 그 배치로 바뀐 격자 필드만 녹화돼 있습니다 — 덮어써서 복원 */
  function archiveSim(body) {
    var dt = body.daytype || 'wd';
    var pl = body.placements || [];
    return Promise.all([archFile('sim_base_' + dt + '.json'), archRaw('simulations.json')]).then(function (r) {
      var res = r[0];
      if (pl.length) {
        var hit = r[1][simKey(dt, pl)];
        if (!hit) throw ApiError('포트폴리오 보관판이라 직접 고친 배치는 다시 계산할 수 없습니다. ' +
          'AI 추천안 그대로이거나 배치가 없을 때만 결과를 보여 드립니다.', 501, 'simulations.run');
        hit = copy(hit);
        for (var k in hit.top) res[k] = hit.top[k];
        Object.keys(hit.cells).forEach(function (p) {
          var cells = res.cellsByPeriod[p], at = {};
          cells.forEach(function (c, i) { at[c.id] = i; });
          Object.keys(hit.cells[p]).forEach(function (id) { Object.assign(cells[at[id]], hit.cells[p][id]); });
        });
      }
      if (body.name) res.name = body.name;
      return res;
    });
  }

  /* 추천은 서버와 같이 요일축이 없습니다(항상 평일 기준). 녹화 조건 =
     화성시 전체 · 기본 예산 · 세 수단 모두(즉시 착수는 정류장만) · 목적 4종 */
  function archiveRec(body) {
    var st = body.strategy || 'efficiency';
    var types = (body.allowedTypes || ['stop', 'drt', 'freq']).slice().sort().join();
    return Promise.all([archRaw('recommendations.json'), archRaw('meta.json')]).then(function (r) {
      var rec = r[0][(body.period || 'am') + '|' + st];
      var plain = !body.cellIds && !body.region && (st === 'quick' || types === 'drt,freq,stop') &&
        (body.budgetKrw == null || body.budgetKrw === r[1].cost.defaultBudget);
      if (!rec || !plain) throw ApiError('포트폴리오 보관판이라 추천은 화성시 전체 · 기본 예산 · ' +
        '세 수단을 모두 켠 조건만 보여 드립니다.', 501, 'recommendations.run');
      rec = copy(rec);
      if (!rec.placements || !rec.placements.length) return rec;
      return archiveSim({ daytype: 'wd', placements: rec.placements }).then(function (sim) {
        rec.simulation = sim;
        return rec;
      });
    });
  }

  function archiveCall(opId, params, body) {
    params = params || {};
    body = body || {};
    var dt = params.daytype || 'wd';
    switch (opId) {
      case 'meta.get':    return archFile('meta.json');
      case 'stops.list':  return archFile('stops.json');
      case 'routes.list': return archFile('routes.json');
      case 'grid.list':   return archFile('grid_' + params.period + '_' + dt + '.json');
      case 'priorities.list':
        return archFile('priorities_' + params.period + '_' + dt + '.json').then(function (r) {
          r.items = r.items.slice(0, params.limit || 10);
          return r;
        });
      case 'stops.profile':
        return archRaw('profiles.json').then(function (all) {
          if (!all[params.stopId]) throw ApiError('프로필 없음: ' + params.stopId, 404, opId);
          return copy(all[params.stopId]);
        });
      case 'simulations.run':     return archiveSim(body);
      case 'recommendations.run': return archiveRec(body);
      case 'reports.draft':
        return archRaw('reports.json').then(function (all) {
          var d = all[(body.period || 'am') + '|' + ((body.context && body.context.daytype) || 'wd')];
          if (!d) throw ApiError('포트폴리오 보관판이라 이 조건의 보고서 예시가 없습니다.', 501, opId);
          return copy(d);
        });
      case 'chat.send':
        return Promise.resolve({ ok: true, reply: '포트폴리오 보관판이라 AI 응답은 꺼져 있습니다. ' +
          '지도·분석 화면과 AI 추천안·보고서 예시는 녹화본으로 그대로 보실 수 있습니다.' });
      case 'admin.status':        return archRaw('admin.json').then(function (a) { return copy(a.status); });
      case 'admin.params':        return archRaw('admin.json').then(function (a) { return copy(a.params); });
      case 'admin.gridOverrides': return archRaw('admin.json').then(function (a) { return copy(a.gridOverrides); });
      case 'admin.history':       return Promise.resolve({ items: [] });
      default:
        return archOff('저장·공유·재계산은 꺼져 있습니다.', opId);
    }
  }

  /* ------------------------------------------------------------ 진입점 */
  function call(opId, params, body, opts) {
    var op = OPS[opId];
    if (!op) return Promise.reject(ApiError('정의되지 않은 오퍼레이션: ' + opId, 0, opId));
    if (CONFIG.ARCHIVE) return archiveCall(opId, params, body);
    /* 서버 주소가 정해진 뒤에 나갑니다. config.js 가 후보를 순서대로 두드려
       첫 응답에 붙이고, 그 결과를 CONFIG.BASE_URL 에 씁니다(CONFIG.url 이
       호출 시점에 읽으므로 여기서 기다리기만 하면 됩니다).
       ready() 는 한 번만 실제로 돌고 이후에는 같은 Promise 를 돌려줍니다.
       구버전 config.js 와 섞여도 죽지 않게 존재 여부를 봅니다. */
    if (typeof CONFIG.ready === 'function') {
      return CONFIG.ready().then(function () {
        return CONFIG.ARCHIVE ? archiveCall(opId, params, body) : httpCall(op, opId, params, body, opts);
      });
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

    /* 서버 breakdown 은 배치 건별 1행(cellId 포함)이라 수단별로 집계한다.
       같은 수단을 여러 격자에 놓으면 비용 차트에 같은 라벨 막대가 반복된다.
       KPI delta 보정과 별개로, 서버가 delta 를 채워 보내는 버전에서도 집계는 필요하다. */
    if (res.cost && res.cost.breakdown &&
        res.cost.breakdown.some(function (b) { return b.cellId != null; })) {
      res.cost.breakdown = aggregateBreakdown(res.cost.breakdown);
    }

    /* 서버 버전에 따라 delta 에 needCells 가 빠져 오기도 한다.
       kpi−baseline 으로 보충하지 않으면 상세 표의 .toFixed 가 undefined 로 죽는다.
       avgMi 보충은 지웠다 — 서버가 avgMi 를 의도적으로 뺐고(시간대별 z 라 평균이
       항상 ≈0 인 항등식) kpi.avgMi 가 절대 오지 않아 조건이 항상 거짓이었다.
       화면 쪽 방어는 simulation.js 가 이미 하고 있다. */
    res.periods.forEach(function (blk) {
      var k = blk.kpi || {}, b = blk.baseline || {};
      blk.delta = blk.delta || {};
      if (blk.delta.needCells == null && k.needCells != null && b.needCells != null) {
        blk.delta.needCells = k.needCells - b.needCells;
      }
    });

    /* delta 에 통행량 키가 이미 있으면(서버가 자체 정합한 버전) KPI 보정은 건너뛴다 */
    var d0 = res.periods[0].delta;
    if (d0 && d0.potentialTripsPerDay != null) return Promise.resolve(res);

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

  /* 추천 응답 보정 — "전부 아니면 통과"가 아니라 **빠진 키만** 보충합니다.
     서버가 summary 등을 자체 구현해 나가는 중이라(버전에 따라 채워진 정도가
     다름), 있는 값은 서버 것을 그대로 쓰고 없는 것만 파생값으로 채웁니다. */
  function adaptRecommendation(rec, body) {
    if (!rec) return Promise.resolve(rec);
    var period = (body && body.period) || rec.period || 'am';
    var maxN = (body && body.maxPlacements) || 10;
    var simP = (rec.simulation && rec.simulation.periods)
      ? adaptSimulation(rec.simulation) : Promise.resolve(null);
    return Promise.all([simP, api.meta()]).then(function (r) {
      var sim = r[0], meta = r[1];
      var blk = null;
      if (sim) sim.periods.forEach(function (p) { if (p.period === period) blk = p; });

      var count = (rec.placements || []).length;
      var used = rec.usedKrw != null ? rec.usedKrw
        : (rec.placements || []).reduce(function (a, p) { return a + (p.costKrw || 0); }, 0);
      var budget = rec.budgetKrw != null ? rec.budgetKrw : ((body && body.budgetKrw) || 0);

      /* ── summary: 없으면 전체 생성, 있으면 빠진 키만 보충 ── */
      if (!rec.summary) {
        var units = (meta.effects || []).map(function (e) { return e.unitKrw; });
        var minUnit = units.length ? Math.min.apply(null, units) : 42000000;
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
          krwPerTrip: (sim && sim.effectiveness) ? sim.effectiveness.krwPerTripPerDay : null,
          stoppedBecause: stopped,
          /* 서버 그리디는 총사업비 1원당 개선량으로 순위를 매깁니다 */
          costCompareLabel: '총사업비 기준',
          costCompareNote: '예산 한도와 같은 기준(총사업비)으로 비교했습니다. '
            + '똑버스·증편은 이듬해에도 같은 예산이 필요합니다.'
        };
      }
      var su = rec.summary;
      if (su.expectedResolvedCells == null) {
        su.expectedResolvedCells = blk ? Math.max(0, -(blk.delta.needCells || 0)) : 0;
      }
      if (su.expectedResolvedTrips == null) {
        su.expectedResolvedTrips = blk ? Math.max(0, -(blk.delta.potentialTripsPerDay || 0)) : 0;
      }
      if (su.expectedResolvedElderlyTrips == null) {
        su.expectedResolvedElderlyTrips = blk ? Math.max(0, -(blk.delta.elderlyTripsPerDay || 0)) : 0;
      }

      if (rec.methodLabel == null) rec.methodLabel = '예산 제약 하 한계효과 최대화';
      if (rec.methodNote == null) rec.methodNote = rec.note || '';
      if (rec.strategyNote == null) rec.strategyNote = rec.note || '';
      if (rec.strategyBasisNote == null) rec.strategyBasisNote = '';
      if (rec.region === undefined) rec.region = (body && body.region) || null;
      /* 배치를 AI 가 고른다고 오해하면 검증 단계에서 그대로 지적당합니다 */
      if (!rec.producedBy) {
        rec.producedBy = {
          placements: '최적화 알고리즘 (예산 제약 하 그리디)',
          narrative: 'AI (보고서 생성 시)',
          deterministic: true,
          deterministicNote: '같은 조건이면 항상 같은 결과가 나옵니다. '
            + '다른 안이 필요하면 난수가 아니라 전략(목적)을 바꿉니다.'
        };
      }

      /* ── 대안 비교표: 서버는 선택 전략을 빼고 주므로, selected 행이
         없으면 현재 추천을 추가하고 전략 순서대로 정렬 ── */
      if (rec.alternatives && rec.alternatives.length &&
          !rec.alternatives.some(function (a) { return a.selected; })) {
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

    /** 격자 목록 + 해당 시간대 KPI. daytype 은 'wd'(평일, 기본) | 'we'(주말) */
    grid: function (period, daytype) {
      var dt = daytype || 'wd';
      return cached('grid:' + period + ':' + dt, function () {
        return call('grid.list', { period: period, daytype: dt });
      });
    },

    /** 정류장 목록 (캐시) */
    stops: function () {
      return cached('stops', function () { return call('stops.list'); });
    },

    /** 정류장 시간대별 승하차 프로파일 — 응답이 전 시간대(5~23시)라 period 를
        보내지 않습니다. 예전에는 ?period= 를 실어 보내고 캐시 키도 시간대별로
        갈랐는데, 서버가 그 파라미터를 받지 않아(경로 파라미터만 — API_SPEC §6)
        같은 응답이 시간대 수만큼 중복 캐시되기만 했습니다. */
    stopProfile: function (stopId) {
      return cached('stopProfile:' + stopId, function () {
        return call('stops.profile', { stopId: stopId });
      });
    },

    /** 노선 목록 (캐시) */
    routes: function () {
      return cached('routes', function () { return call('routes.list'); });
    },

    /** 노선 조정 우선순위. daytype 은 'wd'(평일, 기본) | 'we'(주말) */
    priorities: function (period, limit, daytype) {
      var dt = daytype || 'wd';
      return cached('pri:' + period + ':' + (limit || 10) + ':' + dt, function () {
        return call('priorities.list', { period: period, limit: limit || 10, daytype: dt });
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
     * 시나리오 공유 — 서버에 저장하고 id 를 받습니다. 링크는 호출부가
     * `?scenario=id` 로 조립합니다(서버는 프론트 주소를 모릅니다).
     * body = { name, period, budgetKrw, placements:[{type, cellId, count}] }
     */
    saveScenario: function (body) {
      return call('scenarios.save', null, body);
    },

    /** 공유 시나리오 조회. 캐시하지 않습니다 — 링크로 새로 열 때마다 서버가 정본. */
    getScenario: function (id) {
      return call('scenarios.get', { id: id });
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
    },

    /**
     * 챗봇. mode='help' 는 화면 질문에 답하고 화면 이동 액션을 돌려주며,
     * mode='report' 는 draft 를 지시대로 고쳐 돌려줍니다.
     * body = { mode, period, messages:[{role,content}], context:{}, draft? }
     * 응답 = { reply, action:{type,…}, ok, provider, model, draft? }
     *
     * 이력(messages)은 서버가 아니라 **클라이언트가 들고 있습니다** — 서버를 무상태로
     * 두면 새로고침·다중 탭에서 남의 대화가 섞일 일이 없습니다.
     */
    chat: function (body) {
      return call('chat.send', null, body);
    },

    /**
     * 챗봇 — 답변을 조각으로 받아 가며 화면에 흘립니다.
     * onDelta(text) 가 새로 온 글자만 받고, 프로미스는 최종 응답(reply·action·draft)
     * 으로 풀립니다. 브라우저나 서버가 스트리밍을 못 하면 chat() 과 똑같이 한 번에
     * 돌아오므로 호출부는 분기하지 않아도 됩니다.
     */
    chatStream: function (body, onDelta) {
      if (!canStream()) return call('chat.send', null, body);
      return streamCall('chat.send', body, onDelta);
    }
  };

  HW.api = api;
})(window);
