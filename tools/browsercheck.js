/* ===========================================================================
 * 행사 전 브라우저 점검 — 사람이 실제로 겪는 실패를 자동으로 밟아 봅니다
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/browsercheck.js <포트> [--keep]
 *   봇으로 방을 채워 두면 실제 라운드에서 봅니다 (tools/testbots.js).
 *   CHROME_PATH 환경변수로 크롬 경로를 바꿀 수 있습니다.
 *
 * 보는 것 — 전부 지금까지 자동으로 확인한 적이 없던 것들입니다.
 *   ① 자바스크립트 오류 — 한 라운드 도는 동안 예외·console.error 가 있는가
 *   ② 자원 실패(404)   — 없는 파일을 부르고 있지 않은가
 *   ③ 끊겼다 복구      — WiFi 가 끊겼다 돌아왔을 때 스스로 재연결하는가
 *
 * ⚠ 끊김은 <b>CDP 오프라인으로 못 만듭니다</b> — Network.emulateNetworkConditions
 *   는 이미 열린 WebSocket 에 적용되지 않습니다(실측: 오프라인 6초 동안에도
 *   socket.connected 가 true). 그래서 이 도구는 <b>중간에 netsim 중계를 두고
 *   그 프로세스를 죽였다 살려</b> TCP 를 실제로 끊습니다.
 *
 * ★ 확장 없는 <b>새 프로필</b>로 띄웁니다 — 자동화 확장이 페이지에 주입하는
 *   코드가 오류로 잡히면 엉뚱한 것을 쫓게 됩니다.
 * ⚠ 관전자로 들어가면 물리가 안 도는데도 '이상 없음' 이 나옵니다.
 *   그래서 역할을 먼저 찍습니다 — 주자가 아니면 그 점을 감안해 읽으세요.
 * ======================================================================== */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = process.argv[2] || '3000';
const A = process.argv.slice(2);
const argOf = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const DELAY = argOf('--delay', '0'), JITTER = argOf('--jitter', '0');
const VIA = String(parseInt(PORT, 10) + 100);   // 브라우저가 붙는 중계 포트
const KEEP = process.argv.includes('--keep');
const DPORT = 9340;
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'ipg_bcheck_' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (p) => (await fetch('http://127.0.0.1:' + DPORT + p)).json();

