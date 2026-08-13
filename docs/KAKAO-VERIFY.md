# 카카오 배경 정합 — 로컬 검증 절차

SVG 격자와 카카오맵 배경이 확대·이동할 때 어긋나지 않는지 **직접 재보는 런북**입니다.
문제 자체는 커밋 `00acdee` 로 해결됐고, 이 문서는 **회귀가 의심될 때 다시 재기 위한 것**입니다.

> 이 절차는 실행 검증을 거치지 않았습니다. 코드·선택자·포트·타임아웃은 정적으로 대조했지만
> 브라우저를 띄워 돌려본 적은 없습니다. **처음 돌릴 때는 결과가 이상하면 절차를 의심하세요.**
> 요약과 배경 설명은 [README §9](../README.md) 에 있습니다.

---

## 0. 30초 요약

카카오맵은 **정수 줌 레벨**로만 반응합니다. `setBounds` 는 요청 범위를 "담을 수 있는"
레벨을 고르므로 실제 표시 범위가 항상 요청보다 넓고, 레벨 사이에서 최대 2배까지 벌어집니다.
SVG 확대는 연속값이라 드래그하면 격자는 손끝을 따라오는데 배경은 느리게 밀립니다.

`alignKakao()` 가 **카카오 투영에 직접 물어**(`containerPointFromCoords`) 우리 창의 두
모서리가 컨테이너의 `(0,0)`·`(W,H)` 에 오도록 아핀을 맞춰 그 차이를 메웁니다.
수정 전후 실측은 이렇습니다.

| | 수정 전 | 수정 후 |
|---|---|---|
| 화면 어긋남 | 62~292px | **1.7~7.4px** |
| 정류장 위치 (1,455% 확대) | 중앙값 890m · 최대 1,813m | **중앙값 3m** |
| 정류장 위치 (596% / 100%) | — | 14m / 120m |

**격자가 1km 인데 890m 어긋났다**는 게 문제의 크기였습니다 — 격자 아래 깔린 건물이
실제로 그 격자의 것이 아니게 됩니다.

---

## 1. 재기 전에 — 배경이 살아 있는지부터

**이 확인을 건너뛰면 측정이 통째로 무의미합니다.** 카카오 키는 등록된 도메인에서만
타일을 내려주고, 타일이 5초 안에 안 오면 `map.js` 가 배경 div 를 걷어내고 SVG 단독
지도로 남습니다. 그 상태에서는 **어긋남이라는 것이 아예 존재하지 않습니다.**

서버를 띄웁니다.

```bash
# 터미널 1 — 백엔드
cd hwaseong-dashboard-backend
pip install -r requirements.txt
python main.py                      # → http://localhost:8000

# 터미널 2 — 프론트 (백엔드가 /app/ 로 서빙하면 이 단계는 생략 가능)
cd hwaseong-dashboard
python3 tools/dev-server.py 5500    # → http://localhost:5500/
```

브라우저에서 화면을 열고 콘솔에서 **둘 다** 통과해야 다음으로 갑니다.

```js
document.querySelector('#map').classList.contains('kkmode')   // true 여야 합니다
document.querySelector('.kakaomap-inner')                     // null 이 아니어야 합니다
```

`false`·`null` 이면 어긋남이 아니라 타일 문제입니다.

- `assets/js/config.js` 의 `KAKAO.enabled` 가 `true` 이고 `jsKey` 가 채워져 있는지
- 카카오 개발자 콘솔 > 플랫폼 > Web 사이트 도메인에 **지금 열고 있는 주소**가 등록돼 있는지
- 네트워크 탭에서 `dapi.kakao.com` 요청이 4xx 를 받지 않는지

> `config.js` 주석은 이 키의 허용 도메인이 `localhost:8000` 뿐이라고 적어 두었지만,
> 확인해 보면 `:5500` 과 `file://` 에서도 타일이 정상 수신됐습니다. 주석 쪽이 낡았습니다.
> 그래도 도메인 등록은 키마다 다르니 안 뜨면 여기부터 보세요.

---

## 2. 계측 훅 넣기

카카오 핸들 `kkMap` 은 `map.js` 클로저 안에 있고 `HW.createMap()` 이 돌려주는 공개 API
에도 없습니다. **밖에서는 카카오 투영에 질문을 할 수 없어서** 코드에 임시로 훅을 넣어야
합니다.

`assets/js/map.js` 의 `syncKakao()` 에서 `alignKakao(sw, ne);` **바로 뒤**에 붙입니다.

