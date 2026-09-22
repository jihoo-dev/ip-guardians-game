#!/usr/bin/env node
/* ===========================================================================
 * 검증용 봇
 * ---------------------------------------------------------------------------
 * 브라우저 탭만으로는 만들 수 없는 상황을 만들어 봅니다.
 *
 * ★ 왜 필요한가
 *   2인 게임에서는 패자의 사망이 곧 라운드 종료입니다. 그래서
 *   '탈락 순위'도 '사람마다 다른 생존 시간'도 검증할 수 없습니다.
 *   탭을 네 개 띄워도 사람 손으로는 죽는 시점을 맞출 수 없고,
 *   비활성 탭은 브라우저가 rAF 를 멈춰 결과가 흔들립니다.
 *   봇에게 죽는 시각을 지정하면 그 두 가지를 정확히 만들 수 있습니다.
 *
 *   실제로 이 도구로 찾은 것:
 *     · 클라이언트가 보낸 층 번호를 서버가 그대로 믿어, 결과 화면에
 *       존재하지 않는 '0층'이 표시되던 문제
 *
 * ★ 함께 쓰세요
 *   봇은 화면을 그리지 않습니다. 결과 화면·연출을 보려면 브라우저 탭을
 *   하나 띄워 같은 방에 넣고(--room), 봇으로 나머지 인원을 채우세요.
 *
 * 사용법
 *   node tools/testbots.js --port 3000 --bots 3 --die 5,9,13
 *   node tools/testbots.js --port 3000 --room RM-AB12 --bots 3 --die 5,0,0
 *   node tools/testbots.js --port 3000 --bots 5 --die 4 --intervene
 *
 *   --port       서버 포트 (기본 3000)
 *   --room       이 방으로 들어갑니다. 생략하면 서버가 배정합니다.
 *   --bots N     봇 수 (기본 3)
 *   --die a,b,c  각 봇이 죽는 시각(초). 0 이나 생략은 '끝까지 생존'.
 *   --start      방장 봇이 준비·심사 개시를 눌러 시작합니다 (연습 모드는 필수)
 *   --drop       봇이 층을 한 칸 아래로 보고합니다 (보정 기회 성공 경로 확인용)
 *   --intervene  관전자 봇을 한 명 더 붙여 보정 기회(grant_amend)를 시도합니다.
 *                함께 1번 봇(탈락한 주자)도 시도해, 서버가 그쪽은 막는지 봅니다.
 *   --run S      몇 초 동안 돌릴지 (기본 40)
 *
 * ★ 서버를 짧은 라운드로 띄우면 검증이 빨라집니다
 *   ROUND_MAX_MS=14000 SOLO_ROUND_MS=8000 LOBBY_WAIT_MS=15000 npm start
 *
 * 필요 패키지: socket.io-client (devDependency)
 * ========================================================================= */
'use strict';

const path = require('path');

let io;
try { ({ io } = require('socket.io-client')); } catch (e) {
  console.error('socket.io-client 가 없습니다. `npm install` 로 devDependencies 를 받으세요.');
  console.error('(운영 배포에는 필요 없습니다 — 이 도구 전용입니다)');
  process.exit(1);
}

/* ------------------------------------------------------------------ 인자 */

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const PORT = String(arg('port', '3000'));
const ROOM = arg('room', '');
const N = Math.max(1, parseInt(arg('bots', '3'), 10) || 3);
const DIE = String(arg('die', '')).split(',').map((v) => parseFloat(v) || 0);
const INTERVENE = !!arg('intervene', false);
/* ── --drop ───────────────────────────────────────────────────────────
 * 봇이 자기 층을 <b>한 칸 아래로</b> 보고하게 합니다.
 *
 * 왜 필요한가: 봇은 물리가 없어 스폰한 최상층에서 내려가지 못합니다.
 * 그런데 보정 기회는 '한 층 위로 올려보내기' 라, 최상층이 대상이면
 * 서버가 top 으로 거절합니다(정상 동작). 그래서 --intervene 만으로는
 * <b>성공 경로를 한 번도 지나가지 못합니다</b> — 거절만 확인됩니다.
 * 층은 원래 클라이언트가 보고하는 값이라(server.js player_state),
 * 한 칸 내려 보고하는 것만으로 아래층에 선 것과 같아집니다.          */
