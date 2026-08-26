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
  var $ = C.$, $$ = C.$$, esc = C.esc;

  var S = { params: [], byKey: {}, dirty: {}, status: null, polling: null, meta: null,
            /* 확인창이 무엇을 확정하려는지 — 저장 버튼과 업로드 검증 버튼이
               같은 [확정]을 쓰기 때문에 반드시 구분해야 한다. */
            confirmMode: 'params', upload: null, uploading: false,
            /* 저장 위치 — false(기본)=로컬 초안(이 브라우저), true=서버(DB).
               로컬 초안은 서버·화면 계산에 영향이 없어 토큰 없이 만져볼 수 있고,
               DB 저장을 켜는 순간 관리자 토큰을 확인한다(ensureWriteToken). */
            dbMode: false };

  var LS_DRAFT = 'hw.adminDraft';   /* 로컬 초안 — {savedAt, reason, changes:{key:value|null}} */

  /* 사유는 **선택**입니다(2026-08-26 — 한때 서버가 5자 이상을 요구해 콘솔이
     '관리자 콘솔에서 수정'으로 자동 채웠는데, 그 문구는 이력에서 아무것도
     설명하지 못했습니다). 비워도 적용되고, 적으면 이력의 '왜' 칸에 남습니다.
     무엇이 어떻게 바뀌었는지는 이력이 이전값→새값으로 따로 기록합니다. */

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
      /* 업로드 상자는 여기서도 그려야 한다. #uploadBox 의 hidden 을 푸는 곳이
         renderUploadBox() 하나뿐인데, 그걸 부르는 것은 refreshStatus() 였고
         refreshStatus() 는 잡이 도는 중(poll)이나 저장 직후에만 불린다. 즉 서버에서
         HW_UPLOAD_ENABLED 를 켜도 **첫 진입 화면에는 업로드 UI 가 영원히 안 나타났다** —
         파라미터를 한 번 저장하거나 재계산을 돌려야 비로소 보이는 상태였다. */
      renderUploadBox(st);
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
      api.call('admin.history', { limit: 30 }),
      api.call('admin.gridOverrides')
    ]).then(function (rs) {
      S.params = rs[0].params || [];
      S.byKey = {};
      for (var i = 0; i < S.params.length; i++) S.byKey[S.params[i].key] = S.params[i];
      S.dirty = {};
      renderParams();
      renderHistory(rs[1].items || []);
      renderGridOverrides(rs[2]);
      renderDataState();
      updateSaveBar();
      /* 저장 위치 복원 — 세션에 'db' 로 남아 있어도 쓰기 권한이 확인될 때만
         켠다(토큰이 사라졌으면 조용히 로컬로 내려간다). */
      var want = 'local';
      try { want = sessionStorage.getItem('hw.adminSaveMode') || 'local'; } catch (e) { /* 무시 */ }
      S.dbMode = want === 'db' && rs[2].canWrite !== false;
      syncSaveModeUi();
      var n = applyDraftToInputs();
      if (n && !S.draftNoticeShown) {
        S.draftNoticeShown = true;
        C.toast('로컬 초안 <b>' + n + '건</b>을 불러왔습니다(이 브라우저 전용 — 서버 미반영). '
          + '반영하려면 [DB에 저장]을 켜고 [적용]하세요.', '', 8000);
      }
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
      ['마지막 작업', job.finishedAt ? (job.status === 'done' ? '성공 ' : '실패 ') + fmtTs(job.finishedAt) : '—']
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
      /* 서버가 범위(min/max)를 내리지 않습니다 — 2026-08-26 제거. step 은 범위
         대신 기본값의 자릿수로 정합니다(단가류 100만 원 단위, 건수류 1 단위). */
      var step = p.type === 'int' ? (Math.abs(p.default) >= 1000000 ? 1000000 : 1) : 0.01;
      mid = '<div class="pinput">' +
        '<input type="number" data-key="' + esc(p.key) + '" value="' + esc(String(p.effective)) + '"' +
        (p.min != null ? ' min="' + p.min + '"' : '') +
        (p.max != null ? ' max="' + p.max + '"' : '') +
        ' step="' + step + '"' +
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
      '<tr><td>서버 적재 시각</td><td>' + esc(fmtTs(d.loadedAt) || '—') + '</td></tr>' +
      '<tr><td>화면 데이터 빌드</td><td>' + esc(d.metaUpdatedAt || '—') + '</td></tr>' +
      '<tr><td>출근 사각지대</td><td>' + esc(String(kpi.needCells != null ? kpi.needCells + '칸' : '—')) + '</td></tr>' +
      '<tr><td>관리자 값 저장 위치</td><td>서버 <code>var/admin/params_override.json</code></td></tr>' +
      '<tr><td>마지막 저장</td><td>' + esc(fmtTs(ov.updatedAt) || '없음') + '</td></tr>' +
      '</table>' +
      '<p class="admhint">저장된 값은 <b>서버에 남습니다</b> — 화면을 옮기거나 새로고침해도, 서버를 다시 띄워도 유지되고 다른 사람에게도 같게 보입니다. 아직 [적용]하지 않은 입력은 이 화면을 벗어나면 사라집니다.</p>';
    $('#dataState').innerHTML = html;
  }

  /* 서버가 주는 시각은 KST 오프셋이 붙은 ISO 다 — 2026-08-25T00:11:48+09:00.
     사람이 읽는 자리에는 T 와 오프셋이 방해만 되므로 '2026-08-25 00:11:48' 로 편다.
     오프셋을 화면에서 지우는 것이지 값을 바꾸지 않는다(브라우저 시간대로 재해석하면
     심사위원 노트북이 다른 시간대일 때 또 어긋난다 — 서버가 준 KST 를 그대로 쓴다).
     오프셋이 없는 옛 기록은 손대지 않고 그대로 보여 준다. */
  function fmtTs(s) {
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)/.exec(String(s == null ? '' : s));
    return m ? m[1] + ' ' + m[2] : String(s == null ? '' : s);
  }

  /* --------------------------------------------- 격자 판정 오버라이드 */
  var GOV_PERIOD_KO = { am: '출근', day: '낮', pm: '퇴근', night: '심야' };
  var GOV_VALUE_KO = {
    need: '고수요·저공급', over: '저수요·고공급', drt: '수요응답형', ok: '적정', mid: '균형권',
    DRT: '똑버스', NEW_STOP: '신설', ADD_FREQ: '증차'
  };
  var GOV_FIELD_KO = { quadrant: '사분면 판정', action: '수단 배지', priorityScore: '우선순위 점수' };

  function fmtGovVal(v) {
    if (v == null) return '—';
    return GOV_VALUE_KO[v] || (typeof v === 'number' ? Number(v).toLocaleString('ko-KR') : String(v));
  }

  function renderGridOverrides(res) {
    S.gridOv = res || { overrides: [], fields: {} };
    /* 필드·허용값 셀렉트는 서버 계약(fields)에서 만듭니다 — 하드코딩 복제가
       서버와 어긋나는 사고를 막습니다(coverageMin 과 같은 이유). 시간대 라벨만
       이쪽 소유이고 값 검증은 서버가 합니다. */
    var pf = $('#govPeriod');
    if (pf && !pf.options.length) {
      pf.innerHTML = Object.keys(GOV_PERIOD_KO).map(function (p) {
        return '<option value="' + p + '">' + GOV_PERIOD_KO[p] + '</option>';
      }).join('');
    }
    var ff = $('#govField');
    if (ff && !ff.options.length) {
      ff.innerHTML = Object.keys(S.gridOv.fields || {}).map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(GOV_FIELD_KO[k] || k) + '</option>';
      }).join('');
      syncGovValueInput();
    }
    var host = $('#gridOvList');
    if (!host) return;
    var recs = S.gridOv.overrides || [];
    if (!recs.length) {
      host.innerHTML = '<p class="admhint">수정된 격자가 없습니다 — 지도·표의 판정은 전부 모델 산출값입니다.</p>';
      return;
    }
    var html = '<table><tr><th>격자</th><th>시간대</th><th>항목</th><th>값</th><th>사유</th><th>일시</th><th></th></tr>';
    recs.slice(0, 20).forEach(function (r) {
      var revoked = !!r.revokedAt;
      html += '<tr' + (revoked ? ' style="opacity:.45"' : '') + '><td>' + esc(r.gridId) + '</td><td>' +
        esc((GOV_PERIOD_KO[r.period] || r.period) + (r.daytype === 'we' ? '·주말' : '')) + '</td><td>' +
        esc(GOV_FIELD_KO[r.field] || r.field) + '</td><td><span class="hchg">' +
        esc(fmtGovVal(r.prev)) + ' → ' + esc(fmtGovVal(r.value)) + '</span>' +
        (revoked ? ' (되돌림)' : '') + '</td><td>' + esc(r.reason || '') + '</td><td>' +
        esc(fmtTs(r.at)) + '</td><td>' +
        (!revoked && S.gridOv.canWrite !== false
          ? '<button type="button" class="btn sm" data-gov-revoke="' + esc(r.id) + '">되돌리기</button>' : '') +
        '</td></tr>';
    });
    host.innerHTML = html + '</table>' +
      (recs.length > 20 ? '<p class="admhint">최근 20건만 표시합니다 — 전체는 이력 파일에 있습니다.</p>' : '');
  }

  function syncGovValueInput() {
    var ff = $('#govField');
    if (!ff) return;
    var spec = (S.gridOv && S.gridOv.fields && S.gridOv.fields[ff.value]) || {};
    var sel = $('#govValueSel'), num = $('#govValueNum');
    if (spec.kind === 'num') { sel.hidden = true; num.hidden = false; return; }
    num.hidden = true;
    sel.hidden = false;
    sel.innerHTML = (spec.allowed || []).map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(GOV_VALUE_KO[v] || v) + '</option>';
    }).join('');
  }

  function saveGridOverride() {
    var field = $('#govField').value;
    var spec = (S.gridOv && S.gridOv.fields && S.gridOv.fields[field]) || {};
    var value = spec.kind === 'num' ? Number($('#govValueNum').value) : $('#govValueSel').value;
    var body = {
      gridId: $('#govGrid').value.trim(),
      period: $('#govPeriod').value,
      daytype: $('#govDaytype').value,
      field: field,
      value: value,
      reason: $('#govReason').value.trim(),
      actor: 'admin'
    };
    var err = $('#govErr');
    err.hidden = true;
    if (!body.gridId) { err.hidden = false; err.textContent = '격자 ID 를 입력하세요 — 대시보드에서 격자를 클릭하면 ID 가 보입니다.'; return; }
    if (spec.kind === 'num' && !isFinite(value)) { err.hidden = false; err.textContent = '점수 값을 숫자로 입력하세요.'; return; }
    var btn = $('#govSave');
    btn.disabled = true;
    api.call('admin.gridOverrideSave', null, body).then(function () {
      btn.disabled = false;
      $('#govReason').value = '';
      C.toast('격자 <b>' + esc(body.gridId) + '</b> 판정을 수정했습니다 — 열려 있는 대시보드는 새로고침해야 보입니다.');
      return loadAll();
    })['catch'](function (e) {
      btn.disabled = false;
      err.hidden = false;
      err.textContent = api.humanize(e);
    });
  }

  function renderHistory(items) {
    if (!items.length) { $('#historyList').innerHTML = '<p class="admhint">기록이 없습니다.</p>'; return; }
    var html = '<table><tr><th>시각</th><th>종류</th><th>내용</th></tr>';
    for (var i = 0; i < items.length; i++) {
      var ev = items[i];
      var kind = { 'param.set': '값 변경', 'refresh.start': '갱신 시작', 'refresh.done': '갱신 완료',
                   'auth.fail': '인증 실패', 'upload.accept': '파일 접수',
                   'upload.dryrun': '검증 실행', 'upload.apply': '라이브 반영',
                   'grid.set': '격자 판정 수정', 'grid.revoke': '격자 판정 되돌림' }[ev.kind] || ev.kind;
      var body = '';
      /* grid.* 이력도 changes[{key,old,new}] 모양이 같아 param.set 포맷을 그대로
         씁니다 — key 가 SPECS 에 없으니 라벨 대신 "격자·시간대·필드" 원문이 남습니다. */
      if (ev.kind === 'param.set' || ev.kind === 'grid.set' || ev.kind === 'grid.revoke') {
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
      html += '<tr><td>' + esc(fmtTs(ev.ts)) + '</td><td class="hkind">' + esc(kind) + '</td><td>' + body + '</td></tr>';
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
    /* 범위 검사는 서버 계약에서 빠졌습니다 — min/max 가 null 인 채로 `v < null`
       을 비교하면 null 이 0 으로 강제돼 음수가 전부 "잘못된 값"이 됩니다. */
    var bad = isNaN(v) || (p.min != null && v < p.min) || (p.max != null && v > p.max) ||
      (p.type === 'int' && v !== Math.round(v));
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
    /* 사유 입력칸은 하단 저장 바(적용 대기 옆)에 있습니다 — 값을 고치는 그
       자리에서 바로 적게 하기 위해서입니다. 확인 모달은 파라미터 저장과 업로드
       리포트가 함께 쓰므로 열 때마다 모드를 되돌립니다. */
    $('#confirmReason').textContent = S.dbMode
      ? '적용하면 서버(DB)에 저장되고 변경 이력에 남습니다. 되돌리려면 [모두 기본값으로]를 쓰세요.'
      : '지금은 로컬 초안 모드입니다 — 이 브라우저에만 저장되고 서버·화면 계산에는 영향이 없습니다. '
        + '실제 반영은 상단 [DB에 저장]을 켜세요.';
    S.confirmMode = 'params';
    $('#confirmModal').querySelector('h2').textContent = '변경 내용 확인';
    $('#btnConfirm').textContent = '확정';
    $('#confirmModal').hidden = false;
  }

  function readDraft() {
    try { return JSON.parse(localStorage.getItem(LS_DRAFT) || 'null'); }
    catch (e) { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(LS_DRAFT); } catch (e) { /* 무시 */ }
  }

  /** 로컬 초안 저장 — 서버를 건드리지 않는다. 입력·적용 대기 표시는 그대로
      남는다("서버엔 아직"이라는 신호). 기존 초안 위에 이번 변경을 덮는다. */
  function saveDraftLocal() {
    var d = { savedAt: C.nowStamp(), reason: $('#saveReason').value.trim(), changes: {} };
    var prev = readDraft();
    if (prev && prev.changes) for (var pk in prev.changes) d.changes[pk] = prev.changes[pk];
    for (var k in S.dirty) d.changes[k] = S.dirty[k];
    try { localStorage.setItem(LS_DRAFT, JSON.stringify(d)); }
    catch (e) { C.toast('초안을 저장하지 못했습니다(브라우저 저장 공간).', 'err'); return; }
    C.toast('이 브라우저에 <b>초안으로만</b> 저장했습니다 — 서버·화면 계산에는 반영되지 '
      + '않습니다. 실제 반영은 상단 [DB에 저장]을 켜고 다시 [적용]하세요.', '', 9000);
  }

  /** 로컬 초안을 입력 칸에 되살린다(새로고침·재방문에도 초안 유지). 반환 = 건수. */
  function applyDraftToInputs() {
    var d = readDraft();
    if (!d || !d.changes) return 0;
    var n = 0;
    for (var k in d.changes) {
      var p = S.byKey[k];
      var input = document.querySelector('input[data-key="' + k + '"]');
      if (!p || !input) continue;      /* 서버에서 사라진 키는 조용히 건너뜀 */
      input.value = d.changes[k] === null ? p.default : d.changes[k];
      onInput(input);
      n++;
    }
    if (d.reason && !$('#saveReason').value) $('#saveReason').value = d.reason;
    return n;
  }

  function syncSaveModeUi() {
    $$('#saveMode [data-savemode]').forEach(function (b) {
      var on = (b.getAttribute('data-savemode') === 'db') === S.dbMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  /** DB 저장을 켜기 전 쓰기 권한을 확인한다. 토큰이 없으면 물어보고, 서버가
      토큰을 요구하지 않는 상태(fail-open)면 그대로 통과한다. */
  function ensureWriteToken() {
    function verify() {
      return api.call('admin.gridOverrides')
        .then(function (r) { return r.canWrite !== false; })
        ['catch'](function () { return false; });
    }
    return verify().then(function (ok) {
      if (ok) return true;
      var t = global.prompt('DB(서버) 저장에는 관리자 토큰이 필요합니다.\n서버 .env 의 ADMIN_TOKEN 값을 입력하세요:');
      if (!t) return false;
      try { sessionStorage.setItem('hw.adminToken', t.replace(/\s/g, '')); } catch (e) { /* 무시 */ }
      return verify().then(function (ok2) {
        if (!ok2) { C.toast('토큰이 올바르지 않습니다.', 'err', 5000); return false; }
        C.toast('관리자 인증 확인 — 이제 [적용]이 서버(DB)에 저장됩니다.');
        return true;
      });
    });
  }

  function doSave() {
    $('#confirmModal').hidden = true;
    if (!S.dbMode) { saveDraftLocal(); return; }
    var body = { changes: S.dirty, reason: $('#saveReason').value.trim(), actor: 'admin' };
    $('#btnApply').disabled = true;
    api.call('admin.save', null, body).then(function (res) {
      $('#saveReason').value = '';
      clearDraft();     /* 서버에 들어갔으니 로컬 초안은 소임을 다했다 */
      if (res.requiresRefresh && res.requiresRefresh.length) {
        /* 재계산이 필요한 값(모델·기준선 상수)은 저장 즉시 자동으로 재계산을
           건다 — "저장했는데 화면이 안 바뀐다"가 이 화면에서 가장 흔한 혼란이었고,
           버튼을 따로 누르게 하면 그 사이의 '저장됐지만 미반영' 상태가 사람 몫이
           된다. 진행 상황은 아래 작업 로그로 시선을 옮겨 보여준다. */
        C.toast('저장되었습니다 — 지표 재계산을 자동으로 시작합니다 (수십 초)', '', 8000);
        startRefresh(['join', 'model', 'validate', 'load', 'reload'],
                     '상수 저장 — 자동 지표 재계산');
        focusJobLog();
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
  /** 작업 로그로 시선을 옮깁니다 — 자동 재계산처럼 사용자가 다른 카드에서
      촉발한 작업은 로그가 화면 밖이라 "뭔가 도는 중"이 안 보입니다. */
  function focusJobLog() {
    var log = $('#jobLog');
    if (!log) return;
    log.hidden = false;
    if (!log.hasAttribute('tabindex')) log.setAttribute('tabindex', '-1');
    log.scrollIntoView({ behavior: 'smooth', block: 'center' });
    log.focus({ preventScroll: true });
  }

  function startRefresh(steps, label, opts) {
    var body = { reason: label, actor: 'admin' };
    if (steps) body.steps = steps;
    if (opts && opts.uploadId) { body.uploadId = opts.uploadId; body.apply = !!opts.apply; }
    /* 새 작업이 시작되면 이전 예행의 [라이브에 반영]은 반드시 사라져야 한다.
       남겨 두면 방금 것이 아닌 옛 uploadId 로 반영이 나갈 수 있다. */
    setApplyUploadState(false);
    if ($('#dryResult')) $('#dryResult').hidden = true;
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
    /* 숨기는 대상이 #uploadBox 가 아니라 카드 전체다 — 업로드가 독립 섹션이 된
       뒤로는 내용만 숨기면 제목만 남은 빈 카드가 화면에 남는다. */
    var card = $('#uploadCard');
    if (!card) return;
    card.hidden = !up.enabled;
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

  /* 예시 양식 내려받기 — 링크만 바꿔 준다.
     헤더 정본은 서버(DATASETS[...]["header"])에 하나뿐이므로 컬럼 이름을 프론트가
     따로 들고 있지 않는다. 그래야 "예시대로 만들었는데 400" 이 구조적으로 안 난다.
     api.call 이 아니라 <a href> 인 이유는 JSON 이 아니라 파일 다운로드이고,
     서버가 Content-Disposition: attachment 로 내려주기 때문이다. */
  function updateUpTemplate(t) {
    var a = $('#upTemplate');
    if (!a) return;
    if (!t) { a.hidden = true; return; }
    a.hidden = false;
    a.href = CONFIG.url('/admin/upload/template?datasetId=' + encodeURIComponent(t.id));
    a.setAttribute('download', String(t.name || 'template.csv').replace(/\.csv$/, '') + '_예시양식.csv');
    a.title = t.name + ' — 컬럼 ' + t.columns + '개(순서 포함)와 표본 3행이 들어 있습니다. '
            + '엑셀에서 열어 고친 뒤 그대로 올리시면 됩니다.';
  }

  function updateUpNote() {
    var el = $('#upNote'), t = currentTarget();
    updateUpTemplate(t);
    if (!el) return;
    if (!t) { el.textContent = ''; return; }
    el.innerHTML = '<code>' + esc(t.name) + '</code> · 현재 ' +
      esc(t.liveRows == null ? '—' : String(t.liveRows)) + '행 · 컬럼 ' +
      esc(String(t.columns)) + '개를 순서까지 대조합니다. ' + esc(t.note || '') +
      (S.upload && !S.upload.applyEnabled
        ? '<br><b>이 서버는 검증까지만 열려 있습니다 — 라이브 데이터는 바뀌지 않습니다.</b>'
        : '<br>올리면 먼저 <b>검증(예행)</b>만 돌고, 결과를 본 뒤 <b>[라이브에 반영]</b>을 눌러야 실제로 교체됩니다.');
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
    /* 업로드 카드의 전용 박스에 그린다. 예전에는 #jobNote(새로고침 안내 공용)를
       덮어써서, 다음 일반 재계산 때 낡은 검증 결과가 안내문 자리에 되살아났다. */
    var el = $('#dryResult');
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
    /* 여기서만 [라이브에 반영]이 풀린다 — 서버가 반영을 허용하고(HW_UPLOAD_APPLY)
       방금 검증한 업로드가 손에 있을 때. 검증 결과를 본 사람만 반영할 수 있다. */
    setApplyUploadState(!!((S.upload && S.upload.applyEnabled) && S.pendingUpload));
  }

  /** [라이브에 반영] 버튼 상태. 숨기지 않고 **비활성으로 보여준다** — 숨기면
      "반영은 어디서 하지?"를 검증이 끝나기 전에는 알 수 없다. 왜 안 눌리는지는
      호버 안내(title)가 말한다. */
  function setApplyUploadState(ready) {
    var b = $('#btnApplyUpload');
    if (!b) return;
    b.disabled = !ready;
    b.title = ready
      ? '방금 검증한 파일로 라이브 원본을 교체합니다'
      : (S.upload && S.upload.applyEnabled === false
        ? '서버에서 라이브 반영이 꺼져 있습니다 — .env 의 HW_UPLOAD_APPLY=1 로 켭니다'
        : 'CSV 파일을 올리고 [검증 실행]을 먼저 하세요 — 검증 결과를 본 뒤에만 반영할 수 있습니다');
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
      clearDraft();     /* 안 비우면 다음 방문에 초안이 입력을 도로 채운다 */
      renderParams();
      updateSaveBar();
      C.toast('입력을 서버 저장값으로 되돌렸습니다 (로컬 초안도 비웠습니다)');
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
    $('#saveMode').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-savemode]');
      if (!b) return;
      var wantDb = b.getAttribute('data-savemode') === 'db';
      if (wantDb === S.dbMode) return;
      if (!wantDb) {
        S.dbMode = false;
        try { sessionStorage.setItem('hw.adminSaveMode', 'local'); } catch (e) { /* 무시 */ }
        syncSaveModeUi();
        C.toast('로컬 초안 모드 — [적용]이 이 브라우저에만 저장됩니다.');
        return;
      }
      /* 인증이 확인될 때까지 스위치를 넘기지 않는다 */
      ensureWriteToken().then(function (ok) {
        if (!ok) { S.dbMode = false; syncSaveModeUi(); return; }
        S.dbMode = true;
        try { sessionStorage.setItem('hw.adminSaveMode', 'db'); } catch (e) { /* 무시 */ }
        syncSaveModeUi();
        var d = readDraft();
        var cnt = d && d.changes ? Object.keys(d.changes).length : 0;
        if (cnt) C.toast('로컬 초안 ' + cnt + '건이 입력에 남아 있습니다 — [적용]하면 서버에 저장됩니다.');
      });
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
    if ($('#govSave')) $('#govSave').addEventListener('click', saveGridOverride);
    if ($('#govField')) $('#govField').addEventListener('change', syncGovValueInput);
    if ($('#gridOvList')) {
      $('#gridOvList').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-gov-revoke]');
        if (!b) return;
        if (!global.confirm('이 수정을 되돌릴까요? 원값이 복원되고 되돌림도 이력에 남습니다.')) return;
        api.call('admin.gridOverrideRevoke', null,
                 { id: b.getAttribute('data-gov-revoke'), actor: 'admin' })
          .then(function () { C.toast('되돌렸습니다 — 원값이 복원됐습니다.'); return loadAll(); })
          ['catch'](function (e) { C.toast(esc(api.humanize(e)), 'err', 6000); });
      });
    }
    if ($('#btnApplyUpload')) {
      $('#btnApplyUpload').addEventListener('click', function () {
        var up = S.pendingUpload;
        if (!up) return;
        if (!global.confirm('방금 검증한 파일을 라이브에 반영합니다.\n' +
            '원본이 교체되고 조인→모델→검증→직렬화가 다시 돌아 화면 수치가 바뀔 수 있습니다.\n' +
            '교체 전 자동으로 백업하며, 도중에 실패하면 이미 바꾼 것까지 되돌립니다.\n진행할까요?')) return;
        startRefresh(null, '업로드 반영: ' + (up.label || ''),
                     { uploadId: up.uploadId, apply: true });
      });
    }
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
