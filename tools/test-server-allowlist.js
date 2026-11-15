/* 서버 허용 목록 회귀 검사 — node tools/test-server-allowlist.js
 *
 * ?server= 는 링크 하나로 심을 수 있고 localStorage 에 영속됩니다. 허용 목록이
 * 풀리면 admin.html?server=https://공격자 한 번에 관리자 토큰이 그쪽으로 나갑니다.
 * 그 경로가 다시 열리지 않는지 브라우저 없이 확인합니다.
 *
 *   ① config.js — 허용 목록 밖 ?server= 는 저장·고정하지 않고, 이미 저장된 것도 지운다
 *   ② config.js — isAllowedServer 판정 (우회 시도 포함)
 *   ③ api.js    — 실제로 나가는 요청에 관리자 토큰이 허용 출처에만 붙는다
 *
 * 각 경우를 새 vm 컨텍스트에서 돌립니다(config.js 는 로드 시점에 location 을 읽음).
 * 종료 코드 = 실패 수.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'assets', 'js');
const CONFIG_SRC = fs.readFileSync(path.join(JS, 'config.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(JS, 'api.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function memStorage(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => Object.assign({}, m)
  };
}

/* pageUrl 로 연 페이지에서 config.js(+api.js)를 로드한 컨텍스트 */
function load(pageUrl, storage, withApi) {
  const u = new URL(pageUrl);
  const sent = [];
  const warns = [];
  const ctx = {
    URL, URLSearchParams, setTimeout, clearTimeout, Promise,
    location: { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
                hostname: u.hostname, port: u.port, search: u.search },
    localStorage: storage || memStorage(),
    sessionStorage: memStorage(),
    console: { info() {}, log() {}, warn: m => warns.push(String(m)), error() {} },
    fetch: (url, opts) => {
      sent.push({ url: String(url), headers: (opts && opts.headers) || {} });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' },
                               text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) });
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CONFIG_SRC, ctx);
  if (withApi) vm.runInContext(API_SRC, ctx);
  return { ctx, C: ctx.HW.CONFIG, sent, warns };
}

const PUBLIC = 'https://hw-dashboard.pages.dev';
const EVIL = 'https://evil.example';

console.log('① ?server= 저장·고정');
{
  const st = memStorage();
  const { C, warns } = load(PUBLIC + '/admin.html?server=' + EVIL, st);
  ok('허용 밖 ?server= 는 저장하지 않는다', st.getItem('hw.serverUrl') === null, st._dump());
  ok('허용 밖 ?server= 로 고정되지 않는다', C.SERVER_PINNED === false && C.BASE_URL !== EVIL, C.BASE_URL);
  ok('거른 주소를 SERVER_REJECTED 로 알린다', C.SERVER_REJECTED === EVIL);
  ok('콘솔 경고를 남긴다', warns.some(w => w.indexOf(EVIL) >= 0));
}
{
  const st = memStorage({ 'hw.serverUrl': EVIL });
  const { C } = load(PUBLIC + '/admin.html', st);
  ok('예전에 심어진 저장 주소를 지운다', st.getItem('hw.serverUrl') === null, st._dump());
  ok('예전에 심어진 주소로 고정되지 않는다', C.BASE_URL !== EVIL && C.SERVER_REJECTED === EVIL);
}
{
  const st = memStorage({ 'hw.serverUrl': 'http://127.0.0.1:8000' });
  const { C } = load(PUBLIC + '/admin.html?server=' + EVIL, st);
  ok('허용 밖 ?server= 가 기존의 허용 주소를 지우지 않는다',
    st.getItem('hw.serverUrl') === 'http://127.0.0.1:8000' && C.BASE_URL === 'http://127.0.0.1:8000');
}
{
  const st = memStorage();
  const { C } = load('http://localhost:5500/admin.html?server=http://127.0.0.1:8000', st);
  ok('루프백 ?server= 는 저장·고정한다',
    st.getItem('hw.serverUrl') === 'http://127.0.0.1:8000' && C.SERVER_PINNED === true && !C.SERVER_REJECTED);
}
{
  const st = memStorage();
  load(PUBLIC + '/index.html?server=http://192.168.0.10:8000', st);
  ok('공개 배포본에서는 사설망 ?server= 를 받지 않는다', st.getItem('hw.serverUrl') === null);
  const st2 = memStorage();
  load('http://192.168.0.5:5500/index.html?server=http://192.168.0.10:8000', st2);
  ok('사설망에서 연 페이지는 사설망 ?server= 를 받는다', st2.getItem('hw.serverUrl') === 'http://192.168.0.10:8000');
}
{
  const st = memStorage({ 'hw.serverUrl': 'http://127.0.0.1:8000' });
  load(PUBLIC + '/index.html?server=', st);
  ok('빈 ?server= 는 저장 주소를 지운다(초기화)', st.getItem('hw.serverUrl') === null);
}

