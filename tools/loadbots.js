#!/usr/bin/env node
/* ===========================================================================
 * 서버 부하 측정
 * ---------------------------------------------------------------------------
 * 봇을 N 명 붙여 <b>실제로 움직이게</b> 하고, 서버가 20Hz 스냅샷 리듬을
 * 지키는지 잽니다.
 *
 * ★ testbots.js 와 무엇이 다른가
 *   testbots.js 는 <b>규칙</b>을 검증합니다(탈락 순위·시간 만료·개입).
 *   이 도구는 <b>부하</b>만 봅니다 — 규칙이 맞는지는 보지 않고, 인원이
 *   늘어도 틱이 밀리지 않는지, 메모리가 어디까지 가는지를 잽니다.
 *
 * ★ 왜 가만히 서 있는 봇으로는 안 되는가
 *   서버 비용의 상당 부분이 <b>타일 상태 변화</b>입니다(밟기·퓨즈 예약·
 *   붕괴 브로드캐스트). 가만히 있는 봇은 그걸 하나도 만들지 않아,
 *   "160명도 문제없다" 같은 안심시키는 거짓 결과가 나옵니다.
 *   그래서 원을 그리며 계속 달리게 합니다.
 *
 * ★ 무엇을 보는가
 *   스냅샷 <b>도착 간격</b>입니다. 서버는 20Hz(50ms)를 목표로 하는데,
 *   윈도우 타이머 해상도 때문에 부하가 없어도 평균 57ms 쯤 나옵니다.
 *   그 값 자체가 아니라 <b>인원을 늘렸을 때 늘어나는지</b>를 봅니다.
 *   '1틱 밀림'(75ms 초과)이 몇 % 인지가 핵심 지표입니다.
 *
 * 쓰는 법
 *   # 먼저 서버를 띄우고 (부하용이므로 전용 포트를 권합니다)
 *   PORT=3100 npm start
 *
 *   node tools/loadbots.js                    # 기본: 40봇 · 30초 · 3100 포트
 *   node tools/loadbots.js --bots 120 --sec 40
 *   node tools/loadbots.js --bots 160 --port 3000
 *
 * 참고값 (2026-09-18 · 개발 노트북)
 *   40봇  / 10방 : 간격 평균 57.7ms · p95 66ms · 밀림 0.00%
 *   120봇 / 30방 : 간격 평균 57.5ms · p95 68ms · 밀림 0.14% · 메모리 138MB
 *   → 이 범위에서는 서버가 병목이 아닙니다. 값이 이보다 크게 나빠졌다면
 *     스냅샷에 필드를 더했거나 틱 안에서 도는 일이 늘어난 것입니다.
 * ======================================================================== */

'use strict';

const io = require('socket.io-client');

/* ── 인자 ─────────────────────────────────────────────────────────────── */
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0 || i + 1 >= process.argv.length) return dflt;
  const v = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(v) ? v : dflt;
}

const BOTS = arg('bots', 40);
const SEC  = arg('sec', 30);
const PORT = arg('port', 3100);
const URL  = 'http://localhost:' + PORT;

/* 한꺼번에 붙이면 접속 폭주가 틱 밀림으로 잡혀 측정이 오염됩니다.
 * 60ms 씩 띄워 붙입니다 — 행사장에서 사람이 들어오는 속도와도 비슷합니다. */
const JOIN_STAGGER_MS = 60;

/* 이보다 늦게 온 스냅샷을 '1틱 밀림'으로 셉니다. 목표 50ms + 여유.     */
const LATE_MS = 75;

/* ── 봇 ───────────────────────────────────────────────────────────────── */
const bots = [];
const gaps = [];
let snaps = 0, lastSnap = 0;

