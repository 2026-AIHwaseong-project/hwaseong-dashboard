# 격자와 카카오 배경의 이동·확대 속도 차이

지도를 드래그하면 격자는 손끝을 따라오는데 배경 지도는 그보다 느리게 밀리고,
확대하면 둘이 어긋난 채로 커집니다. **격자 아래 깔린 건물이 실제로 그 격자의
것이 아니게 되므로** '이 칸 안에 뭐가 있나' 판단이 틀어집니다.

이 문서는 그 어긋남을 **숫자로 재는 방법**과, 고칠 때 무엇을 확인해야 하는지를 담습니다.

> 한 번 고쳤다가(⑤, `61351ed`) 되돌렸습니다(`554ae83`). 현재 `dev` 는 **어긋남이 있는 상태**입니다.
> 되돌린 이유와 그 방식의 한계는 [5장](#5-예전에-시도했다-되돌린-방식)에 있습니다.

---

## 0. 30초 요약

| 항목 | 값 |
|---|---|
| 원인 | 카카오맵은 **정수 줌 레벨**로만 반응. `setBounds` 는 요청 범위를 '담을 수 있는' 레벨을 고름 |
| 결과 | 배경이 항상 요청보다 넓게 보임. 비율 `k = 실제폭 / 요청폭` 는 항상 **1 이상** |
| 실측 k | 첫 화면 **×2.06**, 확대 중 **×1.14 ~ ×1.82** 사이를 톱니처럼 오르내림 |
| 고친 상태의 목표 | 모든 확대 단계에서 배경과 격자의 같은 지점이 화면상 같은 픽셀에 오는 것 |
| 계측 방법 | `syncKakao()` 에 임시 훅을 넣고 `window.__kkProbe` 를 읽음 ([2장](#2-수치-계측)) |

관련 코드는 전부 `assets/js/map.js` 한 파일에 있습니다.

| 위치 | 역할 |
|---|---|
| `initKakao()` | 배경 div(`.kakaomap`) 를 SVG 뒤에 깔고 카카오 SDK 를 붙임 |
| `syncKakao()` | **여기가 문제 지점.** SVG 의 `zoom` 창을 카카오 `setBounds` 로 넘김 |
| `applyZoom()` | 확대·이동 때마다 `syncKakao()` 를 부름 |

---

## 1. 환경 준비

### 1-1. 서버 두 개를 띄웁니다

```bash
# 터미널 1 — 백엔드 (:8000)
cd hwaseong-dashboard-backend && python3 main.py

# 터미널 2 — 프론트 정적 서버 (:5500)
cd hwaseong-dashboard && python3 tools/dev-server.py
```

브라우저에서 엽니다. `?server=` 는 프론트가 바라볼 백엔드 주소이고,
`localStorage` 에 기억되므로 한 번만 붙이면 됩니다.

```
http://127.0.0.1:5500/index.html?server=http://127.0.0.1:8000
```

### 1-2. 카카오 타일이 실제로 왔는지 먼저 확인합니다 ★

**이걸 확인하지 않으면 측정 전체가 무의미합니다.** 카카오 키는 등록된 도메인에서만
타일을 내려줍니다. 타일이 안 오면 `map.js` 의 `tilesloaded` 가드가 배경을 걷어내고
SVG 단독 지도로 남으므로, 어긋남 자체가 존재하지 않는 상태가 됩니다.

콘솔에서:

```js
document.querySelector('#map').classList.contains('kkmode')   // true 여야 합니다
document.querySelector('.kakaomap')                            // null 이 아니어야 합니다
```

- `true` → 배경이 살아 있습니다. 측정 가능.
- `false` → 타일이 안 온 것입니다. 아래를 확인하세요.
  - `assets/js/config.js` 의 `KAKAO.jsKey` 가 유효한가
  - 카카오 개발자 콘솔에서 **지금 열고 있는 주소**(`http://127.0.0.1:5500`)가
    플랫폼 > Web 사이트 도메인에 등록돼 있는가
  - 네트워크 탭에서 `dapi.kakao.com` 요청이 4xx 를 받지 않는가

> 참고: `61351ed` 커밋 메시지에는 "허용 도메인이 localhost:8000 뿐이라 타일이 안 온다"고
> 적혀 있지만, 실제로 `127.0.0.1:5500` 에서 타일이 정상 수신되는 것을 확인했습니다.
> 그 메모는 신뢰하지 말고 위 `kkmode` 검사로 직접 판단하세요.

---

## 2. 수치 계측

### 2-1. 왜 임시 훅이 필요한가

`kkMap` 은 `map.js` 의 클로저 안에 있어 밖에서 닿지 않습니다. `HW.createMap()` 이
돌려주는 공개 API 에도 카카오 핸들은 없습니다. 그래서 **측정용 훅을 잠깐 넣었다 뺍니다.**

### 2-2. 훅 넣기

`assets/js/map.js` 의 `syncKakao()` 를 찾습니다. 현재 이렇게 생겼습니다.

```js
function syncKakao() {
  if (!kkMap) return;
  var sw = C.unproject(zoom.x, zoom.y + zoom.h);
  var ne = C.unproject(zoom.x + zoom.w, zoom.y);
  kkMap.setBounds(new global.kakao.maps.LatLngBounds(
    new global.kakao.maps.LatLng(sw.lat, sw.lon),
    new global.kakao.maps.LatLng(ne.lat, ne.lon)
  ));
}
```

`setBounds(...)` 호출 **바로 뒤**, 닫는 `}` **앞**에 아래를 끼웁니다.

```js
  /* [임시 계측] 배경/격자 배율 차이 — 측정이 끝나면 반드시 지웁니다 */
  try {
    var _b = kkMap.getBounds();
    global.__kkProbe = {
      wantLon: ne.lon - sw.lon,                                              // SVG 가 요청한 경도폭
      gotLon: _b.getNorthEast().getLng() - _b.getSouthWest().getLng(),       // 카카오가 실제로 보여주는 경도폭
      level: kkMap.getLevel(),                                               // 카카오 정수 줌 레벨
      vbW: zoom.w                                                            // SVG viewBox 폭(연속값)
    };
    global.__kkProbe.k = global.__kkProbe.gotLon / global.__kkProbe.wantLon;
  } catch (e) { global.__kkProbe = { error: String(e) }; }
```

### 2-3. 읽기

페이지를 새로고침한 뒤 콘솔에서:

```js
__kkProbe
// { wantLon: 0.65123, gotLon: 1.33863, level: 10, vbW: 960, k: 2.056 }
```

지도를 확대·드래그할 때마다 값이 갱신됩니다. 확대 단계마다 `__kkProbe.k` 를 적어 두세요.

**`k` 가 1.000 에 가까울수록 배경과 격자가 맞는 것입니다.**

### 2-4. 훅 빼기

측정이 끝나면 반드시 되돌립니다.

```bash
git diff assets/js/map.js      # 훅만 보이는지 확인
git checkout assets/js/map.js  # 되돌리기
```

---

## 3. 기준 측정값 (현재 `dev`, 어긋남 있는 상태)

1440×900 창, `index.html`, 화면 중앙에서 격자 클릭 후 휠 확대를 5회 반복했습니다.

| 단계 | viewBox 폭 | 카카오 레벨 | 요청 경도폭 | 실제 경도폭 | **배율차 k** |
|---|---:|---:|---:|---:|---:|
| 로드 | 960.0 | 10 | 0.65123 | 1.33863 | **×2.056** |
| 격자 클릭 | 84.8 | 6 | 0.05753 | 0.08363 | **×1.454** |
| 휠 확대 1 | 84.8 | 6 | 0.05753 | 0.08363 | ×1.454 |
| 휠 확대 2 | 67.8 | 6 | 0.04602 | 0.08363 | **×1.817** |
| 휠 확대 3 | 54.3 | 5 | 0.03682 | 0.04181 | **×1.136** |
| 휠 확대 4 | 43.4 | 5 | 0.02946 | 0.04181 | ×1.420 |
| 휠 확대 5 | 34.7 | 5 | 0.02356 | 0.04181 | ×1.774 |

읽는 법:

- **viewBox 폭은 연속으로 줄어드는데(84.8 → 67.8 → 54.3 …) 카카오 레벨은 6, 6, 5, 5, 5 로 계단입니다.**
  같은 레벨에 머무는 동안 `gotLon` 이 `0.08363` 으로 고정된 것이 그 증거입니다.
- 그래서 `k` 는 **1.14 → 1.42 → 1.77 로 커지다가 레벨이 한 칸 떨어지면 다시 1.14 로 리셋**되는
  톱니 모양입니다. 이 톱니가 곧 "확대할수록 어긋나다가 갑자기 튀는" 체감입니다.
- 첫 화면의 `k = 2.06` 은 2 를 넘습니다. 가로가 아니라 **세로**가 먼저 걸려
  레벨이 정해졌기 때문입니다 — 즉 가로·세로 중 어느 쪽이 지배하는지도 상황에 따라 바뀝니다.

### 자동 측정 스크립트 (선택)

Playwright 가 깔려 있다면 위 표를 자동으로 뽑을 수 있습니다.
훅을 넣은 상태에서 실행하세요.

```js
// kkmeasure.js — node kkmeasure.js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:5500/index.html?server=http://127.0.0.1:8000', { waitUntil: 'load' });
  await p.waitForTimeout(5500);

  const kk = await p.evaluate(() => document.querySelector('#map').classList.contains('kkmode'));
  console.log('카카오 타일 로드(kkmode) =', kk);
  if (!kk) { console.log('배경이 없습니다 — 1-2 장을 먼저 확인하세요.'); await b.close(); return; }

  const read = () => p.evaluate(() => window.__kkProbe || null);
  const rows = [];
  rows.push(['로드', await read()]);

  const r = await (await p.$('#map')).boundingBox();
  const cells = await p.$$('#map .c[data-id]');
  await cells[Math.floor(cells.length / 2)].click({ force: true });
  await p.waitForTimeout(1200);
  rows.push(['격자 클릭', await read()]);

  for (let i = 1; i <= 5; i++) {
    await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(800);
    rows.push(['휠 확대 ' + i, await read()]);
  }

  console.log('단계'.padEnd(12) + 'viewBox폭  카카오레벨   요청경도폭   실제경도폭    배율차 k');
  rows.forEach(([k, v]) => {
    if (!v || v.error) return console.log(k.padEnd(12) + ' (probe 없음: ' + (v && v.error) + ')');
    console.log(k.padEnd(12) + String(v.vbW.toFixed(1)).padStart(8) + String(v.level).padStart(11) +
      v.wantLon.toFixed(5).padStart(13) + v.gotLon.toFixed(5).padStart(13) +
      ('×' + v.k.toFixed(3)).padStart(12));
  });
  await b.close();
})();
```

---

## 4. 눈으로 확인하는 절차 (코드 수정 없이)

숫자와 별개로, 사람이 보는 증상도 같이 확인해야 합니다. 셋 다 재현되면 어긋남이 있는 것입니다.

1. **드래그 속도 차이**
   지도를 천천히 오른쪽으로 크게 드래그합니다.
   격자·읍면동 경계선은 커서를 정확히 따라오는데, 배경 건물·도로는 더 적게 움직입니다.

2. **확대 중 미끄러짐**
   특징적인 지형(예: 화성호 해안선, 병점역 일대)을 화면 중앙에 두고 휠로 3~4단 확대합니다.
   SVG 해안선과 배경 위성/지도의 해안선이 점점 벌어지다가, 카카오 레벨이 바뀌는 순간
   갑자기 다시 붙습니다. 이 "벌어졌다 붙었다"가 톱니(3장)의 육안 버전입니다.

3. **격자 안 건물 불일치** — 실무상 이게 제일 문제입니다
   격자 하나를 클릭해 확대한 뒤, 그 칸 안에 보이는 건물·단지를 카카오맵 본사이트에서
   같은 좌표로 확인합니다. 다른 동네가 나오면 어긋난 것입니다.

`.zdetail` 상태(격자를 클릭해 크게 확대한 상태)에서는 `app.css` 가 SVG 육지·바다를
투명하게 만들어 배경이 그대로 드러나므로 어긋남이 가장 잘 보입니다.

---

## 5. 예전에 시도했다 되돌린 방식

`61351ed` 의 ⑤ 항목이 이 문제를 다뤘고, `554ae83` 에서 되돌렸습니다.

**접근:** `setBounds` 직후 `getBounds()` 로 실제 표시 범위를 읽어 `k` 를 구하고,
배경 div 에 `transform: scale(k)` 를 걸어 남은 배율 차이를 메웁니다.
`setBounds` 가 '담기게' 고르므로 `k ≥ 1` 이라 항상 확대 방향이고 가장자리에 빈 자리가 없습니다.

```js
kkDiv.style.transformOrigin = '50% 50%';
kkDiv.style.transform = k > 1.001 ? 'scale(' + k.toFixed(4) + ')' : '';
```

**되돌린 이유 / 알려진 한계:**

- 배율만 맞추고 **중심 어긋남은 안 맞습니다.** `transform-origin: 50% 50%` 는 컨테이너
  중심을 기준으로 잡는데, 카카오가 고른 레벨의 실제 중심은 요청 중심과 다를 수 있습니다.
  화면 중앙 근처는 맞아 보여도 가장자리로 갈수록 틀어집니다.
- 최대 2배까지 확대하므로 **배경 타일이 그만큼 뭉개집니다.** `k = 2.06` 인 첫 화면에서는
  타일이 2배로 늘어나 글씨가 흐려집니다.
- `getBounds()` 가 없는 SDK 버전에서는 `try/catch` 로 조용히 무보정 상태가 됩니다 —
  즉 환경에 따라 동작이 달라집니다.

**이 방식을 다시 쓴다면 반드시 같이 확인할 것:**

- 화면 **모서리 4곳**에서의 일치 여부 (중앙만 보면 속습니다)
- `k` 가 큰 상태(첫 화면, ×2 근처)에서의 타일 선명도
- `.zdetail` 전환 시 배경이 튀지 않는지

---

## 6. 다른 접근 후보

되돌린 방식 말고 검토해 볼 만한 것들입니다. 어느 것도 아직 구현·검증되지 않았습니다.

### (가) SVG 를 카카오 레벨에 맞춘다 — 방향을 뒤집기

배경을 격자에 맞추는 대신, **SVG 확대를 카카오가 실제로 고른 레벨에 스냅**시킵니다.
`setBounds` 대신 `setLevel()` 로 레벨을 직접 정하고, 그 레벨의 실제 범위를 읽어
SVG `zoom` 을 거기에 맞춥니다.

- 장점: 두 층이 **정의상** 항상 일치. 타일도 안 뭉개집니다.
- 단점: 확대가 연속이 아니라 계단이 됩니다. 휠 확대의 부드러움이 사라지고,
  `CELL_ZOOM_SPAN` 기반의 "격자 클릭 → 딱 이만큼 확대" 동작을 다시 설계해야 합니다.

### (나) 카카오 대신 타일을 직접 그린다

`.kakaomap` div 를 걷어내고 래스터 타일(카카오/OSM/VWorld)을 SVG `<image>` 로
직접 배치합니다. 타일 좌표 계산을 직접 하므로 연속 확대와 정확히 맞출 수 있습니다.

- 장점: 완전한 제어. SDK 버전 차이·`getBounds` 유무 같은 변수가 사라집니다.
- 단점: 타일 URL 정책·이용약관 확인이 필요하고, 구현량이 가장 큽니다.

### (다) 배경 없이 간다

애초에 배경은 '있으면 좋은' 한 겹입니다(`initKakao` 가 실패해도 지도는 그대로 동작).
어긋난 배경이 **잘못된 판단을 유도한다면**, 없는 편이 안전할 수 있습니다.

- `assets/js/config.js` 의 `KAKAO.enabled` 를 `false` 로 두면 됩니다.
- 시연 직전까지 못 고치면 이게 가장 확실한 선택지입니다.

---

## 7. 고쳤을 때의 합격 기준

수정안이 무엇이든 아래를 전부 만족해야 '고쳤다'고 할 수 있습니다.

- [ ] 3장 표의 모든 단계에서 **`k` 가 1.00 ± 0.02**
      (또는 (가)안처럼 `k` 자체가 의미 없어지는 구조로 바뀜)
- [ ] 4장의 육안 확인 3가지가 전부 재현되지 않음
- [ ] 화면 **네 모서리**에서 SVG 해안선과 배경 해안선이 일치 (중앙만 보지 말 것)
- [ ] 격자 클릭 → `.zdetail` 진입 시 배경이 튀거나 빈 자리가 생기지 않음
- [ ] `k` 가 컸던 첫 화면에서 타일이 뭉개지지 않음
- [ ] 카카오 타일이 **안 올 때**(`kkmode` 미부여) 예전처럼 SVG 단독으로 정상 동작
      — `KAKAO.enabled: false` 로 바꿔서 확인
- [ ] `node tools/check-css.js` 통과
- [ ] `node tools/e2e-live.js` 통과
- [ ] 두 화면(`index.html`, `simulation.html`) 콘솔 에러 0
- [ ] `window.__kkProbe` 계측 훅이 코드에 남아 있지 않음

---

## 8. 참고 수치

`/api/v1/meta` 기준입니다. 계산을 검산할 때 쓰세요.

| 항목 | 값 |
|---|---|
| `grid.sizeMeters` | 1000 |
| `grid.cellCount` | 786 |
| `grid.bbox` | `[126.53771, 37.01994, 127.15638, 37.29048]` |
| `map.viewBox` | `[0, 0, 960, 640]` |
| 전체 경도폭 | 0.61867° ≈ 54,890 m |
| 1 SVG 사용자 단위 | ≈ 57.2 m |
| `CELL_ZOOM_SPAN` | 5 (격자 클릭 시 화면에 담을 격자 수) |

`viewBox` 는 `map.js` 가 `meta.map.viewBox` 를 우선 쓰고, 없을 때만
`index.html` 의 `viewBox="0 0 960 580"` 로 떨어집니다. **실제로 쓰이는 값은 960×640 입니다.**
