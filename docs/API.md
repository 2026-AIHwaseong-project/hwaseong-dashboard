# 백엔드 연동 규격서

화성시 버스 수요·공급 미스매칭 대시보드 — 프론트엔드 ↔ 백엔드 API 계약

> **이 문서 한 장이면 백엔드 연동이 끝납니다.**
> 아래 9개 엔드포인트를 구현하고 `assets/js/config.js` 의 값 두 개만 바꾸면 됩니다.
> 프론트엔드 코드는 한 줄도 수정할 필요가 없습니다.

---

## 0. 3단계 연동 절차

```
1) 이 문서의 엔드포인트를 구현한다
2) assets/js/config.js 를 연다
     BASE_URL : ''  →  'http://localhost:8000'   (백엔드 주소)
     USE_MOCK : true →  false
3) 브라우저 새로고침 — 끝
```

**점진적 연동**도 가능합니다. 격자 API만 먼저 붙였다면:

```js
ENDPOINT_OVERRIDES: { 'grid.list': false }   // 이 경로만 실서버, 나머지는 목
```

**목 데이터가 곧 규격입니다.** 응답 형태가 헷갈리면 `assets/js/mock.js` 의
해당 함수가 무엇을 돌려주는지 보면 됩니다. 브라우저 콘솔에서 바로 확인할 수도 있습니다.

```js
HW.mock.handle('grid.list', { period: 'am' })      // 격자 응답 예시
HW.mock.handle('priorities.list', { period:'am' }) // 우선순위 응답 예시
```

---

## 1. 공통 규칙

| 항목 | 값 |
|---|---|
| 기본 경로 | `{BASE_URL}/api/v1` (`API_PREFIX` 로 변경 가능) |
| 요청/응답 형식 | `application/json`, UTF-8 |
| 인증 | 기본 없음. 필요하면 `config.js` 의 `AUTH` 활성화 → `Authorization: Bearer <token>` |
| 타임아웃 | 일반 15초 / 보고서 120초 |

### CORS

프론트엔드를 백엔드와 다른 포트에서 열면 CORS 허용이 필요합니다.

```python
# FastAPI 예시
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware,
    allow_origins=["http://localhost:5500", "http://127.0.0.1:5500"],
    allow_methods=["GET", "POST"], allow_headers=["*"])
```

### 오류 응답

HTTP 상태 코드 + 아래 형태 중 아무거나. 프론트엔드는 `message` / `detail` / `error` 순으로 찾아 표시합니다.

```json
{ "message": "period 파라미터가 올바르지 않습니다", "code": "INVALID_PERIOD" }
```

---

## 2. 엔드포인트 목록

| # | 오퍼레이션 ID | 메서드 | 경로 | 용도 | 우선순위 |
|---|---|---|---|---|---|
| 1 | `meta.get` | GET | `/meta` | 시간대·지도경계·단가·산식 | **필수** |
| 2 | `grid.list` | GET | `/grid?period=` | 격자별 수요/공급/MI + KPI | **필수** |
| 3 | `priorities.list` | GET | `/priorities?period=&limit=` | 노선 조정 우선순위 | **필수** |
| 4 | `stops.list` | GET | `/stops` | 정류장 목록 | 필수 |
| 5 | `routes.list` | GET | `/routes` | 노선 목록 | 필수 |
| 6 | `stops.profile` | GET | `/stops/{stopId}/profile` | 정류장 시간대별 승하차 | 필수 |
| 7 | `simulations.run` | POST | `/simulations` | 배치 시뮬레이션 | **필수**(시뮬레이션 화면) |
| 8 | `recommendations.run` | POST | `/recommendations` | 추천 배치안 산출 | **필수**(추천 기능) |
| 9 | `reports.draft` | POST | `/reports/draft` | AI 보고서 초안 생성 | **필수**(보고서 기능) |
| 10 | `reports.export` | POST | `/reports/export` | 서버측 파일 생성(.hwpx) | 선택 |

> 9번은 선택입니다. 구현하지 않으면 프론트엔드가 브라우저에서 직접
> `.xlsx` / `.rtf` 를 만듭니다(현재 기본 동작). 한글 원본 포맷 `.hwpx` 가
> 필요할 때만 구현하세요.

---

## 3. 엔드포인트 상세

### 3.1 `GET /meta` — 화면 구성 메타

한 번만 호출되며 캐시됩니다. 지도 경계, 시간대 정의, 배치 수단 단가가 들어갑니다.

