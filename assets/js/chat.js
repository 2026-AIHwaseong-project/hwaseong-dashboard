/* ============================================================================
 *  chat.js — AI 채팅 (도움 · 보고서 수정)
 * ----------------------------------------------------------------------------
 *  모드 둘이 같은 UI 를 씁니다.
 *    help   서랍 → "AI 도우미". 화면 질문에 답하고 화면을 옮겨 줍니다.
 *    report 보고서 모달 안. 현재 초안을 지시대로 고쳐 씁니다.
 *
 *  이력은 **여기(클라이언트)가 들고 있습니다.** 서버는 무상태입니다. 도움 모드는
 *  sessionStorage 에도 남겨 둡니다 — 그래서 새로고침·화면 이동에도 이어지지만,
 *  탭을 닫으면 사라지고 다른 탭과도 안 섞입니다(sessionStorage 는 탭 전용).
 *
 *  ⚠️ fetch 를 직접 부르지 않습니다 — api.js 를 거칩니다(그 파일 머리 주석의 규칙).
 * ========================================================================= */
(function (global) {
  'use strict';
  var HW = global.HW = global.HW || {};
  var C = HW.core;
  var $ = C.$, esc = C.esc;

  var MAX_TURNS = 10;      // 서버로 보내는 이력 상한. 백엔드도 같은 값으로 자릅니다.
  var MAX_CHARS = 2000;    // 입력 한 번의 상한
  var HIST_KEY = 'hw.chatHist.help';     // 도움 모드 대화 이력
  var OPEN_KEY = 'hw.chatOpen';          // 패널 열림 상태
  var PENDING_KEY = 'hw.chatPending';    // 화면 이동 뒤 이어서 실행할 액션 1개

  /* ── 화면 조작 액션 ────────────────────────────────────────────────
     모델이 임의 코드를 실행하지 않습니다. 화이트리스트고 값도 여기서 검증합니다.
     전부 화면 상태만 바꾸므로 되돌리기는 사용자가 클릭 한 번으로 합니다. */
  var PERIODS = ['am', 'day', 'pm', 'night'];
  var MAX_ACTIONS = 4;     /* 한 응답이 화면을 네 번 넘게 바꾸면 사용자가 따라가지 못합니다 */

  var DAYTYPES = ['wd', 'we'];
  var TOOLS = ['stop', 'drt', 'freq'];
  var STRATEGIES = ['efficiency', 'equity', 'balance', 'quick'];

  /** 액션 여러 개를 순서대로 실행하고 안내 문구를 모읍니다.
      "심야로 바꾸고 공급 레이어로 보여줘" 처럼 한 문장이 두 조작을 요구하는 일이
      흔한데, 예전에는 action 하나 + nav.after 하나가 상한이라 절반만 됐습니다.
      nav 는 페이지를 실제로 떠나므로 **그 뒤 액션은 실행되지 않습니다** — 남은
      것은 nav.after 로 넘겨야 합니다(모델에게도 그렇게 지시합니다). */
  function runActions(list) {
    var notes = [];
    for (var i = 0; i < list.length && i < MAX_ACTIONS; i++) {
      var note = runAction(list[i]);
      if (note) notes.push(note);
      if (list[i] && list[i].type === 'nav') break;   /* 이 페이지는 곧 사라집니다 */
    }
    return notes.join(' · ');
  }

  function runAction(act) {
    if (!act || act.type === 'none') return null;
    var h = HW.chatActions || {};      /* dashboard.js · simulation.js 가 채웁니다 */
    if (act.type === 'period') {
      if (PERIODS.indexOf(act.value) < 0 || !h.setPeriod) return null;
      h.setPeriod(act.value);
      return '시간대를 바꿨습니다';
    }
    if (act.type === 'daytype') {
      if (DAYTYPES.indexOf(act.value) < 0 || !h.setDaytype) return null;
      h.setDaytype(act.value);
      return act.value === 'we' ? '주말 기준으로 바꿨습니다' : '평일 기준으로 바꿨습니다';
    }
    if (act.type === 'select') {
      if (typeof act.cellId !== 'string' || !act.cellId.trim() || !h.selectCell) return null;
      return h.selectCell(act.cellId.trim()) ? '격자를 열었습니다' : null;
    }
    if (act.type === 'budget') {
      /* 억 원 단위로 받습니다 — 사용자가 말하는 단위이고 화면 입력칸도 억입니다. */
      var eok = Number(act.value);
      if (!isFinite(eok) || eok < 0 || eok > 100000 || !h.setBudget) return null;
      h.setBudget(eok);
      return '예산 한도를 ' + eok + '억 원으로 바꿨습니다';
    }
    if (act.type === 'place') {
      if (TOOLS.indexOf(act.tool) < 0 || typeof act.cellId !== 'string' || !h.place) return null;
      var cnt = Math.max(1, Math.min(20, Math.round(Number(act.count) || 1)));
      return h.place(act.tool, act.cellId.trim(), cnt);   /* 안내 문구는 화면이 만듭니다 */
    }
    if (act.type === 'undo') {
      if (!h.undo) return null;
      return h.undo() ? '마지막 배치를 되돌렸습니다' : null;
    }
    if (act.type === 'reset') {
      if (!h.reset) return null;
      return h.reset() ? '배치를 모두 지웠습니다' : null;
    }
    if (act.type === 'strategy') {
      if (STRATEGIES.indexOf(act.value) < 0 || !h.setStrategy) return null;
      return h.setStrategy(act.value);
    }
    if (act.type === 'scope') {
      /* value 가 빈 문자열/none 이면 '화성시 전체'로 되돌립니다 */
      if (!h.setScope) return null;
      return h.setScope(typeof act.value === 'string' ? act.value.trim() : '');
    }
    if (act.type === 'report') {
      if (!h.report) return null;
      h.report();
      return 'AI 보고서를 만듭니다';
    }
    if (act.type === 'layer') {
      if (!HW.MAP_LAYERS || !HW.MAP_LAYERS[act.value] || !h.setLayer) return null;
      h.setLayer(act.value);
      return '지도 기준을 바꿨습니다';
    }
    if (act.type === 'show') {
      if (typeof act.query !== 'string' || !act.query.trim() || !h.search) return null;
      h.search(act.query.trim());
      return '지도를 옮겼습니다';
    }
    if (act.type === 'recommend') {
      if (!h.recommend) return null;
      h.recommend();
      return 'AI 추천 배치안을 계산합니다';
    }
    /* 다른 화면(대시보드 ↔ 시뮬레이션)으로 실제 이동합니다. 이 사이트는 페이지
       두 장이라 SPA 처럼 그 자리에서 바꿔치기할 수 없습니다 — 진짜 새로고침입니다.
       page 는 CONFIG.PAGES 의 키(dashboard|simulation)만 허용되므로 임의 주소로는
       못 갑니다. after 는 도착한 화면에서 이어서 실행할 액션 1개(예: recommend) —
       이 함수를 그대로 재사용해 검증합니다(따로 검증 코드를 안 둡니다). */
    if (act.type === 'nav') {
      var pages = (HW.CONFIG && HW.CONFIG.PAGES) || {};
      var url = pages[act.page];
      if (!url) return null;
      if (global.location.pathname.split('/').pop() === url) return null;   /* 이미 그 화면 */
      var param = act.page === 'simulation' ? 'cell' : 'focus';
      var qp = [];
      if (typeof act.query === 'string' && act.query.trim()) {
        qp.push(param + '=' + encodeURIComponent(act.query.trim()));
      }
      /* 지금 보고 있는 시간대·요일을 함께 넘깁니다 — 안 넘기면 주말·심야를 보다
         옮겨도 도착 화면이 평일·출근으로 시작해, 같은 질문의 답이 이동 한 번에
         달라집니다(독립 검증 주의 7). 값은 도착 화면이 다시 검증합니다. */
      if (h.period) qp.push('period=' + encodeURIComponent(h.period()));
      if (h.daytype) qp.push('daytype=' + encodeURIComponent(h.daytype()));
      var qs = qp.length ? ('?' + qp.join('&')) : '';
      if (act.after && typeof act.after === 'object') {
        try { global.sessionStorage.setItem(PENDING_KEY, JSON.stringify(act.after)); } catch (e) { /* 무시 */ }
      }
      global.location.href = url + qs;
      return '화면을 옮깁니다';
    }
    return null;
  }

  /** 화면 이동 직전에 nav 가 남겨 둔 액션을 한 번만 꺼내 씁니다.
   *  각 화면의 부팅 코드가 자기 HW.chatActions 가 준비된 뒤 불러야 합니다 —
   *  여기서 타이밍을 맞추려 하지 않습니다(그 화면이 언제 준비되는지는 그 화면이 압니다). */
  function consumePending() {
    try {
      var raw = global.sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      global.sessionStorage.removeItem(PENDING_KEY);
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];      /* 도착 화면은 항상 배열로 받습니다 */
    } catch (e) { return null; }
  }

  /* ── 채팅 한 벌 ──────────────────────────────────────────────────── */

  /**
   * @param opt.mode      'help' | 'report'
   * @param opt.mount     말풍선·입력줄을 넣을 요소
   * @param opt.getBody   () => 추가로 실어 보낼 것 { period, context, draft }
   * @param opt.onDraft   (draft) => void — report 모드에서 초안이 바뀌었을 때
   * @param opt.intro     첫 안내 문구
   * @param opt.persist   true 면 sessionStorage 에 이력을 남겨 새로고침·화면
   *                      이동 뒤에도 이어집니다(도움 모드만 — report 는 초안 자체가
   *                      화면을 나가면 사라지므로 이력만 남아 봤자 뭘 고쳤는지 안 맞습니다).
   */
  function create(opt) {
    var msgs = [];               // [{role, content}] — 서버로 보내는 것
    var busy = false;

    function persist() {
      if (!opt.persist) return;
      try { global.sessionStorage.setItem(HIST_KEY, JSON.stringify(msgs)); } catch (e) { /* 용량 초과 등 */ }
    }

    opt.mount.innerHTML =
      '<div class="cm-log" data-log role="log" aria-live="polite"></div>' +
      '<form class="cm-bar" data-form>' +
      '<input class="cm-in" data-in type="text" autocomplete="off" maxlength="' + MAX_CHARS + '" ' +
      'placeholder="' + esc(opt.placeholder || '무엇이든 물어보세요') + '" ' +
      'aria-label="' + esc(opt.placeholder || '메시지 입력') + '">' +
      '<button class="btn sm primary" type="submit" data-send>보내기</button>' +
      '</form>';

    var log = $('[data-log]', opt.mount);
    var input = $('[data-in]', opt.mount);
    var form = $('[data-form]', opt.mount);
    var sendBtn = $('[data-send]', opt.mount);

    function bubble(role, text, note) {
      var d = document.createElement('div');
      d.className = 'cm-b ' + (role === 'user' ? 'me' : 'ai');
      d.innerHTML = '<div class="cm-t"></div>' +
        (note ? '<div class="cm-n">' + esc(note) + '</div>' : '');
      /* 모델 응답은 textContent 로만 넣습니다 — innerHTML 로 넣으면 응답에 섞인
         태그가 그대로 실행됩니다. 줄바꿈은 CSS 의 white-space 가 살립니다. */
      $('.cm-t', d).textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }

    /* 이어갈 이력이 있으면 그걸 그리고, 없으면(처음 왔거나 이력이 비었으면) 안내문. */
    (function () {
      if (opt.persist) {
        try {
          var saved = JSON.parse(global.sessionStorage.getItem(HIST_KEY) || 'null');
          if (Array.isArray(saved) && saved.length) {
            msgs = saved;
            saved.forEach(function (m) { bubble(m.role === 'user' ? 'user' : 'ai', m.content); });
            return;
          }
        } catch (e) { /* 저장된 값이 깨졌으면 안내문으로 폴백 */ }
      }
      if (opt.intro) bubble('ai', opt.intro);
    })();

    function setBusy(v) {
      busy = v;
      input.disabled = v;
      sendBtn.disabled = v;
      sendBtn.textContent = v ? '생각 중…' : '보내기';
    }

    function send(text) {
      if (busy || !text) return;
      bubble('user', text);
      msgs.push({ role: 'user', content: text.slice(0, MAX_CHARS) });
      /* 최근 N턴만 보냅니다(백엔드도 같은 값으로 자릅니다). 화면의 말풍선은 남깁니다. */
      if (msgs.length > MAX_TURNS * 2) msgs = msgs.slice(-MAX_TURNS * 2);
      persist();
      setBusy(true);

      var extra = (opt.getBody && opt.getBody()) || {};
      var body = {
        mode: opt.mode,
        period: extra.period || 'am',
        /* 요일축 — 안 실으면 서버 <사실> 팩이 평일 키만 읽어, 주말 화면을 보며
           물어도 평일 수치로 답합니다(needCells 30 vs 47 같은 조용한 불일치). */
        daytype: extra.daytype || 'wd',
        messages: msgs,
        context: extra.context || {}
      };
      if (opt.mode === 'report') body.draft = extra.draft || null;

      /* 조각이 오는 대로 말풍선을 채웁니다. 첫 조각이 올 때 만들어야 빈 말풍선이
         먼저 떠 있다가 늦게 차는 어색함이 없습니다. 스트리밍을 못 하는 환경에서는
         onDelta 가 한 번도 안 불리고 아래 then 만 도므로 예전과 똑같이 동작합니다. */
      var aiB = null, acc = '';
      function onDelta(t) {
        acc += t;
        if (!aiB) { aiB = bubble('ai', ''); sendBtn.textContent = '쓰는 중…'; }
        $('.cm-t', aiB).textContent = acc;
        log.scrollTop = log.scrollHeight;
      }
      function addNote(el, text) {
        var n = document.createElement('div');
        n.className = 'cm-n';
        n.textContent = text;          /* 모델이 준 값이 섞일 수 있어 textContent */
        el.appendChild(n);
        log.scrollTop = log.scrollHeight;
      }

      HW.api.chatStream(body, onDelta).then(function (res) {
        setBusy(false);
        res = res || {};
        /* 최종 reply 를 기준으로 다시 씁니다 — 스트림이 done 을 못 준 채 끊겼으면
           그때까지 받은 글자(acc)라도 살립니다. */
        var reply = res.reply || acc || '(빈 응답)';
        /* 이력에는 답변만 남깁니다 — 액션은 이미 실행됐고, 다시 보내면 모델이
           같은 조작을 또 하려 들 수 있습니다.
           runAction 보다 먼저 push+persist 하는 이유 — nav 액션은 화면을 실제로
           이동시킵니다. 그 뒤에 저장하면 이동이 이미 시작돼 저장이 못 끝날 수 있습니다. */
        msgs.push({ role: 'assistant', content: String(res.reply || acc || '') });
        persist();
        var note = '';
        /* actions(복수)를 먼저 봅니다. 구버전 서버는 action(단수)만 주므로 둘 다 받습니다 */
        var list = Array.isArray(res.actions) ? res.actions
                 : (res.action ? [res.action] : []);
        if (list.length) note = runActions(list) || '';
        if (aiB) {
          $('.cm-t', aiB).textContent = reply;
          if (note) addNote(aiB, note);
        } else {
          bubble('ai', reply, note);
        }
        if (opt.mode === 'report' && res.draft && opt.onDraft) opt.onDraft(res.draft);
      }).catch(function (e) {
        setBusy(false);
        var why = (e && e.message) ? e.message : String(e);
        /* 흘러오던 중 끊겼으면 받은 데까지 남기고 사유만 덧붙입니다 —
           화면에 떠 있던 글자를 지워 버리면 무슨 일이 났는지 알 수 없습니다. */
        if (aiB && acc) addNote(aiB, '중간에 끊겼습니다: ' + why);
        else bubble('ai', '요청에 실패했습니다: ' + why);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      input.value = '';
      send(v);
    });

    return {
      send: send,
      focus: function () { try { input.focus(); } catch (err) { /* 화면 밖 */ } },
      reset: function () {
        msgs = []; log.innerHTML = '';
        if (opt.persist) { try { global.sessionStorage.removeItem(HIST_KEY); } catch (e) { /* 무시 */ } }
        if (opt.intro) bubble('ai', opt.intro);
      }
    };
  }

  /* ── 도움 모드 패널 ───────────────────────────────────────────────
     모달이 아니라 **떠 있는 패널**입니다. 우측 하단에 도킹되고, 열려 있는
     동안에도 지도를 클릭하거나 시간대를 바꾸는 등 대시보드를 그대로 조작할 수
     있습니다 — 배경을 덮는 .veil 이 없고, pointer-events 도 패널 자신에게만
     걸립니다. 그래서 role="dialog" aria-modal="true" 대신 role="region" 을
     씁니다 — 포커스를 가두지 않고, 스크린 리더에도 '모달' 이라고 알리지 않습니다.
     (실제 모달 — 보고서·안내 — 은 그대로 .modal/.sheet 를 씁니다. 그 둘은 초안
     검토·설명처럼 한 가지에 집중해야 하는 화면이라 가리는 것이 맞습니다.) */
  var helpPanel = null, helpChat = null;

  function buildHelp() {
    if (helpPanel) return helpPanel;
    var p = C.el('div', {
      'class': 'chat-panel', id: 'chat-panel',
      role: 'region', 'aria-label': 'AI 도우미 채팅'
    });
    p.innerHTML =
      '<div class="cp-head">' +
      '<img src="assets/img/koriyo.png" alt="" width="56" height="56" decoding="async" ' +
      'onerror="this.remove()">' +
      '<b>AI 도우미</b>' +
      '<button class="cp-x" type="button" data-chat-close aria-label="닫기">' +
      C.icon('close', 16) + '</button></div>' +
      '<div class="cp-sub">화면·지표에 대해 묻거나, 보고 싶은 곳으로 옮겨 달라고 하세요</div>' +
      '<div class="cm" data-chat-mount></div>';
    document.body.appendChild(p);
    $('[data-chat-close]', p).addEventListener('click', closeHelp);
    /* Esc 는 편의상 둡니다 — 포커스를 가두지 않으므로 실수로 다른 곳을 조작하다
       닫힐 일은 없습니다(패널 안에 초점이 있을 때만 의미가 있는 키). */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && p.classList.contains('open')) closeHelp();
    });

    helpChat = create({
      mode: 'help',
      mount: $('[data-chat-mount]', p),
      persist: true,     /* 새로고침·화면 이동에도 이 대화는 이어집니다 */
      placeholder: '예: MI가 뭐야? · 심야로 바꿔줘 · 향남읍 보여줘',
      intro: '이 화면의 지표와 사용법을 묻거나, "심야로 바꿔줘"처럼 화면을 옮겨 달라고 하셔도 됩니다. ' +
             '이 창을 열어 둔 채로 지도·시간대 탭 등 다른 화면도 그대로 쓰실 수 있습니다. ' +
             '수치는 지금 불러온 데이터에서만 답합니다.',
      getBody: function () {
        var h = HW.chatActions || {};
        var ctx = h.context ? h.context() : {};
        /* 화면마다 지원하는 조작이 다릅니다(예: 시뮬레이션엔 지역 검색창이 없고,
           대시보드엔 AI 추천이 없습니다). 있는 것만 골라 알려주지 않으면, 없는
           조작을 "했다"고 말해 놓고 화면은 그대로인 거짓 응답이 됩니다.
           지금 화면에 없는 기능은 nav 로 그 화면부터 옮기라고 안내합니다 —
           대시보드 ↔ 시뮬레이션은 완전히 다른 페이지라 그렇게만 옮겨집니다. */
        ctx.이화면에서_가능 = [
          h.setPeriod && '시간대 전환', h.setLayer && '지도색 전환',
          h.search && '지역·정류장·노선 검색 이동', h.recommend && 'AI 추천 배치안 계산'
        ].filter(Boolean).join(' · ') || '없음 — 답변만 하세요';
        ctx.다른화면_이동 = 'nav 액션 가능 — 지금 화면에 없는 기능을 물으면 이걸로 그 화면에 옮겨 놓고, ' +
          '필요하면 도착해서 이어 할 액션(after)도 같이 실으세요';
        /* daytype 핸들러는 대시보드에만 있습니다(시뮬레이션 화면엔 요일 토글이
           없어 undefined → 'wd'). report.js 의 getBody 와 같은 규칙입니다. */
        return { period: h.period ? h.period() : 'am',
                 daytype: h.daytype ? h.daytype() : 'wd', context: ctx };
      }
    });
    helpPanel = p;
    return p;
  }

  function openHelp() {
    buildHelp().classList.add('open');
    document.body.classList.add('chat-open');   /* 토스트가 패널과 안 겹치게(§CSS) */
    showBubble(false);
    if (helpChat) helpChat.focus();
    try { global.sessionStorage.setItem(OPEN_KEY, '1'); } catch (e) { /* 무시 */ }
  }
  function closeHelp() {
    if (helpPanel) helpPanel.classList.remove('open');
    document.body.classList.remove('chat-open');
    showBubble(true);      /* 다시 대기 상태 — 말풍선이 돌아옵니다 */
    try { global.sessionStorage.removeItem(OPEN_KEY); } catch (e) { /* 무시 */ }
  }
  function toggleHelp() {
    if (helpPanel && helpPanel.classList.contains('open')) closeHelp();
    else openHelp();
  }

  /* ── 우측 하단 런처 ───────────────────────────────────────────────
     다른 사이트의 상담 챗봇과 같은 자리·같은 동작입니다. 처음 오는 사람이
     "여기 물어볼 데가 있다"를 배우지 않고도 알아보는 자리라, 서랍 안쪽보다
     이쪽이 맞습니다.

     아이콘은 화성시 마스코트 코리요(AI 코리요)입니다 — 시가 발행한 도구라는
     이 화면의 세계관과 맞고, 일반 로봇 아이콘보다 화성시 것임이 분명해집니다. */
  var launcher = null, bubbleEl = null;

  /** 말풍선은 상시 표시입니다 — 한 번 보고 마는 안내가 아니라, 패널이 닫혀
   *  있는 동안은 늘 "무엇을 도와드릴까요?" 가 떠 있습니다. 그래서 세션에 한
   *  번만 보여주고 마는 장치(예전의 sessionStorage 기억)를 두지 않습니다. */
  function showBubble(v) {
    if (bubbleEl) bubbleEl.classList.toggle('show', v);
  }

  function mountLauncher() {
    if (launcher || !global.document.body) return;
    var wrap = C.el('div', { 'class': 'chat-launch', 'data-chat-launch': '' });
    wrap.innerHTML =
      '<div class="cl-bubble" data-bubble><span>무엇을 도와드릴까요?</span></div>' +
      '<button class="cl-btn" type="button" data-launch aria-label="AI 도우미 열기·닫기">' +
      /* 이미지를 못 받으면(파일 누락·오프라인) 버튼이 빈 원으로 남지 않게
         말풍선 아이콘으로 되돌립니다. */
      '<img src="assets/img/koriyo.png" alt="" width="320" height="320" decoding="async" ' +
      'onerror="this.remove();this.parentNode.classList.add(\'noimg\')">' +
      '<span class="cl-fallback" aria-hidden="true">' + C.icon('chat', 28) + '</span>' +
      '</button>';
    global.document.body.appendChild(wrap);
    launcher = wrap;
    bubbleEl = $('[data-bubble]', wrap);

    /* 런처는 토글입니다 — 패널이 이제 화면을 다 안 가리므로, 열려 있는 상태에서
       버튼을 또 누르면 닫는 게 자연스럽습니다(다시 열려면 한 번 더 누르면 됨). */
    $('[data-launch]', wrap).addEventListener('click', toggleHelp);
    /* 말풍선 자체를 누르면 대화를 엽니다(닫는 동작은 아이콘 버튼이 맡습니다) */
    bubbleEl.addEventListener('click', openHelp);

    /* 열어 둔 채로 새로고침·화면 이동을 했으면 그대로 열린 채 이어집니다.
       showBubble(true) 로 지나가지 않게 먼저 확인합니다. */
    var wasOpen = false;
    try { wasOpen = global.sessionStorage.getItem(OPEN_KEY) === '1'; } catch (e) { /* 무시 */ }
    if (wasOpen) { openHelp(); return; }

    /* 첫 페인트(지도·KPI)가 자리 잡을 시간만 살짝 두고, 그 뒤로는 패널이 닫혀
       있는 한 계속 보입니다 — openHelp/closeHelp 가 열고 닫을 때마다 토글합니다. */
    global.setTimeout(function () { showBubble(true); }, 500);
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mountLauncher);
  } else {
    mountLauncher();
  }

  HW.chat = {
    runActions: runActions, create: create, openHelp: openHelp, closeHelp: closeHelp, runAction: runAction, consumePending: consumePending };
})(window);
