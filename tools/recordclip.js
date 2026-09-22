/* ===========================================================================
 * 홍보영상용 플레이 녹화 — 움직임을 미리 짜서 자동으로 찍습니다
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/recordclip.js <포트> <출력폴더> [초]
 *   서버는 라운드가 길게 돌도록 띄우고, 봇으로 방을 채워 두세요:
 *     PORT=3400 ROUND_MAX_MS=900000 LOBBY_STALL_MS=15000 npm start
 *     node tools/testbots.js --port 3400 --bots 3 --die 0,0,0 --run 900
 *
 * ★ 왜 도구로 만들었나 — 처음 찍은 영상은 <b>W 만 계속 눌러</b> 캐릭터가
 *   난간에 붙어 제자리 뛰기를 하는 그림이 됐습니다. 사람이 손으로 찍으면
 *   같은 실수를 반복하게 되고, 다시 찍을 때마다 결과가 달라집니다.
 *   움직임을 <b>표로 적어 두면</b> 몇 번이고 같은 그림을 얻습니다.
 *
 * ★ 앞모습이 나오는 원리 — 이 게임의 이동은 <b>카메라 상대</b>이고
 *   캐릭터는 <b>이동 방향을 봅니다</b>(local.ry = atan2(wish.x, wish.z)).
 *   그래서 W 를 누르면 언제나 등만 보입니다. <b>S 를 누르면 카메라 쪽으로
 *   달려오며 얼굴이 보입니다.</b> 시점 드래그로 각도를 같이 돌리면
 *   옆·앞이 섞인 자연스러운 그림이 됩니다.
 *
 * ⚠ 난간에 박히지 않게 <b>방향을 계속 바꿉니다.</b> 한 방향으로 3초만
 *   달려도 질주 속도(21.5)로 64유닛을 가는데, 아레나 반지름이 48 입니다.
 * ⚠ 화면 캡처는 Page.startScreencast 를 씁니다 — 사용자가 버튼을 누를
 *   필요가 없어 <b>다시 찍기가 쉽습니다</b>(처음에는 사람이 눌러야 했습니다).
 * ======================================================================== */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = process.argv[2] || '3400';
const OUTDIR = process.argv[3] || path.join(os.tmpdir(), 'ipg_clip');
const SECS = parseFloat(process.argv[4] || '30');
const WIN = process.argv.includes('--win');   // 승리 연출까지 찍습니다
const DPORT = 9360;
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'ipg_rec_' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (p) => (await fetch('http://127.0.0.1:' + DPORT + p)).json();