```jsonc
{
  "region": "화성시",
  "updatedAt": "2026-08-07",
  "isMockData": true,
  "periods": [
    { "id": "am",    "name": "출근", "label": "07–09", "hours": [7, 9] },
    { "id": "day",   "name": "낮",   "label": "09–17", "hours": [9, 17] },
    { "id": "pm",    "name": "퇴근", "label": "17–19", "hours": [17, 19] },
    { "id": "night", "name": "심야", "label": "22–24", "hours": [22, 24] }
  ],
  "grid": {
    "sizeMeters": 1000,            // 분석 격자. SGIS 공공데이터포털 배포판이 1km 만 제공
    "analysisCellCount": 850,      // 화성시 1km 격자 수
    "displaySizeMeters": 1500,     // 화면 표시 격자 (분석 격자를 묶어 그림)
    "cellCount": 353,              // ★ /grid 의 cells 길이와 반드시 같아야 함
    "crs": "EPSG:4326",
    "bbox": [126.52923, 37.00909, 127.1613, 37.30279]
  },
  "dataQuality": {                 // 무엇이 실측이고 무엇이 추정인지
    "boardingDaily":  { "level": "observed",  "label": "일별 승하차",
                        "source": "교통카드빅데이터(STCIS)" },
    "boardingHourly": { "level": "estimated", "label": "시간대별 승하차",
                        "method": "일자별 승하차를 통신 유동인구 시간배율로 안분",
                        "note": "원자료에 시간대 정보가 없습니다." },
    "flowHourly":     { "level": "observed",  "label": "시간대별 유동인구",
                        "source": "통신사 유동인구" },
    "boundary":       { "level": "observed",  "label": "행정경계", "source": "SGIS 읍면동 경계" }
  },
  "map": {
    "viewBox": [0, 0, 960, 640],
    "boundarySource": "SGIS 통계지리정보서비스 읍면동 경계 (bnd_dong_00_2025_2Q)",
    "regions": [
      {
        "code": "31240130", "name": "우정읍", "kind": "읍",
        "centroid": [126.80819, 37.04512],
        "bbox": [126.75, 37.00, 126.87, 37.09],
        "rings": [ [[126.80, 37.01], [126.81, 37.02], "… 경위도 폴리곤 …"] ]
      }
      // … 4읍 9면 16동 = 29개
    ],
    "scaleBar": { "km": 5 }
  },
  "cost": {
    // basis 가 비용의 성격입니다. 다르면 그냥 비교하면 안 됩니다.
    //   capital   : 1회성 자본비. lifeYears 로 나눠야 연간 비용이 됩니다.
    //   operating : 연간 운영비. 매년 발생하므로 나누면 안 됩니다.
    "stop": { "krw": 42000000, "basis": "capital", "lifeYears": 10,
              "annualMaintenanceKrw": 1000000,
              "label": "정류장 신설 1개소",
              "source": "가정값 — 실제 사업비 미확정", "confirmed": false },
    "drt":  { "krw": 180000000, "basis": "operating", "lifeYears": 1,
              "label": "똑버스 1대 연간 운영비",
              "source": "가정값 — 실제 사업비 미확정", "confirmed": false },
    "freq": { "krw": 95000000, "basis": "operating", "lifeYears": 1,
              "label": "배차 증편 (노선 1개 · 1일 4회) 연간",
              "source": "가정값 — 실제 사업비 미확정", "confirmed": false },
    "defaultBudget": 3000000000
  },
  "formula": {
    "demand":    "D = 0.5·norm(교통카드 승하차) + 0.5·norm(통신 유동인구)",
    "supply":    "S = 0.78·norm(운행빈도) + 0.22·정류장 커버리지 + 배치효과",
    "mismatch":  "MI = z(D) − z(S), 수요가중 감쇠 적용",
    "priority":  "우선순위 = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)"
  },
  "effects": [
    { "type": "stop", "label": "정류장 신설", "icon": "●", "radiusKm": 2.0,
      "unitKrw": 42000000, "costBasis": "capital",
      "costBasisLabel": "1회성 자본비(내용연수 10년)", "costAssumed": true },
    { "type": "drt",  "label": "똑버스 배치", "icon": "◆", "radiusKm": 3.0,
      "unitKrw": 180000000, "costBasis": "operating",
      "costBasisLabel": "연간 운영비", "costAssumed": true },
    { "type": "freq", "label": "배차 증편",   "icon": "▲", "radiusKm": 2.4,
      "unitKrw": 95000000, "costBasis": "operating",
      "costBasisLabel": "연간 운영비", "costAssumed": true }
  ]
}
```

#### 지도 좌표 — 전부 경위도입니다

`map.regions[].rings` 와 `centroid` 는 **경위도(EPSG:4326)** 이고, 화면 투영은
프론트엔드(`assets/js/core.js` 의 `project()`)가 `grid.bbox` 기준으로 처리합니다.
서버는 SVG 좌표를 계산할 필요가 없습니다.

**현재 목 데이터의 경계는 실제 SGIS 읍면동 경계입니다.** 실서버에서도 같은 출처를
쓰면 되고, 원본 SHP → 이 형식으로 변환하는 스크립트가 `tools/build-boundary.py` 에
있습니다(좌표 단순화 포함, 63,204점 → 5,759점).

> 격자를 어느 읍면동에 넣을지는 **점-다각형 판정**으로 서버가 결정해
> `cells[].region` / `regionCode` 에 실어 보냅니다.

---

### 3.2 `GET /grid?period=am` — 격자 + KPI

지도·산점도·표의 원천 데이터입니다. **가장 중요한 엔드포인트**입니다.

```json
{
  "period": "am",
  "scale": { "miThresholds": [-1.5, -0.75, -0.25, 0.25, 0.75, 1.5], "tripCoef": 3200 },
  "kpi": {
    "needCells": 28, "drtCells": 32, "overCells": 2, "totalCells": 353,
    "needShare": 7.9, "potentialTripsPerDay": 45471,
    "elderlyTripsPerDay": 4842, "avgMi": 0.005
  },
  "cells": [
    {
      "id": "G-100",
      "name": "우정읍 남부",
      "region": "우정읍",
      "regionCode": "31240130",
      "regionKind": "읍",
      "lon": 126.80819, "lat": 37.01587,
      "x": 415.1, "y": 590.2, "w": 22.8, "h": 23.0,
      "demand": 31, "supply": 28,
      "zDemand": 0.056, "zSupply": -0.129,
      "mi": 0.185,
      "flow": 0.3445, "flowTripsPerDay": 1102,
      "elderlyRatio": 0.06,
      "coverage": 0.628,
      "quadrant": "mid", "quadrantLabel": "균형권",
      "action": "ADD_FREQ", "actionLabel": "증차",
      "priorityScore": 0,
      "nearestStopId": "S-021",
      "adjusted": false,
      "bins": { "mi": 3, "demand": 3, "supply": 2, "flow": 3 }
    }
  ]
}
```

