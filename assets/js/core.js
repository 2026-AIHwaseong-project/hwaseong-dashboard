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
  /** "2026-08-23 14:03" · withSeconds 를 주면 "2026-08-23 14:03:27".
      초까지 필요한 곳은 **같은 분 안에 여러 건이 쌓이는 목록**입니다 —
      보고서 기록이 그렇습니다(연달아 만들면 분 단위로는 구별이 안 됩니다).
      시나리오 저장은 사람이 이름을 붙이므로 분 단위로 충분합니다. */
  function nowStamp(withSeconds) {
    var d = new Date();
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return todayISO() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) +
      (withSeconds ? ':' + p2(d.getSeconds()) : '');
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
       이미지의 뜻은 '화성특례시' 이지 서비스 이름이 아닙니다.

       CI 를 두 벌 싣습니다. 컬러 시그니처는 밝은 바탕용, 흰색 1도 반전은
       어두운 바탕용이고 CSS 가 테마에 따라 한쪽만 보여 줍니다.
       예전에는 한 벌만 두고 다크에서 흰 판을 깔았는데, 어두운 막대 위에
       흰 알약이 떠 있어 배경이 비쳐야 할 자리를 막았습니다.

       반전본은 alt 를 비우고 aria-hidden 을 겁니다 — 같은 기관명을 두 번
       읽어 주면 스크린리더에서 "화성특례시 화성특례시" 가 됩니다.

       전체를 <a> 로 감쌉니다. 로고를 눌러 첫 화면으로 가는 것은 웹에서
       기대되는 동작이고, 지금은 서랍을 열어야만 이동할 수 있었습니다. */
    host.innerHTML =
      '<div class="tn-in">' +
      '<button class="tn-menu" data-menu-btn type="button" aria-label="메뉴 열기" ' +
      'aria-expanded="false" aria-controls="tn-drawer">' + icon('menu', 20) + '</button>' +
      '<a class="brand" href="' + pages.dashboard + '"' +
      (current === 'dashboard' ? ' aria-current="page"' : '') + '>' +
      '<img class="ci ci-color" src="assets/img/hwaseong-ci.png" alt="화성특례시" ' +
      'width="512" height="113" decoding="async">' +
      '<img class="ci ci-reverse" src="assets/img/hwaseong-ci-dark.png" alt="" ' +
      'aria-hidden="true" width="512" height="113" decoding="async">' +
      '<span class="svc">' + esc(app.navName || app.name || '') + '</span></a>' +
      '<div class="tn-sp"></div>' +
      '<div class="tn-act">' +
      '<button class="btn sm" data-guide-open type="button">' +
      icon('help') + '사용 안내</button>' +
      '<button class="btn sm" data-theme-btn type="button">테마 · 자동</button>' +
      '</div></div>' +
      /* 서랍 메뉴 — 화면 이동과 보고서 생성이 여기로 들어왔습니다.
         막대에 남는 것은 "지금 이 화면"에 작용하는 스위치들뿐입니다 —
         테마, 그리고 화면 위를 순서대로 비추는 사용 안내(투어). */
      '<div class="tn-scrim" data-menu-scrim></div>' +
      '<nav class="tn-drawer" id="tn-drawer" aria-label="주요 화면">' +
      links.map(function (l) {
        return '<a href="' + l.href + '"' + (l.id === current ? ' aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
      }).join('') +
      /* AI 도우미는 여기 두지 않습니다 — 우측 하단 런처(chat.js)가 상시 떠 있어
         서랍에 또 두면 같은 곳으로 가는 문이 둘이 됩니다. */
      '<div class="tn-cut" role="separator"></div>' +
      /* 관리자 콘솔. 분석 화면들과 성격이 달라 구분선 아래에 둡니다.
         서버가 ADMIN_TOKEN 을 요구하면 그 화면에서 토큰을 묻고, 비어 있으면
         바로 들어갑니다(운영 정책은 서버가 정하고 여기는 문만 답니다). */
      '<a class="tn-item" href="' + (pages.admin || 'admin.html') + '"' +
      ('admin' === current ? ' aria-current="page"' : '') + '>' +
      icon('gear') + '관리자 콘솔</a>' +
      '<div class="tn-cut" role="separator"></div>' +
      /* 서랍의 마지막 항목은 이동이 아니라 **문서를 다루는 동작**입니다.
         화려하게 만들지 않습니다 — 이 화면의 세계에 그라디언트·글로우는 없습니다.
         대신 관공서 서식의 발행 버튼이 그렇듯 무엇을 여는지(주 라벨)와 거기서
         무엇을 하는지(부제)를 두 줄로 밝힙니다.
         부제는 클릭 결과와 반드시 맞춰야 합니다 — 예전에는 '초안 작성 · 한글 ·
         엑셀 저장'이었고 실제로 누르면 곧바로 생성이 나갔습니다. 지금은 지난
         기록 목록이 먼저 뜨고 거기서 [AI 보고서 생성]을 눌러야 만들어지므로,
         부제가 그대로면 버튼이 화면을 거짓말하게 됩니다. */
      '<button class="btn primary tn-issue" data-report-open type="button">' +
      icon('doc', 18) +
      '<span class="ti-tx"><b>AI 보고서</b>' +
      '<span>지난 기록 · 새 초안 만들기</span></span></button>' +
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
    /* 안내 진입점은 막대 말고도 지도 머리 등 여러 곳에 둡니다 — "매뉴얼
       없이도"는 안내를 잘 만드는 것보다 잘 보이는 곳에 두는 문제라서요. */
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-guide-open]')) startTour(0);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && host.classList.contains('menu-open')) setMenu(false);
    });

    mountIssuer();
    mountIcons();

    /* 투어가 다른 화면으로 넘어오며 남겨 둔 이어가기 표식. 화면 골격이
       그려진 다음에 읽어야 하므로 topnav 장착 끝에서 소비합니다. */
    _page = current;
    var pend = null;
    try {
      pend = sessionStorage.getItem(TOUR_STEP_KEY);
      if (pend !== null) sessionStorage.removeItem(TOUR_STEP_KEY);
    } catch (e) { /* noop */ }
    if (pend !== null) setTimeout(function () { startTour(+pend); }, 400);
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
     팝업 설명서 대신 화면 그 자체를 안내판으로 씁니다. 화면을 어둡게 깔고
     실제 요소에만 구멍(스포트라이트)을 내 순서대로 비추는 투어입니다.
     투어 동안 화면은 조작할 수 없습니다 — 어둠막이 모든 입력을 삼키고,
     사용자는 [이전]·[다음]·[종료]와 우상단 × 만 누릅니다. 단계가 다른
     화면에 있으면 실제로 이동했다가, 끝나면 시작한 화면으로 돌아옵니다. */
  var TOUR_STEP_KEY = 'hw.tourStep', TOUR_RET_KEY = 'hw.tourReturn';
  var _page = '';                    // mountTopnav 이 채우는 현재 화면 id
  var TOUR = [
    { page: 'dashboard', targets: ['.mapcard'],
      text: '시간대를 변경하고 버스 공급이 부족한 지역을 찾아보세요' },
    /* align:'center' — 1→[다음]으로 오든 3→[이전] 새로고침으로 오든 같은
       자리에 보이도록, 이 단계는 조건 없이 항상 가운데로 스크롤합니다 */
    { page: 'dashboard', targets: ['#simLink2'], reveal: '#simLink2', align: 'center',
      text: '정책을 적용했을 때의 변화를 시뮬레이션으로 확인해보세요' },
    { page: 'simulation', targets: ['#tools', '#btnRecommend'],
      text: '직접 수단을 배치해보거나 AI 추천 배치안을 받아 확인하고 시나리오를 저장해 보세요' },
    { menu: true, targets: ['.tn-issue'],
      text: '메뉴 버튼을 눌러 다양한 기능을 사용할 수 있어요. AI 보고서 버튼을 클릭해 AI 보고서를 생성, 저장할 수 있어요. 마음에 들지 않는 부분은 메시지를 보내 수정해 보세요' },
    { menu: true, targets: ['.tn-drawer a[href$="admin.html"]'],
      text: '관리자 콘솔 기능으로 데이터를 수정할 수 있어요' },
    { targets: ['.chat-launch'],
      text: 'AI 챗봇으로 무엇이든 물어보세요' }
  ];
  var tour = null;                   // { root, dim, bubble } — 떠 있는 동안만
  var tourIdx = -1;
  var tourRevealed = null;           // 이 단계가 잠시 보이게 만든 요소(원래 hidden)

  function tourHref(page) {
    var pages = (CONFIG && CONFIG.PAGES) || {};
    return page === 'simulation' ? (pages.simulation || 'simulation.html')
                                 : (pages.dashboard || 'index.html');
  }
  function setDrawer(open) {
    var host = $('[data-topnav]');
    if (host) host.classList.toggle('menu-open', open);
  }

  function tourBlockKeys(e) {
    if (e.key === 'Escape') { endTour(); return; }
    /* 스크롤·이동 계열 키 차단 — 투어 중 화면은 구경만 합니다 */
    if (!e.target.closest('.tour-bubble') &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
         'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(e.key) !== -1) e.preventDefault();
  }
  function tourBlockWheel(e) { e.preventDefault(); }
  function onTourResize() { if (tour && tourIdx >= 0) showTourStep(tourIdx); }

  /* 단계 규칙대로 스크롤을 맞춥니다 — 진입할 때만이 아니라, 레이아웃이
     늦게 그려지며 대상이 흘러내려 갔을 때(tourWatch)도 다시 불러 자리를
     지킵니다. 서랍·챗봇 단계는 fixed 라 스크롤이 필요 없습니다.
     ① 대상이 두 곳으로 갈라진 단계(3단계): 모바일에서 아래쪽(AI 추천)이
        화면 밖으로 빠지므로, 말풍선 자리(RESERVE)와 상단 내비 머리(TOPM)를
        뺀 공간의 가운데에 묶음을 둡니다. 넘치면 머리부터 보이게 맞춥니다.
     ② align:'center' 단계: 진입 경로와 무관하게 항상 가운데로.
     ③ 그 외: 벗어나 있을 때만 가운데로 끌어옵니다. */
  function alignTourScroll(step, els) {
    if (step.menu || !els.length) return;
    if (els.length > 1) {
      var u = els.reduce(function (a, n) {
        var r = n.getBoundingClientRect();
        return { top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) };
      }, { top: 1e9, bottom: -1e9 });
      var vh = (window.visualViewport && window.visualViewport.height) || innerHeight;
      /* 위 여백은 고정값이 아니라 상단 내비의 실제 높이로 잽니다 — 모바일은
         막대가 줄바꿈되며 76px 보다 높아져, 고정값이면 구멍 머리가 배너
         밑에 깔립니다. sticky 라 bottom 이 곧 화면에서 차지하는 높이입니다. */
      var nav = $('.topnav');
      var RESERVE = 150;
      var TOPM = (nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 60) + 16;
      var usable = Math.max(TOPM + 120, vh - RESERVE);
      var uh = u.bottom - u.top;
      var want = uh <= usable - TOPM ? TOPM + (usable - TOPM - uh) / 2 : TOPM;
      var delta = u.top - want;
      if (Math.abs(delta) > 8) window.scrollBy(0, delta);
    } else {
      var r0 = els[0].getBoundingClientRect();
      if (step.align === 'center' || r0.top < 0 || r0.bottom > innerHeight) {
        els[0].scrollIntoView({ block: 'center' });
      }
    }
  }

  /* 화면 이동 직후에는 데이터·폰트가 마저 그려지며 레이아웃이 움직여서,
     진입 순간에 잰 구멍 좌표가 곧 어긋납니다(특히 3단계 시뮬레이션 진입과
     [이전]으로 대시보드에 되돌아올 때). 투어가 떠 있는 동안 대상 위치를
     주기적으로 다시 재서, 움직였으면 스포트라이트를 그 자리로 따라 붙입니다. */
  function tourWatch() {
    if (!tour || tourIdx < 0 || !tour.els) return;
    if (tour.els.some(function (n) { return !n.isConnected; })) {
      showTourStep(tourIdx);   // 화면이 다시 그려져 요소 자체가 바뀜 — 재탐색
      return;
    }
    var moved = tour.els.some(function (n, k) {
      var r = n.getBoundingClientRect(), d = tour.rects[k];
      return Math.abs(r.left - d.left) > 1.5 || Math.abs(r.top - d.top) > 1.5 ||
        Math.abs(r.width - d.width) > 1.5 || Math.abs(r.height - d.height) > 1.5;
    });
    if (moved) {
      /* 구멍만 따라 그리지 않고 스크롤 정렬부터 다시 — 늦게 그려진 카드가
         대상을 화면 밖으로 밀어낸 경우(모바일 3→2, 4→3 복귀) 제자리로. */
      alignTourScroll(TOUR[tourIdx], tour.els);
      renderTourStep(TOUR[tourIdx], tourIdx, tour.els, false);
    }
  }

  function startTour(i) {
    try {
      if (!sessionStorage.getItem(TOUR_RET_KEY)) sessionStorage.setItem(TOUR_RET_KEY, location.href);
    } catch (e) { /* noop */ }
    if (!tour) {
      var root = el('div', { 'class': 'tour' });
      root.innerHTML =
        '<svg class="tour-dim" aria-hidden="true"></svg>' +
        '<div class="tour-bubble" role="dialog" aria-label="사용 안내"></div>' +
        '<button class="tour-x" type="button" aria-label="사용 안내 닫기">' + icon('close', 18) + '</button>';
      document.body.appendChild(root);
      $('.tour-x', root).addEventListener('click', endTour);
      root.addEventListener('click', function (e) {
        var go = e.target.closest('[data-tour-go]');
        if (go) showTourStep(+go.getAttribute('data-tour-go'));
        else if (e.target.closest('[data-tour-end]')) endTour();
      });
      tour = {
        root: root, dim: $('.tour-dim', root), bubble: $('.tour-bubble', root),
        els: null, rects: null, watch: setInterval(tourWatch, 350)
      };
      window.addEventListener('keydown', tourBlockKeys, true);
      window.addEventListener('wheel', tourBlockWheel, { passive: false });
      window.addEventListener('touchmove', tourBlockWheel, { passive: false });
      window.addEventListener('resize', onTourResize);
    }
    document.documentElement.classList.add('touring');
    showTourStep(i);
  }

  function endTour() {
    if (tourRevealed) { tourRevealed.hidden = true; tourRevealed = null; }
    setDrawer(false);
    document.documentElement.classList.remove('touring');
    if (tour) {
      clearInterval(tour.watch);
      window.removeEventListener('keydown', tourBlockKeys, true);
      window.removeEventListener('wheel', tourBlockWheel);
      window.removeEventListener('touchmove', tourBlockWheel);
      window.removeEventListener('resize', onTourResize);
      tour.root.parentNode.removeChild(tour.root);
      tour = null;
    }
    tourIdx = -1;
    var ret = null;
    try {
      ret = sessionStorage.getItem(TOUR_RET_KEY);
      sessionStorage.removeItem(TOUR_RET_KEY);
      sessionStorage.removeItem(TOUR_STEP_KEY);
    } catch (e) { /* noop */ }
    /* 투어가 화면을 옮겨 다녔으면, 시작했던 화면으로 되돌린다 */
    if (ret) {
      var a = document.createElement('a');
      a.href = ret;
      if (a.pathname !== location.pathname) location.href = ret;
    }
  }

  function showTourStep(i, tries) {
    if (i < 0 || i >= TOUR.length) { endTour(); return; }
    var step = TOUR[i];

    /* 이 단계가 다른 화면 것이면 이어가기 표식을 남기고 실제로 이동 */
    if (step.page && _page && step.page !== _page) {
      try { sessionStorage.setItem(TOUR_STEP_KEY, String(i)); } catch (e) { /* noop */ }
      location.href = tourHref(step.page);
      return;
    }
    tourIdx = i;

    /* 단계 부수효과 — 서랍 열기/닫기, 숨은 버튼 잠시 보이기.
       .touring 이 서랍 트랜지션을 꺼 두어 좌표를 바로 잴 수 있습니다. */
    setDrawer(!!step.menu);
    if (tourRevealed && (!step.reveal || $(step.reveal) !== tourRevealed)) {
      tourRevealed.hidden = true;
      tourRevealed = null;
    }
    if (step.reveal) {
      var rv = $(step.reveal);
      if (rv && rv.hidden) { rv.hidden = false; tourRevealed = rv; }
    }

    /* 대상 요소 찾기. 데이터가 늦게 그려지는 요소(#tools)는 잠깐 기다렸다
       다시 재고, 끝내 크기가 없으면 그 부모 상자를 비춥니다. */
    var els = step.targets.map(function (sel) { return $(sel); }).filter(Boolean);
    var zero = els.some(function (n) {
      var r = n.getBoundingClientRect();
      return r.width < 4 || r.height < 4;
    });
    if ((els.length < step.targets.length || zero) && (tries || 0) < 10) {
      setTimeout(function () { showTourStep(i, (tries || 0) + 1); }, 180);
      return;
    }
    els = els.map(function (n) {
      var r = n.getBoundingClientRect();
      return (r.width < 4 || r.height < 4) && n.parentElement ? n.parentElement : n;
    });
    if (!els.length) { endTour(); return; }

    alignTourScroll(step, els);
    requestAnimationFrame(function () { renderTourStep(step, i, els); });
  }

  function renderTourStep(step, i, els, refocus) {
    if (!tour) return;
    var PAD = 6, R = 10;
    tour.els = els;
    tour.rects = els.map(function (n) { return n.getBoundingClientRect(); });
    var rects = tour.rects.map(function (r) {
      return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
    });

    /* 어둠막 — 구멍은 mask 로 냅니다. box-shadow 방식은 구멍을 하나만
       낼 수 있어(3단계는 배치 수단 + AI 추천, 두 곳) mask 를 씁니다.
       viewBox 를 걸지 않습니다 — svg 사용자 단위가 곧 CSS px 이 되어
       getBoundingClientRect 좌표와 1:1 로 맞습니다. viewBox 를 innerHeight
       로 걸면 모바일에서 주소창이 접히는 순간 배율이 틀어져 구멍이
       대상(AI 추천 버튼)에서 살짝 비껴 났습니다. */
    tour.dim.innerHTML =
      '<defs><mask id="tour-mask">' +
      '<rect width="100%" height="100%" fill="#fff"/>' +
      rects.map(function (r) {
        return '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="' + R + '" fill="#000"/>';
      }).join('') +
      '</mask></defs>' +
      '<rect width="100%" height="100%" fill="rgba(9,17,32,.62)" mask="url(#tour-mask)"/>' +
      rects.map(function (r) {
        return '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="' + R + '" ' +
          'fill="none" stroke="var(--brand-2)" stroke-width="2.5"/>';
      }).join('');

    /* 말풍선 — 마지막 단계는 [다음] 대신 [종료] */
    var last = i === TOUR.length - 1;
    tour.bubble.innerHTML =
      '<p>' + esc(step.text) + '</p>' +
      '<div class="tour-bt">' +
      '<span class="tour-n">' + (i + 1) + ' / ' + TOUR.length + '</span>' +
      (i > 0 ? '<button class="btn sm" data-tour-go="' + (i - 1) + '" type="button">이전</button>' : '') +
      (last ? '<button class="btn sm primary" data-tour-end type="button">종료</button>'
        : '<button class="btn sm primary" data-tour-go="' + (i + 1) + '" type="button">다음</button>') +
      '</div>';

    /* 말풍선 자리 — 구멍들을 감싼 상자 아래, 안 되면 위, 그래도 안 되면 하단 고정 */
    var U = rects.reduce(function (u, r) {
      return {
        x: Math.min(u.x, r.x), y: Math.min(u.y, r.y),
        r: Math.max(u.r, r.x + r.w), b: Math.max(u.b, r.y + r.h)
      };
    }, { x: 1e9, y: 1e9, r: -1e9, b: -1e9 });
    /* 높이는 innerHeight 가 아니라 visualViewport 로 잽니다 — 모바일에서
       주소창 뒤에 가려진 영역까지 화면으로 치면 말풍선이 손이 안 닿는
       바닥으로 내려가 [다음]을 누를 수 없게 됩니다. */
    var vh = (window.visualViewport && window.visualViewport.height) || innerHeight;
    var bw = tour.bubble.offsetWidth, bh = tour.bubble.offsetHeight;
    var left = clamp((U.x + U.r) / 2 - bw / 2, 12, innerWidth - bw - 12);
    var top;
    tour.bubble.classList.remove('up');
    /* 구멍이 여럿일 때 그 사이가 넉넉하면 말풍선을 사이에 앉힙니다 —
       모바일 3단계에서 위(배치 수단)·아래(AI 추천)를 다 보이게 하는 자리 */
    var placed = false;
    if (rects.length > 1) {
      var sorted = rects.slice().sort(function (a, b) { return a.y - b.y; });
      for (var g = 0; g < sorted.length - 1; g++) {
        var gs = sorted[g].y + sorted[g].h, ge = sorted[g + 1].y;
        if (ge - gs >= bh + 20) {
          top = gs + (ge - gs - bh) / 2;
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      if (U.b + 14 + bh < vh - 12) top = U.b + 14;
      else if (U.y - 14 - bh > 12) { top = U.y - 14 - bh; tour.bubble.classList.add('up'); }
      else top = vh - bh - 16;
    }
    /* 어떤 경우에도 말풍선(과 버튼)은 보이는 화면 안에 있어야 합니다 */
    top = clamp(top, 12, Math.max(12, vh - bh - 12));
    tour.bubble.style.left = left + 'px';
    tour.bubble.style.top = top + 'px';

    /* 위치 추적으로 다시 그릴 때는 포커스를 건드리지 않습니다 — 사용자가
       [다음]을 누르려는 순간 포커스가 튀면 클릭이 무시될 수 있어서요. */
    if (refocus !== false) {
      var fb = $('.btn.primary', tour.bubble);
      if (fb) fb.focus();
    }
  }

  /* ── KPI 미니 비교차트 (시간대별 가로 막대 + 평균 점선 눈금) ──────────
     숫자만 있던 KPI 타일에 맥락을 답니다. 세로 막대로 먼저 만들었다가
     버렸습니다 — 30~39처럼 좁은 범위는 0 기준 세로 막대에서 높이 차이가
     원리적으로 안 읽힙니다. 가로 막대 + 값 숫자 직접 표기로 바꾸면
     ① 차이는 숫자가 보증하고 ② 패턴은 길이가 보여주고 ③ 이 제품의 기존
     차트 문법(우선순위 Top10·권역 요약의 가로 막대·트랙)과도 한 벌이 됩니다.
     평균은 9px 잔글씨 대신 캡션("평균 33 · 현재 +6")과 막대를 관통하는
     세로 점선 눈금, 두 곳에서 말합니다. 줄을 누르면 그 시간대로 전환. */

  /**
   * @param cfg { periods:[{id,name,label}], values:[숫자|null,...], current:'am',
   *              unit:'개', fmt?:v=>문자열, head?:캡션 대체문구, avgLine?:false }
   */
  function kspark(cfg) {
    var f = cfg.fmt || fmt;
    var max = 0, sum = 0, n = 0, cur = null;
    cfg.values.forEach(function (v, i) {
      if (v != null) { max = Math.max(max, v); sum += v; n++; }
      if (cfg.periods[i] && cfg.periods[i].id === cfg.current) cur = v;
    });
    var complete = n === cfg.values.length && n > 0;
    var avg = n ? sum / n : 0;
    var showAvg = cfg.avgLine !== false && max > 0 && complete;

    /* 캡션 — 평균과 '현재가 평균에서 얼마나 떨어져 있는지'를 글자로 명시 */
    var capHtml;
    if (cfg.head != null) {
      capHtml = esc(cfg.head);
    } else if (!complete) {
      capHtml = '불러오는 중…';
    } else {
      var d = (cur != null) ? cur - avg : null;
      var dTxt = '';
      if (d != null) {
        var da = Math.abs(d);
        dTxt = (Math.round(da) === 0 && da < 0.5)
          ? ' · <b>평균 수준</b>'
          : ' · 현재 <b>' + (d > 0 ? '+' : '−') + f(da) + '</b>';
      }
      capHtml = (showAvg ? '<i class="ks-avgkey"></i>' : '') + '평균 ' + f(avg) + dTxt;
    }

    var html = '<div class="ks-cap"><span>' + capHtml + '</span></div><div class="ks-rows">';
    cfg.periods.forEach(function (p, i) {
      var v = cfg.values[i];
      var w = (v == null || max <= 0) ? 0 : Math.max(2, v / max * 100);
      var on = p.id === cfg.current;
      html += '<button type="button" class="ks-row2' + (on ? ' on' : '') +
        '" data-kperiod="' + esc(p.id) + '"' + (on ? ' aria-current="true"' : '') +
        ' aria-label="' + esc(p.name + ' ' + p.label + ' — ' +
          (v == null ? '—' : f(v) + (cfg.unit || '')) +
          (showAvg && v != null && v > avg ? ' · 평균 초과' : '') + (on ? ' (현재)' : '')) + '">' +
        '<span class="ks-nm">' + esc(p.name) + '</span>' +
        '<span class="ks-tr">' +
        (showAvg ? '<i class="ks-avgtick" style="left:' + (avg / max * 100).toFixed(1) + '%"></i>' : '') +
        /* 평균 초과 줄만 지표색(hi) — 색 자체가 '평균 위' 라는 뜻이 됩니다.
           평균이 없는 차트(해소 통행·로딩 중)는 전부 지표색으로 둡니다. */
        (w > 0 ? '<i class="' + (!showAvg || v > avg ? 'ks-fill hi' : 'ks-fill') +
          '" style="width:' + w.toFixed(1) + '%"></i>' : '') +
        '</span>' +
        '<span class="ks-val">' + (v == null ? '–' : esc(f(v))) + '</span>' +
        '</button>';
    });
    html += '</div>';
    return html;
  }

  /** KPI 띠 컨테이너에 한 번만 겁니다 — 클릭=시간대 전환, 호버=툴팁 */
  function wireKspark(host) {
    if (!host || host.getAttribute('data-ks-wired')) return;
    host.setAttribute('data-ks-wired', '1');
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-kperiod]');
      if (!b) return;
      var tab = $('#periods [data-period="' + b.getAttribute('data-kperiod') + '"]');
      if (tab) tab.click();          // 탭과 완전히 같은 경로 — aria·재요청 로직 재사용
    });
    function tip(e) {
      var b = e.target.closest('[data-kperiod]');
      if (b) showTip(esc(b.getAttribute('aria-label')), e);
    }
    host.addEventListener('mouseover', tip);
    host.addEventListener('mousemove', tip);
    host.addEventListener('mouseout', function (e) {
      if (e.target.closest && e.target.closest('[data-kperiod]')) hideTip();
    });
  }

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
    /* 말풍선 — AI 도우미. 꼬리를 왼쪽 아래로 빼 '받는 말' 로 읽히게 합니다. */
    chat: '<path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-4.2A7.5 7.5 0 0 1 12.5 5h0A7.5 7.5 0 0 1 20 12.5z"/>' +
          '<path d="M9 11.5h7M9 14.5h4.5"/>',
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
    /* 조정 손잡이 둘 — 시뮬레이션은 "값을 놓고 움직여 보는 일"이라 슬라이더가
       가장 직설적입니다. 톱니(설정)와 겹치지 않게 손잡이를 분명히 그립니다. */
    tune: '<path d="M4 8h9M17.5 8H20M4 16h3.5M12 16h8"/>' +
          '<circle cx="15" cy="8" r="2.5"/><circle cx="9.5" cy="16" r="2.5"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    plus:  '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    arrow: '<path d="M4.5 12h14"/><path d="M12.5 6l6 6-6 6"/>',
    /* 저장 — 시나리오 보관. 본체·라벨·문서 세 획으로 단순화했습니다 */
    save:  '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h9l4 4v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/>' +
           '<path d="M8.5 4.5v4.5h6.5V4.5"/><path d="M8 19.5V14h8v5.5"/>',
    /* 관리자 콘솔용. 톱니를 다각형으로 그리면 획 굵기가 들쭉날쭉해 보여서,
       원 하나 + 방사형 눈금 8개로 단순화했습니다(같은 24격자·획 1.7 규칙). */
    gear:  '<circle cx="12" cy="12" r="3.2"/>' +
           '<path d="M12 3.5v2.6M12 17.9v2.6M20.5 12h-2.6M6.1 12H3.5' +
           'M18 6l-1.8 1.8M7.8 16.2 6 18M18 18l-1.8-1.8M7.8 7.8 6 6"/>'
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
    kspark: kspark, wireKspark: wireKspark,
    initTheme: initTheme, applyTheme: applyTheme,
    downloadBlob: downloadBlob,
    barUp: barUp, barDown: barDown, barRight: barRight,
    mountTopnav: mountTopnav
  };
})(window);