let id = 0;
function rpc(ws, m, p) {
  return new Promise((res, rej) => {
    const i = ++id;
    const on = (raw) => { let x; try { x = JSON.parse(raw); } catch (e) { return; }
      if (x.id === i) { ws.off('message', on); x.error ? rej(new Error(m + ': ' + x.error.message)) : res(x.result); } };
    ws.on('message', on); ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
}

/* ── 움직임 표 ────────────────────────────────────────────────────────
 * at  : 시작 시각(초)   keys: 그때부터 누르고 있을 키
 * drag: 시점 회전(화면 px, 양수 = 왼쪽으로 돈다)   dur: 그 드래그에 걸릴 초
 * 같은 시각에 keys 와 drag 를 함께 줄 수 있습니다.
 *   W=앞(등 보임) · S=뒤(<b>앞모습</b>) · A/D=옆 · Shift=질주 · Space=점프
 * zoom: 카메라 거리(유닛). 기본은 24×월드배율 ≈ 34 로 <b>너무 멉니다</b> —
 *       처음 찍은 것이 캐릭터가 콩알만 하게 나온 원인입니다.
 *       ★ 휠 줌 한계(12×배율 ≈ 17)보다 <b>더 당길 수 있습니다</b> —
 *         cam.dist 는 매 프레임 targetDist 로 lerp 될 뿐 클램프가 없고,
 *         한계는 휠·핀치 핸들러와 applyWorldScale 에만 걸려 있습니다.
 *         얼굴을 보여 줄 때는 12~13 까지 붙입니다.
 * ------------------------------------------------------------------ */
const SHOT = [
  { at: 0.0,  keys: [], zoom: 12,       drag: 520, dur: 2.2, note: '바짝 붙어 앞으로 돌기 — 얼굴' },
  { at: 1.2,  tap: 'Space' },
  { at: 2.6,  keys: ['KeyS', 'ShiftLeft'], zoom: 13, note: '카메라 쪽으로 질주 — 앞모습' },
  { at: 4.4,  tap: 'Space' },
  { at: 5.2,  keys: ['KeyS', 'KeyD'],   zoom: 14, drag: -260, dur: 1.6, note: '비스듬히 — 옆앞' },
  { at: 6.8,  keys: ['KeyW', 'ShiftLeft'], zoom: 21, drag: -420, dur: 2.4, note: '물러나며 곡선 질주' },
  { at: 8.2,  tap: 'Space' },
  { at: 9.4,  keys: ['KeyA'],           zoom: 17, drag: 300,  dur: 1.4, note: '옆으로' },
  { at: 10.8, keys: ['KeyS', 'ShiftLeft'], zoom: 12, drag: 180, dur: 1.6, note: '다시 바짝 — 앞모습' },
  { at: 12.2, tap: 'Space' },
  { at: 13.0, keys: ['KeyW', 'KeyD', 'ShiftLeft'], zoom: 22, drag: -520, dur: 2.6, note: '크게 돌며 질주' },
  { at: 15.4, tap: 'Space' },
  { at: 16.0, keys: ['KeyD'],           zoom: 16, drag: 240,  dur: 1.2 },
  { at: 17.2, keys: ['KeyS', 'ShiftLeft'], zoom: 12, note: '앞모습' },
  { at: 19.0, tap: 'Space' },
  { at: 19.8, keys: ['KeyW', 'KeyA', 'ShiftLeft'], zoom: 20, drag: -300, dur: 2.0 },
  { at: 22.0, keys: ['KeyS'],           zoom: 12, drag: 420, dur: 2.0, note: '천천히 다가오며 마무리' },
  { at: 24.5, keys: [] }
];

/* ── 승리 연출 전용 표 (--win) ──────────────────────────────────────
 * 봇이 먼저 죽고 <b>이 주자가 살아남아야</b> lastStanding → 등록결정 도장이
 * 나옵니다. 그래서 이 표의 목적은 '멋진 그림' 이 아니라 <b>안 죽는 것</b>입니다.
 *
 * ★ 원을 그리며 걷습니다 — W 를 누른 채 시점을 일정 속도로 돌리면 캐릭터가
 *   원을 그립니다(반지름 = 속도 ÷ 각속도). 매번 <b>새 타일</b>을 밟으므로
 *   밟은 자리가 무너져도 발밑이 남고, 중심에서 일정 거리라 난간에도 안 박힙니다.
 * ⚠ 질주(Shift)는 넣지 않습니다 — 속도가 21.5 면 원이 커져 난간에 닿습니다.
 * ⚠ 제자리를 오가면 안 됩니다. 같은 타일을 두 번 밟으면 무너집니다.
 *   드래그 0.0055 rad/px 이므로 135px/초 면 각속도 0.74 rad/s,
 *   걷기 15 기준 반지름 약 20 — 아레나(48) 안쪽에서 안전하게 돕니다.     */
const WIN_SHOT = (() => {
  const t = [{ at: 0.0, keys: ['KeyW'], zoom: 16, note: '원을 그리며 걷기 — 살아남기' }];
  for (let i = 0; i < 12; i++) t.push({ at: 0.2 + i * 2.0, drag: 270, dur: 2.0 });
  [3.0, 7.0, 11.0, 15.0].forEach((a) => t.push({ at: a, tap: 'Space' }));
  t.push({ at: 17.0, zoom: 14 });          // 도장이 뜰 즈음 조금 당깁니다
  return t.sort((a, b) => a.at - b.at);
})();

/* 시작 카메라 거리. 24×배율(≈34)이 기본인데 홍보영상으로는 멉니다. */
const ZOOM_START = 12;   // 휠 한계(≈17)보다 가깝게 — 위 zoom 주석 참고

const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, ShiftLeft: 16, Space: 32 };
const KEYNAME = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ShiftLeft: 'Shift', Space: ' ' };

