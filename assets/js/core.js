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
    clamp: clamp, fmt: fmt, fmt1: fmt1, pct: pct, won: won, delta: delta,
    mulberry32: mulberry32,
    todayISO: todayISO, nowStamp: nowStamp, korDate: korDate,
    setProjection: setProjection, project: project, xy: xy,
    showTip: showTip, hideTip: hideTip, toast: toast,
    initTheme: initTheme, applyTheme: applyTheme,
    downloadBlob: downloadBlob,
    barUp: barUp, barDown: barDown, barRight: barRight,
    mountTopnav: mountTopnav
  };
})(window);