#### 셀 필드 명세

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 격자 고유 ID. 시뮬레이션 요청에서 이 값을 씁니다 |
| `name` / `region` / `direction` | string | 화면 표기용 이름 |
| `lon` / `lat` | number | 격자 중심 경위도 |
| `regionCode` / `regionKind` | string | 행정동 코드와 읍/면/동 구분 |
| `x` / `y` / `w` / `h` | number | SVG 좌표·크기(선택). 없으면 `lon/lat` 로 자동 투영 |
| `demand` / `supply` | number | 0~100 정규화 지수 (화면 표시용) |
| `zDemand` / `zSupply` | number | 표준화값. **산점도 축이 이 값입니다** |
| `mi` | number | 미스매칭 지수. `-2.6 ~ +2.6` 로 클리핑 |
| `flow` | number | 0~1 정규화 유동인구 |
| `flowTripsPerDay` | number | 일 통행량 환산값 |
| `elderlyRatio` | number | 0~1 고령인구 비율 |
| `coverage` | number | 0~1 정류장 접근성. **수단별 적용 제약의 기준** (§3.7 참고) |
| `nearestStopId` | string | `/stops` 의 `id` 와 같은 형식이어야 합니다 |
| `quadrant` | enum | `need` / `over` / `drt` / `ok` / `mid` |
| `action` | enum | `NEW_STOP` / `ADD_FREQ` / `DRT` |
| `priorityScore` | number | 우선순위 점수. `need` 가 아니면 0 |
| `adjusted` | boolean | 시뮬레이션 배치 효과가 반영된 셀인지 |
| **`bins`** | object | **채색 등급.** 아래 참고 |

#### `bins` — 서버가 등급까지 계산해야 하는 이유

지도 채색은 `bins` 값으로만 결정됩니다. 프론트엔드는 임계값을 모릅니다.

- `bins.mi` : **0~6** (7단계 발산형). `scale.miThresholds` 로 구간을 나눔
  - `0~2` = 공급 여유(파랑), `3` = 균형(중립), `4~6` = 공급 부족(빨강)
- `bins.demand` / `bins.supply` / `bins.flow` : **0~4** (5분위)

> **주의: 분위 기준은 "배치 없음" 상태에서 한 번 고정하고 재사용하세요.**
> 시간대마다 또는 시뮬레이션마다 다시 잡으면 전후 비교가 서로 다른 자로 재는 셈이 됩니다.
> 목 구현은 `mock.js` 의 `NORM` 변수가 이 역할을 합니다.

#### 사분면(`quadrant`) 판정 기준 (목 구현 기준)

```
need : zD ≥  0.20  AND  MI ≥ 0.55            → 고수요·저공급 (증차/신설)
over : zD ≤ -0.30  AND  zS ≥ 0.30            → 저수요·고공급 (효율화)
drt  : zD ≤ -0.35  AND  zS ≤ -0.35  AND 유동인구 ≥ 30분위 → 수요응답형
ok   : zD ≥  0.25  AND  zS ≥ 0.25            → 적정
mid  : 그 외                                   → 균형권
```

---

### 3.3 `GET /priorities?period=am&limit=10` — 우선순위

```json
{
  "period": "am",
  "items": [
    {
      "rank": 1,
      "cellId": "G-453",
      "name": "향남산단 중심",
      "mi": 1.02,
      "priorityScore": 1.1398,
      "demand": 72, "supply": 44,
      "flowTripsPerDay": 2558,
      "elderlyRatio": 0.127,
      "coverage": 0.361,
      "action": "NEW_STOP", "actionLabel": "신설",
      "nearestStopId": "S-015",
      "reason": "수요지수 72 대비 공급지수 44, 가장 가까운 정류장까지 도보권 밖"
    }
  ]
}
```

`reason` 은 화면과 AI 보고서에 그대로 인용됩니다. **사람이 읽을 문장**으로 만들어 주세요.

---

### 3.4 `GET /stops` · `GET /routes`

```json
// GET /stops
{ "stops": [
  { "id": "41590-20000",     // 조인 키: {시군구코드}-{ARS번호}
    "arsNo": "20000",        // 국토부 ARS번호(모바일단축번호)
    "name": "병점역", "dong": "병점1동",
    "lon": 127.0446, "lat": 37.1856,
    "x": 622, "y": 132, "kind": "hub", "routes": ["A", "B"] }
]}
```

#### 정류소 조인 키를 ARS번호로

경기데이터드림 정류소id 로 조인하면 매칭률이 **79.2%**, 국토부 ARS번호로 하면
**99.5%** 입니다(백엔드 실측). ARS번호를 기준으로 씁니다.

