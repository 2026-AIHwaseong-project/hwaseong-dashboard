/* ============================================================================
 *  report.js — AI 보고서 생성 및 한글/엑셀 내보내기
 * ----------------------------------------------------------------------------
 *  ▶ 흐름
 *     [AI 보고서 생성] 버튼
 *        → 화면이 현재 컨텍스트(KPI·우선순위·시나리오)를 모아
 *        → HW.api.draftReport() 로 서버에 보내면
 *        → 서버가 Claude API 를 호출해 문단이 채워진 초안 JSON 을 돌려주고
 *        → 이 파일이 미리보기로 렌더링한 뒤 파일로 저장합니다.
 *
 *  ▶ 파일 생성 방식 (config.js 의 EXPORT_MODE)
 *     'client' : 브라우저에서 직접 생성. 외부 라이브러리 없음.
 *                - 엑셀: 진짜 .xlsx (OOXML) — ZIP 컨테이너를 직접 씁니다.
 *                - 한글: RTF 서식 문서 — 한컴오피스에서 바로 열리고,
 *                        [다른 이름으로 저장]에서 .hwp 로 저장하면 됩니다.
 *     'server' : POST /reports/export 로 서버가 만든 파일을 받습니다.
 *                한글 원본 포맷(.hwpx)이 필요하면 이 방식을 쓰세요.
 *     'auto'   : 서버를 먼저 시도하고 실패하면 클라이언트로 폴백합니다.
 * ========================================================================= */
