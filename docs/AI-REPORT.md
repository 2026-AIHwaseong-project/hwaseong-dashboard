# AI 보고서 생성 — Claude API 호출 규격

`POST /api/v1/reports/draft` 를 백엔드에서 구현할 때 참고하는 문서입니다.

> **핵심**: 프론트엔드가 보내준 **숫자**를 Claude가 **공문 문장**으로 바꿔 주고,
> 결과를 정해진 JSON 스키마로 받아 그대로 돌려주면 됩니다.
> 프론트엔드는 그 JSON을 한글(.rtf)·엑셀(.xlsx) 파일로 만듭니다.

---

## 0. 절대 하면 안 되는 것

**API 키를 프론트엔드에 두지 마세요.** `assets/js/` 안에 키를 넣으면
브라우저 개발자도구에서 그대로 보입니다. Claude 호출은 **반드시 백엔드에서만** 합니다.

```
브라우저 ──POST /api/v1/reports/draft──▶ 백엔드 ──Claude API──▶ Anthropic
                                          (여기에만 API 키)
```

---

## 1. 모델과 파라미터

| 항목 | 값 | 이유 |
|---|---|---|
| 모델 | **`claude-opus-5`** | 현재 기본 모델. 문서 작성 품질이 가장 높음 |
| 사고(thinking) | `{"type": "adaptive"}` | Opus 5는 기본으로 켜져 있음. 명시해도 동일 |
| effort | `output_config.effort = "high"` | 보고서는 품질이 중요. 비용을 줄이려면 `medium` |
| max_tokens | `16000` | 이보다 크게 잡으려면 **스트리밍 필수**(HTTP 타임아웃) |
| 구조화 출력 | `output_config.format` (JSON Schema) | 응답이 항상 파싱 가능한 JSON 이 되도록 |
| 프롬프트 캐싱 | 시스템 프롬프트에 `cache_control` | 같은 시스템 프롬프트 반복 → 비용 최대 90% 절감 |

설치:

```bash
pip install anthropic
export ANTHROPIC_API_KEY="sk-ant-..."
```

> 옛 파라미터를 쓰지 마세요. `temperature` / `top_p` / `top_k` 와
> `thinking={"type":"enabled","budget_tokens":N}` 은 Opus 5에서 **400 오류**가 납니다.
> 사고 깊이는 `output_config.effort` 로 조절합니다.

---

## 2. 응답 스키마 (Pydantic)

프론트엔드가 기대하는 형태 그대로입니다. `docs/API.md` §3.7 과 동일합니다.

```python
from typing import List, Union
from pydantic import BaseModel, Field

class Section(BaseModel):
    key: str = Field(description="summary|status|problem|plan|effect|next 중 하나")
    heading: str = Field(description="'1. 검토 개요' 처럼 번호가 붙은 소제목")
    body: str = Field(description="본문. 문단 구분은 개행문자 하나로.")
    bullets: List[str] = Field(description="근거 항목. 숫자를 반드시 포함시킬 것.")

class Table(BaseModel):
    key: str
    title: str
    columns: List[str]
    rows: List[List[Union[str, int, float]]]

class ReportDraft(BaseModel):
    title: str
    subtitle: str
    sections: List[Section]
    tables: List[Table]
```

---

## 3. 시스템 프롬프트

앞부분은 **고정**입니다. 고정된 부분에만 `cache_control` 을 걸어야 캐시가 맞습니다.
날짜·시간대처럼 매번 바뀌는 값을 여기에 넣으면 캐시가 전부 깨집니다 — 그런 값은
사용자 메시지 쪽에 넣으세요.