```js
  /* [임시 계측] 배경 정합 잔차 — 측정이 끝나면 반드시 지웁니다 */
  try {
    var _proj = kkMap.getProjection();
    var _t = global.getComputedStyle(kkInner).transform;   // .kakaomap-inner 는 transform-origin:0 0
    var _m = (!_t || _t === 'none') ? [1, 0, 0, 1, 0, 0]
      : _t.slice(_t.indexOf('(') + 1, -1).split(',').map(Number);
    var _sx = _m[0], _sy = _m[3], _tx = _m[4], _ty = _m[5];
    var _W = kkInner.clientWidth, _H = kkInner.clientHeight, _worst = 0, _at = '';
    for (var _i = 0; _i < 3; _i++) for (var _j = 0; _j < 3; _j++) {
      var _fx = _i / 2, _fy = _j / 2;
      var _ll = C.unproject(zoom.x + zoom.w * _fx, zoom.y + zoom.h * _fy);
      var _p = _proj.containerPointFromCoords(new global.kakao.maps.LatLng(_ll.lat, _ll.lon));
      var _dx = (_tx + _sx * _p.x) - _W * _fx, _dy = (_ty + _sy * _p.y) - _H * _fy;
      var _d = Math.sqrt(_dx * _dx + _dy * _dy);
      if (_d > _worst) { _worst = _d; _at = _fx + ',' + _fy; }
    }
    global.__kkProbe = {
      level: kkMap.getLevel(),                     // 카카오가 고른 정수 줌 레벨
      vbW: +zoom.w.toFixed(1),                     // SVG viewBox 폭(연속값)
      sx: +_sx.toFixed(4), sy: +_sy.toFixed(4),    // alignKakao 가 실제로 건 보정 배율
      offPx: +_worst.toFixed(2),                   // 3×3 표본점 중 최대 어긋남(px)
      at: _at                                      // 그 지점 (0,0=좌상단 · 1,1=우하단)
    };
  } catch (e) { global.__kkProbe = { error: String(e) }; }
```

**하는 일** — 화면을 3×3 으로 나눈 9개 지점에서, 우리가 그 자리에 있어야 한다고 보는
경위도를 카카오 투영에 물어 화면 좌표를 받고, 거기에 `alignKakao` 가 건 CSS 변형을
적용한 뒤 **실제로 몇 px 어긋나는지**를 잽니다. 그중 최대값이 `offPx` 입니다.

측정이 끝나면 반드시 되돌립니다.

```bash
git diff assets/js/map.js     # 훅만 들어갔는지 확인
git checkout assets/js/map.js
```

---

## 3. 손으로 읽기

새로고침한 뒤 확대·드래그하면서 콘솔에서 읽습니다. 확대 단계마다 값이 갱신됩니다.

```js
__kkProbe
// { level: 5, vbW: 34.7, sx: 1.7742, sy: 1.7742, offPx: 0.41, at: '0.5,0.5' }
```

**보는 값은 `offPx` 하나입니다.** 모든 확대 단계에서 **한 자릿수 px** 를 넘지 않으면
정상입니다(`00acdee` 실측 기준: 수정 후 1.7~7.4px).

### ⚠️ 보정 배율 `sx`·`sy` 가 1 이 아닌 것은 정상입니다

`alignKakao` 는 카카오 줌 레벨을 바꾸는 게 아니라 **남는 차이를 CSS 변형으로 메웁니다.**
그래서 "요청 경도폭 대비 실제 경도폭"(`getBounds()` 비율, 예전 문서의 `k`)은 고친
뒤에도 첫 화면에서 2배 가까이 나옵니다.

**그 비율을 합격 기준으로 쓰면 멀쩡한 화면을 불합격으로 읽습니다.** 판정은 `offPx` 로만
하세요. 참고로 수정 전 `k` 는 확대 단계에 따라 톱니처럼 움직였습니다 — viewBox 는 연속으로
줄어드는데 카카오 레벨은 계단이라, k 가 1.14 → 1.82 로 벌어지다 레벨이 한 칸 떨어지면
리셋됩니다. 첫 화면은 세로가 먼저 걸려 2.06 까지 갔습니다.

---

## 4. 자동으로 재기 (Playwright)

확대 단계별로 한 번에 뽑습니다. **Playwright 는 이 저장소의 의존성이 아닙니다** —
잴 때만 따로 깔고 끝나면 지웁니다.

```bash
npm i playwright && npx playwright install chromium
node kkmeasure.js
```

```js
// kkmeasure.js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:5500/index.html?server=http://127.0.0.1:8000',
               { waitUntil: 'load' });
  await p.waitForTimeout(5500);   // 타일 판정(5초 타임아웃)이 끝나기를 기다립니다

  const kk = await p.evaluate(() => document.querySelector('#map').classList.contains('kkmode'));
  console.log('카카오 타일 로드(kkmode) =', kk);
  if (!kk) { console.log('배경이 없습니다 — 1장부터 다시 보세요.'); await b.close(); return; }

  const read = () => p.evaluate(() => window.__kkProbe || null);
  const rows = [['로드', await read()]];

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

  console.log('단계'.padEnd(12) + 'viewBox폭  카카오레벨    보정배율    최대어긋남  위치');
  rows.forEach(([k, v]) => {
    if (!v || v.error) return console.log(k.padEnd(12) + ' (probe 없음: ' + (v && v.error) + ')');
    console.log(k.padEnd(12) + String(v.vbW).padStart(8) + String(v.level).padStart(11) +
      ('×' + v.sx.toFixed(3)).padStart(12) + (v.offPx.toFixed(2) + 'px').padStart(12) +
      '  ' + v.at);
  });
  await b.close();
})();
```

