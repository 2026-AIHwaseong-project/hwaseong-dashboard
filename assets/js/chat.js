/* ============================================================================
 *  chat.js — AI 채팅 (도움 · 보고서 수정)
 * ----------------------------------------------------------------------------
 *  모드 둘이 같은 UI 를 씁니다.
 *    help   서랍 → "AI 도우미". 화면 질문에 답하고 화면을 옮겨 줍니다.
 *    report 보고서 모달 안. 현재 초안을 지시대로 고쳐 씁니다.
 *
 *  이력은 **여기(클라이언트)가 들고 있습니다.** 서버는 무상태라 새로고침하면
 *  대화가 사라지는 대신, 다중 탭에서 남의 대화가 섞일 일이 없습니다.
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

  /* ── 화면 조작 액션 ────────────────────────────────────────────────
     모델이 임의 코드를 실행하지 않습니다. 화이트리스트 3종이고 값도 여기서 검증합니다.
     셋 다 화면 상태만 바꾸므로 되돌리기는 사용자가 클릭 한 번으로 합니다. */
  var PERIODS = ['am', 'day', 'pm', 'night'];

  function runAction(act) {
    if (!act || act.type === 'none') return null;
    var h = HW.chatActions || {};      /* dashboard.js 가 채웁니다 */
    if (act.type === 'period') {
      if (PERIODS.indexOf(act.value) < 0 || !h.setPeriod) return null;
      h.setPeriod(act.value);
      return '시간대를 바꿨습니다';
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
    return null;
  }

  /* ── 채팅 한 벌 ──────────────────────────────────────────────────── */

  /**
   * @param opt.mode      'help' | 'report'
   * @param opt.mount     말풍선·입력줄을 넣을 요소
   * @param opt.getBody   () => 추가로 실어 보낼 것 { period, context, draft }
   * @param opt.onDraft   (draft) => void — report 모드에서 초안이 바뀌었을 때
   * @param opt.intro     첫 안내 문구
   */
  function create(opt) {
    var msgs = [];               // [{role, content}] — 서버로 보내는 것
    var busy = false;

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

    if (opt.intro) bubble('ai', opt.intro);

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
      setBusy(true);

      var extra = (opt.getBody && opt.getBody()) || {};
      var body = {
        mode: opt.mode,
        period: extra.period || 'am',
        messages: msgs,
        context: extra.context || {}
      };
      if (opt.mode === 'report') body.draft = extra.draft || null;

      HW.api.chat(body).then(function (res) {
        setBusy(false);
        var note = '';
        if (res.action) {
          var done = runAction(res.action);
          if (done) note = done;
        }
        bubble('ai', res.reply || '(빈 응답)', note);
        /* 이력에는 답변만 남깁니다 — 액션은 이미 실행됐고, 다시 보내면 모델이
           같은 조작을 또 하려 들 수 있습니다. */
        msgs.push({ role: 'assistant', content: String(res.reply || '') });
        if (opt.mode === 'report' && res.draft && opt.onDraft) opt.onDraft(res.draft);
      }).catch(function (e) {
        setBusy(false);
        bubble('ai', '요청에 실패했습니다: ' + (e && e.message ? e.message : e));
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
      reset: function () { msgs = []; log.innerHTML = ''; if (opt.intro) bubble('ai', opt.intro); }
    };
  }

  /* ── 도움 모드 모달 ───────────────────────────────────────────────
     사용 안내 모달과 같은 구조(.modal/.sheet)를 씁니다 — 서랍에서 나란히 열리는
     항목이라 생김새가 같아야 합니다. */
  var helpModal = null, helpChat = null;

  function buildHelp() {
    if (helpModal) return helpModal;
    var m = C.el('div', { 'class': 'modal', id: 'chat-modal' });
    m.innerHTML =
      '<div class="veil" data-chat-close></div>' +
      '<div class="sheet chat-sheet" role="dialog" aria-modal="true" aria-label="AI 도우미">' +
      '<header><h2>AI 도우미</h2>' +
      '<span class="hs">화면·지표에 대해 묻거나, 보고 싶은 곳으로 옮겨 달라고 하세요</span>' +
      '<span class="sp"></span>' +
      '<button class="xbtn" data-chat-close type="button" aria-label="닫기">' +
      C.icon('close', 17) + '</button></header>' +
      '<div class="body"><div class="cm" data-chat-mount></div></div>' +
      '</div>';
    document.body.appendChild(m);
    C.$$('[data-chat-close]', m).forEach(function (b) {
      b.addEventListener('click', closeHelp);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && m.classList.contains('open')) closeHelp();
    });

    helpChat = create({
      mode: 'help',
      mount: $('[data-chat-mount]', m),
      placeholder: '예: MI가 뭐야? · 심야로 바꿔줘 · 향남읍 보여줘',
      intro: '이 화면의 지표와 사용법을 묻거나, "심야로 바꿔줘"처럼 화면을 옮겨 달라고 하셔도 됩니다. ' +
             '수치는 지금 불러온 데이터에서만 답합니다.',
      getBody: function () {
        var h = HW.chatActions || {};
        var ctx = h.context ? h.context() : {};
        /* 시뮬레이션 화면에는 chatActions 가 없어 액션이 조용히 무시됩니다.
           그걸 모델에 알려 주지 않으면 "심야로 바꿨습니다" 라고 말해 놓고 화면은
           그대로인 상태가 됩니다 — 그것이 거짓말이 되지 않게 미리 못박습니다. */
        ctx.화면조작 = h.setPeriod ? '가능' : '불가 — 이 화면에서는 답변만 하고, '
          + '화면 이동이 필요하면 대시보드로 가라고 안내하세요';
        return { period: h.period ? h.period() : 'am', context: ctx };
      }
    });
    helpModal = m;
    return m;
  }

  function openHelp() {
    buildHelp().classList.add('open');
    hideBubble(true);
    if (launcher) launcher.classList.add('gone');   /* 모달 뒤에 겹쳐 보이지 않게 */
    if (helpChat) helpChat.focus();
  }
  function closeHelp() {
    if (helpModal) helpModal.classList.remove('open');
    if (launcher) launcher.classList.remove('gone');
  }

  /* ── 우측 하단 런처 ───────────────────────────────────────────────
     다른 사이트의 상담 챗봇과 같은 자리·같은 동작입니다. 처음 오는 사람이
     "여기 물어볼 데가 있다"를 배우지 않고도 알아보는 자리라, 서랍 안쪽보다
     이쪽이 맞습니다.

     아이콘은 화성시 마스코트 코리요(AI 코리요)입니다 — 시가 발행한 도구라는
     이 화면의 세계관과 맞고, 일반 로봇 아이콘보다 화성시 것임이 분명해집니다. */
  var launcher = null, bubbleEl = null, bubbleTimer = null;
  var BUBBLE_KEY = 'hw.chatBubbleSeen';

  function hideBubble(remember) {
    if (bubbleTimer) { global.clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (bubbleEl) bubbleEl.classList.remove('show');
    /* 한 번 보고 나면 이 탭에서는 다시 안 띄웁니다. localStorage 가 아니라
       sessionStorage 인 이유 — 며칠 뒤 다시 온 사람에게는 한 번 더 알려 주는 편이
       낫고, 같은 방문 중에 페이지를 오갈 때만 조용하면 됩니다. */
    if (remember) { try { sessionStorage.setItem(BUBBLE_KEY, '1'); } catch (e) { /* 차단됨 */ } }
  }

  function mountLauncher() {
    if (launcher || !global.document.body) return;
    var wrap = C.el('div', { 'class': 'chat-launch', 'data-chat-launch': '' });
    wrap.innerHTML =
      '<div class="cl-bubble" data-bubble>' +
      '<span>무엇을 도와드릴까요?</span>' +
      '<button class="cl-x" type="button" data-bubble-x aria-label="말풍선 닫기">' +
      C.icon('close', 12) + '</button></div>' +
      '<button class="cl-btn" type="button" data-launch aria-label="AI 도우미 열기">' +
      /* 이미지를 못 받으면(파일 누락·오프라인) 버튼이 빈 원으로 남지 않게
         말풍선 아이콘으로 되돌립니다. */
      '<img src="assets/img/koriyo.png" alt="" width="320" height="320" decoding="async" ' +
      'onerror="this.remove();this.parentNode.classList.add(\'noimg\')">' +
      '<span class="cl-fallback" aria-hidden="true">' + C.icon('chat', 24) + '</span>' +
      '</button>';
    global.document.body.appendChild(wrap);
    launcher = wrap;
    bubbleEl = $('[data-bubble]', wrap);

    $('[data-launch]', wrap).addEventListener('click', openHelp);
    $('[data-bubble-x]', wrap).addEventListener('click', function (e) {
      e.stopPropagation();      /* 닫기가 곧 열기가 되면 안 됩니다 */
      hideBubble(true);
    });
    /* 말풍선 자체를 누르면 대화를 여는 게 자연스럽습니다 */
    bubbleEl.addEventListener('click', openHelp);

    var seen = false;
    try { seen = sessionStorage.getItem(BUBBLE_KEY) === '1'; } catch (e) { /* 차단됨 */ }
    if (!seen) {
      /* 곧바로 띄우면 첫 화면을 읽는 것을 방해합니다. 지도·KPI 가 자리를 잡은 뒤에. */
      bubbleTimer = global.setTimeout(function () {
        bubbleTimer = null;
        if (bubbleEl) bubbleEl.classList.add('show');
      }, 2500);
    }
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mountLauncher);
  } else {
    mountLauncher();
  }

  HW.chat = { create: create, openHelp: openHelp, closeHelp: closeHelp, runAction: runAction };
})(window);