```python
SYSTEM_PROMPT = """\
당신은 지방자치단체 교통정책과의 정책 보고서를 작성하는 실무 담당자입니다.
대중교통 수요·공급 분석 결과를 받아 결재용 검토 보고서 초안을 작성합니다.

[문체]
- 공문서 문체를 사용합니다. '~하였다', '~로 확인되었다', '~을 제안한다'.
- 구어체, 감탄사, 이모지, 마케팅 표현을 쓰지 않습니다.
- 한 문단은 3~4문장을 넘기지 않습니다.

[근거]
- 제공된 수치만 사용합니다. 주어지지 않은 값을 지어내지 않습니다.
- 모든 주장에는 수치 근거를 붙입니다. "수요가 많다"가 아니라
  "수요지수 72로 상위 5% 수준이다" 처럼 씁니다.
- 수치는 천 단위 콤마를 넣고 단위를 명시합니다(개, 통행/일, 원).
- 추정값에는 '추정', '~로 산정되었다' 처럼 불확실성을 드러냅니다.

[지표 해석 기준]
- MI(미스매칭 지수) = z(수요) − z(공급). 양수가 클수록 공급 부족.
- 고수요·저공급(need) = 노선 증차 또는 정류장 신설 대상.
- 저수요·저공급(drt) = 정규 노선보다 수요응답형(똑버스)이 적합.
- 저수요·고공급(over) = 배차 재배분 등 효율화 검토 대상.
- 고령인구비가 높은 격자는 이동권 보장 관점에서 우선순위를 높입니다.

[구성]
sections 는 정확히 6개이며 key 와 heading 은 다음을 따릅니다.
  summary → '1. 검토 개요'
  status  → '2. 현황 분석'
  problem → '3. 도출된 문제점'
  plan    → '4. 개선 방안'
  effect  → '5. 기대 효과'
  next    → '6. 향후 조치 계획'

[표]
- 입력으로 받은 우선순위·배치·효과 데이터를 표로 정리합니다.
- title 은 엑셀 시트명이 되므로 31자 이내로 짓습니다.
"""
```

---

## 4. 구현

### 4.1 권장 — `messages.parse()` + Pydantic

응답이 자동으로 검증·파싱됩니다.

```python
import json
from anthropic import Anthropic

client = Anthropic()   # ANTHROPIC_API_KEY 환경변수를 읽습니다

def build_user_message(req: dict) -> str:
    """프론트엔드가 보낸 숫자를 Claude가 읽을 수 있는 형태로 정리"""
    ctx = req.get("context", {})
    period_names = {"am": "출근(07–09)", "day": "낮(09–17)",
                    "pm": "퇴근(17–19)", "night": "심야(22–24)"}
    parts = [
        f"[분석 대상] {ctx.get('org','화성시')} {ctx.get('dept','교통정책과')}",
        f"[분석 시간대] {period_names.get(req.get('period'), req.get('period'))}",
        "",
        "[전체 지표]",
        json.dumps(ctx.get("kpi"), ensure_ascii=False, indent=2),
        "",
        "[노선 조정 우선순위 상위 격자]",
        json.dumps(ctx.get("priorities"), ensure_ascii=False, indent=2),
    ]
    sim = ctx.get("simulation")
    if sim:
        parts += [
            "",
            "[배치 시뮬레이션 결과]",
            "아래 시나리오의 배치 내역·소요액·기준선 대비 효과를 4·5장에 반영하십시오.",
            json.dumps({
                "name": sim.get("name"),
                "placements": sim.get("placements"),
                "cost": sim.get("cost"),
                "budgetKrw": sim.get("budgetKrw"),
                "periods": sim.get("periods"),
                "effectiveness": sim.get("effectiveness"),
            }, ensure_ascii=False, indent=2),
        ]
    else:
        parts += ["", "[배치 시뮬레이션] 없음. 4장은 격자 특성별 일반 대응 방안으로 작성하십시오."]
    parts += ["", "위 자료로 검토 보고서 초안을 작성하십시오."]
    return "\n".join(parts)


def draft_report(req: dict) -> dict:
    response = client.messages.parse(
        model="claude-opus-5",
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=[{
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},   # 고정 부분만 캐시
        }],
        messages=[{"role": "user", "content": build_user_message(req)}],
        output_format=ReportDraft,
    )

    # 안전장치: 정책상 거절되면 content 가 비어 있을 수 있습니다
    if response.stop_reason == "refusal":
        raise RuntimeError("모델이 요청을 거절했습니다. 입력 데이터를 확인하세요.")

    draft: ReportDraft = response.parsed_output

    # 프론트엔드가 기대하는 필드를 덧붙여 반환
    from datetime import datetime
    return {
        **draft.model_dump(),
        "org": req.get("context", {}).get("org", "화성시"),
        "dept": req.get("context", {}).get("dept", "교통정책과"),
        "period": req.get("period", "am"),
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "model": response.model,
        "disclaimer": "본 문서는 AI가 자동 생성한 초안입니다. 담당자 검토 후 활용하시기 바랍니다.",
    }
```

