/* ============================================================================
 *  map.js — 격자 지도 컴포넌트 (대시보드 · 시뮬레이션 공용)
 * ----------------------------------------------------------------------------
 *  API 가 돌려준 데이터만 보고 그립니다. 도메인 계산은 하지 않습니다.
 *
 *  사용법
 *    var map = HW.createMap({
 *      svg: document.querySelector('#map'),
 *      legend: document.querySelector('#legend'),
 *      meta: meta,                       // api.meta()
 *      onCellClick: function(cell, ev){},
 *      onStopClick: function(stop, cell, ev){}   // cell = 그 정류장이 놓인 격자
 *    });
 *    map.setData({ cells: [...], stops: [...], routes: [...], scale: {...} });
 *    map.setLayer('mi');                 // 'mi' | 'demand' | 'supply' | 'flow'
 *    map.select('G-321');
 *    map.setStopsInteractive(false);     // 배치 모드: 정류장이 클릭을 가로채지 않게
 *    map.setEligible(idSet);             // 배치 가능한 격자만 강조 (null 이면 해제)
 *    map.setPlacements([{type:'stop', cellId:'G-321', count:2}]);
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var C = HW.core;
  var esc = C.esc;

  /* prefix 는 셀 클래스(.c.m0), varPrefix 는 CSS 변수(--mi0)에 씁니다.
     MI 만 둘이 달라서, 범례를 prefix 로 그리면 존재하지 않는 --m0 을 참조해
     색 띠가 투명하게 나옵니다. */
  var LAYERS = {
    mi: { key: 'mi', prefix: 'm', varPrefix: 'mi', steps: 7, title: '미스매칭 지수 MI', unit: '(z)', kind: 'diverging' },
    demand: { key: 'demand', prefix: 'sb', steps: 5, title: '수요지수 D', unit: '5분위', kind: 'sequential' },
    supply: { key: 'supply', prefix: 'so', steps: 5, title: '공급지수 S', unit: '5분위', kind: 'sequential' },
    flow: { key: 'flow', prefix: 'sb', steps: 5, title: '유동인구(잠재수요)', unit: '5분위', kind: 'sequential' }
  };
  var QUINTILE_LABELS = ['하위 20%', '20–40%', '40–60%', '60–80%', '상위 20%'];

  function createMap(opt) {
    var svg = opt.svg;
    var legendEl = opt.legend || null;
    var meta = opt.meta || {};
    var mapMeta = meta.map || {};
    var vb = mapMeta.viewBox || [0, 0, 960, 580];   // meta 가 없을 때만 쓰는 폴백
    var W = vb[2], H = vb[3];
    var zoom = { x: vb[0], y: vb[1], w: W, h: H };  // 현재 viewBox (확대·이동 상태)

    if (meta.grid && meta.grid.bbox) C.setProjection(meta.grid.bbox, W, H);

    /* 격자 크기 비례 계수 — 1km 격자면 1. 확대 한도·시맨틱 줌·스냅 거리처럼
       "셀이 화면에서 얼마나 크게 보이는가"에 걸린 상수들이 이 값으로 조정된다.
       주의: 배치 마커(r=8.5)·겹침 오프셋·선택링 패딩은 시각 판단이 필요해
       비례 적용하지 않았다 — 격자 세분화 후 실화면 보고 조정 (GRID-500M.md). */
    var Z_SCALE = 1000 / ((meta.grid && meta.grid.sizeMeters) || 1000);
    /* 아래 셋은 drawBase→applyZoom 이 처음 실행되기 전에 초기화돼 있어야 한다.
       MIN_W 의 기본 배율(120)은 1km 실측 근거다 — 정류장 절반이 서로 30m
       이내(왕복 반대편 등)인데, 점·선 굵기를 --zk 로 역스케일해 화면 크기를
       유지하는 한 실제로 더 확대하는 수밖에 없다. 24배에서는 10m 간격이
       화면상 4px 로 뭉쳐 안 갈라지고, 120배는 20px 로 벌려 웬만한 쌍이
       갈라져 보인다. */
    var MIN_W = W / (120 * Z_SCALE);    // 확대 한도 — 1km: 120배 · 500m: 240배
    var ZDETAIL_K = 10 * Z_SCALE;       // 정류장 이름이 드러나는 배율
    var zoomAnim = null;

    /* 격자를 클릭했을 때 화면 가로에 담을 격자 수. 셀 실크기(cellRect)에서
       역산하므로 500m 로 세분화해도 화면에 보이는 그림은 같다.

       2.06 이었을 때는 클릭한 칸 하나가 화면을 통째로 채웠다(1km 격자에서
       약 2,950%). 이웃 격자도 읍면동 경계도 시 외곽선도 전부 사라져서
       "이 칸이 왜 최우선인가" 를 지도에서 말할 수 없었다 — 비교 대상이
       화면에 없으니 색을 읽을 기준도 같이 사라진다.

       그렇다고 많이 담을수록 좋은 것도 아니다. 배율이 ZDETAIL_K(=10*Z_SCALE)
       아래로 떨어지면 .zdetail 이 풀려 정류장 이름과 카카오 배경이 통째로
       꺼진다 — 확대해서 건물·골목을 보려던 목적이 무너진다.
         SPAN 4 → 15.2배   5 → 12.2배   6 → 10.1배   8 → 7.6배(zdetail 꺼짐)
       그래서 시맨틱 줌을 확실히 유지하는 선에서 가장 넓게 잡은 값이 5 다.
       클릭한 칸 + 사방 이웃이 함께 보이고 배율은 12.2배로 여유가 남는다. */
    var CELL_ZOOM_SPAN = 5;

    /* 이 개수 이하일 때만 정류장마다 투명 히트 원을 따로 만듭니다.
       넘으면 .st 원 자체가 히트 대상입니다(map.js renderRoutes 참고). */
    var HIT_LAYER_MAX = 400;

    var state = {
      cells: [], stops: [], routes: [], scale: null,
      byId: {},
      layer: 'mi',
      selectedCellId: null,
      selectedStopId: null,
      placements: [],
      eligible: null,          // Set 또는 null(해제)
      eligibleNote: '',        // 강조 중임을 알리는 범례 문구
      /* 대시보드 첫 화면은 격자와 지명만 보여 줍니다. 노선 200개와 정류장
         2,866개를 한꺼번에 깔면 SVG 요소가 1만 개를 넘고, 무엇보다 격자의
         미스매칭 색을 고르게 덮어 "어디가 빨간가"라는 이 지도의 본론이
         안 읽힙니다. 노선·정류장은 격자를 클릭했을 때 그 격자 것만
         드러납니다(cellFocus).
         시뮬레이션 화면은 예외입니다 — 어디에 정류장이 이미 있는지가 배치
         판단의 근거라서, 그쪽은 showRoutes:true 로 켜 둡니다. */
      showRoutes: opt.showRoutes === true,
      showLabels: true,
      cellFocus: null,         // 이 격자에 걸린 정류장·노선만 그린다 (null = 필터 없음)
      zdetail: false,          // 10배 이상 확대 — 이때만 정류장 이름을 DOM 에 만듭니다
      areaMode: false,         // 드래그로 분석 영역을 지정하는 중인지
      area: null,              // 영역 안 격자 ID Set (null = 화성시 전체)
      areaBox: null,           // 영역 사각형 {x,y,w,h} (SVG 좌표)
      stopsInteractive: true,
      armed: false
    };

    /* ---------------------------------------------------------- 뼈대 */
    function path(poly) {
      return 'M' + poly.map(function (p) { return p.join(','); }).join('L') + 'Z';
    }

    function drawBase() {
      var h = '';
      var regions = mapMeta.regions || [];

      h += '<rect class="wtr" x="0" y="0" width="' + W + '" height="' + H + '"/>';

      /* 1단계: 읍면동을 육지색으로 채웁니다. 합쳐지면 그게 곧 시 경계선입니다. */
      h += '<g data-land>';
      regions.forEach(function (r) {
        h += '<path class="land" d="' + ringsPath(r.rings) + '"/>';
      });
      h += '</g>';

      h += '<g class="cells" data-cells></g>';

      /* 2단계: 읍면동 경계선. 격자 위에 얹어 어디까지가 어느 동인지 보이게 합니다. */
      h += '<g data-dongline>';
      regions.forEach(function (r) {
        h += '<path class="dongline" data-dong="' + esc(r.code) + '" d="' + ringsPath(r.rings) + '"/>';
      });
      h += '</g>';

      h += '<g data-groutes></g>';

      /* 3단계: 읍면동 이름을 실제 도형 중심에 배치 */
      h += '<g data-glabels>';
      regions.forEach(function (r) {
        var p = C.project(r.centroid[0], r.centroid[1]);
        h += '<text class="rlab' + (r.kind === '동' ? ' sm' : '') + '" x="' + p.x.toFixed(1) +
          '" y="' + p.y.toFixed(1) + '" text-anchor="middle">' + esc(r.name) + '</text>';
      });
      h += '</g>';

      /* 분석 영역 — 드래그로 지정한 사각형. 격자 위, 기호 아래에 놓습니다. */
      h += '<g data-arearect visibility="hidden"><rect class="area-box"/></g>';

      h += '<g class="placed" data-placed></g>';
      h += '<g data-selring visibility="hidden">' +
        '<rect class="selring-out" x="-99" y="-99" width="20" height="20" rx="3"/>' +
        '<rect class="selring-in" x="-99" y="-99" width="20" height="20" rx="3"/>' +
        '</g>';

      /* 호버 테두리. 셀에 직접 stroke 를 주면 선의 절반이 칸 밖으로 나가
         이웃을 덮으므로, 맨 위 레이어에 칸 안쪽으로 그립니다. */
      h += '<g data-hovring visibility="hidden">' +
        '<rect class="hov-line" x="-99" y="-99" width="10" height="10"/></g>';

      h += '<g transform="translate(' + (W - 38) + ',72)"><circle class="compass" r="11"/>' +
        '<path d="M0,-7 L3,4 L0,2 L-3,4 Z" fill="var(--ink3)"/>' +
        '<text class="compass-t" y="-16" text-anchor="middle">N</text></g>';

      /* 축척바 — 경위도 기준으로 실제 거리를 계산합니다 */
      var sbKm = (mapMeta.scaleBar && mapMeta.scaleBar.km) || 5;
      var sbPx = scaleBarPx(sbKm);
      h += '<g transform="translate(' + (W - 52 - sbPx) + ',' + (H - 34) + ')">' +
        '<line class="scalebar" x1="0" y1="0" x2="' + sbPx.toFixed(1) + '" y2="0"/>' +
        '<line class="scalebar" x1="0" y1="-4" x2="0" y2="4"/>' +
        '<line class="scalebar" x1="' + sbPx.toFixed(1) + '" y1="-4" x2="' + sbPx.toFixed(1) + '" y2="4"/>' +
        '<text class="compass-t" x="' + (sbPx / 2).toFixed(1) + '" y="-6" text-anchor="middle">0 \u2500 ' +
        sbKm + ' km</text></g>';

      applyZoom();          /* 다시 그려도 확대 상태를 유지합니다 */
      svg.innerHTML = h;
    }

    /** 경위도 고리들을 투영해 SVG path 로 */
    function ringsPath(rings) {
      return (rings || []).map(function (ring) {
        return 'M' + ring.map(function (pt) {
          var q = C.project(pt[0], pt[1]);
          return q.x.toFixed(1) + ',' + q.y.toFixed(1);
        }).join('L') + 'Z';
      }).join('');
    }

    /** km 를 화면 px 로 (축척바용) */
    function scaleBarPx(km) {
      var b = (meta.grid && meta.grid.bbox) || [126.5, 37, 127.2, 37.3];
      var midLat = (b[1] + b[3]) / 2;
      var dLon = km / (111.320 * Math.cos(midLat * Math.PI / 180));
      var p0 = C.project(b[0], midLat), p1 = C.project(b[0] + dLon, midLat);
      return Math.max(20, p1.x - p0.x);
    }

    /* ------------------------------------------------------- 카카오맵 배경(선택)
       실제 지도는 배경일 뿐 — 격자·정류장·노선은 지금처럼 이 SVG 가 그립니다.
       SVG 의 확대·이동 상태(zoom)를 카카오 지도에 그대로 넘겨 따라오게만
       합니다. 그래서 키가 없거나 SDK 로드가 실패해도(오프라인 등) 지도
       기능은 그대로 동작하고, 배경 한 겹만 없이 지금 모습으로 남습니다. */
    var kkMap = null;
    var kkInner = null;
    function initKakao() {
      var cfg = (HW.CONFIG && HW.CONFIG.KAKAO) || {};
      if (!cfg.enabled || !cfg.jsKey || !svg.parentNode || !global.document) return;
      var div = global.document.createElement('div');
      div.className = 'kakaomap';
      /* 카카오는 정수 줌 레벨로만 반응해서 setBounds 가 요청보다 넓은 범위를
         보여줍니다(docs/KAKAO-SYNC.md). 그 차이를 syncKakao 가 CSS 변형으로
         메우는데, 변형을 .kakaomap 에 직접 걸면 클리핑 상자까지 같이 커져
         배경이 지도 카드 밖으로 삐져나옵니다(.mapbox 에 overflow 가 없습니다).
         그래서 .kakaomap 은 자르는 틀로만 두고, 안쪽 div 를 변형합니다. */
      var inner = global.document.createElement('div');
      inner.className = 'kakaomap-inner';
      div.appendChild(inner);
      svg.parentNode.insertBefore(div, svg);
      kkInner = inner;

      /* 배경을 포기하고 지금까지의 SVG 단독 지도로 되돌립니다.
         .kkmode 를 붙이기 전에만 불리므로 화면은 원래 상태 그대로입니다. */
      function giveUp() {
        kkMap = null;
        kkInner = null;
        if (div.parentNode) div.parentNode.removeChild(div);
      }

      var s = global.document.createElement('script');
      s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + encodeURIComponent(cfg.jsKey) + '&autoload=false';
      s.onerror = giveUp;
      s.onload = function () {
        try {
          global.kakao.maps.load(function () {
            kkMap = new global.kakao.maps.Map(inner, {
              center: new global.kakao.maps.LatLng(37.2, 126.83), level: 9
            });
            kkMap.setDraggable(false);   // 이동·확대는 지금처럼 SVG 쪽에서만 받습니다
            kkMap.setZoomable(false);    // (두 지도가 서로 다른 입력에 반응하면 어긋납니다)
            syncKakao();

            /* ★ 타일이 실제로 그려진 것을 확인한 뒤에만 .kkmode 를 붙입니다.
               예전에는 SDK 스크립트만 받아지면 무조건 붙였는데, 카카오 키는
               허용 도메인이 등록된 곳에서만 타일을 내려줍니다. 시연을 등록되지
               않은 주소(ngrok·devtunnels·심사용 서버)에서 열면 배경은 비어
               있는데 .kkmode 만 걸려, app.css 의
               `.kkmode.zdetail .wtr,.land{fill-opacity:0}` 때문에 육지·바다·
               해안선이 통째로 사라진 회색 화면이 나왔습니다. 격자를 클릭하면
               CELL_ZOOM_SPAN 배율로 확대돼 .zdetail 이 반드시 걸리므로
               시연에서 그냥 터지는 조합이었습니다.
               타일이 안 오면 배경을 걷어내고 원래 SVG 지도로 남습니다. */
            var settled = false;
            var timer = global.setTimeout(function () {
              if (settled) { return; }
              settled = true;
              giveUp();
            }, 5000);
            global.kakao.maps.event.addListener(kkMap, 'tilesloaded', function () {
              if (settled) { return; }
              settled = true;
              global.clearTimeout(timer);
              svg.classList.add('kkmode');
              applyZoom();          // .kkmode 반영(배경 탈색 클래스 포함)
            });
          });
        } catch (e) { giveUp(); }
      };
      global.document.head.appendChild(s);   // 실패해도 조용히 넘어갑니다(SVG 단독으로)
      global.addEventListener('resize', function () {
        if (kkMap) { kkMap.relayout(); syncKakao(); }
      });
    }
    /** 현재 SVG viewBox 창(zoom)에 꼭 맞도록 카카오 지도의 중심·배율을 맞춥니다.
     *
     *  setBounds 만으로는 안 맞습니다. 카카오는 **정수 줌 레벨**로만 반응해서
     *  요청 범위를 '담을 수 있는' 레벨을 고르고, 그래서 항상 요청보다 넓게
     *  보여줍니다. 확대할수록 어긋나다가 레벨이 한 칸 떨어지면 다시 붙는
     *  톱니가 생기고, 실측으로 **정류장 위치가 중앙값 890m** 어긋났습니다
     *  (1,455% 확대·1km 격자 기준 — 배경 건물이 다른 격자의 것이 됩니다).
     *
     *  남은 차이는 배경에 CSS 변형을 걸어 메웁니다 — alignKakao 참고.
     *
     *  ⚠️ 예전 시도(61351ed)는 scale 만 걸고 transform-origin 을 50% 50% 로
     *     둬서 중심 어긋남이 남는다고 보고 되돌렸습니다(554ae83). 실측해 보면
     *     setBounds 는 요청 중심을 유지하므로 중심은 이미 0.3~3.1px 로 맞아
     *     있었고, 문제는 배율뿐이었습니다. 그래도 여기서는 평행이동 항을
     *     함께 유도해 중심 드리프트까지 구조적으로 없앱니다. */
    function syncKakao() {
      if (!kkMap) return;
      var sw = C.unproject(zoom.x, zoom.y + zoom.h);
      var ne = C.unproject(zoom.x + zoom.w, zoom.y);
      kkMap.setBounds(new global.kakao.maps.LatLngBounds(
        new global.kakao.maps.LatLng(sw.lat, sw.lon),
        new global.kakao.maps.LatLng(ne.lat, ne.lon)
      ));
      alignKakao(sw, ne);
    }

    /** 카카오가 **실제로** 그리는 화면 위로 우리 창을 정확히 겹칩니다.
     *
     *  카카오에게 "우리 창의 좌상단(sw.lon, ne.lat)과 우하단(ne.lon, sw.lat)을
     *  네 화면 어디에 그리느냐"고 직접 물어(containerPointFromCoords), 그 두
     *  점이 컨테이너의 (0,0)과 (W,H)에 오도록 아핀을 맞춥니다. 두 모서리가
     *  정확히 고정되므로 배율과 중심이 동시에 맞습니다.
     *
     *  위도를 직접 비율 계산하지 않는 이유: 카카오는 메르카토르라 화면 y 가
     *  위도에 비선형입니다. 위도 폭의 비(Δ카카오/Δ우리)를 세로 배율로 쓰면
     *  넓은 범위에서 어긋납니다 — 실측으로 첫 화면 6.8px 가 남았습니다.
     *  카카오 투영에 직접 물으면 그 비선형이 값 안에 이미 반영됩니다.
     *  남는 것은 두 모서리 사이 곡률 잔차뿐이고, 화성시 위도폭에서는
     *  0.3px 미만입니다(등장방형 대비 편차 계산).
     *
     *  투영 API 가 없는 SDK 버전에서는 조용히 무보정으로 남습니다 —
     *  지금까지의 동작과 같아 더 나빠지지는 않습니다. */
    function alignKakao(sw, ne) {
      if (!kkInner) return;
      var tl, br, W, H;
      try {
        var proj = kkMap.getProjection();
        W = kkInner.clientWidth;
        H = kkInner.clientHeight;
        if (!proj || !proj.containerPointFromCoords || !W || !H) return;
        tl = proj.containerPointFromCoords(new global.kakao.maps.LatLng(ne.lat, sw.lon));
        br = proj.containerPointFromCoords(new global.kakao.maps.LatLng(sw.lat, ne.lon));
      } catch (e) { return; }
      if (!tl || !br) return;

      var spanX = br.x - tl.x, spanY = br.y - tl.y;
      if (!(spanX > 0) || !(spanY > 0)) return;

      var sx = W / spanX;
      var sy = H / spanY;
      var tx = -tl.x * sx;
      var ty = -tl.y * sy;

      /* 이미 맞아 있으면(레벨이 딱 떨어진 경우) 변형을 걸지 않습니다 —
         scale(1.0000) 도 합성 레이어를 만들어 타일이 미세하게 흐려집니다. */
      if (Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002 &&
          Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5) {
        kkInner.style.transform = '';
        return;
      }
      kkInner.style.transformOrigin = '0 0';
      kkInner.style.transform =
        'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) ' +
        'scale(' + sx.toFixed(5) + ',' + sy.toFixed(5) + ')';
    }

    drawBase();
    initKakao();
    var gCells = svg.querySelector('[data-cells]');
    var gRoutes = svg.querySelector('[data-groutes]');
    var gLabels = svg.querySelector('[data-glabels]');
    var gDongLine = svg.querySelector('[data-dongline]');
    var gPlaced = svg.querySelector('[data-placed]');
    var gSelRing = svg.querySelector('[data-selring]');
    var gHovRing = svg.querySelector('[data-hovring]');

    /** 호버 테두리를 가리킨 칸 '안쪽'에 맞춰 놓습니다(밖으로 삐져나오지 않게). */
    function placeHoverRing(c) {
      if (!gHovRing) return;
      var r = cellRect(c);
      /* renderCells 가 소수 1자리로 그리므로 같은 기준으로 맞춥니다 —
         원본 정밀도로 계산하면 반올림 차이만큼 테두리가 밖으로 밀립니다. */
      var rx = +r.x.toFixed(1), ry = +r.y.toFixed(1);
      var w = +r.w.toFixed(1) - CELL_OV, h = +r.h.toFixed(1) - CELL_OV;  /* 겹침 제외 */
      /* stroke 는 선 중심 기준이라 절반이 밖으로 나갑니다 — 그만큼 안으로 들입니다.
         굵기는 칸의 13%. 500m 격자(약 8px)에서 20% 로 두면 테두리가 칸 면적의
         60% 를 덮어 검은 네모처럼 보입니다. */
      var sw = Math.max(0.6, Math.min(1.8, w * 0.13));
      var el = gHovRing.firstChild;
      el.setAttribute('x', (rx + sw / 2).toFixed(2));
      el.setAttribute('y', (ry + sw / 2).toFixed(2));
      el.setAttribute('width', Math.max(0.5, w - sw).toFixed(2));
      el.setAttribute('height', Math.max(0.5, h - sw).toFixed(2));
      el.setAttribute('stroke-width', sw.toFixed(2));
      gHovRing.setAttribute('visibility', 'visible');
    }
    function hideHoverRing() {
      if (gHovRing) gHovRing.setAttribute('visibility', 'hidden');
    }

    /* -------------------------------------------------------- 데이터 */
    function setData(d) {
      if (d.scale) state.scale = d.scale;
      if (d.cells) {
        /* 격자 구성이 그대로면 DOM 을 다시 만들지 않고 색만 갱신합니다.
           배치할 때마다 389개를 새로 그리면 마우스가 올려져 있던 격자의
           호버 상태가 끊기고, 그 위에 떠 있던 툴팁도 어긋납니다. */
        var same = state.cells.length === d.cells.length &&
          d.cells.every(function (c, i) { return state.cells[i] && state.cells[i].id === c.id; });
        state.cells = d.cells;
        state.byId = {};
        d.cells.forEach(function (c) { state.byId[c.id] = c; });
        if (!same) renderCells();
      }
      if (d.routes) state.routes = d.routes;
      if (d.stops) state.stops = d.stops;
      if (d.routes || d.stops) renderRoutes();
      paint();
      placeRing();
      renderPlacements();
    }

    /* 셀을 이웃과 겹치게 그리는 폭. 호버 테두리를 칸 안쪽에 맞출 때도 씁니다. */
    var CELL_OV = 0.35;

    /* 셀의 px 사각형. 셀이 x/y/w/h(px)를 직접 들고 오면 그대로 쓰고,
       서버 셀처럼 중심 경위도만 오면 격자 실크기(m)로 계산합니다. */
    function cellBox(c) {
      if (typeof c.x === 'number' && typeof c.w === 'number') {
        var b = { x: c.x, y: c.y, w: c.w, h: c.h };
        return { draw: b, hit: b };
      }
      var km = ((meta.grid && meta.grid.sizeMeters) || 1000) / 1000;
      var dLat = km / 110.574;
      var dLon = km / (111.320 * Math.cos(((c.lat || 37)) * Math.PI / 180));
      var p0 = C.project(c.lon - dLon / 2, c.lat + dLat / 2);   /* 좌상단 */
      var p1 = C.project(c.lon + dLon / 2, c.lat - dLat / 2);   /* 우하단 */
      /* hit = 격자의 실제 경계. 소속 판정은 이걸로 합니다.
         draw = 그릴 사각형. 격자는 빈틈없이 맞물린 면인데 사이를 벌리면 배경이
         비쳐 색이 옅어 보이고(500m 에서 지도 면적의 약 20%) 방충망 질감이
         생깁니다. 좌표가 5자리(≈1m)로 반올림돼 있어 경계의 26% 에 0.1px 틈이
         남고 앤티에일리어싱으로 실틈이 비칩니다. 그래서 CELL_OV 만큼만 키워
         이웃과 겹치게 그립니다 — 셀의 2~4% 라 눈에 띄지 않습니다. */
      var hit = { x: p0.x, y: p0.y,
                  w: Math.max(2, p1.x - p0.x), h: Math.max(2, p1.y - p0.y) };
      return {
        draw: { x: hit.x, y: hit.y, w: hit.w + CELL_OV, h: hit.h + CELL_OV },
        hit: hit
      };
    }
    function cellRect(c) { return cellBox(c).draw; }

    function renderCells() {
      var h = '';
      state.cells.forEach(function (c) {
        var r = cellRect(c);
        /* 모서리를 둥글리면 네 셀이 만나는 꼭짓점마다 배경색이 뚫립니다 */
        h += '<rect x="' + r.x.toFixed(1) + '" y="' + r.y.toFixed(1) + '" width="' + r.w.toFixed(1) + '" height="' + r.h.toFixed(1) +
          '" class="c m3" data-id="' + esc(c.id) + '"/>';
      });
      gCells.innerHTML = h;
    }

    /* 판정용 사각형 = 격자의 실제 경계. 렌더용(cellRect)과 한 곳(cellBox)에서
       만듭니다.

       예전에는 둘이 따로 있었고, 그 조합이 두 번 어긋났습니다.
         · cellRect 가 사방 0.4px 를 '깎던' 시절: 그 틈에 떨어진 정류장이 어느
           격자에도 안 속해 격자를 찍으면 사라졌습니다(실측 400개 중 43개).
           그래서 cellHitRect 가 +0.8px 로 깎기를 되돌렸습니다.
         · 이번에 cellRect 가 '깎기'에서 'CELL_OV 만큼 키우기'로 바뀌었는데
           cellHitRect 의 되돌림은 그대로 남았습니다. 그러면 판정 사각형이 실제
           경계보다 좌 0.4px·우 0.75px 넓어져 이웃 판정이 약 1.15px 겹치고,
           한 정류장이 두 격자에 모두 들어가 '정류장 N개'가 이중 계수됩니다.
       보정을 서로 맞추는 대신 경계를 한 번만 계산해 둘로 나눠 씁니다. */
    function cellHitRect(c) {
      return cellBox(c).hit;
    }
    function inCell(c, s) {
      var r = cellHitRect(c), p = C.xy(s);
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }

    /** cellFocus 가 걸려 있으면 그 격자 안의 정류장 id 집합, 없으면 null */
    function focusStopIds() {
      if (!state.cellFocus) return null;
      var c = state.byId[state.cellFocus];
      if (!c) return null;
      var set = {};
      state.stops.forEach(function (s) { if (inCell(c, s)) set[s.id] = 1; });
      /* 선택된 정류장은 무조건 그립니다. 정류장을 검색해 그 격자로 들어왔는데
         경계에 걸려 안 그려지면 "검색한 정류장이 선택된 채로 보인다"가 깨집니다.
         격자 밖 정류장(시 경계 부근)을 검색한 경우에도 이 한 줄이 보장해 줍니다. */
      if (state.selectedStopId) set[state.selectedStopId] = 1;
      return set;
    }

    /* 정류장 층이 지금 화면에 실제로 그려져 있는가.
       기하 판정(nearestStop)은 state.stops 전체를 좌표로 훑기 때문에 '그리지
       않았다' 는 것만으로는 멈추지 않습니다. 아래 renderRoutes 의 조기 반환은
       gRoutes 를 비우고 나가면서 fathit 을 설정하지 못하는데, 그러면
       stopAtEvent 의 두 가드(fathit · stopsInteractive)가 모두 성립하지 않아
       화면에 없는 정류장이 호버·클릭을 가로챕니다 — 두 화면의 기본 상태가
       바로 그 상태였습니다. 그려진 적이 있는지를 따로 들고 판정합니다. */
    var _stopsDrawn = false;

    function renderRoutes() {
      var h = '';
      /* 격자를 클릭했으면 그 격자에 걸린 것만 그립니다. 전체를 깔면 격자 색이
         덮여 미스매칭이 안 읽히고, 확대해도 어느 노선이 이 동네 것인지 모릅니다. */
      var only = focusStopIds();
      /* 안 보일 때는 아예 만들지 않습니다. 첫 화면(격자만)에서 노선 200개와
         정류장 2,866개를 display:none 인 채로 세워 두면 SVG 노드 9천 개를
         쓸데없이 만들게 됩니다. 켜질 때 다시 그립니다. */
      if (!state.showRoutes && !only) {
        gRoutes.innerHTML = '';
        gRoutes.style.display = 'none';
        _stopsDrawn = false;
        return;
      }
      var stops = only ? state.stops.filter(function (s) { return only[s.id]; }) : state.stops;
      var routes = only
        ? state.routes.filter(function (rt) {
            return (rt.stopIds || []).some(function (id) { return only[id]; });
          })
        : state.routes;

      /* 1단계: 케이싱(바탕색 굵은 선) → 2단계: 노선 본선. 격자 위에서도 선이 끊겨 보이지 않습니다. */
      function routePts(rt) {
        var src = rt.pathXY;
        if (src && src.length) return src.map(function (p) { return p[0] + ',' + p[1]; });
        return (rt.path || []).map(function (p) {
          var q = C.project(p[0], p[1]);
          return q.x.toFixed(1) + ',' + q.y.toFixed(1);
        });
      }
      routes.forEach(function (rt) {
        h += '<polyline class="rt-casing" points="' + routePts(rt).join(' ') + '"/>';
      });
      routes.forEach(function (rt) {
        h += '<polyline class="rt" data-route="' + esc(rt.id) + '" points="' + routePts(rt).join(' ') + '"/>';
      });
      /* 점 크기를 일 승하차량에 비례시킵니다. 전부 같은 크기로 그리면
         병점역(일 1만)과 시골 정류장(일 몇 명)이 똑같이 보여서, 2,866개가
         격자 색을 고르게 덮어 미스매칭이 안 읽힙니다.
         제곱근을 쓰는 이유 — 면적이 승하차량에 비례해야 눈이 크기를 제대로 읽습니다.
         반지름에 그냥 비례시키면 큰 정류장이 과장돼 보입니다. */
      /* 크기 기준(maxB)은 전체 정류장에서 뽑습니다. 격자를 옮겨 다닐 때마다
         같은 정류장의 점 크기가 달라지면 비교가 안 됩니다. */
      /* boardingsPerDay 가 아예 안 오는 백엔드(구버전)에서는 maxB 가 1 로 굳어
         모든 점이 최소 크기(1.6px)로 쪼그라듭니다 — 예전 고정값 3.4px 의 절반이라
         "작아진 것"이 데이터로 보입니다. 값이 하나도 없으면 크기 구분을 포기하고
         예전 고정 반지름으로 돌아갑니다. */
      var maxB = 0;
      state.stops.forEach(function (s) {
        if (typeof s.boardingsPerDay === 'number' && isFinite(s.boardingsPerDay)) {
          maxB = Math.max(maxB, s.boardingsPerDay);
        }
      });
      var hasB = maxB > 0;
      function stopR(s) {
        if (s.kind === 'hub') return 4.6;
        if (!hasB) return 3.4;                                  /* 자료 없음 — 균일 */
        var k = Math.sqrt((+s.boardingsPerDay || 0) / maxB);   /* 0~1 */
        return 1.6 + 3.0 * k;                                   /* 1.6 ~ 4.6px */
      }
      stops.forEach(function (s) {
        var p = C.xy(s);
        h += '<circle class="st' + (s.kind === 'hub' ? ' hub' : '') + '" data-stop="' + esc(s.id) +
          '" style="--sr:' + stopR(s).toFixed(2) + 'px"' +
          ' cx="' + p.x + '" cy="' + p.y + '"/>';
      });
      /* 정류장 이름은 확대해야 보이는데(.stlab{display:none}) 예전에는 2,866개를
         항상 만들어 두고 CSS 로만 감췄습니다. SVG 요소 12,636개 중 2,866개가
         한 번도 안 보이는 텍스트였습니다. 확대 상태에서만 만듭니다.
         격자를 클릭한 상태(only)면 몇 개 안 되므로 배율과 무관하게 바로 붙입니다. */
      if (state.zdetail || only) {
        stops.forEach(function (s) {
          var p = C.xy(s);
          h += '<text class="stlab' + (only ? ' always' : '') + '" x="' + p.x + '" y="' + p.y +
            '" dy="-1.1em" text-anchor="middle">' + esc(s.name) + '</text>';
        });
      }
      /* ── 히트 전용 층은 '적을 때만' 만듭니다 ────────────────────────────
         전체(2,866개)를 켜면 이 층만으로 SVG 노드가 5,732개 늘었습니다
         (투명 원 2,866 + <title> 2,866). 전체 노드 8,998 중 64% 가 한 번도
         칠해지지 않는 요소였고, 켜는 데만 314ms 가 걸렸습니다.
         <title> 은 브라우저 기본 툴팁인데 아래 mousemove 가 이미 같은 내용을
         띄우므로 순수 중복입니다 — 전부 없앱니다.
         많을 때는 DOM 을 안 만들고 stopAtEvent 가 좌표로 찾습니다(nearestStop).
         .st 원은 app.css 에서 pointer-events:none 이라 히트 대상이 아닙니다.
         격자를 찍어 몇 개만 남은 상태(only)에서는 예전처럼 넉넉한 투명 원을 씁니다. */
      var fatHit = !!only || stops.length <= HIT_LAYER_MAX;
      _sIdx = null;   // 좌표 색인 무효화 (setData·격자 포커스 전환마다)
      if (fatHit) {
        stops.forEach(function (s) {
          var p = C.xy(s);
          h += '<circle class="sthit" data-stophit="' + esc(s.id) + '" cx="' + p.x + '" cy="' + p.y + '" r="11"/>';
        });
      }
      gRoutes.classList.toggle('fathit', fatHit);
      gRoutes.innerHTML = h;
      /* 격자를 찍어 놓은 동안에는 전체 토글이 꺼져 있어도 그 격자 것은 보여야 합니다 */
      gRoutes.style.display = (state.showRoutes || only) ? '' : 'none';
      _stopsDrawn = true;
      applyStopsInteractive();
      /* 위에서 DOM 을 통째로 새로 만들었으므로 선택 표시(.on)가 날아갑니다.
         정류장을 검색해 그 격자로 파고드는 흐름이 setCellFocus → renderRoutes
         순서라, 여기서 복원하지 않으면 "검색한 정류장이 선택돼 보인다"가 깨집니다. */
      if (state.selectedStopId) highlightStop(state.selectedStopId);
    }

    /* 배치 모드에서는 정류장이 격자 클릭을 가로채지 않도록 통과시킵니다.
       (이걸 안 하면 정류장이 놓인 격자에는 아무것도 배치할 수 없습니다) */
    function applyStopsInteractive() {
      gRoutes.classList.toggle('nohit', !state.stopsInteractive);
    }

    /* ---------------------------------------------------------- 채색 */
    function binOf(cell, layerKey) {
      var b = cell.bins || {};
      if (layerKey === 'mi') return b.mi != null ? b.mi : 3;
      if (layerKey === 'demand') return b.demand != null ? b.demand : 2;
      if (layerKey === 'supply') return b.supply != null ? b.supply : 2;
      return b.flow != null ? b.flow : 2;
    }
    function paint() {
      var L = LAYERS[state.layer];
      var elig = state.eligible;
      Array.prototype.forEach.call(gCells.children, function (rect) {
        var id = rect.getAttribute('data-id');
        var c = state.byId[id];
        if (!c) return;
        var cls = 'c ' + L.prefix + binOf(c, L.key);
        if (elig) cls += elig.has(id) ? ' elig' : ' inelig';
        /* 분석 영역을 정했으면 밖의 칸은 뒤로 물립니다 */
        if (state.area && !state.area.has(id)) cls += ' outarea';
        rect.setAttribute('class', cls);
      });
      renderLegend();
    }

    /** 범례 — 구간 경계 수치를 함께 표기해 색이 무엇을 뜻하는지 읽을 수 있게 합니다 */
    function renderLegend() {
      if (!legendEl) return;
      var L = LAYERS[state.layer];
      var h = '<div class="lg-head"><b>' + esc(L.title) + '</b><span>' + esc(L.unit) + '</span></div>';

      h += '<div class="lg-body">';
      if (L.kind === 'diverging') {
        var th = (state.scale && state.scale.miThresholds) || [-1.5, -0.75, -0.25, 0.25, 0.75, 1.5];
        h += '<span class="lg-end">공급 여유</span>';
        h += '<div class="lg-scale"><div class="lg-sw">';
        for (var i = 0; i < L.steps; i++) h += '<i style="background:var(--' + (L.varPrefix || L.prefix) + i + ')"></i>';
        h += '</div><div class="lg-tick">';
        /* 눈금은 색 칸 사이 경계에 옵니다 */
        h += '<span></span>';
        th.forEach(function (v) {
          h += '<span>' + (v > 0 ? '+' : '') + v + '</span>';
        });
        h += '<span></span></div></div>';
        h += '<span class="lg-end">공급 부족</span>';
      } else {
        h += '<span class="lg-end">낮음</span>';
        h += '<div class="lg-scale"><div class="lg-sw">';
        for (var j = 0; j < L.steps; j++) h += '<i style="background:var(--' + (L.varPrefix || L.prefix) + j + ')" title="' + QUINTILE_LABELS[j] + '"></i>';
        h += '</div><div class="lg-tick lg-tick5">' +
          QUINTILE_LABELS.map(function (t) { return '<span>' + t + '</span>'; }).join('') +
          '</div></div>';
        h += '<span class="lg-end">높음</span>';
      }
      h += '</div>';

      if (state.eligible) {
        h += '<div class="lg-note"><i class="sw-elig"></i>' +
          esc(state.eligibleNote || '선택한 격자만 진하게 표시 중') +
          ' <button class="lg-clear" type="button" data-clear-focus>해제</button></div>';
      }

      /* 지도 기호 설명 — 색만으로는 흰 점·선·삼각형이 무엇인지 알 수 없습니다 */
      h += renderSymbolLegend();
      legendEl.innerHTML = h;

      var clr = legendEl.querySelector('[data-clear-focus]');
      if (clr && opt.onClearFocus) clr.addEventListener('click', opt.onClearFocus);
    }

    /** 지도 기호 범례. 실제 지도와 같은 SVG 로 그려 모양이 정확히 일치합니다. */
    function renderSymbolLegend() {
      /* 격자 실제 렌더 크기(cellRect)와 같은 sizeMeters 를 쓴다.
         예전엔 displaySizeMeters(1.5km)를 써서 범례와 실물이 어긋났다. */
      /* 셀 크기는 서버 meta 를 따릅니다. 1000m 미만이면 km 로 적으면
         '0.5km' 같은 어색한 표기가 되므로 m 로 씁니다. meta 에 없으면
         크기를 지어내지 않고 범례 항목의 수치를 생략합니다. */
      var sizeM = (meta.grid && meta.grid.sizeMeters) || 0;
      var cellLabel = !sizeM ? '격자 1칸'
        : (sizeM >= 1000 ? '격자 1칸 ' + (sizeM / 1000) + 'km'
                         : '격자 1칸 ' + sizeM + 'm');

      function item(svgInner, label, w) {
        return '<span class="lg-sym"><svg viewBox="0 0 ' + (w || 22) + ' 14" width="' + (w || 22) + '" height="14" aria-hidden="true">' +
          svgInner + '</svg>' + esc(label) + '</span>';
      }
      var items = [];
      items.push(item('<rect x="2" y="2" width="10" height="10" rx="2" class="c m3"/>' +
        '<rect x="2" y="2" width="10" height="10" rx="2" fill="none" stroke="var(--line)"/>',
        cellLabel));
      items.push(item('<circle cx="11" cy="7" r="3.4" class="st"/>', '정류장'));
      items.push(item('<circle cx="11" cy="7" r="4.6" class="st hub"/>', '환승 거점'));
      items.push(item('<polyline class="rt-casing" points="2,10 8,4 14,9 20,4"/>' +
        '<polyline class="rt" points="2,10 8,4 14,9 20,4"/>', '버스 노선'));
      items.push(item('<path class="dongline" d="M2,11 L8,4 L14,9 L20,3"/>', '읍면동 경계'));
      /* 선택링 굵기는 지도에서 map.js 가 칸 크기에 맞춰 attribute 로 찍습니다.
         범례에는 칸이 없으니 여기서 직접 줘야 합니다 — 안 주면 CSS 기본 1px 로
         가늘어져 실제 지도의 링과 달라 보입니다. */
      items.push(item('<rect x="3" y="3" width="8" height="8" rx="2" class="selring-out" stroke-width="3"/>' +
        '<rect x="3" y="3" width="8" height="8" rx="2" class="selring-in" stroke-width="1.6"/>', '선택한 격자'));

      if (opt.placementLegend) {
        /* 지도와 **같은 함수**로 그립니다. 예전에는 범례만 옛 글자기호(●◆▲)를
           그리고 지도는 수단별 색+도형을 그려, 이 함수 설명("실제 지도와 같은
           SVG 로 그려 모양이 정확히 일치합니다")이 사실이 아니었습니다.
           색이 수단을 구분하는 지금은 범례에 색 키가 없으면 지도를 못 읽습니다. */
        (meta.effects || []).forEach(function (e) {
          items.push(item(markerShape(e.type, 12, 7, 4, 1), e.label, 24));
        });
      }
      return '<div class="lg-syms">' + items.join('') + '</div>';
    }

    /* -------------------------------------------------------- 선택 */
    function placeRing() {
      if (!state.selectedCellId) { gSelRing.setAttribute('visibility', 'hidden'); return; }
      var c = state.byId[state.selectedCellId];
      if (!c) { gSelRing.setAttribute('visibility', 'hidden'); return; }
      var r = cellRect(c);
      var cw = r.w - CELL_OV, ch = r.h - CELL_OV;
      /* 굵기·여백이 고정값(5px/3px)이던 때는 500m 격자(약 8px)에서 링이 칸보다
         커져 이웃과 주변 글씨를 덮었습니다. 칸 크기에 비례시킵니다. */
      var base = Math.min(cw, ch);
      var sw = [base * 0.26, base * 0.15];
      var pad = base * 0.08;
      Array.prototype.forEach.call(gSelRing.children, function (el, i) {
        el.setAttribute('x', (r.x - pad).toFixed(2));
        el.setAttribute('y', (r.y - pad).toFixed(2));
        el.setAttribute('width', (cw + pad * 2).toFixed(2));
        el.setAttribute('height', (ch + pad * 2).toFixed(2));
        el.setAttribute('stroke-width', sw[i].toFixed(2));
        el.setAttribute('rx', (base * 0.1).toFixed(2));
      });
      gSelRing.setAttribute('visibility', 'visible');
    }

    function highlightStop(stopId) {
      state.selectedStopId = stopId;
      var stop = null;
      state.stops.forEach(function (s) { if (s.id === stopId) stop = s; });
      var routeIds = (stop && stop.routes) || [];
      Array.prototype.forEach.call(gRoutes.querySelectorAll('.rt'), function (r) {
        r.classList.toggle('on', routeIds.indexOf(r.getAttribute('data-route')) >= 0);
      });
      Array.prototype.forEach.call(gRoutes.querySelectorAll('.st'), function (c) {
        c.classList.toggle('on', c.getAttribute('data-stop') === stopId);
      });
    }

    /** 좌표가 들어 있는 격자를 찾습니다 (정류장 → 격자 매핑에 사용) */
    function cellAt(x, y) {
      for (var i = 0; i < state.cells.length; i++) {
        var c = state.cells[i], r = cellRect(c);
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return c;
      }
      /* 격자 사이 틈에 걸렸으면 가장 가까운 격자.
         스냅 허용거리는 셀 크기에 비례 — 1km 격자면 예전 값(30px) 그대로,
         셀이 작아지면 줄여서 이웃 셀로 잘못 스냅되지 않게 한다. */
      var best = null, bd = 1e9;
      state.cells.forEach(function (c) {
        var r = cellRect(c);
        var d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
        if (d < bd) { bd = d; best = c; }
      });
      return bd < 30 / Z_SCALE ? best : null;
    }

    /* ------------------------------------------------------ 배치 마커 */
    /** 같은 격자에 여러 수단을 놓아도 겹치지 않도록 위치를 나눠 찍습니다 */
    var OFFSETS = {
      1: [[0, 0]],
      2: [[-7, 0], [7, 0]],
      3: [[0, -6], [-7, 5], [7, 5]]
    };
    function renderPlacements() {
      var effects = {};
      (meta.effects || []).forEach(function (e) { effects[e.type] = e; });

      var byCell = {};
      state.placements.forEach(function (p) {
        (byCell[p.cellId] = byCell[p.cellId] || []).push(p);
      });

      var h = '';
      Object.keys(byCell).forEach(function (cellId) {
        var list = byCell[cellId];
        var c = state.byId[cellId];
        if (!c) return;
        var r = cellRect(c);
        /* 기호 크기를 칸에 맞춥니다. 예전엔 반지름이 8.5px 고정이라
           500m 격자(약 8px)에서는 기호가 칸보다 두 배 컸습니다. */
        var base = Math.min(r.w, r.h) - CELL_OV;
        var cx = r.x + (r.w - CELL_OV) / 2, cy = r.y + (r.h - CELL_OV) / 2;
        var n = Math.min(list.length, 3);
        var d = base * 0.25;
        var offs = n === 1 ? [[0, 0]]
          : n === 2 ? [[-d, 0], [d, 0]]
            : [[0, -d], [-d, d * 0.85], [d, d * 0.85]];
        var rad = base * (n === 1 ? 0.38 : 0.25);
        list.slice(0, 3).forEach(function (p, i) {
          h += markerShape(p.type, cx + offs[i][0], cy + offs[i][1], rad, p.count);
        });
        if (list.length > 3) {
          h += '<text class="pmk-more" font-size="' + (base * 0.34).toFixed(2) + '" x="' + cx.toFixed(1) +
            '" y="' + (cy + base * 0.78).toFixed(1) + '" text-anchor="middle">+' + (list.length - 3) + '</text>';
        }
      });
      gPlaced.innerHTML = h;
    }

    /** 수단별 배치 기호.
        색으로 먼저 구분되고, 모양(원·마름모·삼각)은 색각 이상·흑백 출력 대비입니다.
        예전에는 셋 다 같은 보라색 글자 기호(●◆▲)라 구분이 안 됐습니다. */
    function markerShape(type, x, y, r, count) {
      var g = '<g class="pmk pmk-' + esc(type) + '" stroke-width="' + (r * 0.4).toFixed(2) +
        '" transform="translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')">';
      if (type === 'drt') {
        g += '<path d="M0,' + (-r).toFixed(2) + 'L' + r.toFixed(2) + ',0L0,' + r.toFixed(2) +
          'L' + (-r).toFixed(2) + ',0Z"/>';
      } else if (type === 'freq') {
        var a = r * 1.12;
        g += '<path d="M0,' + (-a).toFixed(2) + 'L' + (a * 0.87).toFixed(2) + ',' + (a * 0.56).toFixed(2) +
          'L' + (-a * 0.87).toFixed(2) + ',' + (a * 0.56).toFixed(2) + 'Z"/>';
      } else {
        g += '<circle r="' + r.toFixed(2) + '"/>';
      }
      /* 같은 칸에 같은 수단을 여러 번 놓으면 개수를 기호 안에 씁니다 */
      if (count > 1) {
        g += '<text class="pmk-n" font-size="' + (r * 1.1).toFixed(2) +
          '" y="' + (r * 0.38).toFixed(2) + '" text-anchor="middle">' + count + '</text>';
      }
      return g + '</g>';
    }

    /* -------------------------------------------------------- 이벤트 */
    var hoverId = null;
    gCells.addEventListener('mousemove', function (e) {
      var r = e.target.closest('rect');
      if (!r) { hoverId = null; hideHoverRing(); return C.hideTip(); }
      var id = r.getAttribute('data-id');
      var c = state.byId[id];
      if (!c) return;
      if (id !== hoverId) { hoverId = id; placeHoverRing(c); }
      if (opt.onCellHover) opt.onCellHover(c, e);
      else C.showTip(defaultCellTip(c), e);
    });
    gCells.addEventListener('mouseleave', function () {
      hoverId = null; hideHoverRing(); C.hideTip();
    });
    gCells.addEventListener('click', function (e) {
      var r = e.target.closest('rect');
      if (!r) return;
      var c = state.byId[r.getAttribute('data-id')];
      if (c && opt.onCellClick) opt.onCellClick(c, e);
    });

    /* ── 정류장 히트 판정 ──────────────────────────────────────────────
       .sthit 층이 있으면(적을 때) DOM 으로, 없으면 기하로 찾습니다.
       전체 2,866개에 투명 원을 깔면 노드가 그만큼 늘어 켜는 데 314ms 가
       걸렸는데, 좌표 비교는 노드를 하나도 안 만듭니다.
       격자 버킷 색인이라 한 번 훑는 비용이 정류장 수와 무관합니다. */
    var _sIdx = null;         // {cell: [stop,...]} · 버킷 한 변 = BUCKET
    var BUCKET = 24;          // SVG 사용자 단위
    function stopBuckets() {
      if (_sIdx && _sIdx._n === state.stops.length) return _sIdx;
      _sIdx = { _n: state.stops.length };
      state.stops.forEach(function (st) {
        var p = C.xy(st);
        var k = Math.floor(p.x / BUCKET) + ':' + Math.floor(p.y / BUCKET);
        (_sIdx[k] = _sIdx[k] || []).push({ s: st, x: p.x, y: p.y });
      });
      return _sIdx;
    }
    /** 화면상 11px 안에서 가장 가까운 정류장. 없으면 null */
    function nearestStop(sx, sy) {
      var idx = stopBuckets();
      var reach = 11 * (zoom.w / W);          // 화면 11px 을 사용자 단위로
      var bx = Math.floor(sx / BUCKET), by = Math.floor(sy / BUCKET);
      var span = Math.ceil(reach / BUCKET);
      var best = null, bd = reach * reach;
      for (var i = -span; i <= span; i++) {
        for (var j = -span; j <= span; j++) {
          var arr = idx[(bx + i) + ':' + (by + j)];
          if (!arr) continue;
          for (var k = 0; k < arr.length; k++) {
            var dx = arr[k].x - sx, dy = arr[k].y - sy, d = dx * dx + dy * dy;
            if (d <= bd) { bd = d; best = arr[k].s; }
          }
        }
      }
      return best;
    }
    function stopAtEvent(e) {
      var el = e.target.closest('.sthit');
      if (el) return el.getAttribute('data-stophit');
      /* 안 그린 정류장은 없는 것으로 칩니다. 이 줄이 없으면 노선을 끈 기본
         화면에서도 좌표 판정이 돌아, 보이지도 않는 정류장이 격자 툴팁을
         덮고 격자 클릭을 가로챕니다. */
      if (!_stopsDrawn) return null;
      if (gRoutes.classList.contains('fathit')) return null;
      if (!state.stopsInteractive) return null;
      var p = toSvgXY(e);
      var st = nearestStop(p.x, p.y);
      return st ? st.id : null;
    }

    svg.addEventListener('mousemove', function (e) {
      var s = stopAtEvent(e);
      if (!s) {
        /* 격자 위 툴팁은 gCells 핸들러가 관리하므로 건드리지 않습니다.
           그 밖(바다·여백)으로 나가면 정류장 툴팁이 남지 않게 접습니다. */
        if (!e.target.closest('.cells')) C.hideTip();
        return;
      }
      var stop = findStop(s);
      if (!stop) return;
      C.showTip('<b>' + esc(stop.name) + '</b><br>경유 ' + routeNames(stop.routes) +
        ' · 클릭하면 시간대 프로파일', e);
    });
    svg.addEventListener('mouseleave', C.hideTip);
    svg.addEventListener('click', function (e) {
      var s = stopAtEvent(e);
      if (!s) return;
      var stop = findStop(s);
      if (!stop || !opt.onStopClick) return;
      var p = C.xy(stop);
      opt.onStopClick(stop, cellAt(p.x, p.y), e);
    });

    /* mousemove 마다 2,866개를 훑던 선형 탐색을 색인으로 바꿉니다.
       state.stops 는 setData 에서만 갈리므로 그때 색인을 버립니다. */
    var _stopIdx = null;
    function findStop(id) {
      if (!_stopIdx || _stopIdx._n !== state.stops.length) {
        _stopIdx = { _n: state.stops.length };
        for (var i = 0; i < state.stops.length; i++) _stopIdx[state.stops[i].id] = state.stops[i];
      }
      return _stopIdx[id] || null;
    }

    /* 실서버 stop.routes 는 노선ID 목록입니다. 화면에는 노선번호로 보여줍니다. */
    function routeNames(ids) {
      var by = {};
      state.routes.forEach(function (r) { by[r.id] = r.name || r.id; });
      var names = (ids || []).map(function (id) { return by[id] || id; });
      if (!names.length) return '노선 정보 없음';
      if (names.length > 5) return names.slice(0, 5).join('·') + ' 외 ' + (names.length - 5) + '개 노선';
      return names.join('·') + '선';
    }

    /* ------------------------------------------------------ 확대·이동
       SVG viewBox 를 조작합니다. 동탄처럼 면적이 작은 동은 전체 뷰에서
       배치 기호가 겹쳐 안 보입니다. 축척바는 지도 좌표계에 있어서
       확대해도 표시 거리(0─5km)가 그대로 맞습니다.
       MIN_W·ZDETAIL_K·zoomAnim 은 파일 상단(Z_SCALE 옆)에서 초기화된다. */

    function isZoomed() { return zoom.w < W - 0.5; }

    function applyZoom() {
      svg.setAttribute('viewBox', zoom.x.toFixed(1) + ' ' + zoom.y.toFixed(1) + ' ' +
        zoom.w.toFixed(1) + ' ' + zoom.h.toFixed(1));
      /* --zk(배율)는 CSS 가 점·선·글자를 역스케일해 화면 크기를 유지하는 데 씁니다.
         정류장 이름은 이름끼리 겹쳐 범벅이 되지 않도록 충분히 확대했을 때만
         (.zdetail — 격자 크기에 비례한 ZDETAIL_K 배부터, 1km 는 10배 = 1px ≈ 6m
         로 건물·골목이 분간되기 시작하는 수준) 드러냅니다. */
      var k = W / zoom.w;
      svg.style.setProperty('--zk', k.toFixed(3));
      var detail = k >= ZDETAIL_K;
      svg.classList.toggle('zdetail', detail);
      /* 카카오 배경 탈색은 .kakaomap 에 걸어야 하는데, 그건 svg 의 자식이 아니라
         형제(.mapbox 안 svg 앞)입니다. `.kkmode.zdetail .kakaomap` 은 자손
         결합자라 어떤 상태에서도 매치되지 않아, 배경만 원색으로 남고 우리
         레이어만 흐려지는 어긋난 조합이 됐습니다. 부모에 클래스를 직접 겁니다. */
      if (svg.parentNode && svg.parentNode.classList) {
        svg.parentNode.classList.toggle('kkdetail', !!kkMap && detail);
      }
      /* 라벨을 확대 상태에서만 DOM 에 만들므로, 경계를 넘을 때 한 번 다시 그립니다.
         매 프레임이 아니라 상태가 바뀌는 순간에만 도는 조건입니다. */
      if (detail !== state.zdetail) {
        state.zdetail = detail;
        if (state.stops && state.stops.length) renderRoutes();
      }
      /* 격자를 클릭해 확대했다가 −버튼·휠로 손수 다시 축소해 전체 배율로
         돌아오면 cellFocus 가 안 풀렸다 — 지금까지는 '전체' 리셋 버튼
         (zoomReset)만 그걸 지웠다. 그러면 '노선·정류장 전체'를 켠 채로 격자를
         들여다보고 다시 축소했을 때, 화면은 전체인데 노선·정류장은 그 격자
         하나로만 남아 켜 둔 '전체'가 사라진 것처럼 보였다. 손으로 축소해도
         전체 배율까지 돌아오면 zoomReset 과 같은 처리를 한다. */
      if (!isZoomed() && state.cellFocus) {
        state.cellFocus = null;
        renderRoutes();
        if (opt.onExitCellFocus) opt.onExitCellFocus();
      }
      if (zctl) zctl.classList.toggle('zoomed', isZoomed());
      /* 1,200% 넘어가면 소수점이 의미가 없어 정수로 끊습니다 */
      if (zpctEl) zpctEl.textContent = Math.round(k * 100).toLocaleString('ko-KR') + '%';
      syncKakao();
    }

    function clampBox(x, y, w) {
      w = Math.max(MIN_W, Math.min(W, w));
      var h = w * H / W;
      return {
        x: Math.max(0, Math.min(W - w, x)),
        y: Math.max(0, Math.min(H - h, y)),
        w: w, h: h
      };
    }

    function animateTo(t) {
      if (zoomAnim) cancelAnimationFrame(zoomAnim);
      var reduce = global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      /* 백그라운드 탭에서는 requestAnimationFrame 이 멈춥니다. 애니메이션으로
         가면 화면이 중간 배율에 멈춘 채 남으므로 목표 상태로 바로 넘깁니다.
         (격자를 클릭한 뒤 탭을 옮기면 실제로 이 상태가 됩니다) */
      if (reduce || !global.requestAnimationFrame ||
          (global.document && global.document.hidden)) {
        zoom = t; applyZoom(); return;
      }
      var from = { x: zoom.x, y: zoom.y, w: zoom.w, h: zoom.h }, t0 = null;
      function step(ts) {
        if (t0 == null) t0 = ts;
        var k = Math.min(1, (ts - t0) / 200);
        k = k * (2 - k);                             // ease-out
        zoom = {
          x: from.x + (t.x - from.x) * k, y: from.y + (t.y - from.y) * k,
          w: from.w + (t.w - from.w) * k, h: from.h + (t.h - from.h) * k
        };
        applyZoom();
        zoomAnim = k < 1 ? requestAnimationFrame(step) : null;
      }
      zoomAnim = requestAnimationFrame(step);
    }

    /* 전체 보기로 돌아가면 격자 초점도 함께 풉니다. 화성시 전체를 보면서
       한 격자의 정류장만 떠 있으면 그게 왜 거기 있는지 알 수 없습니다. */
    function zoomReset() {
      if (state.cellFocus) {
        state.cellFocus = null;
        renderRoutes();
        if (opt.onExitCellFocus) opt.onExitCellFocus();
      }
      animateTo({ x: 0, y: 0, w: W, h: H });
    }

    /** (x,y)가 화면 중심에 오도록 이동합니다. 전체 뷰 상태면 4배로 당겨서 보여줍니다 */
    function focusPoint(x, y) {
      var w = isZoomed() ? zoom.w : W / 4;
      animateTo(clampBox(x - w / 2, y - (w * H / W) / 2, w));
    }

    function focusStop(stopId) {
      var s = findStop(stopId);
      if (!s) return;
      var p = C.xy(s);
      focusPoint(p.x, p.y);
    }

    /** 격자 하나가 화면을 채우도록 확대합니다 (CELL_ZOOM_SPAN 참고).
        focusPoint 를 쓰던 예전 구현은 전체 뷰에서 4배까지만 당겨서, 격자를
        찍어도 카카오 배경이 여전히 시 전체 축척이라 골목이 안 보였습니다. */
    function focusCell(cellId) {
      var c = state.byId[cellId];
      if (!c) return;
      var r = cellRect(c);
      var w = Math.max(MIN_W, Math.min(W, r.w * CELL_ZOOM_SPAN));
      animateTo(clampBox(r.x + r.w / 2 - w / 2,
                         r.y + r.h / 2 - (w * H / W) / 2, w));
    }

    /** 해당 읍면동의 격자들이 화면을 채우도록 확대합니다 */
    function zoomToRegion(regionName) {
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
      state.cells.forEach(function (c) {
        if (c.region !== regionName) return;
        var r = cellRect(c);
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
        n++;
      });
      if (!n) return;
      var w = Math.max((x1 - x0) * 1.35, (y1 - y0) * 1.35 * W / H, MIN_W);
      animateTo(clampBox((x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - (w * H / W) / 2, w));
    }

    /** factor 배 확대(>1)/축소(<1). (sx,sy)는 고정점(SVG 좌표) */
    function zoomAt(factor, sx, sy) {
      /* 폭을 먼저 한계 안으로 clamp 한 뒤, 실제로 적용된 배율로 위치를 옮깁니다.
         요청한 factor 를 그대로 쓰면 최대 배율에 도달한 뒤 휠을 더 굴렸을 때
         폭은 그대로인데 좌상단만 커서 쪽으로 당겨져, 확대는 안 되고 시점만
         오른쪽 아래로 계속 밀려납니다. 한계에 걸리면 f=1 이라 안 움직입니다. */
      var w = Math.max(MIN_W, Math.min(W, zoom.w / factor));
      var f = zoom.w / w;
      zoom = clampBox(sx - (sx - zoom.x) / f, sy - (sy - zoom.y) / f, w);
      applyZoom();
    }

    function toSvgXY(e) {
      var r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return { x: zoom.x, y: zoom.y };
      return { x: zoom.x + (e.clientX - r.left) / r.width * zoom.w,
               y: zoom.y + (e.clientY - r.top) / r.height * zoom.h };
    }

    /* 휠 = 커서 기준 확대/축소 */
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = toSvgXY(e);
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, p.x, p.y);
    }, { passive: false });

    /* ------------------------------------------------------- 분석 영역
       바탕화면에서 파일을 끌어 고르듯 지도에 사각형을 그려, 그 안에서만
       배치하고 그 안의 결과만 봅니다. 영역 지정 모드일 때는 드래그가
       화면 이동 대신 영역 선택으로 동작합니다. */
    var gArea = svg.querySelector('[data-arearect]');
    var band = null;

    function normBand(b) {
      return { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1),
               w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) };
    }
    function drawArea(box, dragging) {
      var el = gArea.firstChild;
      el.setAttribute('x', box.x.toFixed(1));
      el.setAttribute('y', box.y.toFixed(1));
      el.setAttribute('width', box.w.toFixed(1));
      el.setAttribute('height', box.h.toFixed(1));
      el.setAttribute('class', dragging ? 'area-box dragging' : 'area-box');
      gArea.setAttribute('visibility', 'visible');
    }
    /** 사각형 안(중심점 기준)에 든 격자를 영역으로 잡습니다 */
    function commitArea(box) {
      var ids = new Set();
      state.cells.forEach(function (c) {
        var r = cellRect(c);
        var mx = r.x + (r.w - CELL_OV) / 2, my = r.y + (r.h - CELL_OV) / 2;
        if (mx >= box.x && mx <= box.x + box.w && my >= box.y && my <= box.y + box.h) ids.add(c.id);
      });
      if (!ids.size) { clearArea(); return; }
      state.area = ids; state.areaBox = box;
      drawArea(box, false);
      paint();
      if (opt.onAreaChange) opt.onAreaChange(ids, box);
    }
    function clearArea() {
      state.area = null; state.areaBox = null;
      gArea.setAttribute('visibility', 'hidden');
      paint();
      if (opt.onAreaChange) opt.onAreaChange(null, null);
    }

    /* 드래그 = 이동. 4px 미만 움직임은 클릭으로 취급해 배치·선택을 방해하지 않습니다 */
    var pan = null, panMoved = false;
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (state.areaMode) {
        var p = toSvgXY(e);
        band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        drawArea(normBand(band), true);
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 환경 */ }
        e.preventDefault();
        return;
      }
      pan = { cx: e.clientX, cy: e.clientY, x: zoom.x, y: zoom.y };
      panMoved = false;
    });
    svg.addEventListener('pointermove', function (e) {
      if (band) {
        var p = toSvgXY(e);
        band.x1 = p.x; band.y1 = p.y;
        drawArea(normBand(band), true);
        return;
      }
      if (!pan) return;
      var dx = e.clientX - pan.cx, dy = e.clientY - pan.cy;
      if (!panMoved && dx * dx + dy * dy < 16) return;
      if (!panMoved) {
        panMoved = true;
        svg.classList.add('panning');
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 환경 */ }
      }
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      zoom = clampBox(pan.x - dx / r.width * zoom.w, pan.y - dy / r.height * zoom.h, zoom.w);
      applyZoom();
    });
    function endBand() {
      if (!band) return false;
      var box = normBand(band);
      band = null;
      /* 살짝 눌린 정도면 취소 — 실수로 영역이 통째로 바뀌지 않게 */
      if (box.w < zoom.w * 0.01 || box.h < zoom.h * 0.01) {
        if (state.areaBox) drawArea(state.areaBox, false);
        else gArea.setAttribute('visibility', 'hidden');
        return true;
      }
      commitArea(box);
      return true;
    }
    svg.addEventListener('pointerup', function () {
      if (endBand()) return;
      pan = null; svg.classList.remove('panning');
    });
    svg.addEventListener('pointercancel', function () {
      band = null; pan = null; svg.classList.remove('panning');
    });
    /* 드래그 직후의 click 이 배치·선택으로 이어지지 않게 캡처 단계에서 삼킵니다 */
    svg.addEventListener('click', function (e) {
      if (panMoved) { e.stopPropagation(); panMoved = false; }
    }, true);

    /* 확대 버튼 — 우상단에는 나침반이 있어 좌상단에 둡니다 */
    var zctl = null, zpctEl = null;
    if (svg.parentNode && global.document) {
      zctl = global.document.createElement('div');
      zctl.className = 'zctl';
      zctl.innerHTML =
        '<button type="button" data-z="in" aria-label="지도 확대">+</button>' +
        '<button type="button" data-z="out" aria-label="지도 축소">−</button>' +
        '<button type="button" data-z="reset" aria-label="전체 보기">전체</button>' +
        /* 현재 배율. 화성시 전체가 보이는 상태가 100% 입니다. */
        '<div class="zpct" data-zpct aria-live="polite" title="현재 확대 비율 (화성시 전체 = 100%)">100%</div>';
      svg.parentNode.appendChild(zctl);
      zpctEl = zctl.querySelector('[data-zpct]');
      applyZoom();          /* 컨트롤이 생기기 전 확대 상태를 표시에 반영 */
      zctl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-z]');
        if (!b) return;
        var z = b.getAttribute('data-z');
        if (z === 'reset') zoomReset();
        else zoomAt(z === 'in' ? 1.5 : 1 / 1.5, zoom.x + zoom.w / 2, zoom.y + zoom.h / 2);
      });
    }

    function defaultCellTip(c) {
      var mi = typeof c.mi === 'number' ? (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) : '–';
      return '<b>' + esc(c.name) + '</b> <span class="mono">' + esc(c.id) + '</span><br>' +
        '수요 D <b>' + c.demand + '</b> · 공급 S <b>' + c.supply + '</b> · MI <b>' + mi + '</b><br>' +
        '잠재수요 ' + C.fmt(c.flowTripsPerDay) + '통행/일 · 고령비 <b>' +
        Math.round((c.elderlyRatio || 0) * 100) + '%</b>';
    }

    /* --------------------------------------------------------- 공개 */
    return {
      state: state,
      setData: setData,
      setLayer: function (k) { if (LAYERS[k]) { state.layer = k; paint(); } },
      getLayer: function () { return state.layer; },
      select: function (cellId) { state.selectedCellId = cellId; placeRing(); },
      selectedCell: function () { return state.byId[state.selectedCellId] || null; },
      highlightStop: highlightStop,
      cellAt: cellAt,
      setPlacements: function (list) { state.placements = list || []; renderPlacements(); },
      /** 특정 격자만 강조합니다. idSet 이 null 이면 해제.
       *  배치 가능 격자 표시(시뮬레이션)와 권역 강조(대시보드) 양쪽에 씁니다. */
      setEligible: function (idSet, note) {
        state.eligible = idSet || null;
        state.eligibleNote = note || '';
        paint();
      },
      /** false 로 두면 정류장이 격자 클릭을 가로채지 않습니다 */
      setStopsInteractive: function (v) { state.stopsInteractive = !!v; applyStopsInteractive(); },
      /* 꺼진 동안에는 DOM 을 비워 두므로(renderRoutes 참고) 켤 때 다시 그립니다 */
      setShowRoutes: function (v) {
        state.showRoutes = !!v;
        renderRoutes();
      },
      setShowLabels: function (v) { state.showLabels = !!v; gLabels.style.display = v ? '' : 'none'; },
      /** 이 격자에 걸린 정류장·노선만 그립니다. null 이면 해제(전체 토글 상태로 복귀). */
      setCellFocus: function (cellId) {
        state.cellFocus = cellId || null;
        renderRoutes();
      },
      getCellFocus: function () { return state.cellFocus; },
      /** 격자 안에 들어오는 정류장 목록 — 노선 경유 순서 다이어그램이 씁니다.
          지도에 그리는 집합(focusStopIds)과 같은 판정을 써야 카드와 지도가 어긋나지 않습니다. */
      stopsInCell: function (cellId) {
        var c = state.byId[cellId];
        if (!c) return [];
        return state.stops.filter(function (s) { return inCell(c, s); });
      },
      routes: function () { return state.routes; },
      /** 이 정류장이 들어 있는 격자 id — 정류장을 검색해 그 격자로 파고들 때 씁니다.
          격자 사이 틈에 떨어지면 cellAt 이 최근접 격자로 스냅해 줍니다. */
      cellOfStop: function (stopId) {
        var s = findStop(stopId);
        if (!s) return null;
        var p = C.xy(s);
        var c = cellAt(p.x, p.y);
        return c ? c.id : null;
      },
      /** 격자에 실제로 존재하는 읍면동 이름 목록 (가나다순) — 지역 검색용 */
      regions: function () {
        var seen = {};
        state.cells.forEach(function (c) { if (c.region) seen[c.region] = 1; });
        return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
      },
      /** 읍면동 경계선 표시 여부 */
      setShowBoundary: function (v) { gDongLine.style.display = v ? '' : 'none'; },
      setArmed: function (v) {
        state.armed = !!v;
        var box = svg.parentNode;
        if (box && box.classList) box.classList.toggle('arm', !!v);
      },
      cellById: function (id) { return state.byId[id] || null; },
      cells: function () { return state.cells; },
      repaint: paint,
      /** 분석 영역 — 드래그로 사각형을 그려 그 안에서만 배치·집계합니다 */
      setAreaMode: function (v) {
        state.areaMode = !!v;
        svg.classList.toggle('areamode', !!v);
      },
      clearArea: clearArea,
      area: function () { return state.area; },
      areaBox: function () { return state.areaBox; },
      defaultCellTip: defaultCellTip,
      /** 읍면동으로 확대 / 정류장·격자 중심 이동 / 전체 복귀 / 확대 여부 */
      zoomToRegion: zoomToRegion,
      focusStop: focusStop,
      focusCell: focusCell,
      zoomReset: zoomReset,
      isZoomed: isZoomed
    };
  }

  HW.createMap = createMap;
  HW.MAP_LAYERS = LAYERS;
})(window);
