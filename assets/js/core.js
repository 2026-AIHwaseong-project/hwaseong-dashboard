/* ============================================================================
 *  core.js — 공용 유틸리티 · UI 헬퍼 · 좌표 투영
 * ----------------------------------------------------------------------------
 *  화면 로직이 공통으로 쓰는 것들만 모았습니다. 도메인 계산(MI 산출 등)은
 *  여기 없습니다. 그건 서버의 책임입니다.
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
  /** project() 의 역함수 — SVG 좌표 → 경위도. 카카오 배경 지도(map.js)를
      SVG 의 확대·이동 상태에 맞춰 따라오게 할 때만 씁니다. */
  function unproject(x, y) {
    var b = PROJ.bbox;
    if (!b) return { lon: 0, lat: 0 };
    var lon0 = b[0], lat0 = b[1], lon1 = b[2], lat1 = b[3];
    var midLat = (lat0 + lat1) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);
    var dx = (lon1 - lon0) * kx, dy = (lat1 - lat0);
    var innerW = PROJ.w - PROJ.pad * 2, innerH = PROJ.h - PROJ.pad * 2;
    var scale = Math.min(innerW / dx, innerH / dy);
    var offX = PROJ.pad + (innerW - dx * scale) / 2;
    var offY = PROJ.pad + (innerH - dy * scale) / 2;
    return {
      lon: lon0 + (x - offX) / (kx * scale),
      lat: lat1 - (y - offY) / scale
    };
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
      d: 'SGIS 격자 거주인구에 통행 원단위(1인당 하루 버스통행 0.25회 가정)를 곱해 추정한 이동 총량입니다. ' +
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
         '정류장 비중이 더 커집니다.'
    },
    assumedCost: {
      t: '단가 근거',
      d: '<b>똑버스</b>는 경기교통공사 표준운송원가(경기도 \'23년 526,301원/일·대, ' +
         '수원시 \'24년 560,428원)와 대조해 6~12% 보수적으로 잡았고, ' +
         '<b>배차 증편</b>은 화성시 마을버스 345대의 연간 운송원가 322억 원 ' +
         '(대당 연 9,333만 원)과 1.8% 차이입니다. ' +
         '<b>정류장 신설</b>만 아직 <b>가정값</b>입니다 — 정보안내기(BIT) 단가 ' +
         '1,600만 원(서울시 2016)은 확인했지만 승차대 구조물 단가는 지자체 ' +
         '설계내역서 안에만 있어 공개자료로 확인하지 못했습니다. ' +
         '실제 사업비가 확정되면 설정에 반영해 재산정해야 합니다.'
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
    /* 화성특례시 공식 CI. 기관을 말하는 것은 이 이미지이고, 그 옆 서비스명이
       이 도구의 이름입니다. alt 는 기관명으로 둡니다 — 스크린리더에게 이
       이미지의 뜻은 '화성특례시' 이지 서비스 이름이 아닙니다. */
    host.innerHTML =
      '<div class="tn-in">' +
      '<button class="tn-menu" data-menu-btn type="button" aria-label="메뉴 열기" ' +
      'aria-expanded="false" aria-controls="tn-drawer">' + icon('menu', 20) + '</button>' +
      '<div class="brand">' +
      '<img class="ci" src="assets/img/hwaseong-ci.png" alt="화성특례시" ' +
      'width="512" height="151" decoding="async">' +
      '<span class="svc">' + esc(app.navName || app.name || '') + '</span></div>' +
      '<div class="tn-sp"></div>' +
      '<div class="tn-act">' +
      '<button class="btn sm" data-theme-btn type="button">테마 · 자동</button>' +
      '</div></div>' +
      /* 서랍 메뉴 — 화면 이동과 보고서 생성이 모두 여기로 들어왔습니다.
         테마 버튼만 막대에 남는 이유: 테마는 "지금 이 화면"을 바꾸는 스위치라
         숨기면 찾을 수 없고, 이동·생성은 목적지가 분명해 서랍 안이 맞습니다. */
      '<div class="tn-scrim" data-menu-scrim></div>' +
      '<nav class="tn-drawer" id="tn-drawer" aria-label="주요 화면">' +
      links.map(function (l) {
        return '<a href="' + l.href + '"' + (l.id === current ? ' aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
      }).join('') +
      '<button class="tn-item" data-guide-open type="button">' +
      icon('help') + '사용 안내</button>' +
      '<div class="tn-cut" role="separator"></div>' +
      /* 서랍의 마지막 항목은 이동이 아니라 **문서를 발행하는 동작**입니다.
         화려하게 만들지 않습니다 — 이 화면의 세계에 그라디언트·글로우는 없습니다.
         대신 관공서 서식의 발행 버튼이 그렇듯 무엇을 만드는지(주 라벨)와 무엇으로
         나오는지(부제)를 두 줄로 밝힙니다. 부제 문구는 report.js 의 실제 출력과
         맞춘 것입니다 — 클라이언트 방식에서 엑셀은 .xlsx, 한글은 .rtf 입니다. */
      '<button class="btn primary tn-issue" data-report-open type="button">' +
      icon('doc', 18) +
      '<span class="ti-tx"><b>AI 보고서 생성</b>' +
      '<span>초안 작성 · 한글 · 엑셀 저장</span></span></button>' +
      '</nav>';

    var mbtn = $('[data-menu-btn]', host);
    var drawer = $('#tn-drawer', host);
    function setMenu(open) {
      host.classList.toggle('menu-open', open);
      mbtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      mbtn.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
    }
    mbtn.addEventListener('click', function () {
      setMenu(!host.classList.contains('menu-open'));
    });
    $('[data-menu-scrim]', host).addEventListener('click', function () { setMenu(false); });
    /* 보고서·안내 버튼은 모달을 띄우므로 서랍이 그대로 열려 있으면 모달
       뒤에 서랍+스크림이 겹칩니다. 링크든 버튼이든 고르면 서랍은 임무 끝. */
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a, button')) setMenu(false);
    });
    $('[data-guide-open]', host).addEventListener('click', openGuide);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && host.classList.contains('menu-open')) setMenu(false);
    });

    mountIssuer();
    mountIcons();
  }

  /** 정적 HTML 에 놓인 버튼에도 아이콘 한 벌을 붙입니다.
   *  `data-ic="save"` 는 글자 앞, `data-ic-after="arrow"` 는 글자 뒤에 넣습니다.
   *  JS 가 만드는 버튼은 icon() 을 직접 부르면 되지만, index.html·simulation.html
   *  안에 그대로 적혀 있는 버튼([이 격자로 시뮬레이션 하기 →]·[시나리오 저장])은
   *  그럴 자리가 없어 아이콘이 없거나 → 같은 글자로 때워져 있었습니다.
   *  이미 아이콘을 들고 있으면 건너뛰므로 두 번 불러도 안전합니다. */
  function mountIcons() {
    $$('[data-ic],[data-ic-after]').forEach(function (b) {
      if (b.querySelector('.ic')) return;
      var pre = b.getAttribute('data-ic');
      var post = b.getAttribute('data-ic-after');
      if (pre) b.insertAdjacentHTML('afterbegin', icon(pre));
      if (post) b.insertAdjacentHTML('beforeend', icon(post));
    });
  }

  /** 푸터의 발행 주체 표기.
   *  config.js 의 APP.org('화성특례시')·APP.dept('교통정책과')는 지금까지
   *  보고서 파일 안에만 들어가고 화면에는 한 번도 안 나왔습니다. 관공서가
   *  발행한 문서를 세계관으로 잡아 놓고 정작 화면에는 발행 부서가 없던 셈입니다.
   *  화면을 캡처하거나 인쇄해 회의에 들고 갔을 때 출처가 문서 안에 남아야
   *  하므로 푸터 말미에 한 줄로 답니다. 값은 새로 만들지 않고 그대로 읽습니다.
   *  날짜는 데이터의 기준일자가 아니라 **화면을 띄운 날**이라 '출력' 으로
   *  적습니다 — 기준일자는 대시보드 상단의 '최종 갱신' 이 따로 말합니다. */
  function mountIssuer() {
    var app = (CONFIG && CONFIG.APP) || {};
    var who = [app.org, app.dept].filter(Boolean).join(' ');
    if (!who) return;
    $$('[data-issuer]').forEach(function (h) {
      h.innerHTML = '<b>' + esc(who) + '</b><span class="is-sp"></span>' +
        '<span>출력 ' + esc(todayISO()) + '</span>';
    });
  }

  /* ----------------------------------------------------------- 사용 안내
     글 목록 대신 화면 축소판 그림에 번호를 얹어 설명합니다 — 처음 보는
     사람(심사위원)이 3분 안에 "어디를 눌러야 하는지"를 눈으로 익히는 용도.
     그림은 실제 대시보드 배치(시간대 탭 / 지도 / 우선순위)를 그대로 축소한
     SVG 라, 테마 변수(currentColor 계열)를 따라 다크 모드에서도 맞습니다. */
  var guideModal = null;

  function guideHero() {
    var tabs = ['출근', '낮', '퇴근', '심야'].map(function (t, i) {
      var x = 40 + i * 68;
      return i === 0
        ? '<rect x="' + x + '" y="12" width="64" height="30" rx="8" fill="var(--brand)"/>' +
          '<text x="' + (x + 32) + '" y="31" text-anchor="middle" fill="#fff" font-weight="700">' + t + '</text>' +
          '<rect x="' + (x + 12) + '" y="37" width="40" height="2.5" rx="1.2" fill="var(--brand-2)"/>'
        : '<rect x="' + x + '" y="12" width="64" height="30" rx="8" fill="var(--bg)" stroke="var(--line)"/>' +
          '<text x="' + (x + 32) + '" y="31" text-anchor="middle" fill="var(--ink2)">' + t + '</text>';
    }).join('');

    /* 격자 8×4 — 대부분 옅은 파랑(공급 충분), 오른쪽 위로 갈수록 붉게(부족).
       2행 5열이 "클릭해 볼 붉은 격자" 주인공입니다. */
    var CELL = ['....odro', '...obrRo', '....oob.', '........'];
    var FILL = { '.': 'var(--brand-soft)', b: 'var(--brand)', o: 'var(--brand-2)', d: 'var(--brand-2)', r: 'var(--bad)', R: 'var(--bad)' };
    var cells = '';
    CELL.forEach(function (row, r) {
      row.split('').forEach(function (c, col) {
        var x = 56 + col * 41, y = 92 + r * 41;
        cells += '<rect x="' + x + '" y="' + y + '" width="35" height="35" rx="4" fill="' + FILL[c] + '"' +
          (c === '.' ? '' : c === 'o' || c === 'd' ? ' opacity=".55"' : c === 'b' ? ' opacity=".45"' : '') + '/>';
        if (c === 'R') {
          cells += '<rect x="' + (x - 3) + '" y="' + (y - 3) + '" width="41" height="41" rx="6" ' +
            'fill="none" stroke="var(--bad)" stroke-width="2.2"/>' +
            /* 마우스 커서 */
            '<path transform="translate(' + (x + 24) + ' ' + (y + 24) + ')" ' +
            'd="M0 0l5.2 13.2 2.1-5.4 5.4-2.1z" fill="var(--ink)" stroke="var(--card)" stroke-width="1.4"/>';
        }
      });
    });

    /* 우선순위 Top 목록 — 순위 칩과 길이가 줄어드는 붉은 막대 */
    var rows = [128, 104, 82, 62].map(function (w, i) {
      var y = 96 + i * 30;
      return '<rect x="450" y="' + y + '" width="20" height="20" rx="6" fill="var(--brand-soft)"/>' +
        '<text x="460" y="' + (y + 14) + '" text-anchor="middle" fill="var(--brand-ink)" font-weight="700" font-size="11">' + (i + 1) + '</text>' +
        '<rect x="478" y="' + (y + 5) + '" width="' + w + '" height="10" rx="5" fill="var(--bad)" opacity="' + (0.9 - i * 0.18) + '"/>';
    }).join('');

    function badge(n, cx, cy) {
      return '<circle cx="' + cx + '" cy="' + cy + '" r="11" fill="var(--brand)" stroke="var(--card)" stroke-width="2"/>' +
        '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" fill="#fff" font-weight="700" font-size="12">' + n + '</text>';
    }

    return '<svg class="ghero" viewBox="0 0 660 286" role="img" aria-label="대시보드 화면 안내도">' +
      '<g font-size="11">' + tabs +
      /* 지도 카드 */
      '<rect x="40" y="58" width="380" height="212" rx="10" fill="var(--bg)" stroke="var(--line)"/>' +
      '<text x="56" y="80" fill="var(--ink3)" font-size="10">미스매칭 지도 — 붉을수록 공급 부족</text>' +
      cells +
      /* 우선순위 카드 */
      '<rect x="436" y="58" width="186" height="212" rx="10" fill="var(--bg)" stroke="var(--line)"/>' +
      '<text x="450" y="80" fill="var(--ink3)" font-size="10">노선 조정 우선순위 Top10</text>' + rows +
      /* 시뮬레이션 버튼 */
      '<rect x="450" y="228" width="158" height="28" rx="8" fill="var(--brand)"/>' +
      '<text x="529" y="246" text-anchor="middle" fill="#fff" font-size="10.5" font-weight="700">이 격자로 시뮬레이션 →</text>' +
      badge(1, 28, 27) + badge(2, 300, 131) + badge(3, 622, 70) + badge(4, 622, 242) +
      '</g></svg>';
  }

  function buildGuide() {
    if (guideModal) return guideModal;
    var steps = [
      ['시간대를 바꿔보세요', '출근·낮·퇴근·심야마다 답이 달라집니다 — 심야에는 공급 부족 격자가 30개에서 39개로 늘어납니다.'],
      ['붉은 격자를 클릭', '붉을수록 "수요는 있는데 버스가 없는 곳"입니다. 클릭하면 상세 수치와 경유 노선이 아래에 나타납니다.'],
      ['우선순위에서 대상 선택', '오른쪽 Top10이 조정 후보 목록입니다. 항목을 고르면 해당 격자를 지도에서 바로 확인할 수 있습니다.'],
      ['시뮬레이션 → 보고서', '정류장·똑버스·증편을 놓아 예산 안에서 효과를 비교하고, AI 보고서로 회의 자료를 만듭니다.']
    ];
    guideModal = el('div', { 'class': 'modal', id: 'guide-modal' });
    guideModal.innerHTML =
      '<div class="veil" data-guide-close></div>' +
      '<div class="sheet guide-sheet" role="dialog" aria-modal="true" aria-label="사용 안내">' +
      '<header><h2>사용 안내</h2>' +
      '<span class="hs">붉은 격자를 찾아 → 눌러보고 → 시뮬레이션으로</span>' +
      '<span class="sp"></span>' +
      '<button class="xbtn" data-guide-close type="button" aria-label="닫기">' + icon('close', 17) + '</button></header>' +
      '<div class="body">' + guideHero() +
      '<div class="gsteps">' +
      steps.map(function (s, i) {
        return '<div class="gstep"><b><span class="gnum">' + (i + 1) + '</span>' +
          esc(s[0]) + '</b><p>' + esc(s[1]) + '</p></div>';
      }).join('') +
      '</div>' +
      '<p class="gfoot">786개 격자 × 4개 시간대 · 공공데이터 실측 · 승차 예측 회귀(공간 교차검증) 0.852</p>' +
      '</div>';
    document.body.appendChild(guideModal);
    $$('[data-guide-close]', guideModal).forEach(function (b) {
      b.addEventListener('click', closeGuide);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && guideModal.classList.contains('open')) closeGuide();
    });
    return guideModal;
  }
  function openGuide() { buildGuide().classList.add('open'); }
  function closeGuide() { if (guideModal) guideModal.classList.remove('open'); }

  /* ── 아이콘 ─────────────────────────────────────────────────────────
     한 벌로 직접 그립니다. 예전에는 ▤ · ✦ 같은 글자 기호를 아이콘 자리에
     썼는데, 그건 폰트마다 모양·굵기·정렬이 제각각이라 나란히 놓으면 한 벌로
     안 보입니다(✦ 는 폰트에 따라 아예 네모로 뜹니다).
     규칙: 24 격자 · 획 1.7 · 끝과 모서리는 둥글게 · 채움 없음.
     currentColor 를 쓰므로 버튼 색이 바뀌면 아이콘도 따라갑니다. */
  var ICONS = {
    /* 문서 — 보고서 */
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
         '<path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    /* 반짝임 — AI 가 만들어 주는 것 */
    spark: '<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z"/>' +
           '<path d="M18.5 3.5v3M20 5h-3"/>',
    /* 돋보기 — 검색 */
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>',
    /* 작대기 셋 — 메뉴 서랍 */
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    /* 물음표 동그라미 — 사용 안내 */
    help: '<circle cx="12" cy="12" r="8.5"/>' +
          '<path d="M9.7 9.5a2.35 2.35 0 1 1 3.4 2.1c-.75.4-1.1.9-1.1 1.7v.3"/>' +
          '<path d="M12 16.4h.01"/>',
    /* ── 아래 넷은 그동안 유니코드 글자로 때우던 자리입니다 ────────────────
       닫기 ×(U+00D7)·확대 +·축소 −(U+2212)·이동 →(U+2192) 를 그대로 썼는데,
       DESIGN.md 가 "이모지·유니코드 글자를 아이콘 자리에" 를 금지 목록에 올려
       둔 바로 그 경우입니다. 폰트마다 굵기·크기·광학 중심이 달라 옆의 SVG
       아이콘과 한 벌로 보이지 않고, ×(곱셈 기호)는 폰트에 따라 눈에 띄게
       작거나 위로 뜹니다. 같은 규칙(24격자·획 1.7·둥근 끝)으로 다시 그립니다. */
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    plus:  '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    arrow: '<path d="M4.5 12h14"/><path d="M12.5 6l6 6-6 6"/>',
    /* 저장 — 시나리오 보관. 본체·라벨·문서 세 획으로 단순화했습니다 */
    save:  '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h9l4 4v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/>' +
           '<path d="M8.5 4.5v4.5h6.5V4.5"/><path d="M8 19.5V14h8v5.5"/>'
  };
  /** 인라인 SVG 아이콘 한 개. size 는 픽셀(기본 16). */
  function icon(name, size) {
    var d = ICONS[name];
    if (!d) return '';
    var s = size || 16;
    return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + '</svg>';
  }
  HW.icon = icon;

  HW.core = {
    $: $, $$: $$, el: el, esc: esc, icon: icon,
    HELP: HELP, wireHelp: wireHelp,
    clamp: clamp, fmt: fmt, fmt1: fmt1, pct: pct, won: won, delta: delta,
    todayISO: todayISO, nowStamp: nowStamp, korDate: korDate,
    setProjection: setProjection, fitHeight: fitHeight, project: project, xy: xy, unproject: unproject,
    showTip: showTip, hideTip: hideTip, toast: toast,
    initTheme: initTheme, applyTheme: applyTheme,
    downloadBlob: downloadBlob,
    barUp: barUp, barDown: barDown, barRight: barRight,
    mountTopnav: mountTopnav
  };
})(window);