백엔드가 프론트를 `/app/` 으로 서빙 중이면 URL 을 `http://localhost:8000/app/` 로 바꾸고
`?server=` 는 빼도 됩니다.

---

## 5. 눈으로도 봅니다

숫자가 통과해도 이 셋은 사람이 봐야 합니다.

1. **드래그** — 지도를 천천히 크게 끌었을 때 격자·읍면동 경계선과 배경 건물·도로가
   같은 속도로 밀리는가. 배경이 뒤처지면 정합이 아니라 이벤트 동기화 문제입니다.
2. **확대** — 화성호 해안선이나 병점역 일대를 화면 중앙에 두고 휠로 3~4단 확대할 때
   SVG 해안선과 배경 해안선이 벌어졌다 붙었다 하지 않는가.
3. **격자 클릭** — 한 칸을 클릭해 확대한 뒤, 그 칸 안에 보이는 건물·단지가 카카오맵
   본사이트에서 같은 좌표를 찍었을 때와 **같은 동네인가.**

격자를 클릭한 `.zdetail` 상태에서는 CSS 가 SVG 육지·바다를 투명하게 만들어 배경이
그대로 드러나므로 어긋남이 가장 잘 보입니다.

**네 모서리에서 확인하세요.** 중앙만 보면 속습니다 — 배율만 어긋나고 중심은 맞는 경우
화면 중앙은 멀쩡해 보이는데 가장자리가 틀어집니다.

---

## 6. 합격 기준

| 항목 | 기준 |
|---|---|
| `offPx` (전 확대 단계) | 한 자릿수 px 이내 |
| 드래그 시 배경 추종 | 격자와 같은 속도 |
| 격자 클릭 확대 후 건물 위치 | 카카오맵 본사이트와 같은 동네 |
| 네 모서리 | 중앙과 같은 수준 |
| 콘솔 에러 | 0건 |
| 첫 화면 타일 선명도 | 뭉개지지 않음 (배율이 2 근처라 확인 필요) |

마지막 항목은 `00acdee` 커밋 기록에 명시 검증이 없습니다 — 이번에 같이 봐 주세요.

---

## 7. 어긋난다면 — 확인할 곳

정합 로직은 `assets/js/map.js` 두 함수입니다.

| 위치 | 하는 일 |
|---|---|
| `syncKakao()` | SVG viewBox 창의 경위도를 구해 `kkMap.setBounds()` 호출 → `alignKakao()` |
| `alignKakao()` | 카카오 투영에 두 모서리 화면 좌표를 물어 아핀(배율+평행이동)을 계산해 `.kakaomap-inner` 에 CSS 변형으로 적용 |

**구조상 주의할 점 둘.**

- 변형은 `.kakaomap` 이 아니라 **안쪽 `.kakaomap-inner`** 에 겁니다. 바깥에 걸면
  클리핑 상자까지 같이 커져 배경이 지도 카드 밖으로 삐져나옵니다(`.mapbox` 에 overflow 가 없습니다).
- 위도 비율(Δ카카오/Δ우리)로 세로 배율을 계산하는 방식은 **안 됩니다.** 카카오가
  메르카토르라 화면 y 가 위도에 비선형이어서 첫 화면에 6.8px 가 남았습니다.
  투영에 직접 물으면 그 비선형이 값 안에 이미 반영됩니다.

`getProjection()` 이나 `containerPointFromCoords` 가 없는 SDK 버전에서는 `alignKakao` 가
조용히 무보정으로 빠집니다 — 그 경우 어긋남이 수정 전 수준(수십~수백 px)으로 돌아옵니다.
`__kkProbe.error` 를 먼저 보세요.

---

## 8. 참고 수치

정본은 실서버 `/api/v1/meta` 이고 아래는 2026-08-13 응답 기준입니다.

| 항목 | 값 |
|---|---|
| `map.viewBox` | `[0, 0, 960, 640]` |
| bbox | `[126.53771, 37.01994, 127.15638, 37.29048]` |
| 전체 경도폭 | 0.61867° ≈ 54,890 m |
| 1 SVG 사용자 단위 | ≈ 60.2 m (1km 격자 ≈ 16.6 단위) |
| 격자 | 1km · 786칸 |

**폭을 960 으로 나누면 틀립니다.** `core.js` 의 투영은 사방에 `pad` 24 를 남기고 가로·세로
중 빡빡한 쪽에 맞추는데, 화성시 bbox 는 가로가 지배해서 실제로 쓰이는 폭은 **912 단위**
입니다 — 54,890 m ÷ 912 = 60.2 m 입니다.

**`index.html` 의 `viewBox="0 0 960 580"` 은 폴백입니다.** `map.js` 는 `meta.map.viewBox` 를
먼저 쓰고 없을 때만 이 값으로 떨어지므로, 서버가 붙은 화면에서 실제로 쓰이는 값은
**960×640** 입니다. 정적 HTML 만 보고 세로를 580 으로 잡으면 어긋납니다.