const DROP = !!arg('drop', false);
/* ── --start ──────────────────────────────────────────────────────────
 * 방장 봇이 <b>직접 심사를 개시</b>합니다(비방장은 준비를 누릅니다).
 *
 * 이게 없으면 라운드는 서버의 멈춤 방지 타이머(LOBBY_STALL_MS)로만
 * 시작됩니다 — 즉 <b>사람이 실제로 쓰는 시작 경로를 한 번도 지나지
 * 않습니다.</b> 게다가 혼자일 때는 안전망이 아예 없어서(설계상 그렇습니다)
 * 연습 모드는 --start 없이는 검증 자체가 불가능합니다.                */
const START = !!arg('start', false);
const RUN_MS = (parseFloat(arg('run', '40')) || 40) * 1000;

const URL = 'http://localhost:' + PORT;
const bots = [];
const log = [];
let roundStart = 0;

/* ------------------------------------------------------------------ 봇 */

function makeBot(i, opt) {
  const spectate = !!(opt && opt.spectate);
  /* 실제 클라이언트와 같은 transport 순서. websocket 을 먼저 두면 사내
   * 프록시가 업그레이드를 막을 때 연결 자체가 실패합니다(index.html 참고). */
  const sock = io(URL, { transports: ['polling', 'websocket'], tryAllTransports: true });

  const b = {
    i, sock, name: (opt && opt.name) || ('봇' + (i + 1)), spectate,
    role: '?', room: '?', selfId: null,
    pos: null, alive: true, dead: false, phase: null,
    placement: null, over: null, events: [], intervened: false
  };

  sock.on('connect', () => {
    sock.emit('join', {
      name: b.name,
      mode: spectate ? 'spectator' : 'player',
      roomId: (opt && opt.roomId) || ROOM || undefined
    });
  });

  sock.on('init', (d) => {
    b.role = d.role || '?';
    b.room = d.roomId || '?';
    b.selfId = d.selfId;
    /* 내 스폰 위치는 players 목록에서 찾습니다. 서버가 준 위치에서
     * 출발해야 이동 검증(VALIDATE)에 걸리지 않습니다.                */
    const me = (d.players || []).find((p) => p.id === d.selfId);
    if (me && me.pos) b.pos = { ...me.pos };
    /* ⚠ 층도 여기서 받아 둡니다. 비워 두면 첫 state 스냅샷이 올 때까지
     *   player_state 의 layer 가 undefined 로 나가고, 서버가 그것을
     *   맨 아래층으로 <b>클램프</b>합니다 — 결과 화면의 deepest 가 1층으로
     *   찍힙니다(실측: --start 로 곧바로 시작하면 6층 봇이 1층으로 기록).
     *   멈춤 방지 타이머로 느리게 시작할 때는 스냅샷이 먼저 도착해
     *   가려져 있었습니다.                                            */
    if (me && me.layer !== undefined) b.layer = me.layer;
    if (!b.pos && d.map && d.map.spawns) b.pos = { ...d.map.spawns[i % d.map.spawns.length] };
  });

  sock.on('phase', (d) => {
    /* ★ 회차가 바뀌면 죽음 플래그와 기준 시각을 되돌려야 합니다.
     *   안 그러면 1회차에 죽은 봇이 2회차 내내 보고를 멈춰 STALE 로
     *   잘리고, 그 회차 결과를 읽게 됩니다(실제로 그렇게 헤맸습니다). */
    if ((d.phase === 'waiting' || d.phase === 'countdown') && b.phase === 'ended') {
      b.dead = false; b.placement = null; b.intervened = false; roundStart = 0;
      b.readySent = false; b.startSent = false;   // 다음 회차도 사람이 눌러 시작합니다
    }
    if (d.phase === 'playing' && !roundStart) roundStart = Date.now();

    /* ── 사람이 쓰는 시작 경로 ────────────────────────────────────────
     * 방장은 준비가 없습니다 — 심사 개시를 누르는 것 자체가 준비입니다
     * (server.js toggle_ready 가 방장을 그냥 돌려보냅니다).
     * 그래서 비방장은 준비만 누르고, 방장은 canStart 를 보고 누릅니다. */
    if (START && d.phase === 'waiting' && b.role === 'player') {
      const isHost = d.hostId === b.sock.id;
      if (!isHost && !b.readySent) { b.readySent = true; b.sock.emit('toggle_ready', { ready: true }); }
      if (isHost && d.canStart && !b.startSent) {
        b.startSent = true;
        b.sock.emit('start_round');
        log.push('  ' + b.name + '(방장) 심사 개시 @ 대기실');
      }
    }
    b.phase = d.phase;
  });
  sock.on('round_start', () => { if (!roundStart) roundStart = Date.now(); });

  /* 승격(관전 → 주자)은 map_reset 에서 일어납니다. role 은 join 시점의
   * 값이라 갱신하지 않으면 '관전자로 들어와 다음 회차에 뛰는' 경로를
   * 눈으로 확인할 수 없습니다(server.js resetRoom). 명단에 내가 있으면
   * 주자입니다.                                                      */
  sock.on('map_reset', (d) => {
    const mine = (d.players || []).find((x) => x.id === sock.id);
    const was = b.role;
    b.role = mine ? 'player' : 'spectator';
    if (mine && mine.layer !== undefined) b.layer = mine.layer;
    if (mine && mine.pos) b.pos = { ...mine.pos };
    if (was !== b.role) log.push('  ' + b.name + ' 역할 변경 ' + was + ' → ' + b.role + ' (다음 회차)');
  });

  sock.on('state', (snap) => {
    /* 서버가 중계하는 내 위치를 그대로 되돌려 보냅니다 — 봇은 물리가
     * 없으므로 스스로 움직이면 검증에 걸립니다.                      */
    const me = (snap.players || []).find((p) => p.id === sock.id);
    if (me && me.p) b.pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
    /* 서버가 말해 주는 층을 그대로 되돌려 보냅니다. 안 보내면 서버가
     * 0 으로 읽어 맨 아래 층으로 고정되고, 관전자 투하가 봇이 서 있는
     * 층이 아니라 엉뚱한 층에 떨어집니다.                          */
    if (me && me.l !== undefined) {
      /* ⚠ --drop 은 <b>스폰 층 기준</b>으로 한 칸 내려야 합니다.
       *   서버가 되돌려 주는 l 은 '봇이 방금 보고한 값' 이라, 거기서
       *   매번 1 을 빼면 스냅샷마다 한 층씩 가라앉아 20Hz 로 맨 아래까지
       *   내려갑니다(실제로 6층 봇이 1층으로 떨어졌습니다).            */
      if (b.layer0 === undefined) b.layer0 = me.l;
      b.layer = DROP ? Math.max(1, b.layer0 - 1) : me.l;
    }
    if (me) b.alive = !!me.al;
    b.others = (snap.players || []).filter((p) => p.id !== sock.id && p.al).map((p) => p.id);
  });

  sock.on('eliminated', (d) => { if (d.id === sock.id) b.placement = d.placement; });
  sock.on('game_over', (d) => { if (!b.over) b.over = d; });   // 첫 회차만 봅니다

  /* ── 개입이 실제로 먹었는지 확인할 신호 ────────────────────────────
   * ⚠ 종전에는 booster_spawn·obstacle_drop 을 들었습니다. 둘 다 서버에서
   *   사라진 기믹이라(디버프 제거), 이 도구는 개입을 <b>검증하지 못한 채</b>
   *   '아무 응답 없음' 만 찍고 있었습니다. 지금 남은 개입 수단은 보정
   *   기회 하나뿐이라 amend_granted 를 봅니다.                        */
  sock.on('amend_granted', (e) => {
    if (e.byId === sock.id) b.events.push('보정 기회 성공 → ' + e.targetName + ' (' + e.toLayer + '층 복귀)');
  });
  sock.on('action_denied', (d) => {
    if (d.action === 'grant_amend') b.events.push('거절(' + (d.reason || '?') + ')');
    if (d.action === 'start') log.push('  ' + b.name + ' 시작 거절(' + (d.reason || '?') + ')');
  });

  return b;
}

