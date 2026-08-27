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

/* ═══════════════════════════════════════════════════════════════════════
 * 개발용 테스트 모드
 * ───────────────────────────────────────────────────────────────────────
 * 켜는 법:  바로 아래 DEV_MODE_ON 을 true 로 바꾸고 서버를 재시작하세요.
 *           환경변수로도 됩니다 →  DEV_MODE=1 npm start
 * 끄는 법:  DEV_MODE_ON 을 false 로 되돌리고 재시작. (기본값 false)
 *
 * 브라우저는 새로고침만 하면 됩니다 — 이 값은 접속 시 서버가 클라이언트로
 * 내려주므로, 클라이언트 코드를 따로 고칠 필요가 없습니다.
 *
 * true 일 때 달라지는 것:
 *   1. 타일이 밟혀도 무너지지 않는다            (requestTileBreak 무효화)
 *   2. 떨어져도 탈락하지 않는다                 (player_death 무시)
 *   3. 왼쪽 레이어 안내문에 어두운 배경이 깔린다 (클라이언트 CSS)
 *   4. 그 안내문을 클릭하면 해당 층으로 순간이동 (클라이언트)
 *
 * 타일 크기는 모드와 무관하게 항상 같습니다 — 모드에 따라 크기가 달라지면
 * 겹침/빈틈 특성이 두 벌이 되어 검증이 무의미해지기 때문입니다.
 *
 * false 일 때는 게임 로직과 밸런스가 종전과 완전히 동일합니다.
 * ═══════════════════════════════════════════════════════════════════════ */
/* ▼▼▼ 여기만 바꾸면 됩니다 ▼▼▼
 *   false = 평소 게임      true = 개발용 테스트 모드                    */
const DEV_MODE_ON = true;
/* ▲▲▲ 여기만 바꾸면 됩니다 ▲▲▲ */

/* 파일을 고치지 않고 잠깐만 바꾸고 싶을 때는 환경변수를 씁니다.
 *   DEV_MODE=1 npm start   → 강제로 켬
 *   DEV_MODE=0 npm start   → 강제로 끔 (위 DEV_MODE_ON 이 true 여도)
 * 환경변수가 없으면 DEV_MODE_ON 값을 따릅니다.                         */
const DEV_MODE =
  (process.env.DEV_MODE === '0' || process.env.DEV_MODE === 'false') ? false
    : (DEV_MODE_ON || process.env.DEV_MODE === '1' || process.env.DEV_MODE === 'true');

/* ------------------------------------------------------------------ config */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR || 'public';

/* ── 인원 설정 ────────────────────────────────────────────────────────
 * 이 값 하나만 바꾸면 좌석 수, 플레이어 색상, 대기 발판 개수,
 * 맵 크기까지 전부 따라옵니다. 환경변수로도 바꿀 수 있습니다.
 *   MAX_PLAYERS=16 node server.js
 * ------------------------------------------------------------------ */
const MAX_PLAYERS = Math.max(1, parseInt(process.env.MAX_PLAYERS, 10) || 4);
const TICK_HZ = 20;             // 20Hz => 50ms snapshot interval
const TICK_MS = 1000 / TICK_HZ;

const LOBBY_WAIT_MS = parseInt(process.env.LOBBY_WAIT_MS, 10) || 20000;  // 정원이 안 차면 이만큼 기다렸다 시작
const SOLO_WAIT_MS  = parseInt(process.env.SOLO_WAIT_MS, 10)  || 15000;  // 혼자일 때 대기 (탭 2개 열 시간 확보)
const COUNTDOWN_MS = 5000;      // "심사 착수" countdown before the run
const ROUND_MAX_MS = 300000;    // hard cap on a round (5 minutes)
const RESET_DELAY_MS = 8000;    // podium screen duration before the next map

// Tile collapse timings (seconds are converted to ms).
const FUSE_NORMAL_MS = 800;     // 0.8s  standard patent tile
const FUSE_TRAP_MS = 200;       // 0.2s  무단 카피캣 함정 블록

/* 일반 타일 내구도 — 이 횟수만큼 밟아야 무너집니다.
 *   1회차: 색이 옅어짐   2회차: 균열   3회차: 경고 점멸 후 붕괴
 * 함정 타일(trap)은 이 값과 무관하게 항상 1회에 즉시 붕괴합니다.       */
const TILE_HITS = parseInt(process.env.TILE_HITS, 10) || 3;