> ⚠️ **ARS번호는 전국 유일이 아닙니다.** 시군구 안에서만 유일하므로
> `id` 는 `{시군구코드}-{ARS번호}` 결합키로 두고 `arsNo` 를 따로 실어 보냅니다.
> 나중에 인접 시군으로 확장해도 키를 갈아엎지 않아도 됩니다.
>
> 프론트엔드는 `id` 를 불투명한 문자열로만 다루므로 형식이 바뀌어도 코드 변경은 없습니다.
> 다만 `cells[].nearestStopId` 와 `/stops/{stopId}/profile` 의 값이 같아야 합니다.

```jsonc

// GET /routes
{ "routes": [
  { "id": "A", "name": "간선 A · 병점–동탄2", "type": "trunk",
    "stopIds": ["S-001", "S-002"],
    "path":   [[127.0446, 37.1856], [127.0759, 37.1685]],
    "pathXY": [[622, 132], [668, 162]] }
]}
```

`kind` 는 `hub` / `ind`(산단) / `res`(주거) / `rural`. 지도 마커 크기에만 씁니다.
`pathXY` 는 선택 — 없으면 `path`(경위도)를 투영합니다.

---

### 3.5 `GET /stops/{stopId}/profile?period=am`

```json
{
  "stopId": "41590-20000", "stopName": "병점역", "kind": "hub",
  "routes": ["A", "B"],

  // ★ 시간대 프로파일은 실측이 아닙니다.
  //    교통카드 원자료가 일자별 집계라 시간대 정보가 없어, 유동인구 배율로 안분합니다.
  //    화면에 "추정치" 배지가 붙습니다.
  "isEstimated": true,
  "estimationMethod": "일자별 승하차를 통신 유동인구 시간배율로 안분",
  "hours": [5, 6, 7, 8, "…23까지"],
  "boardings":  [12, 48, 210, 305, "…"],
  "alightings": [ 9, 31, 178, 288, "…"],
  "summary": { "boardingsPerDay": 3658, "alightingsPerDay": 3521, "peakSharePct": 41.2 }
}
```

`hours`·`boardings`·`alightings` 는 **길이가 같아야** 합니다.
`peakSharePct` = 출퇴근 첨두(07–09, 17–19) 승하차 ÷ 전체 승하차 × 100.

---

### 3.6 `POST /simulations` — 배치 시뮬레이션 ★

시뮬레이션 화면의 심장부입니다. 배치를 바꿀 때마다 호출됩니다.

#### 요청

```json
{
  "name": "향남 우선 배치안",
  "period": "am",
  "budgetKrw": 3000000000,
  "placements": [
    { "type": "stop", "cellId": "G-453", "count": 1 },
    { "type": "drt",  "cellId": "G-312", "count": 1 }
  ]
}
```

`type` 은 `meta.effects[].type` 중 하나 (`stop` / `drt` / `freq`).

#### 응답

```json
{
  "id": "SIM-0001",
  "name": "향남 우선 배치안",
  "createdAt": "2026-08-06 14:22",
  "placements": [
    { "type": "stop", "typeLabel": "정류장 신설", "cellId": "G-453",
      "cellName": "향남산단 중심", "count": 1, "radiusKm": 1.9, "unitKrw": 42000000 }
  ],
  "cost": {
    "totalKrw": 222000000,
    "breakdown": [
      { "type": "stop", "label": "정류장 신설", "unitKrw": 42000000,  "amountKrw": 42000000 },
      { "type": "drt",  "label": "똑버스 배치", "unitKrw": 180000000, "amountKrw": 180000000 }
    ]
  },
  "budgetKrw": 3000000000,
  "periods": [
    {
      "period": "am", "periodName": "출근",
      "kpi":      { "needCells": 6,  "potentialTripsPerDay": 21400, "elderlyTripsPerDay": 1720, "avgMi": -0.04, "drtCells": 55, "overCells": 0, "totalCells": 389, "needShare": 1.5 },
      "baseline": { "needCells": 13, "potentialTripsPerDay": 36336, "elderlyTripsPerDay": 2934, "avgMi": 0.002, "drtCells": 57, "overCells": 0, "totalCells": 389, "needShare": 3.3 },
      "delta":    { "needCells": -7, "potentialTripsPerDay": -14936, "elderlyTripsPerDay": -1214, "avgMi": -0.042, "drtCells": -2 }
    }
  ],
  "effectiveness": {
    "resolvedNeedCells": 21,
    "resolvedTripsPerDay": 90914,
    "resolvedElderlyTripsPerDay": 7180,
    "krwPerTripPerDay": 3366
  },
  "cellsByPeriod": {
    "am":    "[ /grid 의 cells 와 완전히 같은 형식 ]",
    "day":   "[ … ]",
    "pm":    "[ … ]",
    "night": "[ … ]"
  }
}
```

**규칙**

- `periods` 는 **4개 시간대를 모두** 담아야 합니다(전후 비교 차트가 전 시간대를 그림).
- `baseline` 은 **배치가 하나도 없는 상태**의 값. 항상 같은 값이어야 합니다.
- `delta` = `kpi` − `baseline`. 음수가 "개선"입니다.
- `effectiveness.krwPerTripPerDay` = 총 사업비 ÷ 전 시간대 해소 통행 합.
  해소된 통행이 0이면 **`null`** 을 보내세요(프론트엔드가 `–` 로 표시).
- `placements` 가 빈 배열이면 `kpi === baseline`, `cost.totalKrw === 0` 이어야 합니다.

