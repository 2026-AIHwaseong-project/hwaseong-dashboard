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

  var S = { params: [], byKey: {}, dirty: {}, status: null, polling: null, meta: null,
            /* 확인창이 무엇을 확정하려는지 — 저장 버튼과 업로드 검증 버튼이
               같은 [확정]을 쓰기 때문에 반드시 구분해야 한다. */
            confirmMode: 'params', upload: null, uploading: false };

  /* 서버는 변경 이력의 '왜' 칸을 위해 사유 5자 이상을 요구합니다(save_params).
     화면에서는 더 이상 받지 않으므로 콘솔이 대신 채웁니다 — API 계약과 이력
     형식을 그대로 두기 위해서입니다. 무엇이 어떻게 바뀌었는지는 이력이
     이전값→새값으로 따로 기록합니다. */
  var SAVE_REASON = '관리자 콘솔에서 수정';

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
      $('#topAct').hidden = false;
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
      api.meta().then(function (m) { S.meta = m; })['catch'](function () { /* 보고서 맥락용 — 없어도 화면은 돈다 */ });
      return loadAll();
    })['catch'](function (e) {
      var box = $('#loginErr');
      if (e.status === 401 && !getToken()) {
        /* 첫 진입 — 토큰 없이 두드렸는데 서버가 인증을 요구한 정상 흐름이다.
           오류가 아니므로 붉은 문구 대신 로그인 카드만 보여준다. */
        box.hidden = true;
        return;
      }
      box.hidden = false;
      box.textContent = e.status === 401 ? '토큰이 올바르지 않습니다.'
        : (e.status === 503 ? '서버에서 관리자 기능이 비활성화돼 있습니다.' : api.humanize(e));
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
      renderUploadBox(st);
      return st;
    });
  }

  /* ------------------------------------------------------------ 렌더 */
  function fmtVal(p, v) {
    if (v == null) return '—';
    if (p.type === 'int' && v >= 10000) return C.won ? C.won(v) : Number(v).toLocaleString('ko-KR');
    return Number(v).toLocaleString('ko-KR');
  }

  /* 값 + 단위. C.won 은 이미 '원'을 붙여 돌려주므로("4,200만 원") 단위를 그대로
     이으면 '4,200만 원 원'이 됩니다. 단위가 '원'으로 시작하면 그 글자를 빼고
     나머지만 잇습니다 — '원' 은 아무것도, '원/년' 은 '/년' 만. */
  function fmtUnit(p, v) {
    var s = fmtVal(p, v), u = p.unit || '';
    if (!u) return s;
    if (u.charAt(0) === '원' && /원$/.test(s)) u = u.slice(1);
    if (!u) return s;
    return s + (u.charAt(0) === '/' ? u : ' ' + u);
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
      html += '<div class="kpi"><div class="lb">' + esc(tiles[i][0]) + '</div>' +
        '<div class="vl">' + esc(String(tiles[i][1])) + '</div></div>';
    }
    $('#statusStrip').innerHTML = html;
    var mu = $('#metaUpdated');
    if (mu) mu.textContent = (st.data && st.data.metaUpdatedAt) || '–';
  }

  function rowHtml(p) {
    var badge = p.overridden ? ' <span class="ptag">관리자 수정</span>' : '';
    if (p.pending) badge += ' <span class="ptag">재계산 대기</span>';
    var meta = '기본값 ' + esc(fmtUnit(p, p.default));
    if (p.overridden && p.reason) meta += '<br><span class="ov">사유</span> ' + esc(p.reason);
    var left = '<div class="plabel">' + esc(p.label) + badge +
      '<small>' + esc(p.note || '') + '</small></div>';
    var mid;
    if (p.editable) {
      var step = p.type === 'int' ? (p.max >= 1000000 ? 1000000 : 1) : 0.01;
      mid = '<div class="pinput">' +
        '<input type="number" data-key="' + esc(p.key) + '" value="' + esc(String(p.effective)) + '"' +
        ' min="' + p.min + '" max="' + p.max + '" step="' + step + '"' +
        ' aria-label="' + esc(p.label) + '">' +
        '<span class="unit">' + esc(p.unit || '') + '</span>' +
        '<button type="button" class="btn sm" data-reset="' + esc(p.key) + '">기본값</button></div>';
    } else {
      mid = '<div class="pval">' + esc(fmtUnit(p, p.effective)) + '</div>';
    }
    var right = '<div class="pnote">' + meta + '<br>' + esc(p.applies || '') + '</div>';
    return '<div class="admrow" data-row="' + esc(p.key) + '">' + left + mid + right + '</div>';
  }

  /* 한 조(카드) 또는 전체를 기본값으로 되돌립니다. 입력만 바꿀 뿐 저장은
     하지 않습니다 — 실제 반영은 아래 저장 바의 [적용]을 거칩니다. */
  function resetGroup(group) {
    var n = 0;
    for (var i = 0; i < S.params.length; i++) {
      var p = S.params[i];
      if (!p.editable) continue;
      if (group && p.group !== group) continue;
      var input = document.querySelector('input[data-key="' + p.key + '"]');
      if (input && Number(input.value) !== p.default) {
        input.value = p.default;
        onInput(input);
        n++;
      }
    }
    C.toast(n ? (group ? '이 조를 기본값으로 되돌렸습니다 — [적용]을 눌러야 저장됩니다'
                       : '전체를 기본값으로 되돌렸습니다 — [적용]을 눌러야 저장됩니다')
              : '이미 전부 기본값입니다');
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
    var ov = st.overrides || {};
    var html = '<table>' +
      '<tr><td>서버 적재 시각</td><td>' + esc(d.loadedAt || '—') + '</td></tr>' +
      '<tr><td>화면 데이터 빌드</td><td>' + esc(d.metaUpdatedAt || '—') + '</td></tr>' +
      '<tr><td>출근 사각지대</td><td>' + esc(String(kpi.needCells != null ? kpi.needCells + '칸' : '—')) + '</td></tr>' +
      '<tr><td>관리자 값 저장 위치</td><td>서버 <code>var/admin/params_override.json</code></td></tr>' +
      '<tr><td>마지막 저장</td><td>' + esc(ov.updatedAt || '없음') + '</td></tr>' +
      '</table>' +
      '<p class="admhint">저장된 값은 <b>서버에 남습니다</b> — 화면을 옮기거나 새로고침해도, 서버를 다시 띄워도 유지되고 다른 사람에게도 같게 보입니다. 아직 [적용]하지 않은 입력은 이 화면을 벗어나면 사라집니다.</p>';
    $('#dataState').innerHTML = html;
  }

  function renderHistory(items) {
    if (!items.length) { $('#historyList').innerHTML = '<p class="admhint">기록이 없습니다.</p>'; return; }
    var html = '<table><tr><th>시각</th><th>종류</th><th>내용</th></tr>';
    for (var i = 0; i < items.length; i++) {
      var ev = items[i];
      var kind = { 'param.set': '값 변경', 'refresh.start': '갱신 시작', 'refresh.done': '갱신 완료',
                   'auth.fail': '인증 실패', 'upload.accept': '파일 접수',
                   'upload.dryrun': '검증 실행', 'upload.apply': '라이브 반영' }[ev.kind] || ev.kind;
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
      } else if (ev.kind === 'upload.accept') {
        body = esc(ev.file || '') + ' · ' + esc(String(ev.rows || 0)) + '행 · sha ' + esc(ev.sha256 || '') +
               (ev.reason ? '<br><i>' + esc(ev.reason) + '</i>' : '');
      } else if (ev.kind === 'upload.dryrun') {
        var q = (ev.result || {}).quadrantChanged;
        body = '라이브 무변경 · 판정 변경 ' + esc(String(q == null ? '—' : q)) + '개';
      } else if (ev.kind === 'upload.apply') {
        body = esc(ev.file || '') + ' 반영 · 백업 <code>' + esc(ev.backup || '') + '</code>';
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
    $('#saveCount').textContent = '적용 대기 ' + keys.length + '건';
    $('#btnApply').disabled = keys.length === 0;
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
    /* 사유 입력칸은 없앴고(콘솔이 자동으로 채웁니다), 확인 모달은 파라미터
       저장과 업로드 리포트가 함께 쓰므로 열 때마다 모드를 되돌립니다. */
    $('#confirmReason').textContent =
      '적용하면 서버에 저장되고 변경 이력에 남습니다. 되돌리려면 [모두 기본값으로]를 쓰세요.';
    S.confirmMode = 'params';
    $('#confirmModal').querySelector('h2').textContent = '변경 내용 확인';
    $('#btnConfirm').textContent = '확정';
    $('#confirmModal').hidden = false;
  }

  function doSave() {
    $('#confirmModal').hidden = true;
    var body = { changes: S.dirty, reason: SAVE_REASON, actor: 'admin' };
    $('#btnApply').disabled = true;
    api.call('admin.save', null, body).then(function (res) {
      if (res.requiresRefresh && res.requiresRefresh.length) {
        C.toast('저장되었습니다 — 모델 상수는 [지표 재계산]을 실행해야 화면에 반영됩니다', '', 8000);
      } else {
        C.toast('적용되었습니다 — 시뮬레이션·추천에 즉시 반영됩니다');
      }
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
  function startRefresh(steps, label, opts) {
    var body = { reason: label, actor: 'admin' };
    if (steps) body.steps = steps;
    if (opts && opts.uploadId) { body.uploadId = opts.uploadId; body.apply = !!opts.apply; }
    api.call('admin.refresh', null, body)
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
    /* disabled 된 input[type=file] 은 label 을 눌러도 **아무 반응 없이** 죽는다.
       "버튼이 눌리는데 아무 일도 안 남"이 되므로 label 쪽도 함께 잠근다. */
    var pick = $('#upPick'), sel = $('#upTarget');
    if (pick) { pick.className = running || S.uploading ? 'btn disabled' : 'btn'; }
    if (sel) { sel.disabled = running || S.uploading; }
    if ($('#upFile')) { $('#upFile').disabled = running || S.uploading; }
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
          if (job.result && job.result.dryRun) {
            /* 예행은 라이브를 안 바꿨다 — '갱신 완료'로 띄우면 반영된 것처럼 읽힌다. */
            C.toast('검증 완료 — 라이브 데이터는 변경되지 않았습니다', '', 7000);
            renderDryRun(job.result);
          } else {
            C.toast('갱신 완료 — 열려 있는 다른 화면은 새로고침해야 반영됩니다');
          }
          api.clearCache();
          loadAll();
        } else if (job.status === 'failed') {
          C.toast('갱신 실패 — 라이브 데이터는 변경되지 않았습니다', 'err', 8000);
        }
      }
    })['catch'](function (e) {
      /* 인증이 깨졌으면(토큰 회전·서버 비활성) 재시도하지 않는다 — 오답 폴링이
         서버의 실패 잠금을 계속 재점화해 정상 토큰까지 막는 역공을 방지. */
      if (e && (e.status === 401 || e.status === 503)) {
        S.polling = null;
        C.toast('인증이 만료되었습니다 — 다시 로그인하세요', 'err', 8000);
        return;
      }
      S.polling = setTimeout(poll, 3000);
    });
  }


  /* ------------------------------------------------------ 데이터 올리기 */
  function renderUploadBox(st) {
    var up = (st && st.upload) || {};
    var box = $('#uploadBox');
    if (!box) return;
    box.hidden = !up.enabled;
    if (!up.enabled) return;
    S.upload = up;
    var sel = $('#upTarget'), targets = up.targets || [];
    if (sel && sel.options.length !== targets.length) {
      var opts = '';
      for (var i = 0; i < targets.length; i++) {
        opts += '<option value="' + esc(targets[i].id) + '">' + esc(targets[i].label) + '</option>';
      }
      sel.innerHTML = opts;
    }
    updateUpNote();
  }

  function currentTarget() {
    var id = $('#upTarget') ? $('#upTarget').value : '';
    var t = (S.upload && S.upload.targets) || [];
    for (var i = 0; i < t.length; i++) if (t[i].id === id) return t[i];
    return null;
  }

  function updateUpNote() {
    var el = $('#upNote'), t = currentTarget();
    if (!el) return;
    if (!t) { el.textContent = ''; return; }
    el.innerHTML = '<code>' + esc(t.name) + '</code> · 현재 ' +
      esc(t.liveRows == null ? '—' : String(t.liveRows)) + '행 · 컬럼 ' +
      esc(String(t.columns)) + '개를 순서까지 대조합니다. ' + esc(t.note || '') +
      (S.upload && !S.upload.applyEnabled
        ? '<br><b>이 서버는 검증까지만 열려 있습니다 — 라이브 데이터는 바뀌지 않습니다.</b>' : '');
  }

  function showUpErr(msg) {
    var el = $('#upErr');
    el.innerHTML = esc(msg || '올리지 못했습니다.');
    el.hidden = false;
  }

  function uploadFile(file) {
    var t = currentTarget();
    if (!t || !file) return;
    $('#upErr').hidden = true;
    var reason = global.prompt('무엇을 올리는지 적어 주세요 (이력에 남습니다)', t.label + ' 최신본');
    if (reason == null) return;
    reason = String(reason).replace(/\s+/g, ' ').replace(/^\s|\s$/g, '');
    if (reason.length < 5) { showUpErr('사유를 5자 이상 적어 주세요.'); return; }

    S.uploading = true;
    renderJob(S.status && S.status.job);
    C.toast('올리는 중…');
    var fr = new FileReader();
    fr.onerror = function () {
      S.uploading = false; showUpErr('파일을 읽지 못했습니다.');
      renderJob(S.status && S.status.job);
    };
    fr.onload = function () {
      var b64 = String(fr.result || ''), comma = b64.indexOf(',');
      if (comma >= 0) b64 = b64.slice(comma + 1);
      api.call('admin.upload', null,
        { datasetId: t.id, filename: file.name, contentB64: b64, reason: reason, actor: 'admin' },
        { timeout: 300000 }
      ).then(function (res) {
        S.uploading = false;
        renderJob(S.status && S.status.job);
        renderUploadReport(res);
      })['catch'](function (e) {
        S.uploading = false;
        renderJob(S.status && S.status.job);
        showUpErr(api.humanize(e) || e.message);
      });
    };
    fr.readAsDataURL(file);
  }

  function renderUploadReport(res) {
    S.pendingUpload = res;
    var rows = '<tr><th>항목</th><th>내용</th></tr>';
    function row(k, v) { rows += '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'; }
    row('자료', esc(res.label || '') + ' <code>' + esc(res.name || '') + '</code>');
    row('올린 파일', esc(res.originalFilename || '—'));
    row('행 수', esc(res.liveRows == null ? '—' : String(res.liveRows)) +
                 ' → <b>' + esc(String(res.rows)) + '</b>');
    if (res.dateFrom || res.dateTo) {
      row('기간', esc((res.dateFrom || '?') + ' ~ ' + (res.dateTo || '?')));
    }
    row('지문', '<code>' + esc(String(res.sha256 || '').slice(0, 10)) + '</code>');
    if (res.encodingConverted) {
      row('인코딩', '엑셀에서 저장한 한글 인코딩(cp949)을 자동으로 변환했습니다');
    }
    var w = res.warnings || [];
    for (var i = 0; i < w.length; i++) row('확인 필요', '<b class="admerr">' + esc(w[i]) + '</b>');
    $('#confirmTable').innerHTML = rows;
    $('#confirmReason').textContent =
      '이 시점까지 라이브 데이터는 한 바이트도 바뀌지 않았습니다. ' +
      '검증을 실행하면 서버의 임시 공간에서 전 과정을 다시 계산해 결과만 비교합니다.';
    S.confirmMode = 'upload';
    $('#confirmModal').querySelector('h2').textContent = '올린 파일 확인';
    $('#btnConfirm').textContent = '이 데이터로 검증 실행';
    $('#confirmModal').hidden = false;
  }

  function startUploadDryRun() {
    $('#confirmModal').hidden = true;
    var up = S.pendingUpload;
    if (!up) return;
    startRefresh(null, '업로드 검증: ' + (up.label || ''),
                 { uploadId: up.uploadId, apply: false });
  }

  function renderDryRun(r) {
    var el = $('#jobNote');
    if (!el) return;
    var html = '<b>검증 결과 — 라이브 데이터는 변경되지 않았습니다.</b><br>';
    if (r.quadrantChanged != null) {
      html += '격자 판정 변경 <b>' + esc(String(r.quadrantChanged)) + '</b>개' +
              (r.comparedCells ? ' / ' + esc(String(r.comparedCells)) + '개' : '') + '<br>';
    }
    var tr = r.topRegions;
    if (tr && tr.before && tr.after) {
      html += '우선순위 상위: ' + esc(tr.before.join(', ')) +
              '<br>&rarr; ' + esc(tr.after.join(', ')) + '<br>';
    }
    var cv = r.cvLogR2;
    if (cv && cv.before != null) {
      html += '홀드아웃 R²: ' + esc(String(cv.before)) + ' → ' + esc(String(cv.after));
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  /* ------------------------------------------------------------ 배선 */
  function wire() {
    $('#loginForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      try { sessionStorage.setItem('hw.adminToken', $('#tokenInput').value.replace(/\s/g, '')); } catch (e) {}
      $('#loginErr').hidden = true;
      tryEnter();
    });
    /* 파라미터 입력 — 컨테이너 위임 (행 재렌더에도 리스너 유지) */
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.hasAttribute && t.hasAttribute('data-key')) onInput(t);
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
      C.toast('입력을 서버 저장값으로 되돌렸습니다');
    });
    /* 조별 [여기만 기본값으로] · 전체 [모두 기본값으로] */
    document.addEventListener('click', function (ev) {
      var g = ev.target.closest ? ev.target.closest('[data-reset-group]') : null;
      if (g) { resetGroup(g.getAttribute('data-reset-group')); return; }
      var a = ev.target.closest ? ev.target.closest('[data-reset-all]') : null;
      if (a) resetGroup(null);
    });
    /* 적용하지 않은 입력을 두고 화면을 떠나려 하면 한 번 묻습니다 —
       이 값들은 브라우저 메모리에만 있어서 떠나면 사라집니다. */
    global.addEventListener('beforeunload', function (e) {
      if (S.uploading) { e.preventDefault(); e.returnValue = ''; return ''; }
      for (var k in S.dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    $('#btnApply').addEventListener('click', openConfirm);
    $('#btnCancel').addEventListener('click', function () { $('#confirmModal').hidden = true; });
    $('#btnConfirm').addEventListener('click', function () {
      if (S.confirmMode === 'upload') { startUploadDryRun(); } else { doSave(); }
    });
    if ($('#upFile')) {
      $('#upFile').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        ev.target.value = '';          // 같은 파일을 다시 골라도 change 가 오게
        if (f) uploadFile(f);
      });
    }
    if ($('#upTarget')) $('#upTarget').addEventListener('change', updateUpNote);
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
    /* 상단 레일·서랍·테마·도움말·보고서를 다른 화면과 똑같이 답니다.
       initTheme 을 빼면 테마 버튼이 그려지기만 하고 눌러도 안 바뀝니다
       (dashboard.js·simulation.js 도 같은 순서로 부릅니다). */
    C.mountTopnav('admin');
    C.initTheme();
    C.wireHelp();
    if (HW.report) {
      HW.report.mount();
      /* 관리자 화면에는 격자·우선순위 맥락이 없으므로, 보고서는 대시보드에서
         쓰던 마지막 상태(meta·시나리오)만 넘겨 초안을 만들 수 있게 합니다. */
      HW.report.setContextProvider(function () {
        return { meta: S.meta || null, admin: { overrides: (S.status && S.status.overrides) || null } };
      });
    }
    wireAuth();
    wire();
    showServerTarget();
    /* 토큰이 없어도 일단 두드린다 — 서버가 ADMIN_TOKEN 을 요구하지 않으면
       그대로 들어가고, 요구하면 401 이 와서 로그인 카드가 뜬다.
       "인증이 필요한가"는 서버가 정하고 화면은 결과를 따른다. */
    tryEnter();
  }

  boot();
})(window);