/* ── 이동 검증 (VALIDATE) ─────────────────────────────────────────────
 * 이동은 여전히 클라이언트 권위입니다. 서버가 물리를 돌리지는 않습니다.
 * 다만 보고된 위치가 '물리적으로 가능한 범위'인지는 봅니다.
 *
 * 왜 지금 필요한가: 주자간 밀림(클라이언트 BUMP)이 들어가면서 밀려서
 * 떨어지는 것이 정식 탈락 사유가 되었습니다. 검증이 없으면 "나는 안
 * 밀렸다"고 좌표를 고쳐 보내는 클라이언트를 막을 근거가 없습니다.
 *
 * 위반해도 강제 퇴장시키지 않습니다 — 렉으로 인한 오탐이 퇴장으로
 * 이어지면 안 됩니다. WARN_AT 회 '연속' 위반해야 마지막 정상 위치로
 * 되돌립니다(state_correction). 통과한 보고가 하나라도 오면 초기화됩니다.
 *
 * 속도 한계는 클라이언트 PHYS 와 짝입니다 — public/index.html 의 PHYS 를
 * 바꾸면 여기도 같이 바꿔야 합니다.
 *
 * 끄는 법:  VALIDATE=0 npm start
 * ------------------------------------------------------------------ */
const VALIDATE = {
  ON: process.env.VALIDATE !== '0' && process.env.VALIDATE !== 'false',

  /* 수평 이동은 '토큰 버킷'으로 봅니다.
   *
   * 처음에는 패킷당 거리 ÷ 도착 시각 차이로 속도를 냈는데, dt 를 서버 도착
   * 시각으로 재면서 이동량은 클라이언트 물리 시간 기준이라 지터가 끼면 둘이
   * 어긋납니다. 정직한 봇이 30초에 62번 보정당했습니다. dt 하한을 올려
   * 막으려 했더니 이번엔 실효 속도 상한이 36 m/s 로 올라가 버렸습니다.
   *
   * 버킷은 둘 다 해결합니다 — 시간에 비례해 예산이 차고(지터가 평균으로
   * 상쇄됨), BURST 를 넘겨 쌓이지 않으므로 지속 속도는 정확히
   * MAX_H_SPEED 로 묶입니다.                                          */
  MAX_H_SPEED: 21.5 * 1.4,   // PHYS.SPRINT(21.5) + 40% 여유 (장애물 넉백이
                             // 한 프레임 SPRINT 를 넘길 수 있습니다)
  BURST: 6.0,                // 한 보고에 허용하는 최대 이동거리(m).
                             // 패킷이 한두 개 유실돼 250ms 만에 몰아 와도
                             // 스프린트 이동분(5.4 m)이 들어갑니다.

  /* 수직은 버킷을 쓰지 않습니다. 중력이 이미 자연스러운 상한이고,
   * 낙하는 정상적으로 아주 빠릅니다. 순간 판정 + 여유값으로 충분합니다. */
  MAX_UP_SPEED: 34,          // PHYS.JUMP_V(21.5) + 장애물 팝(9) + 여유
  MAX_DOWN_SPEED: 120,       // PHYS.MAX_FALL(90) + 여유
  V_MIN_DT: 0.02,
  V_SLACK: 1.0,              // 착지 스냅(findLanding)이 한 프레임에 내는 도약분

  /* MAX_DT 가 없으면 오래 끊겼다 돌아온 클라이언트의 버킷이 가득 차
   * 순간이동 한 번이 통과합니다. BURST 와 함께 이중으로 막습니다.     */
  MAX_DT: 0.5,
  BOUND_XZ: 220,             // 클라이언트 장외 판정(170) 보다 넉넉하게
  MIN_Y: -140, MAX_Y: 140,
  WARN_AT: 4,                // 연속 위반 이 횟수에서 보정 (20Hz 기준 약 200ms)
  LOG: true
};

/* ── 보고가 끊긴 플레이어 (STALE) ─────────────────────────────────────
 * 브라우저는 비활성 탭의 requestAnimationFrame 을 멈춥니다. 그러면 물리도
 * player_state 도 안 나가고, 서버는 마지막 위치를 계속 중계하므로 그 사람은
 * 다른 화면에서 '공중에 낙하 자세로 굳은 조각상'이 됩니다. 죽지도 않으니
 * checkRoundEnd 가 성립하지 않아 라운드가 ROUND_MAX_MS(5분)까지 갑니다.
 *
 * 클라이언트도 워커 타이머로 백그라운드 전송을 유지하지만(index.html 의
 * startBackgroundTicker), 그쪽만 믿으면 브라우저 정책이 바뀌거나 절전 모드로
 * 들어갔을 때 다시 당합니다. 여기가 안전망입니다.
 *
 * DROP_MS 를 넉넉히 잡은 이유: 파트 A 가 정상 동작하면 백그라운드 탭도
 * 33ms 마다 보고하므로 절대 여기 걸리지 않습니다. 너무 짧게 잡으면 순간적인
 * 렉으로 멀쩡한 플레이어가 떨어집니다.                                */