/* --names 로 봇 이름을 직접 줍니다(쉼표 구분). 홍보영상처럼 <b>화면에
   이름이 그대로 찍히는</b> 경우에 '봇1·봇2' 가 보이면 안 되기 때문입니다.
   주면 앞에서부터 쓰고, 모자라면 나머지는 기본값(봇N)입니다. */
const NAMES = (() => {
  const i = process.argv.indexOf('--names');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : [];
})();
for (let i = 0; i < N; i++) bots.push(makeBot(i, NAMES[i] ? { name: NAMES[i] } : undefined));

/* ── 관전자 봇 ────────────────────────────────────────────────────────
 * 개입(보정 기회)을 쓸 수 있는 것은 <b>이번 회차에 뛰지 않는 사람</b>뿐입니다
 * — server.js 의 grant_amend 는 room.players.has(socket.id) 면 그냥
 * 돌아갑니다. 탈락한 주자도 room.players 에 남아 있으므로 여기 걸립니다.
 * 즉 <b>탈락자만으로는 이 경로를 한 줄도 지나갈 수 없습니다.</b>
 *
 * 방 배정이 끝난 뒤에 붙입니다 — mode:'spectator' 는 roomId 가 없으면
 * '아무 방'으로 들어가므로, 봇들이 들어간 방을 알아낸 다음이라야 합니다. */