**배치 효과 모델(목 구현 — 실데이터에서 반드시 보정 필요)**

| 수단 | 반경 | 효과 |
|---|---|---|
| `stop` 정류장 신설 | 1.9km | 커버리지 `+0.34 × (1 − d/R)`, 공급 `+0.05 × (1 − d/R)` |
| `drt` 똑버스 | 3.0km | 공급 `+0.13 × (1 − d/R)` — 넓지만 얕게 |
| `freq` 배차 증편 | 2.2km | 인접 격자 `+0.20`, 그 외 `+0.09`. **`coverage ≥ 0.5` 인 격자만 허용** |

> 이 계수는 시연용 가정값입니다. 실데이터에서는 유사 사례의 실측 승하차 증가율로
> 보정해야 하며, 그 지점이 이 모델의 신뢰도를 좌우합니다.

---

### 3.7 `POST /recommendations` — 추천 배치안 ★

> **설계 원칙: 최적화는 알고리즘, 설명은 AI**
> 배치 위치를 언어모델에게 고르게 하지 마세요. 매번 답이 달라지고 근거를 댈 수 없습니다.
> 위치는 아래 알고리즘이 정하고, 근거 문장만 AI 가 다듬습니다.

#### 요청

```jsonc
{
  "strategy": "efficiency",       // efficiency | equity | balance | quick (기본 efficiency)
  "includeAlternatives": true,    // 다른 전략 요약도 함께 (기본 false)
  "period": "am",
  "budgetKrw": 3000000000,
  "maxPlacements": 10,
  "allowedTypes": ["stop", "drt", "freq"],  // 선택. 생략하면 전부
  "region": "동탄8동"             // 선택. 후보를 해당 읍면동으로 제한 (생략 시 화성시 전체)
}
```

`region` 은 대시보드에서 "이 격자로 시뮬레이션 하기"로 넘어온 흐름을 위한 것입니다.
후보 격자만 좁힐 뿐 선정 알고리즘은 같아서 결정성이 유지됩니다. 주의:

- `region` 지정 시 `balance`(지역 균형) 전략은 성립하지 않으므로(동별 1건 상한 = 곧 1건 추천)
  `efficiency` 로 대체 처리되고, `alternatives` 목록에서도 빠집니다.
- 해당 동에 해소할 사각지대가 없으면 `stoppedBecause: "no_candidate"` 로 0건이 옵니다.

#### 응답

```jsonc
{
  "method": "budget-constrained greedy marginal benefit",
  "methodLabel": "예산 제약 하 한계효과 최대화",
  "methodNote": "미해결 통행량을 사업비 1원당 가장 많이 줄이는 지점을 순차 선택…",

  "region": "동탄8동",            // 추천 범위 에코 (요청에 없었으면 null = 화성시 전체)

  // 어떤 목적으로 고른 안인지 (§ 추천 전략 참고)
  "strategy": "efficiency",
  "strategyLabel": "효율 최우선",
  "strategyNote": "사업비 1원당 해소 통행량이 가장 큰 순서로 고릅니다.",
  "strategyBasisNote": "기본안입니다. 예산 대비 성과를 묻는 질문에 답합니다.",
  "strategies": [ { "id": "efficiency", "label": "효율 최우선", "short": "효율", "note": "…" }, … ],

  // includeAlternatives:true 일 때만. 목적별 요약(배치 목록은 싣지 않음)
  "alternatives": [
    { "strategy": "efficiency", "label": "효율 최우선", "short": "효율",
      "selected": true, "count": 5, "totalKrw": 260000000,
      "mix": { "stop": 4, "drt": 0, "freq": 1 },
      "expectedResolvedCells": 14, "expectedResolvedTrips": 30971,
      "expectedResolvedElderlyTrips": 2386 }
  ],

  // 무엇을 알고리즘이 하고 무엇을 AI 가 하는지
  "producedBy": {
    "placements": "최적화 알고리즘 (예산 제약 하 그리디)",
    "narrative": "Claude",
    "deterministic": true,
    "deterministicNote": "같은 조건이면 항상 같은 결과가 나옵니다. 다른 안이 필요하면 난수가 아니라 전략(목적)을 바꿉니다."
  },
  "period": "am",
  "generatedAt": "2026-08-07 12:10",
  "placements": [
    { "rank": 1, "type": "stop", "typeLabel": "정류장 신설",
      "cellId": "G-269", "cellName": "동탄8동 북부", "region": "동탄8동", "count": 1,
      "radiusKm": 2.0,
      "costKrw": 42000000, "annualCostKrw": 4200000,
      "costBasis": "1회성 시설비(내용연수 10년)",
      "expectedResolvedCells": 3, "expectedResolvedTrips": 8636, "krwPerTrip": 4863,
      "rationale": "수요지수 87 대비 공급지수 53, 노선은 인근을 지나지만 정류장이 도보권 밖(커버리지 0.23)이라 정류장 신설로 해소 가능" }
  ],
  "simulation": { "…": "POST /simulations 와 같은 형식. 화면·보고서가 이 수치를 씁니다" },
  "summary": {
    "count": 5, "totalKrw": 210000000, "budgetKrw": 3000000000, "budgetUsedPct": 7.0,
    "expectedResolvedCells": 11, "expectedResolvedTrips": 22190,
    "expectedResolvedElderlyTrips": 1870, "krwPerTrip": 3883,
    "stoppedBecause": "max_reached",  // budget_exhausted | budget_too_small | max_reached | no_further_gain | no_candidate
                                      // budget_too_small: 한 건도 못 넣고 종료(예산 < 최소 단가).
                                      //   '예산 소진'과 구분해야 "0건·0원·예산 소진" 같은 모순 문구가 안 나옵니다.
    "costCompareBasis": "total",      // total | annual  (CONFIG.COST.compareBasis)
    "costCompareLabel": "총사업비 기준",
    "costCompareNote": "예산 한도와 같은 기준(총사업비)으로 비교했습니다. 똑버스·증편은 이듬해에도 같은 예산이 필요합니다."
  }
}
```

