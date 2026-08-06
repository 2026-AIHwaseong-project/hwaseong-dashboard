#!/usr/bin/env node
/* ============================================================================
 *  build-standalone.js — 단일 파일(HTML 하나) 버전 생성기
 * ----------------------------------------------------------------------------
 *  CSS·JS 를 HTML 안에 전부 넣어, 파일 하나만 더블클릭하면 열리는 버전을 만듭니다.
 *  카톡·메일로 보내거나 USB 로 옮겨도 그대로 동작합니다(서버 불필요).
 *
 *  실행:  node tools/build-standalone.js
 *  결과:  dist/hwaseong-dashboard.html
 *         dist/hwaseong-simulation.html
 *
 *  주의: 단일 파일 버전은 목(mock) 데이터 전용입니다.
 *        실서버 연동은 원본(index.html + assets/)을 쓰세요.
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* 단일 파일 버전의 화면 간 이동 경로 */
const PAGES = {
  dashboard: 'hwaseong-dashboard.html',
  simulation: 'hwaseong-simulation.html'
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 인라인 <script> 안에서 문서를 조기 종료시키는 문자열을 막습니다 */
const safeJs = (code) => code.replace(/<\/script/gi, '<\\/script');
const safeCss = (code) => code.replace(/<\/style/gi, '<\\/style');

function build(srcHtml, outName, pageId) {
  let html = read(srcHtml);

  // 1) CSS 인라인
  html = html.replace(
    /<link rel="stylesheet" href="([^"]+)">/g,
    (_, href) => '<style>\n' + safeCss(read(href)) + '\n</style>'
  );

  // 2) JS 인라인 (+ config 뒤에 단일 파일용 경로 덮어쓰기)
  html = html.replace(
    /<script src="([^"]+)"><\/script>/g,
    (_, src) => {
      let out = '<script>\n' + safeJs(read(src)) + '\n</script>';
      if (src.endsWith('config.js')) {
        out += '\n<script>\n' +
          '/* 단일 파일 버전 — 화면 간 이동 경로를 이 파일들로 맞춥니다 */\n' +
          'HW.CONFIG.PAGES = ' + JSON.stringify(PAGES, null, 2) + ';\n' +
          'HW.CONFIG.APP.buildNote = "단일 파일 버전 (오프라인·목 데이터)";\n' +
          '</script>';
      }
      return out;
    }
  );

  // 3) 남은 외부 참조가 없는지 확인
  const leftover = html.match(/(?:src|href)="(?!#|https?:|mailto:)([^"]*\.(?:js|css))"/g);
  if (leftover) throw new Error(outName + ' 에 인라인되지 않은 참조가 남았습니다: ' + leftover.join(', '));

  // 4) 안내 주석
  html = html.replace('<head>',
    '<head>\n<!-- 단일 파일 버전 · 자동 생성됨 (tools/build-standalone.js)\n' +
    '     이 파일 하나만 있으면 브라우저에서 바로 열립니다. 인터넷·서버 불필요.\n' +
    '     수정은 원본(index.html + assets/)에서 하고 다시 빌드하세요. -->');

  fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, outName);
  fs.writeFileSync(outPath, html, 'utf8');
  return { outPath, bytes: Buffer.byteLength(html, 'utf8') };
}

const targets = [
  ['index.html', PAGES.dashboard, 'dashboard'],
  ['simulation.html', PAGES.simulation, 'simulation']
];

console.log('단일 파일 버전 생성');
let total = 0;
for (const [src, out, id] of targets) {
  const r = build(src, out, id);
  total += r.bytes;
  console.log('  ✓ ' + src.padEnd(18) + ' → dist/' + out +
    '  (' + (r.bytes / 1024).toFixed(0) + ' KB)');
}
console.log('  합계 ' + (total / 1024).toFixed(0) + ' KB');
console.log('\n브라우저에서 dist/' + PAGES.dashboard + ' 를 열면 됩니다.');
