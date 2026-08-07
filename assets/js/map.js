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

  var LAYERS = {
    mi: { key: 'mi', prefix: 'm', steps: 7, title: '미스매칭 지수 MI', unit: '(z)', kind: 'diverging' },
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
    var vb = mapMeta.viewBox || [0, 0, 960, 640];
    var W = vb[2], H = vb[3];

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
      h += '<rect class="wtr" x="0" y="0" width="' + W + '" height="' + H + '"/>';
      h += '<text class="wlab" x="30" y="212" transform="rotate(-90 30 212)">서 해</text>';
      (mapMeta.labels && mapMeta.labels.neighbors || []).forEach(function (n) {
        h += '<text class="nlab" x="' + n[1] + '" y="' + n[2] + '" text-anchor="middle">' + esc(n[0]) + '</text>';
      });
      if (mapMeta.boundary) h += '<path class="land" d="' + path(mapMeta.boundary) + '"/>';
      (mapMeta.islands || []).forEach(function (isl) {
        h += '<path class="land" d="' + path(isl) + '"/>';
      });
      h += '<line x1="86" y1="316" x2="100" y2="314" stroke="var(--coast)" stroke-width="1.4" stroke-dasharray="3 3"/>';

      h += '<g class="cells" data-cells></g>';

      /* 노선은 격자 위에 그리되, 흰 테두리(케이싱)를 깔아 어떤 격자 색 위에서도 보이게 합니다 */
      h += '<g data-groutes></g>';

      h += '<g data-glabels>';
      (mapMeta.labels && mapMeta.labels.regions || []).forEach(function (r) {
        h += '<text class="rlab' + (r[0] === '제부도' ? ' sm' : '') + '" x="' + r[1] + '" y="' + r[2] + '" text-anchor="middle">' + esc(r[0]) + '</text>';
      });
      (mapMeta.labels && mapMeta.labels.industrial || []).forEach(function (m) {
        var x = m[1], y = m[2];
        h += '<path class="indmark" d="M' + (x - 5) + ',' + (y + 3) + ' L' + x + ',' + (y - 6) + ' L' + (x + 5) + ',' + (y + 3) + ' Z"/>' +
          '<text class="rlab sm" x="' + (x + 8) + '" y="' + (y + 6) + '" text-anchor="start">' + esc(m[0]) + '</text>';
      });
      h += '</g>';

      h += '<g class="placed" data-placed></g>';
      /* 선택 표시는 이중 링(바깥 흰 테두리 + 안쪽 강조색)이라 어떤 격자 색 위에서도 보입니다 */
      h += '<g data-selring visibility="hidden">' +
        '<rect class="selring-out" x="-99" y="-99" width="28" height="28" rx="4"/>' +
        '<rect class="selring-in" x="-99" y="-99" width="28" height="28" rx="4"/>' +
        '</g>';

      h += '<g transform="translate(' + (W - 38) + ',72)"><circle class="compass" r="11"/>' +
        '<path d="M0,-7 L3,4 L0,2 L-3,4 Z" fill="var(--ink3)"/>' +
        '<text class="compass-t" y="-16" text-anchor="middle">N</text></g>';

      var sb = mapMeta.scaleBar || { px: 120, meters: 5000 };
      h += '<g transform="translate(' + (W - 172) + ',' + (H - 34) + ')">' +
        '<line class="scalebar" x1="0" y1="0" x2="' + sb.px + '" y2="0"/>' +
        '<line class="scalebar" x1="0" y1="-4" x2="0" y2="4"/>' +
        '<line class="scalebar" x1="' + sb.px + '" y1="-4" x2="' + sb.px + '" y2="4"/>' +
        '<text class="compass-t" x="' + (sb.px / 2) + '" y="-6" text-anchor="middle">0 ─ ' +
        (sb.meters / 1000) + ' km' + (meta.isMockData ? ' (개략)' : '') + '</text></g>';

      svg.setAttribute('viewBox', vb.join(' '));
      svg.innerHTML = h;
    }

    drawBase();
    var gCells = svg.querySelector('[data-cells]');
    var gRoutes = svg.querySelector('[data-groutes]');
    var gLabels = svg.querySelector('[data-glabels]');
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
        var s = c.size || 24;
        h += '<rect x="' + p.x + '" y="' + p.y + '" width="' + s + '" height="' + s +
          '" rx="2" class="c m3" data-id="' + esc(c.id) + '"/>';
      });
      gCells.innerHTML = h;
    }

    function renderRoutes() {
      var h = '';
      /* 1단계: 케이싱(바탕색 굵은 선) → 2단계: 노선 본선. 격자 위에서도 선이 끊겨 보이지 않습니다. */
      state.routes.forEach(function (rt) {
        var pts = (rt.pathXY || []).map(function (p) { return p[0] + ',' + p[1]; });
        if (!pts.length && rt.path) {
          pts = rt.path.map(function (p) { var q = C.project(p[0], p[1]); return q.x + ',' + q.y; });
        }
        h += '<polyline class="rt-casing" points="' + pts.join(' ') + '"/>';
      });
      state.routes.forEach(function (rt) {
        var pts = (rt.pathXY || []).map(function (p) { return p[0] + ',' + p[1]; });
        if (!pts.length && rt.path) {
          pts = rt.path.map(function (p) { var q = C.project(p[0], p[1]); return q.x + ',' + q.y; });
        }
        h += '<polyline class="rt" data-route="' + esc(rt.id) + '" points="' + pts.join(' ') + '"/>';
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
        for (var i = 0; i < L.steps; i++) h += '<i style="background:var(--' + L.prefix + i + ')"></i>';
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
        for (var j = 0; j < L.steps; j++) h += '<i style="background:var(--' + L.prefix + j + ')" title="' + QUINTILE_LABELS[j] + '"></i>';
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
      var cellKm = 1;
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
      items.push(item('<path class="indmark" d="M6,10 L11,3 L16,10 Z"/>', '산업단지'));
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
      var p = C.xy(c), s = (c.size || 24);
      Array.prototype.forEach.call(gSelRing.children, function (r, i) {
        var pad = i === 0 ? 3 : 1.5;   // 바깥 링이 더 크게
        r.setAttribute('x', p.x - pad);
        r.setAttribute('y', p.y - pad);
        r.setAttribute('width', s + pad * 2);
        r.setAttribute('height', s + pad * 2);
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
        var c = state.cells[i], p = C.xy(c), s = c.size || 24;
        if (x >= p.x && x <= p.x + s && y >= p.y && y <= p.y + s) return c;
      }
      /* 격자 사이 틈에 걸렸으면 가장 가까운 격자 */
      var best = null, bd = 1e9;
      state.cells.forEach(function (c) {
        var p = C.xy(c), s = c.size || 24;
        var d = Math.hypot(x - (p.x + s / 2), y - (p.y + s / 2));
        if (d < bd) { bd = d; best = c; }
      });
      return bd < 26 ? best : null;
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
        var q = C.xy(c), s = c.size || 24;
        var cx = q.x + s / 2, cy = q.y + s / 2;
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
      if (!s) return;
      var stop = findStop(s.getAttribute('data-stophit'));
      if (!stop) return;
      C.showTip('<b>' + esc(stop.name) + '</b><br>경유 ' + stop.routes.join('·') +
        '선 · 클릭하면 시간대 프로파일', e);
    });
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
      setArmed: function (v) {
        state.armed = !!v;
        var box = svg.parentNode;
        if (box && box.classList) box.classList.toggle('arm', !!v);
      },
      cellById: function (id) { return state.byId[id] || null; },
      cells: function () { return state.cells; },
      repaint: paint,
      defaultCellTip: defaultCellTip
    };
  }

  HW.createMap = createMap;
  HW.MAP_LAYERS = LAYERS;
})(window);