#### 추천 전략 — 답이 하나뿐이면 안 됩니다

그리디는 **결정론적**입니다. 같은 조건이면 항상 같은 답이 나옵니다.
이건 고쳐야 할 결함이 아니라 **요구사항**입니다. 공무원이 같은 조건으로 두 번 돌렸는데
다른 답이 나오면 그 수치는 공문서에 쓸 수 없습니다. **난수를 넣지 마세요.**

다만 답이 하나뿐이면 "이 안 말고 다른 안은 없나요"에 답할 수 없습니다.
그래서 다양성은 무작위가 아니라 **목적함수**에서 만듭니다. 각 전략은 그 자체로
결정론적이면서 서로 다른 답을 냅니다.

| `strategy` | 이름 | 목적함수 / 제약 |
|---|---|---|
| `efficiency` *(기본)* | 효율 최우선 | 가중치 `1 + 고령비 × 1.6` — 전체 통행 기준 |
| `equity` | 교통약자 우선 | 가중치 `고령비` — **고령 통행량** 기준 |
| `balance` | 지역 균형 | 효율과 동일 + 읍면동당 최대 1개 |
| `quick` | 즉시 착수 | 효율과 동일 + 정류장 신설만 (`types: ['stop']`) |

목 데이터 실측 (출근 · 30억 · 5건):

| 전략 | 구성 | 해소 격자 | 일 통행 | 고령 통행 | 사업비 | 읍면동 |
|---|---|---|---|---|---|---|
| 효율 최우선 | 정류장4+증편1 | **14** | **30,971** | 2,386 | 2.6억 | 4 |
| 교통약자 우선 | 정류장4+증편1 | 14 | 29,660 | **2,427** | 2.6억 | 3 |
| 지역 균형 | 정류장4+증편1 | 12 | 27,192 | 2,132 | 2.6억 | **5** |
| 즉시 착수 | 정류장5 | 11 | 22,190 | 1,875 | **2.1억** | 5 |

> **가중치를 조금 올리는 방식은 통하지 않습니다.**
> 처음에 교통약자 우선을 "고령 가중 1.6 → 3.0" 으로 만들었더니 상위 5건이
> 효율안과 **완전히 동일**했습니다. 격자 간 고령비 차이가 작아 순위가 안 바뀝니다.
> 기준 자체를 고령 통행량으로 바꿔야 실제로 다른 답이 나옵니다.

`includeAlternatives: true` 를 주면 네 전략을 모두 계산해 **요약만** 함께 돌려줍니다
(배치 목록은 제외). 그리디를 4번 도는 비용이 듭니다 — 목 구현 기준 약 0.8초.
필요 없으면 생략하세요.

#### 알고리즘 (목 구현 — 백엔드에서 그대로 옮기면 됩니다)

```
후보 = 현재 상태에서 미해결인 격자 (고수요·저공급 + DRT후보)

예산이 남고 최대 건수에 못 미치는 동안 반복:
    각 (후보, 수단) 조합에 대해:
        전략이 수단을 제한하면 그 밖은 건너뜀        (즉시 착수)
        전략이 지역 상한을 두면 채운 읍면동은 건너뜀  (지역 균형)
        수단별 적용 제약을 통과하지 못하면 건너뜀
        효율 = 줄어든 미해결 통행량 ÷ 사업비   ← 예산 판정과 같은 기준
    효율 1위를 채택하고 실제로 반영
    ※ 같은 (격자, 수단) 조합은 두 번 채택하지 않음
    ※ 이미 개선된 곳은 다음 회차에 효율이 자동으로 낮아짐 → 중복 방지
```

**목적함수 — 미해결 통행량**

```
미해결(i) = (고수요·저공급 또는 DRT후보인 격자) ? 잠재통행_i × 가중치(i) : 0

가중치(i) = 1 + 1.6·고령비_i    (efficiency / balance / quick)
          = 고령비_i           (equity — 고령 통행량만 봄)
```

`efficiency` 의 교통약자 가중은 우선순위 산식과 같은 계수를 씁니다.

**수단별 적용 제약 (서로 겹치지 않게 설계)**

| 커버리지 | 진단 | 수단 |
|---|---|---|
| ≥ 0.5 | 정류장은 도보권 안, 버스가 뜸함 | `freq` 배차 증편 |
| 0.15 ~ 0.5 | 노선은 인근, 정류장이 멀다 | `stop` 정류장 신설 |
| < 0.15 | 노선망 자체가 닿지 않음 | `drt` 똑버스 |

> 이 구분이 없으면 가장 싼 정류장이 아무 데나 선택됩니다.
> 제약 판정은 **배치 효과가 반영된 커버리지**로 해야 같은 격자에 중복 추천되지 않습니다.

**⚠️ 비용 비교 기준 — 총사업비를 씁니다**