const STALE = {
  ANIM_MS: 700,     // 이만큼 보고가 없으면 anim 을 idle 로 (낙하 자세 고정 방지)

  /* 이만큼 없으면 서버가 대신 중력을 적용합니다.
   *
   * 실측으로 2500 에서 5000 으로 올렸습니다. 탈락까지 걸리는 시간은
   * DROP_MS + 낙하 시간이고, 최상층(y=24.35)에서 구름바다(SEA_Y+2=-14)까지
   * 38.35 m 를 g=62 로 떨어지는 데 약 1.1~1.4초가 걸립니다.
   *   DROP_MS 2500 → 약 3.9초 침묵이면 사망   (5초 멈췄다 돌아오면 죽어 있음)
   *   DROP_MS 5000 → 약 6.2초 침묵이면 사망   (5초 복귀는 무사)
   * 파트 A(워커 타이머)가 살아 있으면 백그라운드 탭도 20Hz 로 계속 보고하므로
   * 여기 걸릴 일이 없습니다. 절전 모드·페이지 동결처럼 정말로 플레이가
   * 불가능한 경우의 안전망이라, 짧게 잡아 얻는 것보다 잃는 게 큽니다.   */
  DROP_MS: 5000,

  KICK_MS: 20000    // 이만큼 없으면 탈락 처리 (라운드가 안 끝나는 것 방지)
};

// Spectator intervention economy.
const BOOSTER_COOLDOWN_MS = 9000;
const OBSTACLE_COOLDOWN_MS = 12000;
const BOOSTER_TTL_MS = 7000;
const OBSTACLE_FALL_MS = 1400;

/* ----------------------------------------------------------- map constants */
/* The client rebuilds geometry from exactly these numbers, so any change here
 * automatically propagates — the client never hardcodes the layout.          */

/* 타일 하나의 외접원 반지름(S).
 *
 * flat-top 육각형 규약이라 이 값 하나가 전부를 결정합니다.
 *   가로 = 2S,  세로 = √3·S
 *   이웃 X 간격 = 1.5S,  이웃 중심거리 = √3·S (= 내접원 지름)
 * 이웃 중심거리가 내접원 지름과 같으므로 변끼리 정확히 맞물립니다.
 *
 * DEV_MODE 에서도 같은 값을 씁니다 — 크기가 모드에 따라 달라지면
 * 겹침/빈틈 특성이 두 벌이 되어 검증이 무의미해집니다.               */
const HEX_SIZE = 3.2 / 1.5;     // 2.1333 (종전 3.2 에서 1.5배 축소)
const HEX_THICKNESS = 0.7;      // 타일이 얇아진 비율에 맞춤 (종전 1.0)

/* 맵 반경은 인원에 맞춰 늘어납니다.
 * 반경 R 의 육각 그리드 타일 수 = 3R² + 3R + 1
 * 타일이 작아진 만큼 1인당 배분을 22 → 38 로 올려 층당 개수를 약 2배로 만듭니다.
 * (4인 기준: 반경 5/91타일 → 반경 7/169타일)                          */
const TILES_PER_PLAYER = parseInt(process.env.TILES_PER_PLAYER, 10) || 38;
const GRID_RADIUS = parseInt(process.env.GRID_RADIUS, 10) ||
  Math.max(7, Math.round(Math.sqrt(TILES_PER_PLAYER * MAX_PLAYERS / 3)));
const TRAP_CHANCE = 0.11;

/* ── 대기 발판 ────────────────────────────────────────────────────────
 * 게임 시작 전 각 플레이어가 자기 발판 위에서 대기합니다.
 * 정원이 차면 발판이 사라지고, 플레이어들이 최상층으로 떨어지며 시작됩니다. */
const PEDESTAL_RISE  = 9.0;   // 최상층 위로 띄우는 높이
/* 타일이 1.5배 작아졌으므로 발판은 상대 배율을 올려 서 있기 편한 크기를 유지합니다.
 * 1.45 × 3.2 = 4.64  →  2.1 × 2.133 = 4.48 (절대 크기가 거의 그대로)      */
const PEDESTAL_SCALE = 2.1;
const SEA_Y = -16;              // 구름바다 높이. 층 간격이 줄어든 만큼 함께 축소
const THEME_COUNT = 3;          // 배경 맵 개수 (public/assets/bg)

/* 층 높이도 타일 축소에 맞춰 줄입니다 (30/15/0 → 24/12/0).
 * 낙하 시간이 과도하게 길어지지 않도록 간격을 좁혔습니다.               */
const LAYERS = [
  { index: 3, y: 24, color: '#00ffcc', name: '우선심사 패스트트랙 레이어', short: 'FAST-TRACK' },
  { index: 2, y: 12, color: '#0088ff', name: '의견제출통지 레이어', short: 'OFFICE ACTION' },
  { index: 1, y: 0, color: '#aa00ff', name: '아이디어 구상 레이어', short: 'IDEATION' }
];

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

function clampName(raw) {
  const s = String(raw || '').trim().replace(/[\u0000-\u001f<>]/g, '');
  return (s.slice(0, 14) || '심사관' + Math.floor(Math.random() * 900 + 100));
}

