/* ===========================================================================
 * IP Guardians: Fast-Track Survival  —  Authoritative Game Server
 * ---------------------------------------------------------------------------
 * Express (static) + Socket.io (rooms, tile sync, 20Hz state broadcast)
 *
 * Responsibilities
 *   1. Serve the single-file WebGL client from ./public
 *   2. Match up to MAX_PLAYERS active players per room, unlimited spectators
 *   3. Generate + own the 3-layer hex tile map (single source of truth)
 *   4. Own tile disintegration timing so every client sees the same collapse
 *   5. Relay spectator interventions (cheer_booster / drop_obstacle)
 *   6. Broadcast player snapshots at TICK_HZ for client-side dead reckoning
 * ========================================================================= */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ config */

/* 개발용 테스트 모드. true로 바꾸면 아래가 적용됩니다 (기본은 반드시 false):
 *   - 타일이 밟혀도 무너지지 않는다 (requestTileBreak 가 아무것도 하지 않음)
 *   - 바닥에서 떨어져도 탈락하지 않는다 (서버가 player_death 를 무시함)
 *   - 클라이언트 왼쪽 레이어 안내문을 클릭하면 그 레이어로 순간이동한다
 * false일 때 실제 게임 로직/밸런스는 지금과 완전히 동일합니다.               */
const DEV_MODE = false;

/** DEV_MODE 배속 헬퍼. 앞으로 층별 이벤트 타이머를 추가할 때
 *  const MY_TIMER_MS = devMs(실제값, DEV_MODE용 짧은 값); 형태로 감싸두면
 *  DEV_MODE 에서 자동으로 짧아집니다. (지금은 연결된 타이머가 없습니다 —
 *  타일 붕괴는 DEV_MODE에서 아예 일어나지 않아 시간을 당길 필요가 없어서요.) */
