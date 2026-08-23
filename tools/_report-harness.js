/* test-reports.js 가 쓰는 최소 실행 환경.
   report.js 는 브라우저 전역(window·document·localStorage)과 HW.core 를 전제하므로,
   기록 계층만 돌려보기 위한 껍데기를 만들어 그 안에서 파일을 평가합니다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const el = () => ({
  innerHTML: '', textContent: '', className: '', style: {}, hidden: false,
  disabled: false, title: '', setAttribute() {}, getAttribute() { return null; },
  appendChild() {}, addEventListener() {}, querySelector() { return null; },
  insertAdjacentHTML() {}, closest() { return null; },
  classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  parentNode: { style: {}, title: '' },
});

const g = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    /* 실제 브라우저와 같은 지점에서 터지게 합니다 — 이 예외를 삼키면
       "저장된 줄 알았는데 새로고침하니 사라짐"이 재현되지 않습니다. */
    setItem: (k, v) => {
      if (v.length > 4000000) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store[k] = v;
    },
    removeItem: (k) => { delete store[k]; },
  },
  document: { createElement: el, body: { appendChild() {} }, addEventListener() {} },
  /* 선택자마다 같은 스텁을 돌려줘야 renderList 가 그린 HTML 을 들여다볼 수 있습니다.
     새 객체를 매번 만들면 innerHTML 이 즉시 버려집니다. */
  __els: {},
  confirm: () => true,
  HW: {
    core: {
      /* core.js 의 esc 와 같은 규칙 — 이스케이프를 안 하는 스텁을 쓰면
         "태그가 그대로 심어지는가" 검사가 통과해 버립니다. */
      esc: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      $: (sel) => (g.__els[sel] = g.__els[sel] || el()),
      $$: () => [],
      toast: (m, t) => g.__toasts.push([m, t]),
      nowStamp: () => '2026-08-23 14:03',
    },
    icon: () => '<svg/>',
    CONFIG: { APP: {}, EXPORT_MODE: 'client' },
    api: { humanize: (e) => String(e) },
  },
  __toasts: [],
};
g.window = g;
g.self = g;

vm.createContext(g);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'report.js'), 'utf8'), g);

module.exports = g;