(function (global) {
  'use strict';

  var HW = global.HW = global.HW || {};
  var C = HW.core;
  var CONFIG = HW.CONFIG;
  var esc = C.esc;

  /* ======================================================================
   *  A. ZIP 라이터 (무압축 STORE 방식)
   *     .xlsx 는 XML 파일들을 담은 ZIP 입니다. 압축하지 않아도 규격상 유효하고,
   *     보고서 크기라면 용량 차이도 의미가 없습니다.
   * ==================================================================== */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    /* 구형 브라우저 폴백 */
    var s = unescape(encodeURIComponent(str));
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF;
    return a;
  }

  function ByteWriter() {
    this.chunks = [];
    this.len = 0;
  }
  ByteWriter.prototype.raw = function (u8) { this.chunks.push(u8); this.len += u8.length; return this; };
  ByteWriter.prototype.u16 = function (v) {
    return this.raw(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]));
  };
  ByteWriter.prototype.u32 = function (v) {
    return this.raw(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
  };
  ByteWriter.prototype.concat = function () {
    var out = new Uint8Array(this.len), off = 0;
    for (var i = 0; i < this.chunks.length; i++) { out.set(this.chunks[i], off); off += this.chunks[i].length; }
    return out;
  };

  /** files: [{name:'xl/workbook.xml', text:'...'}] → Uint8Array(ZIP) */
  function zip(files) {
    var out = new ByteWriter();
    var central = [];
    /* 고정 타임스탬프(2026-01-01 00:00) — 같은 입력이면 같은 파일이 나오도록 */
    var DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

    files.forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = f.bytes || utf8(f.text || '');
      var crc = crc32(data);
      var offset = out.len;

      out.u32(0x04034b50).u16(20).u16(0x0800).u16(0)      // 서명/버전/UTF-8플래그/무압축
        .u16(DOS_TIME).u16(DOS_DATE)
        .u32(crc).u32(data.length).u32(data.length)
        .u16(nameBytes.length).u16(0)
        .raw(nameBytes).raw(data);

      central.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset });
    });

    var cdStart = out.len;
    central.forEach(function (e) {
      out.u32(0x02014b50).u16(20).u16(20).u16(0x0800).u16(0)
        .u16(DOS_TIME).u16(DOS_DATE)
        .u32(e.crc).u32(e.size).u32(e.size)
        .u16(e.nameBytes.length).u16(0).u16(0)
        .u16(0).u16(0).u32(0).u32(e.offset)
        .raw(e.nameBytes);
    });
    var cdSize = out.len - cdStart;

    out.u32(0x06054b50).u16(0).u16(0)
      .u16(central.length).u16(central.length)
      .u32(cdSize).u32(cdStart).u16(0);

    return out.concat();
  }

  /* ======================================================================
   *  A-1. 우선순위 막대그래프 — 미리보기·한글·엑셀 셋이 캔버스 하나를 같이 쓴다
   *
   *  SVG 로 그린 뒤 내보내기용으로 다시 래스터화하면 두 벌을 관리하게 됩니다.
   *  <canvas> 로 한 번만 그리고, 화면엔 dataURL 을 <img> 로 박고 한글·엑셀엔
   *  같은 캔버스의 PNG 바이트를 그대로 심습니다 — 그리는 코드가 한 곳입니다.
   * ==================================================================== */
  var CHART_SCALE = 2;   /* 화면 DPI 와 무관하게 항상 2배로 그려 인쇄·확대에도 흐리지 않게 */

  /** draft.meta.cells(엑셀 데이터 시트와 같은 출처 — chat.js 참고)에서 직접 계산합니다.
      AI 가 만든 tables[] 는 형식이 흔들릴 수 있어 차트 값의 출처로 쓰지 않습니다. */
  function priorityChartItems(draft) {
    var cells = (draft.meta && draft.meta.cells) || [];
    var top = cells.filter(function (c) { return typeof c.priorityScore === 'number' && c.priorityScore > 0; })
      .sort(function (a, b) { return b.priorityScore - a.priorityScore; })
      .slice(0, 5);
    /* 지난 기록에는 격자를 보관하지 않습니다. 그때는 meta.priorities(이미 rank
       순 Top 목록)로 같은 막대를 그립니다 — 미리보기·한글·엑셀의 그림이 함께
       살아납니다. 이 필드는 대시보드에서 만든 기록만 갖고 있습니다. */
    if (!top.length) {
      top = ((draft.meta && draft.meta.priorities) || []).filter(function (r) {
        return r && typeof r.priorityScore === 'number' && r.priorityScore > 0;
      }).slice(0, 5);
    }
    if (!top.length) return [];
    var max = top[0].priorityScore;
    return top.map(function (c) { return { name: c.name, score: c.priorityScore, pct: c.priorityScore / max }; });
  }

  /** items 를 캔버스에 그려 {canvas, width, height} 로 돌려줍니다(width/height 는
      논리 픽셀 — 실제 캔버스 픽셀은 CHART_SCALE 배 더 큽니다). */
  function drawPriorityChart(items) {
    var W = 620, rowH = 32, padL = 148, padR = 56, padY = 6;
    var H = padY * 2 + items.length * rowH;
    var canvas = document.createElement('canvas');
    canvas.width = W * CHART_SCALE;
    canvas.height = H * CHART_SCALE;
    var ctx = canvas.getContext('2d');
    ctx.scale(CHART_SCALE, CHART_SCALE);
    ctx.fillStyle = '#ffffff';           /* 한글·엑셀은 다크모드가 없으니 배경을 항상 흰색으로 고정 */
    ctx.fillRect(0, 0, W, H);
    var barMaxW = W - padL - padR;
    items.forEach(function (it, i) {
      var y = padY + i * rowH;
      ctx.textBaseline = 'middle';
      ctx.font = '12px "Malgun Gothic", sans-serif';
      ctx.fillStyle = '#41546E';
      ctx.textAlign = 'right';
      ctx.fillText(it.name, padL - 10, y + rowH / 2);
      var barW = Math.max(3, barMaxW * it.pct);
      ctx.fillStyle = '#0054A6';
      ctx.fillRect(padL, y + 6, barW, rowH - 13);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#12233A';
      ctx.font = 'bold 12px "Malgun Gothic", sans-serif';
      ctx.fillText(it.score.toFixed(1) + '점', padL + barW + 8, y + rowH / 2);
    });
    return { canvas: canvas, width: W, height: H };
  }

  /** dataURL(base64) → 원본 바이트(Uint8Array). xlsx 미디어 파트에 그대로 쓴다. */
  function pngBytes(canvas) {
    var b64 = canvas.toDataURL('image/png').split(',')[1];
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ======================================================================
   *  B. XLSX 생성
   * ==================================================================== */
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      /* XML 1.0 에서 허용되지 않는 제어문자 제거 */
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  function colName(i) {
    var s = '';
    i = i + 1;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function safeSheetName(name, used) {
    var n = String(name || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
    var base = n, i = 2;
    while (used[n]) { n = (base.slice(0, 28) + '(' + i + ')'); i++; }
    used[n] = true;
    return n;
  }

  /**
   * sheets: [{ name, cols:[너비...], rows:[ [값,...] ... ], headerRows:1 }]
   * 값이 number 면 숫자 셀, 아니면 문자열 셀로 씁니다.
   */
  /** chart 가 있으면 0번째 시트(sheetIndex, 기본 0)에 그림으로 심는다. */
  function buildXlsx(sheets, chart, sheetIndex) {
    sheetIndex = sheetIndex || 0;
    var used = {};
    sheets = sheets.map(function (s) {
      return { name: safeSheetName(s.name, used), cols: s.cols || [], rows: s.rows || [], headerRows: s.headerRows == null ? 1 : s.headerRows, cf: s.cf };
    });

    var files = [];

    files.push({
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        (chart ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        (chart ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>'
    });

    files.push({
      name: '_rels/.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>'
    });

    files.push({
      name: 'docProps/core.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>' + xmlEsc(CONFIG.APP.name) + '</dc:title>' +
        '<dc:creator>' + xmlEsc(CONFIG.APP.org + ' ' + CONFIG.APP.dept) + '</dc:creator>' +
        '<cp:lastModifiedBy>' + xmlEsc(CONFIG.APP.org) + '</cp:lastModifiedBy>' +
        '</cp:coreProperties>'
    });

    files.push({
      name: 'docProps/app.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>' + xmlEsc(CONFIG.APP.shortName) + '</Application></Properties>'
    });

    files.push({
      name: 'xl/workbook.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function (s, i) {
          return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('') +
        '</sheets></workbook>'
    });

    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'
    });

    files.push({
      name: 'xl/styles.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="3">' +
        '<font><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>' +
        '<font><b/><sz val="10"/><color rgb="FF1F1F1F"/><name val="맑은 고딕"/><family val="2"/></font>' +
        '<font><b/><sz val="13"/><name val="맑은 고딕"/><family val="2"/></font>' +
        '</fonts>' +
        '<fills count="3">' +
        '<fill><patternFill patternType="none"/></fill>' +
        '<fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFECEBE4"/><bgColor indexed="64"/></patternFill></fill>' +
        '</fills>' +
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBEB6"/></bottom><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                        /* 0 일반 */
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' + /* 1 표머리 */
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                          /* 2 제목 */
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' + /* 3 본문(줄바꿈) */
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
    });

    /** s.cf: [{sqref:'F2:F787', colors:[minRGB, midRGB, maxRGB]}] → 3색 색상 스케일.
        새 관계(rels) 파트가 필요 없습니다 — 시트 XML 안에 색이 그대로 들어갑니다. */
    function condFmtXml(cf) {
      return (cf || []).map(function (r) {
        return '<conditionalFormatting sqref="' + r.sqref + '">' +
          '<cfRule type="colorScale" priority="1"><colorScale>' +
          '<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>' +
          '<color rgb="' + r.colors[0] + '"/><color rgb="' + r.colors[1] + '"/><color rgb="' + r.colors[2] + '"/>' +
          '</colorScale></cfRule></conditionalFormatting>';
      }).join('');
    }

    sheets.forEach(function (s, si) {
      var maxCols = 0;
      s.rows.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
      var cols = '';
      if (s.cols && s.cols.length) {
        cols = '<cols>' + s.cols.map(function (w, i) {
          return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
        }).join('') + '</cols>';
      }
      var rowsXml = s.rows.map(function (row, ri) {
        var cells = row.map(function (v, ci) {
          var ref = colName(ci) + (ri + 1);
          /* 30자 넘는 글은 줄바꿈(스타일 3). 한글은 전각이라 열 폭 한 칸에 반 글자만
             들어갑니다 — 60자 기준이던 때는 43자짜리 비고 문장이 줄바꿈 없이 옆으로
             흘러 인쇄하면 뒷부분만 다음 장에 찍혔습니다(실측). */
          var style = ri < s.headerRows ? 1 : (typeof v === 'string' && v.length > 30 ? 3 : 0);
          if (v == null || v === '') return '<c r="' + ref + '" s="' + style + '"/>';
          if (typeof v === 'number' && isFinite(v)) {
            return '<c r="' + ref + '" s="' + style + '"><v>' + v + '</v></c>';
          }
          if (v && v.__title) {
            return '<c r="' + ref + '" s="2" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v.__title) + '</t></is></c>';
          }
          return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
        }).join('');
        return '<row r="' + (ri + 1) + '">' + cells + '</row>';
      }).join('');

      var hasChart = chart && si === sheetIndex;
      files.push({
        name: 'xl/worksheets/sheet' + (si + 1) + '.xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheetViews><sheetView' + (si === 0 ? ' tabSelected="1"' : '') + ' workbookViewId="0"/></sheetViews>' +
          '<sheetFormatPr defaultRowHeight="15"/>' + cols +
          '<sheetData>' + rowsXml + '</sheetData>' +
          condFmtXml(s.cf) +
          '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
          (hasChart ? '<drawing r:id="rId1"/>' : '') +
          '</worksheet>'
      });
      if (hasChart) {
        files.push({
          name: 'xl/worksheets/_rels/sheet' + (si + 1) + '.xml.rels',
          text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
            '</Relationships>'
        });
      }
    });

    /* 그림 — 새 xlsx 파트 4개(그림 바이트·앵커·관계 2개)가 더 필요합니다.
       cx/cy 는 EMU(1px@96dpi = 9525EMU) — 논리 크기(chart.width/height)로 정해야
       CHART_SCALE 로 키워 그린 만큼 화면에서 커지지 않고 원래 의도한 크기로 뜹니다. */
    if (chart) {
      var cx = Math.round(chart.width * 9525), cy = Math.round(chart.height * 9525);
      files.push({ name: 'xl/media/image1.png', bytes: pngBytes(chart.canvas) });
      files.push({
        name: 'xl/drawings/drawing1.xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<xdr:oneCellAnchor>' +
          '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + (chart.anchorRow || 0) +
          '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
          '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>' +
          '<xdr:pic>' +
          '<xdr:nvPicPr><xdr:cNvPr id="1" name="우선순위 막대그래프"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
          '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
          '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
          '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'
      });
      files.push({
        name: 'xl/drawings/_rels/drawing1.xml.rels',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
          '</Relationships>'
      });
    }

    return new Blob([zip(files)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /* ======================================================================
   *  C. RTF 생성 (한글/한컴오피스에서 열림)
   * ==================================================================== */
  /** 한글 등 비ASCII 문자를 RTF \uN? 이스케이프로 변환 */
  function rtfText(s) {
    s = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], code = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '{') out += '\\{';
      else if (ch === '}') out += '\\}';
      else if (ch === '\n') out += '\\par ';
      else if (ch === '\r') { /* 무시 */ }
      else if (ch === '\t') out += '\\tab ';
      else if (code < 128) out += ch;
      else {
        /* RTF \u 는 부호 있는 16비트. 32767 초과분은 음수로 표기해야 한글이 정확히 읽습니다. */
        var v = code > 32767 ? code - 65536 : code;
        out += '\\u' + v + '?';
      }
    }
    return out;
  }

  var TWIP_USABLE = 9638;  /* A4 210mm - 좌우 여백 20mm 씩 */

  function rtfTable(columns, rows) {
    var n = columns.length;
    if (!n) return '';
    /* 첫 열은 조금 넓게, 나머지 균등 */
    var widths = [], base = Math.floor(TWIP_USABLE / n);
    for (var i = 0; i < n; i++) widths.push(base);
    var acc = 0, edges = widths.map(function (w) { acc += w; return acc; });
    edges[n - 1] = TWIP_USABLE;

    function rowRtf(cells, bold) {
      var s = '\\trowd\\trgaph80\\trleft0';
      for (var i = 0; i < n; i++) {
        s += '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
        if (bold) s += '\\clcbpat15';
        s += '\\cellx' + edges[i];
      }
      for (var j = 0; j < n; j++) {
        var v = cells[j] == null ? '' : cells[j];
        s += '\\pard\\intbl\\fs17' + (bold ? '\\b' : '') + ' ' + rtfText(v) + (bold ? '\\b0' : '') + '\\cell ';
      }
      return s + '\\row\n';
    }

    var out = rowRtf(columns, true);
    rows.forEach(function (r) { out += rowRtf(r, false); });
    return out + '\\pard\\par\n';
  }

  /** 캔버스 PNG 를 RTF \pict 로 심는다. \pngblip 은 워드·한컴오피스가 다 읽는
      표준 컨트롤워드라 옛 RTF 방식(비트맵을 손수 인코딩)을 안 써도 된다.
      picw/pich 는 실제 픽셀(원본 크기), picwgoal/pichgoal 은 화면에 그릴 목표
      크기(트윕, 1px@96dpi = 15트윕) — 캔버스는 CHART_SCALE 배로 그렸으므로 목표
      크기는 논리 크기(width/height)로 정해야 원래 의도한 만큼만 차지한다. */
  function rtfPicture(chart) {
    var hex = '', bin = atob(chart.canvas.toDataURL('image/png').split(',')[1]);
    for (var i = 0; i < bin.length; i++) {
      var h = bin.charCodeAt(i).toString(16);
      hex += h.length < 2 ? '0' + h : h;
    }
    var lines = [];
    for (var j = 0; j < hex.length; j += 128) lines.push(hex.slice(j, j + 128));
    return '{\\pict\\pngblip\\picw' + chart.canvas.width + '\\pich' + chart.canvas.height +
      '\\picwgoal' + Math.round(chart.width * 15) + '\\pichgoal' + Math.round(chart.height * 15) +
      '\n' + lines.join('\n') + '}';
  }

  function buildRtf(draft) {
    var b = '';
    b += '{\\rtf1\\ansi\\ansicpg949\\deff0\\uc1\n';
    b += '{\\fonttbl{\\f0\\fnil\\fcharset129 \\\'b8\\\'bc\\\'c0\\\'ba \\\'b0\\\'ed\\\'b5\\\'f1;}{\\f1\\fnil\\fcharset129 Malgun Gothic;}}\n';
    b += '{\\colortbl;\\red0\\green0\\blue0;\\red90\\green90\\blue90;}\n';
    b += '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\n';
    b += '\\f1\\fs20\n';

    /* 제목 */
    b += '\\pard\\qc\\b\\fs32 ' + rtfText(draft.title) + '\\b0\\par\n';
    if (draft.subtitle) b += '\\pard\\qc\\fs20\\cf2 ' + rtfText(draft.subtitle) + '\\cf1\\par\n';
    b += '\\pard\\qc\\fs17\\cf2 ' + rtfText((draft.org || '') + (draft.dept ? ' ' + draft.dept : '') +
      '   |   작성일 ' + C.korDate((draft.generatedAt || '').slice(0, 10))) + '\\cf1\\par\\par\n';

    /* 우선순위 막대그래프 — 미리보기와 같은 캔버스 */
    var chartItems = priorityChartItems(draft);
    if (chartItems.length) {
      var chart = drawPriorityChart(chartItems);
      b += '\\pard\\b\\fs20 ' + rtfText('노선 조정 우선순위 Top ' + chartItems.length) + '\\b0\\par\n';
      b += '\\pard\\qc ' + rtfPicture(chart) + '\\par\\par\n';
    }

    /* 본문 */
    (draft.sections || []).forEach(function (s) {
      b += '\\pard\\b\\fs24 ' + rtfText(s.heading) + '\\b0\\par\n';
      if (s.body) {
        String(s.body).split('\n').forEach(function (para) {
          if (!para.trim()) return;
          b += '\\pard\\fi400\\sa120\\fs20 ' + rtfText(para) + '\\par\n';
        });
      }
      (s.bullets || []).forEach(function (li) {
        b += '\\pard\\li400\\fi-200\\sa60\\fs20 \\bullet\\tab ' + rtfText(li) + '\\par\n';
      });
      b += '\\pard\\par\n';
    });

    /* 표 */
    (draft.tables || []).forEach(function (t) {
      b += '\\pard\\b\\fs20 [' + rtfText(t.title) + ']\\b0\\par\n';
      b += rtfTable(t.columns || [], t.rows || []);
    });

    if (draft.disclaimer) {
      b += '\\pard\\par\\brdrt\\brdrs\\brdrw10\\brsp20\\par\n';
      b += '\\pard\\fs16\\cf2 ' + rtfText('※ ' + draft.disclaimer) + '\\cf1\\par\n';
    }

    b += '}';
    return new Blob([b], { type: 'application/rtf' });
  }

  /* ======================================================================
   *  D. 초안 → 시트 변환
   * ==================================================================== */
  /* 첫 시트는 '요약' — 줄글이 아니라 항목·값 표입니다.
     행정 실무에서 매체별 역할이 갈립니다: 읽고 결재하는 문서는 한글, 다루는 자료는
     엑셀(현황표·붙임). 예전에는 이 자리에 보고서 본문을 문단째 넣었는데, 문단이 셀
     하나에 갇혀 편집도 인쇄도 안 되고 한글 파일과 내용이 절반 겹쳐 "왜 둘 다 있나"가
     됐습니다. 줄글은 한글이 전담하고, 엑셀은 표로만 갑니다. */
  function draftToSheets(draft) {
    var sheets = [];
    var meta = draft.meta || {};
    var kpi = meta.kpi || {};
    var cells = meta.cells || [];

    var top = cells.filter(function (c) { return typeof c.priorityScore === 'number' && c.priorityScore > 0; })
      .sort(function (a, b) { return b.priorityScore - a.priorityScore; })[0];

    var sum = [['항목', '값']];
    function add(k, v) { if (v !== null && v !== undefined && v !== '') sum.push([k, v]); }
    add('문서', draft.title || '');
    add('기준 시간대', draft.subtitle || '');
    add('작성 기관', ((draft.org || '') + ' ' + (draft.dept || '')).trim());
    add('생성 일시', draft.generatedAt || '');
    add('생성 모델', draft.model || '');
    sum.push([]);
    add('분석 격자', typeof kpi.totalCells === 'number' ? kpi.totalCells : cells.length || '');
    add('사각지대 격자(고수요·저공급)', kpi.needCells);
    add('사각지대 비중(%)', kpi.needShare);
    add('사각지대 잠재수요(통행/일)', kpi.potentialTripsPerDay);
    add('이 중 고령층(통행/일)', kpi.elderlyTripsPerDay);
    add('DRT 후보 격자', kpi.drtCells);
    if (top) {
      sum.push([]);
      add('최우선 격자', top.name + ' (' + top.id + ')');
      add('최우선 격자 권장조치', top.actionLabel || '');
    }
    /* 줄글 전문은 한글 문서가 전담합니다. 여기엔 결론 한 줄만 남깁니다. */
    var head = (draft.sections || [])[0];
    if (head && head.body) {
      sum.push([]);
      add('요지', String(head.body).split('\n')[0]);
    }
    if (draft.disclaimer) { sum.push([]); add('비고', draft.disclaimer); }
    /* 폭 26+56 — 인쇄 시 A4 한 장 안에 두 열이 같이 들어가는 선입니다. 예전 30+78 은
       합이 인쇄 가능 폭을 넘어 항목열과 값열이 서로 다른 장에 찍혔습니다(실측). */
    sheets.push({ name: '요약', cols: [26, 56], rows: sum, headerRows: 1 });

    /* 2) 표들 */
    (draft.tables || []).forEach(function (t) {
      var cols = t.columns || [];
      var r = [cols.slice()].concat((t.rows || []).map(function (row) {
        return (row || []).map(function (v) {
          if (typeof v === 'number') return v;
          /* "1,234" 처럼 콤마가 들어간 숫자는 엑셀에서 숫자로 쓰이도록 되돌립니다 */
          if (typeof v === 'string' && /^-?[\d,]+$/.test(v) && v.replace(/,/g, '').length < 15) {
            var n = Number(v.replace(/,/g, ''));
            if (!isNaN(n)) return n;
          }
          return v;
        });
      }));
      var widths = cols.map(function (c, i) { return i < 2 ? 14 : 12; });
      sheets.push({ name: t.title, cols: widths, rows: r, headerRows: 1 });
    });

    /* 3) 데이터 시트 — AI 가 문장에 쓴 Top5 가 아니라 지금 지도에 그려진 전체
       격자 원자료를 그대로 싣습니다. 정렬·필터 가능한 실데이터 + MI·커버리지
       색상 스케일은 한글(워드프로세서) 문서로는 원천적으로 못 하는 것이라
       엑셀 내보내기만의 차별점으로 여기 넣습니다. */
    if (cells.length) {
      var dataCols = ['격자ID', '격자명', '권역', '수요지수', '공급지수', 'MI',
                       '커버리지(%)', '우선순위점수', '분류', '권장조치'];
      var dataRows = [dataCols].concat(cells.map(function (c) {
        return [
          c.id, c.name, c.region, c.demand, c.supply,
          typeof c.mi === 'number' ? Math.round(c.mi * 100) / 100 : c.mi,
          typeof c.coverage === 'number' ? Math.round(c.coverage * 1000) / 10 : c.coverage,
          typeof c.priorityScore === 'number' ? Math.round(c.priorityScore * 100) / 100 : c.priorityScore,
          c.quadrantLabel, c.actionLabel
        ];
      }));
      var lastRow = dataRows.length;
      var miCol = colName(5), covCol = colName(6);   /* dataCols 의 'MI'·'커버리지(%)' 위치 */
      sheets.push({
        name: '데이터', cols: [12, 16, 10, 10, 10, 9, 12, 12, 10, 10],
        rows: dataRows, headerRows: 1,
        /* MI 는 높을수록 나쁨(수요>공급) — 기본 순서(초록=낮음 → 빨강=높음)가 그대로 맞습니다.
           커버리지는 반대로 낮을수록 나쁨이라 색을 뒤집습니다(빨강=낮음 → 초록=높음). */
        cf: [
          { sqref: miCol + '2:' + miCol + lastRow, colors: ['FF63BE7B', 'FFFFEB84', 'FFF8696B'] },
          { sqref: covCol + '2:' + covCol + lastRow, colors: ['FFF8696B', 'FFFFEB84', 'FF63BE7B'] }
        ]
      });
    }

    /* 4) 산출식·주석 시트 — 수치의 출처를 문서 안에 남깁니다 */
    var f = meta.formula || {};

    /* 서버 meta.dataQuality 에서 출처 문장을 만든다. 없으면 폴백 문구를 쓴다. */
    var dq = meta.dataQuality || {};
    function dqOne(key, fallback) {
      var e = dq[key];
      if (!e) return fallback;
      var lv = e.level === 'observed' ? '실측' : '추정';
      var src = e.source || e.method || '';
      return src ? lv + ' — ' + src : lv;
    }
    function dqList(fallback) {
      var seen = {}, out = [];
      Object.keys(dq).forEach(function (k) {
        var s = dq[k] && dq[k].source;
        if (s && !seen[s]) { seen[s] = 1; out.push(s); }
      });
      return out.length ? out.join(', ') : fallback;
    }

    sheets.push({
      name: '산출식·주석',
      cols: [18, 92],
      rows: [
        ['항목', '내용'],
        ['수요지수 D', f.demand || 'D = 0.5·정규화(교통카드 승하차) + 0.5·정규화(연령가중 유동인구)'],
        ['공급지수 S', f.supply || 'S = 0.78·정규화(운행빈도) + 0.22·정류장 커버리지 + 배치효과'],
        ['미스매칭 MI', f.mismatch || (f.mi ? 'MI = ' + f.mi : 'MI = z(D) − z(S), 수요 규모로 가중 감쇠')],
        ['우선순위', f.priority || '우선순위 = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)'],
        ['생성 모델', draft.model || '-'],
        ['생성 일시', draft.generatedAt || '-'],
        /* 출처는 서버 meta.dataQuality 를 쓴다. 하드코딩하면 안 되는 이유:
           예전에 STCIS·통신사 유동인구로 적혀 있었는데 둘 다 실제로 안 쓰는
           데이터다. STCIS 는 신청 리드타임 때문에 제외했고 통신사는 SKT 가
           제공 불가 회신을 보냈다. 이 시트는 공문서로 나가므로 출처가 틀리면
           심사에서 답할 수 없다. 서버 값이 없을 때만 실제 출처로 폴백한다. */
        ['데이터 출처', dqList('경기데이터드림 정류소별 승하차, 경기도 분석갤러리 유동인구, '
                            + 'GBIS 노선·배차, SGIS 격자 인구·읍면동 경계')],
        ['행정경계', dqOne('boundary', '실측 — SGIS 읍면동 경계')],
        ['일별 승하차', dqOne('boardingDaily', '실측 — 경기데이터드림 정류소별 승하차 인원 집계')],
        ['시간대별 승하차', dqOne('boardingHourly',
          '추정 — 원자료에 시간대 정보가 없어 유동인구 연령가중 시간배율로 안분')],
        ['시간대별 유동인구', dqOne('flowHourly', '실측 — 경기도 분석갤러리 유동인구(화성시)')],
        /* 셋 다 가정값이던 시절의 문구를 2026-08-14 공개자료 대조 결과로 갱신.
           보고서는 심사에 그대로 나가므로 근거 수준을 항목별로 밝힙니다. */
        ['사업비 근거',
         '똑버스 — 경기교통공사 표준운송원가 대조(경기도 \'23년 526,301원/일·대) · ' +
         '증편 — 화성시 마을버스 345대 연간 운송원가 322억 원(대당 연 9,333만 원) 대조 · ' +
         '정류장 — 가정값(BIT 1,600만 원만 공개단가 확인, 승차대 구조물 미확인). ' +
         '내용연수는 전 항목 가정값'],
        ['비용 비교 기준', (meta.costCompare && meta.costCompare.label)
          ? meta.costCompare.label + ' — ' + (meta.costCompare.note || '')
          : '총사업비 기준 — 예산 한도와 같은 기준으로 비교. '
            + '똑버스·증편은 이듬해에도 같은 예산이 필요합니다.'],
        ['비고', draft.disclaimer || '']
      ],
      headerRows: 1
    });

    return sheets;
  }

  function fileStem(draft) {
    var d = (draft.generatedAt || C.todayISO()).slice(0, 10).replace(/-/g, '');
    return (CONFIG.APP.org || '보고서') + '_대중교통_수급분석_' + d;
  }

  /* ======================================================================
   *  E. 내보내기
   * ==================================================================== */
  function exportFile(draft, format) {
    var mode = CONFIG.EXPORT_MODE || 'client';
    var stem = fileStem(draft);

    function clientSide() {
      if (format === 'xlsx') {
        var sheets = draftToSheets(draft);
        var chartItems = priorityChartItems(draft);
        var chart = chartItems.length ? drawPriorityChart(chartItems) : null;
        /* 요약 표 아래, A열에 붙인다. C열 앵커는 실측(Excel COM)에서 잘못임이
           드러났다 — 첫 시트 A열이 넓어 C열부터 시작하면 그림 왼쪽 끝이 이미
           인쇄 가능 폭(A4 약 487pt)을 넘어서, 인쇄 시 그림이 페이지 경계에서
           잘리고 1위 막대의 점수만 다음 장에 혼자 찍혔다. A열(0)이면 Left=0 이라
           안 잘린다. */
        if (chart) chart.anchorRow = sheets[0].rows.length + 1;
        C.downloadBlob(buildXlsx(sheets, chart), stem + '.xlsx');
        return '엑셀 파일을 내려받았습니다.';
      }
      C.downloadBlob(buildRtf(draft), stem + '.rtf');
      return '한글 문서를 내려받았습니다. 한컴오피스에서 열어 <b>다른 이름으로 저장 → .hwp</b> 로 저장하세요.';
    }

    if (mode === 'client') {
      return Promise.resolve(clientSide());
    }

    var serverFormat = format === 'xlsx' ? 'xlsx' : 'hwpx';
    return HW.api.exportReport({ format: serverFormat, draft: draft })
      .then(function (blob) {
        C.downloadBlob(blob, stem + '.' + serverFormat);
        return (serverFormat === 'xlsx' ? '엑셀' : '한글') + ' 파일을 내려받았습니다.';
      })
      .catch(function (err) {
        if (mode === 'auto') {
          C.toast('서버 내보내기에 실패해 브라우저에서 생성합니다.', null, 3000);
          return clientSide();
        }
        throw err;
      });
  }

  /* ======================================================================
   *  F. 모달 UI
   * ==================================================================== */
  /* ── 보고서 기록 ─────────────────────────────────────────────────
     생성한 초안을 브라우저에 남겨 다시 열어 볼 수 있게 합니다.

     격자(meta.cells, 786칸 약 400KB)는 **저장하지 않습니다** — 한 건이 브라우저
     저장 한도의 15% 라 예닐곱 건이면 차고, 같은 원점을 쓰는 hw.scenarios 저장이
     조용히 실패합니다. 대신 이 세션에서 만든 것만 메모리에 들고 있다가 다시 열
     때 되붙입니다. 새로고침하면 사라지고, 그때는 엑셀의 「데이터」 시트만 빠집니다.

     격자를 서버에서 다시 받아오지 않는 이유 — HW.api.grid 에는 시점 개념이 없어
     돌려주는 것은 '그때의 격자'가 아니라 '지금의 격자'입니다. 관리자 콘솔의
     재계산이 그 산출물을 실제로 바꾸므로, 본문 문장(생성 시점 수치)과 엑셀
     데이터 시트(오늘 수치)가 어긋난 결재 문서가 아무 표시 없이 나갑니다. */
  var LS_REPORTS = 'hw.reports';
  var RP_MAX = 20;
  var sessionCells = {};
  var SOURCE_LABEL = { dashboard: '대시보드', simulation: '시뮬레이션', admin: '관리자' };

  function loadRecords() {
    try {
      var v = JSON.parse(localStorage.getItem(LS_REPORTS) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveRecords(list) {
    try { localStorage.setItem(LS_REPORTS, JSON.stringify(list)); return true; }
    catch (e) {
      C.toast('기록을 저장하지 못했습니다(브라우저 저장 공간).', 'err', 6000);
      return false;
    }
  }

  /** 저장용으로 격자만 떼어낸 사본. meta 의 나머지(kpi·priorities·formula·
      dataQuality)는 엑셀 요약·산출식 시트와 차트 폴백이 실제로 읽으므로 남깁니다. */
  function slimDraft(d) {
    var out = {}, k, j;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    if (out.meta) {
      var mt = {};
      for (j in out.meta) if (Object.prototype.hasOwnProperty.call(out.meta, j)) mt[j] = out.meta[j];
      delete mt.cells;
      out.meta = mt;
    }
    return out;
  }

  /* 어느 화면에서 만든 기록인가. 페이지 3개의 contextProvider 를 고치지 않고
     ctx 모양으로 판별합니다 — 대시보드에는 recommendation 키 자체가 없고,
     시뮬레이션은 값이 null 이어도 키가 있으며, 관리자는 {meta, admin} 뿐입니다. */
  function recordSource(ctx) {
    if (ctx && 'admin' in ctx) return 'admin';
    if (ctx && 'recommendation' in ctx) return 'simulation';
    return 'dashboard';
  }

  function pushRecord(draft, ctx, inclSim) {
    /* 카드 주 라벨은 title 이 아니라 subtitle 입니다 — title 은 백엔드가 못박은
       상수("화성시 대중교통 수급 불일치 분석 및 노선 조정 검토(안)")라 목록이
       똑같이 잘린 카드로 가득 찹니다. subtitle 은 "평일 · 출근 시간대(07–09)
       기준"처럼 화면 상태마다 달라집니다. */
    var id = 'rp-' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
    var rec = {
      id: id,
      savedAt: C.nowStamp(true),
      label: draft.subtitle || '기준 미상',
      title: draft.title || '',
      source: recordSource(ctx),
      period: ctx.period || 'am',
      daytype: ctx.daytype || 'wd',
      inclSim: !!inclSim,
      isAi: draft.isAiGenerated !== false,
      draft: slimDraft(draft)
    };
    var list = loadRecords();
    list.unshift(rec);
    while (list.length > RP_MAX) list.pop();
    /* 저장에 실패했으면 카드도 만들지 않습니다 — 메모리에만 있는 카드는
       새로고침하면 사라져서, 저장된 것처럼 보이다 없어지는 쪽이 더 나쁩니다. */
    if (!saveRecords(list)) return null;
    if (ctx.cells && ctx.cells.length) sessionCells[id] = ctx.cells;
    return id;
  }

  function updateRecord(id, draft) {
    if (!id) return;
    var list = loadRecords(), i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        /* 반드시 다시 슬림화합니다 — currentDraft 에는 생성 직후 얹은 격자가
           붙어 있어, 그냥 넣으면 채팅 편집 한 번에 400KB 가 직렬화됩니다. */
        list[i].draft = slimDraft(draft);
        list[i].savedAt = C.nowStamp(true);
        saveRecords(list);
        return;
      }
    }
  }

  function removeRecord(id) {
    saveRecords(loadRecords().filter(function (r) { return r && r.id !== id; }));
    delete sessionCells[id];
  }

  var contextProvider = null;
  var modal = null, currentDraft = null;
  var currentRecId = null;   /* 지금 화면의 초안이 어느 기록인가 */
  var archive = false;       /* 지금 보고 있는 것이 '지난 기록'인가 */
  var chatRecToken = null;   /* 채팅 지시를 보낸 시점의 기록 */

  function ensureModal() {
    if (modal) return modal;
    var m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'rp-title');
    m.innerHTML =
      '<div class="veil" data-close></div>' +
      /* data-view 를 처음부터 박아 둡니다 — 비어 있으면 [36] 의 두 규칙이 모두
         안 맞아 목록과 초안이 잠깐 함께 보입니다. */
      '<div class="sheet" data-view="list">' +
      '<header>' +
      '<h2 id="rp-title">AI 보고서</h2>' +
      '<span class="hs" data-status data-draft-only></span>' +
      '<span class="sp"></span>' +
      '<label class="hs" style="display:flex;align-items:center;gap:5px">' +
      '<input type="checkbox" data-incl-sim> 시나리오·추천안 포함</label>' +
      '<button class="btn sm" data-back type="button" data-draft-only>목록</button>' +
      '<button class="btn sm" data-regen type="button" data-draft-only>다시 생성</button>' +
      '<button class="xbtn" data-close type="button" aria-label="닫기">' + HW.icon('close', 17) + '</button>' +
      '</header>' +
      '<div class="body" data-body data-draft-only></div>' +
      /* 기록 목록 뷰. 같은 시트 안의 형제로 두고 CSS 로 한쪽만 보입니다
         ([36] 구획) — 시트를 두 벌 만들면 헤더·푸터 배선이 두 벌이 됩니다. */
      '<div class="body" data-list data-list-only></div>' +
      /* 초안을 말로 고치는 줄. 본문과 내려받기 사이에 둡니다 — 읽고(본문) → 고치고
         (여기) → 내보내는(푸터) 순서가 그대로 화면 순서가 됩니다.
         초안이 없을 때는 아래 setChatEnabled 가 잠급니다. */
      '<div class="cm cm-report" data-chat data-draft-only hidden></div>' +
      '<footer data-draft-only>' +
      '<span class="hs" data-foot></span>' +
      '<span class="sp"></span>' +
      '<button class="btn" data-copy type="button" disabled>본문 복사</button>' +
      '<button class="btn primary" data-dl-hwp type="button" disabled>' + HW.icon('doc') + '한글 문서</button>' +
      '<button class="btn excel" data-dl-xlsx type="button" disabled><i>▦</i>엑셀 파일</button>' +
      '</footer>' +
      '</div>';
    document.body.appendChild(m);
    modal = m;

    C.$$('[data-close]', m).forEach(function (b) { b.addEventListener('click', close); });
    C.$('[data-regen]', m).addEventListener('click', function () { generate(); });
    C.$('[data-back]', m).addEventListener('click', function () {
      /* 목록으로 나오면 '지난 기록' 상태를 풉니다 — 안 풀면 시나리오 체크박스가
         새로고침 전까지 회색으로 남습니다. */
      archive = false;
      updateArchiveUi();
      renderList();
      showView('list');
    });
    /* 목록은 매번 다시 그리므로 이벤트는 컨테이너에 한 번만 겁니다. */
    C.$('[data-list]', m).addEventListener('click', function (ev) {
      var gen = ev.target.closest('[data-gen-new]');
      if (gen) { startNew(); return; }
      var del = ev.target.closest('[data-del]');
      if (del) {
        var did = del.getAttribute('data-del');
        if (global.confirm('이 기록을 삭제할까요?')) {
          removeRecord(did);
          /* 지운 것이 지금 화면의 기록이면 연결을 끊습니다 — 안 끊으면
             채팅으로 고칠 때 updateRecord 가 지운 기록을 되살립니다. */
          if (currentRecId === did) currentRecId = null;
          renderList();
        }
        return;
      }
      var ld = ev.target.closest('[data-open]');
      if (ld) openRecord(ld.getAttribute('data-open'));
    });
    C.$('[data-incl-sim]', m).addEventListener('change', function () { generate(); });
    C.$('[data-dl-xlsx]', m).addEventListener('click', function () { doExport('xlsx'); });
    C.$('[data-dl-hwp]', m).addEventListener('click', function () { doExport('hwp'); });
    C.$('[data-copy]', m).addEventListener('click', copyText);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && modal.classList.contains('open')) close();
    });
    return m;
  }

  function setBusy(busy, msg) {
    var m = ensureModal();
    C.$('[data-status]', m).textContent = msg || '';
    ['[data-dl-xlsx]', '[data-dl-hwp]', '[data-copy]', '[data-regen]'].forEach(function (sel) {
      C.$(sel, m).disabled = busy || (sel !== '[data-regen]' && !currentDraft);
    });
    /* busy 로는 안 잠급니다 — 체크박스의 change 가 스스로 generate() 를 부르므로,
       여기서 잠그면 생성 중(약 14초) 다시 누른 클릭이 조용히 무시되어 "체크가
       안 된다"는 버그가 됩니다. 겹친 요청은 genSeq(요청 순번)가 낡은 응답을
       버리므로 잠그지 않아도 안전합니다. 시뮬레이션이 없어 원래 비활성인
       상태(data-nosim)만 그대로 둡니다. */
    var chk = C.$('[data-incl-sim]', m);
    if (chk) chk.disabled = chk.getAttribute('data-nosim') === '1';
  }

  function renderDraft(draft) {
    var m = ensureModal();
    var body = C.$('[data-body]', m);
    var h = '<div class="doc">';
    /* 서버가 AI 를 못 불러 서식만 채워 보낸 초안이면 그렇다고 밝힙니다.
       밝히지 않으면 문단이 두 개뿐인 폴백 초안을 AI 가 쓴 글로 읽게 되고, 이어서
       채팅으로 고치려 해도 같은 이유로 안 되는데 그 까닭을 화면에서 알 수 없습니다.
       (백엔드가 이 구분을 위해 isAiGenerated 를 실어 보냅니다 — _fallback_report) */
    if (draft.isAiGenerated === false) {
      h += '<div class="dwarn"><b>AI 가 쓴 초안이 아닙니다 — 서식 초안입니다.</b>' +
        '서버에 AI 키가 없어 지표만 문장 틀에 채워 넣었습니다. 아래 채팅으로 고치는 것도 ' +
        '같은 이유로 되지 않습니다. 백엔드 폴더의 <code>.env</code> 에 ' +
        '<code>ANTHROPIC_API_KEY</code>(또는 OPENAI_API_KEY · GOOGLE_API_KEY) 를 넣고 ' +
        '서버를 다시 켠 뒤 [다시 생성] 을 누르세요.</div>';
    }
    h += '<p class="dtitle">' + esc(draft.title) + '</p>';
    if (draft.subtitle) h += '<p class="dmeta">' + esc(draft.subtitle) + '</p>';
    h += '<p class="dmeta">' + esc((draft.org || '') + ' ' + (draft.dept || '')) +
      ' · 생성 ' + esc(draft.generatedAt || '') +
      (draft.model ? ' · 모델 ' + esc(draft.model) : '') + '</p>';

    /* 본문 앞에 한눈에 보는 막대그래프 — 글을 읽기 전에 순위부터 보이게 */
    var chartItems = priorityChartItems(draft);
    if (chartItems.length) {
      var chart = drawPriorityChart(chartItems);
      h += '<p class="dcap">노선 조정 우선순위 Top ' + chartItems.length + '</p>' +
        '<img class="dchart" src="' + chart.canvas.toDataURL('image/png') + '" ' +
        'width="' + chart.width + '" height="' + chart.height + '" alt="우선순위 막대그래프">';
    }

    (draft.sections || []).forEach(function (s) {
      h += '<h3>' + esc(s.heading) + '</h3>';
      if (s.body) String(s.body).split('\n').forEach(function (p) {
        if (p.trim()) h += '<p>' + esc(p) + '</p>';
      });
      if (s.bullets && s.bullets.length) {
        h += '<ul>' + s.bullets.map(function (li) { return '<li>' + esc(li) + '</li>'; }).join('') + '</ul>';
      }
    });

    (draft.tables || []).forEach(function (t) {
      /* AI 가 columns/rows 를 빠뜨린 표가 와도 미리보기 전체가 죽지 않게 */
      var cols = t.columns || [], trs = t.rows || [];
      h += '<p class="dcap">[' + esc(t.title) + ']</p><div class="tblwrap" style="padding:0"><table>' +
        '<tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>' +
        trs.map(function (r) {
          return '<tr>' + (r || []).map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</table></div>';
    });

    if (draft.disclaimer) h += '<div class="dnote">※ ' + esc(draft.disclaimer) + '</div>';
    h += '</div>';
    body.innerHTML = h;
  }

  function draftToPlainText(draft) {
    var out = [draft.title];
    if (draft.subtitle) out.push(draft.subtitle);
    out.push('');
    (draft.sections || []).forEach(function (s) {
      out.push(s.heading);
      if (s.body) out.push(s.body);
      (s.bullets || []).forEach(function (li) { out.push('  · ' + li); });
      out.push('');
    });
    (draft.tables || []).forEach(function (t) {
      out.push('[' + t.title + ']');
      out.push(t.columns.join('\t'));
      t.rows.forEach(function (r) { out.push(r.join('\t')); });
      out.push('');
    });
    if (draft.disclaimer) out.push('※ ' + draft.disclaimer);
    return out.join('\n');
  }

  function copyText() {
    if (!currentDraft) return;
    var txt = draftToPlainText(currentDraft);
    var done = function () { C.toast('보고서 본문을 클립보드에 복사했습니다.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { C.toast('복사에 실패했습니다. 본문을 직접 선택해 주세요.', 'err'); }
      document.body.removeChild(ta);
    }
  }

  function doExport(format) {
    if (!currentDraft) return;
    setBusy(true, '파일 생성 중…');
    Promise.resolve()
      .then(function () { return exportFile(currentDraft, format); })
      .then(function (msg) {
        setBusy(false, '');
        C.toast(msg);
      })
      .catch(function (err) {
        setBusy(false, '');
        C.toast('내보내기 실패 — ' + esc(HW.api.humanize(err)), 'err', 6000);
      });
  }

  /* '다시 생성'을 연달아 누르거나 생성 중 체크박스가 바뀌어 요청이 겹치면,
     늦게 도착한 옛 응답이 최신 초안을 덮을 수 있습니다. 마지막 요청만 반영합니다. */
  var genSeq = 0;

  function generate(opts) {
    var m = ensureModal();
    var body = C.$('[data-body]', m);
    var ctx = contextProvider ? contextProvider() : {};
    var inclSim = C.$('[data-incl-sim]', m).checked;
    var seq = ++genSeq;
    /* 목록의 [AI 보고서 생성]만 새 기록을 만듭니다. [다시 생성]과 시나리오
       체크박스는 **같은 카드를 덮어씁니다** — 안 그러면 초안 하나를 다듬으려
       세 번 누른 결과가 구별되지 않는 카드 세 장이 됩니다(저장 시각이 분
       단위라 화면에서도 같아 보입니다). */
    var isNew = !!(opts && opts.isNew);
    if (isNew) currentRecId = null;
    archive = false;

    currentDraft = null;
    setBusy(true, '생성 중…');
    body.innerHTML = '<div class="loading"><div class="spin" aria-hidden="true"></div>' +
      '<div>AI가 분석 결과를 문서로 정리하고 있습니다…</div>' +
      '<div style="font-size:11.5px">수요·공급 지표와 우선순위를 근거 문장으로 변환하는 중</div></div>';

    var payload = {
      period: ctx.period || 'am',
      format: 'sections',
      tone: '공문',
      sections: ['summary', 'status', 'problem', 'plan', 'effect', 'next'],
      context: {
        org: CONFIG.APP.org,
        dept: CONFIG.APP.dept,
        /* 대시보드에서만 있는 값(시뮬레이션 화면엔 요일 토글이 없어 undefined → 'wd') */
        daytype: ctx.daytype || 'wd',
        kpi: ctx.kpi || null,
        priorities: ctx.priorities || null,
        simulation: inclSim ? (ctx.simulation || null) : null,
        /* 추천 배치안이 있으면 선정 근거가 4장과 표에 실립니다 */
        recommendation: inclSim ? (ctx.recommendation || null) : null
      }
    };

    HW.api.draftReport(payload).then(function (draft) {
      if (seq !== genSeq) return;   /* 그사이 새 생성 요청이 나갔으면 버립니다 */
      draft.meta = draft.meta || {};
      if (ctx.meta && ctx.meta.formula) draft.meta.formula = ctx.meta.formula;
      if (ctx.meta && ctx.meta.dataQuality && !draft.meta.dataQuality) {
        draft.meta.dataQuality = ctx.meta.dataQuality;   /* 출처 시트를 서버 값으로 */
      }
      /* 엑셀의 '데이터' 시트용 — AI 가 문장에 쓴 Top5 가 아니라 지금 지도에 그려진
         전체 격자를 그대로 싣습니다(지도가 기준·시나리오 어느 쪽이든 화면과 일치). */
      if (ctx.cells && ctx.cells.length) draft.meta.cells = ctx.cells;
      if (ctx.kpi) draft.meta.kpi = ctx.kpi;             /* 엑셀 '요약' 시트용 */
      if (ctx.priorities) draft.meta.priorities = ctx.priorities;
      currentDraft = draft;
      renderDraft(draft);
      mountChat();                 /* 초안이 생긴 뒤에야 고칠 것이 있습니다 */
      setBusy(false, '');
      C.$('[data-foot]', m).innerHTML =
        (CONFIG.EXPORT_MODE === 'client'
          ? '엑셀은 .xlsx, 한글은 .rtf(한컴오피스에서 열림)로 저장됩니다.'
          : '서버에서 파일을 생성합니다.');

      if (currentRecId) {
        updateRecord(currentRecId, draft);
        if (ctx.cells && ctx.cells.length) sessionCells[currentRecId] = ctx.cells;
      } else {
        currentRecId = pushRecord(draft, ctx, inclSim);
      }
      updateArchiveUi();
    }).catch(function (err) {
      if (seq !== genSeq) return;
      setBusy(false, '');
      body.innerHTML = '<div class="errbox"><b>보고서 초안을 생성하지 못했습니다.</b><br>' +
        esc(HW.api.humanize(err)) + '</div>';
    });
  }

  /* ── 초안을 말로 고치기 ───────────────────────────────────────────
     chat.js 의 같은 모듈을 mode='report' 로 씁니다. 응답의 draft 로 currentDraft 를
     갈아끼우고 기존 renderDraft 를 다시 부르면 본문·표·내려받기가 모두 새 초안을
     씁니다(내려받기는 currentDraft 를 읽으므로 따로 손댈 것이 없습니다). */
  var reportChat = null;

  function mountChat() {
    var box = modal && C.$('[data-chat]', modal);
    if (!box || !HW.chat) return;
    box.hidden = false;
    if (reportChat) return;        /* 한 번만 만들고 이후엔 이력만 이어집니다 */
    reportChat = HW.chat.create({
      mode: 'report',
      mount: box,
      placeholder: '예: 고령층 관점을 더 강조해줘 · 개요를 3문장으로 줄여줘',
      intro: '초안을 어떻게 고칠지 말로 지시하세요. 수치는 바꾸지 않고 강조·순서·어조·분량만 고칩니다.',
      getBody: function () {
        /* 보낸 시점의 기록을 잡아 둡니다 — chat.js 에는 취소도 세대 가드도 없어
           (send 가 응답이 오면 무조건 onDraft 를 실행합니다), 지시를 보낸 뒤
           목록으로 나가 다른 기록을 열면 늦게 온 응답이 그 기록을 덮어씁니다. */
        chatRecToken = currentRecId;
        return {
          period: (HW.chatActions && HW.chatActions.period && HW.chatActions.period()) || 'am',
          context: {},
          draft: currentDraft
        };
      },
      onDraft: function (d) {
        if (chatRecToken !== currentRecId) return;   /* 그사이 다른 기록으로 옮겼습니다 */
        /* 모델이 sections 만 돌려주므로 나머지(제목·표·meta)는 지금 것을 지킵니다 */
        if (!currentDraft || !d || !Array.isArray(d.sections)) return;
        currentDraft.sections = d.sections;
        renderDraft(currentDraft);
        if (currentRecId) updateRecord(currentRecId, currentDraft);
      }
    });
  }

  /* ── 목록 뷰 ─────────────────────────────────────────────────── */
  function showView(v) {
    var m = ensureModal();
    C.$('.sheet', m).setAttribute('data-view', v);
    C.$('#rp-title', m).textContent = v === 'list' ? 'AI 보고서' : 'AI 보고서 초안';
  }

  /** 지난 기록은 [다시 생성]으로 되살릴 수 없습니다 — generate() 는 언제나
      **지금 화면**의 지표를 읽으므로, 시뮬레이션에서 만든 기록을 대시보드에서
      열어 누르면 전혀 다른 초안이 그 자리에 덮입니다. 잠그고 이유를 밝힙니다. */
  function updateArchiveUi() {
    var m = ensureModal();
    var rg = C.$('[data-regen]', m);
    rg.disabled = archive || !currentDraft;
    rg.title = archive ? '지난 기록은 다시 생성할 수 없습니다 — [목록]에서 새로 만드세요.' : '';
    /* 한쪽으로만 잠그면 목록으로 돌아온 뒤에도 풀리지 않습니다. setBusy 와 같은
       식으로 원래 비활성 사유(시뮬레이션 없음)를 함께 봅니다. */
    var chk = C.$('[data-incl-sim]', m);
    chk.disabled = archive || chk.getAttribute('data-nosim') === '1';
  }

  function renderList() {
    var m = ensureModal();
    var host = C.$('[data-list]', m);
    var ctx = contextProvider ? contextProvider() : {};
    var hint = recordSource(ctx) === 'admin'
      ? '관리자 화면에는 격자·지표 맥락이 없어 요약 위주의 초안이 나옵니다.'
      : '지금 화면에 보이는 지표로 새 초안을 만듭니다.';
    var head =
      '<div class="rp-new">' +
      '<button class="btn primary" data-gen-new type="button">' + HW.icon('doc') +
      'AI 보고서 생성</button>' +
      '<span class="hs">' + esc(hint) + '</span>' +
      '</div>';

    /* draft 없는 항목은 조용히 건너뜁니다 — 옛 저장본 하나 때문에 목록 전체가
       안 뜨면 사용자는 기록이 사라졌다고 읽습니다. */
    var list = loadRecords().filter(function (r) { return r && r.draft; });
    if (!list.length) {
      host.innerHTML = head +
        '<div class="empty">아직 만든 보고서가 없습니다.<br>' +
        '[AI 보고서 생성]을 누르면 지금 화면의 지표로 초안을 만듭니다.</div>';
      return;
    }
    host.innerHTML = head + '<div class="scen-list">' + list.map(function (r) {
      /* 삭제 버튼을 불러오기 버튼 안에 넣지 않습니다(HTML 위반 + 키보드로 삭제 불가).
         시뮬레이션 시나리오 카드와 같은 구조입니다. */
      return '<div class="scen">' +
        '<button class="sload" data-open="' + esc(r.id) + '" type="button" title="' +
        esc(r.title || '') + '">' +
        '<span class="snm">' + esc(r.label || '기준 미상') + '</span>' +
        '<span class="smeta">' +
        '<span>' + esc(r.savedAt || '') + '</span>' +
        '<span>' + esc(SOURCE_LABEL[r.source] || '대시보드') + '</span>' +
        '<span>' + (r.isAi === false ? '서식 초안' : 'AI') + '</span>' +
        (r.inclSim ? '<span>시나리오 포함</span>' : '') +
        (sessionCells[r.id] ? '' : '<span>원자료 없음</span>') +
        '</span></button>' +
        '<button class="sdel" data-del="' + esc(r.id) + '" type="button" ' +
        'aria-label="이 기록 삭제">' + HW.icon('close', 14) + '</button>' +
        '</div>';
    }).join('') + '</div>';
  }

  function startNew() {
    archive = false;
    currentRecId = null;
    if (reportChat) reportChat.reset();
    showView('draft');
    generate({ isNew: true });
  }

  function openRecord(id) {
    var list = loadRecords(), rec = null, i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { rec = list[i]; break; }
    }
    if (!rec || !rec.draft) {
      C.toast('기록을 찾지 못했습니다.', 'err');
      renderList();
      return;
    }
    /* 목록 배열 안의 원본을 채팅 편집이 제자리에서 고치지 않도록 사본을 씁니다. */
    var d = {}, k, j;
    for (k in rec.draft) if (Object.prototype.hasOwnProperty.call(rec.draft, k)) d[k] = rec.draft[k];
    var hasCells = !!sessionCells[id];
    if (hasCells) {
      var mt = {};
      for (j in (d.meta || {})) if (Object.prototype.hasOwnProperty.call(d.meta, j)) mt[j] = d.meta[j];
      mt.cells = sessionCells[id];
      d.meta = mt;
    }
    currentDraft = d;
    currentRecId = id;
    archive = true;
    genSeq++;   /* 진행 중이던 생성 응답이 이 화면을 덮지 못하게 세대를 올립니다 */
    renderDraft(d);
    mountChat();
    if (reportChat) reportChat.reset();
    setBusy(false, '');
    C.$('[data-foot]', ensureModal()).innerHTML = hasCells
      ? '지난 기록입니다. 내려받기와 말로 고치기는 그대로 됩니다.'
      : '지난 기록입니다. 원자료(격자)는 보관하지 않아 <b>엑셀의 「데이터」 시트가 빠집니다</b>.';
    showView('draft');
    updateArchiveUi();
  }

  function open() {
    var m = ensureModal();
    var ctx = contextProvider ? contextProvider() : {};
    var chk = C.$('[data-incl-sim]', m);
    var hasSim = !!(ctx && ctx.simulation);
    chk.setAttribute('data-nosim', hasSim ? '0' : '1');
    chk.disabled = !hasSim;
    chk.checked = hasSim;
    chk.parentNode.style.opacity = hasSim ? '1' : '.45';
    chk.parentNode.title = hasSim ? '' : '시뮬레이션 화면에서 배치안을 만들면 활성화됩니다.';
    m.classList.add('open');
    /* 예전에는 여기서 곧바로 generate() 를 불러, 버튼을 누르는 순간 AI 호출이
       나갔습니다. 지금은 지난 기록을 먼저 보여주고 목록의 [AI 보고서 생성]을
       눌러야 나갑니다 — 이 경로에서 나가는 요청은 한 건도 없습니다. */
    archive = false;
    currentRecId = null;
    renderList();
    showView('list');
  }
  function close() {
    if (modal) modal.classList.remove('open');
  }

  /** 페이지 스크립트가 컨텍스트 공급 함수를 등록합니다. */
  function setContextProvider(fn) { contextProvider = fn; }

  /** 상단 내비게이션의 [AI 보고서 생성] 버튼을 연결합니다. */
  function mount() {
    C.$$('[data-report-open]').forEach(function (b) {
      /* 시뮬레이션 사이드 패널의 [보고서]는 정적 HTML 이라 아이콘이 없었습니다.
         서랍의 발행 버튼에는 문서 아이콘이 붙어 있어, 같은 동작인데 한쪽만
         글자만 있는 상태였습니다. 이미 아이콘을 들고 있으면 건너뜁니다. */
      if (!b.querySelector('.ic')) b.insertAdjacentHTML('afterbegin', HW.icon('doc'));
      b.addEventListener('click', open);
    });
  }

  HW.report = {
    mount: mount,
    open: open,
    close: close,
    setContextProvider: setContextProvider,
    /* 테스트·재사용용으로 노출 */
    /* 기록 계층 — 프론트에 CI 가 없어 이 저장 로직만이라도 밖에서 돌려볼 수
       있게 엽니다(쿼터 초과·격자 제외·id 처리가 조용히 틀리기 쉬운 자리입니다). */
    _records: {
      load: loadRecords, save: saveRecords, push: pushRecord,
      update: updateRecord, remove: removeRecord,
      slim: slimDraft, source: recordSource, sessionCells: sessionCells
    },
    buildXlsx: buildXlsx,
    buildRtf: buildRtf,
    draftToSheets: draftToSheets,
    draftToPlainText: draftToPlainText,
    zip: zip,
    crc32: crc32
  };
})(window);