수단마다 비용의 성격이 다릅니다.

| 수단 | 사업비 | 성격 | 연환산 시 |
|---|---|---|---|
| 정류장 신설 | 4,200만 원 | 1회성 자본비 (`capital`) | ÷ 10년 + 유지비 = 520만 원 |
| 똑버스 배치 | 1.8억 원 | 연간 운영비 (`operating`) | 1.8억 원 |
| 배차 증편 | 9,500만 원 | 연간 운영비 (`operating`) | 9,500만 원 |

성격이 다르니 어떤 자로 잴지 정해야 합니다. **`CONFIG.COST.compareBasis`
(기본값 `'total'`)** 로 바꿀 수 있고, 기본은 **총사업비**입니다.

##### 왜 총사업비인가

처음에는 연환산을 썼는데, 그러면 정류장이 520만 원/년 vs 똑버스 1.8억 원/년으로
**35배 싸게** 잡혀 추천이 정류장으로 쏠렸습니다. 목 데이터 실측:

| 비교 기준 | 정류장 | 똑버스 | 증편 | 집행액 | 예산 소진 | 해소 격자 | 해소 통행 |
|---|---|---|---|---|---|---|---|
| 연환산 (정류장만 ÷10년) | **17** | 2 | 1 | 11.7억 | 39% | 22칸 | 39,246 |
| 연환산 (똑버스도 ÷8년) | 9 | 11 | 0 | 23.6억 | 79% | 28칸 | 45,471 |
| **총사업비 (채택)** | 10 | 9 | 1 | **21.4억** | 71% | **28칸** | **45,471** |

*(예산 30억 · 출근시간대 · 20건 요청)*

총사업비를 고른 이유는 결과가 좋아서가 아니라 **기준이 맞아서**입니다.

1. **예산 한도를 총액으로 재고 있었습니다.** 채택 여부는 `spent + cost > budget`
   (총액)으로 자르면서 순위는 연환산으로 매기고 있었습니다. 재는 자와 자르는 자가
   달랐던 것이고, 이게 쏠림의 직접 원인입니다. 화면 예산 입력칸도 총액(억 원)입니다.
2. **공무원이 실제로 묻는 것**은 "올해 예산 30억으로 무엇을 살 수 있나"입니다.
3. **가정이 하나 줄어듭니다.** 내용연수를 정하지 않아도 됩니다. 위 표에서 보듯
   똑버스 내용연수를 8년으로 잡느냐 마느냐로 결과가 크게 흔들리는데, 그 값 자체가
   근거 없는 가정이었습니다.

> **한계 — 총사업비는 1년차 관점입니다.**
> 정류장은 한 번 지으면 끝이지만 똑버스·증편은 이듬해에도 같은 예산이 듭니다.
> 다년도로 비교하면 정류장 비중이 다시 커집니다. 이 한계는 화면(추천 박스 하단)과
> 보고서 주석에 그대로 표시됩니다.
>
> 다년도 기준으로 바꾸려면 `compareBasis: 'annual'` 로 두고 각 수단의 `lifeYears`
> 를 실제 값으로 채우세요. 코드 수정은 이 한 줄뿐입니다.

##### 남은 과제 — 용량 제약

기준을 바로잡아도 **정류장 10개**는 여전히 많습니다. 근본 원인은 비용이 아니라
효과 모형에 **용량 제약이 없다**는 점입니다. 지금은 정류장을 몇 개 세우든 그 노선의
버스 대수가 그대로인데도 공급이 계속 늘어납니다. 실제로는 같은 노선에 정류장만
늘리면 효과가 체감합니다.

실데이터 연동 후 노선별 운행 대수·재차인원을 받으면 다음을 넣을 예정입니다.

```
같은 노선 회랑에 이미 N개를 신설했다면  효과 × 1/(1 + k·N)
```

#### 성능 참고

배치는 **공급(S)에만** 영향을 주고 정규화 기준은 고정돼 있으므로, 영향권 안 격자만
다시 계산해도 전체 재계산과 결과가 **정확히 같습니다**. (똑버스 1대 = 353칸 중 8칸)

목 구현 실측: 전체 재계산 방식 **49초** → 국소 계산 방식 **0.2초** (약 44배)

---

### 3.8 `POST /reports/draft` — AI 보고서 초안 ★

**Claude API 호출 규격은 별도 문서 → [`AI-REPORT.md`](AI-REPORT.md)**

#### 요청

```json
{
  "period": "am",
  "format": "sections",
  "tone": "공문",
  "sections": ["summary", "status", "problem", "plan", "effect", "next"],
  "context": {
    "org": "화성시", "dept": "교통정책과",
    "kpi": { "needCells": 13, "…": "/grid 의 kpi 그대로" },
    "priorities": [ "/priorities 의 items 그대로" ],
    "simulation": { "…": "POST /simulations 응답 그대로 (없으면 null)" },
    "recommendation": {
      "placements": [ "…POST /recommendations 의 placements…" ],
      "summary": { "…" },
      "methodLabel": "예산 제약 하 한계효과 최대화",
      "methodNote": "…",
      "edited": false        // 사용자가 추천안을 손봤는지
    }
  }
}
```

`recommendation` 이 있으면 보고서 4장(개선 방안)에 선정 근거가 들어가고,
**"추천 배치안 및 선정 근거"** 표가 추가됩니다.

#### 응답

