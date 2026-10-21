"""실서버 응답을 archive/ 에 녹화합니다 — 서버 없이 화면을 띄우는 보관판용.

    REPORT_PROVIDER=claude python tools/record-archive.py [http://127.0.0.1:8000]

백엔드를 로컬에서 띄워 두고 실행합니다. 보고서 예시는 그 서버의 AI 키로 만들어지고,
REPORT_PROVIDER 로 프로바이더를 고를 수 있습니다(기본 auto). 키가 죽어 있으면 규칙
기반 초안이 녹화되니 끝에 찍히는 provider 를 확인하세요. 화면은 api.js 의 archiveCall 이 이 파일들을 읽습니다.

용량을 줄이려고 시뮬레이션은 요일별 기준선 1벌 + 배치마다 '바뀐 격자 필드만'
저장합니다(시뮬 응답 1건이 1.5MB 라 통째로 30벌이면 50MB 가 넘습니다).
"""
import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/") + "/api/v1"
OUT = Path(__file__).resolve().parent.parent / "archive"
PERIODS = ["am", "day", "pm", "night"]
DAYTYPES = ["wd", "we"]
STRATEGIES = ["efficiency", "equity", "balance", "quick"]
ALL_TYPES = ["stop", "drt", "freq"]


def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method="POST" if data else "GET",
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as res:
        return json.load(res)


def save(name, obj):
    (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def sim_key(daytype, placements):
    """api.js 의 simKey 와 같은 규칙 — 같은 (수단, 격자)는 수량을 합칩니다."""
    agg = {}
    for p in placements:
        k = (p["type"], p["cellId"])
        agg[k] = agg.get(k, 0) + int(p.get("count") or 1)
    return daytype + "|" + "|".join(f"{t}:{c}:{n}" for (t, c), n in sorted(agg.items()))


def cell_patch(base, sim):
    """기준선 대비 바뀐 격자 필드만 {period: {cellId: {필드: 값}}}"""
    out = {}
    for p, cells in sim["cellsByPeriod"].items():
        by_id = {c["id"]: c for c in base["cellsByPeriod"][p]}
        diff = {}
        for c in cells:
            b = by_id[c["id"]]
            d = {k: v for k, v in c.items() if b.get(k) != v}
            if d:
                diff[c["id"]] = d
        out[p] = diff
    return out


def main():
    OUT.mkdir(exist_ok=True)
    meta = req("/meta")
    save("meta.json", meta)
    save("stops.json", req("/stops"))
    save("routes.json", req("/routes"))
    grids = {}
    for p in PERIODS:
        for dt in DAYTYPES:
            grids[p, dt] = req(f"/grid?period={p}&daytype={dt}")
            save(f"grid_{p}_{dt}.json", grids[p, dt])
            save(f"priorities_{p}_{dt}.json", req(f"/priorities?period={p}&limit=100&daytype={dt}"))
    print("grid·priorities 완료")

    stops = req("/stops")
    ids = [s["id"] for s in (stops["stops"] if isinstance(stops, dict) else stops)]
    profiles = {}
    for sid in ids:
        try:
            profiles[sid] = req(f"/stops/{sid}/profile")
        except urllib.error.HTTPError:
            pass        # 프로필 없는 정류장 — 화면은 404 와 같은 안내를 띄웁니다
    save("profiles.json", profiles)
    print(f"정류장 프로필 {len(profiles)}/{len(ids)}")

    budget = meta["cost"]["defaultBudget"]
    bases = {dt: req("/simulations", {"daytype": dt, "placements": []}) for dt in DAYTYPES}
    for dt, b in bases.items():
        save(f"sim_base_{dt}.json", b)

    # 추천 요청(RecRequest)에는 요일축이 없습니다 — 서버는 항상 평일로 고릅니다.
    # 그래서 추천은 (시간대, 목적)으로만 녹화하고, 그 배치의 시뮬레이션은 평일·주말
    # 둘 다 녹화합니다(시뮬 화면에서 주말로 바꾸면 같은 배치를 주말로 다시 계산).
    sims, recs = {}, {}
    for p in PERIODS:
        for st in STRATEGIES:
            body = {"period": p, "budgetKrw": budget, "maxPlacements": 10, "strategy": st,
                    "allowedTypes": ["stop"] if st == "quick" else ALL_TYPES,
                    "includeAlternatives": True}
            rec = req("/recommendations", body)
            rec.pop("simulation", None)
            pl = [{"type": x["type"], "cellId": x["cellId"], "count": x["count"]}
                  for x in rec.get("placements", [])]
            recs[f"{p}|{st}"] = rec
            for dt in DAYTYPES if pl else []:
                key = sim_key(dt, pl)
                if key in sims:
                    continue
                sim = req("/simulations", {"daytype": dt, "budgetKrw": budget, "placements": pl})
                top = {k: v for k, v in sim.items() if k != "cellsByPeriod"}
                sims[key] = {"top": top, "cells": cell_patch(bases[dt], sim)}
        print(f"추천 {p} 완료")
    save("recommendations.json", recs)
    save("simulations.json", sims)

    reports = {}
    for dt in DAYTYPES:
        for p in PERIODS:
            g = grids[p, dt]
            pri = req(f"/priorities?period={p}&limit=10&daytype={dt}")
            body = {"period": p, "provider": os.environ.get("REPORT_PROVIDER", "auto"), "format": "sections", "tone": "공문",
                    "sections": ["summary", "status", "problem", "plan", "effect", "next"],
                    "context": {"daytype": dt, "kpi": g.get("kpi"), "priorities": pri["items"]}}
            reports[f"{p}|{dt}"] = req("/reports/draft", body)
            print(f"보고서 {dt} {p} 완료 —", reports[f"{p}|{dt}"].get("provider"))
    save("reports.json", reports)

    admin = {k: req(path) for k, path in [("status", "/admin/status"), ("params", "/admin/params"),
                                          ("gridOverrides", "/admin/grid-overrides")]}
    save("admin.json", admin)
    save("manifest.json", {"recordedAt": datetime.now().isoformat(timespec="minutes")})
    print("완료 →", OUT)


if __name__ == "__main__":
    main()
