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
  function buildXlsx(sheets) {
    var used = {};
    sheets = sheets.map(function (s) {
      return { name: safeSheetName(s.name, used), cols: s.cols || [], rows: s.rows || [], headerRows: s.headerRows == null ? 1 : s.headerRows };
    });

    var files = [];

    files.push({
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
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
          var style = ri < s.headerRows ? 1 : (typeof v === 'string' && v.length > 60 ? 3 : 0);
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

      files.push({
        name: 'xl/worksheets/sheet' + (si + 1) + '.xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetViews><sheetView' + (si === 0 ? ' tabSelected="1"' : '') + ' workbookViewId="0"/></sheetViews>' +
          '<sheetFormatPr defaultRowHeight="15"/>' + cols +
          '<sheetData>' + rowsXml + '</sheetData>' +
          '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
          '</worksheet>'
      });
    });

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

  function buildRtf(draft) {
    var b = '';
    b += '{\\rtf1\\ansi\\ansicpg949\\deff0\\uc1\n';
    b += '{\\fonttbl{\\f0\\fnil\\fcharset129 \\\'b8\\\'bc\\\'c0\\\'ba \\\'b0\\\'edN;}{\\f1\\fnil\\fcharset129 Malgun Gothic;}}\n';
    b += '{\\colortbl;\\red0\\green0\\blue0;\\red90\\green90\\blue90;}\n';
    b += '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\n';
    b += '\\f1\\fs20\n';

    /* 제목 */
    b += '\\pard\\qc\\b\\fs32 ' + rtfText(draft.title) + '\\b0\\par\n';
    if (draft.subtitle) b += '\\pard\\qc\\fs20\\cf2 ' + rtfText(draft.subtitle) + '\\cf1\\par\n';
    b += '\\pard\\qc\\fs17\\cf2 ' + rtfText((draft.org || '') + (draft.dept ? ' ' + draft.dept : '') +
      '   |   작성일 ' + C.korDate((draft.generatedAt || '').slice(0, 10))) + '\\cf1\\par\\par\n';

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
  function draftToSheets(draft) {
    var sheets = [];

    /* 1) 요약 시트 — 문서 본문을 그대로 */
    var rows = [];
    rows.push([{ __title: draft.title }]);
    if (draft.subtitle) rows.push([draft.subtitle]);
    rows.push([(draft.org || '') + ' ' + (draft.dept || '') + '  |  작성일시 ' + (draft.generatedAt || '')]);
    rows.push([]);
    (draft.sections || []).forEach(function (s) {
      rows.push([s.heading]);
      if (s.body) String(s.body).split('\n').forEach(function (p) { if (p.trim()) rows.push([p]); });
      (s.bullets || []).forEach(function (li) { rows.push(['· ' + li]); });
      rows.push([]);
    });
    if (draft.disclaimer) rows.push(['※ ' + draft.disclaimer]);
    sheets.push({ name: '보고서', cols: [110], rows: rows, headerRows: 0 });

    /* 2) 표들 */
    (draft.tables || []).forEach(function (t) {
      var r = [t.columns.slice()].concat(t.rows.map(function (row) {
        return row.map(function (v) {
          if (typeof v === 'number') return v;
          /* "1,234" 처럼 콤마가 들어간 숫자는 엑셀에서 숫자로 쓰이도록 되돌립니다 */
          if (typeof v === 'string' && /^-?[\d,]+$/.test(v) && v.replace(/,/g, '').length < 15) {
            var n = Number(v.replace(/,/g, ''));
            if (!isNaN(n)) return n;
          }
          return v;
        });
      }));
      var widths = t.columns.map(function (c, i) { return i < 2 ? 14 : 12; });
      sheets.push({ name: t.title, cols: widths, rows: r, headerRows: 1 });
    });

    /* 3) 산출식·주석 시트 — 수치의 출처를 문서 안에 남깁니다 */
    var meta = draft.meta || {};
    var f = meta.formula || {};
    sheets.push({
      name: '산출식·주석',
      cols: [18, 92],
      rows: [
        ['항목', '내용'],
        ['수요지수 D', f.demand || 'D = 0.5·정규화(교통카드 승하차) + 0.5·정규화(통신 유동인구)'],
        ['공급지수 S', f.supply || 'S = 0.78·정규화(운행빈도) + 0.22·정류장 커버리지 + 배치효과'],
        ['미스매칭 MI', f.mismatch || 'MI = z(D) − z(S), 수요 규모로 가중 감쇠'],
        ['우선순위', f.priority || '우선순위 = MI⁺ × 수요규모 × (1 + 1.6·고령인구비)'],
        ['생성 모델', draft.model || '-'],
        ['생성 일시', draft.generatedAt || '-'],
        ['데이터 출처', '교통카드빅데이터(STCIS), 통신사 유동인구, GBIS 노선·정류장, SGIS 격자 인구'],
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
        C.downloadBlob(buildXlsx(draftToSheets(draft)), stem + '.xlsx');
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
  var contextProvider = null;
  var modal = null, currentDraft = null;

  function ensureModal() {
    if (modal) return modal;
    var m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'rp-title');
    m.innerHTML =
      '<div class="veil" data-close></div>' +
      '<div class="sheet">' +
      '<header>' +
      '<h2 id="rp-title">AI 보고서 초안</h2>' +
      '<span class="hs" data-status></span>' +
      '<span class="sp"></span>' +
      '<label class="hs" style="display:flex;align-items:center;gap:5px">' +
      '<input type="checkbox" data-incl-sim> 시나리오 포함</label>' +
      '<button class="btn sm" data-regen type="button">다시 생성</button>' +
      '<button class="xbtn" data-close type="button" aria-label="닫기">×</button>' +
      '</header>' +
      '<div class="body" data-body></div>' +
      '<footer>' +
      '<span class="hs" data-foot></span>' +
      '<span class="sp"></span>' +
      '<button class="btn" data-copy type="button" disabled>본문 복사</button>' +
      '<button class="btn" data-dl-hwp type="button" disabled><i>▤</i>한글 문서</button>' +
      '<button class="btn primary" data-dl-xlsx type="button" disabled><i>▦</i>엑셀 파일</button>' +
      '</footer>' +
      '</div>';
    document.body.appendChild(m);
    modal = m;

    C.$$('[data-close]', m).forEach(function (b) { b.addEventListener('click', close); });
    C.$('[data-regen]', m).addEventListener('click', function () { generate(); });
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
  }

  function renderDraft(draft) {
    var m = ensureModal();
    var body = C.$('[data-body]', m);
    var h = '<div class="doc">';
    h += '<p class="dtitle">' + esc(draft.title) + '</p>';
    if (draft.subtitle) h += '<p class="dmeta">' + esc(draft.subtitle) + '</p>';
    h += '<p class="dmeta">' + esc((draft.org || '') + ' ' + (draft.dept || '')) +
      ' · 생성 ' + esc(draft.generatedAt || '') +
      (draft.model ? ' · 모델 ' + esc(draft.model) : '') + '</p>';

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
      h += '<p class="dcap">[' + esc(t.title) + ']</p><div class="tblwrap" style="padding:0"><table>' +
        '<tr>' + t.columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>' +
        t.rows.map(function (r) {
          return '<tr>' + r.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>';
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

  function generate() {
    var m = ensureModal();
    var body = C.$('[data-body]', m);
    var ctx = contextProvider ? contextProvider() : {};
    var inclSim = C.$('[data-incl-sim]', m).checked;

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
        kpi: ctx.kpi || null,
        priorities: ctx.priorities || null,
        simulation: inclSim ? (ctx.simulation || null) : null
      }
    };

    HW.api.draftReport(payload).then(function (draft) {
      draft.meta = draft.meta || {};
      if (ctx.meta && ctx.meta.formula) draft.meta.formula = ctx.meta.formula;
      currentDraft = draft;
      renderDraft(draft);
      setBusy(false, '');
      C.$('[data-foot]', m).innerHTML =
        (CONFIG.EXPORT_MODE === 'client'
          ? '엑셀은 .xlsx, 한글은 .rtf(한컴오피스에서 열림)로 저장됩니다.'
          : '서버에서 파일을 생성합니다.');
    }).catch(function (err) {
      setBusy(false, '');
      body.innerHTML = '<div class="errbox"><b>보고서 초안을 생성하지 못했습니다.</b><br>' +
        esc(HW.api.humanize(err)) + '</div>';
    });
  }

  function open() {
    var m = ensureModal();
    var ctx = contextProvider ? contextProvider() : {};
    var chk = C.$('[data-incl-sim]', m);
    var hasSim = !!(ctx && ctx.simulation);
    chk.disabled = !hasSim;
    chk.checked = hasSim;
    chk.parentNode.style.opacity = hasSim ? '1' : '.45';
    chk.parentNode.title = hasSim ? '' : '시뮬레이션 화면에서 배치안을 만들면 활성화됩니다.';
    m.classList.add('open');
    generate();
  }
  function close() {
    if (modal) modal.classList.remove('open');
  }

  /** 페이지 스크립트가 컨텍스트 공급 함수를 등록합니다. */
  function setContextProvider(fn) { contextProvider = fn; }

  /** 상단 내비게이션의 [AI 보고서 생성] 버튼을 연결합니다. */
  function mount() {
    C.$$('[data-report-open]').forEach(function (b) {
      b.addEventListener('click', open);
    });
  }

  HW.report = {
    mount: mount,
    open: open,
    close: close,
    setContextProvider: setContextProvider,
    /* 테스트·재사용용으로 노출 */
    buildXlsx: buildXlsx,
    buildRtf: buildRtf,
    draftToSheets: draftToSheets,
    draftToPlainText: draftToPlainText,
    zip: zip,
    crc32: crc32
  };
})(window);