function devMs(normalMs, devModeMs) {
  return DEV_MODE ? devModeMs : normalMs;
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR || 'public';

const MAX_PLAYERS = 4;          // active runners per room
const TICK_HZ = 20;             // 20Hz => 50ms snapshot interval
const TICK_MS = 1000 / TICK_HZ;

const LOBBY_WAIT_MS = parseInt(process.env.LOBBY_WAIT_MS, 10) || 20000;  // 정원이 안 차면 이만큼 기다렸다 시작
const SOLO_WAIT_MS  = parseInt(process.env.SOLO_WAIT_MS, 10)  || 3000;   // 혼자일 때 대기
const COUNTDOWN_MS = 0;         // "심사 착수" countdown before the run
const ROUND_MAX_MS = 300000;    // hard cap on a round (5 minutes)
const RESET_DELAY_MS = 8000;    // podium screen duration before the next map

// Spectator intervention economy.
const BOOSTER_COOLDOWN_MS = 9000;
const OBSTACLE_COOLDOWN_MS = 12000;
const BOOSTER_TTL_MS = 7000;
const OBSTACLE_FALL_MS = 1400;

/* ----------------------------------------------------------- map constants */
/* The client rebuilds geometry from exactly these numbers, so any change here
 * automatically propagates — the client never hardcodes the layout.          */

const HEX_SIZE = 3.2;           // circumradius of one hex tile
const HEX_THICKNESS = 1.0;
const GRID_RADIUS = 7;          // 7 rings => 169 tiles per layer (~2x)
const LAVA_Y = -20;

// 5개 층. index 1 = 맨 위(스폰), index 5 = 맨 아래(바로 아래가 용암).
// name/color 는 그대로 클라이언트로 전달되며, special 은 그 층 전용 특수타일 태그입니다.
const LAYERS = [
  { index: 1, y: 60, color: '#00ffcc', name: '우선심사 패스트트랙 레이어', short: 'FAST-TRACK', special: 'fasttrack' },
  { index: 2, y: 45, color: '#0088ff', name: '의견제출통지 레이어', short: 'OFFICE ACTION', special: 'officeaction' },
  { index: 3, y: 30, color: '#ff8a00', name: '실체심사/선행기술조사 레이어', short: 'PRIOR ART SEARCH', special: 'priorart' },
  { index: 4, y: 15, color: '#ff4fd8', name: '청구항 레이어', short: 'CLAIMS', special: 'claims' },
  { index: 5, y: 0, color: '#aa00ff', name: '아이디어 레이어', short: 'IDEATION', special: 'idea' }
];
const TOP_LAYER_INDEX = LAYERS[0].index;

/* --------------------------------------------------------------- tile types
 * 모든 층 공통 비율. 합이 1이 되도록 유지하세요 — 바꾸고 싶으면 이 값만 고치면 됩니다. */
const TILE_TYPE_RATIO = {
  normal: 0.60,       // 일반: 0.7~1.0초 후 붕괴
  weak: 0.10,         // 취약 (구 함정 타일 재활용): 0.2~0.3초 후 붕괴
  reinforced: 0.10,   // 강화: 밟으면 금이 가고, 누구든 두 번째로 밟거나 3초 후 붕괴
  special: 0.20       // 특수: 지금은 일반처럼 동작. 층별 태그만 부여 (기능은 추후 추가)
};

const FUSE_NORMAL_MIN_MS = 700, FUSE_NORMAL_MAX_MS = 1000; // 일반 / (특수 중 위상 타일이 아닌 것)
const FUSE_WEAK_MIN_MS = 200, FUSE_WEAK_MAX_MS = 300;       // 취약
const REINFORCED_CRACK_TIMEOUT_MS = 3000;                   // 강화: 금 간 뒤 자동 붕괴까지
const FUSE_REINFORCED_BREAK_MS = 250;                        // 강화: 두 번째로 밟힌 뒤 붕괴까지

/* --------------------------------------------------------------- phase tiles
 * 청구항 레이어(special: 'claims')의 특수타일 = 위상 타일. 밟아도 무너지지
 * 않는다 — 대신 방 전체가 같은 리듬으로 ON(실체)/OFF(비활성)를 반복하며,
 * OFF인 동안엔 지지력이 없어 그 위의 플레이어가 아래로 떨어진다.            */
const PHASE_TILE_SPECIAL = 'claims';
const PHASE_TILE_ON_MS = 2000;   // 실체 상태 지속 시간
const PHASE_TILE_OFF_MS = 1000;  // 비활성 상태 지속 시간

/* ------------------------------------------------------------ fasttrack tile
 * 우선심사 패스트트랙 레이어(맨 위층, special: 'fasttrack')의 특수타일 = 신속심사
 * 타일. 밟으면 진행 방향(정지 중이면 마지막 이동 방향)으로 서버가 대시 이동을
 * 계산해 모든 클라이언트에 반영한다. 대시 착지 지점에 타일이 없으면 그대로
 * 아래로 떨어진다 — 이후 처리는 기존 낙하/탈락 로직을 그대로 탄다(DEV_MODE 포함).
 * 대시를 발동시킨 뒤 타일 자체는 일반 타일과 똑같이 붕괴한다.                 */
const FASTTRACK_TILE_SPECIAL = 'fasttrack';
const FASTTRACK_DASH_TILES = 2;          // 대시 거리 (칸 수)
const FASTTRACK_DASH_MIN_SPEED = 0.5;    // 이 속도 이상이어야 "지금 이동 중"으로 보고 그 방향을 쓴다

/* --------------------------------------------------------------- utilities */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function axialToWorld(q, r) {
  return {
    x: HEX_SIZE * 1.5 * q,
    z: HEX_SIZE * Math.sqrt(3) * (r + q / 2)
  };
}

function makeRoomId() {
  return 'RM-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** 시드 기반 rand() 로 TILE_TYPE_RATIO 비율에 맞는 타일 종류 하나를 뽑는다. */
function pickTileType(rand) {
  const roll = rand();
  let acc = 0;
  for (const type in TILE_TYPE_RATIO) {
    acc += TILE_TYPE_RATIO[type];
    if (roll < acc) return type;
  }
  return 'normal';
}

function clampName(raw) {
  const s = String(raw || '').trim().replace(/[\u0000-\u001f<>]/g, '');
  return (s.slice(0, 14) || '심사관' + Math.floor(Math.random() * 900 + 100));
}

const PLAYER_COLORS = ['#ffcc00', '#ff5599', '#66ff66', '#66ccff'];

/* --------------------------------------------------------- map generation */

function buildMap(seed) {
  const rand = mulberry32(seed);
  const tiles = [];
  const spawns = [];

  for (const layer of LAYERS) {
    for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q++) {
      const rMin = Math.max(-GRID_RADIUS, -q - GRID_RADIUS);
      const rMax = Math.min(GRID_RADIUS, -q + GRID_RADIUS);
      for (let r = rMin; r <= rMax; r++) {
        const { x, z } = axialToWorld(q, r);
        const dist = (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;

        // Keep the top-layer spawn ring on plain "normal" tiles so nobody dies on frame 1.
        const protectedSpawn = layer.index === TOP_LAYER_INDEX && dist >= GRID_RADIUS - 1;
        const type = protectedSpawn ? 'normal' : pickTileType(rand);
        const specialType = type === 'special' ? layer.special : null;

        tiles.push({
          id: 'L' + layer.index + '_' + q + '_' + r,
          layer: layer.index,
          q: q,
          r: r,
          x: +x.toFixed(4),
          y: layer.y,
          z: +z.toFixed(4),
          type: type,
          specialType: specialType
        });
      }
    }
  }

  // Four spawn points spread around the outer ring of the top layer.
  const spawnAxials = [
    { q: GRID_RADIUS - 1, r: 0 },
    { q: -(GRID_RADIUS - 1), r: 0 },
    { q: 0, r: GRID_RADIUS - 1 },
    { q: 0, r: -(GRID_RADIUS - 1) }
  ];
  for (const a of spawnAxials) {
    const { x, z } = axialToWorld(a.q, a.r);
    spawns.push({ x: +x.toFixed(4), y: LAYERS[0].y + HEX_THICKNESS / 2, z: +z.toFixed(4) });
  }

  return { seed, tiles, spawns };
}

/* ------------------------------------------------------------- room model */

const rooms = new Map();

function createRoom() {
  const id = makeRoomId();
  const room = {
    id,
    seed: (Math.random() * 0xffffffff) >>> 0,
    map: null,
    tileState: new Map(),   // tileId -> 'idle' | 'cracked' | 'warning' | 'broken'
    crackedBy: new Map(),   // tileId -> { by: socketId|null } — 강화 타일의 첫 번째 타격자
    players: new Map(),     // socketId -> player
    spectators: new Map(),  // socketId -> { id, name }
    phase: 'waiting',       // waiting | countdown | playing | ended
    phaseEndsAt: 0,
    roundStartedAt: 0,
    winnerId: null,
    phaseTileOn: true,      // 위상 타일 방 전체 공유 ON/OFF 상태
    timers: new Set(),
    nextEntityId: 1,
    seatColors: [...PLAYER_COLORS]
  };
  room.map = buildMap(room.seed);
  for (const t of room.map.tiles) room.tileState.set(t.id, 'idle');
  rooms.set(id, room);
  console.log('[room] created ' + id + ' seed=' + room.seed);
  return room;
}

function findOpenRoom() {
  // 1순위: 아직 시작 안 한 방의 빈 자리
  for (const room of rooms.values()) {
    if (room.players.size < MAX_PLAYERS && (room.phase === 'waiting' || room.phase === 'countdown')) {
      return room;
    }
  }
  // 2순위: 진행 중이지만 자리가 남은 방. 이번 판은 관전하고 다음 판에 자동 승격된다.
  // (새 방을 파버리면 탭 2개로 테스트할 때 서로 다른 방에 갇힙니다)
  for (const room of rooms.values()) {
    if (room.players.size < MAX_PLAYERS) return room;
  }
  return createRoom();
}

function roomTimeout(room, fn, ms) {
  const t = setTimeout(() => {
    room.timers.delete(t);
    try { fn(); } catch (err) { console.error('[timer]', err); }
  }, ms);
  room.timers.add(t);
  return t;
}

function clearRoomTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers.clear();
}

function destroyRoom(room) {
  clearRoomTimers(room);
  rooms.delete(room.id);
  console.log('[room] destroyed ' + room.id);
}

function aliveCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.alive) n++;
  return n;
}

