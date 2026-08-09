/* ============================================================================
 *  config.js  —  ⚠️ 백엔드 연동 시 여기만 고치면 됩니다.
 * ----------------------------------------------------------------------------
 *  프론트엔드의 모든 서버 통신은 assets/js/api.js 한 곳을 지나갑니다.
 *  api.js 는 아래 USE_MOCK 값을 보고
 *      USE_MOCK = true   → assets/js/mock.js 의 가짜 데이터를 돌려주고
 *      USE_MOCK = false  → BASE_URL 로 실제 HTTP 요청을 보냅니다.
 *
 *  ▶ 백엔드 연동 순서
 *     1) docs/API.md 의 엔드포인트를 구현한다.
 *     2) 아래 BASE_URL 을 서버 주소로 바꾼다. (예: 'http://localhost:8000')
 *     3) USE_MOCK 을 false 로 바꾼다.
 *     4) 끝. 프론트엔드 코드는 한 줄도 고칠 필요가 없습니다.
 *
 *  ▶ 일부만 실서버로 붙이고 싶을 때
 *     ENDPOINT_OVERRIDES 에 경로별로 true/false 를 지정하면
 *     그 경로만 목/실서버를 따로 쓸 수 있습니다. 점진적 연동용입니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ====================================================================
   * ★ 백엔드 서버 주소 — 배포·시연 때 여기 한 줄만 바꾸면 됩니다.
   *
   *   SERVER_URL = ''                              → 자동 결정 (아래 규칙)
   *   SERVER_URL = 'https://xxxx.ngrok-free.app'   → ngrok 등 터널 주소
   *   SERVER_URL = 'http://192.168.0.10:8000'      → 다른 PC 의 백엔드
   *
   *   자동 결정 규칙(빈 문자열일 때):
   *     - file:// 로 열었을 때              → http://localhost:8000
   *     - 백엔드가 직접 서빙(/app)했을 때    → 같은 원점 (포트 그대로)
   *     - 개발 서버(예: :5500)로 서빙했을 때 → 같은 호스트의 :8000
   *
   *   ⚠️ ngrok 무료 터널은 주소가 재시작마다 바뀝니다. 시연 직전에 갱신하세요.
   * ================================================================== */
  var SERVER_URL = 'https://581f-218-145-154-236.ngrok-free.app';

  var CONFIG = {

    /* ------------------------------------------------------------------
     * [1] 서버 주소
     *   위의 SERVER_URL 이 우선합니다. 비워 두면 자동 결정.
     * ---------------------------------------------------------------- */
    BASE_URL: SERVER_URL || (function () {
      try {
        if (location.protocol === 'file:') return 'http://localhost:8000';
        /* 8000 이거나 포트 표기가 없으면(80/443 — 터널·배포) 백엔드가 직접
           서빙 중인 것으로 보고 같은 원점을 씁니다. 그 외(개발 서버)는 :8000. */
        if (location.port === '8000' || !location.port) return '';
        return location.protocol + '//' + location.hostname + ':8000';
      } catch (e) { return 'http://localhost:8000'; }
    })(),

    /* ------------------------------------------------------------------
     * [1-2] 추가 요청 헤더
     *   ngrok 무료 터널은 브라우저 요청 앞에 경고 페이지(HTML)를 끼워 넣어
     *   JSON 파싱이 깨집니다. 이 헤더가 있으면 경고 없이 바로 통과합니다.
     * ---------------------------------------------------------------- */
    EXTRA_HEADERS: /ngrok/.test(SERVER_URL)
      ? { 'ngrok-skip-browser-warning': 'true' }
      : {},

    /* API 경로 접두사. 백엔드 라우팅에 맞춰 바꾸세요. */
    API_PREFIX: '/api/v1',

    /* ------------------------------------------------------------------
     * [2] 목 데이터 사용 여부
     *   true  → 서버 없이 브라우저 안에서 가짜 데이터를 만들어 씁니다(현재 상태).
     *   false → 실제 서버에 HTTP 요청을 보냅니다.
     * ---------------------------------------------------------------- */
    USE_MOCK: false,

    /* ------------------------------------------------------------------
     * [3] 경로별 개별 전환 (점진적 연동용)
     *   키는 docs/API.md 의 오퍼레이션 ID 입니다.
     *   값 true = 목 사용, false = 실서버 사용, 없으면 위의 USE_MOCK 을 따름.
     *   예) 격자 API 만 먼저 붙였다면:  { 'grid.list': false }
     * ---------------------------------------------------------------- */
    ENDPOINT_OVERRIDES: {
      // 'meta.get':          false,
      // 'grid.list':         false,
      // 'stops.list':        false,
      // 'stops.profile':     false,
      // 'routes.list':       false,
      // 'priorities.list':   false,
      // 'simulations.run':   false,
      // 'reports.draft':     false,
      // 'reports.export':    false,
    },

    /* ------------------------------------------------------------------
     * [4] 인증
     *   백엔드가 토큰을 요구하면 여기에 설정합니다.
     *   getToken 은 함수여도 됩니다(로그인 후 동적으로 읽을 때).
     * ---------------------------------------------------------------- */
    AUTH: {
      enabled: false,
      header: 'Authorization',
      scheme: 'Bearer',
      getToken: function () {
        // 예) return localStorage.getItem('accessToken');
        return '';
      }
    },

    /* 요청 타임아웃(ms). AI 보고서 생성은 오래 걸리므로 따로 둡니다. */
    TIMEOUT_MS: 15000,
    TIMEOUT_MS_REPORT: 120000,

    /* 목 모드에서 일부러 주는 지연(ms). 로딩 UI 확인용. 0 이면 즉시 응답. */
    MOCK_LATENCY_MS: 120,

    /* ------------------------------------------------------------------
     * [5] 보고서 내보내기 방식
     *   'client' → 브라우저에서 직접 파일을 만듭니다. (서버 없이 동작, 기본값)
     *   'server' → POST {API_PREFIX}/reports/export 로 파일을 받아옵니다.
     *              한글 .hwpx 원본 포맷이 필요하면 서버 방식을 쓰세요.
     *   'auto'   → 서버를 먼저 시도하고, 실패하면 클라이언트로 폴백합니다.
     * ---------------------------------------------------------------- */
    EXPORT_MODE: 'client',

    /* ------------------------------------------------------------------
     * [6] 화면 파일 경로
     *   상단 내비게이션과 화면 간 이동 링크가 이 값을 씁니다.
     *   파일명을 바꾸거나 단일 파일로 묶을 때 여기만 고치면 됩니다.
     * ---------------------------------------------------------------- */
    PAGES: {
      dashboard: 'index.html',
      simulation: 'simulation.html'
    },

    /* ------------------------------------------------------------------
     * [7] 화면 표기용 메타
     * ---------------------------------------------------------------- */
    APP: {
      name: '화성시 버스 수요·공급 미스매칭 대시보드',
      shortName: 'HWASEONG BUS GAP',
      org: '화성시',
      dept: '교통정책과',
      /* 데이터가 가상인지 실제인지 화면에 표시합니다.
         실데이터로 전환하면 false 로 바꾸세요. 배지와 면책 문구가 사라집니다. */
      isMockData: false
    },

    /* ------------------------------------------------------------------
     * [8] 격자 정의
     *   분석 격자와 화면 표시 격자는 다릅니다. 혼동을 막기 위해 나눠 둡니다.
     *   - analysis* : 실제 분석에 쓰는 격자 (SGIS 배포판 기준)
     *   - display*  : 지도에 그리는 격자. 분석 격자를 묶어 보여 줍니다.
     *   화면 격자를 분석 격자와 같게 하려면 displaySizeMeters 를 1000 으로.
     * ---------------------------------------------------------------- */
    GRID: {
      analysisSizeMeters: 1000,   // SGIS 공공데이터포털 배포판이 1km 격자만 제공
      analysisCellCount: 786,     // 화성시 1km 격자 수 (백엔드 05_load 실측)
      displaySizeMeters: 1500     // 지도 표시 격자
    },

    /* ------------------------------------------------------------------
     * [9] 시뮬레이션 단가
     *   ⚠️ 전부 시연용 가정값입니다. confirmed 를 true 로 바꾸기 전까지
     *      화면과 보고서에 "가정값" 표시가 자동으로 붙습니다.
     *
     *   basis 가 비용의 성격을 나타냅니다. 이게 다르면 그냥 비교하면 안 됩니다.
     *     'capital'   1회성 자본비. lifeYears 로 나눠야 연간 비용이 됩니다.
     *     'operating' 연간 운영비. 매년 발생하므로 나누면 안 됩니다.
     * ---------------------------------------------------------------- */
    COST: {
      stop: {
        krw: 42000000, basis: 'capital', lifeYears: 10,
        annualMaintenanceKrw: 1000000,
        label: '정류장 신설 1개소',
        note: '승차대·정보안내기 설치비. 유지관리비는 별도 연 100만 원 가정.',
        source: '가정값 — 실제 사업비 미확정', confirmed: false
      },
      drt: {
        krw: 180000000, basis: 'operating', lifeYears: 1,
        label: '똑버스 1대 연간 운영비',
        note: '기사 인건비·연료·정비·관제 포함 가정. 차량 구매비는 미포함.',
        source: '가정값 — 실제 사업비 미확정', confirmed: false
      },
      freq: {
        krw: 95000000, basis: 'operating', lifeYears: 1,
        label: '배차 증편 (노선 1개 · 1일 4회) 연간',
        note: '운전기사 추가 인건비와 연료비 가정.',
        source: '가정값 — 실제 사업비 미확정', confirmed: false
      },
      defaultBudget: 3000000000,  // 기본 예산 한도 30억 원

      /* 추천 순위를 매길 때 무엇을 '비용'으로 볼 것인가.
       *
       *   'total'  — 총사업비 (기본값)
       *   'annual' — 연환산 비용 (자본비는 lifeYears 로 나눔)
       *
       * 총사업비를 기본으로 두는 이유:
       *   ① 예산 한도(defaultBudget)와 화면 입력칸이 모두 총액입니다.
       *      순위만 연환산으로 매기면 재는 자와 자르는 자가 달라집니다.
       *   ② 공무원이 실제로 묻는 것은 "이번 예산 30억으로 무엇을 살 수 있나"입니다.
       *   ③ 내용연수 가정이 필요 없습니다. 가정이 하나 줄면 반박 지점도 하나 줍니다.
       *
       * 한계 — 총사업비는 1년차 관점입니다. 똑버스·증편은 이듬해에도 같은 돈이
       * 다시 들어가지만 정류장은 한 번뿐입니다. 다년도 사업비로 비교하려면
       * 'annual' 로 바꾸고 COST[].lifeYears 를 실제 값으로 채우세요.
       * 기준별 결과 차이는 docs/API.md §3.7 에 기록해 두었습니다. */
      compareBasis: 'total'
    }
  };

  /* ------------------------------------------------------------------
   * 단가 조회 헬퍼
   *   COST 항목이 객체가 되면서, 금액만 필요한 곳에서 쓰라고 만든 함수입니다.
   * ---------------------------------------------------------------- */
  CONFIG.costKrw = function (type) {
    var c = CONFIG.COST[type];
    return (c && typeof c.krw === 'number') ? c.krw : 0;
  };
  CONFIG.costMeta = function (type) {
    return CONFIG.COST[type] || null;
  };
  /** 단가 중 하나라도 미확정이면 true — 화면에 "가정값" 표시를 붙입니다 */
  CONFIG.costIsAssumed = function () {
    return ['stop', 'drt', 'freq'].some(function (t) {
      var c = CONFIG.COST[t];
      return c && c.confirmed === false;
    });
  };

  /* API 전체 URL 조합 */
  CONFIG.url = function (path) {
    var base = (CONFIG.BASE_URL || '').replace(/\/+$/, '');
    var pre = (CONFIG.API_PREFIX || '').replace(/\/+$/, '');
    var p = path.charAt(0) === '/' ? path : '/' + path;
    return base + pre + p;
  };

  /* 해당 오퍼레이션이 목을 써야 하는지 판단 */
  CONFIG.useMock = function (opId) {
    var o = CONFIG.ENDPOINT_OVERRIDES;
    if (o && Object.prototype.hasOwnProperty.call(o, opId)) return !!o[opId];
    return !!CONFIG.USE_MOCK;
  };

  global.HW = global.HW || {};
  global.HW.CONFIG = CONFIG;
})(window);
