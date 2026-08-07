#!/usr/bin/env python3
"""SGIS 읍면동 경계 SHP → 화성시 경계 데이터(JS) 생성기

입력 : bnd_dong_00_2025_2Q.shp (+ .dbf .shx .prj .cpg)
       SGIS 통계지리정보서비스 > 자료제공 > 경계 > 읍면동
출력 : assets/data/boundary.js   (window.HW.BOUNDARY 에 담김)
       assets/data/hwaseong-dong.geojson  (참고용 원본 형식)

왜 .js 로 내보내는가
    파일을 fetch 로 읽으면 file:// 로 열었을 때 막히고, 단일 파일 빌드에도
    안 들어갑니다. JS 로 만들어 <script> 로 불러오면 두 경우 다 동작합니다.

실행
    pip install pyshp pyproj
    python3 tools/build-boundary.py
"""

import json
import math
import os
import sys

try:
    import shapefile
    from pyproj import Transformer
except ImportError:
    sys.exit('필요한 라이브러리가 없습니다:  pip install pyshp pyproj')

SHP = 'bnd_dong_00_2025_2Q'
SIGUNGU_CODE = '31240'     # SGIS 기준 화성시 (행정표준코드 41590 과 다름)
SIMPLIFY_DEG = 0.00025     # 약 25m. 시 단위 지도에서는 눈으로 차이가 없습니다.
OUT_JS = 'assets/data/boundary.js'
OUT_GEOJSON = 'assets/data/hwaseong-dong.geojson'


def douglas_peucker(pts, eps):
    """좌표점을 줄이되 모양은 유지합니다(원본 6만 점은 웹에서 너무 무겁습니다)."""
    if len(pts) < 3:
        return pts
    dmax, imax = 0.0, 0
    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy)
    for i in range(1, len(pts) - 1):
        x0, y0 = pts[i]
        d = (abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm) if norm else math.hypot(x0 - x1, y0 - y1)
        if d > dmax:
            dmax, imax = d, i
    if dmax > eps:
        return douglas_peucker(pts[:imax + 1], eps)[:-1] + douglas_peucker(pts[imax:], eps)
    return [pts[0], pts[-1]]


def ring_area_centroid(ring):
    """폴리곤 고리의 면적과 무게중심. 라벨을 실제 도형 중앙에 놓기 위해 씁니다."""
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a *= 0.5
    if abs(a) < 1e-12:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return 0.0, (sum(xs) / len(xs), sum(ys) / len(ys))
    return abs(a), (cx / (6 * a), cy / (6 * a))


def main():
    if not os.path.exists(SHP + '.shp'):
        sys.exit('%s.shp 를 찾을 수 없습니다. 프로젝트 루트에서 실행하세요.' % SHP)

    reader = shapefile.Reader(SHP, encoding='utf-8')
    records = reader.records()
    targets = [i for i, r in enumerate(records) if str(r['ADM_CD']).startswith(SIGUNGU_CODE)]
    if not targets:
        sys.exit('화성시(%s) 레코드를 찾지 못했습니다.' % SIGUNGU_CODE)

    to_wgs84 = Transformer.from_crs('EPSG:5179', 'EPSG:4326', always_xy=True)

    dongs = []
    pts_before = pts_after = 0

    for i in targets:
        shape = reader.shape(i)
        rec = records[i]
        bounds = list(shape.parts) + [len(shape.points)]
        rings = []
        for a, b in zip(bounds[:-1], bounds[1:]):
            seg = shape.points[a:b]
            pts_before += len(seg)
            lonlat = [list(to_wgs84.transform(x, y)) for x, y in seg]
            simplified = douglas_peucker(lonlat, SIMPLIFY_DEG)
            if len(simplified) < 4:          # 아주 작은 섬은 원본 유지
                simplified = lonlat
            if simplified[0] != simplified[-1]:
                simplified.append(simplified[0])
            simplified = [[round(x, 5), round(y, 5)] for x, y in simplified]
            pts_after += len(simplified)
            rings.append(simplified)

        rings.sort(key=len, reverse=True)
        areas = [ring_area_centroid(r) for r in rings]
        main_area, centroid = max(areas, key=lambda t: t[0])

        name = rec['ADM_NM']
        kind = '읍' if name.endswith('읍') else '면' if name.endswith('면') else '동'
        lons = [p[0] for r in rings for p in r]
        lats = [p[1] for r in rings for p in r]

        dongs.append({
            'code': str(rec['ADM_CD']),
            'name': name,
            'kind': kind,
            'rings': rings,
            'centroid': [round(centroid[0], 5), round(centroid[1], 5)],
            'bbox': [round(min(lons), 5), round(min(lats), 5), round(max(lons), 5), round(max(lats), 5)],
            'areaRank': 0,
        })

    dongs.sort(key=lambda d: d['name'])
    lons = [p[0] for d in dongs for r in d['rings'] for p in r]
    lats = [p[1] for d in dongs for r in d['rings'] for p in r]
    bbox = [round(min(lons), 5), round(min(lats), 5), round(max(lons), 5), round(max(lats), 5)]

    payload = {
        'region': '화성시',
        'source': 'SGIS 통계지리정보서비스 읍면동 경계 (%s)' % SHP,
        'crs': 'EPSG:4326',
        'note': 'EPSG:5179 → EPSG:4326 변환 후 약 25m 허용오차로 단순화',
        'bbox': bbox,
        'dongs': dongs,
    }

    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('/* 자동 생성 파일 — 직접 고치지 마세요.\n'
                '   생성: python3 tools/build-boundary.py\n'
                '   출처: %s\n'
                '   화성시 읍면동 %d개 실제 행정경계 (경위도) */\n'
                % (payload['source'], len(dongs)))
        f.write('(function (g) { g.HW = g.HW || {}; g.HW.BOUNDARY = ')
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        f.write('; })(window);\n')

    geojson = {
        'type': 'FeatureCollection',
        'name': '화성시 읍면동 경계',
        'source': payload['source'],
        'features': [{
            'type': 'Feature',
            'properties': {'code': d['code'], 'name': d['name'], 'kind': d['kind']},
            'geometry': ({'type': 'Polygon', 'coordinates': [d['rings'][0]]}
                         if len(d['rings']) == 1
                         else {'type': 'MultiPolygon', 'coordinates': [[r] for r in d['rings']]}),
        } for d in dongs],
    }
    with open(OUT_GEOJSON, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, separators=(',', ':'))

    counts = {}
    for d in dongs:
        counts[d['kind']] = counts.get(d['kind'], 0) + 1
    print('화성시 읍면동 %d개  (%s)' % (len(dongs), ' '.join('%d%s' % (v, k) for k, v in sorted(counts.items()))))
    print('좌표점 %s → %s  (%.1f%%)' % (f'{pts_before:,}', f'{pts_after:,}', 100 * pts_after / pts_before))
    print('경위도 범위 %s' % bbox)
    for path in (OUT_JS, OUT_GEOJSON):
        print('  %-38s %6.0f KB' % (path, os.path.getsize(path) / 1024))


if __name__ == '__main__':
    main()