/* 인원수에 맞춰 색을 만듭니다.
 * 앞 4개는 기존 색을 그대로 쓰고, 그 이상은 색상환을 균등 분할해
 * 서로 최대한 구분되는 색을 생성합니다.                                */
const BASE_COLORS = ['#ffcc00', '#ff5599', '#66ff66', '#66ccff'];

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function buildPlayerColors(n) {
  const out = BASE_COLORS.slice(0, Math.min(n, BASE_COLORS.length));
  for (let i = out.length; i < n; i++) {
    // 황금각으로 색상환을 돌면 인접 좌석끼리 색이 겹치지 않습니다
    const hue = (i * 137.508) % 360;
    const light = 0.58 + ((i % 3) - 1) * 0.09;
    out.push(hslToHex(hue, 0.82, light));
  }
  return out;
}

const PLAYER_COLORS = buildPlayerColors(MAX_PLAYERS);

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

        // Keep the top-layer spawn ring free of traps so nobody dies on frame 1.
        const protectedSpawn = layer.index === 3 && dist >= GRID_RADIUS - 1;
        const trap = !protectedSpawn && rand() < TRAP_CHANCE;

        tiles.push({
          id: 'L' + layer.index + '_' + q + '_' + r,
          layer: layer.index,
          q: q,
          r: r,
          x: +x.toFixed(4),
          y: layer.y,
          z: +z.toFixed(4),
          trap: trap
        });
      }
    }
  }

  /* 대기 발판을 최상층 위 공중에 흩뿌립니다.
   * 서로 충분히 떨어지도록 배치하되, 인원이 많아 자리가 모자라면
   * 간격을 조금씩 좁혀 가며 재시도합니다.                              */
  const cells = [];
  for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q++) {
    const rMin = Math.max(-GRID_RADIUS, -q - GRID_RADIUS);
    const rMax = Math.min(GRID_RADIUS, -q + GRID_RADIUS);
    for (let r = rMin; r <= rMax; r++) {
      const { x, z } = axialToWorld(q, r);
      cells.push({ q, r, x, z });
    }
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
  }

  const pedestals = [];
  let minGap = HEX_SIZE * 4.6;
  for (let attempt = 0; attempt < 14 && pedestals.length < MAX_PLAYERS; attempt++) {
    pedestals.length = 0;
    for (const c of cells) {
      if (pedestals.length >= MAX_PLAYERS) break;
      let ok = true;
      for (const p of pedestals) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < minGap) { ok = false; break; }
      }
      if (ok) pedestals.push({ x: c.x, z: c.z });
    }
    if (pedestals.length < MAX_PLAYERS) minGap *= 0.82;
  }
  // 그래도 모자라면 남은 칸을 순서대로 채웁니다 (아주 많은 인원일 때)
  for (let i = 0; pedestals.length < MAX_PLAYERS && i < cells.length; i++) {
    const c = cells[i];
    if (!pedestals.some((p) => p.x === c.x && p.z === c.z)) pedestals.push({ x: c.x, z: c.z });
  }

  const pedY = LAYERS[0].y + PEDESTAL_RISE;
  const out = pedestals.slice(0, MAX_PLAYERS).map((p, i) => ({
    id: 'PED' + i,
    seat: i,
    x: +p.x.toFixed(4),
    y: pedY,
    z: +p.z.toFixed(4)
  }));

  // 스폰 = 자기 발판 위
  for (const p of out) {
    spawns.push({ x: p.x, y: pedY + HEX_THICKNESS / 2, z: p.z });
  }

  return { seed, tiles, spawns, pedestals: out, pedestalScale: PEDESTAL_SCALE };
}

/* ------------------------------------------------------------- room model */

const rooms = new Map();

function createRoom() {
  const id = makeRoomId();
  const room = {
    id,
    seed: (Math.random() * 0xffffffff) >>> 0,
    theme: Math.floor(Math.random() * THEME_COUNT),   // 배경 맵. 회차마다 새로 뽑습니다
    map: null,
    /* tileId -> { hits, phase, warnAt }
     *   hits  : 밟힌 횟수 (0 ~ maxHits)
     *   phase : 'idle' | 'warning' | 'broken'
     * hits 가 올라가도 maxHits 에 닿기 전까지 phase 는 'idle' 로 둡니다.
     * 그래야 다음 사람이 같은 타일을 다시 밟을 수 있습니다.            */
    tileState: new Map(),
    players: new Map(),     // socketId -> player
    spectators: new Map(),  // socketId -> { id, name }
    phase: 'waiting',       // waiting | countdown | playing | ended
    phaseEndsAt: 0,
    roundStartedAt: 0,
    winnerId: null,
    timers: new Set(),
    pedestalsActive: true,   // 대기 발판이 아직 떠 있는지
    nextEntityId: 1,
    seatColors: [...PLAYER_COLORS]
  };
  room.map = buildMap(room.seed);
  resetTileState(room);
  rooms.set(id, room);
  console.log('[room] created ' + id + ' seed=' + room.seed + ' theme=' + room.theme);
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
    layer: 3,
    anim: 'idle',
    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    ry: 0,
    /* 접지 여부. 클라이언트 추측 항법이 "중력을 더할지" 판단하는 근거입니다.
     * 공중이면 낙하 가속을 적분하고, 접지 상태면 수평 등속으로만 밉니다.   */
    grounded: true,
    wins: 0,
    lastInput: Date.now(),

    /* 이동 검증 상태 (VALIDATE).
     *   lastGood   : 마지막으로 검증을 통과한 위치. 보정할 때 이 자리로 되돌립니다.
     *   lastGoodAt : 그 시각. 여기부터 흐른 시간만큼 예산이 찹니다.
     *   budget     : 남은 수평 이동 예산(m). 토큰 버킷.
     *   strikes    : 연속 위반 횟수. 통과 보고가 하나라도 오면 0 으로 돌아갑니다. */
    lastGood: { x: spawn.x, y: spawn.y, z: spawn.z },
    lastGoodAt: Date.now(),
    budget: VALIDATE.BURST,
    strikes: 0,
    corrections: 0
  };
}

