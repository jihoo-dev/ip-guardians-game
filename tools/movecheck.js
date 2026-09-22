/* ===========================================================================
 * 이동 검증 점검 — 정직한 주자는 통과하고 치팅은 막히는가
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/movecheck.js <포트> [--quick]
 *   서버는 라운드가 충분히 긴 상태로 띄우세요:
 *     PORT=3400 ROUND_MAX_MS=600000 LOBBY_STALL_MS=8000 npm start
 *
 * 보는 것 — server.js 의 VALIDATE 가 두 가지를 동시에 해내는지.
 *   ① 정직한 주자를 되돌리지 않는가   (보고가 몰려 도착해도)
 *   ② 치팅을 막는가                  (수평 4종 · 수직 4종)
 *
 * ★ 왜 '보고 몰림' 을 재는가 — 클라이언트는 20Hz 로 정직하게 보내지만,
 *   폴링 전송·프록시 버퍼링·서버 이벤트루프 지연이 끼면 서버가 여러 개를
 *   <b>같은 순간에</b> 처리합니다. 그때 dt 가 0 에 가까워 예산이 안 차는데
 *   이동분은 그대로 빠져나가, <b>정직한 주자가 계속 보정당했습니다</b>
 *   (2026-09-21 수평 · 2026-09-22 수직 — 두 번 다 이 경로였습니다).
 *   배포 환경에서만 드러나므로 반드시 흉내 내서 재야 합니다.
 *
 * ⚠ 이 도구는 봇이라 물리가 없습니다. 좌표를 직접 만들어 보내므로
 *   '사람이 실제로 그렇게 움직일 수 있는가' 는 클라이언트 쪽에서 봅니다.
 * ======================================================================== */
const path = require('path');
const { io } = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));

const PORT = process.argv[2] || '3000';
const QUICK = process.argv.includes('--quick');
const URL = 'http://localhost:' + PORT;

const G = 62, MAXFALL = -90, STEP = 1 / 60, HZ = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 방에 들어가 라운드를 시작시키고, 보낸 좌표에 대한 보정 횟수를 셉니다. */
function runner(name, opts) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    const st = { corrections: 0, sent: 0, pos: null, layer: 6, playing: false, extra: {} };
    let timer = null, queue = [], flush = null;

    s.on('connect', () => s.emit('join', { name, mode: 'player' }));
    s.on('init', (d) => {
      const me = (d.players || []).find((p) => p.id === d.selfId);
      /* ⚠ init 의 층을 반드시 들고 있어야 합니다 — 비워 두면 첫 스냅샷까지
         layer 가 undefined 로 나가 서버가 맨 아래층으로 클램프합니다. */
      if (me) { st.pos = { ...me.pos }; st.layer = me.layer; }
      s.emit('toggle_ready', { ready: true });
    });
    s.on('phase', (d) => {
      if (d.phase === 'waiting') {
        s.emit('toggle_ready', { ready: true });
        if (d.hostId === s.id && d.canStart) s.emit('start_round');
      }
      if (d.phase === 'playing' && !st.playing) { st.playing = true; opts.onStart && opts.onStart(st); }
    });
    s.on('state', (snap) => {
      const me = (snap.players || []).find((p) => p.id === s.id);
      if (me && me.l != null) st.layer = me.l;
      if (!st.playing && me && me.p) st.pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
    });
    s.on('state_correction', (d) => { st.corrections++; opts.onCorrect && opts.onCorrect(st, d); });

    timer = setInterval(() => {
      if (!st.playing || !st.pos) return;
      const msg = opts.tick(st);
      if (!msg) return;
      if (opts.batchMs) queue.push(msg);
      else { s.emit('player_state', msg); st.sent++; }
    }, 1000 / HZ);

    if (opts.batchMs) {
      flush = setInterval(() => {
        while (queue.length) { s.emit('player_state', queue.shift()); st.sent++; }
      }, opts.batchMs);
    }

    setTimeout(() => {
      clearInterval(timer); if (flush) clearInterval(flush);
      try { s.close(); } catch (e) { /* 무시 */ }
      resolve(st);
    }, opts.ms || 12000);
  });
}

/* 원을 질주로 도는 정직한 주자 */
function honest(batchMs) {
  let t = 0, cx = null, cz = null;
  return runner('정직봇', {
    batchMs, ms: QUICK ? 9000 : 14000,
    onStart: (st) => { cx = st.pos.x; cz = st.pos.z; },
    tick: (st) => {
      t += 1 / HZ;
      const R = 12, w = 21.5 / R;
      const x = cx + R * Math.cos(w * t) - R;
      const z = cz + R * Math.sin(w * t);
      st.pos.x = x; st.pos.z = z;
      return { p: [x, st.pos.y, z], v: [0, 0, 0], ry: w * t, layer: st.layer, anim: 'run', g: 1 };
    }
  });
}

