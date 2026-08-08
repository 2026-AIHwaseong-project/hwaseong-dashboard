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

    var state = {
      cells: [], stops: [], routes: [], scale: null,
      byId: {},
      layer: 'mi',
      selectedCellId: null,
      selectedStopId: null,
      placements: [],
      eligible: null,          // Set 또는 null(해제)
      eligibleNote: '',        // 강조 중임을 알리는 범례 문구
      showRoutes: true,
      showLabels: true,
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

      h += '<g class="placed" data-placed></g>';
      h += '<g data-selring visibility="hidden">' +
        '<rect class="selring-out" x="-99" y="-99" width="20" height="20" rx="3"/>' +
        '<rect class="selring-in" x="-99" y="-99" width="20" height="20" rx="3"/>' +
        '</g>';

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

    drawBase();
    var gCells = svg.querySelector('[data-cells]');
    var gRoutes = svg.querySelector('[data-groutes]');
    var gLabels = svg.querySelector('[data-glabels]');
    var gDongLine = svg.querySelector('[data-dongline]');
    var gPlaced = svg.querySelector('[data-placed]');
    var gSelRing = svg.querySelector('[data-selring]');

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

    function renderCells() {
      var h = '';
      state.cells.forEach(function (c) {
        var p = C.xy(c);
        h += '<rect x="' + p.x + '" y="' + p.y + '" width="' + (c.w || 20) + '" height="' + (c.h || 20) +
          '" rx="1.5" class="c m3" data-id="' + esc(c.id) + '"/>';
      });
      gCells.innerHTML = h;
    }

    function renderRoutes() {
      var h = '';
      /* 1단계: 케이싱(바탕색 굵은 선) → 2단계: 노선 본선. 격자 위에서도 선이 끊겨 보이지 않습니다. */
      function routePts(rt) {
        var src = rt.pathXY;
        if (src && src.length) return src.map(function (p) { return p[0] + ',' + p[1]; });
        return (rt.path || []).map(function (p) {
          var q = C.project(p[0], p[1]);
          return q.x.toFixed(1) + ',' + q.y.toFixed(1);
        });
      }
      state.routes.forEach(function (rt) {
        h += '<polyline class="rt-casing" points="' + routePts(rt).join(' ') + '"/>';
      });
      state.routes.forEach(function (rt) {
        h += '<polyline class="rt" data-route="' + esc(rt.id) + '" points="' + routePts(rt).join(' ') + '"/>';
      });
      state.stops.forEach(function (s) {
        var p = C.xy(s);
        h += '<circle class="st' + (s.kind === 'hub' ? ' hub' : '') + '" data-stop="' + esc(s.id) +
          '" cx="' + p.x + '" cy="' + p.y + '" r="' + (s.kind === 'hub' ? 4.6 : 3.4) + '"/>';
      });
      state.stops.forEach(function (s) {
        var p = C.xy(s);
        h += '<circle class="sthit" data-stophit="' + esc(s.id) + '" cx="' + p.x + '" cy="' + p.y + '" r="11"><title>' +
          esc(s.name) + '</title></circle>';
      });
      gRoutes.innerHTML = h;
      gRoutes.style.display = state.showRoutes ? '' : 'none';
      applyStopsInteractive();
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
      var cellKm = 1.5;
      if (meta.grid && meta.grid.displaySizeMeters) cellKm = meta.grid.displaySizeMeters / 1000;

      function item(svgInner, label, w) {
        return '<span class="lg-sym"><svg viewBox="0 0 ' + (w || 22) + ' 14" width="' + (w || 22) + '" height="14" aria-hidden="true">' +
          svgInner + '</svg>' + esc(label) + '</span>';
      }
      var items = [];
      items.push(item('<rect x="2" y="2" width="10" height="10" rx="2" class="c m3"/>' +
        '<rect x="2" y="2" width="10" height="10" rx="2" fill="none" stroke="var(--line)"/>',
        '격자 1칸 ≈ ' + cellKm + 'km'));
      items.push(item('<circle cx="11" cy="7" r="3.4" class="st"/>', '정류장'));
      items.push(item('<circle cx="11" cy="7" r="4.6" class="st hub"/>', '환승 거점'));
      items.push(item('<polyline class="rt-casing" points="2,10 8,4 14,9 20,4"/>' +
        '<polyline class="rt" points="2,10 8,4 14,9 20,4"/>', '버스 노선'));
      items.push(item('<path class="dongline" d="M2,11 L8,4 L14,9 L20,3"/>', '읍면동 경계'));
      items.push(item('<rect x="3" y="3" width="8" height="8" rx="2" class="selring-out"/>' +
        '<rect x="3" y="3" width="8" height="8" rx="2" class="selring-in"/>', '선택한 격자'));

      if (opt.placementLegend) {
        (meta.effects || []).forEach(function (e) {
          items.push(item('<circle cx="11" cy="7" r="6" class="pmk-bg"/>' +
            '<text class="pmk" x="11" y="10.5" text-anchor="middle" style="font-size:8px">' +
            esc(e.icon) + '</text>', e.label, 24));
        });
      }
      return '<div class="lg-syms">' + items.join('') + '</div>';
    }

    /* -------------------------------------------------------- 선택 */
    function placeRing() {
      if (!state.selectedCellId) { gSelRing.setAttribute('visibility', 'hidden'); return; }
      var c = state.byId[state.selectedCellId];
      if (!c) { gSelRing.setAttribute('visibility', 'hidden'); return; }
      var p = C.xy(c), cw = c.w || 20, ch = c.h || 20;
      Array.prototype.forEach.call(gSelRing.children, function (r, i) {
        var pad = i === 0 ? 3 : 1.5;   // 바깥 링이 더 크게
        r.setAttribute('x', p.x - pad);
        r.setAttribute('y', p.y - pad);
        r.setAttribute('width', cw + pad * 2);
        r.setAttribute('height', ch + pad * 2);
      });
      gSelRing.setAttribute('visibility', 'visible');
    }

    function highlightStop(stopId) {
      state.selectedStopId = stopId;
      var stop = null;
      state.stops.forEach(function (s) { if (s.id === stopId) stop = s; });
      var routeIds = stop ? stop.routes : [];
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
        var c = state.cells[i], p = C.xy(c);
        if (x >= p.x && x <= p.x + (c.w || 20) && y >= p.y && y <= p.y + (c.h || 20)) return c;
      }
      /* 격자 사이 틈에 걸렸으면 가장 가까운 격자 */
      var best = null, bd = 1e9;
      state.cells.forEach(function (c) {
        var p = C.xy(c);
        var d = Math.hypot(x - (p.x + (c.w || 20) / 2), y - (p.y + (c.h || 20) / 2));
        if (d < bd) { bd = d; best = c; }
      });
      return bd < 30 ? best : null;
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
        var q = C.xy(c);
        var cx = q.x + (c.w || 20) / 2, cy = q.y + (c.h || 20) / 2;
        var offs = OFFSETS[Math.min(list.length, 3)] || OFFSETS[3];
        list.slice(0, 3).forEach(function (p, i) {
          var o = offs[i] || [0, 0];
          var x = cx + o[0], y = cy + o[1];
          var icon = (effects[p.type] && effects[p.type].icon) || '●';
          /* 어떤 격자 색 위에서도 읽히도록 바탕 원을 깔아 줍니다 */
          h += '<circle class="pmk-bg" cx="' + x + '" cy="' + y + '" r="8.5"/>';
          h += '<text class="pmk" x="' + x + '" y="' + (y + 4.5) + '" text-anchor="middle">' + esc(icon) + '</text>';
          if (p.count > 1) {
            h += '<circle class="pmk-badge-bg" cx="' + (x + 7) + '" cy="' + (y - 6.5) + '" r="6"/>';
            h += '<text class="pmk-badge" x="' + (x + 7) + '" y="' + (y - 4) + '" text-anchor="middle">' + p.count + '</text>';
          }
        });
        if (list.length > 3) {
          h += '<text class="pmk-more" x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle">+' + (list.length - 3) + '</text>';
        }
      });
      gPlaced.innerHTML = h;
    }

    /* -------------------------------------------------------- 이벤트 */
    gCells.addEventListener('mousemove', function (e) {
      var r = e.target.closest('rect');
      if (!r) return C.hideTip();
      var c = state.byId[r.getAttribute('data-id')];
      if (!c) return;
      if (opt.onCellHover) opt.onCellHover(c, e);
      else C.showTip(defaultCellTip(c), e);
    });
    gCells.addEventListener('mouseleave', C.hideTip);
    gCells.addEventListener('click', function (e) {
      var r = e.target.closest('rect');
      if (!r) return;
      var c = state.byId[r.getAttribute('data-id')];
      if (c && opt.onCellClick) opt.onCellClick(c, e);
    });

    svg.addEventListener('mousemove', function (e) {
      var s = e.target.closest('.sthit');
      if (!s) {
        /* 격자 위 툴팁은 gCells 핸들러가 관리하므로 건드리지 않습니다.
           그 밖(바다·여백)으로 나가면 정류장 툴팁이 남지 않게 접습니다. */
        if (!e.target.closest('.cells')) C.hideTip();
        return;
      }
      var stop = findStop(s.getAttribute('data-stophit'));
      if (!stop) return;
      C.showTip('<b>' + esc(stop.name) + '</b><br>경유 ' + stop.routes.join('·') +
        '선 · 클릭하면 시간대 프로파일', e);
    });
    svg.addEventListener('mouseleave', C.hideTip);
    svg.addEventListener('click', function (e) {
      var s = e.target.closest('.sthit');
      if (!s) return;
      var stop = findStop(s.getAttribute('data-stophit'));
      if (!stop || !opt.onStopClick) return;
      var p = C.xy(stop);
      opt.onStopClick(stop, cellAt(p.x, p.y), e);
    });

    function findStop(id) {
      for (var i = 0; i < state.stops.length; i++) if (state.stops[i].id === id) return state.stops[i];
      return null;
    }

    /* ------------------------------------------------------ 확대·이동
       SVG viewBox 를 조작합니다. 동탄처럼 면적이 작은 동은 전체 뷰에서
       배치 기호가 겹쳐 안 보입니다. 축척바는 지도 좌표계에 있어서
       확대해도 표시 거리(0─5km)가 그대로 맞습니다. */
    var MIN_W = W / 8;                 // 최대 8배
    var zoomAnim = null;

    function isZoomed() { return zoom.w < W - 0.5; }

    function applyZoom() {
      svg.setAttribute('viewBox', zoom.x.toFixed(1) + ' ' + zoom.y.toFixed(1) + ' ' +
        zoom.w.toFixed(1) + ' ' + zoom.h.toFixed(1));
      if (zctl) zctl.classList.toggle('zoomed', isZoomed());
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
      if (reduce || !global.requestAnimationFrame) { zoom = t; applyZoom(); return; }
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

    function zoomReset() { animateTo({ x: 0, y: 0, w: W, h: H }); }

    /** 해당 읍면동의 격자들이 화면을 채우도록 확대합니다 */
    function zoomToRegion(regionName) {
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
      state.cells.forEach(function (c) {
        if (c.region !== regionName) return;
        var p = C.xy(c);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + (c.w || 20)); y1 = Math.max(y1, p.y + (c.h || 20));
        n++;
      });
      if (!n) return;
      var w = Math.max((x1 - x0) * 1.35, (y1 - y0) * 1.35 * W / H, MIN_W);
      animateTo(clampBox((x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - (w * H / W) / 2, w));
    }

    /** factor 배 확대(>1)/축소(<1). (sx,sy)는 고정점(SVG 좌표) */
    function zoomAt(factor, sx, sy) {
      zoom = clampBox(sx - (sx - zoom.x) / factor, sy - (sy - zoom.y) / factor, zoom.w / factor);
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

    /* 드래그 = 이동. 4px 미만 움직임은 클릭으로 취급해 배치·선택을 방해하지 않습니다 */
    var pan = null, panMoved = false;
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      pan = { cx: e.clientX, cy: e.clientY, x: zoom.x, y: zoom.y };
      panMoved = false;
    });
    svg.addEventListener('pointermove', function (e) {
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
    svg.addEventListener('pointerup', function () { pan = null; svg.classList.remove('panning'); });
    svg.addEventListener('pointercancel', function () { pan = null; svg.classList.remove('panning'); });
    /* 드래그 직후의 click 이 배치·선택으로 이어지지 않게 캡처 단계에서 삼킵니다 */
    svg.addEventListener('click', function (e) {
      if (panMoved) { e.stopPropagation(); panMoved = false; }
    }, true);

    /* 확대 버튼 — 우상단에는 나침반·가상수치 배지가 있어 좌상단에 둡니다 */
    var zctl = null;
    if (svg.parentNode && global.document) {
      zctl = global.document.createElement('div');
      zctl.className = 'zctl';
      zctl.innerHTML =
        '<button type="button" data-z="in" aria-label="지도 확대">+</button>' +
        '<button type="button" data-z="out" aria-label="지도 축소">−</button>' +
        '<button type="button" data-z="reset" aria-label="전체 보기">전체</button>';
      svg.parentNode.appendChild(zctl);
      zctl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-z]');
        if (!b) return;
        var z = b.getAttribute('data-z');
        if (z === 'reset') zoomReset();
        else zoomAt(z === 'in' ? 1.5 : 1 / 1.5, zoom.x + zoom.w / 2, zoom.y + zoom.h / 2);
      });
    }

    function defaultCellTip(c) {
      return '<b>' + esc(c.name) + '</b> <span class="mono">' + esc(c.id) + '</span><br>' +
        '수요 D <b>' + c.demand + '</b> · 공급 S <b>' + c.supply + '</b> · MI <b>' +
        (c.mi >= 0 ? '+' : '') + c.mi.toFixed(2) + '</b><br>' +
        '잠재수요 ' + C.fmt(c.flowTripsPerDay) + '통행/일 · 고령비 <b>' + Math.round(c.elderlyRatio * 100) + '%</b>';
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
      setShowRoutes: function (v) {
        state.showRoutes = !!v;
        gRoutes.style.display = v ? '' : 'none';
      },
      setShowLabels: function (v) { state.showLabels = !!v; gLabels.style.display = v ? '' : 'none'; },
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
      defaultCellTip: defaultCellTip,
      /** 읍면동으로 확대 / 전체 복귀 / 확대 여부 */
      zoomToRegion: zoomToRegion,
      zoomReset: zoomReset,
      isZoomed: isZoomed
    };
  }

  HW.createMap = createMap;
  HW.MAP_LAYERS = LAYERS;
})(window);
