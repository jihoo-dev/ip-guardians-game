/* ===========================================================================
 * 동시 입장 폭주 — 행사장에서 QR 을 동시에 찍고 우르르 들어올 때
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/joinburst.js --port 3000 --people 24 [--spread 0]
 *   --spread <ms>  그 시간에 걸쳐 고르게 들어옵니다(0 이면 완전 동시)
 *
 * ★ loadbots 와 다른 것 — 저쪽은 <b>정상 상태의 틱 지연</b>을 봅니다.
 *   이쪽은 <b>들어오는 순간</b>만 봅니다: 몇 초 만에 자리를 받는지,
 *   방이 어떻게 갈리는지, 관전자로 밀리는 사람이 몇인지, 거절이 있는지.
 *
 * ⚠ <b>'인원 분포' 가 정원을 넘어 보일 수 있는데 서버 버그가 아닙니다.</b>
 *   이 표는 '각자 자기 init 시점에 본 방' 을 몇 초에 걸쳐 합산한 것입니다.
 *   그 사이 누가 재연결하며 자리를 비웠다 다른 사람이 그 자리를 받으면
 *   같은 방을 <b>두 사람이 각각</b> 기록합니다(실측: 4인 방에 5 로 표시).
 *   실제 동시 인원은 GET /api/rooms 로 보세요 — 서버는 단일 스레드라
 *   findOpenRoom 의 검사와 배정이 같은 턴에 끝나 정원 초과가 불가능합니다
 *   (24초 폴링으로 초과 0건 · 좌석 번호 중복 0건 확인).
 *
 * ⚠ 방이 갈리는 것 자체는 정상입니다(MAX_PLAYERS 를 넘으면 새 방).
 *   봐야 할 것은 <b>자리를 못 받는 사람</b>과 <b>지나치게 잘게 갈리는 것</b>
 *   (예: 4인 방 정원인데 1~2명짜리 방이 잔뜩 생기는 경우)입니다.
 * ======================================================================== */
const { io } = require(require('path').join(__dirname, '..', 'node_modules', 'socket.io-client'));

const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const PORT   = get('--port', '3000');
const N      = parseInt(get('--people', '24'), 10);
const SPREAD = parseInt(get('--spread', '0'), 10);
const WAIT   = parseInt(get('--wait', '20'), 10) * 1000;
const URL = 'http://localhost:' + PORT;

const people = [];
let done = 0;

function one(i) {
  const rec = { i, t0: 0, ms: null, role: null, room: null, err: null, retry: 0 };
  people.push(rec);
  const delay = SPREAD ? Math.round(SPREAD * i / N) : 0;
  setTimeout(() => {
    rec.t0 = Date.now();
    /* ⚠ 실제 클라이언트와 <b>같은 옵션</b>이어야 합니다. reconnection:false 로
       재면 업그레이드가 한 번 삐끗한 사람을 전부 '실패' 로 세어, 지연 200ms
       에서 6/24 가 못 들어온 것처럼 보입니다(실측). 진짜 클라이언트는
       무한 재연결이라 그 사람들도 곧 들어옵니다.                        */
    const s = io(URL, {
      transports: ['polling', 'websocket'], tryAllTransports: true, upgrade: true,
      reconnectionAttempts: Infinity, reconnectionDelayMax: 4000, timeout: 8000
    });
    s.io.on('reconnect_attempt', () => { rec.retry = (rec.retry || 0) + 1; });
    s.on('connect', () => s.emit('join', { name: '참가자' + (i + 1), mode: 'player' }));
    s.on('init', (d) => {
      if (rec.ms != null) return;
      rec.ms = Date.now() - rec.t0;
      rec.role = d.role;
      rec.room = d.roomId || (d.room && d.room.id) || '?';
      done++;
    });
    s.on('connect_error', (e) => { rec.err = e.message; });   // 재연결이 이어받습니다
    rec.sock = s;
  }, delay);
}

console.log('[joinburst] ' + URL + ' 에 ' + N + '명이 ' +
  (SPREAD ? (SPREAD + 'ms 에 걸쳐') : '동시에') + ' 입장합니다.');
for (let i = 0; i < N; i++) one(i);

setTimeout(() => {
  const ok = people.filter((p) => p.ms != null);
  const bad = people.filter((p) => p.ms == null);
  const ms = ok.map((p) => p.ms).sort((a, b) => a - b);
  const q = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : -1;
  const rooms = {};
  for (const p of ok) rooms[p.room] = (rooms[p.room] || 0) + 1;
  const roles = {};
  for (const p of ok) roles[p.role] = (roles[p.role] || 0) + 1;

  console.log('\n  자리 받음      ' + ok.length + ' / ' + N +
    (bad.length ? ('   ❌ 실패 ' + bad.length + '명 (' + (bad[0].err || '응답 없음') + ')') : '   ✓'));
  console.log('  입장 소요      p50 ' + q(0.5) + 'ms · p95 ' + q(0.95) + 'ms · 최대 ' + (ms[ms.length - 1] || 0) + 'ms');
  const retried = ok.filter((p) => p.retry > 0).length;
  console.log('  역할 분포      ' + JSON.stringify(roles) +
    (retried ? ('   · 재연결 거친 사람 ' + retried + '명') : ''));
  const sizes = Object.values(rooms).sort((a, b) => b - a);
  console.log('  방 ' + Object.keys(rooms).length + '개  인원 분포 ' + JSON.stringify(sizes));
  const singles = sizes.filter((v) => v === 1).length;
  console.log('  판정          ' +
    (bad.length ? '❌ 자리를 못 받은 사람이 있습니다'
      : singles > Math.ceil(Object.keys(rooms).length / 2)
        ? '⚠ 1인 방이 ' + singles + '개 — 지나치게 잘게 갈렸습니다'
        : '✓ 전원 입장 · 방 분배 정상'));
  for (const p of people) { try { p.sock && p.sock.close(); } catch (e) {} }
  process.exit(0);
}, WAIT);