/* 정직하게 종단속도로 떨어지는 주자 (수직 버킷 확인).
 *
 * ⚠ 바다에 닿았다고 <b>위로 되돌려 다시 떨어뜨리면 안 됩니다</b> — 그 복귀가
 *   100유닛짜리 상승이라 서버가 '비행' 으로 막는 것이 정상인데, 표에는
 *   '정직한 낙하가 12번 보정당함' 으로 찍혀 <b>없는 버그를 만듭니다</b>
 *   (실제로 이 도구를 처음 짤 때 그렇게 나왔습니다).
 *   닿은 뒤에는 그냥 그 자리에 서 있습니다. */
function honestFall(batchMs) {
  let vy = 0, landed = false;
  return runner('낙하봇', {
    batchMs, ms: QUICK ? 9000 : 12000,
    tick: (st) => {
      if (!landed) {
        for (let i = 0; i < 3; i++) { vy = Math.max(MAXFALL, vy - G * STEP); st.pos.y += vy * STEP; }
        if (st.pos.y <= -14) { st.pos.y = -14; vy = 0; landed = true; }
      }
      return {
        p: [st.pos.x, st.pos.y, st.pos.z], v: [0, vy, 0], ry: 0,
        layer: st.layer, anim: landed ? 'idle' : 'fall', g: landed ? 1 : 0
      };
    }
  });
}

/* 치팅 여러 종류 */
function cheat(kind) {
  let t = 0, n = 0;
  return runner('치팅봇', {
    ms: QUICK ? 9000 : 12000,
    tick: (st) => {
      t += 1 / HZ;
      const jump = Math.floor(t / 2) !== Math.floor((t - 1 / HZ) / 2);
      if (kind === 'teleport') { if (jump) { n++; st.pos.x += 12; } }
      else if (kind === 'speed') { n = 1; st.pos.x += 60 / HZ; }
      else if (kind === 'fly') { n = 1; st.pos.y += 30 / HZ; }
      else if (kind === 'climb') { if (jump) { n++; st.pos.y += 25; } }
      else if (kind === 'sink') { n = 1; st.pos.y -= 300 / HZ; if (st.pos.y < -150) st.pos.y = 140; }
      else if (kind === 'dropjump') { if (jump) { n++; st.pos.y -= 60; } if (st.pos.y < -150) st.pos.y = 140; }
      st.extra.tries = n;
      return { p: [st.pos.x, st.pos.y, st.pos.z], v: [0, 0, 0], ry: 0, layer: st.layer, anim: 'run', g: 1 };
    }
  });
}

(async () => {
  const rows = [];
  const batches = QUICK ? [50, 400] : [50, 150, 300, 500, 800];

  console.log('  ── ① 정직한 주자 (보정 0 이어야 통과) ──');
  for (const b of batches) {
    const r = await honest(b);
    const ok = r.corrections === 0;
    rows.push(ok);
    console.log('    수평 · 몰림 ' + String(b).padStart(3) + 'ms   보고 ' +
      String(r.sent).padStart(4) + '   보정 ' + r.corrections + (ok ? '   통과' : '   ❌ 실패'));
    await sleep(600);
  }
  for (const b of batches) {
    const r = await honestFall(b);
    const ok = r.corrections === 0;
    rows.push(ok);
    console.log('    낙하 · 몰림 ' + String(b).padStart(3) + 'ms   보고 ' +
      String(r.sent).padStart(4) + '   보정 ' + r.corrections + (ok ? '   통과' : '   ❌ 실패'));
    await sleep(600);
  }

  console.log('');
  console.log('  ── ② 치팅 (보정이 걸려야 통과) ──');
  const kinds = [
    ['teleport', '수평 12m 순간이동'], ['speed', '수평 60m/s 지속'],
    ['fly', '수직 30m/s 상승'], ['climb', '수직 25m 한 번에'],
    ['sink', '수직 300m/s 하강'], ['dropjump', '수직 60m 한 번에 하강']
  ];
  for (const [k, label] of kinds) {
    const r = await cheat(k);
    const ok = r.corrections > 0;
    rows.push(ok);
    console.log('    ' + label.padEnd(20) + ' 시도 ' + String(r.extra.tries || 0).padStart(3) +
      '   보정 ' + String(r.corrections).padStart(3) + (ok ? '   차단됨' : '   ❌ 통과됨(위험)'));
    await sleep(600);
  }

  const bad = rows.filter((v) => !v).length;
  console.log('');
  console.log('  판정: ' + (bad ? ('❌ ' + bad + '개 항목 실패') : '✓ 전 항목 통과'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
