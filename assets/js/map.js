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
 *      onStopClick: function(stop, ev){}
 *    });
 *    map.setData({ cells: [...], stops: [...], routes: [...] });
 *    map.setLayer('mi');                 // 'mi' | 'demand' | 'supply' | 'flow'
 *    map.select('G-321');
 *    map.setPlacements([{type:'stop', cellId:'G-321'}]);
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var C = HW.core;
  var esc = C.esc;

  var LAYERS = {
    mi: { key: 'mi', prefix: 'm', steps: 7, title: '미스매칭 지수 MI (z)', kind: 'diverging' },
    demand: { key: 'demand', prefix: 'sb', steps: 5, title: '수요지수 D · 5분위', kind: 'sequential' },
    supply: { key: 'supply', prefix: 'so', steps: 5, title: '공급지수 S · 5분위', kind: 'sequential' },
    flow: { key: 'flow', prefix: 'sb', steps: 5, title: '유동인구(잠재수요) · 5분위', kind: 'sequential' }
  };

  function createMap(opt) {
    var svg = opt.svg;
    var legendEl = opt.legend || null;
    var meta = opt.meta || {};
    var mapMeta = meta.map || {};
    var vb = mapMeta.viewBox || [0, 0, 960, 640];
    var W = vb[2], H = vb[3];

    if (meta.grid && meta.grid.bbox) C.setProjection(meta.grid.bbox, W, H);

    var state = {
      cells: [], stops: [], routes: [],
      byId: {},
      layer: 'mi',
      selectedCellId: null,
      selectedStopId: null,
      placements: [],
      showRoutes: true,
      showLabels: true,
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

      h += '<g data-groutes></g>';
      h += '<g class="placed" data-placed></g>';
      h += '<rect class="selring" data-selring x="-99" y="-99" width="26" height="26" rx="3" visibility="hidden"/>';

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
    var selRing = svg.querySelector('[data-selring]');

    /* -------------------------------------------------------- 데이터 */
    function setData(d) {
      if (d.cells) {
        state.cells = d.cells;
        state.byId = {};
        d.cells.forEach(function (c) { state.byId[c.id] = c; });
        renderCells();
      }
      if (d.routes) { state.routes = d.routes; }
      if (d.stops) { state.stops = d.stops; }
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
      Array.prototype.forEach.call(gCells.children, function (rect) {
        var c = state.byId[rect.getAttribute('data-id')];
        if (!c) return;
        rect.setAttribute('class', 'c ' + L.prefix + binOf(c, L.key));
      });
      renderLegend();
    }

    function renderLegend() {
      if (!legendEl) return;
      var L = LAYERS[state.layer];
      var h = '<div class="lt">' + esc(L.title) + '</div><div class="lrow">';
      for (var i = 0; i < L.steps; i++) h += '<i style="background:var(--' + L.prefix + i + ')"></i>';
      h += '</div>';
      if (L.kind === 'diverging') {
        h += '<div class="lcap"><span>−2.6</span><span>0 균형</span><span>+2.6</span></div>' +
          '<div class="lcap"><span>공급 여유</span><span></span><span>공급 부족</span></div>';
      } else {
        h += '<div class="lcap"><span>낮음</span><span>높음</span></div>';
      }
      legendEl.innerHTML = h;
    }

    /* -------------------------------------------------------- 선택 */
    function placeRing() {
      if (!state.selectedCellId) { selRing.setAttribute('visibility', 'hidden'); return; }
      var c = state.byId[state.selectedCellId];
      if (!c) { selRing.setAttribute('visibility', 'hidden'); return; }
      var p = C.xy(c), s = (c.size || 24) + 2;
      selRing.setAttribute('x', p.x - 1);
      selRing.setAttribute('y', p.y - 1);
      selRing.setAttribute('width', s);
      selRing.setAttribute('height', s);
      selRing.setAttribute('visibility', 'visible');
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

    /* ------------------------------------------------------ 배치 마커 */
    function renderPlacements() {
      var effects = {};
      (meta.effects || []).forEach(function (e) { effects[e.type] = e; });
      gPlaced.innerHTML = state.placements.map(function (p) {
        var c = state.byId[p.cellId];
        if (!c) return '';
        var q = C.xy(c), s = c.size || 24;
        var icon = (effects[p.type] && effects[p.type].icon) || '●';
        return '<text class="pmk" x="' + (q.x + s / 2) + '" y="' + (q.y + s / 2 + 5) +
          '" text-anchor="middle">' + esc(icon) + '</text>';
      }).join('');
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
      var stop = null;
      state.stops.forEach(function (x) { if (x.id === s.getAttribute('data-stophit')) stop = x; });
      if (!stop) return;
      C.showTip('<b>' + esc(stop.name) + '</b><br>경유 ' + stop.routes.join('·') +
        '선 · 클릭하면 시간대 프로파일', e);
    });
    svg.addEventListener('click', function (e) {
      var s = e.target.closest('.sthit');
      if (!s) return;
      var stop = null;
      state.stops.forEach(function (x) { if (x.id === s.getAttribute('data-stophit')) stop = x; });
      if (stop && opt.onStopClick) opt.onStopClick(stop, e);
    });

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
      setPlacements: function (list) { state.placements = list || []; renderPlacements(); },
      setShowRoutes: function (v) { state.showRoutes = !!v; gRoutes.style.display = v ? '' : 'none'; },
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
