/* ===========================================================================
 * 좌석 배정 점검 — 나갔다 들어와도 발판·옷 색이 겹치지 않는가
 * ---------------------------------------------------------------------------
 * 쓰는 법:  LOBBY_STALL_MS=300000 PORT=3400 npm start
 *           node tools/seatcheck.js 3400
 *
 * ★ 왜 필요한가 — 좌석 번호 하나가 <b>대기 발판 위치와 옷 색을 동시에</b>
 *   정합니다(makePlayer). 그래서 좌석이 겹치면 두 사람이 같은 자리에 같은
 *   모습으로 서고, 화면만 봐서는 누가 누군지 구분되지 않습니다.
 *
 * ⚠ 2026-09-22 에 실제로 났던 버그입니다 — 좌석을 <b>room.players.size</b>
 *   (인원 수)로 주고 있었습니다. 그건 아무도 빠지지 않았을 때만 맞는 값이라,
 *   1번이 나갔다 들어오면 남아 있는 2번의 번호를 그대로 받았습니다.
 *   지금은 freeSeat() 이 <b>실제로 비어 있는 번호</b>를 찾습니다.
 *
 * ⚠ 반드시 <b>대기실에서</b> 재세요. 라운드가 시작되면 resetRoom 이 좌석을
 *   0,1,2… 로 다시 정렬하므로 충돌이 저절로 지워져 <b>안 나는 것처럼</b>
 *   보입니다 — 사용자가 본 것도 대기 발판이었습니다.
 *   그래서 LOBBY_STALL_MS 를 크게 주어 대기실에 머물게 합니다.
 * ======================================================================== */
const path = require('path');
const { io } = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));
const PORT = process.argv[2] || '3400';
const URL = 'http://localhost:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function join(name, roomId, create) {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    const st = { s, name, seat: null, color: null, spawn: null, room: null, role: null };
    s.on('connect', () => s.emit('join', { name, mode: 'player', roomId, create: !!create }));
    s.on('init', (d) => {
      st.room = d.roomId || (d.room && d.room.id);
      st.role = d.role;
      const me = (d.players || []).find((p) => p.id === d.selfId);
      if (me) { st.seat = me.seat; st.color = me.color;
        st.spawn = me.pos ? Math.round(me.pos.x * 10) / 10 + ',' + Math.round(me.pos.z * 10) / 10 : null; }
      res(st);
    });
    setTimeout(() => res(st), 8000);
  });
}
const dup = (arr, k) => {
  const v = arr.filter((p) => p.role === 'player').map((p) => p[k]);
  return v.length !== new Set(v).size;
};
function verdict(label, live) {
  const seats = live.map((p) => p.name + '→' + p.seat).join(' · ');
  const bad = dup(live, 'seat') || dup(live, 'color') || dup(live, 'spawn');
  console.log('    ' + label.padEnd(34) + seats + '   ' + (bad ? '❌ 겹침' : '✓'));
  return !bad;
}

(async () => {
  let ok = true;

  /* ① 가운데 사람이 빠졌다 돌아오기 (3인 중 2번) */
  {
    const a = await join('A', null, true); await sleep(400);
    const b = await join('B', a.room);     await sleep(400);
    const c = await join('C', a.room);     await sleep(400);
    ok &= verdict('① 3인 최초', [a, b, c]);
    b.s.close(); await sleep(1500);
    const b2 = await join('B', a.room);    await sleep(400);
    ok &= verdict('   가운데(B) 재입장', [a, b2, c]);
    for (const p of [a, b2, c]) p.s.close();
    await sleep(1200);
  }

  /* ② 정원(4인)까지 채우기 — 좌석 0~3 이 모두 달라야 */
  {
    const ps = [];
    const first = await join('P1', null, true); ps.push(first); await sleep(400);
    for (let i = 2; i <= 4; i++) { ps.push(await join('P' + i, first.room)); await sleep(400); }
    ok &= verdict('② 정원 4인', ps);
    /* 첫 사람이 빠졌다 돌아오면 빈 0번을 받아야 */
    ps[0].s.close(); await sleep(1500);
    const back = await join('P1', first.room); await sleep(400);
    ok &= verdict('   맨 앞(P1) 재입장', [back, ps[1], ps[2], ps[3]]);
    for (const p of ps.concat([back])) { try { p.s.close(); } catch (e) {} }
    await sleep(1200);
  }

  /* ③ 여러 명이 동시에 나갔다 들어오기 */
  {
    const a = await join('X', null, true); await sleep(400);
    const b = await join('Y', a.room);     await sleep(400);
    const c = await join('Z', a.room);     await sleep(400);
    a.s.close(); c.s.close(); await sleep(1600);
    const a2 = await join('X', a.room); await sleep(300);
    const c2 = await join('Z', a.room); await sleep(400);
    ok &= verdict('③ 둘이 나갔다 둘 다 재입장', [a2, b, c2]);
    for (const p of [a2, b, c2]) { try { p.s.close(); } catch (e) {} }
  }

  console.log('');
  console.log('  종합: ' + (ok ? '✓ 전 경우 좌석·색·발판 겹침 없음' : '❌ 겹치는 경우가 있습니다'));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('오류:', e.message); process.exit(2); });
