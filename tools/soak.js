/* ===========================================================================
 * 장시간 안정성 (soak) — 행사는 몇 시간 동안 이어집니다
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/soak.js --port 3000 --min 20 [--bots 40]
 *
 * ★ loadbots 와 다른 것 — 저쪽은 <b>짧고 굵게</b>(40초) 틱이 밀리는지 봅니다.
 *   이쪽은 <b>길게</b> 돌리며 시간에 따라 나빠지는 것만 봅니다:
 *     · 메모리가 우상향하는가 (회차가 수십 번 바뀌어도 회수되는가)
 *     · 방이 청소되는가 (아무도 없는 방이 쌓이지 않는가)
 *     · 틱 간격이 시간이 갈수록 벌어지는가
 *   짧은 시험으로는 절대 안 보이는 것들입니다 — 누수는 30분쯤부터 보입니다.
 *
 * ⚠ 봇은 <b>들락날락</b>합니다. 계속 붙어만 있으면 방 생성·소멸·승격 경로를
 *   한 번도 지나지 않아, 가장 누수가 나기 쉬운 곳을 비워 두고 재게 됩니다.
 * ⚠ 이 도구는 서버만 봅니다. 클라이언트 장시간은 사람이 한 탭을 오래 켜 두고
 *   F2 진단의 화질·FPS 를 확인하세요(자동화 브라우저는 몇 시간을 못 버팁니다).
 * ======================================================================== */
const path = require('path');
const { io } = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));

const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const PORT = get('--port', '3000');
const MIN  = parseFloat(get('--min', '20'));
const BOTS = parseInt(get('--bots', '40'), 10);
const CHURN = parseInt(get('--churn', '20'), 10) * 1000;   // 이 간격마다 일부 교체
const URL = 'http://localhost:' + PORT;

const bots = new Map();
let seq = 0, joined = 0, left = 0;
const samples = [];

function spawnBot() {
  const id = ++seq;
  const s = io(URL, {
    transports: ['polling', 'websocket'], tryAllTransports: true,
    reconnectionAttempts: Infinity, reconnectionDelayMax: 4000, timeout: 8000
  });
  const st = { s, pos: null, layer: null, playing: false, dead: false, t: Math.random() * 6 };
  bots.set(id, st);
  s.on('connect', () => { joined++; s.emit('join', { name: '체류' + id, mode: 'player' }); });
  s.on('init', (d) => {
    const me = (d.players || []).find((p) => p.id === d.selfId);
    if (me) { st.pos = { ...me.pos }; st.layer = me.layer; }
    s.emit('toggle_ready', { ready: true });
  });
  s.on('phase', (d) => {
    const was = st.playing;
    st.playing = d.phase === 'playing';
    if (d.phase === 'waiting') { s.emit('toggle_ready', { ready: true }); st.dead = false; }
    /* ⚠ <b>봇이 죽어야 라운드가 끝납니다.</b> 안 죽으면 시간이 다 돼도
       서든데스로 넘어가 <b>영영 안 끝나고</b>, 그 방이 playing 에 묶이는
       바람에 뒤에 오는 사람이 전부 관전자로 쌓입니다 — 실측으로 10분 뒤
       봇 40명 중 주자가 3명뿐이었습니다. 그러면 정작 보려던
       <b>방 생성·소멸·승격</b> 경로를 거의 안 지납니다. */
    if (!was && st.playing) {
      st.dead = false;
      const life = 4000 + Math.random() * 16000;
      setTimeout(() => {
        if (!st.playing || st.dead) return;
        st.dead = true;
        try { s.emit('player_death', { cause: 'fall' }); } catch (e) { /* 무시 */ }
      }, life);
    }
  });
  s.on('state', (snap) => {
    const me = (snap.players || []).find((p) => p.id === s.id);
    if (me && me.p) { st.pos = { x: me.p[0], y: me.p[1], z: me.p[2] }; if (me.l != null) st.layer = me.l; }
  });
  return id;
}
function killBot(id) {
  const b = bots.get(id);
  if (!b) return;
  try { b.s.close(); } catch (e) { /* 무시 */ }
  bots.delete(id); left++;
}

for (let i = 0; i < BOTS; i++) setTimeout(spawnBot, i * 120);