function makePlayer(id, name, seat, room) {
  const spawn = room.map.spawns[seat % room.map.spawns.length];
  return {
    id,
    name,
    color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
    seat,
    alive: true,
    placement: 0,
    layer: TOP_LAYER_INDEX,
    anim: 'idle',
    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    ry: 0,
    wins: 0,
    lastMoveDir: null, // 신속심사 타일 대시용 — 마지막으로 유의미하게 움직인 수평 방향
    lastInput: Date.now()
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    seat: p.seat,
    alive: p.alive,
    layer: p.layer,
    placement: p.placement,
    pos: p.pos,
    ry: p.ry
  };
}

function roomSnapshotMeta(room) {
  return {
    roomId: room.id,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    alive: aliveCount(room),
    total: room.players.size,
    spectators: room.spectators.size,
    winnerId: room.winnerId
  };
}

/* --------------------------------------------------------- phase machine */

function broadcastPhase(room) {
  io.to(room.id).emit('phase', roomSnapshotMeta(room));
}

function evaluateLobby(room) {
  if (room.phase !== 'waiting') return;
  if (room.players.size === 0) return;

  if (room.players.size >= MAX_PLAYERS) {
    startCountdown(room);
    return;
  }

  if (!room.lobbyDeadline) {
    const wait = room.players.size >= 2 ? LOBBY_WAIT_MS : SOLO_WAIT_MS;
    room.lobbyDeadline = Date.now() + wait;
    room.phaseEndsAt = room.lobbyDeadline;
    broadcastPhase(room);
    roomTimeout(room, () => {
      room.lobbyDeadline = null;
      if (room.phase === 'waiting' && room.players.size > 0) startCountdown(room);
    }, wait);
  }
}

function startCountdown(room) {
  if (room.phase !== 'waiting') return;
  room.phase = 'countdown';
  room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
  broadcastPhase(room);
  console.log('[room] ' + room.id + ' countdown with ' + room.players.size + ' players');

  roomTimeout(room, () => startRound(room), COUNTDOWN_MS);
}