let specBot = null;
if (INTERVENE) {
  setTimeout(() => {
    const roomId = ROOM || bots.map((b) => b.room).find((r) => r && r !== '?');
    specBot = makeBot(N, { spectate: true, roomId, name: '관전봇' });
  }, 2000);
}

/* 20Hz 보고. 안 하면 서버 안전망(STALE)이 5초 뒤 중력을 걸고 20초에 탈락시킵니다. */
const reporter = setInterval(() => {
  for (const b of bots) {
    if (!b.sock.connected || !b.pos || b.dead || b.role !== 'player') continue;
    b.sock.emit('player_state', {
      p: [b.pos.x, b.pos.y, b.pos.z], v: [0, 0, 0], ry: 0,
      layer: b.layer, anim: 'idle', g: 1
    });
  }
}, 50);

const timer = setInterval(() => {
  if (!roundStart) return;
  const t = (Date.now() - roundStart) / 1000;

  bots.forEach((b, i) => {
    const at = DIE[i];
    if (at && !b.dead && b.role === 'player' && t >= at) {
      b.dead = true;
      b.sock.emit('player_death', { cause: 'fall' });
      log.push('  ' + b.name + ' 사망 @ ' + t.toFixed(1) + '초');
    }
  });

  /* ── 개입 ──────────────────────────────────────────────────────────
   * 두 쪽을 다 눌러 봅니다. 관전자는 되어야 하고, 탈락한 주자는 막혀야
   * 합니다 — 막히는 쪽도 규칙이라 함께 확인해야 회귀를 잡습니다.
   *
   * ⚠ 서버가 읽는 필드 이름은 targetId 입니다. target 으로 보내면
   *   '대상 없음' 폴백을 타 아무나 고르므로, 조준이 되는지 검증할 수
   *   없는데도 성공한 것처럼 보입니다.                              */
  if (INTERVENE) {
    const alive = bots.find((x) => x.role === 'player' && x.alive && !x.dead);
    const targetId = alive && alive.selfId;

    if (specBot && !specBot.intervened && specBot.role === 'spectator' && targetId && t >= 3) {
      specBot.intervened = true;
      specBot.sock.emit('grant_amend', { targetId });
      log.push('  관전봇 보정 기회 시도 @ ' + t.toFixed(1) + '초 (대상 ' + alive.name + ')');
    }

    const b = bots[0];
    if (b.dead && !b.intervened && t >= (DIE[0] || 0) + 1.5) {
      b.intervened = true;
      b.sock.emit('grant_amend', { targetId: (b.others || [])[0] });
      log.push('  ' + b.name + '(탈락 주자) 보정 기회 시도 @ ' + t.toFixed(1) + '초');
    }
  }
}, 100);