/** 검증 기준점을 지금 위치로 다시 잡습니다. 서버가 위치를 옮긴 직후에 부릅니다. */
function resetValidation(p) {
  p.lastGood.x = p.pos.x; p.lastGood.y = p.pos.y; p.lastGood.z = p.pos.z;
  p.lastGoodAt = Date.now();
  p.budget = VALIDATE.BURST;
  p.strikes = 0;
}

/**
 * 보고된 위치가 물리적으로 가능한 범위인지 봅니다.
 *
 * 통과하면 수평 이동분만큼 버킷을 씁니다(부작용). 거절하면 버킷도 시각도
 * 건드리지 않으므로, 진짜 렉이었다면 다음 보고에서 예산이 차 있어 스스로
 * 회복됩니다. 반대로 순간이동은 BURST 를 넘으므로 아무리 기다려도 통과하지
 * 못합니다.
 *
 * 잡을 수 있는 것: 속도 핵, 순간이동, 비행, 장외.
 * 잡을 수 없는 것: '밀림을 자기에게 적용하지 않는' 클라이언트. 가만히 있는
 * 것은 물리적으로 가능한 움직임이라 이 방식으로는 구분되지 않습니다.
 * 다만 밀려 떨어진 뒤 타일 위로 되돌아가는 것은 순간이동이라 잡힙니다.
 */
function moveIsPlausible(p, nx, ny, nz, now) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return false;
  if (Math.abs(nx) > VALIDATE.BOUND_XZ || Math.abs(nz) > VALIDATE.BOUND_XZ) return false;
  if (ny < VALIDATE.MIN_Y || ny > VALIDATE.MAX_Y) return false;

  let dt = (now - p.lastGoodAt) / 1000;
  if (dt < 0) dt = 0;
  else if (dt > VALIDATE.MAX_DT) dt = VALIDATE.MAX_DT;

  // 수평 — 토큰 버킷
  const budget = Math.min(VALIDATE.BURST, (p.budget || 0) + VALIDATE.MAX_H_SPEED * dt);
  const dh = Math.hypot(nx - p.lastGood.x, nz - p.lastGood.z);
  if (dh > budget) return false;

  // 수직 — 순간 판정. 위로 솟는 것만 빡빡하게 봅니다.
  const vdt = Math.max(dt, VALIDATE.V_MIN_DT);
  const dy = ny - p.lastGood.y;
  if (dy > VALIDATE.MAX_UP_SPEED * vdt + VALIDATE.V_SLACK) return false;
  if (-dy > VALIDATE.MAX_DOWN_SPEED * vdt + VALIDATE.V_SLACK) return false;

  p.budget = budget - dh;      // 통과했을 때만 씁니다
  return true;
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
    theme: room.theme,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    alive: aliveCount(room),
    total: room.players.size,
    seats: MAX_PLAYERS,
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

  /* 플레이어를 옮기지 않습니다. 이미 각자 대기 발판 위에 서 있으므로,
   * 발판만 치우면 그 자리에서 최상층으로 떨어지며 게임이 시작됩니다. */
  for (const p of room.players.values()) {
    p.alive = true;
    p.placement = 0;
    p.layer = 3;
    p.anim = 'fall';
    // 대기 중에는 검증을 쉬므로 기준점이 낡아 있습니다. 지금 자리에서 다시 잡습니다.
    resetValidation(p);
    // stale 시계도 지금부터. 안 하면 라운드 시작 직후 곧바로 stale 판정이 납니다.
    p.lastInput = Date.now();
  }
  room.pedestalsActive = false;

  broadcastPhase(room);
  io.to(room.id).emit('pedestals_clear', { at: Date.now() });
  io.to(room.id).emit('round_start', {
    startedAt: room.roundStartedAt,
    players: [...room.players.values()].map(publicPlayer)
  });

  roomTimeout(room, () => {
    if (room.phase === 'playing') endRound(room, null, 'timeout');
  }, ROUND_MAX_MS);
}