```json
{
  "title": "화성시 대중교통 수급 불일치 분석 및 노선 조정 검토(안)",
  "subtitle": "출근 시간대(07–09) 기준 · 시나리오 「향남 우선 배치안」",
  "org": "화성시", "dept": "교통정책과",
  "period": "am",
  "generatedAt": "2026-08-06 14:25",
  "model": "claude-opus-5",
  "sections": [
    {
      "key": "summary",
      "heading": "1. 검토 개요",
      "body": "본 자료는 …\n두 번째 문단은 \\n 으로 구분합니다.",
      "bullets": ["분석 시간대: 출근 07–09", "고수요·저공급 격자: 28개 / 전체 353개"]
    }
  ],
  "tables": [
    {
      "key": "priority",
      "title": "노선 조정 우선순위 (상위 10개 격자)",
      "columns": ["순위", "격자", "권역", "수요 D", "공급 S", "MI", "고령비", "잠재수요(통행/일)", "조치"],
      "rows": [[1, "G-453", "향남산단 중심", 72, 44, "+1.02", "13%", "2,558", "신설"]]
    }
  ],
  "disclaimer": "본 문서는 자동 생성된 초안입니다. 담당자 검토 후 활용하시기 바랍니다."
}
```

**규칙**

- `sections[].body` 안의 `\n` 은 문단 구분으로 렌더링됩니다.
- `tables[].rows` 의 각 행 길이는 `columns` 길이와 같아야 합니다.
- `tables[].title` 은 **엑셀 시트명**이 됩니다. 31자 초과·`[]:*?/\` 는 프론트엔드가 자동 정리합니다.
- 숫자를 `"2,558"` 처럼 콤마 문자열로 보내도 엑셀에서는 숫자 셀로 복원됩니다.

---

### 3.9 `POST /reports/export` — 서버측 파일 생성 (선택)

`config.js` 의 `EXPORT_MODE` 를 `'server'` 또는 `'auto'` 로 바꿨을 때만 호출됩니다.

```
요청  : { "format": "xlsx" | "hwpx" | "docx", "draft": { …3.7 의 응답 그대로… } }
응답  : 파일 바이너리 (Content-Type: application/octet-stream 등)
```

한글 `.hwpx` 생성은 파이썬 [`python-hwpx`], [`pyhwpx`] 또는 한컴 오피스 SDK 를 검토하세요.
구현 전까지는 `EXPORT_MODE: 'client'` 로 두면 브라우저가 `.xlsx` / `.rtf` 를 만듭니다.

---

## 4. 백엔드 스켈레톤 (FastAPI)

```python
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal, Optional, List

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

Period = Literal["am", "day", "pm", "night"]

@app.get("/api/v1/meta")
def get_meta():
    return {...}

@app.get("/api/v1/grid")
def get_grid(period: Period = "am"):
    return {"period": period, "scale": {...}, "kpi": {...}, "cells": [...]}

@app.get("/api/v1/priorities")
def get_priorities(period: Period = "am", limit: int = 10):
    return {"period": period, "items": [...]}

@app.get("/api/v1/stops")
def get_stops(): ...

@app.get("/api/v1/stops/{stop_id}/profile")
def get_profile(stop_id: str, period: Period = "am"): ...

@app.get("/api/v1/routes")
def get_routes(): ...

class Placement(BaseModel):
    type: Literal["stop", "drt", "freq"]
    cellId: str
    count: int = 1

class SimRequest(BaseModel):
    name: str = "시나리오"
    period: Period = "am"
    budgetKrw: int = 0
    placements: List[Placement] = []

@app.post("/api/v1/simulations")
def run_simulation(req: SimRequest):
    return {...}

class ReportRequest(BaseModel):
    period: Period = "am"
    tone: str = "공문"
    sections: List[str] = []
    context: dict = {}

@app.post("/api/v1/reports/draft")
def draft_report(req: ReportRequest):
    # → AI-REPORT.md 참고 (Claude API 호출)
    return {...}
```

---

## 5. 연동 확인 체크리스트

- [ ] `GET /api/v1/meta` 가 200 을 돌려주고 `periods` 4개가 있다
- [ ] `GET /api/v1/grid?period=am` 의 `cells[].bins.mi` 가 **0~6 정수**다
- [ ] 4개 시간대의 `kpi.needCells` 가 서로 **다르다** (같으면 시간대 배율 미적용)
- [ ] 지도에 격자가 칠해진다 (안 칠해지면 `bins` 누락 또는 `lon/lat` 범위 오류)
- [ ] `POST /simulations` 에 빈 `placements` 를 보내면 `kpi === baseline` 이다
- [ ] 배치를 추가하면 `delta.needCells` 가 **음수**가 된다
- [ ] `POST /recommendations` 가 같은 `(격자, 수단)` 조합을 두 번 추천하지 않는다
- [ ] 추천 건수를 늘리면 수단이 다양해진다 (정류장만 나오면 제약 설정을 확인)
- [ ] 브라우저 개발자도구 Network 탭에 CORS 오류가 없다
- [ ] `USE_MOCK: false` 로 바꿔도 화면이 목 모드와 동일하게 보인다

문제가 생기면 브라우저 콘솔에서 목 응답과 실서버 응답을 직접 비교해 보세요.

```js
HW.CONFIG.USE_MOCK = true;  HW.api.clearCache(); HW.mock.handle('grid.list', {period:'am'})
```