/* ------------------------------------------------------------------ 보고 */

function finish() {
  clearInterval(reporter); clearInterval(timer);

  if (log.length) { console.log('\n=== 진행 ==='); console.log(log.join('\n')); }

  console.log('\n=== 참가 결과 ===');
  const rooms = new Set(bots.map((b) => b.room));
  for (const b of bots) {
    console.log('  ' + b.name.padEnd(6) + ' role=' + b.role.padEnd(9) + ' room=' + b.room);
  }
  if (rooms.size > 1) {
    console.log('  ※ 방이 ' + rooms.size + '개로 갈렸습니다 — 정원(MAX_PLAYERS)을 넘기면');
    console.log('     서버가 새 방을 엽니다. 관전자로 밀리는 것이 아닙니다.');
  }

  if (INTERVENE) {
    console.log('\n=== 개입 (보정 기회) ===');
    const sEv = specBot ? [...new Set(specBot.events)] : [];
    const dEv = [...new Set(bots[0].events)];
    console.log('  관전봇          : ' + (sEv.length ? sEv.join(' · ') : '(응답 없음)') +
      (sEv.some((e) => e.indexOf('성공') >= 0) ? '   ✓ 성공해야 맞습니다' : '   ← 성공해야 합니다'));
    console.log('  ' + bots[0].name + '(탈락 주자) : ' +
      (dEv.length ? dEv.join(' · ') + '   ← 막혀야 합니다' : '(응답 없음 — 서버가 막았습니다)   ✓'));
  }

  const over = bots.map((b) => b.over).find(Boolean);
  console.log('\n=== 첫 회차 결과 ===');
  if (!over) {
    console.log('  game_over 를 받지 못했습니다 — --run 을 늘리거나 서버의');
    console.log('  LOBBY_WAIT_MS / ROUND_MAX_MS 를 줄여 보세요.');
  } else {
    console.log('  사유 ' + over.reason + ' · 승자 ' + (over.winnerName || '없음') +
                ' · 라운드 ' + (over.durationMs / 1000).toFixed(1) + '초');
    console.log('  ' + '순위'.padEnd(5) + '이름'.padEnd(12) + '생존  버틴시간   가장 깊이');
    for (const s of over.standings) {
      console.log('  ' + (String(s.placement || '—') + '위').padEnd(5) +
        s.name.padEnd(12) +
        (s.alive ? ' O   ' : ' X   ') +
        ((s.survivedMs / 1000).toFixed(1) + '초').padStart(7) + '   ' +
        s.deepest + '층');
    }
    /* 이 도구를 쓰는 이유가 바로 이 줄입니다 */
    const ms = new Set(over.standings.map((s) => Math.round(s.survivedMs / 100)));
    console.log('\n  생존 시간이 ' + (ms.size > 1 ? '사람마다 다르게' : '전원 같게') + ' 기록됐습니다' +
      (ms.size > 1 ? ' ✓' : ' — 2인 게임이면 정상입니다(패자 사망 = 라운드 종료).'));
  }

  for (const b of bots) b.sock.close();
  if (specBot) specBot.sock.close();
  process.exit(0);
}

process.on('SIGINT', finish);
setTimeout(finish, RUN_MS);

console.log(URL + ' 에 봇 ' + N + '개 접속' + (ROOM ? ' (방 ' + ROOM + ')' : '') +
            ' · ' + (RUN_MS / 1000) + '초 동안 관찰');