/**
 * 서버가 대신 탈락시킵니다 — 보고가 끊겨 클라이언트가 player_death 를
 * 보낼 수 없는 경우 전용입니다. 처리 내용은 player_death 핸들러와 같습니다.
 */
function eliminateStale(room, p, cause) {
  if (!p.alive) return;
  p.alive = false;
  p.anim = 'dead';
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
  p.placement = aliveCount(room) + 1;

  io.to(room.id).emit('eliminated', {
    id: p.id,
    name: p.name,
    color: p.color,
    placement: p.placement,
    cause,
    by: null, byName: null,      // 밀려서가 아니라 연결이 끊겨서입니다
    alive: aliveCount(room)
  });

  // 탈락한 주자는 곧바로 관전자 개입 권한을 얻습니다 (player_death 와 동일)
  room.spectators.set(p.id, { id: p.id, name: p.name });
  console.log('[stale] ' + p.name + ' 자동 탈락 (' + cause + ')');
  checkRoundEnd(room);
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
  // 같은 배경이 연달아 나오지 않게 직전 테마는 제외하고 뽑습니다
  if (THEME_COUNT > 1) {
    let t = Math.floor(Math.random() * (THEME_COUNT - 1));
    if (t >= room.theme) t++;
    room.theme = t;
  }
  room.map = buildMap(room.seed);
  room.tileState = new Map();
  resetTileState(room);
  room.phase = 'waiting';
  room.pedestalsActive = true;
  room.phaseEndsAt = 0;
  room.winnerId = null;
  room.lobbyDeadline = null;
  room.nextEntityId = 1;

  for (const p of room.players.values()) {
    p.alive = true;
    p.placement = 0;
    p.layer = 3;
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
    resetValidation(p);          // 서버가 옮겼으므로 기준점도 같이 옮깁니다
    p.lastInput = Date.now();    // 새 회차 — stale 시계도 다시 0 부터
    si++;
  }

  io.to(room.id).emit('map_reset', {
    seed: room.seed,
    theme: room.theme,
    map: room.map,
    pedestalsActive: true,
    players: [...room.players.values()].map(publicPlayer),
    meta: roomSnapshotMeta(room)
  });

  evaluateLobby(room);
}

/* ---------------------------------------------------------- tile handling */

/** 방의 모든 타일을 '한 번도 안 밟은' 상태로 되돌립니다. */
function resetTileState(room) {
  for (const t of room.map.tiles) {
    room.tileState.set(t.id, { hits: 0, phase: 'idle', warnAt: 0 });
  }
}

/** 이 타일이 몇 번 밟혀야 무너지는가. 함정은 항상 1회입니다. */
function maxHitsFor(tile) {
  return tile.trap ? 1 : TILE_HITS;
}

/**
 * 타일을 한 번 밟은 것으로 처리합니다.
 *
 * 마지막 타격이 아니면 hits 만 올리고 tile_hit 을 보냅니다. 이때 phase 는
 * 반드시 'idle' 로 남겨둬야 합니다 — 'warning' 으로 바꿔버리면 다음 사람이
 * 같은 타일을 밟아도 위에서 걸러져 3회 규칙이 성립하지 않습니다.
 *
 * 호출처는 두 곳입니다: 플레이어의 tile_step, 관전자 서류의 착탄.
 * 서류도 여기를 타므로 1히트만 줍니다(의도된 동작).
 */
function requestTileBreak(room, tileId, sourceId) {
  if (DEV_MODE) return;   // 개발 모드: 타일이 무너지지 않습니다
  if (room.phase !== 'playing') return;

  const st = room.tileState.get(tileId);
  if (!st || st.phase !== 'idle') return;

  const tile = room.map.tiles.find(t => t.id === tileId);
  if (!tile) return;

  const maxHits = maxHitsFor(tile);
  st.hits++;

  if (st.hits < maxHits) {
    // 아직 버팁니다 — 마모 단계만 올려서 알립니다
    io.to(room.id).emit('tile_hit', {
      tileId,
      hits: st.hits,
      maxHits,
      trap: tile.trap,
      by: sourceId || null,
      at: Date.now()
    });
    return;
  }

  // 마지막 타격 — 기존 경고→붕괴 흐름을 그대로 탑니다
  const fuse = tile.trap ? FUSE_TRAP_MS : FUSE_NORMAL_MS;
  st.phase = 'warning';
  st.warnAt = Date.now();

  io.to(room.id).emit('tile_warn', {
    tileId,
    fuse,
    trap: tile.trap,
    by: sourceId || null,
    at: Date.now(),
    hits: st.hits,
    maxHits
  });

  roomTimeout(room, () => {
    const cur = room.tileState.get(tileId);
    if (!cur || cur.phase !== 'warning') return;
    cur.phase = 'broken';
    io.to(room.id).emit('tile_break', { tileId, at: Date.now() });
  }, fuse);
}