### 4.2 FastAPI 연결

```python
from fastapi import FastAPI, HTTPException
import anthropic

app = FastAPI()

@app.post("/api/v1/reports/draft")
def post_report_draft(req: dict):
    try:
        return draft_report(req)
    except anthropic.RateLimitError:
        raise HTTPException(429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"AI 서비스 오류: {e.message}")
    except Exception as e:
        raise HTTPException(500, str(e))
```

프론트엔드는 응답 본문의 `message` / `detail` 필드를 찾아 모달에 그대로 보여 줍니다.

### 4.3 Node/TypeScript 를 쓴다면

```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();

const Section = z.object({
  key: z.string(), heading: z.string(), body: z.string(), bullets: z.array(z.string()),
});
const ReportDraft = z.object({
  title: z.string(), subtitle: z.string(),
  sections: z.array(Section),
  tables: z.array(z.object({
    key: z.string(), title: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number()]))),
  })),
});

const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high", format: zodOutputFormat(ReportDraft) },
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: buildUserMessage(req) }],
});
const draft = res.parsed_output!;
```

---

## 5. 비용·속도 관리

| 상황 | 대응 |
|---|---|
| 응답이 20초 이상 걸림 | 정상입니다. 프론트엔드 타임아웃은 120초로 잡혀 있습니다(`TIMEOUT_MS_REPORT`) |
| 더 빠르게 하고 싶다 | `output_config.effort` 를 `"medium"` 또는 `"low"` 로 |
| 비용을 줄이고 싶다 | ① 시스템 프롬프트 캐싱 유지 ② `effort` 낮추기 ③ 같은 입력이면 결과 캐시 |
| 캐시가 안 먹는 것 같다 | 응답의 `usage.cache_read_input_tokens` 확인. 0이면 시스템 프롬프트에 매번 바뀌는 값(날짜 등)이 섞인 것 |
| 데모 중 API 장애 | `config.js` 의 `ENDPOINT_OVERRIDES: { 'reports.draft': true }` 로 그 경로만 목으로 되돌릴 수 있습니다 |

동일 입력에 대한 캐시 예시:

```python
import hashlib, json
_cache = {}

def draft_report_cached(req: dict) -> dict:
    key = hashlib.sha256(json.dumps(req, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if key not in _cache:
        _cache[key] = draft_report(req)
    return _cache[key]
```

---

## 6. 품질 점검

생성된 보고서를 아래 기준으로 확인하세요. 어긋나면 시스템 프롬프트를 조정합니다.

- [ ] `sections` 가 정확히 6개이고 heading 번호가 1~6 이다
- [ ] 각 `body` 가 공문 문체다 (`~하였다` / `~로 확인되었다`)
- [ ] 입력에 없는 숫자가 등장하지 않는다 ← **가장 중요**
- [ ] `bullets` 에 수치가 들어 있다
- [ ] 시뮬레이션을 함께 보냈을 때 4·5장이 그 배치안 내용을 반영한다
- [ ] `tables[].rows` 의 길이가 `columns` 길이와 같다
- [ ] `tables[].title` 이 31자 이내다

**입력에 없는 숫자가 나오는 경우** 가 발견되면 시스템 프롬프트에 한 줄 추가하세요.

> "제공된 JSON 에 없는 수치는 어떤 경우에도 쓰지 마십시오.
> 필요한 값이 없으면 그 문장을 쓰지 말고 넘어가십시오."

---

## 7. 참고

- Claude API 문서: <https://platform.claude.com/docs>
- 구조화 출력: `output_config.format` (`output_format` 파라미터는 폐기됨)
- 프롬프트 캐싱: Opus 5는 최소 512토큰부터 캐시됩니다
- 모델 목록·가격: <https://platform.claude.com/docs/en/about-claude/models/overview>
