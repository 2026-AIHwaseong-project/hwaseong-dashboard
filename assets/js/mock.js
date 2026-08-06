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
   * 0. 지도 좌표계 · 지형 (개략도)
   *    실서버에서는 이 부분이 GeoJSON 행정경계로 대체됩니다.
   * ==================================================================== */
  var VIEW_W = 960, VIEW_H = 640, PAD = 24;
  /* 화성시 대략 경위도 범위 — 목 데이터에 실데이터와 같은 모양의 lon/lat 를
     실어 보내기 위한 값입니다(실제 경계와 다름). */
  var BBOX = [126.62, 36.97, 127.17, 37.33];

  /* SVG px → 경위도 역투영 (core.project 의 역함수) */
  function toLonLat(x, y) {
    var lon0 = BBOX[0], lat0 = BBOX[1], lon1 = BBOX[2], lat1 = BBOX[3];
    var kx = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    var dx = (lon1 - lon0) * kx, dy = (lat1 - lat0);
    var innerW = VIEW_W - PAD * 2, innerH = VIEW_H - PAD * 2;
    var scale = Math.min(innerW / dx, innerH / dy);
    var offX = PAD + (innerW - dx * scale) / 2;
    var offY = PAD + (innerH - dy * scale) / 2;
    return {
      lon: +(lon0 + (x - offX) / scale / kx).toFixed(6),
      lat: +(lat1 - (y - offY) / scale).toFixed(6)
    };
  }

  var POLY = [[152, 96], [214, 84], [262, 96], [318, 84], [368, 96], [414, 78], [470, 92], [524, 76], [566, 92], [612, 78], [652, 98], [688, 92], [718, 118], [762, 128], [812, 152], [852, 186], [874, 226], [878, 272], [862, 312], [832, 340], [788, 352], [744, 342], [716, 356], [700, 384], [664, 398], [646, 430], [606, 422], [566, 452], [524, 438], [502, 470], [452, 472], [414, 500], [368, 492], [330, 520], [282, 540], [232, 526], [186, 542], [144, 522], [122, 484], [136, 444], [112, 412], [96, 372], [130, 352], [106, 320], [92, 292], [116, 262], [98, 232], [122, 202], [102, 172], [136, 142]];
  var ISLE = [[52, 306], [76, 296], [86, 316], [64, 334], [44, 326]];

  function inPoly(x, y, poly) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }

  /* 지도 라벨 — 순수 표시용 */
  var REGION_LABELS = [['동탄', 788, 262], ['병점', 622, 118], ['봉담', 497, 168], ['매송·비봉', 392, 108], ['새솔동', 196, 112],
  ['송산·마도', 262, 238], ['남양', 300, 250], ['서신', 142, 276], ['팔탄', 420, 318], ['정남', 524, 288], ['향남', 450, 396],
  ['양감', 558, 430], ['장안', 348, 458], ['우정', 250, 492], ['제부도', 64, 348]];
  var IND_MARKS = [['기아공장', 268, 466], ['제약산단', 512, 432], ['송산산단', 242, 192]];
  var NEIGHBORS = [['안산시', 218, 48], ['수원시', 592, 52], ['용인시', 892, 122], ['오산시', 772, 398], ['평택시', 492, 586]];

  /* ======================================================================
   * 1. 권역 정의 [이름, x, y, 반경, 수요밀도, 공급, 유형, 고령인구비]
   * ==================================================================== */
  var REG = [
    ['동탄1', 752, 195, 58, .95, .96, 'urban', .08],
    ['동탄2', 806, 292, 68, .97, .60, 'urbannew', .07],
    ['병점', 622, 132, 55, .85, .90, 'urban', .12],
    ['봉담', 498, 152, 55, .68, .58, 'urban', .11],
    ['매송·비봉', 392, 118, 46, .32, .34, 'rural', .21],
    ['새솔동', 198, 128, 42, .55, .30, 'urbannew', .06],
    ['송산·마도', 252, 204, 46, .34, .28, 'ind', .16],
    ['남양', 300, 262, 56, .58, .50, 'town', .15],
    ['서신', 148, 292, 46, .17, .14, 'tour', .28],
    ['팔탄', 420, 330, 46, .30, .30, 'rural', .20],
    ['정남', 522, 300, 44, .34, .36, 'rural', .19],
    ['향남', 452, 408, 56, .76, .48, 'town', .12],
    ['향남산단', 508, 432, 36, .38, .24, 'ind', .10],
    ['양감', 556, 442, 38, .20, .20, 'rural', .23],
    ['장안', 350, 468, 44, .24, .22, 'rural', .24],
    ['우정', 258, 470, 50, .48, .30, 'ind', .17],
    ['매향·궁평', 172, 482, 40, .15, .12, 'tour', .30]
  ].map(function (r) {
    return { n: r[0], x: r[1], y: r[2], r: r[3], p: r[4], s: r[5], t: r[6], e: r[7] };
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

  /* 잠재수요(0~1 정규화값) → 일 통행량 환산 계수. 시연용 가정값.
     실데이터 적용 시 실측 승하차 총량에 맞춰 보정해야 하는 값입니다. */
  var TRIP_COEF = 3200;

  /* ======================================================================
   * 2. 노선 · 정류장
   * ==================================================================== */
  var ROUTES = [
    { id: 'A', name: '간선 A · 병점–동탄2', type: 'trunk', pts: [[622, 132, '병점역'], [668, 162, '능동마을'], [716, 190, '반송동'], [752, 214, '동탄중앙'], [788, 240, '동탄역'], [804, 286, '동탄호수공원'], [786, 320, '동탄2남부']] },
    { id: 'B', name: '간선 B · 남양–병점', type: 'trunk', pts: [[300, 262, '남양시청'], [342, 236, '신남리'], [386, 210, '비봉'], [430, 186, '수영리'], [474, 166, '봉담읍'], [548, 146, '와우리'], [622, 132, '병점역']] },
    { id: 'C', name: '간선 C · 발안–동탄', type: 'trunk', pts: [[452, 408, '발안터미널'], [494, 382, '향남2지구'], [538, 352, '정남면'], [586, 324, '보통리'], [638, 296, '방교동'], [694, 268, '영천동'], [742, 248, '동탄남부'], [788, 240, '동탄역']] },
    { id: 'D', name: '지선 D · 새솔–남양', type: 'branch', pts: [[198, 128, '새솔동'], [222, 166, '송산그린시티'], [248, 204, '마도산단'], [274, 234, '마도면'], [300, 262, '남양시청']] },
    { id: 'E', name: '지선 E · 조암–발안', type: 'branch', pts: [[258, 468, '기아공장'], [296, 456, '조암터미널'], [340, 444, '장안면'], [400, 426, '향남산단'], [452, 408, '발안터미널']] }
  ];
  var STOP_KIND = {
    '병점역': 'hub', '동탄역': 'hub', '발안터미널': 'hub', '조암터미널': 'hub', '남양시청': 'hub',
    '기아공장': 'ind', '향남산단': 'ind', '마도산단': 'ind',
    '능동마을': 'res', '반송동': 'res', '동탄중앙': 'res', '동탄호수공원': 'res', '동탄2남부': 'res',
    '봉담읍': 'res', '향남2지구': 'res', '새솔동': 'res', '송산그린시티': 'res'
  };

  var STOPS = {}, STOP_LIST = [];
  ROUTES.forEach(function (rt) {
    rt.stopIds = [];
    rt.pts.forEach(function (p) {
      var name = p[2];
      if (!STOPS[name]) {
        var ll = toLonLat(p[0], p[1]);
        STOPS[name] = {
          id: 'S-' + String(STOP_LIST.length + 1).padStart(3, '0'),
          name: name, x: p[0], y: p[1], lon: ll.lon, lat: ll.lat,
          kind: STOP_KIND[name] || 'rural', routes: []
        };
        STOP_LIST.push(STOPS[name]);
      }
      if (STOPS[name].routes.indexOf(rt.id) < 0) STOPS[name].routes.push(rt.id);
      rt.stopIds.push(STOPS[name].id);
    });
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
   * 3. 격자 생성
   *    표시 격자는 약 1km. 실구현에서는 250m 격자(SGIS)를 씁니다.
   * ==================================================================== */
  var STEP = 26;
  var CELLS = [];
  (function buildCells() {
    var i = 0;
    for (var gy = 64; gy < 616; gy += STEP) {
      for (var gx = 84; gx < 912; gx += STEP) {
        var cx = gx + 12, cy = gy + 12;
        if (!inPoly(cx, cy, POLY)) continue;
        var byT = {}, byTs = {}, rnd = mulberry32(i * 7 + 3);
        var e = 0, wsum = 0, popw = 0, best = null, bw = 0;
        REG.forEach(function (r) {
          var d = Math.hypot(cx - r.x, cy - r.y);
          var w = Math.exp(-(d * d) / (r.r * r.r));
          if (w < 1e-4) return;
          byT[r.t] = (byT[r.t] || 0) + w * r.p;
          byTs[r.t] = (byTs[r.t] || 0) + w * r.s;
          e += w * r.e; wsum += w; popw += w * r.p;
          if (w > bw) { bw = w; best = r; }
        });
        var dmin = 1e9, nearest = null;
        STOP_LIST.forEach(function (s) {
          var d = Math.hypot(cx - s.x, cy - s.y);
          if (d < dmin) { dmin = d; nearest = s; }
        });
        var dir = '중심';
        if (best) {
          var dx = cx - best.x, dy = cy - best.y;
          if (Math.abs(dx) > Math.abs(dy)) { if (dx > 14) dir = '동부'; else if (dx < -14) dir = '서부'; }
          else { if (dy > 14) dir = '남부'; else if (dy < -14) dir = '북부'; }
        }
        var ll = toLonLat(cx, cy);
        CELLS.push({
          idx: i, id: 'G-' + (100 + i),
          x: gx, y: gy, cx: cx, cy: cy, size: 24,
          lon: ll.lon, lat: ll.lat,
          region: best ? best.n : '외곽', dir: dir,
          name: (best ? best.n : '외곽') + ' ' + dir,
          byT: byT, byTs: byTs,
          elderlyRatio: wsum ? e / wsum : .2,
          popWeight: popw,
          coverage: clamp(1 - dmin / 95, .05, 1),
          nearestStopId: nearest ? nearest.id : null,
          nearestStopName: nearest ? nearest.name : null,
          nP: .92 + rnd() * .16, nS: .92 + rnd() * .16, nF: .92 + rnd() * .16,
          covAdj: 0, supAdj: 0
        });
        i++;
      }
    }
  })();
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

      var quad = zD.map(function (v, i) {
        var d = v, s = zS[i];
        if (d >= .2 && MI[i] >= .55) return 'need';
        if (d <= -.3 && s >= .3) return 'over';
        if (d <= -.35 && s <= -.35 && nf[i] >= K.fRef) return 'drt';
        if (d >= .25 && s >= .25) return 'ok';
        return 'mid';
      });
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
   *    좌표는 SVG px. 축척바 기준 120px ≈ 5km 이므로 1px ≈ 41.7m.
   *    파급 계수는 시연용 가정값 — 실데이터에서는 실측 승하차로 보정해야 합니다.
   * ==================================================================== */
  var PX_M = 5000 / 120;
  var EFFECT = {
    stop: {
      label: '정류장 신설', icon: '●', radiusPx: 45,
      apply: function (c, d) { var k = 1 - d / 45; c.covAdj += .34 * k; c.supAdj += .05 * k; }
    },
    /* 똑버스는 문전 서비스라 범위는 넓되 효과는 얕게. 한 대로 권역이 통째로 해결되면 안 됩니다. */
    drt: {
      label: '똑버스 배치', icon: '◆', radiusPx: 72,
      apply: function (c, d) { c.supAdj += .13 * (1 - d / 72); }
    },
    freq: {
      label: '배차 증편', icon: '▲', radiusPx: 52,
      apply: function (c, d) { c.supAdj += (d < STEP ? .20 : .09); },
      guard: function (c) { return c.coverage >= .5; },
      guardMsg: '배차 증편은 기존 정류장이 가까운 격자에만 적용할 수 있습니다.'
    }
  };
  function effectRadiusKm(type) {
    return Math.round(EFFECT[type].radiusPx * PX_M / 100) / 10;
  }

  function applyPlacements(placements) {
    CELLS.forEach(function (c) { c.covAdj = 0; c.supAdj = 0; });
    (placements || []).forEach(function (p) {
      var e = EFFECT[p.type];
      if (!e) return;
      var target = CELLS.filter(function (c) { return c.id === p.cellId; })[0];
      if (!target) return;
      var mult = Math.max(1, p.count || 1);
      CELLS.forEach(function (c) {
        var d = Math.hypot(c.cx - target.cx, c.cy - target.cy);
        if (d < e.radiusPx) {
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
        x: c.x, y: c.y, size: c.size,
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
    var COST = CONFIG.COST, breakdown = {}, total = 0;
    (placements || []).forEach(function (p) {
      var unit = COST[p.type] || 0;
      var n = Math.max(1, p.count || 1);
      breakdown[p.type] = (breakdown[p.type] || 0) + unit * n;
      total += unit * n;
    });
    return {
      totalKrw: total,
      breakdown: Object.keys(breakdown).map(function (k) {
        return { type: k, label: EFFECT[k] ? EFFECT[k].label : k, unitKrw: CONFIG.COST[k] || 0, amountKrw: breakdown[k] };
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
          unitKrw: CONFIG.COST[p.type] || 0
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
    if (sim && sim.placements.length) {
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
    if (sim && simPeriod) {
      var dn = simPeriod.delta.needCells, dt = simPeriod.delta.potentialTripsPerDay;
      effBody = '시뮬레이션 결과 ' + P.name + '시간대 고수요·저공급 격자는 ' +
        f(simPeriod.baseline.needCells) + '개에서 ' + f(simPeriod.kpi.needCells) + '개로 ' +
        (dn < 0 ? f(-dn) + '개 감소' : dn > 0 ? f(dn) + '개 증가' : '변동 없음') + '하였다.\n' +
        '사각지대 잠재수요는 일 ' + f(simPeriod.baseline.potentialTripsPerDay) + '통행에서 ' +
        f(simPeriod.kpi.potentialTripsPerDay) + '통행으로 ' +
        (dt < 0 ? f(-dt) + '통행 해소' : '변동 없음') + '되는 것으로 추정된다.';
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

    if (sim) {
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

    return {
      title: CONFIG.APP.org + ' 대중교통 수급 불일치 분석 및 노선 조정 검토(안)',
      subtitle: P.name + ' 시간대(' + P.label + ') 기준' + (sim ? ' · 시나리오 「' + sim.name + '」' : ''),
      org: CONFIG.APP.org,
      dept: CONFIG.APP.dept,
      period: pid,
      generatedAt: C.nowStamp(),
      model: 'mock-template',      // 실서버에서는 'claude-opus-5'
      sections: sections,
      tables: tables,
      disclaimer: CONFIG.APP.isMockData
        ? '본 문서의 모든 수치는 로직 시연을 위한 가상 예시 데이터에 기반합니다. 실제 지리·운행 정보와 다르며, 정책 판단의 근거로 사용할 수 없습니다.'
        : '본 문서는 자동 생성된 초안입니다. 담당자 검토 후 활용하시기 바랍니다.'
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
          region: CONFIG.APP.org,
          updatedAt: C.todayISO(),
          isMockData: true,
          periods: PERIODS.map(function (p) {
            return { id: p.id, name: p.name, label: p.label, hours: p.hours };
          }),
          grid: { sizeMeters: 250, displaySizeMeters: 1000, crs: 'EPSG:4326', bbox: BBOX, cellCount: N },
          map: {
            viewBox: [0, 0, VIEW_W, VIEW_H],
            boundary: POLY, islands: [ISLE],
            labels: { regions: REGION_LABELS, industrial: IND_MARKS, neighbors: NEIGHBORS },
            scaleBar: { px: 120, meters: 5000 }
          },
          cost: CONFIG.COST,
          formula: {
            demand: 'D = 0.5·norm(교통카드 승하차) + 0.5·norm(통신 유동인구)',
            supply: 'S = 0.78·norm(운행빈도) + 0.22·정류장 커버리지 + 배치효과',
            mismatch: 'MI = z(D) − z(S), 수요가중 감쇠 적용',
            priority: '우선순위 = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)'
          },
          effects: Object.keys(EFFECT).map(function (k) {
            return { type: k, label: EFFECT[k].label, icon: EFFECT[k].icon, radiusKm: effectRadiusKm(k), unitKrw: CONFIG.COST[k] };
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
            return { id: s.id, name: s.name, lon: s.lon, lat: s.lat, x: s.x, y: s.y, kind: s.kind, routes: s.routes.slice() };
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
              pathXY: r.pts.map(function (p) { return [p[0], p[1]]; }),
              path: r.pts.map(function (p) { var ll = toLonLat(p[0], p[1]); return [ll.lon, ll.lat]; })
            };
          })
        };

      case 'priorities.list':
        return { period: PERIODS[t].id, items: serializePriorities(d, Number(params.limit) || 10) };

      case 'simulations.run':
        return runSimulation(body);

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
