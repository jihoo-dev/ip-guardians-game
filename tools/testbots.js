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
 *   --intervene  1번 봇이 죽은 뒤 관전자 개입(발판 지원·통지서 투하)을 시도
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
const RUN_MS = (parseFloat(arg('run', '40')) || 40) * 1000;

const URL = 'http://localhost:' + PORT;
const bots = [];
const log = [];
let roundStart = 0;

/* ------------------------------------------------------------------ 봇 */

function makeBot(i) {
  /* 실제 클라이언트와 같은 transport 순서. websocket 을 먼저 두면 사내
   * 프록시가 업그레이드를 막을 때 연결 자체가 실패합니다(index.html 참고). */
  const sock = io(URL, { transports: ['polling', 'websocket'], tryAllTransports: true });

  const b = {
    i, sock, name: '봇' + (i + 1),
    role: '?', room: '?', selfId: null,
    pos: null, alive: true, dead: false, phase: null,
    placement: null, over: null, events: [], intervened: false
  };

  sock.on('connect', () => {
    sock.emit('join', { name: b.name, mode: 'player', roomId: ROOM || undefined });
  });

  sock.on('init', (d) => {
    b.role = d.role || '?';
    b.room = d.roomId || '?';
    b.selfId = d.selfId;
    /* 내 스폰 위치는 players 목록에서 찾습니다. 서버가 준 위치에서
     * 출발해야 이동 검증(VALIDATE)에 걸리지 않습니다.                */
    const me = (d.players || []).find((p) => p.id === d.selfId);
    if (me && me.pos) b.pos = { ...me.pos };
    if (!b.pos && d.map && d.map.spawns) b.pos = { ...d.map.spawns[i % d.map.spawns.length] };
  });

  sock.on('phase', (d) => {
    /* ★ 회차가 바뀌면 죽음 플래그와 기준 시각을 되돌려야 합니다.
     *   안 그러면 1회차에 죽은 봇이 2회차 내내 보고를 멈춰 STALE 로
     *   잘리고, 그 회차 결과를 읽게 됩니다(실제로 그렇게 헤맸습니다). */
    if ((d.phase === 'waiting' || d.phase === 'countdown') && b.phase === 'ended') {
      b.dead = false; b.placement = null; b.intervened = false; roundStart = 0;
    }
    if (d.phase === 'playing' && !roundStart) roundStart = Date.now();
    b.phase = d.phase;
  });
  sock.on('round_start', () => { if (!roundStart) roundStart = Date.now(); });

  sock.on('state', (snap) => {
    /* 서버가 중계하는 내 위치를 그대로 되돌려 보냅니다 — 봇은 물리가
     * 없으므로 스스로 움직이면 검증에 걸립니다.                      */
    const me = (snap.players || []).find((p) => p.id === sock.id);
    if (me && me.p) b.pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
    if (me) b.alive = !!me.al;
    b.others = (snap.players || []).filter((p) => p.id !== sock.id && p.al).map((p) => p.id);
  });

  sock.on('eliminated', (d) => { if (d.id === sock.id) b.placement = d.placement; });
  sock.on('game_over', (d) => { if (!b.over) b.over = d; });   // 첫 회차만 봅니다

  /* 개입이 실제로 먹었는지 확인할 신호들 */
  sock.on('booster_spawn', (e) => { if (e.by === b.name) b.events.push('발판 지원 성공'); });
  sock.on('obstacle_drop', (e) => { if (e.by === b.name) b.events.push('통지서 투하 성공'); });
  sock.on('action_denied', (d) => b.events.push('거절(재사용 ' + Math.ceil((d.retryInMs || 0) / 1000) + '초)'));

  return b;
}

for (let i = 0; i < N; i++) bots.push(makeBot(i));

/* 20Hz 보고. 안 하면 서버 안전망(STALE)이 5초 뒤 중력을 걸고 20초에 탈락시킵니다. */
const reporter = setInterval(() => {
  for (const b of bots) {
    if (!b.sock.connected || !b.pos || b.dead || b.role !== 'player') continue;
    b.sock.emit('player_state', {
      p: [b.pos.x, b.pos.y, b.pos.z], v: [0, 0, 0], ry: 0, anim: 'idle', g: 1
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

  /* 탈락한 주자는 곧바로 관전자 개입 권한을 얻습니다 — 그게 되는지 봅니다. */
  if (INTERVENE) {
    const b = bots[0];
    if (b.dead && !b.intervened && t >= (DIE[0] || 0) + 1.5) {
      b.intervened = true;
      const target = (b.others || [])[0];
      b.sock.emit('cheer_booster', { target });
      b.sock.emit('drop_obstacle', { target });
      log.push('  ' + b.name + ' 개입 시도 @ ' + t.toFixed(1) + '초');
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
    const b = bots[0];
    console.log('\n=== 탈락자 개입 ===');
    console.log('  ' + b.name + ': ' + (b.events.length ? [...new Set(b.events)].join(' · ') : '(아무 응답 없음)'));
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
  process.exit(0);
}

process.on('SIGINT', finish);
setTimeout(finish, RUN_MS);

console.log(URL + ' 에 봇 ' + N + '개 접속' + (ROOM ? ' (방 ' + ROOM + ')' : '') +
            ' · ' + (RUN_MS / 1000) + '초 동안 관찰');
