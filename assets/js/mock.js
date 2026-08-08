/* ============================================================================
 *  mock.js — 목(가짜) 백엔드
 * ----------------------------------------------------------------------------
 *  ⚠️ 백엔드 팀 참고
 *  이 파일은 서버가 준비되기 전까지 서버 역할을 대신합니다.
 *  각 함수가 돌려주는 JSON 모양이 곧 백엔드가 구현해야 할 응답 규격입니다.
 *  docs/API.md 에 같은 내용이 표로 정리돼 있습니다.
 *
 *  실서버 연동이 끝나면 이 파일은 지워도 됩니다.
 *  (config.js 의 USE_MOCK 을 false 로 두면 호출되지 않습니다.)
 *
 *  ── 산출 로직 요약 (백엔드에서 그대로 옮기면 됩니다) ─────────────────
 *    D  수요지수  = 0.5·정규화(교통카드 실현승하차) + 0.5·정규화(통신 유동인구)
 *    S  공급지수  = 0.78·정규화(운행빈도) + 0.22·정류장 커버리지 + 배치효과
 *    MI 미스매칭 = (z(D) − z(S)) × 수요가중감쇠
 *    우선순위     = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)
 *  ------------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var CONFIG = HW.CONFIG;
  var C = HW.core;
  var clamp = C.clamp, mulberry32 = C.mulberry32;

  /* ======================================================================
   * 0. 지도 좌표계 · 실제 행정경계
   *    assets/data/boundary.js 가 SGIS 읍면동 경계(경위도)를 실어 옵니다.
   *    좌표는 전부 경위도(EPSG:4326)이며, 화면 투영은 core.project 가 합니다.
   * ==================================================================== */
  var BND = HW.BOUNDARY;
  if (!BND) throw new Error('assets/data/boundary.js 를 먼저 불러와야 합니다.');
  var BBOX = BND.bbox.slice();
  var DONGS = BND.dongs;

  /* 세로 길이는 실제 경계 비율에서 계산합니다. 960×640(1.5:1) 로 고정하면
     화성시 종횡비(1.72:1)와 안 맞아 위아래에 54px 씩 빈 띠가 생겼습니다.
     ※ BBOX 보다 먼저 계산하면 호이스팅으로 undefined 가 들어갑니다. */
  var VIEW_W = 960, VIEW_H = C.fitHeight(BBOX, VIEW_W);

  C.setProjection(BBOX, VIEW_W, VIEW_H);

  /* 점-다각형 판정(ray casting). 격자를 어느 읍면동에 넣을지 결정합니다. */
  function inRing(x, y, ring) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  function dongAt(lon, lat) {
    for (var i = 0; i < DONGS.length; i++) {
      var d = DONGS[i], b = d.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;   // bbox 로 먼저 거르기
      for (var r = 0; r < d.rings.length; r++) {
        if (inRing(lon, lat, d.rings[r])) return d;
      }
    }
    return null;
  }

  /* 화면 표시용 좌표(SVG px) — 경위도를 투영해 얻습니다 */
  function toXY(lon, lat) { return C.project(lon, lat); }

  /* ======================================================================
   * 1. 읍면동별 수요·공급 특성 (시연용 가정값)
   *    [유형, 수요밀도, 공급수준, 고령인구비]
   *    경계와 이름은 실제이지만 아래 수치는 가상입니다.
   *    실데이터 연동 시 이 표가 통째로 교체됩니다.
   * ==================================================================== */
  var PROFILE = {
    '동탄1동': ['urban', .92, .90, .08], '동탄2동': ['urbannew', .95, .62, .07],
    '동탄3동': ['urban', .88, .84, .08], '동탄4동': ['urbannew', .90, .58, .06],
    '동탄5동': ['urbannew', .86, .55, .06], '동탄6동': ['urbannew', .93, .60, .06],
    '동탄7동': ['urbannew', .89, .57, .06], '동탄8동': ['urbannew', .84, .52, .07],
    '동탄9동': ['urbannew', .81, .50, .07],
    '병점1동': ['urban', .86, .88, .12], '병점2동': ['urban', .80, .82, .13],
    '진안동': ['urban', .78, .74, .12], '기배동': ['urban', .66, .70, .14],
    '화산동': ['urban', .62, .66, .15], '반월동': ['urban', .72, .68, .11],
    '봉담읍': ['town', .74, .60, .12], '향남읍': ['town', .80, .42, .13],
    '남양읍': ['town', .62, .50, .15], '우정읍': ['ind', .58, .30, .18],
    '매송면': ['rural', .34, .36, .20], '비봉면': ['rural', .30, .32, .22],
    '마도면': ['ind', .34, .28, .19], '송산면': ['rural', .28, .26, .23],
    '서신면': ['tour', .20, .16, .28], '팔탄면': ['rural', .32, .30, .21],
    '장안면': ['rural', .24, .22, .25], '양감면': ['rural', .20, .20, .24],
    '정남면': ['rural', .36, .36, .19], '새솔동': ['urbannew', .58, .30, .06]
  };
  var DEFAULT_PROFILE = ['rural', .30, .30, .20];

  /* 읍면동 정보를 이름으로 찾기 쉽게 */
  var DONG_BY_NAME = {};
  DONGS.forEach(function (d) {
    var pf = PROFILE[d.name] || DEFAULT_PROFILE;
    d.type = pf[0]; d.demand = pf[1]; d.supplyLevel = pf[2]; d.elderly = pf[3];
    DONG_BY_NAME[d.name] = d;
  });

  /* 지역유형별 시간대 배율 [출근, 낮, 퇴근, 심야] */
  var DM = { urban: [1, .72, 1, .45], urbannew: [1.05, .68, 1.05, .4], town: [.9, .78, .9, .32], rural: [.6, .55, .6, .18], tour: [.42, .88, .52, .12], ind: [1.3, .5, 1.2, .22] };
  var SM = { urban: [1, .8, 1, .5], urbannew: [.9, .72, .9, .42], town: [.9, .68, .9, .25], rural: [.7, .5, .7, .12], tour: [.6, .5, .6, .1], ind: [.8, .5, .8, .15] };
  var FM = { urban: [1, .85, 1, .5], urbannew: [1.1, .8, 1.1, .45], town: [.95, .85, .95, .35], rural: [.7, .65, .7, .2], tour: [.5, 1.15, .6, .15], ind: [1.35, .6, 1.25, .25] };

  var PERIODS = [
    { id: 'am', name: '출근', label: '07–09', hours: [7, 9] },
    { id: 'day', name: '낮', label: '09–17', hours: [9, 17] },
    { id: 'pm', name: '퇴근', label: '17–19', hours: [17, 19] },
    { id: 'night', name: '심야', label: '22–24', hours: [22, 24] }
  ];
  function periodIndex(id) {
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i].id === id) return i;
    return 0;
  }

  /* 잠재수요(0~1 정규화값) → 일 통행량 환산 계수. 시연용 가정값. */
  var TRIP_COEF = 3200;

  /* ======================================================================
   * 2. 노선 · 정류장
   *    노선망 자체는 가상이지만, 정류장을 실제 읍면동 중심에 배치해
   *    지도 위에서 위치가 어긋나지 않게 했습니다.
   * ==================================================================== */
  function centroidOf(name) {
    var d = DONG_BY_NAME[name];
    return d ? d.centroid.slice() : [(BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2];
  }
  /** 두 읍면동 중심 사이를 t 비율로 나눈 지점 (중간 정류장을 놓을 때) */
  function between(a, b, t) {
    var p = centroidOf(a), q = centroidOf(b);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  }

  var ROUTE_DEFS = [
    { id: 'A', name: '간선 A · 병점–동탄', type: 'trunk', stops: [
      ['병점역', '병점1동'], ['진안지구', '진안동'], ['반월동', '반월동'],
      ['동탄중앙', '동탄1동'], ['동탄역', '동탄3동'], ['동탄호수공원', '동탄6동'], ['동탄2남부', '동탄9동'] ] },
    { id: 'B', name: '간선 B · 남양–병점', type: 'trunk', stops: [
      ['남양시청', '남양읍'], ['마도면사무소', '마도면'], ['비봉', '비봉면'],
      ['매송', '매송면'], ['봉담읍', '봉담읍'], ['기배동', '기배동'], ['병점역', '병점1동'] ] },
    { id: 'C', name: '간선 C · 발안–동탄', type: 'trunk', stops: [
      ['발안터미널', '향남읍'], ['향남2지구', '팔탄면'], ['정남면', '정남면'],
      ['화산동', '화산동'], ['동탄서부', '동탄4동'], ['동탄역', '동탄3동'] ] },
    { id: 'D', name: '지선 D · 새솔–남양', type: 'branch', stops: [
      ['새솔동', '새솔동'], ['송산그린시티', '송산면'], ['마도산단', '마도면'], ['남양시청', '남양읍'] ] },
    { id: 'E', name: '지선 E · 조암–발안', type: 'branch', stops: [
      ['기아공장', '우정읍'], ['조암터미널', '장안면'], ['양감면', '양감면'], ['발안터미널', '향남읍'] ] },
    { id: 'F', name: '지선 F · 서신–남양', type: 'branch', stops: [
      ['제부도입구', '서신면'], ['서신면사무소', '서신면'], ['남양시청', '남양읍'] ] }
  ];
  var STOP_KIND = {
    '병점역': 'hub', '동탄역': 'hub', '발안터미널': 'hub', '조암터미널': 'hub', '남양시청': 'hub',
    '기아공장': 'ind', '마도산단': 'ind',
    '진안지구': 'res', '반월동': 'res', '동탄중앙': 'res', '동탄호수공원': 'res', '동탄2남부': 'res',
    '봉담읍': 'res', '향남2지구': 'res', '새솔동': 'res', '송산그린시티': 'res', '동탄서부': 'res'
  };

  var STOPS = {}, STOP_LIST = [], ROUTES = [];
  ROUTE_DEFS.forEach(function (def) {
    var rt = { id: def.id, name: def.name, type: def.type, stopIds: [], pts: [] };
    def.stops.forEach(function (sp, k) {
      var label = sp[0], dongName = sp[1];
      if (!STOPS[label]) {
        var c = centroidOf(dongName);
        /* 같은 읍면동에 정류장이 둘이면 겹치지 않게 살짝 흩뜨립니다 */
        var jitter = mulberry32(label.length * 31 + k * 7);
        var off = 0.004;
        var lon = c[0] + (jitter() - 0.5) * off;
        var lat = c[1] + (jitter() - 0.5) * off;
        var xy = toXY(lon, lat);
        /* 정류소 조인 키.
           경기데이터드림 정류소id 로 조인하면 매칭률이 79.2% 인데,
           국토부 ARS번호(모바일단축번호)로 하면 99.5% 입니다(백엔드 실측).
           다만 ARS번호는 전국 유일이 아니라 시군구 안에서만 유일하므로,
           나중에 인접 시군으로 넓혀도 안 깨지도록 시군구코드와 결합해 씁니다. */
        var ars = String(20000 + STOP_LIST.length * 7);
        STOPS[label] = {
          id: '41590-' + ars,
          arsNo: ars,
          name: label, dong: dongName,
          lon: +lon.toFixed(5), lat: +lat.toFixed(5),
          x: +xy.x.toFixed(1), y: +xy.y.toFixed(1),
          kind: STOP_KIND[label] || 'rural', routes: []
        };
        STOP_LIST.push(STOPS[label]);
      }
      var st = STOPS[label];
      if (st.routes.indexOf(rt.id) < 0) st.routes.push(rt.id);
      rt.stopIds.push(st.id);
      rt.pts.push([st.lon, st.lat, label]);
    });
    ROUTES.push(rt);
  });
  var STOP_BY_ID = {};
  STOP_LIST.forEach(function (s) { STOP_BY_ID[s.id] = s; });

  /* 정류장 시간대별 승하차 프로파일 (5~23시) */
  var HOURS = [];
  for (var h = 5; h <= 23; h++) HOURS.push(h);
  function gauss(x, m, s) { return Math.exp(-((x - m) * (x - m)) / (2 * s * s)); }
  var SIZE = { hub: 8, ind: 7, res: 5, rural: 1.7 };
  STOP_LIST.forEach(function (st) {
    var z = SIZE[st.kind];
    var rnd = mulberry32(st.name.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 7));
    var nz = function () { return .9 + rnd() * .2; };
    st.boardings = []; st.alightings = [];
    HOURS.forEach(function (hr) {
      var b, a;
      if (st.kind === 'hub') {
        b = 38 * gauss(hr, 8, 1.2) + 34 * gauss(hr, 18.2, 1.7) + 15 * gauss(hr, 13, 3.5) + 4;
        a = 34 * gauss(hr, 8.5, 1.4) + 36 * gauss(hr, 18.4, 1.7) + 15 * gauss(hr, 13, 3.5) + 4;
      } else if (st.kind === 'res') {
        b = 52 * gauss(hr, 7.7, 1) + 16 * gauss(hr, 18.6, 2) + 9 * gauss(hr, 13, 3.5) + 2.5;
        a = 13 * gauss(hr, 8.6, 1.6) + 44 * gauss(hr, 18.7, 1.4) + 9 * gauss(hr, 13, 3.5) + 2.5;
      } else if (st.kind === 'ind') {
        b = 9 * gauss(hr, 8.2, 1) + 58 * gauss(hr, 17.9, 1) + 5 * gauss(hr, 13, 4) + 1.5;
        a = 60 * gauss(hr, 7.6, .9) + 8 * gauss(hr, 18, 1.4) + 5 * gauss(hr, 13, 4) + 1.5;
      } else {
        b = 20 * gauss(hr, 7.4, 1.2) + 13 * gauss(hr, 17.4, 1.8) + 8 * gauss(hr, 11.5, 3) + 1.2;
        a = 12 * gauss(hr, 8.6, 1.6) + 18 * gauss(hr, 18, 1.8) + 8 * gauss(hr, 12.5, 3) + 1.2;
      }
      st.boardings.push(Math.round(b * z * nz()));
      st.alightings.push(Math.round(a * z * nz()));
    });
  });

  /* ======================================================================
   * 3. 격자 생성 — 실제 행정경계 안에만
   *    표시 격자 1.5km. 실구현에서는 250m 격자(SGIS)를 씁니다.
   * ==================================================================== */
  var CELL_KM = (CONFIG.GRID && CONFIG.GRID.displaySizeMeters ? CONFIG.GRID.displaySizeMeters : 1500) / 1000;
  var KM_PER_DEG_LAT = 110.574;
  var MID_LAT = (BBOX[1] + BBOX[3]) / 2;
  var KM_PER_DEG_LON = 111.320 * Math.cos(MID_LAT * Math.PI / 180);
  var DLAT = CELL_KM / KM_PER_DEG_LAT;
  var DLON = CELL_KM / KM_PER_DEG_LON;

  var CELLS = [];
  (function buildCells() {
    var i = 0;
    for (var lat = BBOX[1]; lat < BBOX[3]; lat += DLAT) {
      for (var lon = BBOX[0]; lon < BBOX[2]; lon += DLON) {
        var clon = lon + DLON / 2, clat = lat + DLAT / 2;
        var dong = dongAt(clon, clat);
        if (!dong) continue;                       // 화성시 밖은 제외

        var rnd = mulberry32(i * 7 + 3);
        /* 인접 읍면동의 영향까지 섞어 경계에서 값이 뚝 끊기지 않게 합니다 */
        var byT = {}, byTs = {}, wsum = 0, eld = 0, popw = 0;
        DONGS.forEach(function (d) {
          var dx = (clon - d.centroid[0]) * KM_PER_DEG_LON;
          var dy = (clat - d.centroid[1]) * KM_PER_DEG_LAT;
          var dist = Math.hypot(dx, dy);
          /* 자기 읍면동이 지배적이되, 경계에서 값이 뚝 끊기지 않을 만큼만 이웃을 섞습니다 */
          var reach = d === dong ? 6 : 2.8;        // km
          var w = Math.exp(-(dist * dist) / (reach * reach));
          if (d === dong) w = Math.max(w, 1.6);    // 자기 읍면동 비중 보장
          if (w < 1e-3) return;
          byT[d.type] = (byT[d.type] || 0) + w * d.demand;
          byTs[d.type] = (byTs[d.type] || 0) + w * d.supplyLevel;
          eld += w * d.elderly; wsum += w; popw += w * d.demand;
        });

        var dmin = 1e9, nearest = null;
        STOP_LIST.forEach(function (s) {
          var sx = (clon - s.lon) * KM_PER_DEG_LON, sy = (clat - s.lat) * KM_PER_DEG_LAT;
          var dd = Math.hypot(sx, sy);
          if (dd < dmin) { dmin = dd; nearest = s; }
        });

        var p0 = toXY(lon, lat + DLAT), p1 = toXY(lon + DLON, lat);   // 좌상단·우하단
        var cellW = Math.max(3, p1.x - p0.x), cellH = Math.max(3, p1.y - p0.y);

        CELLS.push({
          idx: i, id: 'G-' + (100 + i),
          lon: +clon.toFixed(5), lat: +clat.toFixed(5),
          x: +(p0.x + 0.8).toFixed(1), y: +(p0.y + 0.8).toFixed(1),
          w: +(cellW - 1.6).toFixed(1), h: +(cellH - 1.6).toFixed(1),
          region: dong.name, regionCode: dong.code, regionKind: dong.kind,
          name: dong.name + ' ' + directionIn(clon, clat, dong),
          byT: byT, byTs: byTs,
          elderlyRatio: wsum ? eld / wsum : .2,
          popWeight: popw,
          coverage: clamp(1 - dmin / 3.6, .05, 1),      // 3.6km 를 도보권 밖 기준으로
          nearestStopId: nearest ? nearest.id : null,
          nearestStopName: nearest ? nearest.name : null,
          nP: .92 + rnd() * .16, nS: .92 + rnd() * .16, nF: .92 + rnd() * .16,
          covAdj: 0, supAdj: 0
        });
        i++;
      }
    }
  })();

  /** 읍면동 안에서의 방위. 작은 동에서 이름이 겹치지 않도록 8방위를 씁니다. */
  function directionIn(lon, lat, dong) {
    /* 배열을 함수 안에 두는 이유: 이 함수는 격자 생성(위쪽)에서 호출되는데,
       바깥 var 는 그 시점에 아직 초기화되지 않습니다(호이스팅). */
    var DIR8 = ['동부', '북동부', '북부', '북서부', '서부', '남서부', '남부', '남동부'];
    var dx = (lon - dong.centroid[0]) * KM_PER_DEG_LON;
    var dy = (lat - dong.centroid[1]) * KM_PER_DEG_LAT;
    if (Math.hypot(dx, dy) < 0.7) return '중심';
    var i = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    return DIR8[((i % 8) + 8) % 8];
  }

  /** 그래도 이름이 겹치면 순번을 붙입니다 (격자 ID 로는 늘 구분됩니다) */
  function dedupeNames(cells) {
    var seen = {};
    cells.forEach(function (c) {
      var n = c.name;
      if (seen[n] == null) { seen[n] = 1; return; }
      seen[n] += 1;
      c.name = n + ' ' + seen[n];
    });
  }

  dedupeNames(CELLS);
  var N = CELLS.length;

  /* ======================================================================
   * 4. 지수 산출
   * ==================================================================== */
  function pctl(arr, q) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(q * (a.length - 1))];
  }
  function zstats(a) {
    var m = a.reduce(function (s, v) { return s + v; }, 0) / a.length;
    var sd = Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / a.length) || 1;
    return [m, sd];
  }
  function qbins(arr, t) {
    return arr.map(function (v) { return t.reduce(function (b, th) { return b + (v > th ? 1 : 0); }, 0); });
  }

  /* 정규화·z 기준통계는 "배치 없음" 상태에서 한 번만 잡고 고정합니다.
     매번 다시 잡으면 배치 전후 KPI 를 서로 다른 자로 재는 셈이라 비교가 무의미해집니다. */
  var NORM = null;
  var MI_THRESHOLDS = [-1.5, -.75, -.25, .25, .75, 1.5];

  /** 사분면 판정. computeAll 과 추천 엔진이 같은 규칙을 쓰도록 한 곳에 둡니다. */
  function quadrantOf(zd, zs, mi, nfv, K) {
    if (zd >= .2 && mi >= .55) return 'need';
    if (zd <= -.3 && zs >= .3) return 'over';
    if (zd <= -.35 && zs <= -.35 && nfv >= K.fRef) return 'drt';
    if (zd >= .25 && zs >= .25) return 'ok';
    return 'mid';
  }

  function computeAll() {
    var first = !NORM;
    if (first) NORM = [];
    return PERIODS.map(function (P, t) {
      var sup = [], flt = [], board = [];
      CELLS.forEach(function (c) {
        var p = .02, s = .01, f = .02, ty;
        for (ty in c.byT) { p += c.byT[ty] * DM[ty][t]; f += c.byT[ty] * FM[ty][t] * 1.08; }
        for (ty in c.byTs) { s += c.byTs[ty] * SM[ty][t]; }
        p *= c.nP; s *= c.nS; f *= c.nF;
        sup.push(s); flt.push(f);
        /* 실현수요 = 잠재수요 × 공급제약. 버스가 없어서 눌린 수요를 그대로 두지 않습니다. */
        board.push(p * Math.min(1, Math.pow(s / (p * .85 + 1e-6), .6)));
      });

      if (first) {
        NORM[t] = {
          loB: pctl(board, .03), hiB: pctl(board, .97),
          loF: pctl(flt, .03), hiF: pctl(flt, .97),
          loS: pctl(sup, .03), hiS: pctl(sup, .97)
        };
      }
      var K = NORM[t];
      var nb = board.map(function (v) { return clamp((v - K.loB) / (K.hiB - K.loB || 1), 0, 1); });
      var nf = flt.map(function (v) { return clamp((v - K.loF) / (K.hiF - K.loF || 1), 0, 1); });
      var nq = sup.map(function (v) { return clamp((v - K.loS) / (K.hiS - K.loS || 1), 0, 1); });

      var D = nb.map(function (v, i) { return .5 * v + .5 * nf[i]; });
      /* 배치효과: covAdj 는 커버리지에, supAdj 는 공급점수에 직접 가산 */
      var S = nq.map(function (v, i) {
        return .78 * v + .22 * clamp(CELLS[i].coverage + CELLS[i].covAdj, 0, 1) + CELLS[i].supAdj;
      });

      if (first) {
        var dz = zstats(D), sz = zstats(S);
        K.mD = dz[0]; K.sD = dz[1]; K.mS = sz[0]; K.sS = sz[1];
        K.dRef = pctl(D, .55) + 1e-9;
        K.fRef = pctl(nf, .3);
        K.dBinT = [.2, .4, .6, .8].map(function (q) { return pctl(D, q); });
        K.sBinT = [.2, .4, .6, .8].map(function (q) { return pctl(S, q); });
        K.fBinT = [.2, .4, .6, .8].map(function (q) { return pctl(nf, q); });
      }

      var zD = D.map(function (v) { return (v - K.mD) / K.sD; });
      var zS = S.map(function (v) { return (v - K.mS) / K.sS; });
      /* 수요 가중 감쇠: 수요 자체가 미미한 격자의 상대적 공급부족이 붉게 과장되는 것을 방지 */
      var MI = zD.map(function (v, i) {
        return clamp((v - zS[i]) * Math.pow(clamp(D[i] / K.dRef, 0, 1), .65), -2.6, 2.6);
      });
      var miBin = MI.map(function (v) {
        return MI_THRESHOLDS.reduce(function (b, th) { return b + (v > th ? 1 : 0); }, 0);
      });
      var dBin = qbins(D, K.dBinT), sBin = qbins(S, K.sBinT), fBin = qbins(nf, K.fBinT);

      var quad = zD.map(function (v, i) { return quadrantOf(v, zS[i], MI[i], nf[i], K); });
      var pri = MI.map(function (v, i) {
        return quad[i] === 'need' ? v * (0.35 + CELLS[i].popWeight) * (1 + CELLS[i].elderlyRatio * 1.6) : 0;
      });

      var needIdx = [], drtIdx = [], overIdx = [];
      for (var i = 0; i < N; i++) {
        if (quad[i] === 'need') needIdx.push(i);
        else if (quad[i] === 'drt') drtIdx.push(i);
        else if (quad[i] === 'over') overIdx.push(i);
      }
      var potentialTrips = needIdx.reduce(function (s, i) { return s + nf[i]; }, 0) * TRIP_COEF;
      var elderlyTrips = needIdx.reduce(function (s, i) { return s + nf[i] * CELLS[i].elderlyRatio; }, 0) * TRIP_COEF;

      var top = [];
      for (var j = 0; j < N; j++) if (pri[j] > 0) top.push(j);
      top.sort(function (a, b) { return pri[b] - pri[a]; });

      return {
        period: P.id, D: D, S: S, zD: zD, zS: zS, MI: MI, nf: nf,
        nq: nq, K: K,          /* 국소 재계산(추천 엔진)에서 씁니다 */
        miBin: miBin, dBin: dBin, sBin: sBin, fBin: fBin,
        quad: quad, pri: pri,
        needIdx: needIdx, drtIdx: drtIdx, overIdx: overIdx,
        potentialTrips: potentialTrips, elderlyTrips: elderlyTrips,
        topIdx: top
      };
    });
  }

  /* ======================================================================
   * 5. 배치 효과 모델
   *    거리는 km 로 계산합니다(예전에는 화면 px 기준이었습니다).
   *    파급 계수는 시연용 가정값 — 실데이터에서는 실측 승하차로 보정해야 합니다.
   * ==================================================================== */
  /** 배치 효과까지 반영한 커버리지. 제약 판정은 반드시 이 값으로 해야
      같은 격자에 같은 수단이 중복 추천되지 않습니다. */
  function effectiveCoverage(c) { return clamp(c.coverage + (c.covAdj || 0), 0, 1); }

  function distKm(a, b) {
    var dx = (a.lon - b.lon) * KM_PER_DEG_LON;
    var dy = (a.lat - b.lat) * KM_PER_DEG_LAT;
    return Math.hypot(dx, dy);
  }
  var EFFECT = {
    stop: {
      label: '정류장 신설', icon: '●', radiusKm: 2.0,
      apply: function (c, d) { var k = 1 - d / 2.0; c.covAdj += .34 * k; c.supAdj += .05 * k; },
      /* 정류장 신설이 답인 상황은 "노선은 인근인데 걸어가기 먼" 경우뿐입니다.
         - 커버리지 ≥ 0.5 : 정류장은 이미 도보권. 문제는 운행 빈도 → 배차 증편
         - 커버리지 < 0.15: 노선망 자체가 닿지 않음 → 똑버스(또는 노선 신설)
         이 구분이 없으면 가장 싼 정류장이 아무 데나 이깁니다. */
      guard: function (c) { var cv = effectiveCoverage(c); return cv >= .15 && cv < .5; },
      guardMsg: '정류장 신설은 정류장이 도보권 밖이면서 기존 노선망에서 약 3km 이내인 격자에만 ' +
        '적용할 수 있습니다. 정류장이 이미 가까우면 배차 증편을, 노선망에서 멀면 똑버스를 검토하세요.'
    },
    /* 똑버스는 문전 서비스라 범위는 넓되 효과는 얕게. 한 대로 권역이 통째로 해결되면 안 됩니다. */
    drt: {
      label: '똑버스 배치', icon: '◆', radiusKm: 3.0,
      apply: function (c, d) { c.supAdj += .13 * (1 - d / 3.0); }
    },
    freq: {
      label: '배차 증편', icon: '▲', radiusKm: 2.4,
      apply: function (c, d) { c.supAdj += (d < CELL_KM ? .20 : .09); },
      /* 정류장이 도보권 안이면 부족한 것은 접근성이 아니라 운행 빈도입니다. */
      guard: function (c) { return effectiveCoverage(c) >= .5; },
      guardMsg: '배차 증편은 정류장이 도보권 안(커버리지 0.5 이상)인 격자에만 적용할 수 있습니다.'
    }
  };
  function effectRadiusKm(type) { return EFFECT[type].radiusKm; }

  function applyPlacements(placements) {
    CELLS.forEach(function (c) { c.covAdj = 0; c.supAdj = 0; });
    (placements || []).forEach(function (p) {
      var e = EFFECT[p.type];
      if (!e) return;
      var target = CELLS.filter(function (c) { return c.id === p.cellId; })[0];
      if (!target) return;
      var mult = Math.max(1, p.count || 1);
      CELLS.forEach(function (c) {
        var d = distKm(c, target);
        if (d < e.radiusKm) {
          for (var k = 0; k < mult; k++) e.apply(c, d);
        }
      });
    });
    return computeAll();
  }

  /* 기준선(배치 없음) 데이터 — 최초 1회 계산해 고정 */
  var BASE_DATA = applyPlacements([]);
  var BASELINE_KPI = BASE_DATA.map(function (d) { return kpiOf(d); });

  function kpiOf(d) {
    return {
      needCells: d.needIdx.length,
      drtCells: d.drtIdx.length,
      overCells: d.overIdx.length,
      totalCells: N,
      needShare: +(100 * d.needIdx.length / N).toFixed(1),
      potentialTripsPerDay: Math.round(d.potentialTrips),
      elderlyTripsPerDay: Math.round(d.elderlyTrips),
      avgMi: +(d.MI.reduce(function (s, v) { return s + v; }, 0) / N).toFixed(3)
    };
  }

  /* ======================================================================
   * 6. 응답 직렬화 (→ 이 모양이 API 응답 규격)
   * ==================================================================== */
  function actionOf(cell, quad) {
    if (quad === 'drt') return { code: 'DRT', label: 'DRT' };
    return cell.coverage < .42 ? { code: 'NEW_STOP', label: '신설' } : { code: 'ADD_FREQ', label: '증차' };
  }
  var QUAD_LABEL = {
    need: '고수요·저공급', over: '저수요·고공급', drt: '저수요·저공급', ok: '적정', mid: '균형권'
  };

  function serializeCells(d) {
    return CELLS.map(function (c, i) {
      var act = actionOf(c, d.quad[i]);
      return {
        id: c.id,
        name: c.name,
        region: c.region,
        direction: c.dir,
        lon: c.lon, lat: c.lat,
        x: c.x, y: c.y, w: c.w, h: c.h,
        regionCode: c.regionCode, regionKind: c.regionKind,
        demand: Math.round(100 * d.D[i]),
        supply: Math.round(100 * d.S[i]),
        zDemand: +d.zD[i].toFixed(3),
        zSupply: +d.zS[i].toFixed(3),
        mi: +d.MI[i].toFixed(3),
        flow: +d.nf[i].toFixed(4),
        flowTripsPerDay: Math.round(d.nf[i] * TRIP_COEF),
        elderlyRatio: +c.elderlyRatio.toFixed(3),
        coverage: +clamp(c.coverage + c.covAdj, 0, 1).toFixed(3),
        quadrant: d.quad[i],
        quadrantLabel: QUAD_LABEL[d.quad[i]],
        action: act.code,
        actionLabel: act.label,
        priorityScore: +d.pri[i].toFixed(4),
        nearestStopId: c.nearestStopId,
        adjusted: !!(c.covAdj || c.supAdj),
        bins: { mi: d.miBin[i], demand: d.dBin[i], supply: d.sBin[i], flow: d.fBin[i] }
      };
    });
  }

  function serializePriorities(d, limit) {
    return d.topIdx.slice(0, limit || 10).map(function (i, r) {
      var c = CELLS[i], act = actionOf(c, d.quad[i]);
      return {
        rank: r + 1,
        cellId: c.id,
        name: c.name,
        mi: +d.MI[i].toFixed(2),
        priorityScore: +d.pri[i].toFixed(4),
        demand: Math.round(100 * d.D[i]),
        supply: Math.round(100 * d.S[i]),
        flowTripsPerDay: Math.round(d.nf[i] * TRIP_COEF),
        elderlyRatio: +c.elderlyRatio.toFixed(3),
        coverage: +c.coverage.toFixed(3),
        action: act.code,
        actionLabel: act.label,
        nearestStopId: c.nearestStopId,
        reason: buildReason(c, d, i, act.code)
      };
    });
  }

  function buildReason(c, d, i, action) {
    var parts = [];
    parts.push('수요지수 ' + Math.round(100 * d.D[i]) + ' 대비 공급지수 ' + Math.round(100 * d.S[i]));
    if (c.coverage < .42) parts.push('가장 가까운 정류장까지 도보권 밖');
    if (c.elderlyRatio >= .2) parts.push('고령인구비 ' + Math.round(c.elderlyRatio * 100) + '%로 교통약자 밀집');
    if (action === 'DRT') parts.push('절대 수요가 작아 정규 노선보다 수요응답형이 적합');
    return parts.join(', ');
  }

  /* ======================================================================
   * 7. 시뮬레이션
   * ==================================================================== */
  var SIM_SEQ = 1;
  function costOf(placements) {
    var breakdown = {}, total = 0;
    (placements || []).forEach(function (p) {
      var unit = CONFIG.costKrw(p.type);
      var n = Math.max(1, p.count || 1);
      breakdown[p.type] = (breakdown[p.type] || 0) + unit * n;
      total += unit * n;
    });
    return {
      totalKrw: total,
      breakdown: Object.keys(breakdown).map(function (k) {
        var cm = CONFIG.costMeta(k) || {};
        return {
          type: k, label: EFFECT[k] ? EFFECT[k].label : k,
          unitKrw: CONFIG.costKrw(k), amountKrw: breakdown[k],
          basis: cm.basis, costBasisLabel: costBasisLabel(k),
          assumed: cm.confirmed === false
        };
      })
    };
  }

  function runSimulation(body) {
    var placements = (body && body.placements) || [];
    var data = applyPlacements(placements);
    var cost = costOf(placements);

    var periods = PERIODS.map(function (P, t) {
      var k = kpiOf(data[t]), b = BASELINE_KPI[t];
      return {
        period: P.id, periodName: P.name,
        kpi: k, baseline: b,
        delta: {
          needCells: k.needCells - b.needCells,
          drtCells: k.drtCells - b.drtCells,
          potentialTripsPerDay: k.potentialTripsPerDay - b.potentialTripsPerDay,
          elderlyTripsPerDay: k.elderlyTripsPerDay - b.elderlyTripsPerDay,
          avgMi: +(k.avgMi - b.avgMi).toFixed(3)
        }
      };
    });

    /* 효과성: 사각지대에서 해소된 잠재통행 합(전 시간대) 대비 총사업비 */
    var resolvedTrips = periods.reduce(function (s, p) { return s + Math.max(0, -p.delta.potentialTripsPerDay); }, 0);
    var resolvedCells = periods.reduce(function (s, p) { return s + Math.max(0, -p.delta.needCells); }, 0);
    var resolvedElderly = periods.reduce(function (s, p) { return s + Math.max(0, -p.delta.elderlyTripsPerDay); }, 0);

    var result = {
      id: 'SIM-' + String(SIM_SEQ++).padStart(4, '0'),
      name: (body && body.name) || '이름 없는 시나리오',
      createdAt: C.nowStamp(),
      placements: placements.map(function (p) {
        var c = CELLS.filter(function (x) { return x.id === p.cellId; })[0];
        return {
          type: p.type,
          typeLabel: EFFECT[p.type] ? EFFECT[p.type].label : p.type,
          cellId: p.cellId,
          cellName: c ? c.name : p.cellId,
          count: Math.max(1, p.count || 1),
          radiusKm: effectRadiusKm(p.type),
          unitKrw: CONFIG.costKrw(p.type)
        };
      }),
      cost: cost,
      budgetKrw: (body && body.budgetKrw) || CONFIG.COST.defaultBudget,
      periods: periods,
      effectiveness: {
        resolvedNeedCells: resolvedCells,
        resolvedTripsPerDay: Math.round(resolvedTrips),
        resolvedElderlyTripsPerDay: Math.round(resolvedElderly),
        krwPerTripPerDay: resolvedTrips > 0 ? Math.round(cost.totalKrw / resolvedTrips) : null
      },
      cellsByPeriod: {}
    };
    PERIODS.forEach(function (P, t) { result.cellsByPeriod[P.id] = serializeCells(data[t]); });

    /* 다음 호출을 위해 기준선 상태로 되돌려 둡니다 */
    applyPlacements([]);
    return result;
  }

  /* ======================================================================
   * 7-2. 추천 배치안 (탐욕적 한계효과 최대화)
   * ----------------------------------------------------------------------
   *  ⚠️ 설계 원칙: "최적화는 알고리즘, 설명은 AI"
   *     배치 위치를 언어모델에게 고르게 하지 않습니다. 매번 답이 달라지고
   *     근거를 댈 수 없기 때문입니다. 위치는 아래 알고리즘이 정하고,
   *     선정 근거를 문장으로 다듬는 일만 AI 가 맡습니다.
   *
   *  왜 빠른가
   *     배치는 공급(S)에만 영향을 주고 정규화 기준은 고정돼 있으므로,
   *     영향권 안 격자만 다시 계산해도 전체 재계산과 결과가 정확히 같습니다.
   *     (똑버스 1대 = 353칸 중 8칸만 변함 → 약 44배 절약)
   *
   *  목적함수
   *     미해결 통행량 = Σ(고수요·저공급 또는 DRT후보 격자의 잠재통행 × 교통약자 가중)
   *     교통약자 가중은 우선순위 산식과 같은 (1 + 1.6·고령인구비) 를 씁니다.
   * ==================================================================== */

  /** 격자 i 를 현재 상태 + 추가 배치효과로 다시 계산 (국소) */
  function recalcCell(i, d, addCov, addSup) {
    var c = CELLS[i], K = d.K;
    var S = .78 * d.nq[i] +
      .22 * clamp(c.coverage + c.covAdj + addCov, 0, 1) +
      c.supAdj + addSup;
    var zS = (S - K.mS) / K.sS;
    var mi = clamp((d.zD[i] - zS) * Math.pow(clamp(d.D[i] / K.dRef, 0, 1), .65), -2.6, 2.6);
    return { zS: zS, mi: mi, quad: quadrantOf(d.zD[i], zS, mi, d.nf[i], K) };
  }

  /* 수단마다 비용의 성격이 다릅니다.
     정류장은 1회성 자본비(내용연수 10년), 똑버스·증편은 연간 운영비입니다.
     화면 표시용으로 연환산 값이 필요해 아래 함수를 둡니다.
     추천 순위에 쓰는 비용은 compareCost() 를 보세요 — 기본은 총사업비입니다. */
  /** 연간 환산 비용.
   *  basis 가 'capital' 이면 내용연수로 나누고 유지관리비를 더합니다.
   *  'operating' 은 이미 연간 값이므로 그대로 씁니다(나누면 이중 할인).
   *  ※ 이 비교 방식 자체는 추후 재검토 대상입니다. docs/API.md §3.7 참고. */
  function annualCost(type) {
    var c = CONFIG.costMeta(type);
    if (!c) return 0;
    if (c.basis === 'capital') {
      return c.krw / (c.lifeYears || 1) + (c.annualMaintenanceKrw || 0);
    }
    return c.krw;   // operating: 이미 연간 값이라 나누면 이중 할인
  }

  /* 추천 순위를 매길 때 쓰는 '비용'.
     예산 한도를 총액으로 재고 있으므로 순위도 같은 자로 재야 합니다.
     기준을 바꾸려면 CONFIG.COST.compareBasis 한 줄만 고치면 됩니다. */
  function compareCost(type) {
    return CONFIG.COST.compareBasis === 'annual'
      ? annualCost(type)
      : CONFIG.costKrw(type);
  }

  /* 비교 기준 설명. meta·추천·보고서가 같은 문장을 쓰도록 여기서만 만듭니다. */
  function costCompareMeta() {
    var annual = CONFIG.COST.compareBasis === 'annual';
    return {
      basis: CONFIG.COST.compareBasis,
      label: annual ? '연환산 비용 기준' : '총사업비 기준',
      note: annual
        ? '자본비는 내용연수로 나눠 연간 비용으로 환산해 비교했습니다.'
        : '예산 한도와 같은 기준(총사업비)으로 비교했습니다. '
          + '똑버스·증편은 이듬해에도 같은 예산이 필요합니다.'
    };
  }

  /* 보고서 주석 시트에 그대로 실리는 산출식 */
  function formulaMeta() {
    return {
      demand: 'D = 0.5·norm(교통카드 승하차) + 0.5·norm(통신 유동인구)',
      supply: 'S = 0.78·norm(운행빈도) + 0.22·정류장 커버리지 + 배치효과',
      mismatch: 'MI = z(D) − z(S), 수요가중 감쇠 적용',
      priority: '우선순위 = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)'
    };
  }
  function costBasisLabel(type) {
    var c = CONFIG.costMeta(type);
    if (!c) return '-';
    return c.basis === 'capital'
      ? '1회성 자본비(내용연수 ' + (c.lifeYears || 1) + '년)'
      : '연간 운영비';
  }

  /* ======================================================================
   *  추천 전략 — 같은 알고리즘에 목적만 바꿔 끼웁니다.
   *
   *  그리디는 결정론적이라 같은 조건이면 항상 같은 답이 나옵니다.
   *  정책 도구에서 재현성은 요구사항이므로 난수를 넣지 않습니다.
   *  대신 "다른 안"이 필요하면 목적함수를 바꿉니다. 각 전략은 그 자체로
   *  결정론적이면서 서로 다른 답을 냅니다.
   * =================================================================== */
  var STRATEGIES = {
    efficiency: {
      label: '효율 최우선', short: '효율',
      note: '사업비 1원당 해소 통행량이 가장 큰 순서로 고릅니다.',
      basisNote: '기본안입니다. 예산 대비 성과를 묻는 질문에 답합니다.',
      /* 전체 통행에 고령 가중을 얹은 값 — 우선순위 산식과 같은 계수 */
      weight: function (i) { return 1 + CELLS[i].elderlyRatio * 1.6; }
    },
    equity: {
      label: '교통약자 우선', short: '약자',
      note: '고령 통행 해소량이 가장 큰 순서로 고릅니다.',
      basisNote: '전체 통행이 아니라 고령 통행을 기준으로 삼습니다. '
        + '총 해소량은 줄지만 이동 대안이 적은 지역이 먼저 들어갑니다.',
      /* 가중치를 조금 올리는 정도로는 순위가 안 바뀝니다(1.6→3.0 실험 결과 동일).
         기준 자체를 고령 통행량으로 바꿔야 실제로 다른 답이 나옵니다. */
      weight: function (i) { return CELLS[i].elderlyRatio; }
    },
    balance: {
      label: '지역 균형', short: '균형',
      note: '읍면동마다 최대 1개씩만 배정해 특정 지역 집중을 막습니다.',
      basisNote: '효율은 떨어지지만 지역 형평 문제 제기에 대응할 수 있습니다.',
      weight: function (i) { return 1 + CELLS[i].elderlyRatio * 1.6; },
      maxPerRegion: 1
    },
    quick: {
      label: '즉시 착수', short: '즉시',
      note: '인허가·운영 협의가 비교적 짧은 정류장 신설만으로 구성합니다.',
      basisNote: '운수업체 협의나 차량 확보 없이 당해 연도 착수가 가능한 범위입니다.',
      weight: function (i) { return 1 + CELLS[i].elderlyRatio * 1.6; },
      types: ['stop']
    }
  };
  var STRATEGY_ORDER = ['efficiency', 'equity', 'balance', 'quick'];
  function strategyOf(id) { return STRATEGIES[id] ? id : 'efficiency'; }

  /** 아직 해결되지 않은 통행량 (교통약자 가중 반영) */
  function unresolvedOf(i, d, quad, wf) {
    if (quad !== 'need' && quad !== 'drt') return 0;
    var w = wf ? wf(i) : (1 + CELLS[i].elderlyRatio * 1.6);
    return d.nf[i] * TRIP_COEF * w;
  }

  /** 후보 하나를 놓았을 때의 개선량. 실제로 반영하지는 않습니다. */
  function evalCandidate(type, target, dataAll, t, wf) {
    var e = EFFECT[type], d = dataAll[t];
    var gainWeighted = 0, gainTrips = 0, resolvedCells = 0;
    for (var i = 0; i < N; i++) {
      var dist = distKm(CELLS[i], target);
      if (dist >= e.radiusKm) continue;
      var inc = { covAdj: 0, supAdj: 0 };
      e.apply(inc, dist);
      var after = recalcCell(i, d, inc.covAdj, inc.supAdj);
      var before = d.quad[i];
      var u0 = unresolvedOf(i, d, before, wf), u1 = unresolvedOf(i, d, after.quad, wf);
      if (u0 !== u1) {
        gainWeighted += u0 - u1;
        if (before === 'need' && after.quad !== 'need') {
          resolvedCells++;
          gainTrips += d.nf[i] * TRIP_COEF;
        } else if (before !== 'need' && after.quad === 'need') {
          resolvedCells--;
          gainTrips -= d.nf[i] * TRIP_COEF;
        } else if (before === 'drt' && after.quad !== 'drt') {
          resolvedCells++;
        }
      }
    }
    return { weighted: gainWeighted, trips: Math.round(gainTrips), cells: resolvedCells };
  }

  /** 왜 이 수단을 이 자리에 골랐는지 — 보고서에 그대로 실립니다 */
  function buildRationale(cell, d, i, type, gain) {
    var parts = [];
    parts.push('수요지수 ' + Math.round(100 * d.D[i]) + ' 대비 공급지수 ' + Math.round(100 * d.S[i]));
    if (type === 'stop') {
      parts.push('노선은 인근을 지나지만 정류장이 도보권 밖(커버리지 ' +
        cell.coverage.toFixed(2) + ')이라 정류장 신설로 해소 가능');
    } else if (type === 'freq') {
      parts.push('정류장은 도보권 안(커버리지 ' + cell.coverage.toFixed(2) +
        ')이므로 부족한 것은 접근성이 아니라 운행 빈도');
    } else {
      parts.push(cell.coverage < .15
        ? '노선망이 닿지 않아(커버리지 ' + cell.coverage.toFixed(2) + ') 정규 노선보다 수요응답형이 적합'
        : '절대 수요가 작아 정규 노선 증차보다 수요응답형이 적합');
    }
    if (cell.elderlyRatio >= .18) {
      parts.push('고령인구비 ' + Math.round(cell.elderlyRatio * 100) + '%로 이동 대안이 적음');
    }
    if (gain.cells > 0) parts.push('인근 ' + gain.cells + '개 격자 해소 예상');
    return parts.join(', ');
  }

  function runRecommendation(body) {
    body = body || {};
    var period = body.period || 'am';
    var t = periodIndex(period);
    var budget = body.budgetKrw != null ? body.budgetKrw : CONFIG.COST.defaultBudget;
    var maxN = Math.max(1, Math.min(20, body.maxPlacements || 10));
    var allowed = body.allowedTypes && body.allowedTypes.length
      ? body.allowedTypes : Object.keys(EFFECT);

    /* 전략이 수단을 제한하면(즉시 착수 = 정류장만) 요청과 교집합을 씁니다 */
    var stratId = strategyOf(body.strategy);
    var strat = STRATEGIES[stratId];
    if (strat.types) {
      allowed = allowed.filter(function (x) { return strat.types.indexOf(x) >= 0; });
      if (!allowed.length) allowed = strat.types.slice();
    }

    /* 추천 범위 — 대시보드에서 특정 격자를 보고 넘어왔다면 그 읍면동으로 후보를
       제한합니다. 후보만 좁힐 뿐 선정 방식은 같아서 결정성이 유지됩니다. */
    var regionScope = body.region || null;
    /* 단일 동 안에서 '지역 균형'(동별 1건 상한)은 곧 1건 추천이라 성립하지 않습니다 */
    if (regionScope && stratId === 'balance') {
      stratId = 'efficiency';
      strat = STRATEGIES[stratId];
    }

    /* 기존 배치는 무시하고 기준선에서 새로 짭니다(교체 방식) */
    var data = applyPlacements([]);
    var chosen = [], spent = 0, stopped = 'max_reached';
    var used = {};        /* 같은 격자에 같은 수단을 두 번 추천하지 않습니다 */
    var perRegion = {};   /* 지역 균형 전략에서 읍면동별 배정 수를 셉니다 */

    while (chosen.length < maxN) {
      var d = data[t], best = null;

      for (var i = 0; i < N; i++) {
        var q = d.quad[i];
        if (q !== 'need' && q !== 'drt') continue;          // 후보: 미해결 격자만
        if (regionScope && CELLS[i].region !== regionScope) continue;   // 범위 제한

        /* 지역 균형 — 이미 상한을 채운 읍면동은 건너뜁니다 */
        if (strat.maxPerRegion &&
            (perRegion[CELLS[i].region] || 0) >= strat.maxPerRegion) continue;

        for (var a = 0; a < allowed.length; a++) {
          var type = allowed[a], e = EFFECT[type];
          if (!e) continue;
          if (used[type + '@' + CELLS[i].id]) continue;
          if (e.guard && !e.guard(CELLS[i])) continue;       // 증편은 도보권 안에서만
          var cost = CONFIG.costKrw(type);
          if (cost <= 0 || spent + cost > budget) continue;  // 예산 초과분은 제외

          var gain = evalCandidate(type, CELLS[i], data, t, strat.weight);
          if (gain.weighted <= 0) continue;
          var eff = gain.weighted / compareCost(type);       // 1원당 개선량 (예산과 같은 기준)
          if (!best || eff > best.eff) {
            best = { i: i, type: type, cost: cost, eff: eff, gain: gain };
          }
        }
      }

      if (!best) {
        /* 한 건도 못 넣고 끝났는데 사유가 '예산 소진'이면
           "0건 · 0원 · 예산 소진"이라는 모순 문장이 화면에 나옵니다 */
        stopped = chosen.length ? 'no_further_gain'
          : (spent === 0 && budget < Math.min.apply(null, allowed.map(function (x) { return CONFIG.costKrw(x) || 1e12; }))
            ? 'budget_too_small'
            : (regionScope ? 'no_candidate' : 'no_further_gain'));
        break;
      }

      var cell = CELLS[best.i];
      used[best.type + '@' + cell.id] = true;
      perRegion[cell.region] = (perRegion[cell.region] || 0) + 1;
      chosen.push({
        rank: chosen.length + 1,
        type: best.type,
        typeLabel: EFFECT[best.type].label,
        cellId: cell.id,
        cellName: cell.name,
        region: cell.region,
        count: 1,
        radiusKm: EFFECT[best.type].radiusKm,
        costKrw: best.cost,
        annualCostKrw: Math.round(annualCost(best.type)),
        costBasis: costBasisLabel(best.type),
        costAssumed: (CONFIG.costMeta(best.type) || {}).confirmed === false,
        expectedResolvedCells: best.gain.cells,
        expectedResolvedTrips: best.gain.trips,
        krwPerTrip: best.gain.trips > 0 ? Math.round(best.cost / best.gain.trips) : null,
        rationale: buildRationale(cell, data[t], best.i, best.type, best.gain)
      });
      spent += best.cost;

      /* 채택분을 실제로 반영하고 다음 라운드로.
         이미 커버된 곳은 다음 회차에 효율이 자동으로 떨어집니다(중복 배치 방지). */
      data = applyPlacements(chosen.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      }));

      if (spent >= budget) { stopped = 'budget_exhausted'; break; }
    }

    /* 최종 효과는 기존 시뮬레이션 경로로 계산해 화면·보고서와 수치를 일치시킵니다 */
    var sim = runSimulation({
      name: body.name || (strat.label + ' 배치안'),
      period: period,
      budgetKrw: budget,
      placements: chosen.map(function (p) {
        return { type: p.type, cellId: p.cellId, count: p.count };
      })
    });
    applyPlacements([]);   // 기준선 복원

    var block = sim.periods.filter(function (x) { return x.period === period; })[0] || sim.periods[0];

    /* 다른 전략으로 돌리면 어떻게 되는지 요약만 함께 돌려줍니다.
       "이 안 말고 다른 안은 없나요"에 화면에서 바로 답하기 위한 것입니다.
       요약만 필요하므로 배치 목록은 싣지 않습니다(응답 크기 절약). */
    var alternatives = null;
    if (body.includeAlternatives) {
      alternatives = STRATEGY_ORDER.filter(function (sid) {
        /* 동 범위에서는 '지역 균형'이 성립하지 않으므로 대안표에서도 뺍니다 */
        return !(regionScope && sid === 'balance');
      }).map(function (sid) {
        var alt = sid === stratId ? null : runRecommendation({
          period: period, budgetKrw: budget, maxPlacements: maxN,
          allowedTypes: body.allowedTypes, strategy: sid, region: regionScope
        });
        var su = alt ? alt.summary : null;
        var mix = { stop: 0, drt: 0, freq: 0 };
        (alt ? alt.placements : chosen).forEach(function (pp) { mix[pp.type]++; });
        return {
          strategy: sid,
          label: STRATEGIES[sid].label,
          short: STRATEGIES[sid].short,
          note: STRATEGIES[sid].note,
          basisNote: STRATEGIES[sid].basisNote,
          selected: sid === stratId,
          count: alt ? su.count : chosen.length,
          totalKrw: alt ? su.totalKrw : spent,
          mix: mix,
          expectedResolvedCells: alt ? su.expectedResolvedCells : Math.max(0, -block.delta.needCells),
          expectedResolvedTrips: alt ? su.expectedResolvedTrips : Math.max(0, -block.delta.potentialTripsPerDay),
          expectedResolvedElderlyTrips: alt ? su.expectedResolvedElderlyTrips
            : Math.max(0, -block.delta.elderlyTripsPerDay)
        };
      });
      applyPlacements([]);   // 대안 계산 후 기준선 복원
    }

    return {
      method: 'budget-constrained greedy marginal benefit',
      methodLabel: '예산 제약 하 한계효과 최대화',
      methodNote: '미해결 통행량(고수요·저공급 + DRT후보, 교통약자 가중)을 ' +
        (CONFIG.COST.compareBasis === 'annual' ? '연간 환산 사업비' : '총사업비') +
        ' 1원당 가장 많이 줄이는 지점을 순차 선택했습니다. ' +
        '이미 개선된 지역은 다음 회차에 효율이 낮아져 중복 배치되지 않습니다.' +
        (regionScope ? ' 추천 범위: ' + regionScope + '.' : ''),
      period: period,
      generatedAt: C.nowStamp(),

      /* 추천 범위 (null = 화성시 전체). 범위를 좁혀도 알고리즘은 같습니다. */
      region: regionScope,

      /* 어떤 목적으로 고른 안인지. 같은 알고리즘에 목적만 바꿔 끼운 것입니다. */
      strategy: stratId,
      strategyLabel: strat.label,
      strategyNote: strat.note,
      strategyBasisNote: strat.basisNote,
      strategies: STRATEGY_ORDER.map(function (sid) {
        return { id: sid, label: STRATEGIES[sid].label, short: STRATEGIES[sid].short,
                 note: STRATEGIES[sid].note };
      }),
      alternatives: alternatives,

      /* 배치 선정은 알고리즘, 설명·보고서 문장은 AI 가 씁니다. */
      producedBy: {
        placements: '최적화 알고리즘 (예산 제약 하 그리디)',
        narrative: CONFIG.APP.isMockData ? '템플릿 (실서버에서는 Claude)' : 'Claude',
        deterministic: true,
        deterministicNote: '같은 조건이면 항상 같은 결과가 나옵니다. '
          + '다른 안이 필요하면 난수가 아니라 전략(목적)을 바꿉니다.'
      },

      placements: chosen,
      simulation: sim,
      summary: {
        count: chosen.length,
        totalKrw: spent,
        budgetKrw: budget,
        budgetUsedPct: budget > 0 ? +(100 * spent / budget).toFixed(1) : 0,
        expectedResolvedCells: Math.max(0, -block.delta.needCells),
        expectedResolvedTrips: Math.max(0, -block.delta.potentialTripsPerDay),
        expectedResolvedElderlyTrips: Math.max(0, -block.delta.elderlyTripsPerDay),
        krwPerTrip: sim.effectiveness.krwPerTripPerDay,
        stoppedBecause: stopped,
        costCompareBasis: costCompareMeta().basis,
        costCompareLabel: costCompareMeta().label,
        costCompareNote: costCompareMeta().note
      }
    };
  }

  /* ======================================================================
   * 8. AI 보고서 초안 (목)
   * ----------------------------------------------------------------------
   *  실서버에서는 이 함수 자리에서 Claude API 를 호출합니다.
   *  프롬프트·모델·응답 스키마는 docs/AI-REPORT.md 를 참고하세요.
   *  아래 목 구현은 같은 스키마를 규칙 기반으로 채워 넣습니다.
   * ==================================================================== */
  function draftReport(body) {
    var ctx = (body && body.context) || {};
    var pid = (body && body.period) || 'am';
    var t = periodIndex(pid);
    var P = PERIODS[t];
    var d = BASE_DATA[t];
    var base = BASELINE_KPI[t];
    var sim = ctx.simulation || null;
    var rec = ctx.recommendation || null;
    var top = serializePriorities(d, 5);
    var f = C.fmt, won = C.won;

    var simPeriod = sim ? sim.periods.filter(function (x) { return x.period === pid; })[0] : null;

    var sections = [];

    sections.push({
      key: 'summary', heading: '1. 검토 개요',
      body: '본 자료는 교통카드 빅데이터로 산출한 실현수요와 통신사 유동인구로 산출한 잠재수요를 ' +
        '동일 격자 단위에서 공급(운행빈도·정류장 커버리지)과 대조하여, ' + P.name + '시간대(' + P.label + ') ' +
        '대중교통 수급 불일치 구간을 식별하고 노선 조정 우선순위를 제시하기 위해 작성하였다.\n' +
        '분석 대상 격자는 총 ' + f(base.totalCells) + '개이며, 이 중 수요가 공급을 뚜렷하게 초과하는 ' +
        '고수요·저공급 격자는 ' + f(base.needCells) + '개(' + base.needShare + '%)로 확인되었다.',
      bullets: [
        '분석 시간대: ' + P.name + ' ' + P.label,
        '고수요·저공급 격자: ' + f(base.needCells) + '개 / 전체 ' + f(base.totalCells) + '개',
        '사각지대 잠재수요: 일 ' + f(base.potentialTripsPerDay) + '통행',
        '이 중 고령층 추정 통행: 일 ' + f(base.elderlyTripsPerDay) + '통행'
      ]
    });

    sections.push({
      key: 'status', heading: '2. 현황 분석',
      body: '미스매칭 지수(MI)는 수요지수의 표준화값에서 공급지수의 표준화값을 뺀 값으로, ' +
        '양(+)의 값이 클수록 수요 대비 공급이 부족함을 의미한다. ' +
        P.name + '시간대 전체 격자의 평균 MI는 ' + base.avgMi.toFixed(2) + '이며, ' +
        '상위 격자는 ' + (top[0] ? top[0].name : '-') + ' 일대에 집중되어 있다.\n' +
        '한편 수요와 공급이 모두 낮아 정규 노선 신설의 실익이 낮은 격자는 ' + f(base.drtCells) + '개로, ' +
        '수요응답형 교통(똑버스) 검토 대상으로 분류하였다.',
      bullets: top.map(function (r) {
        return r.rank + '순위 ' + r.name + '(' + r.cellId + ') — MI +' + r.mi.toFixed(2) +
          ', 잠재수요 일 ' + f(r.flowTripsPerDay) + '통행, 고령비 ' + Math.round(r.elderlyRatio * 100) + '%';
      })
    });

    sections.push({
      key: 'problem', heading: '3. 도출된 문제점',
      body: '첫째, 신규 개발지구와 산업단지 배후 격자에서 잠재수요 대비 노선 공급이 지체되고 있다. ' +
        '둘째, 농촌 지역은 절대 수요가 작아 정규 노선 증차의 효율이 낮은 반면 고령인구 비중이 높아 ' +
        '이동권 보장 측면의 대응이 필요하다. ' +
        '셋째, 일부 격자는 수요 대비 공급이 과잉으로 나타나 노선 효율화 여지가 있다.',
      bullets: [
        '개발지구·산단 배후: 공급 지체로 인한 실현수요 억제 추정',
        '농촌 지역: 저수요·저공급 ' + f(base.drtCells) + '개 격자, 정규 노선 대신 수요응답형 검토 필요',
        '공급 과잉 추정 격자 ' + f(base.overCells) + '개: 배차 재배분 검토 대상'
      ]
    });

    var planBody, planBullets;
    if (rec && rec.placements && rec.placements.length) {
      var su = rec.summary || {};
      planBody = '예산 ' + won(su.budgetKrw || 0) + ' 범위에서 ' + (rec.methodLabel || '최적화 분석') +
        ' 방식으로 우선 배치 대상 ' + rec.placements.length + '개 지점을 도출하였다. ' +
        '총 소요액은 ' + won(su.totalKrw || 0) + '으로 예산의 ' + (su.budgetUsedPct || 0) + '% 수준이다.' +
        (rec.strategyLabel
          ? '\n본 안은 「' + rec.strategyLabel + '」 기준으로 산출하였다. ' + (rec.strategyNote || '')
            + ' ' + (rec.strategyBasisNote || '')
          : '') +
        (rec.edited ? '\n다만 아래 목록은 담당 부서 검토 의견을 반영해 일부 조정한 안이다.' : '') +
        '\n' + (rec.methodNote || '');
      planBullets = rec.placements.map(function (p) {
        return p.rank + '순위 ' + p.typeLabel + ' — ' + p.cellName + '(' + p.cellId + '), ' +
          won(p.costKrw) + '. ' + p.rationale;
      });
    } else if (sim && sim.placements.length) {
      var byType = {};
      sim.placements.forEach(function (p) { byType[p.typeLabel] = (byType[p.typeLabel] || 0) + p.count; });
      planBody = '「' + sim.name + '」 시나리오는 ' +
        Object.keys(byType).map(function (k) { return k + ' ' + byType[k] + '건'; }).join(', ') +
        '을 배치하는 안으로, 총 소요액은 ' + won(sim.cost.totalKrw) + '으로 산정되었다.';
      planBullets = sim.placements.map(function (p) {
        return p.typeLabel + ' — ' + p.cellName + '(' + p.cellId + ') ' + p.count + '건, ' +
          '파급반경 약 ' + p.radiusKm + 'km, 소요액 ' + won(p.unitKrw * p.count);
      });
    } else {
      planBody = '분석 결과에 따라 격자 특성별로 대응 수단을 달리 적용할 것을 제안한다. ' +
        '정류장 도보권 밖 고수요 격자는 정류장 신설을, 도보권 내 고수요 격자는 배차 증편을, ' +
        '저수요·저공급 격자는 수요응답형 교통(똑버스) 배치를 우선 검토한다.';
      planBullets = top.map(function (r) {
        return r.name + '(' + r.cellId + ') — ' + r.actionLabel + ' 검토: ' + r.reason;
      });
    }
    sections.push({ key: 'plan', heading: '4. 개선 방안', body: planBody, bullets: planBullets });

    var effBody, effBullets;
    /* 배치가 한 건도 없으면 전후가 같아 빈 표·"변동 없음" 문장만 남습니다.
       그때는 기준선 보고서 문안으로 처리합니다. */
    if (sim && simPeriod && sim.placements.length) {
      var dn = simPeriod.delta.needCells, dt = simPeriod.delta.potentialTripsPerDay;
      effBody = '시뮬레이션 결과 ' + P.name + '시간대 고수요·저공급 격자는 ' +
        f(simPeriod.baseline.needCells) + '개에서 ' + f(simPeriod.kpi.needCells) + '개로 ' +
        (dn < 0 ? f(-dn) + '개 감소하였다' : dn > 0 ? f(dn) + '개 증가하였다' : '변동이 없었다') + '.\n' +
        '사각지대 잠재수요는 일 ' + f(simPeriod.baseline.potentialTripsPerDay) + '통행에서 ' +
        f(simPeriod.kpi.potentialTripsPerDay) + '통행으로 ' +
        (dt < 0 ? f(-dt) + '통행 해소되는 것으로 추정된다' : '변동이 없는 것으로 추정된다') + '.';
      effBullets = [
        '고수요·저공급 격자: ' + f(simPeriod.baseline.needCells) + '개 → ' + f(simPeriod.kpi.needCells) + '개',
        '사각지대 잠재수요: 일 ' + f(simPeriod.baseline.potentialTripsPerDay) + '통행 → ' + f(simPeriod.kpi.potentialTripsPerDay) + '통행',
        '고령층 사각지대 통행: 일 ' + f(simPeriod.baseline.elderlyTripsPerDay) + '통행 → ' + f(simPeriod.kpi.elderlyTripsPerDay) + '통행',
        '총 소요액: ' + won(sim.cost.totalKrw) +
        (sim.effectiveness.krwPerTripPerDay ? ' (해소 통행 1건당 ' + f(sim.effectiveness.krwPerTripPerDay) + '원)' : '')
      ];
    } else {
      effBody = '상기 개선 방안을 적용할 경우, 사각지대 잠재수요 일 ' + f(base.potentialTripsPerDay) +
        '통행 중 상당 부분이 대중교통으로 전환될 것으로 기대된다. ' +
        '구체적 효과는 시뮬레이션 화면에서 수단·위치별로 산정할 수 있다.';
      effBullets = [
        '대상 잠재수요: 일 ' + f(base.potentialTripsPerDay) + '통행',
        '교통약자 수혜 추정: 일 ' + f(base.elderlyTripsPerDay) + '통행',
        '정량 효과는 정책 시뮬레이션 화면에서 배치안별로 산출'
      ];
    }
    sections.push({ key: 'effect', heading: '5. 기대 효과', body: effBody, bullets: effBullets });

    sections.push({
      key: 'next', heading: '6. 향후 조치 계획',
      body: '단기적으로는 우선순위 상위 격자에 대한 현장 실사와 노선 협의를 진행하고, ' +
        '중기적으로는 수요응답형 교통 운행 구역 조정을 검토한다. ' +
        '분석 지표는 교통카드 데이터 갱신 주기에 맞추어 정기적으로 재산출한다.',
      bullets: [
        '단기(3개월): 우선순위 상위 격자 현장 실사 및 운수업체 협의',
        '중기(6개월): 수요응답형 교통 운행구역 조정안 수립',
        '상시: 교통카드·유동인구 데이터 갱신 시 지표 재산출'
      ]
    });

    var tables = [{
      key: 'priority', title: '노선 조정 우선순위 (상위 10개 격자)',
      columns: ['순위', '격자', '권역', '수요 D', '공급 S', 'MI', '고령비', '잠재수요(통행/일)', '조치'],
      rows: serializePriorities(d, 10).map(function (r) {
        return [r.rank, r.cellId, r.name, r.demand, r.supply, (r.mi >= 0 ? '+' : '') + r.mi.toFixed(2),
        Math.round(r.elderlyRatio * 100) + '%', f(r.flowTripsPerDay), r.actionLabel];
      })
    }];

    if (rec && rec.placements && rec.placements.length) {
      tables.push({
        key: 'recommendation', title: '추천 배치안 및 선정 근거',
        columns: ['순위', '수단', '위치', '격자', '사업비(원)', '비용 성격', '해소 격자', '해소 통행(일)', '선정 근거'],
        rows: rec.placements.map(function (p) {
          return [p.rank, p.typeLabel, p.cellName, p.cellId, f(p.costKrw),
            p.costBasis || '-', p.expectedResolvedCells, f(p.expectedResolvedTrips), p.rationale];
        })
      });
    }

    if (sim && sim.placements.length) {
      tables.push({
        key: 'placements', title: '시뮬레이션 배치 내역',
        columns: ['수단', '격자', '위치', '수량', '파급반경(km)', '소요액(원)'],
        rows: sim.placements.map(function (p) {
          return [p.typeLabel, p.cellId, p.cellName, p.count, p.radiusKm, f(p.unitKrw * p.count)];
        })
      });
      tables.push({
        key: 'kpi', title: '시간대별 기준선 대비 효과',
        columns: ['시간대', '사각지대 격자(전)', '사각지대 격자(후)', '증감', '잠재수요(전)', '잠재수요(후)', '증감'],
        rows: sim.periods.map(function (p) {
          return [p.periodName, p.baseline.needCells, p.kpi.needCells,
            (p.delta.needCells > 0 ? '+' : '') + p.delta.needCells,
          f(p.baseline.potentialTripsPerDay), f(p.kpi.potentialTripsPerDay),
            (p.delta.potentialTripsPerDay > 0 ? '+' : '') + f(p.delta.potentialTripsPerDay)];
        })
      });
    }

    /* 목적별 대안 비교 — "왜 이 안이냐"에 대한 답을 문서 안에 남깁니다. */
    if (rec && rec.alternatives && rec.alternatives.length > 1) {
      tables.push({
        key: 'alternatives', title: '목적별 대안 비교',
        columns: ['목적', '채택', '구성', '해소 격자', '일 통행 해소', '고령 통행 해소', '사업비(원)'],
        rows: rec.alternatives.map(function (a) {
          var mix = ['stop', 'drt', 'freq'].filter(function (k) { return a.mix[k]; })
            .map(function (k) { return EFFECT[k].label + ' ' + a.mix[k]; }).join(', ') || '—';
          return [a.label, a.selected ? '○' : '', mix, a.expectedResolvedCells,
                  f(a.expectedResolvedTrips), f(a.expectedResolvedElderlyTrips), f(a.totalKrw)];
        })
      });
    }

    return {
      title: CONFIG.APP.org + ' 대중교통 수급 불일치 분석 및 노선 조정 검토(안)',
      subtitle: P.name + ' 시간대(' + P.label + ') 기준' +
        (sim ? ' · 시나리오 「' + sim.name + '」' : '') +
        (rec ? (rec.edited ? ' · AI 추천안(수정)' : ' · AI 추천안') : ''),
      org: CONFIG.APP.org,
      dept: CONFIG.APP.dept,
      period: pid,
      generatedAt: C.nowStamp(),
      model: 'mock-template',      // 실서버에서는 'claude-opus-5'
      sections: sections,
      tables: tables,
      /* 주석 시트가 쓰는 산출식·비교 기준.
         이게 없으면 report.js 가 하드코딩된 기본 문구로 넘어갑니다. */
      meta: {
        formula: formulaMeta(),
        costCompare: costCompareMeta()
      },
      disclaimer: CONFIG.APP.isMockData
        ? '본 문서의 수치는 로직 시연을 위한 가상 예시 데이터에 기반합니다. 행정경계만 실제(SGIS)이며 ' +
          '수요·공급 수치와 노선·정류장은 가상입니다. 정책 판단의 근거로 사용할 수 없습니다.'
        : '본 문서는 자동 생성된 초안입니다. 시간대별 승하차는 원자료에 시간대 정보가 없어 ' +
          '통신 유동인구 시간배율로 안분한 추정치이며, 사업비와 내용연수는 미확정 가정값입니다. ' +
          '담당자 검토 후 활용하시기 바랍니다.'
    };
  }

  /* ======================================================================
   * 9. 목 라우터 — api.js 가 이 함수를 호출합니다.
   * ==================================================================== */
  function handle(opId, params, body) {
    params = params || {};
    var t = periodIndex(params.period);
    var d = BASE_DATA[t];

    switch (opId) {
      case 'meta.get':
        return {
          region: BND.region,
          updatedAt: C.todayISO(),
          isMockData: true,
          periods: PERIODS.map(function (p) {
            return { id: p.id, name: p.name, label: p.label, hours: p.hours };
          }),
          grid: {
            /* 분석 격자 — SGIS 공공데이터포털 배포판이 1km 만 제공합니다 */
            sizeMeters: CONFIG.GRID.analysisSizeMeters,
            analysisCellCount: CONFIG.GRID.analysisCellCount,
            /* 화면 표시 격자 — 분석 격자를 묶어 그립니다 */
            displaySizeMeters: CELL_KM * 1000,
            /* ★ 아래 값은 /grid 의 cells 길이와 반드시 같아야 합니다 */
            cellCount: N,
            crs: 'EPSG:4326', bbox: BBOX
          },
          map: {
            viewBox: [0, 0, VIEW_W, VIEW_H],
            /* 실제 행정경계. 좌표는 경위도이므로 화면에서 투영해 그립니다. */
            boundarySource: BND.source,
            regions: DONGS.map(function (d) {
              return {
                code: d.code, name: d.name, kind: d.kind,
                centroid: d.centroid, bbox: d.bbox, rings: d.rings
              };
            }),
            scaleBar: { km: 5 }
          },
          cost: CONFIG.COST,
          /* 어느 수치가 실측이고 어느 수치가 추정인지 화면이 알 수 있게 합니다.
             교통카드 원자료는 일자별 집계라 시간대 정보가 없어서,
             시간대별 승하차는 유동인구 시간배율로 안분한 추정치입니다. */
          dataQuality: {
            boardingDaily: { level: 'observed', label: '일별 승하차', source: '교통카드빅데이터(STCIS)' },
            boardingHourly: {
              level: 'estimated', label: '시간대별 승하차',
              method: '일자별 승하차를 통신 유동인구 시간배율로 안분',
              note: '원자료에 시간대 정보가 없습니다.'
            },
            flowHourly: { level: 'observed', label: '시간대별 유동인구', source: '통신사 유동인구' },
            boundary: { level: 'observed', label: '행정경계', source: BND.source }
          },
          formula: formulaMeta(),
          costCompare: costCompareMeta(),
          effects: Object.keys(EFFECT).map(function (k) {
            var cm = CONFIG.costMeta(k) || {};
            return {
              type: k, label: EFFECT[k].label, icon: EFFECT[k].icon,
              radiusKm: EFFECT[k].radiusKm,
              unitKrw: CONFIG.costKrw(k),
              costBasis: cm.basis, costBasisLabel: costBasisLabel(k),
              costNote: cm.note, costSource: cm.source,
              costAssumed: cm.confirmed === false
            };
          })
        };

      case 'grid.list':
        return {
          period: PERIODS[t].id,
          scale: { miThresholds: MI_THRESHOLDS, tripCoef: TRIP_COEF },
          kpi: BASELINE_KPI[t],
          cells: serializeCells(d)
        };

      case 'stops.list':
        return {
          stops: STOP_LIST.map(function (s) {
            return {
              id: s.id,                 /* 조인 키: {시군구코드}-{ARS번호} */
              arsNo: s.arsNo,           /* 국토부 ARS번호(모바일단축번호) */
              name: s.name, dong: s.dong,
              lon: s.lon, lat: s.lat, x: s.x, y: s.y,
              kind: s.kind, routes: s.routes.slice()
            };
          })
        };

      case 'stops.profile': {
        var st = STOP_BY_ID[params.stopId] || STOP_LIST[0];
        var tb = st.boardings.reduce(function (a, b) { return a + b; }, 0);
        var ta = st.alightings.reduce(function (a, b) { return a + b; }, 0);
        var peak = 0;
        HOURS.forEach(function (hr, k) {
          if ((hr >= 7 && hr < 9) || (hr >= 17 && hr < 19)) peak += st.boardings[k] + st.alightings[k];
        });
        return {
          stopId: st.id, stopName: st.name, kind: st.kind, routes: st.routes.slice(),
          /* 시간대 프로파일은 실측이 아니라 추정입니다(위 dataQuality 참고) */
          isEstimated: true,
          estimationMethod: '일자별 승하차를 통신 유동인구 시간배율로 안분',
          hours: HOURS.slice(), boardings: st.boardings.slice(), alightings: st.alightings.slice(),
          summary: {
            boardingsPerDay: tb, alightingsPerDay: ta,
            peakSharePct: +(100 * peak / (tb + ta || 1)).toFixed(1)
          }
        };
      }

      case 'routes.list':
        return {
          routes: ROUTES.map(function (r) {
            return {
              id: r.id, name: r.name, type: r.type, stopIds: r.stopIds.slice(),
              path: r.pts.map(function (p) { return [p[0], p[1]]; })
            };
          })
        };

      case 'priorities.list':
        return { period: PERIODS[t].id, items: serializePriorities(d, Number(params.limit) || 10) };

      case 'simulations.run':
        return runSimulation(body);

      case 'recommendations.run':
        return runRecommendation(body);

      case 'reports.draft':
        return draftReport(body);

      default:
        var err = new Error('목 라우터에 정의되지 않은 오퍼레이션입니다: ' + opId);
        err.status = 501;
        throw err;
    }
  }

  HW.mock = {
    handle: handle,
    /* 화면에서 직접 참조하는 상수들 */
    PERIODS: PERIODS,
    EFFECT: EFFECT,
    effectRadiusKm: effectRadiusKm,
    QUAD_LABEL: QUAD_LABEL
  };
})(window);