function spawn(i) {
  const sock = io(URL, { transports: ['websocket'], tryAllTransports: false });
  const b = { i, sock, t: Math.random() * 6.28, pos: null, home: null, layer: 6, keep: 0 };
  bots.push(b);

  sock.on('connect', () => sock.emit('join', { name: '봇' + i, mode: 'player' }));

  sock.on('init', (d) => {
    b.id = d.selfId;
    const me = (d.players || []).find((p) => p.id === d.selfId);
    if (me) { b.pos = { x: me.pos.x, y: me.pos.y, z: me.pos.z }; b.home = { ...b.pos }; b.layer = me.layer; }
    if (b.keep) clearInterval(b.keep);
    /* 클라이언트와 같은 20Hz 로 보고합니다. 이 주기를 바꾸면 서버가 받는
     * 양이 달라져 측정이 실제와 어긋납니다.                            */
    b.keep = setInterval(() => {
      if (!b.pos) return;
      b.t += 0.06;
      b.pos.x = b.home.x + Math.cos(b.t) * 7;
      b.pos.z = b.home.z + Math.sin(b.t) * 7;
      sock.emit('player_state', {
        p: [b.pos.x, b.pos.y, b.pos.z], v: [0, 0, 0],
        ry: b.t, cy: b.t, cp: 0.5,
        layer: b.layer, anim: 'run', g: true
      });
    }, 50);
    /* 대기실 규칙(2026-09-17)상 방장이 눌러야 시작합니다. 누가 방장이 될지
     * 모르므로 전원이 준비를 누르고 전원이 시작을 시도합니다 — 방장이
     * 아닌 쪽은 서버가 조용히 거절합니다.                              */
    setTimeout(() => sock.emit('toggle_ready', { ready: true }), 1500);
    setTimeout(() => sock.emit('start_round'), 4000);
  });

  sock.on('state', (sn) => {
    if (b.id && sn.s) {
      const me = sn.s.find((x) => x.id === b.id);
      if (me && me.p) { b.pos.y = me.p[1]; if (me.l) b.layer = me.l; }
    }
    /* 간격은 <b>봇 하나</b>만 잽니다. 전원이 재면 같은 틱이 N 번 세어져
     * 표본만 부풀고 분포는 똑같습니다.                                 */
    if (b.i !== 0) return;
    const now = Date.now();
    snaps++;
    if (lastSnap) gaps.push(now - lastSnap);
    lastSnap = now;
  });

  /* 봇이 죽어도 계속 붙여 둡니다 — 관전자도 스냅샷을 받으므로 부하는
   * 그대로이고, 되살리려 재접속하면 그게 또 다른 부하가 됩니다.       */
  sock.on('connect_error', (e) => {
    if (b.i === 0) console.error('[접속 실패] ' + (e && e.message));
  });
  return b;
}

console.log('부하 측정 — 봇 ' + BOTS + '명 · ' + SEC + '초 · ' + URL);
for (let i = 0; i < BOTS; i++) setTimeout(() => spawn(i), i * JOIN_STAGGER_MS);

/* ── 결과 ─────────────────────────────────────────────────────────────── */
setTimeout(async () => {
  let health = null, rooms = [];
  try { health = await (await fetch(URL + '/healthz')).json(); } catch (e) {}
  try { rooms = await (await fetch(URL + '/api/rooms')).json(); } catch (e) {}

  const sorted = gaps.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((s, x) => s + x, 0) / (sorted.length || 1);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
  const late = sorted.filter((g) => g > LATE_MS).length;
  const playing = rooms.filter((r) => r.phase === 'playing').length;

  console.log('');
  console.log('=== 결과 ===');
  console.log('  봇             ' + BOTS + '명 · 방 ' + rooms.length + '개 (진행 중 ' + playing + ')');
  console.log('  스냅샷 표본    ' + sorted.length);
  console.log('  간격 평균      ' + avg.toFixed(1) + 'ms   (목표 50 · 무부하에서도 57 안팎)');
  console.log('  간격 p50/p95   ' + pick(0.5) + ' / ' + pick(0.95) + 'ms');
  console.log('  1틱 밀림       ' + late + '회 (' + (late / (sorted.length || 1) * 100).toFixed(2) + '%)  ← 핵심 지표');
  if (health) console.log('  서버 가동      ' + health.uptime.toFixed(0) + '초 · 방 ' + health.rooms + '개');
  console.log('');
  console.log('  메모리는 별도로 보세요 —  tasklist /FI "IMAGENAME eq node.exe"');

  /* 인터벌을 먼저 끊고 소켓을 닫습니다. 안 그러면 닫히는 중인 핸들에
   * emit 이 들어가 libuv 어서션으로 죽습니다(측정값은 이미 찍혔지만
   * 종료 코드가 더러워집니다).                                        */
  for (const b of bots) { if (b.keep) clearInterval(b.keep); }
  for (const b of bots) { try { b.sock.close(); } catch (e) {} }
  setTimeout(() => process.exit(0), 300);
}, SEC * 1000);