(async () => {
  fs.rmSync(OUTDIR, { recursive: true, force: true });
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const chrome = spawn(CHROME, [
    '--remote-debugging-port=' + DPORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,760', 'http://localhost:' + PORT + '/?fs=0'
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 40 && !t; i++) { await sleep(500);
    try { t = (await http('/json')).find((x) => x.type === 'page' && x.url.includes('localhost:' + PORT)); } catch (e) {} }
  if (!t) { console.log('크롬 타깃을 못 찾았습니다'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable');

  /* 창 크기와 무관하게 뷰포트를 1920x1080 으로 고정합니다 —
     영상 비율이 기기에 따라 달라지면 안 됩니다. */
  await rpc(ws, 'Emulation.setDeviceMetricsOverride',
    { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  const ev = async (e, a) => (await rpc(ws, 'Runtime.evaluate',
    { expression: e, awaitPromise: !!a, returnByValue: true })).result.value;

  await sleep(2500);
  /* 이름칸 id 는 <b>#nameInput</b> 입니다. 처음에 #joinName 으로 썼다가
     이름이 무작위(출원인996)로 찍혔습니다 — 영상에 그대로 나옵니다. */
  await ev([
    '(async()=>{const t0=Date.now();',
    'while(!document.querySelector("#btnJoin")&&Date.now()-t0<30000) await new Promise(r=>setTimeout(r,300));',
    'const n=document.querySelector("#nameInput");   /* ⚠ joinName 아님 */',
    'if(n){n.value="출원인 김특허";n.dispatchEvent(new Event("input",{bubbles:true}));}',
    'document.querySelector("#btnJoin").click(); return 1})()'
  ].join(''), true);

  console.log('  라운드 시작을 기다립니다…');
  const role = await ev([
    '(async()=>{const t0=Date.now();',
    'while(document.body.classList.contains("lobby")&&Date.now()-t0<60000)',
    ' await new Promise(r=>setTimeout(r,400));',
    'return document.body.className||"(주자)"})()'
  ].join(''), true);
  if (String(role).includes('spectating')) {
    console.error('  ❌ 관전자로 들어갔습니다 — 라운드가 이미 시작된 것입니다. 서버를 다시 띄우세요.');
    ws.close(); chrome.kill(); process.exit(2);
  }
  await sleep(3200);          // 발판에서 최상층으로 떨어져 안정될 때까지

  /* 카메라를 당깁니다. ⚠ applyWorldScale 이 targetDist 를 덮으므로
     <b>맵이 다 만들어진 뒤</b>(라운드 시작 후) 설정해야 합니다.
     userZoomed 를 세워야 그 뒤 재계산에서 dist 가 되돌아가지 않습니다. */
  const zoomTo = (d) => ev('cam.userZoomed=true;cam.targetDist=' + d + ';cam.dist=' + d + ';cam.targetDist');
  const z0 = await zoomTo(WIN ? 16 : ZOOM_START);
  console.log('  카메라 거리 → ' + z0 + ' (기본 약 34)');

  /* ── 캡처 시작 ───────────────────────────────────────────────── */
  let n = 0; const manifest = [];
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.method !== 'Page.screencastFrame') return;
    const p = m.params;
    fs.writeFileSync(path.join(OUTDIR, String(++n).padStart(5, '0') + '.jpg'),
      Buffer.from(p.data, 'base64'));
    manifest.push(p.metadata.timestamp);
    try { await rpc(ws, 'Page.screencastFrameAck', { sessionId: p.sessionId }); } catch (e) {}
  });
  await rpc(ws, 'Page.startScreencast',
    { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  /* ── 움직임 실행 ─────────────────────────────────────────────── */
  const down = new Set();
  const key = (code, type) => rpc(ws, 'Input.dispatchKeyEvent', {
    type, code, key: KEYNAME[code], windowsVirtualKeyCode: VK[code],
    nativeVirtualKeyCode: VK[code],
    modifiers: code === 'ShiftLeft' ? 8 : 0
  });
  const setKeys = async (list) => {
    for (const c of [...down]) if (!list.includes(c)) { await key(c, 'keyUp'); down.delete(c); }
    for (const c of list) if (!down.has(c)) { await key(c, 'keyDown'); down.add(c); }
  };
  const tap = async (c) => { await key(c, 'keyDown'); await sleep(70); await key(c, 'keyUp'); };
  /* 시점 드래그 — 캔버스를 누른 채 가로로 끕니다 */
  const drag = async (px, dur) => {
    const steps = Math.max(6, Math.round(dur * 30));
    let x = 960; const y = 560;
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 0; i < steps; i++) {
      x += px / steps;
      await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y, button: 'left', buttons: 1 });
      await sleep((dur * 1000) / steps);
    }
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y, button: 'left', buttons: 0 });
  };

  const t0 = Date.now();
  const timers = [];
  for (const s of (WIN ? WIN_SHOT : SHOT)) {
    timers.push(setTimeout(async () => {
      try {
        if (s.zoom) await zoomTo(s.zoom);
        if (s.keys) await setKeys(s.keys);
        if (s.tap) await tap(s.tap);
        if (s.drag) drag(s.drag, s.dur || 1.5);
        if (s.note) console.log('  ' + s.at.toFixed(1) + 's  ' + s.note);
      } catch (e) { /* 창이 닫히는 중 */ }
    }, s.at * 1000));
  }

  await sleep(SECS * 1000);
  for (const t of timers) clearTimeout(t);
  await setKeys([]);
  try { await rpc(ws, 'Page.stopScreencast'); } catch (e) {}
  await sleep(400);

  const won = await ev('(()=>{try{return document.body.className+" | 결과화면:"+' +
    '(!!document.querySelector("#result")&&getComputedStyle(document.querySelector("#result")).display!=="none")}catch(e){return "?"}})()');
  if (WIN) console.log('  끝난 뒤 상태: ' + won);

  const t1 = manifest.length ? manifest[manifest.length - 1] - manifest[0] : 0;
  fs.writeFileSync(path.join(OUTDIR, 'frames.json'), JSON.stringify(manifest));
  console.log('');
  console.log('  프레임 ' + n + '개 · ' + t1.toFixed(1) + '초 · ' +
    (n / Math.max(0.001, t1)).toFixed(1) + 'fps → ' + OUTDIR);

  ws.close(); chrome.kill(); await sleep(700);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