let id = 0;
function rpc(ws, m, p) {
  return new Promise((res, rej) => {
    const i = ++id;
    const on = (raw) => {
      let x; try { x = JSON.parse(raw); } catch (e) { return; }
      if (x.id === i) {
        ws.off('message', on);
        x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
}

/* netsim 중계를 띄웁니다. 끊김 시험에서 이 프로세스를 죽였다 살립니다. */
const NETSIM = path.join(__dirname, 'netsim.js');
function startNetsim() {
  return spawn(process.execPath,
    [NETSIM, '--in', VIA, '--to', PORT, '--delay', DELAY, '--jitter', JITTER],
    { stdio: 'ignore' });
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  let relay = startNetsim();
  await sleep(1200);
  const chrome = spawn(CHROME, [
    '--remote-debugging-port=' + DPORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--disable-renderer-backgrounding', '--window-size=1200,760',
    'http://localhost:' + VIA + '/?fs=0'
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    await sleep(500);
    try {
      t = (await http('/json')).find((x) => x.type === 'page' && x.url.includes('localhost:' + VIA));
    } catch (e) { /* 아직 안 뜸 */ }
  }
  if (!t) { console.log('  크롬 타깃을 못 찾았습니다'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await rpc(ws, 'Network.enable');

  const errs = [], res404 = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push('예외: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = (m.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : (a.description || ''))).join(' ');
      errs.push('console.error: ' + txt);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level !== 'error') return;
      if (/404|Failed to load resource/i.test(e.text)) res404.push(e.url || e.text);
      else errs.push('로그: ' + e.text);
    }
  });

  const ev = async (expr, awaitP) => {
    const r = await rpc(ws, 'Runtime.evaluate',
      { expression: expr, awaitPromise: !!awaitP, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception || {}).description || '평가 오류');
    }
    return r.result.value;
  };

  const out = [];
  await sleep(2500);

  // 참가
  await ev([
    '(async()=>{const t0=Date.now();',
    'while(!document.querySelector("#btnJoin")&&Date.now()-t0<30000)',
    ' await new Promise(r=>setTimeout(r,300));',
    'const n=document.querySelector("#joinName");',
    'if(n){n.value="점검";n.dispatchEvent(new Event("input",{bubbles:true}));}',
    'document.querySelector("#btnJoin").click(); return 1})()'
  ].join(''), true);

  // 라운드 시작 대기
  const role = await ev([
    '(async()=>{const t0=Date.now();',
    'while(document.body.classList.contains("lobby")&&Date.now()-t0<45000)',
    ' await new Promise(r=>setTimeout(r,400));',
    'return document.body.className||"(주자)"})()'
  ].join(''), true);
  out.push(['역할', role === '(주자)' ? '주자' : role]);

  // 25초 동안 달리며 오류를 봅니다
  await ev('window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyW",key:"w",bubbles:true})),1');
  await sleep(25000);
  await ev('window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyW",key:"w",bubbles:true})),1');

  const alive = await ev('(()=>{const c=document.querySelector("canvas");' +
    'return !!(c && c.width>0) && typeof renderer!=="undefined"})()');

  /* ⚠ 여기서 <b>선을 긋습니다.</b> 아래 ③ 은 일부러 끊는 시험이라
     연결 오류·폴링 404 가 반드시 납니다. 그걸 '라운드 중 오류' 에 섞으면
     멀쩡한 판이 실패로 보입니다.                                     */
  const errsRound = errs.slice(), r404Round = res404.slice();
  out.push(['① 자바스크립트 오류', errsRound.length
    ? ('실패 ' + errsRound.length + '건 — ' + errsRound[0].slice(0, 110)) : '없음']);
  out.push(['② 자원 실패(404)', r404Round.length
    ? ('주의 ' + r404Round.length + '건 (아래 목록)') : '없음']);
  out.push(['   화면 살아있음', alive ? '예' : '아니오 — 캔버스/렌더러 없음']);

  // ③ 끊겼다 복구 — 중계를 죽여 TCP 를 실제로 끊습니다
  const before = await ev('(()=>{try{return G.socket.connected}catch(e){return null}})()');
  try { relay.kill(); } catch (e) { /* 무시 */ }
  await sleep(6000);
  const during = await ev('(()=>{try{return G.socket.connected}catch(e){return null}})()');
  relay = startNetsim();
  const back = await ev([
    '(async()=>{const t0=Date.now();',
    'while(Date.now()-t0<30000){ try{ if(G.socket.connected) return Math.round(Date.now()-t0);}catch(e){}',
    ' await new Promise(r=>setTimeout(r,300)); } return -1})()'
  ].join(''), true);
  out.push(['③ 끊김 복구', before === false ? '끊기 전부터 미연결 — 판단 불가'
    : (during !== false ? '끊기지 않음 — 판단 불가'
      : (back >= 0 ? ('TCP 6초 끊김 → ' + back + 'ms 만에 재연결') : '재연결 실패(30초)'))]);
  const stillOk = await ev('(()=>{const c=document.querySelector("canvas");return !!(c&&c.width>0)})()');
  out.push(['   복구 후 화면', stillOk ? '정상' : '깨짐']);

  console.log('');
  console.log('  ── 브라우저 점검 (포트 ' + PORT + ') ──');
  for (const [k, v] of out) console.log('    ' + k.padEnd(20) + v);
  if (r404Round.length) {
    console.log('');
    console.log('    404 목록(라운드 중 · 중복 제거):');
    [...new Set(r404Round.map((u) => String(u).replace(/^https?:\/\/[^/]+/, '')))]
      .forEach((u) => console.log('      · ' + u));
    console.log('      ※ 선택 에셋(소리 등)이면 정상입니다 — public/assets/audio/README.md 참고');
  }
  if (errsRound.length) {
    console.log('');
    console.log('    라운드 중 오류:');
    errsRound.slice(0, 8).forEach((e) => console.log('      · ' + e.slice(0, 160)));
  }
  const cut = errs.length - errsRound.length;
  if (cut > 0) {
    console.log('');
    console.log('    (③ 일부러 끊는 동안 난 연결 오류 ' + cut + '건은 정상입니다 — 위 판정에서 제외)');
  }

  if (!KEEP) {
    ws.close(); chrome.kill(); try { relay.kill(); } catch (e) { /* 무시 */ }
    await sleep(700);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 무시 */ }
  }
  process.exit(errsRound.length ? 1 : 0);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