/**
 * 재접속·중도 참가자에게 보낼 타일 진행 상태.
 * 붕괴된 것뿐 아니라 '2번 밟힌 채 서 있는' 중간 단계까지 복원해야
 * 새로 들어온 사람 화면에서만 타일이 멀쩡해 보이는 일이 없습니다.
 */
function tileProgress(room) {
  const out = [];
  for (const [id, st] of room.tileState) {
    if (st.hits > 0 || st.phase !== 'idle') {
      out.push({ id, hits: st.hits, phase: st.phase });
    }
  }
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
    spectators: r.spectators.size,
    // 이동 검증이 얼마나 개입했는지. 평상시 0 이어야 정상입니다.
    corrections: [...r.players.values()].reduce((n, p) => n + (p.corrections || 0), 0)
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
      DEV_MODE,   // 클라이언트가 이 값으로 CSS/텔레포트/카메라를 맞춥니다
      VALIDATE_ON: VALIDATE.ON,   // 진단 패널에 검증 동작 여부를 표시합니다
      MAX_PLAYERS, TICK_HZ, HEX_SIZE, HEX_THICKNESS, GRID_RADIUS,
      SEA_Y, LAYERS, FUSE_NORMAL_MS, FUSE_TRAP_MS, PEDESTAL_RISE, PEDESTAL_SCALE,
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
      theme: room.theme,
      map: room.map,
      pedestalsActive: room.pedestalsActive,
      brokenTiles: tileProgress(room),
      players: [...room.players.values()].map(publicPlayer),
      meta: roomSnapshotMeta(room),
      serverTime: Date.now()
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

    const nx = +s.p[0] || 0, ny = +s.p[1] || 0, nz = +s.p[2] || 0;
    const now = Date.now();

    /* "이 클라이언트가 살아서 말을 걸고 있다"는 사실은 좌표가 타당한지와
     * 별개입니다. 검증 거절 경로보다 먼저 찍어야, 렉으로 보정을 연달아
     * 받는 사람이 stale(AFK) 로도 오인되어 두 번 벌받지 않습니다.      */
    p.lastInput = now;

    /* 검증은 라운드 중에만 합니다.
     * 대기 중에는 발판에서 떨어진 사람을 클라이언트가 제자리로 순간이동시키고
     * (stepPhysics 의 '대기 중 이탈 방지'), 개발 모드에는 레이어 텔레포트가
     * 있습니다. 둘 다 정상 동작이라 검증에 걸리면 안 됩니다.            */
    if (VALIDATE.ON && !DEV_MODE && room.phase === 'playing') {
      if (!moveIsPlausible(p, nx, ny, nz, now)) {
        p.strikes++;
        if (p.strikes >= VALIDATE.WARN_AT) {
          p.strikes = 0;
          p.corrections++;
          p.pos.x = p.lastGood.x; p.pos.y = p.lastGood.y; p.pos.z = p.lastGood.z;
          p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
          p.lastGoodAt = now;
          socket.emit('state_correction', {
            p: [p.lastGood.x, p.lastGood.y, p.lastGood.z],
            at: now
          });
          if (VALIDATE.LOG) {
            console.log('[validate] ' + p.name + ' 위치 보정 (' + p.corrections + '회) -> ' +
              p.lastGood.x.toFixed(1) + ',' + p.lastGood.y.toFixed(1) + ',' + p.lastGood.z.toFixed(1));
          }
        }
        return;                    // 이번 보고는 버립니다
      }
      p.strikes = 0;               // 통과 — 연속 카운터 초기화
      p.lastGood.x = nx; p.lastGood.y = ny; p.lastGood.z = nz;
      p.lastGoodAt = now;
    }

    p.pos.x = nx;
    p.pos.y = ny;
    p.pos.z = nz;
    if (Array.isArray(s.v) && s.v.length === 3) {
      p.vel.x = +s.v[0] || 0;
      p.vel.y = +s.v[1] || 0;
      p.vel.z = +s.v[2] || 0;
    }
    p.ry = +s.ry || 0;
    p.layer = s.layer | 0;
    p.anim = typeof s.anim === 'string' ? s.anim.slice(0, 12) : 'idle';
    // 접지 여부(g). 구 클라이언트는 이 필드를 안 보내므로, 없으면 종전처럼 공중으로 봅니다.
    p.grounded = s.g === undefined ? false : !!s.g;
    // lastInput 은 이 핸들러 맨 위에서 이미 찍었습니다 (검증 거절 경로에서도 찍히도록)
  });

  socket.on('tile_step', (data = {}) => {
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof data.tileId !== 'string') return;
    requestTileBreak(room, data.tileId, socket.id);
  });

  socket.on('player_death', (data = {}) => {
    if (DEV_MODE) return;   // 개발 모드: 떨어져도 탈락하지 않습니다
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (room.phase !== 'playing') return;

    p.alive = false;
    p.anim = 'dead';
    p.placement = aliveCount(room) + 1;

    /* 밀어서 떨어뜨린 사람. 클라이언트가 by 로 보내오지만 그대로 믿지 않고
     * 같은 방에 살아 있는 주자인지만 확인합니다 — 자기 자신을 넣거나
     * 없는 id 를 넣어 로그를 어지럽히는 것을 막습니다.                 */
    let pusher = null;
    if (typeof data.by === 'string' && data.by !== p.id) {
      const cand = room.players.get(data.by);
      if (cand) pusher = cand;
    }

    io.to(room.id).emit('eliminated', {
      id: p.id,
      name: p.name,
      color: p.color,
      placement: p.placement,
      cause: typeof data.cause === 'string' ? data.cause.slice(0, 24) : 'fall',
      by: pusher ? pusher.id : null,
      byName: pusher ? pusher.name : null,
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
      t.layer === targetLayer && (room.tileState.get(t.id) || {}).phase === 'idle');
    const pool = candidates.length ? candidates
      : room.map.tiles.filter(t => (room.tileState.get(t.id) || {}).phase === 'idle');
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

    /* ── 보고가 끊긴 플레이어 처리 (STALE) ──────────────────────────
     * 스냅샷을 만들기 전에 손봅니다. 여기서 고치지 않으면 마지막으로 받은
     * 낙하 자세가 그대로 중계되어 공중에 굳어 보입니다.
     *
     * 클라이언트 워커 타이머가 정상이면 여기 걸릴 일이 없습니다.
     * 절전 모드·CSP 로 워커가 막힌 경우의 안전망입니다.               */
    if (room.phase === 'playing') {
      for (const p of room.players.values()) {
        if (!p.alive) continue;
        const age = now - (p.lastInput || 0);
        if (age <= STALE.ANIM_MS) continue;

        if (age > STALE.KICK_MS) { eliminateStale(room, p, 'afk'); continue; }

        if (age > STALE.DROP_MS) {
          /* 서버가 대신 중력을 적용합니다. 타일 충돌은 보지 않고 그냥
           * 떨어뜨립니다 — 서버에는 물리가 없어 착지 판정을 할 수 없고,
           * 여기까지 온 시점에서 그 플레이어는 이미 게임을 진행하지 못하는
           * 상태입니다.
           *
           * 일부러 lastGood(VALIDATE 기준점)은 건드리지 않습니다. 돌아온
           * 클라이언트가 자기 원래 높이를 보고했을 때 '비행'으로 걸려
           * 구름바다로 보정당하는 것을 막기 위해서입니다. 즉 이 낙하는
           * 구름바다에 닿기 전까지는 되돌릴 수 있는 연출입니다.        */
          const dts = TICK_MS / 1000;
          p.vel.y = Math.max(-90, (p.vel.y || 0) - 62 * dts);
          p.pos.y += p.vel.y * dts;
          p.anim = 'fall';
          p.grounded = false;
          if (p.pos.y <= SEA_Y + 2) eliminateStale(room, p, 'timeout');
        } else if (p.anim === 'fall') {
          /* 낙하 자세로 굳는 것을 막습니다 — 보고된 증상의 직접 해결.
           * startRound 가 anim='fall' 로 시작시키는데 클라이언트가 갱신을
           * 못 보내면 영원히 그 자세로 남습니다.                       */
          p.anim = 'idle';
        }
      }
    }

    const players = [];
    for (const p of room.players.values()) {
      players.push({
        id: p.id,
        p: [+p.pos.x.toFixed(3), +p.pos.y.toFixed(3), +p.pos.z.toFixed(3)],
        v: [+p.vel.x.toFixed(3), +p.vel.y.toFixed(3), +p.vel.z.toFixed(3)],
        ry: +p.ry.toFixed(3),
        l: p.layer,
        a: p.anim,
        al: p.alive ? 1 : 0,
        g: p.grounded ? 1 : 0     // 접지 여부 — 클라이언트 추측 항법의 중력 적분 스위치
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
  console.log(' tile: S=' + HEX_SIZE.toFixed(4) + '  radius=' + GRID_RADIUS +
    '  ' + (3 * GRID_RADIUS * GRID_RADIUS + 3 * GRID_RADIUS + 1) + ' tiles/layer' +
    '  arena R=' + (HEX_SIZE * 1.5 * GRID_RADIUS).toFixed(1));
  if (DEV_MODE) {
    console.log('----------------------------------------------');
    console.log(' ** 개발용 테스트 모드 (DEV_MODE) 켜짐 **');
    console.log('    · 타일이 무너지지 않습니다');
    console.log('    · 떨어져도 탈락하지 않습니다');
    console.log('    · 왼쪽 레이어 안내문 클릭 = 해당 층으로 이동');
    console.log('    끄려면 server.js 상단 DEV_MODE_ON 을 false 로');
  }
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
