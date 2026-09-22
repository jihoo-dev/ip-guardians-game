/* ===========================================================================
 * 「한 프레임 수평 점프 한 번」이 보정 연쇄를 부르는가
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/jumpcheck.js <포트> <점프거리>
 *   예)    PORT=3400 ROUND_MAX_MS=600000 LOBBY_STALL_MS=6000 npm start
 *          node tools/jumpcheck.js 3400 6.26
 *
 * ★ 무한 낙하의 <b>뒷부분</b>을 재는 도구입니다. 앞부분(클램프가 크게 끄는 것)은
 *   클라이언트 문제이고, 이쪽은 <b>한 번 거절되면 왜 계속 거절되는가</b> 입니다.
 *   서버는 거절된 보고로 lastGood 을 갱신하지 않으므로, 한 번 크게 벗어나면
 *   <b>그 뒤 보고가 전부 같은 거리만큼 벗어나</b> 연달아 거절됩니다.
 *
 * 실측(2026-09-22, MAX_STEP 6.0): 4.40 → 보정 0회 · 5.90 → 0회 ·
 *   <b>6.26 → 32회</b> · 6.50 → 31회. 경계를 한 번 넘으면 회차 내내 끌려다닙니다.
 * ======================================================================== */
const path = require('path');
const { io } = require(require('path').join(__dirname, '..', 'node_modules', 'socket.io-client'));
const PORT = process.argv[2] || '3400';
const JUMP = parseFloat(process.argv[3] || '6.26');
const G = 62, MAXFALL = -90, STEP = 1 / 60, HZ = 20;

const s = io('http://localhost:' + PORT, { transports: ['websocket'], reconnection: false });
let pos = null, layer = 6, playing = false, vy = 0, t = 0, jumped = false;
let corrections = 0, sent = 0, afterJump = 0;

s.on('connect', () => s.emit('join', { name: '점프봇', mode: 'player' }));
s.on('init', (d) => {
  const me = (d.players || []).find((p) => p.id === d.selfId);
  if (me) { pos = { ...me.pos }; layer = me.layer; }
  s.emit('toggle_ready', { ready: true });
});
s.on('phase', (d) => {
  if (d.phase === 'waiting') {
    s.emit('toggle_ready', { ready: true });
    if (d.hostId === s.id && d.canStart) s.emit('start_round');
  }
  if (d.phase === 'playing') playing = true;
});
s.on('state', (snap) => {
  const me = (snap.players || []).find((p) => p.id === s.id);
  if (me && me.l != null) layer = me.l;
  if (!playing && me && me.p) pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
});
s.on('state_correction', () => { corrections++; });

setInterval(() => {
  if (!playing || !pos) return;
  t += 1 / HZ;
  /* 정직하게 떨어집니다 */
  for (let i = 0; i < 3; i++) { vy = Math.max(MAXFALL, vy - G * STEP); pos.y += vy * STEP; }
  if (pos.y < -14) { pos.y = -14; vy = 0; }
  /* 3초 시점에 딱 한 번, 수평으로 JUMP 만큼 — 층 전환 클램프가 끄는 것과 같은 크기 */
  if (!jumped && t >= 3) { jumped = true; pos.x += JUMP; }
  if (jumped) afterJump++;
  s.emit('player_state', {
    p: [pos.x, pos.y, pos.z], v: [0, vy, 0], ry: 0,
    layer, anim: 'fall', g: pos.y <= -14 ? 1 : 0
  });
  sent++;
}, 1000 / HZ);

setTimeout(() => {
  console.log('  수평 점프 ' + JUMP.toFixed(2) + ' 유닛 한 번 → 보정 ' + corrections +
    '회   (점프 뒤 보고 ' + afterJump + '건 / 전체 ' + sent + '건)   ' +
    (corrections > 0 ? '❌ 보정 발생' : '✓ 통과'));
  process.exit(0);
}, 14000);
