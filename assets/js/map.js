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
    /* 유동인구는 --fl(자주). 예전에는 수요와 같은 'sb'(파랑)를 써서, 두 층을
       번갈아 켜도 지도가 똑같이 보였습니다 — 무엇을 보고 있는지 알 수 없었습니다. */
    flow: { key: 'flow', prefix: 'fl', steps: 5, title: '유동인구(잠재수요)', unit: '5분위', kind: 'sequential' }
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
       cellRect 로 구한 실제 칸 크기에 비례시킨다 — renderPlacements 참고. */
    var Z_SCALE = 1000 / ((meta.grid && meta.grid.sizeMeters) || 1000);
    /* 아래 셋은 drawBase→applyZoom 이 처음 실행되기 전에 초기화돼 있어야 한다.
       MIN_W 의 기본 배율(120)은 1km 실측 근거다 — 정류장 절반이 서로 30m
       이내(왕복 반대편 등)인데, 점·선 굵기를 --zk 로 역스케일해 화면 크기를
       유지하는 한 실제로 더 확대하는 수밖에 없다. 24배에서는 10m 간격이
       화면상 4px 로 뭉쳐 안 갈라지고, 120배는 20px 로 벌려 웬만한 쌍이
       갈라져 보인다. */
    var MIN_W = W / (120 * Z_SCALE);    // 확대 한도 — 1km: 120배 · 500m: 240배
    var ZDETAIL_K = 10 * Z_SCALE;       // 정류장 이름이 드러나는 배율
    var animTargetW = null;
    var zoomAnim = null;
    /* 노선 클리핑 상태도 같은 이유로 여기서 초기화한다 — applyZoom 이 매번
       routeClipStale() 을 부르는데, 그 안에서 _rtGeom.length 를 읽는다.
       아래(renderRouteLines 옆)에 두면 첫 drawBase 때 undefined 라 터진다.
       뜻과 근거는 renderRouteLines 주석 참고. */
    var RT_PAD = 1.0;       // 창 사방에 둘 여유(창 크기의 배수)
    var _rtGeom = [];       // [{id, pts:[[x,y],…]}] — renderRoutes 가 채운다
    var _rtBox = null;      // 지금 그려 둔 창(여유 포함)
    var _rtW = 0;           // 그때의 창 너비
    var _rtFull = false;    // 그때 상자가 지도를 다 덮었나(= 아무것도 안 잘렸나)
    var _onRoutes = [];     // 선택된 정류장이 지나는 노선 id — 다시 깎아도 강조 유지

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
      routeFocus: null,        // 이 노선 하나만 그린다 (버스 번호 검색). cellFocus 보다 우선
      zdetail: false,          // 10배 이상 확대 — 이때만 정류장 이름을 DOM 에 만듭니다
      areaMode: false,         // 영역을 고르는 중인지
      areaDraft: null,         // 고르는 중인 격자 ID Set (확정 전)
      area: null,              // 영역 안 격자 ID Set (null = 화성시 전체)
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
        h += '<path class="dongline" data-dong="' + esc(r.code) + '" data-name="' + esc(r.name) + '" d="' + ringsPath(r.rings) + '"/>';
      });
      h += '</g>';

      /* 노선 선과 정류장을 다른 층에 담습니다. 확대해서 끌 때 노선만 '화면에 드는
         만큼'으로 다시 깎는데(renderRouteLines), 한 innerHTML 에 섞여 있으면 그때마다
         정류장 2,866개까지 통째로 재파싱하게 됩니다. 부모(data-groutes)는 그대로라
         display·fathit·nohit 같은 기존 상태와 CSS 선택자는 손대지 않아도 됩니다. */
      h += '<g data-groutes><g data-grtline></g><g data-grtstop></g></g>';
      /* 정류장 이름표는 따로 담습니다. 노선·정류장과 같은 innerHTML 에 섞여 있으면
         이름표만 다시 그리려 해도 노선 400개·정류장 2,866개(59만 자)를 통째로
         재파싱해야 합니다. 층을 나눠 이름표만 갈아끼웁니다. */
      h += '<g data-gstoplab></g>';

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
      /* 밝기 강조는 칸 위에 반투명 한 장을 덮어서 냅니다. 예전에는 격자 rect 에
         filter:saturate()brightness() 를 걸었는데, filter 는 그 칸을 별도 페인트
         서피스로 승격시켜 마우스가 칸을 넘을 때마다 지도 전체가 다시 래스터됐습니다
         — 실측 호버 프레임 p95 118.5ms · 50ms 초과 6/72. 이 한 장으로 바꾸면
         p95 21ms · 초과 1 입니다. 색상(hue)은 안 바뀌므로 지표 해석은 그대로입니다. */
      h += '<g data-hovring visibility="hidden">' +
        '<rect class="hov-fill" x="-99" y="-99" width="10" height="10"/>' +
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
    /* 컨테이너 크기 캐시. alignKakao 가 매번 clientWidth 를 읽으면, 바로 앞에서
       viewBox 를 써 레이아웃을 더럽힌 직후라 브라우저가 그 자리에서 문서 전체
       레이아웃을 동기로 돌립니다(write→read 레이아웃 스래싱). 휠 핸들러 JS 중앙
       106ms 가 이 한 줄에서 나왔습니다. 크기는 ResizeObserver 가 알려줄 때만
       바뀌므로 그때 갱신합니다. */
    var kkBoxW = 0, kkBoxH = 0;
    function initKakao() {
      var cfg = (HW.CONFIG && HW.CONFIG.KAKAO) || {};
      if (!cfg.enabled || !cfg.jsKey || !svg.parentNode || !global.document) return;
      var div = global.document.createElement('div');
      div.className = 'kakaomap';
      /* 카카오는 정수 줌 레벨로만 반응해서 setBounds 가 요청보다 넓은 범위를
         보여줍니다. 그 차이를 syncKakao 가 CSS 변형으로
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
        kkBoxW = kkBoxH = 0;
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

      /* 컨테이너 크기가 바뀌면 다시 맞춥니다.
         alignKakao 가 거는 변형은 그때의 컨테이너 크기로 계산한 값이라,
         지도 카드가 커지거나 줄었는데 그대로 두면 배경만 옛 크기 기준으로
         남습니다. 전에는 window 의 resize 만 들었는데 그건 **창** 크기가
         바뀔 때만 옵니다. 창은 그대로인 채 카드만 바뀌는 경우는 못 잡습니다 —
         카드 높이를 495 → 300 으로 바꿔 보면 syncKakao 가 한 번도 불리지
         않고 배경이 옛 배율로 남는 것을 확인했습니다. 컨테이너를 직접 봅니다.

         관찰 대상은 .kakaomap(틀)입니다. 변형이 걸리는 .kakaomap-inner 를
         보면 자기가 만든 변화에 자기가 반응할 여지를 남기게 됩니다 —
         transform 은 레이아웃 박스를 안 바꾸므로 실제로는 안 돌지만,
         관찰자를 굳이 그 자리에 두지 않습니다. 크기가 실제로 달라졌을
         때만 도는 가드도 함께 둡니다. */
      function onBoxResize() {
        if (!kkMap) return;
        var w = div.clientWidth, h = div.clientHeight;
        if (!w || !h || (w === kkBoxW && h === kkBoxH)) return;
        kkBoxW = w; kkBoxH = h;
        kkMap.relayout();
        syncKakao();
      }
      if (global.ResizeObserver) {
        new global.ResizeObserver(onBoxResize).observe(div);
        onBoxResize();          /* 첫 크기를 캐시에 채웁니다 */
      } else {
        global.addEventListener('resize', onBoxResize);   // 구형 브라우저 폴백
      }
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
        /* 캐시가 비어 있을 때만 실제로 읽습니다(첫 호출·구형 폴백 경로) */
        if (!kkBoxW || !kkBoxH) { kkBoxW = kkInner.clientWidth; kkBoxH = kkInner.clientHeight; }
        W = kkBoxW;
        H = kkBoxH;
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
    var gRtLine = svg.querySelector('[data-grtline]');
    var gRtStop = svg.querySelector('[data-grtstop]');
    var gStopLab = svg.querySelector('[data-gstoplab]');
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
      /* 밝기 덮개는 칸 전체를, 테두리는 그 안쪽에 */
      var fill = gHovRing.querySelector('.hov-fill');
      if (fill) {
        fill.setAttribute('x', rx.toFixed(2));
        fill.setAttribute('y', ry.toFixed(2));
        fill.setAttribute('width', Math.max(0.5, w).toFixed(2));
        fill.setAttribute('height', Math.max(0.5, h).toFixed(2));
      }
      var el = gHovRing.querySelector('.hov-line');
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

    /** routeFocus 가 가리키는 노선 객체. 없으면 null. */
    function focusRouteObj() {
      if (!state.routeFocus) return null;
      var list = state.routes || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === state.routeFocus) return list[i];
      }
      return null;   /* 데이터가 갈린 경우 — 조용히 필터 없음으로 떨어집니다 */
    }

    /** 그릴 정류장 id 집합. 노선 초점 → 격자 초점 순으로 보고, 둘 다 없으면 null. */
    function focusStopIds() {
      /* 노선 초점이 먼저입니다. 버스 번호로 찾아 들어온 상태에서는 그 노선이
         지나는 정류장만 보여야 하고, 그때 격자 초점이 남아 있으면 노선이 그
         격자 안에서 잘려 "전체 노선을 본다"가 깨집니다. */
      var rt = focusRouteObj();
      if (rt) {
        var rset = {};
        (rt.stopIds || []).forEach(function (id) { rset[id] = 1; });
        if (state.selectedStopId) rset[state.selectedStopId] = 1;
        return rset;
      }
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
        /* 자식 두 층은 남겨 둡니다 — gRoutes.innerHTML='' 로 지우면 gRtLine·gRtStop
           참조가 문서에서 떨어져 나가 이후 그리기가 조용히 아무 데도 안 나갑니다. */
        _rtGeom = []; _rtBox = null;
        gRtLine.innerHTML = '';
        gRtStop.innerHTML = '';
        gRoutes.style.display = 'none';
        /* 이름표는 이제 gRoutes 밖(별도 층)이라 여기서 같이 지워야 합니다. 안 그러면
           격자를 찍어 이름표가 떠 있는 상태(.always)에서 노선을 끄면, 정류장 점은
           사라지고 이름 41개만 빈 지도 위에 남습니다 — 실측으로 재현됩니다
           (격자 재클릭 해제: 정류장 0개 · 이름표 41개). */
        _labStops = []; _labAlways = false;
        renderStopLabels();
        _stopsDrawn = false;
        svg.classList.remove('rtfocus');
        return;
      }
      var stops = only ? state.stops.filter(function (s) { return only[s.id]; }) : state.stops;
      /* 노선 초점일 때 정류장 집합으로 노선을 거르면 안 됩니다 — 그 정류장들을 함께
         지나는 다른 노선까지 걸려 들어와, 한 노선만 보려던 화면이 다시 다발이 됩니다.
         그래서 노선 쪽은 id 로 딱 하나만 집습니다. */
      var rtOnly = focusRouteObj();
      var routes = rtOnly
        ? [rtOnly]
        : only
          ? state.routes.filter(function (rt) {
              return (rt.stopIds || []).some(function (id) { return only[id]; });
            })
          : state.routes;

      /* 노선 선은 좌표만 뽑아 두고, 그리는 일은 renderRouteLines 가 맡습니다
         (화면에 드는 구간만 — 아래 설명).

         노선 하나를 들여다볼 때는 **가는 길과 오는 길을 갈라** 둡니다. 한 노선
         기록에 두 방향이 이어 담겨 있어서(200개 중 185개가 기점=종점) 그냥 그리면
         선이 제자리로 돌아와 겹치고, 어느 쪽이 가는 길인지 알 수 없습니다.
         가르는 자리는 백엔드가 넣어 준 turnIdx(경로 기하 추정)이고, 없으면
         (편도·똑버스·예약제 18개) 예전처럼 한 줄로 그립니다.
         아래 클리핑 루프는 조각 단위로 도므로, 여기서 둘로 나눠 넣기만 하면 됩니다. */
      _rtGeom = [];
      routes.forEach(function (rt) {
        var g = routeXY(rt);
        var t = rtOnly ? rt.turnIdx : null;   /* 초점일 때만 가릅니다 */
        if (t != null && t > 0 && t < g.pts.length - 1) {
          _rtGeom.push({ id: g.id, pts: g.pts.slice(0, t + 1), dir: 0 });
          _rtGeom.push({ id: g.id, pts: g.pts.slice(t), dir: 1 });
        } else {
          _rtGeom.push(g);
        }
      });
      _rtBox = null;                 /* 목록이 바뀌었으니 이전 클립 창은 버립니다 */
      renderRouteLines();

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
      /* 이름표는 아래 renderStopLabels 가 별도 층에 그립니다(화면에 드는 것만). */
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
      /* 노선 하나만 보는 중임을 CSS 에 알립니다 — 그때는 선을 실선·진하게 그립니다.
         기본(전체 표시)에서는 노선이 배경이라 흐리게 두는 게 맞지만, 일부러 찾아
         들어온 노선은 주인공이라 같은 규칙을 쓰면 안 보입니다. */
      svg.classList.toggle('rtfocus', !!rtOnly);
      gRtStop.innerHTML = h;
      /* 격자를 찍어 놓은 동안에는 전체 토글이 꺼져 있어도 그 격자 것은 보여야 합니다 */
      gRoutes.style.display = (state.showRoutes || only) ? '' : 'none';
      _labStops = stops;
      /* 컬링 면제(always)는 **격자 초점에만** 줍니다. 격자는 정류장이 몇 개(786칸 중
         최대 41개·중앙값 2개)고 focusCell 이 CELL_ZOOM_SPAN 만큼 당겨 놓은 상태라
         전부 그려도 읽힙니다. 노선은 한 줄에 최대 241개(1000번)가 걸립니다.

         ⚠️ 면제 기준을 개수로 바꾸고 싶어질 텐데("짧은 노선은 살려 주자"), 그럴
            필요가 없습니다. 노선 초점 배율은 zoomToBox 가 노선 bbox×1.35 로 잡으므로
            **정류장이 적은 노선일수록 배율이 저절로 높아져** 이미 zdetail 입니다.
            실측(200개 노선, 1600×1000 화면, 이름표를 예전 방식대로 넣고 화면 겹침 측정):

              똑버스01  3개 · 120.0배 · 겹침  0% · zdetail ✔ → 이름표 나옴
              13-1      6개 ·  69.6배 · 겹침  0% · zdetail ✔ → 나옴
              4403     13개 ·  12.2배 · 겹침 31% · zdetail ✔ → 나옴
              M4130    17개 ·   4.5배 · 겹침 71% · zdetail ✘ → 안 나옴
              45       26개 ·   5.5배 · 겹침 85% · zdetail ✘
              400     152개 ·   1.8배 · 겹침 99% · zdetail ✘
              1000    241개 ·   1.1배 · 겹침100% · zdetail ✘

            zdetail 경계(10배)가 읽힘 경계(겹침 31%→71%)와 거의 그대로 겹칩니다.
            즉 보통 경로에 맡기면 읽히는 노선은 나오고 안 읽히는 노선만 빠집니다.
            개수 임계값(예 60개)을 두면 겹침 92% 짜리 화면을 도로 켜게 됩니다.

         면제해 두면 안 되는 이유는 두 가지입니다 — (1) 위 표대로 못 읽고, (2) 노선
         초점은 applyZoom 의 자동 해제 대상이 아니라(격자와 달리 손수 축소하는 것이
         정상 조작이라 일부러 뺐습니다 — zoomReset 주석 참고) 오래 남는데, 그동안
         모든 팬·휠이 그 <text> 들을 재레이아웃합니다. */
      _labAlways = !!only && !rtOnly;
      renderStopLabels();
      _stopsDrawn = true;
      applyStopsInteractive();
      /* 위에서 DOM 을 통째로 새로 만들었으므로 선택 표시(.on)가 날아갑니다.
         정류장을 검색해 그 격자로 파고드는 흐름이 setCellFocus → renderRoutes
         순서라, 여기서 복원하지 않으면 "검색한 정류장이 선택돼 보인다"가 깨집니다. */
      if (state.selectedStopId) highlightStop(state.selectedStopId);
    }

    /* ── 노선 선: 화면에 드는 구간만 ──────────────────────────────────
       확대해 놓고 마우스로 끌 때 프레임을 통째로 먹는 것이 이 층입니다. 층을
       하나씩 꺼 가며 잰 결과(zdetail·1,455% · 동탄 · 프레임 간격 중앙값):

         현재 200ms │ 노선 층만 끔 33ms(-83%) │ 점선만 해제 83ms(-58%)
         케이싱만 끔·정류장 점 끔·이름표 끔·격자 끔·카카오 배경 끔 → 모두 0%

       즉 비용은 사실상 전부 노선이고, 그중 대부분이 점선입니다. 점선 개수는
       '경로 길이 ÷ 점선 주기'인데 주기를 --zk 로 역스케일해 화면상 굵기를
       유지하므로, 확대할수록 주기가 잘게 쪼개집니다(14.5배에서 5px → 0.34
       사용자단위). 게다가 노선 201개는 저마다 시 전체를 가로지르는 폴리라인이라
       화면에 0.5% 만 걸쳐도 브라우저는 경로 **전체** 길이만큼 점선을 셉니다.

       그래서 창 밖 구간을 잘라 냅니다. 점선을 포기하지 않고 같은 이득이 나고
       (200 → 83ms, 점선 해제와 동일), 둘을 겹치면 67ms 입니다. 자른 자리는
       창 밖이라 보이지 않으므로 화면은 그대로입니다 — app.css 의 "노선은
       실제 도로 형상이 아니라 모식도" 라는 표현을 지웠다면 잃었을 주장입니다.
       (자른 조각은 점선 위상이 그 자리에서 다시 시작하므로, 그것만은
        stroke-dashoffset 으로 되돌려 줘야 합니다 — 아래 emitRun 참고.)

       ⚠️ 매 프레임 깎지 않습니다(1회 9.8ms). 창의 사방에 제 크기만큼 여유를
          두고 잘라 두었다가 그 여유를 벗어났을 때만 다시 깎고(routeClipStale),
          '더 촘촘히 자르면 싸지겠다'는 쪽은 멈춘 뒤로 미룹니다(routeClipLoose).
          확대·축소 애니메이션은 지나갈 구간을 animateTo 가 미리 통째로 넘겨
          200ms 동안 0회로 만듭니다.

       (상태 변수 RT_PAD·_rtGeom·_rtBox·_rtW·_onRoutes 는 초기화 순서 때문에
        파일 상단 MIN_W 옆에 선언돼 있습니다 — 거기 주석 참고.) */

    function routeXY(rt) {
      var src = rt.pathXY, pts = [], i;
      if (src && src.length) {
        for (i = 0; i < src.length; i++) pts.push([+src[i][0], +src[i][1]]);
      } else {
        var path = rt.path || [];
        for (i = 0; i < path.length; i++) {
          var q = C.project(path[i][0], path[i][1]);
          pts.push([+q.x.toFixed(1), +q.y.toFixed(1)]);
        }
      }
      return { id: rt.id, pts: pts };
    }

    /** 여유를 포함한 창이 지도를 다 덮는가 — 그러면 자를 것이 하나도 없습니다. */
    function routeBoxCoversAll(v) {
      var mx = v.w * RT_PAD, my = v.h * RT_PAD;
      return v.x - mx <= 0 && v.y - my <= 0 &&
        v.x + v.w + mx >= W && v.y + v.h + my >= H;
    }

    /** 지금 당장 다시 깎아야 하는가 — 창이 잘라 둔 상자를 벗어나 노선이 비어 보이는 경우.
     *  applyZoom 이 매 프레임 부르므로 값 비교만 합니다.
     *
     *  ⚠️ 예전에는 여기에 배율 조건(zoom.w > _rtW*1.8 || < _rtW*0.5)이 함께 있었는데,
     *     그건 '더 촘촘히 잘라 두면 프레임이 싸진다'는 최적화지 지금 고쳐야 하는 일이
     *     아닙니다. 그런데 applyZoom 이 이걸 그 자리에서 실행하는 바람에, 축소
     *     애니메이션 200ms 안에서 노선 층이 3~4번 통째로 다시 만들어졌습니다.
     *     그중 뒤쪽 1~2번은 상자가 이미 지도 전체를 덮어 **한 구간도 안 잘리는**,
     *     즉 화면상 달라지는 픽셀이 0인 23만 자짜리 재파싱이었습니다. 바꾸기 전
     *     코드는 이 구간에서 노선 DOM 을 한 번도 안 건드렸으므로 순수 회귀였습니다.
     *     지금은 최적화 쪽을 routeClipLoose 로 떼어 움직임이 멈춘 뒤로 미룹니다. */
    function routeClipStale() {
      if (!_rtGeom.length) return false;
      if (!_rtBox) return true;
      /* 전에도 다 덮었고 지금도 다 덮으면 결과가 '노선 전부'로 같습니다 — 건너뜁니다 */
      if (_rtFull && routeBoxCoversAll(zoom)) return false;
      return zoom.x < _rtBox.x0 || zoom.y < _rtBox.y0 ||
        zoom.x + zoom.w > _rtBox.x1 || zoom.y + zoom.h > _rtBox.y1;
    }

    /** 미뤄도 되는 쪽 — 상자를 너무 넓게 잡아 둬서 프레임이 필요 이상으로 비싼 경우.
     *  많이 확대해 들어갔을 때 걸립니다. 화면은 이미 맞으므로 멈춘 뒤에 손봅니다. */
    function routeClipLoose() {
      return !!_rtBox && !!_rtGeom.length && zoom.w < _rtW * 0.5;
    }

    var _rtTimer = null;
    function scheduleRouteLines() {
      if (_rtTimer) global.clearTimeout(_rtTimer);
      _rtTimer = global.setTimeout(function () {
        _rtTimer = null;
        /* 미뤄 두는 사이에 상황이 달라졌을 수 있으니 그때 다시 봅니다. 축소
           애니메이션의 앞 프레임들은 '상자를 너무 넓게 잡아 뒀다'로 보이지만,
           끝나고 나면 창이 그 상자만큼 커져 있어 다시 깎아 봐야 **바이트까지
           똑같은** 전량 재구축이 됩니다(실측 247,364자 → 247,364자). */
        if (routeClipLoose()) renderRouteLines();
      }, 140);
    }

    /** @param view 잘라 둘 창. 생략하면 지금 창. animateTo 는 애니메이션이 지나갈
     *              구간을 통째로 넘겨, 그 200ms 동안 다시 깎을 일이 없게 합니다. */
    function renderRouteLines(view) {
      if (!gRtLine) return;
      if (_rtTimer) { global.clearTimeout(_rtTimer); _rtTimer = null; }
      var v = view || zoom;
      var mx = v.w * RT_PAD, my = v.h * RT_PAD;
      _rtBox = { x0: v.x - mx, y0: v.y - my,
                 x1: v.x + v.w + mx, y1: v.y + v.h + my };
      _rtW = v.w;
      _rtFull = routeBoxCoversAll(v);
      var b = _rtBox, cas = '', main = '', i, j, dir;
      for (i = 0; i < _rtGeom.length; i++) {
        var P = _rtGeom[i].pts, id = esc(_rtGeom[i].id), run = null, at = 0, off = 0;
        /* 가는 길/오는 길 조각이면 그 표시를 선에 실어 색을 가릅니다(renderRoutes 참고) */
        dir = _rtGeom[i].dir;
        for (j = 0; j < P.length - 1; j++) {
          var a = P[j], c = P[j + 1];
          /* 선분의 경계상자로 판정합니다 — 걸치지 않는 것을 확실히 버리기만 하면
             되므로, 실제로는 안 지나는데 남는 선분이 몇 개 있어도 무해합니다. */
          var lx = a[0] < c[0] ? a[0] : c[0], hx = a[0] < c[0] ? c[0] : a[0];
          var ly = a[1] < c[1] ? a[1] : c[1], hy = a[1] < c[1] ? c[1] : a[1];
          if (hx >= b.x0 && lx <= b.x1 && hy >= b.y0 && ly <= b.y1) {
            if (!run) { run = [a[0] + ',' + a[1]]; off = at; }
            run.push(c[0] + ',' + c[1]);
          } else if (run) {
            emitRun(run, id, off, dir);
            run = null;
          }
          /* 노선 시작점부터의 거리. 아래 emitRun 이 점선 위상을 맞추는 데 씁니다. */
          at += Math.sqrt((c[0] - a[0]) * (c[0] - a[0]) + (c[1] - a[1]) * (c[1] - a[1]));
        }
        if (run && run.length > 1) emitRun(run, id, off, dir);
      }
      /* 1단계: 케이싱(바탕색 굵은 선) → 2단계: 본선. 케이싱을 먼저 다 깔아야
         격자 색 위에서도 선이 끊겨 보이지 않습니다. 그래서 두 문자열로 모읍니다. */
      function emitRun(run, id, off, dir) {
        var s = run.join(' ');
        cas += '<polyline class="rt-casing" points="' + s + '"/>';
        /* stroke-dashoffset — 자른 조각은 그 자리에서 점선이 다시 시작하므로,
           다시 깎을 때마다 자르는 위치가 달라지면 화면 안의 모든 점선이 한 프레임에
           같이 튑니다(실측 최대 9px, 케이싱 실선은 안 움직여 그 위를 미끄러집니다).
           노선 시작점부터의 거리를 위상으로 되돌려 주면 어디서 자르든 원래 자리에
           점선이 놓입니다 — 그래야 "자른 자리는 창 밖이라 화면은 그대로"가 참이 됩니다.
           (.kkmode.zdetail 이 아니면 stroke-dasharray 가 없어 이 값은 무시됩니다) */
        main += '<polyline class="rt' + (dir === 0 ? ' dir0' : dir === 1 ? ' dir1' : '') +
          '" data-route="' + id + '" stroke-dashoffset="' +
          off.toFixed(1) + '" points="' + s + '"/>';
      }
      gRtLine.innerHTML = cas + main;
      /* 다시 만들었으니 선택 강조(.on)가 날아갑니다. 정류장 층은 그대로이므로
         highlightStop 전체를 다시 돌리지 않고 노선 쪽만 되돌립니다. */
      if (_onRoutes.length) {
        Array.prototype.forEach.call(gRtLine.querySelectorAll('.rt'), function (r) {
          if (_onRoutes.indexOf(r.getAttribute('data-route')) >= 0) r.classList.add('on');
        });
      }
    }

    /* ── 정류장 이름표 ────────────────────────────────────────────────
       확대(zdetail)해야 보이는데, 예전에는 2,866개를 통째로 만들어 두고 CSS 로만
       감췄습니다. SVG <text> 는 viewBox 가 바뀔 때마다 전부 재레이아웃 대상이라,
       확대해 둔 채 팬하면 프레임마다 2,866개 텍스트를 다시 재게 됩니다 —
       실측 프레임당 레이아웃 248ms, 이름표를 빼면 2.7ms(-99%).
       그래서 **지금 화면에 드는 것만** 만듭니다. 확대하면 수십 개입니다.
       격자를 클릭한 상태(always)는 몇 개 안 되므로 컬링하지 않습니다. */
    var _labStops = [];       // 그릴 후보 (renderRoutes 가 고른 것)
    var _labAlways = false;   // 격자 포커스 상태 — 배율·화면과 무관하게 전부 표시
    var _labKey = '';         // 같은 화면이면 다시 안 그리게
    var _labTimer = null;

    /* 팬·확대 중에는 미룹니다. 이름표는 SVG 좌표라 viewBox 와 함께 따라 움직이므로
       움직이는 동안 갱신하지 않아도 어긋나지 않습니다 — 새로 드러난 가장자리만
       잠깐 비는데 아래 20% 여유가 그걸 덮습니다. 프레임당 비용이 0 이 됩니다. */
    function scheduleStopLabels() {
      if (_labTimer) global.clearTimeout(_labTimer);
      _labTimer = global.setTimeout(function () { _labTimer = null; renderStopLabels(); }, 120);
    }

    function renderStopLabels() {
      if (!gStopLab) return;
      if (!(state.zdetail || _labAlways) || !_labStops.length) {
        if (_labKey !== 'off') { gStopLab.innerHTML = ''; _labKey = 'off'; }
        return;
      }
      var list = _labStops, key;
      /* 키에는 '어떤 화면인가' 를 다 담아야 합니다. 개수만으로는 세 가지가 겹칩니다.
           · 정류장 수가 같은 다른 격자로 이동 — 맞닿은 격자 쌍 2,847개 중 165쌍이
             0 아닌 같은 개수입니다(다사5811·다사5812 둘 다 18개).
           · 같은 격자 안에서 선택 정류장만 교체 — focusStopIds 가 selectedStopId 를
             격자 밖이어도 집합에 넣으므로(아래 참고) 개수가 그대로입니다. 그런
             정류장 129개·격자 30개, 실제로 부딪히는 키가 14개입니다.
           · 뷰포트 가지도 마찬가지 — 창이 안 움직인 채 초점만 갈리는 순간이 있습니다.
         겹치면 아래에서 조기 반환해, 점은 새 자리에 찍히는데 이름표는 옛 자리에
         남습니다(§8.3 이 기록한 유령 이름표와 같은 증상). 그래서 두 가지 모두 앞에
         무엇을 보고 있는지를 붙입니다. 팬·휠 중에는 이 셋이 상수라 캐시는 그대로 듭니다. */
      var who = (state.cellFocus || '') + '/' + (state.routeFocus || '') + '/' +
        (state.selectedStopId || '');
      if (_labAlways) {
        key = 'always:' + who + ':' + list.length;
      } else {
        var mx = zoom.w * 0.2, my = zoom.h * 0.2;
        var x0 = zoom.x - mx, x1 = zoom.x + zoom.w + mx;
        var y0 = zoom.y - my, y1 = zoom.y + zoom.h + my;
        list = [];
        for (var i = 0; i < _labStops.length; i++) {
          var q = C.xy(_labStops[i]);
          if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) list.push(_labStops[i]);
        }
        key = 'v:' + who + ':' +
          x0.toFixed(0) + ',' + y0.toFixed(0) + ',' + x1.toFixed(0) + ',' + y1.toFixed(0) +
          ':' + list.length;
      }
      if (key === _labKey) return;
      _labKey = key;
      var h = '';
      for (var j = 0; j < list.length; j++) {
        var s2 = list[j], p2 = C.xy(s2);
        h += '<text class="stlab' + (_labAlways ? ' always' : '') + '" x="' + p2.x + '" y="' + p2.y +
          '" dy="-1.1em" text-anchor="middle">' + esc(s2.name) + '</text>';
      }
      gStopLab.innerHTML = h;
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
        /* 지정 중에는 고른 칸을 또렷하게, 확정 뒤에는 영역 밖을 물립니다.
           아직 하나도 안 골랐으면 지도를 그대로 보여 줘야 고를 수 있습니다. */
        var pick = null, isDraft = false;
        if (state.areaMode) {
          if (state.areaDraft && state.areaDraft.size) { pick = state.areaDraft; isDraft = true; }
        } else if (state.area) pick = state.area;
        if (pick) cls += pick.has(id) ? (isDraft ? ' indraft' : '') : ' outarea';
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
        /* 임계값 정본은 서버 meta.scale 이다. 로컬 폴백 상수는 백엔드(±1.2/±0.7)와
           값이 갈라져 있던 사본이라 제거 — meta 가 없으면 눈금 수치를 생략하고
           색 띠만 그린다(틀린 눈금보다 없는 눈금이 낫다). */
        var th = (state.scale && state.scale.miThresholds) || [];
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
      _onRoutes = routeIds;   /* 노선을 다시 깎아도 강조가 유지되게 (renderRouteLines) */
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

    /** 수단별 배치 기호 — 수단색 원형 뱃지 + 흰 픽토그램.
        도구 버튼·배치 목록과 같은 그림(표지판/호출 승합차/버스+)이라
        "버튼에서 고른 것"이 지도에서 같은 얼굴로 나타납니다. 흑백 출력에서도
        픽토그램 자체가 모양 구분을 대신합니다(예전 원·마름모·삼각의 역할).
        같은 칸에 여러 번 놓으면 그림 대신 개수를 씁니다 — 작은 뱃지 안에
        둘 다 넣으면 어느 쪽도 안 읽힙니다. */
    var PMK_GLYPH = {
      stop: '<rect x="4.2" y="1.8" width="7.6" height="5.2" rx="1.2"/>' +
        '<path d="M6.3 4.4h3.4M8 7v6.2M5.2 13.2h5.6"/>',
      drt: '<rect x="1.6" y="5.4" width="10.6" height="5.8" rx="1.6"/>' +
        '<path d="M1.6 8.3h10.6M13.4 2.6a3.4 3.4 0 0 1 1.8 3"/>' +
        '<circle cx="4.4" cy="12.6" r="1.25"/><circle cx="9.4" cy="12.6" r="1.25"/>',
      freq: '<rect x="1.6" y="6" width="9.4" height="5.4" rx="1.4"/>' +
        '<path d="M1.6 8.7h9.4M13.2 1.9v4M11.2 3.9h4"/>' +
        '<circle cx="4.2" cy="12.8" r="1.2"/><circle cx="8.6" cy="12.8" r="1.2"/>'
    };
    function markerShape(type, x, y, r, count) {
      var R = r * 1.15;
      var g = '<g class="pmk pmk-' + esc(type) + '" transform="translate(' +
        x.toFixed(1) + ',' + y.toFixed(1) + ')">';
      g += '<circle r="' + R.toFixed(2) + '"/>';
      if (count > 1) {
        g += '<text class="pmk-n" font-size="' + (R * 1.15).toFixed(2) +
          '" y="' + (R * 0.4).toFixed(2) + '" text-anchor="middle">' + count + '</text>';
      } else if (PMK_GLYPH[type]) {
        var k = (R / 10).toFixed(3);
        g += '<g class="pmk-g" transform="scale(' + k + ') translate(-8,-8)">' +
          PMK_GLYPH[type] + '</g>';
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
      if (!c) return;
      /* 영역을 고르는 중에는 클릭이 '배치'가 아니라 '이 칸 넣기/빼기' 입니다 */
      if (state.areaMode) {
        if (areaDragged) { areaDragged = false; return; }   /* 드래그 끝의 클릭은 무시 */
        toggleDraftCell(c.id);
        return;
      }
      if (opt.onCellClick) opt.onCellClick(c, e);
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
      /* 끄는 중에는 정류장 판정을 건너뜁니다. 판정은 toSvgXY 로 지도 상자의 화면
         좌표를 읽는데, 바로 앞에서 applyZoom 이 viewBox 를 써 놓아 강제 동기
         레이아웃이 걸립니다(실측 2.8ms) — 게다가 히트 층이 없는 전체 표시
         상태에서는 nearestStop 이 2,866개를 좌표로 훑습니다. 끌고 있는 동안
         정류장 툴팁을 띄울 이유도 없습니다(위 pointermove 에서 이미 접었습니다). */
      if (pan && panMoved) return;
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
        /* 이름표는 별도 층이라 노선·정류장을 다시 파싱하지 않고 그 층만 갈아끼웁니다
           (예전에는 여기서 renderRoutes 가 통째로 돌아 59만 자를 재파싱했습니다). */
        renderStopLabels();
      }
      /* 화면이 움직였으면 이름표 대상이 달라졌을 수 있습니다 — 멈춘 뒤 한 번 */
      if (state.zdetail || _labAlways) scheduleStopLabels();
      /* 격자를 클릭해 확대했다가 −버튼·휠로 손수 다시 축소해 전체 배율로
         돌아오면 cellFocus 가 안 풀렸다 — 지금까지는 '전체' 리셋 버튼
         (zoomReset)만 그걸 지웠다. 그러면 '노선·정류장 전체'를 켠 채로 격자를
         들여다보고 다시 축소했을 때, 화면은 전체인데 노선·정류장은 그 격자
         하나로만 남아 켜 둔 '전체'가 사라진 것처럼 보였다. 손으로 축소해도
         전체 배율까지 돌아오면 zoomReset 과 같은 처리를 한다. */
      /* ⚠️ '지금 배율'로 판단하면 안 된다. 격자를 클릭해 확대할 때 첫 프레임은
         아직 전체 배율이라, 방금 설정한 cellFocus 를 그 자리에서 지워 버린다
         (같은 격자 재클릭 해제가 한 박자씩 밀리던 원인). 애니메이션 중에는
         '가려는 배율'로 판단한다. */
      var wGoal = (zoomAnim && animTargetW != null) ? animTargetW : zoom.w;
      if (wGoal >= W - 0.5 && state.cellFocus) {
        state.cellFocus = null;
        renderRoutes();
        if (opt.onExitCellFocus) opt.onExitCellFocus();
      }
      /* 노선 선은 잘라 둔 창을 벗어났을 때만 그 자리에서 다시 깎습니다. 이름표처럼
         미루지 않는 이유 — 이름표는 없으면 비어 보일 뿐이지만, 노선이 비면
         "여기는 노선이 없다"는 틀린 주장이 됩니다. 반대로 '너무 넓게 잘라 둬서
         비싸다'는 화면이 이미 맞는 상태라 멈춘 뒤로 미룹니다.
         바로 위 격자 초점 해제 뒤에 두는 이유 — 그 분기의 renderRoutes 가 노선
         목록을 전체로 갈아끼우고 이미 다시 깎습니다. 앞에 두면 같은 프레임에
         옛 목록으로 한 번, 새 목록으로 한 번, 두 번 쓰게 됩니다. */
      if (routeClipStale()) renderRouteLines();
      else if (routeClipLoose()) scheduleRouteLines();
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
      animTargetW = t.w;
      var reduce = global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      /* 백그라운드 탭에서는 requestAnimationFrame 이 멈춥니다. 애니메이션으로
         가면 화면이 중간 배율에 멈춘 채 남으므로 목표 상태로 바로 넘깁니다.
         (격자를 클릭한 뒤 탭을 옮기면 실제로 이 상태가 됩니다) */
      if (reduce || !global.requestAnimationFrame ||
          (global.document && global.document.hidden)) {
        zoom = t; applyZoom(); return;
      }
      /* 애니메이션이 지나갈 구간(지금 창 ∪ 목표 창)을 한 번에 담아 노선을 미리
         깎아 둡니다. 보간은 x·w 를 각각 선형으로 섞으므로 중간 창은 전부 이
         합집합 안에 들어옵니다 — 그래서 200ms 동안 다시 깎을 일이 0 이 됩니다.
         이 한 번의 비용은 클릭한 그 순간에 묻히지, 애니메이션 한복판에서
         프레임을 떨어뜨리지 않습니다. */
      if (_rtGeom.length) {
        var ux = Math.min(zoom.x, t.x), uy = Math.min(zoom.y, t.y);
        renderRouteLines({
          x: ux, y: uy,
          w: Math.max(zoom.x + zoom.w, t.x + t.w) - ux,
          h: Math.max(zoom.y + zoom.h, t.y + t.h) - uy
        });
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
        if (k >= 1) animTargetW = null;
        zoomAnim = k < 1 ? requestAnimationFrame(step) : null;
      }
      zoomAnim = requestAnimationFrame(step);
    }

    /* 전체 보기로 돌아가면 격자 초점도 함께 풉니다. 화성시 전체를 보면서
       한 격자의 정류장만 떠 있으면 그게 왜 거기 있는지 알 수 없습니다.
       노선 초점도 여기서 풉니다 — 다만 위 applyZoom 의 자동 해제에는 넣지
       않았습니다. 격자와 달리 **노선은 전체를 보려고 축소하는 것이 정상 조작**이라,
       손으로 축소했다고 풀어 버리면 사용자와 싸우게 됩니다. 명시적으로 '전체'를
       눌렀을 때만 풉니다. */
    function zoomReset() {
      if (state.cellFocus || state.routeFocus) {
        state.cellFocus = null;
        state.routeFocus = null;
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
    /** 사각형이 화면에 담기게 확대합니다(사방 여유 35%). 읍면동·노선이 같이 씁니다. */
    function zoomToBox(x0, y0, x1, y1) {
      var w = Math.max((x1 - x0) * 1.35, (y1 - y0) * 1.35 * W / H, MIN_W);
      animateTo(clampBox((x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - (w * H / W) / 2, w));
    }

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
      zoomToBox(x0, y0, x1, y1);
    }

    /** 노선 전 구간이 담기게 확대합니다. 좌표는 routeXY 가 이미 투영해 둔 것을 씁니다. */
    function zoomToRoute(rt) {
      var pts = routeXY(rt).pts;
      if (!pts.length) return;
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (var i = 0; i < pts.length; i++) {
        if (pts[i][0] < x0) x0 = pts[i][0];
        if (pts[i][0] > x1) x1 = pts[i][0];
        if (pts[i][1] < y0) y0 = pts[i][1];
        if (pts[i][1] > y1) y1 = pts[i][1];
      }
      zoomToBox(x0, y0, x1, y1);
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

    /** 지도 상자의 화면 좌표 — 한 프레임 동안 캐시합니다.
     *
     *  ⚠️ 핸들러 안에서 그때그때 읽으면 안 됩니다. 바로 앞에서 applyZoom 이
     *     viewBox 와 --zk 를 써 놓았고, --zk 는 CSS 26곳에서 점·선·글자 크기를
     *     역스케일하는 데 쓰입니다. 그래서 이 한 줄이 SVG 전체의 스타일 재계산과
     *     레이아웃을 그 자리에서 끝내게 만듭니다(강제 동기 레이아웃).
     *
     *     휠은 한 프레임에 여러 개가 몰려 들어오는데 스로틀이 없어, 그때마다
     *     전체 레이아웃을 다시 했습니다 — 실측 **이벤트당 81.7ms**, 12노치
     *     버스트에서 **980.8ms 로 휠 처리 JS 전체의 95%** 였습니다.
     *     (팬에서는 --zk 가 안 바뀌어 같은 호출이 2.8ms 입니다. 배율이 바뀌느냐가
     *      30배를 가릅니다.)
     *
     *  한 프레임만 들고 있는 이유 — 같은 프레임 안에서는 상자가 움직일 수 없으니
     *  버스트 전체가 한 번만 읽으면 됩니다. 반대로 프레임이 바뀌면 사이드바가
     *  접히거나 스크롤돼 상자가 옮겨졌을 수 있어 그냥 버립니다. ResizeObserver 만
     *  걸면 '크기는 그대로인데 위치만 밀린' 경우를 놓칩니다. */
    var mapRect = null, mapRectRaf = 0;
    function svgRect() {
      if (mapRect) return mapRect;
      mapRect = svg.getBoundingClientRect();
      if (global.requestAnimationFrame && !mapRectRaf) {
        mapRectRaf = global.requestAnimationFrame(function () { mapRectRaf = 0; mapRect = null; });
      }
      return mapRect;
    }

    function toSvgXY(e) {
      /* 끄는 중이면 그 제스처 내내 잡아 둔 값을 씁니다(pointerdown 에서 한 번) */
      var r = panRect || svgRect();
      if (!r.width || !r.height) return { x: zoom.x, y: zoom.y };
      return { x: zoom.x + (e.clientX - r.left) / r.width * zoom.w,
               y: zoom.y + (e.clientY - r.top) / r.height * zoom.h };
    }

    /* 휠 = 커서 기준 확대/축소.
       휠은 한 프레임 안에 여러 개가 몰려 들어옵니다(트랙패드는 특히). 이벤트마다
       applyZoom 을 부르면 그 프레임에는 마지막 것 하나만 화면에 나오는데도 12번을
       다 계산합니다 — 실측 12노치 버스트에서 카카오 setBounds 만 12회(19.7ms)였고,
       그동안 실제로 그려진 프레임은 5개였습니다. 배율을 곱해 모아 두었다가 프레임당
       한 번만 적용합니다.

       같은 프레임 안에서는 zoom 이 안 바뀌므로 이벤트마다 toSvgXY 가 내놓는 지도
       좌표가 모두 같습니다. 그래서 배율만 곱해 두고 마지막 커서 위치를 쓰면
       한 번에 적용한 결과가 한 노치씩 적용한 것과 같습니다(커서 고정 확대는
       같은 기준점에 대해 곱셈이라 결합법칙이 성립합니다). */
    var wheelF = 1, wheelRaf = 0, wheelX = 0, wheelY = 0;
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = toSvgXY(e);
      wheelX = p.x; wheelY = p.y;
      wheelF *= (e.deltaY < 0 ? 1.25 : 0.8);
      if (!global.requestAnimationFrame) {          // 구형 폴백 — 예전처럼 바로
        var f0 = wheelF; wheelF = 1;
        zoomAt(f0, wheelX, wheelY);
        return;
      }
      if (wheelRaf) return;
      wheelRaf = global.requestAnimationFrame(function () {
        wheelRaf = 0;
        var f = wheelF; wheelF = 1;
        zoomAt(f, wheelX, wheelY);
      });
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
    function draftChanged() {
      paint();
      if (opt.onAreaDraft) opt.onAreaDraft(state.areaDraft ? state.areaDraft.size : 0);
    }
    /** 사각형 안(중심점 기준)에 든 격자를 고른 목록에 더합니다 (덮어쓰지 않습니다) */
    function addBoxToDraft(box) {
      if (!state.areaDraft) state.areaDraft = new Set();
      state.cells.forEach(function (c) {
        var r = cellRect(c);
        var mx = r.x + (r.w - CELL_OV) / 2, my = r.y + (r.h - CELL_OV) / 2;
        if (mx >= box.x && mx <= box.x + box.w &&
            my >= box.y && my <= box.y + box.h) state.areaDraft.add(c.id);
      });
      draftChanged();
    }
    /** 격자 하나를 넣고 빼기 — 드래그로 잘못 들어온 칸을 고칠 때 씁니다 */
    function toggleDraftCell(id) {
      if (!state.areaDraft) state.areaDraft = new Set();
      if (state.areaDraft.has(id)) state.areaDraft.delete(id);
      else state.areaDraft.add(id);
      draftChanged();
    }
    /** [지정 완료] — 고른 목록을 분석 영역으로 확정합니다 */
    function commitArea() {
      var ids = state.areaDraft;
      state.areaDraft = null;
      state.areaMode = false;
      svg.classList.remove('areamode');
      gArea.setAttribute('visibility', 'hidden');
      if (!ids || !ids.size) { clearArea(); return; }
      state.area = ids;
      paint();
      if (opt.onAreaChange) opt.onAreaChange(ids);
    }
    function clearArea() {
      state.area = null; state.areaDraft = null;
      gArea.setAttribute('visibility', 'hidden');
      paint();
      if (opt.onAreaChange) opt.onAreaChange(null);
    }

    /* 드래그 = 이동. 4px 미만 움직임은 클릭으로 취급해 배치·선택을 방해하지 않습니다 */
    var pan = null, panMoved = false, panRect = null;
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (state.areaMode) {
        /* 새 제스처가 시작되면 '드래그 뒤 클릭 무시' 를 풉니다. click 이 온 뒤에만
           풀면, 드래그가 격자 밖에서 끝나 click 이 안 오는 경우 다음 클릭 한 번을
           통째로 삼킵니다. */
        areaDragged = false;
        var p = toSvgXY(e);
        band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        drawArea(normBand(band), true);
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 환경 */ }
        e.preventDefault();
        return;
      }
      pan = { cx: e.clientX, cy: e.clientY, x: zoom.x, y: zoom.y };
      panMoved = false;
      /* 지도 상자의 화면 좌표는 끄는 동안 변하지 않습니다. 그런데 아래
         pointermove 는 applyZoom 이 viewBox 를 써서 레이아웃을 막 더럽힌 직후에
         이걸 읽어 왔습니다 — 강제 동기 레이아웃이라 실측 호출당 2.8ms 입니다.
         누를 때 한 번만 재 둡니다. */
      panRect = svg.getBoundingClientRect();
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
        C.hideTip();     /* 끌기 시작 — 정류장 툴팁은 여기서 한 번만 접습니다 */
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 환경 */ }
      }
      var r = panRect || svg.getBoundingClientRect();
      if (!r.width) return;
      zoom = clampBox(pan.x - dx / r.width * zoom.w, pan.y - dy / r.height * zoom.h, zoom.w);
      applyZoom();
    });
    var areaDragged = false;
    function endBand() {
      if (!band) return false;
      var box = normBand(band);
      band = null;
      gArea.setAttribute('visibility', 'hidden');
      /* 살짝 눌린 정도면 드래그가 아니라 클릭입니다 — 격자 클릭 처리에 맡깁니다 */
      if (box.w < zoom.w * 0.01 || box.h < zoom.h * 0.01) return true;
      areaDragged = true;            /* 뒤따르는 click 이 칸을 도로 빼지 않게 */
      addBoxToDraft(box);
      return true;
    }
    svg.addEventListener('pointerup', function () {
      panRect = null;
      if (endBand()) return;
      pan = null; svg.classList.remove('panning');
    });
    svg.addEventListener('pointercancel', function () {
      band = null; pan = null; panRect = null; svg.classList.remove('panning');
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
        '<button type="button" data-z="in" aria-label="지도 확대">' + HW.icon('plus', 15) + '</button>' +
        '<button type="button" data-z="out" aria-label="지도 축소">' + HW.icon('minus', 15) + '</button>' +
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
      /** 권역 요약에서 고른 읍면동의 경계선만 굵게 — 격자별 테두리 대신
       *  이미 있는 읍면동 경계선 하나를 강조해 선 체계를 늘리지 않는다. */
      setFocusRegion: function (name) {
        Array.prototype.forEach.call(gDongLine.children, function (p) {
          p.classList.toggle('active', !!name && p.getAttribute('data-name') === name);
        });
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
        /* 격자를 고르면 노선 초점은 끝납니다(그 반대는 setRouteFocus 가 합니다).
           둘이 같이 걸려 있으면 focusStopIds 에서 노선이 이기므로, 격자를 눌러도
           화면이 안 바뀌는 것처럼 보입니다. */
        if (cellId) state.routeFocus = null;
        renderRoutes();
      },
      getCellFocus: function () { return state.cellFocus; },
      /** 노선 하나만 그리고 그 전 구간이 담기게 확대합니다. null 이면 해제.
       *  격자 초점은 같이 풀립니다 — 둘이 동시에 걸리면 노선이 격자 안에서 잘립니다. */
      setRouteFocus: function (routeId) {
        state.routeFocus = routeId || null;
        if (routeId) state.cellFocus = null;
        renderRoutes();
        var rt = focusRouteObj();
        if (rt) zoomToRoute(rt);
      },
      getRouteFocus: function () { return state.routeFocus; },
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
        /* 지정을 시작하면 지금 영역에서 이어서 고칠 수 있게 그대로 물려받고,
           취소하면 고르던 것을 버립니다(확정된 영역은 그대로 둡니다). */
        state.areaDraft = v ? new Set(state.area || []) : null;
        if (!v) gArea.setAttribute('visibility', 'hidden');
        draftChanged();
      },
      commitArea: commitArea,
      clearArea: clearArea,
      area: function () { return state.area; },
      areaDraftSize: function () { return state.areaDraft ? state.areaDraft.size : 0; },
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