console.log('② isAllowedServer');
{
  const { C } = load(PUBLIC + '/admin.html');
  const cases = [
    ['', true, '같은 원점(빈 값)'],
    ['/api/v1/meta', true, '상대 경로 = 같은 원점'],
    [PUBLIC + '/api/v1/meta', true, '같은 원점 절대 URL'],
    ['http://localhost:8000', true, 'localhost'],
    ['http://127.0.0.1:9999/api/v1/admin/status', true, '127.0.0.1 임의 포트'],
    ['http://[::1]:8000', true, 'IPv6 루프백'],
    [EVIL, false, '임의 외부 주소'],
    [EVIL + '/api/v1/admin/status', false, '임의 외부 주소의 API URL'],
    ['https://localhost.evil.example', false, 'localhost 로 시작하는 외부 호스트'],
    ['http://127.0.0.1.nip.io:8000', false, '127.0.0.1 로 시작하는 외부 호스트'],
    ['https://hw-dashboard.pages.dev@evil.example', false, '사용자정보(@)로 위장한 외부 주소'],
    ['https://hw-dashboard.pages.dev.evil.example', false, '같은 원점 이름을 접두로 단 외부 호스트'],
    ['http://hw-dashboard.pages.dev', false, '같은 호스트라도 스킴이 다르면 다른 출처'],
    ['https://abcd.ngrok-free.app', false, '목록에 없는 ngrok 터널'],
    ['javascript:alert(1)', false, 'http(s) 아닌 스킴'],
    ['//evil.example', false, '스킴 생략 외부 주소'],
    ['http://10.0.0.5:8000', false, '공개 페이지에서 사설망']
  ];
  cases.forEach(([u, want, name]) => ok(name + ' → ' + want, C.isAllowedServer(u) === want, u));
}
{
  const { C } = load(PUBLIC + '/admin.html');
  C.ALLOWED_SERVER_ORIGINS.push('https://abcd.ngrok-free.app');
  ok('목록에 넣은 출처는 허용', C.isAllowedServer('https://abcd.ngrok-free.app/api/v1/meta') === true);
  ok('목록 출처라도 포트가 다르면 거부', C.isAllowedServer('https://abcd.ngrok-free.app:8443') === false);
}

console.log('③ 관리자 토큰 전송');
function authOf(r) { return r && (r.headers.Authorization || r.headers.authorization); }
async function tokenCase(pageUrl, server, storage) {
  const L = load(pageUrl, storage || memStorage({ 'hw.adminToken': 'test-admin-token' }), true);
  const C = L.C;
  C.AUTH.enabled = true;
  C.AUTH.header = 'Authorization';
  C.AUTH.scheme = 'Bearer';
  C.AUTH.getToken = () => L.ctx.localStorage.getItem('hw.adminToken');
  if (server !== undefined) C.useServer(server);
  try { await L.ctx.HW.api.call('admin.status'); } catch (e) { /* 응답 내용은 상관없다 */ }
  return L;
}
(async () => {
  {
    /* 완료 기준 그대로 — admin.html?server=https://임의주소 를 연다 */
    const L = await tokenCase(PUBLIC + '/admin.html?server=' + EVIL);
    ok('?server=임의주소 로 연 관리자 화면: 임의주소로 요청 0건',
      L.sent.every(r => r.url.indexOf('evil.example') < 0), L.sent.map(r => r.url));
    ok('?server=임의주소 로 연 관리자 화면: 어떤 요청에도 토큰이 임의주소로 가지 않는다',
      L.sent.every(r => !authOf(r) || r.url.indexOf('evil.example') < 0));
  }
  {
    /* 이중 방어 — 주소가 다른 길(useServer·SERVER_URL)로 바뀌어도 토큰은 안 붙는다 */
    const L = await tokenCase(PUBLIC + '/admin.html', EVIL);
    const r = L.sent.find(x => x.url.indexOf('/admin/status') >= 0);
    ok('허용 밖 서버로 나가는 요청에는 Authorization 이 없다', r && !authOf(r), r);
    ok('토큰을 거른 사실을 경고한다', L.warns.some(w => w.indexOf('토큰') >= 0));
  }
  {
    const L = await tokenCase(PUBLIC + '/admin.html', 'http://127.0.0.1:8000');
    const r = L.sent.find(x => x.url.indexOf('/admin/status') >= 0);
    ok('허용 서버(루프백)로는 토큰이 붙는다', r && authOf(r) === 'Bearer test-admin-token', r);
  }
  {
    const L = await tokenCase('http://localhost:8000/app/admin.html', '');
    const r = L.sent.find(x => x.url.indexOf('/admin/status') >= 0);
    ok('같은 원점(백엔드가 /app 서빙)으로는 토큰이 붙는다', r && authOf(r) === 'Bearer test-admin-token', r);
  }

  console.log('\n최종 ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail);
})();