function startRound(room) {
  if (room.phase !== 'countdown') return;
  room.phase = 'playing';
  room.roundStartedAt = Date.now();
  room.phaseEndsAt = room.roundStartedAt + ROUND_MAX_MS;
  room.winnerId = null;

  let seatIdx = 0;
  for (const p of room.players.values()) {
    const spawn = room.map.spawns[seatIdx % room.map.spawns.length];
    p.alive = true;
    p.placement = 0;
    p.layer = TOP_LAYER_INDEX;
    p.pos = { x: spawn.x, y: spawn.y, z: spawn.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.ry = 0;
    p.anim = 'idle';
    seatIdx++;
  }

  room.phaseTileOn = true;
  schedulePhaseToggle(room);

  broadcastPhase(room);
  io.to(room.id).emit('round_start', {
    startedAt: room.roundStartedAt,
    players: [...room.players.values()].map(publicPlayer)
  });

  roomTimeout(room, () => {
    if (room.phase === 'playing') endRound(room, null, 'timeout');
  }, ROUND_MAX_MS);
}

/** 위상 타일 방 전체 동기화 사이클. 라운드가 끝나면(clearRoomTimers) 자동으로 멈춘다. */
function schedulePhaseToggle(room) {
  const waitMs = room.phaseTileOn ? PHASE_TILE_ON_MS : PHASE_TILE_OFF_MS;
  roomTimeout(room, () => {
    room.phaseTileOn = !room.phaseTileOn;
    io.to(room.id).emit('phase_tile', { on: room.phaseTileOn, at: Date.now() });
    schedulePhaseToggle(room);
  }, waitMs);
}

function checkRoundEnd(room) {
  if (room.phase !== 'playing') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  const started = room.players.size;

  // 주자가 한 명도 남지 않은 경우 (전원 새로고침/이탈).
  // 이걸 처리하지 않으면 방이 ROUND_MAX_MS(5분) 동안 playing 에 묶여
  // 그동안 접속하는 사람이 전부 관전자로 밀립니다 = "캐릭터가 안 나옴".
  if (started === 0) {
    endRound(room, null, 'abandoned');
    return;
  }

  if (started >= 2 && alive.length <= 1) {
    endRound(room, alive[0] || null, 'lastStanding');
  } else if (started === 1 && alive.length === 0) {
    endRound(room, null, 'wipe');
  }
}

function endRound(room, winner, reason) {
  if (room.phase === 'ended') return;
  room.phase = 'ended';
  room.winnerId = winner ? winner.id : null;
  room.phaseEndsAt = Date.now() + RESET_DELAY_MS;

  if (winner) {
    winner.placement = 1;
    winner.wins = (winner.wins || 0) + 1;
  }

  const standings = [...room.players.values()]
    .sort((a, b) => (a.placement || 99) - (b.placement || 99))
    .map(p => ({ id: p.id, name: p.name, color: p.color, placement: p.placement || 99 }));

  // 아무도 안 남은 방은 곧바로 다음 판 준비로 넘어갑니다
  if (reason === 'abandoned') room.phaseEndsAt = Date.now() + 1500;

  io.to(room.id).emit('game_over', {
    winnerId: room.winnerId,
    winnerName: winner ? winner.name : null,
    reason,
    standings,
    durationMs: Date.now() - room.roundStartedAt
  });
  broadcastPhase(room);
  console.log('[room] ' + room.id + ' round over (' + reason + ') winner=' + (winner ? winner.name : 'none'));

  roomTimeout(room, () => resetRoom(room), reason === 'abandoned' ? 1500 : RESET_DELAY_MS);
}

function resetRoom(room) {
  clearRoomTimers(room);

  if (room.players.size === 0 && room.spectators.size === 0) {
    destroyRoom(room);
    return;
  }

  room.seed = (Math.random() * 0xffffffff) >>> 0;
  room.map = buildMap(room.seed);
  room.tileState = new Map();
  room.crackedBy = new Map();
  for (const t of room.map.tiles) room.tileState.set(t.id, 'idle');
  room.phase = 'waiting';
  room.phaseEndsAt = 0;
  room.winnerId = null;
  room.lobbyDeadline = null;
  room.nextEntityId = 1;
  room.phaseTileOn = true;

  for (const p of room.players.values()) {
    p.alive = true;
    p.placement = 0;
    p.layer = TOP_LAYER_INDEX;
    // A runner who was eliminated last round got temporary spectator powers.
    // Revoke them now that they are back on the grid.
    room.spectators.delete(p.id);
  }

  // 라운드 중 난입해 관전자로 밀렸던 사람을 빈 자리에 승격시킨다.
  for (const [sid, spec] of [...room.spectators]) {
    if (room.players.size >= MAX_PLAYERS) break;
    if (!spec.wantsPlay) continue;                 // 순수 관전자는 건드리지 않음
    if (!io.sockets.sockets.get(sid)) { room.spectators.delete(sid); continue; }
    room.players.set(sid, makePlayer(sid, spec.name, room.players.size, room));
    room.spectators.delete(sid);
    io.to(room.id).emit('toast', { kind: 'cheer', text: spec.name + ' 님이 이번 회차 주자로 참가합니다' });
  }

  // 좌석 번호와 색을 다시 정렬
  let si = 0;
  for (const p of room.players.values()) {
    p.seat = si;
    p.color = PLAYER_COLORS[si % PLAYER_COLORS.length];
    const sp = room.map.spawns[si % room.map.spawns.length];
    p.pos = { x: sp.x, y: sp.y, z: sp.z };
    p.vel = { x: 0, y: 0, z: 0 };
    si++;
  }

  io.to(room.id).emit('map_reset', {
    seed: room.seed,
    map: room.map,
    players: [...room.players.values()].map(publicPlayer),
    meta: roomSnapshotMeta(room),
    phaseTileOn: room.phaseTileOn
  });

  evaluateLobby(room);
}

/* ---------------------------------------------------------- tile handling */

const HEX_HALF_X = HEX_SIZE;
const HEX_HALF_Z = HEX_SIZE * Math.sqrt(3) / 2;

/** 어떤 층의 (x, z) 위치를 실제로 차지하는 타일을 찾는다 (클라이언트 pointInXZ와 동일 로직). */
function findTileAt(room, layer, x, z) {
  let owner = null, ownerD = Infinity;
  for (const t of room.map.tiles) {
    if (t.layer !== layer) continue;
    if (x < t.x - HEX_HALF_X || x > t.x + HEX_HALF_X) continue;
    if (z < t.z - HEX_HALF_Z || z > t.z + HEX_HALF_Z) continue;
    const d = (x - t.x) * (x - t.x) + (z - t.z) * (z - t.z);
    if (d < ownerD) { ownerD = d; owner = t; }
  }
  return owner;
}

/** 신속심사 타일: 진행 방향(없으면 마지막 이동 방향)으로 대시. 방향 기록이 없으면 발동하지 않는다. */
function triggerFasttrackDash(room, tile, player) {
  const speed = Math.hypot(player.vel.x, player.vel.z);
  const dir = speed > FASTTRACK_DASH_MIN_SPEED
    ? { x: player.vel.x / speed, z: player.vel.z / speed }
    : player.lastMoveDir;
  if (!dir) return;

  const dashDist = FASTTRACK_DASH_TILES * HEX_SIZE * Math.sqrt(3);
  const destX = +(player.pos.x + dir.x * dashDist).toFixed(4);
  const destZ = +(player.pos.z + dir.z * dashDist).toFixed(4);
  const landingTile = findTileAt(room, tile.layer, destX, destZ);
  const solid = !!landingTile && room.tileState.get(landingTile.id) !== 'broken';

  player.pos.x = destX;
  player.pos.z = destZ;
  player.vel.x = 0;
  player.vel.z = 0;

  io.to(room.id).emit('fasttrack_dash', {
    playerId: player.id,
    x: destX, y: player.pos.y, z: destZ,
    dirX: dir.x, dirZ: dir.z,
    fellThrough: !solid,
    at: Date.now()
  });
}

/** 타일 종류별 붕괴까지 걸리는 시간(ms)을 하나 뽑는다. */
function pickFuseMs(type) {
  if (type === 'weak') return randRange(FUSE_WEAK_MIN_MS, FUSE_WEAK_MAX_MS);
  return randRange(FUSE_NORMAL_MIN_MS, FUSE_NORMAL_MAX_MS); // normal, special
}

function beginWarn(room, tile, fuse, sourceId) {
  room.tileState.set(tile.id, 'warning');
  io.to(room.id).emit('tile_warn', {
    tileId: tile.id,
    fuse,
    type: tile.type,
    by: sourceId || null,
    at: Date.now()
  });

  roomTimeout(room, () => {
    if (room.tileState.get(tile.id) !== 'warning') return;
    room.tileState.set(tile.id, 'broken');
    io.to(room.id).emit('tile_break', { tileId: tile.id, at: Date.now() });
  }, fuse);
}

/** 강화 타일 첫 타격: 금이 가고, 3초 안에 두 번째 타격이 없으면 스스로 붕괴한다. */
function crackTile(room, tile, sourceId) {
  room.tileState.set(tile.id, 'cracked');
  room.crackedBy.set(tile.id, { by: sourceId || null });

  io.to(room.id).emit('tile_crack', {
    tileId: tile.id,
    by: sourceId || null,
    at: Date.now()
  });

  roomTimeout(room, () => {
    if (room.tileState.get(tile.id) !== 'cracked') return;
    beginWarn(room, tile, FUSE_REINFORCED_BREAK_MS, null);
  }, REINFORCED_CRACK_TIMEOUT_MS);
}

function requestTileBreak(room, tileId, sourceId) {
  if (DEV_MODE) return; // 개발용 테스트 모드: 타일이 무너지지 않는다
  const tile = room.map.tiles.find(t => t.id === tileId);
  if (!tile) return;
  if (tile.specialType === PHASE_TILE_SPECIAL) return; // 위상 타일: 밟아도 무너지지 않는다 (ON/OFF 주기만 반복)
  if (room.phase !== 'playing') return;
  const state = room.tileState.get(tileId);

  if (tile.type === 'reinforced') {
    if (state === 'idle') { crackTile(room, tile, sourceId); return; }
    if (state === 'cracked') {
      const crack = room.crackedBy.get(tileId);
      if (crack && crack.by === sourceId) return; // 자기 자신이 계속 밟는 건 두 번째 타격으로 치지 않음
      beginWarn(room, tile, FUSE_REINFORCED_BREAK_MS, sourceId);
    }
    return;
  }

  if (state !== 'idle') return;
  beginWarn(room, tile, pickFuseMs(tile.type), sourceId);
}

function brokenTileIds(room) {
  const out = [];
  for (const [id, st] of room.tileState) if (st !== 'idle') out.push({ id, st });
  return out;
}

/* -------------------------------------------------- express + socket wiring */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

app.disable('x-powered-by');
/* HTML 은 절대 캐시하지 않습니다. 개발 중 index.html 을 고쳤는데 브라우저가
 * 옛 파일을 계속 띄우는 사고를 막습니다. 이미지/텍스처만 캐시합니다.        */
app.use(express.static(path.join(__dirname, STATIC_DIR), {
  etag: true,
  lastModified: true,
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

app.get('/api/rooms', (_req, res) => {
  res.json([...rooms.values()].map(r => ({
    id: r.id,
    phase: r.phase,
    players: r.players.size,
    spectators: r.spectators.size
  })));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, STATIC_DIR, 'index.html'));
});

/* --------------------------------------------------------- socket handlers */

io.on('connection', (socket) => {
  let room = null;
  let role = null; // 'player' | 'spectator'

  socket.emit('server_hello', {
    now: Date.now(),
    config: {
      DEV_MODE,
      MAX_PLAYERS, TICK_HZ, HEX_SIZE, HEX_THICKNESS, GRID_RADIUS,
      LAVA_Y, LAYERS, TILE_TYPE_RATIO,
      FUSE_NORMAL_MIN_MS, FUSE_NORMAL_MAX_MS, FUSE_WEAK_MIN_MS, FUSE_WEAK_MAX_MS,
      REINFORCED_CRACK_TIMEOUT_MS, FUSE_REINFORCED_BREAK_MS,
      PHASE_TILE_SPECIAL, PHASE_TILE_ON_MS, PHASE_TILE_OFF_MS,
      FASTTRACK_TILE_SPECIAL, FASTTRACK_DASH_TILES,
      BOOSTER_TTL_MS, OBSTACLE_FALL_MS,
      BOOSTER_COOLDOWN_MS, OBSTACLE_COOLDOWN_MS
    }
  });

  socket.on('ping_probe', (clientSent) => {
    socket.emit('pong_probe', { clientSent, serverTime: Date.now() });
  });

  socket.on('join', (payload = {}) => {
    if (room) return;

    const name = clampName(payload.name);
    const wantSpectate = payload.mode === 'spectator';

    if (payload.roomId && rooms.has(String(payload.roomId).toUpperCase())) {
      room = rooms.get(String(payload.roomId).toUpperCase());
    } else {
      room = wantSpectate ? ([...rooms.values()][0] || createRoom()) : findOpenRoom();
    }

    const seatFull = room.players.size >= MAX_PLAYERS;
    const midRound = room.phase === 'playing' || room.phase === 'ended';
    role = (wantSpectate || seatFull || midRound) ? 'spectator' : 'player';

    socket.join(room.id);

    if (role === 'player') {
      const player = makePlayer(socket.id, name, room.players.size, room);
      room.players.set(socket.id, player);
      socket.to(room.id).emit('player_joined', publicPlayer(player));
    } else {
      // wantsPlay: 주자로 들어오려 했지만 라운드 중이라 밀린 경우.
      // 다음 맵 리셋에서 자동으로 주자로 승격됩니다.
      room.spectators.set(socket.id, { id: socket.id, name, wantsPlay: !wantSpectate });
      socket.to(room.id).emit('spectator_joined', { id: socket.id, name, wantsPlay: !wantSpectate });
    }

    socket.emit('init', {
      selfId: socket.id,
      role,
      name,
      roomId: room.id,
      seed: room.seed,
      map: room.map,
      brokenTiles: brokenTileIds(room),
      players: [...room.players.values()].map(publicPlayer),
      meta: roomSnapshotMeta(room),
      serverTime: Date.now(),
      phaseTileOn: room.phaseTileOn
    });

    broadcastPhase(room);
    if (role === 'player') evaluateLobby(room);
    console.log('[join] ' + name + ' as ' + role + ' -> ' + room.id +
      ' (' + room.players.size + 'p/' + room.spectators.size + 's)');
  });

  /* ---- player state ingest (client-authoritative movement, server relays) */
  socket.on('player_state', (s) => {
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (!s || !Array.isArray(s.p) || s.p.length !== 3) return;

    p.pos.x = +s.p[0] || 0;
    p.pos.y = +s.p[1] || 0;
    p.pos.z = +s.p[2] || 0;
    if (Array.isArray(s.v) && s.v.length === 3) {
      p.vel.x = +s.v[0] || 0;
      p.vel.y = +s.v[1] || 0;
      p.vel.z = +s.v[2] || 0;
    }
    const hSpeed = Math.hypot(p.vel.x, p.vel.z);
    if (hSpeed > FASTTRACK_DASH_MIN_SPEED) {
      p.lastMoveDir = { x: p.vel.x / hSpeed, z: p.vel.z / hSpeed };
    }
    p.ry = +s.ry || 0;
    p.layer = s.layer | 0;
    p.anim = typeof s.anim === 'string' ? s.anim.slice(0, 12) : 'idle';
    p.lastInput = Date.now();
  });

  socket.on('tile_step', (data = {}) => {
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof data.tileId !== 'string') return;

    if (room.phase === 'playing') {
      const tile = room.map.tiles.find(t => t.id === data.tileId);
      // DEV_MODE에서도 대시는 확인할 수 있어야 하므로 requestTileBreak와 별도로 처리한다.
      if (tile && tile.specialType === FASTTRACK_TILE_SPECIAL &&
          room.tileState.get(tile.id) !== 'broken') {
        triggerFasttrackDash(room, tile, p);
      }
    }

    requestTileBreak(room, data.tileId, socket.id);
  });

  socket.on('player_death', (data = {}) => {
    if (DEV_MODE) return; // 개발용 테스트 모드: 떨어져도 탈락하지 않는다
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (room.phase !== 'playing') return;

    p.alive = false;
    p.anim = 'dead';
    p.placement = aliveCount(room) + 1;

    io.to(room.id).emit('eliminated', {
      id: p.id,
      name: p.name,
      color: p.color,
      placement: p.placement,
      cause: typeof data.cause === 'string' ? data.cause.slice(0, 24) : 'lava',
      alive: aliveCount(room)
    });

    // Eliminated runners immediately gain spectator intervention powers.
    room.spectators.set(socket.id, { id: socket.id, name: p.name });
    checkRoundEnd(room);
  });

  /* ------------------------------------------- spectator intervention API */

  socket.on('cheer_booster', (data = {}) => {
    if (!room) return;
    const isSpectator = room.spectators.has(socket.id);
    if (!isSpectator) return;
    if (room.phase !== 'playing') return;

    const now = Date.now();
    const spec = room.spectators.get(socket.id);
    if (spec.boosterAt && now - spec.boosterAt < BOOSTER_COOLDOWN_MS) {
      socket.emit('action_denied', {
        action: 'cheer_booster',
        retryInMs: BOOSTER_COOLDOWN_MS - (now - spec.boosterAt)
      });
      return;
    }

    let target = room.players.get(String(data.targetId));
    if (!target || !target.alive) {
      target = [...room.players.values()].find(p => p.alive);
    }
    if (!target) return;

    spec.boosterAt = now;
    const entity = {
      id: 'BST' + (room.nextEntityId++),
      targetId: target.id,
      x: target.pos.x,
      y: target.pos.y - 1.6,
      z: target.pos.z,
      ttl: BOOSTER_TTL_MS,
      by: spec.name,
      at: now
    };
    io.to(room.id).emit('booster_spawn', entity);
    io.to(room.id).emit('toast', {
      kind: 'cheer',
      text: spec.name + ' 님이 ' + target.name + ' 에게 우선심사 발판을 지원했습니다'
    });

    roomTimeout(room, () => {
      io.to(room.id).emit('booster_expire', { id: entity.id });
    }, BOOSTER_TTL_MS);
  });

  socket.on('drop_obstacle', (data = {}) => {
    if (!room) return;
    const isSpectator = room.spectators.has(socket.id);
    if (!isSpectator) return;
    if (room.phase !== 'playing') return;

    const now = Date.now();
    const spec = room.spectators.get(socket.id);
    if (spec.obstacleAt && now - spec.obstacleAt < OBSTACLE_COOLDOWN_MS) {
      socket.emit('action_denied', {
        action: 'drop_obstacle',
        retryInMs: OBSTACLE_COOLDOWN_MS - (now - spec.obstacleAt)
      });
      return;
    }

    // Prefer a live tile on the layer that currently holds the most runners.
    const alive = [...room.players.values()].filter(p => p.alive);
    if (alive.length === 0) return;

    let targetLayer = alive[0].layer || 3;
    if (data.targetId) {
      const t = room.players.get(String(data.targetId));
      if (t && t.alive) targetLayer = t.layer || targetLayer;
    }

    const candidates = room.map.tiles.filter(t =>
      t.layer === targetLayer && room.tileState.get(t.id) === 'idle');
    const pool = candidates.length ? candidates
      : room.map.tiles.filter(t => room.tileState.get(t.id) === 'idle');
    if (!pool.length) return;

    const tile = pool[Math.floor(Math.random() * pool.length)];
    spec.obstacleAt = now;

    const entity = {
      id: 'OBS' + (room.nextEntityId++),
      tileId: tile.id,
      x: tile.x,
      y: tile.y,
      z: tile.z,
      fromY: tile.y + 46,
      durationMs: OBSTACLE_FALL_MS,
      by: spec.name,
      at: now
    };
    io.to(room.id).emit('obstacle_drop', entity);
    io.to(room.id).emit('toast', {
      kind: 'obstacle',
      text: spec.name + ' 님이 의견제출통지서를 투하했습니다'
    });

    roomTimeout(room, () => {
      io.to(room.id).emit('obstacle_impact', { id: entity.id, tileId: tile.id });
      requestTileBreak(room, tile.id, null);
    }, OBSTACLE_FALL_MS);
  });

  socket.on('chat', (msg) => {
    if (!room) return;
    const text = String(msg || '').slice(0, 120).replace(/[\u0000-\u001f<>]/g, '');
    if (!text) return;
    const who = room.players.get(socket.id) || room.spectators.get(socket.id);
    io.to(room.id).emit('chat', { name: who ? who.name : '익명', text, at: Date.now() });
  });

  /* --------------------------------------------------------- disconnect */
  socket.on('disconnect', () => {
    if (!room) return;

    const wasPlayer = room.players.has(socket.id);
    const p = room.players.get(socket.id);

    room.players.delete(socket.id);
    room.spectators.delete(socket.id);

    if (wasPlayer) {
      socket.to(room.id).emit('player_left', { id: socket.id, name: p ? p.name : '' });
      checkRoundEnd(room);
    } else {
      socket.to(room.id).emit('spectator_left', { id: socket.id });
    }

    broadcastPhase(room);

    if (room.players.size === 0 && room.spectators.size === 0) {
      destroyRoom(room);
    }
    console.log('[left] ' + socket.id + ' from ' + room.id);
  });
});

/* --------------------------------------------------- 20Hz snapshot broadcast */

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 끊어진 소켓이 방에 남아 있으면 정리하고 라운드 종료 조건을 다시 봅니다
    let pruned = false;
    for (const id of [...room.players.keys()]) {
      if (!io.sockets.sockets.get(id)) { room.players.delete(id); pruned = true; }
    }
    for (const id of [...room.spectators.keys()]) {
      if (!io.sockets.sockets.get(id)) room.spectators.delete(id);
    }
    if (pruned) { broadcastPhase(room); checkRoundEnd(room); }

    if (room.players.size === 0 && room.spectators.size === 0) continue;

    const players = [];
    for (const p of room.players.values()) {
      players.push({
        id: p.id,
        p: [+p.pos.x.toFixed(3), +p.pos.y.toFixed(3), +p.pos.z.toFixed(3)],
        v: [+p.vel.x.toFixed(3), +p.vel.y.toFixed(3), +p.vel.z.toFixed(3)],
        ry: +p.ry.toFixed(3),
        l: p.layer,
        a: p.anim,
        al: p.alive ? 1 : 0
      });
    }

    io.to(room.id).emit('state', { t: now, players });
  }
}, TICK_MS);

/* ------------------------------------------------------------- lifecycle */

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(' IP Guardians: Fast-Track Survival');
  console.log(' listening on http://' + HOST + ':' + PORT);
  console.log(' static dir: ' + path.join(__dirname, STATIC_DIR));
  console.log(' tick: ' + TICK_HZ + 'Hz   seats/room: ' + MAX_PLAYERS);
  console.log('==============================================');
});

function shutdown(signal) {
  console.log('[' + signal + '] shutting down...');
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
