/* ============================================================
 * 관리자 콘솔 (admin.html 전용)
 * ------------------------------------------------------------
 * - 통신은 전부 HW.api 를 지난다 (fetch 직접 호출 금지 — api.js 규칙).
 * - 인증은 기존 CONFIG.AUTH 훅을 켜는 것뿐이다. 토큰은 sessionStorage
 *   (탭 수명 — 공용 PC 를 고려해 localStorage 를 쓰지 않는다).
 * - 서버 응답의 동적 텍스트는 전부 esc() 또는 textContent 로만 화면에 놓는다.
 * - 진행 로그는 textContent 전용 — 파이프라인 stdout 을 innerHTML 에 넣지 않는다.
 * ============================================================ */
(function (global) {
  'use strict';
  var HW = global.HW;
  var C = HW.core, CONFIG = HW.CONFIG, api = HW.api;
  var $ = C.$, esc = C.esc;

  var S = { params: [], byKey: {}, dirty: {}, status: null, polling: null };

  /* ------------------------------------------------------------ 인증 */
  function getToken() {
    try { return sessionStorage.getItem('hw.adminToken') || ''; } catch (e) { return ''; }
  }
  function wireAuth() {
    CONFIG.AUTH.enabled = true;
    CONFIG.AUTH.header = 'Authorization';
    CONFIG.AUTH.scheme = 'Bearer';
    CONFIG.AUTH.getToken = getToken;
  }

  function tryEnter() {
    return api.call('admin.status').then(function (st) {
      $('#loginCard').hidden = true;
      $('#console').hidden = false;
      $('#btnLogout').hidden = false;
      S.status = st;
      renderStrip(st);
      renderJob(st.job);
      /* 잡이 진행 중인 채로 (재)진입하면 폴링을 재개한다 — startRefresh 경로에서만
         폴링을 시작하면 새로고침 후 완료 토스트·버튼 복구가 영원히 안 온다. */
      if (st.job && st.job.status === 'running') {
        $('#jobLog').hidden = false;
        $('#jobNote').hidden = false;
        poll();
      }
      return loadAll();
    })['catch'](function (e) {
      var box = $('#loginErr');
      box.hidden = false;
      box.textContent = e.status === 503
        ? '서버에 ADMIN_TOKEN 이 설정돼 있지 않아 관리자 기능이 닫혀 있습니다.'
        : (e.status === 401 ? '토큰이 올바르지 않습니다.' : api.humanize(e));
    });
  }

  /* ------------------------------------------------------- 데이터 적재 */
  function loadAll() {
    return Promise.all([
      api.call('admin.params'),
      api.call('admin.history', { limit: 30 })
    ]).then(function (rs) {
      S.params = rs[0].params || [];
      S.byKey = {};
      for (var i = 0; i < S.params.length; i++) S.byKey[S.params[i].key] = S.params[i];
      S.dirty = {};
      renderParams();
      renderHistory(rs[1].items || []);
      renderDataState();
      updateSaveBar();
    })['catch'](function (e) { C.toast(esc(api.humanize(e)), 'err'); });
  }

  function refreshStatus() {
    return api.call('admin.status').then(function (st) {
      S.status = st;
      renderStrip(st);
      renderJob(st.job);
      return st;
    });
  }

  /* ------------------------------------------------------------ 렌더 */
  function fmtVal(p, v) {
    if (v == null) return '—';
    if (p.type === 'int' && v >= 10000) return C.won ? C.won(v) : Number(v).toLocaleString('ko-KR');
    return Number(v).toLocaleString('ko-KR');
  }

  function renderStrip(st) {
    var d = st.data || {}, ov = st.overrides || {}, job = st.job || {};
    var tiles = [
      ['화면 데이터 빌드', d.metaUpdatedAt || '—'],
      ['서버 데이터', (d.source === 'db' ? 'DB 모드' : 'JSON 모드') + ' · 격자 ' + (d.gridCells || 0) + '칸'],
      ['관리자 값', (ov.count || 0) + '건 적용 중'],
      ['마지막 작업', job.finishedAt ? (job.status === 'done' ? '성공 ' : '실패 ') + job.finishedAt : '—']
    ];
    var html = '';
    for (var i = 0; i < tiles.length; i++) {
      html += '<div class="tile"><span>' + esc(tiles[i][0]) + '</span><b>' + esc(String(tiles[i][1])) + '</b></div>';
    }
    $('#statusStrip').innerHTML = html;
  }

  function rowHtml(p) {
    var badge = p.overridden ? ' <b class="ov">[관리자 수정]</b>' : '';
    if (p.pending) badge += ' <b class="ov">[재계산 대기]</b>';
    var meta = '기본 ' + esc(fmtVal(p, p.default)) + (p.unit ? ' ' + esc(p.unit) : '');
    if (p.overridden && p.reason) meta += ' · 사유: ' + esc(p.reason);
    var left = '<div class="plabel">' + esc(p.label) + badge +
      '<small>' + esc(p.note || '') + '</small></div>';
    var mid;
    if (p.editable) {
      var step = p.type === 'int' ? (p.max >= 1000000 ? 1000000 : 1) : 0.01;
      mid = '<div class="pinput">' +
        '<input type="number" data-key="' + esc(p.key) + '" value="' + esc(String(p.effective)) + '"' +
        ' min="' + p.min + '" max="' + p.max + '" step="' + step + '">' +
        '<span class="unit">' + esc(p.unit || '') + '</span>' +
        '<button type="button" class="minib" data-reset="' + esc(p.key) + '">기본값</button></div>';
    } else {
      mid = '<div class="pval">' + esc(fmtVal(p, p.effective)) + (p.unit ? ' ' + esc(p.unit) : '') + '</div>';
    }
    var right = '<div class="pnote">' + meta + '<br>' + esc(p.applies || '') + '</div>';
    return '<div class="admrow" data-row="' + esc(p.key) + '">' + left + mid + right + '</div>';
  }

  function renderParams() {
    var groups = { effect: [], cost: [], model: [], baseline: [] };
    for (var i = 0; i < S.params.length; i++) {
      var p = S.params[i];
      if (groups[p.group]) groups[p.group].push(rowHtml(p));
    }
    $('#rowsEffect').innerHTML = groups.effect.join('');
    $('#rowsCost').innerHTML = groups.cost.join('');
    $('#rowsModel').innerHTML = groups.model.join('');
    $('#rowsBaseline').innerHTML = groups.baseline.join('');
  }

  function renderDataState() {
    var st = S.status || {}, d = st.data || {};
    var kpi = d.kpiAm || {};
    var html = '<table>' +
      '<tr><td>서버 적재 시각</td><td>' + esc(d.loadedAt || '—') + '</td></tr>' +
      '<tr><td>화면 데이터 빌드</td><td>' + esc(d.metaUpdatedAt || '—') + '</td></tr>' +
      '<tr><td>출근 사각지대</td><td>' + esc(String(kpi.needCells != null ? kpi.needCells + '칸' : '—')) + '</td></tr>' +
      '</table>';
    $('#dataState').innerHTML = html;
  }

  function renderHistory(items) {
    if (!items.length) { $('#historyList').innerHTML = '<p class="admhint">기록이 없습니다.</p>'; return; }
    var html = '<table><tr><th>시각</th><th>종류</th><th>내용</th></tr>';
    for (var i = 0; i < items.length; i++) {
      var ev = items[i];
      var kind = { 'param.set': '값 변경', 'refresh.start': '갱신 시작', 'refresh.done': '갱신 완료', 'auth.fail': '인증 실패' }[ev.kind] || ev.kind;
      var body = '';
      if (ev.kind === 'param.set') {
        var parts = [];
        for (var j = 0; j < (ev.changes || []).length; j++) {
          var ch = ev.changes[j];
          var spec = S.byKey[ch.key];
          parts.push(esc((spec ? spec.label : ch.key)) + ' <span class="hchg">' +
            esc(String(ch.old)) + ' → ' + esc(String(ch.new)) + '</span>' + (ch.revoked ? ' (기본값 복귀)' : ''));
        }
        body = parts.join('<br>') + (ev.reason ? '<br><i>' + esc(ev.reason) + '</i>' : '');
      } else if (ev.kind === 'refresh.done') {
        body = ev.ok ? ('성공 — ' + esc((ev.steps || []).join(' → '))) : ('실패 — ' + esc(ev.error || ''));
      } else if (ev.kind === 'refresh.start') {
        body = esc((ev.steps || []).join(' → ')) + (ev.reason ? ' · ' + esc(ev.reason) : '');
      } else if (ev.kind === 'auth.fail') {
        body = 'IP ' + esc(ev.ip || '-');
      }
      html += '<tr><td>' + esc(ev.ts || '') + '</td><td class="hkind">' + esc(kind) + '</td><td>' + body + '</td></tr>';
    }
    $('#historyList').innerHTML = html + '</table>';
  }

  /* --------------------------------------------------- 변경 추적·저장 */
  function updateSaveBar() {
    var keys = [], k;
    for (k in S.dirty) keys.push(k);
    var bar = $('#saveBar');
    bar.hidden = keys.length === 0;
    $('#saveCount').textContent = '변경 ' + keys.length + '건';
    var reason = ($('#saveReason').value || '').replace(/\s+/g, ' ').replace(/^\s|\s$/g, '');
    $('#btnApply').disabled = keys.length === 0 || reason.length < 5;
  }

  function onInput(input) {
    var key = input.getAttribute('data-key');
    var p = S.byKey[key];
    if (!p) return;
    var v = input.value === '' ? NaN : Number(input.value);
    var row = input.closest('.admrow');
    var bad = isNaN(v) || v < p.min || v > p.max || (p.type === 'int' && v !== Math.round(v));
    input.classList.toggle('bad', bad);
    if (bad) { delete S.dirty[key]; updateSaveBar(); return; }
    if (v === p.effective) {
      delete S.dirty[key];
    } else if (v === p.default && p.overridden) {
      S.dirty[key] = null;                     // 기본값 복귀 = revoke
    } else {
      S.dirty[key] = v;
    }
    row.classList.toggle('changed', S.dirty.hasOwnProperty(key));
    updateSaveBar();
  }

  function openConfirm() {
    var html = '<tr><th>항목</th><th>현재</th><th></th><th>변경 후</th></tr>';
    var k;
    for (k in S.dirty) {
      var p = S.byKey[k];
      var nv = S.dirty[k] === null ? p.default : S.dirty[k];
      html += '<tr><td>' + esc(p.label) + '</td><td>' + esc(fmtVal(p, p.effective)) +
        '</td><td class="arrow">→</td><td>' + esc(fmtVal(p, nv)) +
        (S.dirty[k] === null ? ' (기본값 복귀)' : '') + '</td></tr>';
    }
    $('#confirmTable').innerHTML = html;
    $('#confirmReason').textContent = '사유: ' + $('#saveReason').value;
    $('#confirmModal').hidden = false;
  }

  function doSave() {
    $('#confirmModal').hidden = true;
    var body = { changes: S.dirty, reason: $('#saveReason').value, actor: 'admin' };
    $('#btnApply').disabled = true;
    api.call('admin.save', null, body).then(function (res) {
      if (res.requiresRefresh && res.requiresRefresh.length) {
        C.toast('저장되었습니다 — 모델 상수는 [지표 재계산]을 실행해야 화면에 반영됩니다', '', 8000);
      } else {
        C.toast('적용되었습니다 — 시뮬레이션·추천에 즉시 반영됩니다');
      }
      $('#saveReason').value = '';
      S.params = res.params || [];
      S.byKey = {};
      for (var i = 0; i < S.params.length; i++) S.byKey[S.params[i].key] = S.params[i];
      S.dirty = {};
      renderParams();
      updateSaveBar();
      api.clearCache();               // 이 페이지가 들고 있는 meta 캐시 무효화
      return Promise.all([refreshStatus(), api.call('admin.history', { limit: 30 })]);
    }).then(function (rs) {
      if (rs && rs[1]) renderHistory(rs[1].items || []);
    })['catch'](function (e) {
      C.toast(esc(api.humanize(e) || e.message), 'err', 8000);
      updateSaveBar();
    });
  }

  /* --------------------------------------------------------- 최신화 */
  function startRefresh(steps, label) {
    api.call('admin.refresh', null, { steps: steps, reason: label, actor: 'admin' })
      .then(function () {
        $('#jobLog').hidden = false;
        $('#jobNote').hidden = false;
        poll();
      })['catch'](function (e) { C.toast(esc(api.humanize(e) || e.message), 'err', 8000); });
  }

  function renderJob(job) {
    if (!job || !job.id) return;
    var log = $('#jobLog');
    if (job.logTail && job.logTail.length) {
      log.hidden = false;
      log.textContent = job.logTail.join('\n');   // textContent 전용 — stdout 을 그대로
      log.scrollTop = log.scrollHeight;
    }
    var running = job.status === 'running';
    $('#btnReload').disabled = running;
    $('#btnRecompute').disabled = running;
  }

  function poll() {
    if (S.polling) clearTimeout(S.polling);
    refreshStatus().then(function (st) {
      var job = st.job || {};
      if (job.status === 'running') {
        S.polling = setTimeout(poll, 1200);
      } else {
        S.polling = null;
        if (job.status === 'done') {
          C.toast('갱신 완료 — 열려 있는 다른 화면은 새로고침해야 반영됩니다');
          api.clearCache();
          loadAll();
        } else if (job.status === 'failed') {
          C.toast('갱신 실패 — 라이브 데이터는 변경되지 않았습니다', 'err', 8000);
        }
      }
    })['catch'](function (e) {
      /* 인증이 깨졌으면(토큰 회전·서버 비활성) 재시도하지 않는다 — 오답 폴링이
         서버의 실패 잠금을 계속 재점화해 정상 토큰까지 막는 역공을 방지. */
      if (e && (e.status === 401 || e.status === 429 || e.status === 503)) {
        S.polling = null;
        C.toast('인증이 만료되었습니다 — 다시 로그인하세요', 'err', 8000);
        return;
      }
      S.polling = setTimeout(poll, 3000);
    });
  }

  /* ------------------------------------------------------------ 배선 */
  function wire() {
    $('#loginForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      try { sessionStorage.setItem('hw.adminToken', $('#tokenInput').value.replace(/\s/g, '')); } catch (e) {}
      $('#loginErr').hidden = true;
      tryEnter();
    });
    $('#btnLogout').addEventListener('click', function () {
      try { sessionStorage.removeItem('hw.adminToken'); } catch (e) {}
      global.location.reload();
    });
    /* 파라미터 입력 — 컨테이너 위임 (행 재렌더에도 리스너 유지) */
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.hasAttribute && t.hasAttribute('data-key')) onInput(t);
      if (t && t.id === 'saveReason') updateSaveBar();
    });
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-reset]') : null;
      if (!t) return;
      var key = t.getAttribute('data-reset');
      var p = S.byKey[key];
      if (!p) return;
      var input = document.querySelector('input[data-key="' + key + '"]');
      if (input) { input.value = p.default; onInput(input); }
    });
    $('#btnRevert').addEventListener('click', function () {
      S.dirty = {};
      renderParams();
      updateSaveBar();
    });
    $('#btnApply').addEventListener('click', openConfirm);
    $('#btnCancel').addEventListener('click', function () { $('#confirmModal').hidden = true; });
    $('#btnConfirm').addEventListener('click', doSave);
    $('#btnReload').addEventListener('click', function () {
      startRefresh(['reload'], '관리자 콘솔 — 화면 반영');
    });
    $('#btnRecompute').addEventListener('click', function () {
      if (!global.confirm('지표 재계산은 수 분이 걸리고, 완료되면 격자 지표·우선순위 수치가 바뀔 수 있습니다.\n스테이징에서 검증을 통과한 산출물만 반영되며, 실패해도 기존 데이터는 유지됩니다.\n진행할까요?')) return;
      startRefresh(['join', 'model', 'validate', 'load', 'reload'], '관리자 콘솔 — 지표 재계산');
    });
  }

  /* 토큰이 어디로 전송되는지 로그인 카드에 표시한다 — ?server= 로 심어진
     localStorage 주소(악성 링크 한 번이면 영속)로 토큰이 새는 것을 눈으로 잡는
     최소 방어선. 저장된 주소가 있으면 경고를 함께 띄운다. */
  function showServerTarget() {
    var pinned = '';
    try { pinned = localStorage.getItem('hw.serverUrl') || ''; } catch (e) {}
    var el = $('#serverInfo');
    if (!el) return;
    if (pinned) {
      el.textContent = '⚠ 저장된 서버 주소로 접속합니다: ' + pinned +
        ' — 의도한 주소가 아니면 ?server= 로 초기화한 뒤 토큰을 입력하세요.';
      el.classList.add('admerr');
    } else {
      el.textContent = '접속 대상: 자동 탐색 (같은 원점 → 기본 서버 순)';
    }
  }

  function boot() {
    wireAuth();
    wire();
    showServerTarget();
    if (getToken()) tryEnter();
  }

  boot();
})(window);