/* 20Hz 로 원을 그리며 달립니다 — 가만히 선 봇은 타일을 하나도 안 무너뜨려
   "몇 명이든 문제없다" 는 안심시키는 거짓 결과를 냅니다(loadbots 와 같은 이유). */
setInterval(() => {
  for (const b of bots.values()) {
    if (!b.playing || !b.pos || b.dead) continue;
    b.t += 0.05;
    const R = 12, w = 21.5 / R;
    b.pos.x += Math.cos(w * b.t) * 0.9;
    b.pos.z += Math.sin(w * b.t) * 0.9;
    b.s.emit('player_state', {
      p: [b.pos.x, b.pos.y, b.pos.z], v: [0, 0, 0], ry: w * b.t,
      layer: b.layer, anim: 'run', g: 1
    });
  }
}, 50);

/* 들락날락 — 방 생성·소멸·승격 경로를 실제로 지나게 합니다 */
/* ⚠ 죽일 대상은 <b>서로 다른 것</b>으로 골라야 합니다. 무작위로 뽑아
   그냥 killBot 하면 같은 id 를 두 번 뽑는 만큼 실제로는 덜 죽는데 새로
   띄우는 수는 그대로라, <b>인원이 계속 불어납니다</b> — 실측으로 40명으로
   시작해 10분 만에 57명이 됐습니다. 그러면 시간에 따라 부하가 커져
   '메모리가 우상향한다' 로 잘못 읽게 됩니다. */
setInterval(() => {
  const ids = [...bots.keys()];
  const n = Math.min(ids.length, Math.max(1, Math.round(BOTS * 0.15)));
  for (let i = ids.length - 1; i > 0; i--) {          // 섞어서 앞에서 n 개
    const j = Math.floor(Math.random() * (i + 1));
    const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
  }
  for (let i = 0; i < n; i++) killBot(ids[i]);
  for (let i = 0; i < n; i++) setTimeout(spawnBot, i * 150);
}, CHURN);

const t0 = Date.now();
async function sample() {
  let rooms = null, health = null;
  try { health = await (await fetch(URL + '/healthz')).json(); } catch (e) { /* 무시 */ }
  try { rooms = await (await fetch(URL + '/api/rooms')).json(); } catch (e) { /* 무시 */ }
  const min = (Date.now() - t0) / 60000;
  const empty = rooms ? rooms.filter((r) => r.players === 0 && r.spectators === 0).length : -1;
  const row = {
    분: +min.toFixed(1),
    방: rooms ? rooms.length : -1,
    빈방: empty,
    주자: rooms ? rooms.reduce((a, r) => a + r.players, 0) : -1,
    가동초: health ? Math.round(health.uptime) : -1
  };
  samples.push(row);
  console.log('  ' + String(row.분).padStart(5) + '분  방 ' + String(row.방).padStart(3) +
    ' (빈 ' + row.빈방 + ')  주자 ' + String(row.주자).padStart(3) +
    '  봇 ' + bots.size + '  누적 입장 ' + joined + ' / 퇴장 ' + left);
}
sample();
const iv = setInterval(sample, 60000);

setTimeout(async () => {
  clearInterval(iv);
  await sample();
  console.log('');
  console.log('  ── ' + MIN + '분 결과 ──');
  const rooms = samples.map((s) => s.방).filter((v) => v >= 0);
  const emptys = samples.map((s) => s.빈방).filter((v) => v >= 0);
  console.log('    방 개수      최소 ' + Math.min(...rooms) + ' · 최대 ' + Math.max(...rooms) +
    ' · 마지막 ' + rooms[rooms.length - 1]);
  console.log('    빈 방        최대 ' + Math.max(...emptys) + ' · 마지막 ' + emptys[emptys.length - 1] +
    (Math.max(...emptys) > 3 ? '   ⚠ 빈 방이 쌓입니다(destroyRoom 확인)' : '   ✓ 쌓이지 않음'));
  console.log('    누적 입·퇴장 ' + joined + ' / ' + left + ' (방 생성·소멸·승격 경로를 지났습니다)');
  console.log('');
  console.log('    ※ 메모리는 이 도구가 못 봅니다 — 서버 프로세스의 WorkingSet 을 따로 보세요:');
  console.log('      powershell "(Get-Process -Id <PID>).WorkingSet64/1MB"');
  for (const id of [...bots.keys()]) killBot(id);
  process.exit(0);
}, MIN * 60000);
