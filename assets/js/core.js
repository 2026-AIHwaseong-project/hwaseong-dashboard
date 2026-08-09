/* ============================================================================
 *  core.js — 공용 유틸리티 · UI 헬퍼 · 좌표 투영
 * ----------------------------------------------------------------------------
 *  화면 로직이 공통으로 쓰는 것들만 모았습니다. 도메인 계산(MI 산출 등)은
 *  여기 없습니다. 그건 서버(또는 목 모드에서는 mock.js)의 책임입니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var CONFIG = HW.CONFIG;

  /* ------------------------------------------------------------------ DOM */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  /* --------------------------------------------------------------- 숫자 */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(n) { return Math.round(n || 0).toLocaleString('ko-KR'); }
  function fmt1(n) { return (Math.round((n || 0) * 10) / 10).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function pct(n, digits) { return (n || 0).toFixed(digits == null ? 1 : digits) + '%'; }

  /** 원 단위 금액을 억/만 단위 한글 표기로. 1234500000 → "12.3억 원" */
  function won(v) {
    v = v || 0;
    if (Math.abs(v) >= 100000000) return fmt1(v / 100000000) + '억 원';
    if (Math.abs(v) >= 10000) return fmt(v / 10000) + '만 원';
    return fmt(v) + '원';
  }

  /** 부호를 붙인 증감 표기. sign 이 true 면 ▲/▼ 기호 포함 */
  function delta(v, unit, useArrow) {
    var s = v > 0 ? '+' : v < 0 ? '−' : '';
    var arrow = !useArrow ? '' : (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '');
    return arrow + s + fmt(Math.abs(v)) + (unit || '');
  }

  /* 결정론적 난수 — 새로고침해도 같은 값이 나오도록 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* --------------------------------------------------------------- 날짜 */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nowStamp() {
    var d = new Date();
    return todayISO() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /** 2026-08-06 → "2026년 8월 6일" */
  function korDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || todayISO());
    if (!m) return iso || '';
    return m[1] + '년 ' + Number(m[2]) + '월 ' + Number(m[3]) + '일';
  }

  /* ----------------------------------------------------- 좌표 투영(지도) */
  /* 지도 SVG 는 960x640 좌표계를 씁니다.
   * - 목 데이터: 셀이 이미 x/y(SVG px)를 들고 옵니다. 그대로 사용.
   * - 실데이터: 셀이 lon/lat 을 들고 오면 meta.grid.bbox 기준으로 선형 투영합니다.
   *   (화성시 정도의 범위에서는 등장방형 투영으로 충분합니다.)
   */
  var PROJ = { bbox: null, w: 960, h: 640, pad: 24 };
  /* 지도 높이를 경계에 맞춰 계산합니다.
     화성시는 가로가 세로의 약 1.72배인데 viewBox 를 1.5 로 두면
     위아래에 각각 54px 씩, 세로의 17% 가 빈 띠로 남습니다.
     경계 파일이 바뀌어도 알아서 맞도록 값을 고정하지 않고 계산합니다. */
  function fitHeight(bbox, w) {
    if (!bbox || bbox.length !== 4) return PROJ.h;
    var midLat = (bbox[1] + bbox[3]) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);
    var dx = (bbox[2] - bbox[0]) * kx, dy = (bbox[3] - bbox[1]);
    if (!(dx > 0) || !(dy > 0)) return PROJ.h;
    return Math.round(PROJ.pad * 2 + (w - PROJ.pad * 2) * (dy / dx));
  }

  function setProjection(bbox, w, h) {
    if (bbox && bbox.length === 4) PROJ.bbox = bbox.slice();
    if (w) PROJ.w = w;
    if (h) PROJ.h = h;
  }
  function project(lon, lat) {
    var b = PROJ.bbox;
    if (!b) return { x: 0, y: 0 };
    var lon0 = b[0], lat0 = b[1], lon1 = b[2], lat1 = b[3];
    var midLat = (lat0 + lat1) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);          // 경도 축소 보정
    var dx = (lon1 - lon0) * kx, dy = (lat1 - lat0);
    var innerW = PROJ.w - PROJ.pad * 2, innerH = PROJ.h - PROJ.pad * 2;
    var scale = Math.min(innerW / dx, innerH / dy);
    var offX = PROJ.pad + (innerW - dx * scale) / 2;
    var offY = PROJ.pad + (innerH - dy * scale) / 2;
    return {
      x: offX + (lon - lon0) * kx * scale,
      y: offY + (lat1 - lat) * scale                     // 위도는 위아래 뒤집힘
    };
  }
  /** 셀/정류장 객체에서 SVG 좌표를 얻습니다. x/y 우선, 없으면 lon/lat 투영. */
  function xy(o) {
    if (o && typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
    if (o && typeof o.lon === 'number' && typeof o.lat === 'number') return project(o.lon, o.lat);
    return { x: 0, y: 0 };
  }

  /* ------------------------------------------------------------- 툴팁 */
  var _tt = null;
  function tooltip() {
    if (!_tt) {
      _tt = document.createElement('div');
      _tt.className = 'tt';
      _tt.setAttribute('role', 'status');
      document.body.appendChild(_tt);
    }
    return _tt;
  }
  function showTip(html, ev) {
    var t = tooltip();
    t.innerHTML = html;
    t.style.display = 'block';
    var w = t.offsetWidth, h = t.offsetHeight;
    var cx = ev.clientX != null ? ev.clientX : 0;
    var cy = ev.clientY != null ? ev.clientY : 0;
    var x = cx + 14, y = cy + 12;
    if (x + w > innerWidth - 8) x = cx - w - 12;
    if (y + h > innerHeight - 8) y = cy - h - 10;
    t.style.left = Math.max(6, x) + 'px';
    t.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() { if (_tt) _tt.style.display = 'none'; }
  /* 터치에서는 mouseleave 가 오지 않아 툴팁이 화면에 눌어붙습니다.
     다음 탭이 시작되는 순간 접습니다(탭 대상의 툴팁은 그 뒤 이벤트에서 다시 뜹니다). */
  document.addEventListener('pointerdown', hideTip);

  /* -------------------------------------------------------------- 토스트 */
  var _toasts = null;
  function toast(msg, kind, ms) {
    if (!_toasts) {
      _toasts = document.createElement('div');
      _toasts.className = 'toasts';
      _toasts.setAttribute('aria-live', 'polite');
      document.body.appendChild(_toasts);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.innerHTML = msg;
    _toasts.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, ms || 4200);
  }

  /* --------------------------------------------------------------- 테마 */
  var THEME_KEY = 'hw.theme';
  function applyTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 사생활 보호 모드 */ }
    $$('[data-theme-btn]').forEach(function (b) {
      var cur = mode === 'auto' ? '자동' : (mode === 'dark' ? '다크' : '라이트');
      b.textContent = '테마 · ' + cur;
      b.setAttribute('aria-label', '표시 테마 전환 (현재 ' + cur + ')');
    });
  }
  function initTheme() {
    var saved = 'auto';
    try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* noop */ }
    applyTheme(saved);
    $$('[data-theme-btn]').forEach(function (b) {
      b.addEventListener('click', function () {
        var order = ['auto', 'light', 'dark'];
        var cur = document.documentElement.getAttribute('data-theme') || 'auto';
        applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
      });
    });
  }

  /* ---------------------------------------------------- 파일 다운로드 */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /* ------------------------------------------------------- SVG 헬퍼 */
  /** 위로 자라는 막대: 바닥은 각지고 윗변만 둥근 경로 */
  function barUp(x, baseY, w, h, r) {
    r = Math.min(r == null ? 4 : r, Math.abs(h), w / 2);
    if (h <= 0) return '';
    var y = baseY - h;
    return 'M' + x + ',' + baseY + ' L' + x + ',' + (y + r) +
      ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      ' L' + (x + w - r) + ',' + y +
      ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      ' L' + (x + w) + ',' + baseY + ' Z';
  }
  /** 아래로 자라는 막대 */
  function barDown(x, baseY, w, h, r) {
    r = Math.min(r == null ? 4 : r, Math.abs(h), w / 2);
    if (h <= 0) return '';
    var y = baseY + h;
    return 'M' + x + ',' + baseY + ' L' + x + ',' + (y - r) +
      ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      ' L' + (x + w - r) + ',' + y +
      ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y - r) +
      ' L' + (x + w) + ',' + baseY + ' Z';
  }
  /** 오른쪽으로 자라는 가로 막대 */
  function barRight(baseX, y, h, w, r) {
    r = Math.min(r == null ? 4 : r, Math.abs(w), h / 2);
    if (w <= 0) return '';
    var x = baseX + w;
    return 'M' + baseX + ',' + y + ' L' + (x - r) + ',' + y +
      ' Q' + x + ',' + y + ' ' + x + ',' + (y + r) +
      ' L' + x + ',' + (y + h - r) +
      ' Q' + x + ',' + (y + h) + ' ' + (x - r) + ',' + (y + h) +
      ' L' + baseX + ',' + (y + h) + ' Z';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------- 용어 사전
   * 화면에 쓰인 지표 용어를 공무원이 바로 이해할 수 있게 풀어 씁니다.
   * HTML 에서  <button class="help" data-help="mi">?</button>  로 붙입니다.
   * ------------------------------------------------------------------ */
  var HELP = {
    mi: {
      t: '미스매칭 지수 (MI)',
      d: '수요를 표준화한 값에서 공급을 표준화한 값을 뺀 수치입니다. ' +
         '0이면 수요와 공급이 균형을 이룬 상태이고, 양수가 클수록 수요에 비해 버스 공급이 부족합니다. ' +
         '음수는 공급에 여유가 있다는 뜻입니다.'
    },
    demand: {
      t: '수요지수 D',
      d: '교통카드 실제 승하차와 유동인구를 절반씩 반영해 0~100으로 환산한 값입니다. ' +
         '버스가 없어서 발생하지 못한 통행까지 잡아내기 위해 유동인구를 함께 봅니다.'
    },
    supply: {
      t: '공급지수 S',
      d: '노선 운행빈도와 정류장까지의 도보 접근성을 합쳐 0~100으로 환산한 값입니다.'
    },
    need: {
      t: '고수요·저공급 격자',
      d: '이동 수요는 많은데 버스 공급이 따라가지 못하는 격자입니다. ' +
         '정류장이 도보권 밖이면 <b>신설</b>, 도보권 안이면 <b>증차</b>가 우선 검토 대상입니다. ' +
         '흔히 말하는 대중교통 사각지대가 여기에 해당합니다.'
    },
    drt: {
      t: 'DRT (수요응답형 교통 · 똑버스)',
      d: '수요와 공급이 모두 낮아 정규 노선을 넣기에는 효율이 떨어지는 지역에, ' +
         '호출하면 오는 방식으로 운행하는 교통수단입니다. ' +
         '농촌 지역 이동권 보장에 쓰입니다.'
    },
    potential: {
      t: '잠재수요',
      d: '경기도 유동인구 통계로 추정한 이동 총량입니다. ' +
         '실제 버스 이용 실적이 아니라 <b>버스가 있었다면 발생했을 통행</b>까지 포함한 값이라, ' +
         '사각지대 규모를 가늠하는 데 씁니다.'
    },
    elderly: {
      t: '교통약자 가중',
      d: '고령인구 비율이 높은 격자의 우선순위를 높이는 보정입니다. ' +
         '같은 수요라도 이동 대안이 적은 지역을 먼저 보기 위한 장치입니다.'
    },
    coverage: {
      t: '정류장 커버리지',
      d: '격자에서 가장 가까운 정류장까지의 거리로 계산한 접근성입니다. ' +
         '0에 가까울수록 도보권 밖이며, 0.5 미만이면 배차 증편 대상에서 제외됩니다.'
    },
    peak: {
      t: '첨두 집중률',
      d: '출퇴근 시간대(07–09, 17–19) 승하차가 하루 전체에서 차지하는 비율입니다. ' +
         '높을수록 특정 시간대에 이용이 몰린다는 뜻입니다.'
    },
    estimated: {
      t: '추정치 (실측 아님)',
      d: '교통카드 원자료는 <b>일자별 집계</b>라 시간대 정보가 없습니다. ' +
         '시간대별 승하차는 유동인구의 연령가중 시간배율로 안분해 채운 <b>추정치</b>입니다. ' +
         '하루 총량은 실측이지만, 시간대별 배분은 추정입니다. ' +
         '시간대별 지표를 해석할 때 이 점을 감안하십시오.'
    },
    strategy: {
      t: '왜 목적을 고르나요',
      d: '배치 산출은 <b>최적화 알고리즘</b>입니다. 난수를 쓰지 않으므로 같은 조건이면 ' +
         '항상 같은 결과가 나옵니다. 공문서에 쓰려면 재현이 되어야 하기 때문입니다.<br><br>' +
         '그래서 "다른 안"은 무작위로 만들지 않고 <b>목적을 바꿔서</b> 만듭니다. ' +
         '효율을 최우선으로 할지, 교통약자를 먼저 볼지, 지역 균형을 맞출지에 따라 ' +
         '답이 달라집니다. 어느 목적을 택할지가 곧 정책 판단입니다.<br><br>' +
         '표의 목적 이름을 누르면 그 기준으로 다시 짭니다.'
    },
    costBasis: {
      t: '비용 비교 기준',
      d: '추천 순위는 <b>총사업비</b> 1원당 개선량으로 매깁니다. 예산 한도를 총액으로 재고 ' +
         '있으니 순위도 같은 자로 재야 하기 때문입니다.<br><br>' +
         '다만 총사업비는 <b>1년차 관점</b>입니다. 정류장은 한 번 지으면 끝이지만 ' +
         '똑버스·배차 증편은 이듬해에도 같은 예산이 필요합니다. 다년도로 비교하면 ' +
         '정류장 비중이 더 커집니다.<br><br>' +
         '기준을 연환산으로 바꾸려면 config.js 의 <b>COST.compareBasis</b> 를 ' +
         "'annual' 로 두면 됩니다."
    },
    assumedCost: {
      t: '가정값 사업비',
      d: '정류장·똑버스·증편 단가와 내용연수는 아직 확정되지 않은 <b>시연용 가정값</b>입니다. ' +
         '실제 사업비가 확정되면 <b>config.js</b> 의 COST 를 바꾸고 confirmed 를 true 로 두면 ' +
         '이 표시가 사라집니다.'
    },
    baseline: {
      t: '기준선',
      d: '아무것도 배치하지 않은 현재 상태의 수치입니다. ' +
         '시뮬레이션 결과는 항상 이 값과 비교해 표시됩니다.'
    }
  };

  /** [data-help] 버튼에 설명 툴팁을 붙입니다. 터치 기기를 위해 클릭도 받습니다. */
  function wireHelp(root) {
    $$('[data-help]', root).forEach(function (b) {
      var key = b.getAttribute('data-help');
      var h = HELP[key];
      if (!h) return;
      b.setAttribute('aria-label', h.t + ' 설명');
      b.setAttribute('title', h.t);
      var html = '<b>' + esc(h.t) + '</b><br>' + h.d;
      b.addEventListener('mouseenter', function (e) { showTip(html, e); });
      b.addEventListener('mousemove', function (e) { showTip(html, e); });
      b.addEventListener('mouseleave', hideTip);
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        /* 키보드(Enter/Space)로 누르면 clientX/Y 가 0이라 툴팁이 화면 구석에 뜹니다.
           그때는 버튼 위치를 기준으로 띄웁니다. */
        if (!e.clientX && !e.clientY) {
          var r = b.getBoundingClientRect();
          showTip(html, { clientX: r.left + r.width / 2, clientY: r.bottom + 4 });
        } else showTip(html, e);
      });
    });
  }

  /* --------------------------------------------------------- 상단 내비 */
  /** 각 페이지 상단의 공통 내비게이션을 만들어 넣습니다. */
  function mountTopnav(current) {
    var host = $('[data-topnav]');
    if (!host) return;
    var app = (CONFIG && CONFIG.APP) || {};
    var pages = (CONFIG && CONFIG.PAGES) || { dashboard: 'index.html', simulation: 'simulation.html' };
    var links = [
      { id: 'dashboard', href: pages.dashboard, label: '대시보드' },
      { id: 'simulation', href: pages.simulation, label: '정책 시뮬레이션' }
    ];
    host.innerHTML =
      '<div class="tn-in">' +
      '<div class="brand"><i></i>' + esc(app.name || '') +
      (app.isMockData ? '<span>MOCK DATA</span>' : '') + '</div>' +
      '<nav class="navlinks" aria-label="주요 화면">' +
      links.map(function (l) {
        return '<a href="' + l.href + '"' + (l.id === current ? ' aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
      }).join('') +
      '</nav>' +
      '<div class="tn-sp"></div>' +
      '<div class="tn-act">' +
      '<button class="btn sm" data-theme-btn type="button">테마 · 자동</button>' +
      '<button class="btn sm primary" data-report-open type="button"><i>▤</i>AI 보고서 생성</button>' +
      '</div></div>';
  }

  HW.core = {
    $: $, $$: $$, el: el, esc: esc,
    HELP: HELP, wireHelp: wireHelp,
    clamp: clamp, fmt: fmt, fmt1: fmt1, pct: pct, won: won, delta: delta,
    mulberry32: mulberry32,
    todayISO: todayISO, nowStamp: nowStamp, korDate: korDate,
    setProjection: setProjection, fitHeight: fitHeight, project: project, xy: xy,
    showTip: showTip, hideTip: hideTip, toast: toast,
    initTheme: initTheme, applyTheme: applyTheme,
    downloadBlob: downloadBlob,
    barUp: barUp, barDown: barDown, barRight: barRight,
    mountTopnav: mountTopnav
  };
})(window);
