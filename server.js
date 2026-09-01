/* ===========================================================================
 * IP Guardians: Fast-Track Survival  —  Authoritative Game Server
 * ---------------------------------------------------------------------------
 * Express (static) + Socket.io (rooms, tile sync, 20Hz state broadcast)
 *
 * Responsibilities
 *   1. Serve the single-file WebGL client from ./public
 *   2. Match up to MAX_PLAYERS active players per room, unlimited spectators
 *   3. Generate + own the multi-layer hex tile map (LAYER_DEFS 가 유일한 출처)
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
 * 개발용 테스트 모드 (DEV)
 * ───────────────────────────────────────────────────────────────────────
 * 켜는 법:  DEV_MODE=1 npm start
 *           (또는 아래 DEV_MODE_ON 을 true 로 바꾸고 재시작)
 * 끄는 법:  DEV_MODE=0 npm start   ← 환경변수가 파일 상수를 이깁니다
 *
 * ── 왜 항목별로 쪼갰나 ────────────────────────────────────────────
 * 층별 특수 기능을 하나씩 붙이면서 "타일은 안 무너지되 이벤트는 빨리
 * 돌려보고 싶다" 같은 조합이 계속 생깁니다. 단일 on/off 로는 매번
 * 코드를 고쳐야 하므로 처음부터 항목별 스위치로 둡니다.
 *
 * ── 전역이냐 개인이냐 ─────────────────────────────────────────────
 * noFuse 와 fastEvents 는 '타일 상태'를 바꿉니다. 사람마다 다르게 하면
 * 같은 방인데 서로 다른 맵을 보게 되므로 반드시 서버 전역입니다.
 * noEliminate 와 layerJump 는 '그 사람의 위치'만 바꾸므로 클라이언트
 * 개인 설정이어도 안전합니다 (탭마다 ?dev=1 로 따로 켤 수 있습니다).
 *
 * 단, 개인 설정이라도 위치를 순간이동시키려면 서버가 이동 검증을 면제해
 * 줘야 합니다(grantMoveExemption). 그래서 클라이언트 개인 항목도 서버가
 * DEV 로 떠 있을 때만 실제로 동작합니다 — 운영 서버에 ?dev=1 을 붙여도
 * 아무 일도 일어나지 않습니다.
 *
 * 타일 크기는 모드와 무관하게 항상 같습니다 — 모드에 따라 크기가 달라지면
 * 겹침/빈틈 특성이 두 벌이 되어 검증이 무의미해지기 때문입니다.
 * ═══════════════════════════════════════════════════════════════════════ */
/* ▼▼▼ 여기만 바꾸면 됩니다 ▼▼▼
 *   false = 평소 게임      true = 개발용 테스트 모드                    */
const DEV_MODE_ON = false;
/* ▲▲▲ 여기만 바꾸면 됩니다 ▲▲▲ */

const devOn =
  (process.env.DEV_MODE === '0' || process.env.DEV_MODE === 'false') ? false
    : (DEV_MODE_ON || process.env.DEV_MODE === '1' || process.env.DEV_MODE === 'true');

/** 환경변수로 항목 하나만 따로 끄고 싶을 때: DEV_NOFUSE=0 npm start */
const devFlag = (name, dflt) => {
  const v = process.env['DEV_' + name.toUpperCase()];
  if (v === undefined) return dflt;
  return !(v === '0' || v === 'false');
};

const DEV = {
  on: devOn,

  /* ── 서버 전역 (모든 참가자에게 똑같이 적용) ── */
  // 밟아서 생기는 퓨즈만 끕니다. 특수 타일의 파괴(폭발 등)는 그대로 둡니다 —
  // 앞으로 만들 층 기능을 dev 에서 관찰할 수 없으면 의미가 없기 때문입니다.
  noFuse: devOn && devFlag('noFuse', true),
  // 층 이벤트 간격 단축. 앞으로 만들 이벤트가 이 값을 읽습니다.
  fastEvents: devOn && devFlag('fastEvents', true),

  /* ── 클라이언트 개인 (여기 값은 '기본값'이고 탭마다 ?dev 로 바꿉니다) ── */
  noEliminate: devFlag('noEliminate', true),
  layerJump: devFlag('layerJump', true)
};

/* 층 이벤트를 얼마나 빨리 돌릴지. 앞으로 추가할 이벤트는 간격을 직접 쓰지
 * 말고 이 함수를 통과시키세요. fastEvents 를 끄면 자동으로 원래 간격입니다. */
const EVENT_SPEEDUP = 5;
function eventInterval(ms) {
  return DEV.fastEvents ? Math.max(400, Math.round(ms / EVENT_SPEEDUP)) : ms;
}

/* ------------------------------------------------------------------ config */

/* 중력 크기(양수). 클라이언트 PHYS.GRAVITY(-62) 와 반드시 같아야 합니다.
 *
 * 점프 타일의 발사 속도를 v = √(2·g·h) 로 역산하는데, 여기 g 가 클라이언트와
 * 다르면 목표 층에 못 닿거나 지나쳐 버립니다. 예전에는 아래 STALE 낙하
 * 처리에 62 가 리터럴로 박혀 있어 둘이 어긋날 여지가 있었습니다.       */
const GRAVITY_MAG = 62;

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

/* ── 타일 종류 체계 (TILE_MIX / TILE_KINDS) ───────────────────────────
 * 종전의 "일반 타일 3회 밟기" 규칙을 폐기하고 4종 체계로 대체했습니다.
 * 3회 규칙을 굴리던 코드(hits 누적 · tile_hit 이벤트 · maxHits)는 지우지
 * 않고 '강화 타일'이 그대로 물려받았습니다 — 2회 밟기라 구조가 같습니다.
 * (종전 상수 TILE_HITS 는 TILE_KINDS.reinforced.hits 로 흡수됐습니다)
 *
 *   normal     일반   1회 밟기 + 0.7~1.0초 퓨즈
 *   fragile    취약   1회 밟기 + 0.2~0.3초 퓨즈 (구 trap 을 재활용)
 *   reinforced 강화   1회에 금 → 2회째(누구든)에 파괴, 아무도 안 밟아도 3초 뒤 자동 파괴
 *   special    특수   층별 태그만 붙은 상태. 이번 단계에서는 일반과 동작이 같고 색만 다릅니다.
 *
 * 비율을 바꾸려면 TILE_MIX 만 고치면 됩니다(합이 1 이 아니어도 정규화됩니다).
 * ------------------------------------------------------------------ */
const TILE_MIX = { normal: 0.60, fragile: 0.10, reinforced: 0.10, special: 0.20 };

const TILE_KINDS = {
  normal:     { hits: 1, fuseMin: 700,  fuseMax: 1000, autoMs: 0    },
  fragile:    { hits: 1, fuseMin: 200,  fuseMax: 300,  autoMs: 0    },
  reinforced: { hits: 2, fuseMin: 0,    fuseMax: 0,    autoMs: 3000 },
  special:    { hits: 1, fuseMin: 700,  fuseMax: 1000, autoMs: 0    }
};

const TILE_KIND_ORDER = Object.keys(TILE_KINDS);
const TILE_MIX_TOTAL =
  TILE_KIND_ORDER.reduce((acc, k) => acc + (TILE_MIX[k] || 0), 0) || 1;

/** 시드 난수 하나로 타일 종류를 뽑습니다. TILE_MIX 합이 1 이 아니어도 됩니다. */
function pickTileKind(rand) {
  let roll = rand() * TILE_MIX_TOTAL;
  for (const k of TILE_KIND_ORDER) {
    roll -= (TILE_MIX[k] || 0);
    if (roll < 0) return k;
  }
  return 'normal';
}

/* ── 특수 타일 세부 분화 (SPECIAL_SUBMIX) ────────────────────────────
 * 한 층의 특수 타일(전체의 20%)을 다시 여러 갈래로 나눕니다.
 *
 * 의견제출통지 층은 특수 20% 를 다음과 같이 씁니다.
 *   75% → reject  거절이유 타일 (전체의 15%)  — 밟으면 주변까지 폭발
 *   25% → amend   보정 타일     (전체의  5%)  — 아직 미구현, 일반처럼 동작
 *
 * ★ 키는 층 번호가 아니라 '층의 special 태그'입니다. 그래서 의견제출통지
 *   층이 몇 번째로 가든 이 분화가 그대로 따라갑니다.
 * 서브믹스가 없는 태그(accel · phase 등)는 태그 이름이 그대로
 * specialType 이 됩니다 — 지금까지와 동일합니다.
 * ------------------------------------------------------------------ */
const OFFICE_SPECIAL_MIX = { reject: 0.75, amend: 0.25 };

/* ── 점프 타일 (JUMP_TILE) ────────────────────────────────────────────
 * LAYER_DEFS 에서 special:'jump' 인 층의 특수 타일입니다.
 * 밟으면 같은 q,r 좌표 그대로 위쪽 층으로 발사됩니다.
 *
 *   levels  : 만들 종류. [1,2] 면 '한 층 위' / '두 층 위' 두 종류입니다.
 *             여기에 3 을 더하면 세 종류가 되고 색·비율·판정이 다 따라옵니다.
 *   graceMs : 발사 뒤 이동 검증을 면제할 시간. 상승 시간보다 넉넉해야 합니다
 *             (두 층 상승이 약 0.89초이므로 1.2초).
 *
 * ★ 서버가 플레이어를 직접 옮기지 않습니다.
 *   프롬프트 3(신속심사 대시)에서 만든 player_impulse + grantMoveExemption
 *   구조를 그대로 씁니다. 서버는 '발동 여부·발사 속도·목표'만 정하고,
 *   실제 이동은 클라이언트 물리가 합니다.
 * ------------------------------------------------------------------ */
const JUMP_TILE = { levels: [1, 2], graceMs: 1200 };

/* 점프 타일의 세부 종류는 levels 에서 만듭니다 — 'jump1', 'jump2' …
 * 종류를 손으로 나열하지 않으므로 levels 만 고치면 전부 따라옵니다.  */
const JUMP_SUBMIX = {};
for (const lv of JUMP_TILE.levels) JUMP_SUBMIX['jump' + lv] = 1 / JUMP_TILE.levels.length;

const SPECIAL_SUBMIX = {
  reject: OFFICE_SPECIAL_MIX,     // special:'reject' 인 층에 적용
  jump: JUMP_SUBMIX               // special:'jump'   인 층에 적용
};

/**
 * 특수 타일의 세부 종류를 뽑습니다.
 * 서브믹스가 정의되지 않은 층은 태그를 그대로 씁니다.
 *
 * ★ 서브믹스가 있든 없든 rand() 를 정확히 한 번 쓰는 것이 중요합니다.
 *   층마다 난수 소비 횟수가 달라지면 같은 시드인데 아래층 배치가
 *   통째로 바뀝니다 (buildMap 의 보호 구역 주석과 같은 이유).
 */
function pickSpecialSubtype(layerSpecial, rand) {
  const mix = SPECIAL_SUBMIX[layerSpecial];
  const roll = rand();
  if (!mix) return layerSpecial;
  const keys = Object.keys(mix);
  const total = keys.reduce((acc, k) => acc + (mix[k] || 0), 0) || 1;
  let acc = roll * total;
  for (const k of keys) {
    acc -= (mix[k] || 0);
    if (acc < 0) return k;
  }
  return keys[0];
}

/* 퓨즈는 타일마다 범위 안에서 한 번 뽑아 맵에 박아 둡니다.
 * 밟을 때마다 뽑으면 같은 타일이 회차마다 다르게 무너져 학습이 안 되고,
 * 재접속자에게 남은 시간을 복원해 줄 수도 없습니다.                    */
function pickTileFuse(kind, rand) {
  const k = TILE_KINDS[kind] || TILE_KINDS.normal;
  if (k.fuseMax <= k.fuseMin) return k.fuseMin;
  return Math.round(k.fuseMin + rand() * (k.fuseMax - k.fuseMin));
}

/* ── 위상 타일 (PHASE_TILE) ───────────────────────────────────────────
 * LAYER_DEFS 에서 special:'phase' 인 층의 특수 타일입니다.
 * 밟아도 무너지지 않고, 대신 '있다/없다'가 주기적으로 바뀝니다.
 *   ON  onMs  동안 실체 — 평소 타일처럼 밟힙니다
 *   OFF offMs 동안 비활성 — 지지력이 없어 위에 있으면 떨어집니다
 * 모든 위상 타일이 같은 리듬으로 동시에 켜지고 꺼집니다.
 *
 * ★ 층 번호를 쓰지 마세요. 청구항 층이 3번째로 올라가든 맨 아래로 가든
 *   special:'phase' 태그만 따라가야 합니다 (isPhaseTile 참고).
 *
 * ★ 동기화: 매 틱 상태를 보내지 않습니다.
 *   서버가 라운드 시작 시각(room.phaseEpoch)만 알려주고, 서버와 클라이언트가
 *   각자 아래 같은 공식으로 계산합니다. 클라이언트는 자기 시계를 RTT 보정값
 *   (G.serverOffset)으로 서버 시각에 맞춘 뒤 넣습니다.
 *       elapsed = now - phaseEpoch
 *       isOn    = (elapsed % (onMs + offMs)) < onMs
 *   그래도 어긋날 수 있으니 20Hz 스냅샷에 현재 값을 1바이트(ph)로 함께
 *   실어 보내 클라이언트가 자기 계산을 검산하게 합니다.
 * ------------------------------------------------------------------ */
const PHASE_TILE = { onMs: 2000, offMs: 1000 };
const PHASE_TILE_PERIOD = PHASE_TILE.onMs + PHASE_TILE.offMs;

/** 이 타일이 위상 타일인가. 층 번호가 아니라 층 태그로만 판정합니다. */
function isPhaseTile(tile) {
  return !!tile && tile.kind === 'special' && tile.specialType === 'phase';
}

/**
 * 지금 위상 타일이 켜져 있는가 (서버 시각 기준).
 * 라운드 시작 전(phaseEpoch 0)에는 ON 으로 봅니다 — 대기 중에 발판 대신
 * 이 타일 위에 서게 되는 일은 없지만, 켜진 상태로 라운드를 시작해야
 * "라운드 시작 시 ON" 규칙과 어긋나지 않습니다.
 */
function phaseTilesOn(room, now) {
  if (!room || !room.phaseEpoch) return true;
  const elapsed = now - room.phaseEpoch;
  if (elapsed < 0) return true;
  return (elapsed % PHASE_TILE_PERIOD) < PHASE_TILE.onMs;
}

/* ── 신속심사 타일 (DASH) ─────────────────────────────────────────────
 * LAYER_DEFS 에서 special:'accel' 인 층의 특수 타일입니다.
 * 밟으면 진행 방향으로 DASH.tiles 칸 튀어나갑니다. 타일 자체는 일반 타일과
 * 똑같이 퓨즈가 붙어 무너집니다.
 *
 * ★ 왜 서버가 위치를 직접 옮기지 않는가
 *   이 게임은 '이동은 클라이언트 권위, 서버는 검증'입니다. 서버가 좌표를
 *   밀어 넣으면 클라이언트 물리와 싸우게 되고, 반대로 클라이언트가 혼자
 *   2칸을 뛰면 VALIDATE 의 속도 상한에 걸려 state_correction 으로
 *   되돌려집니다(캐릭터가 덜덜 떨림).
 *
 *   그래서 서버는 '발동 여부와 도착 지점'만 정하고(권위),
 *   player_impulse 로 알려준 뒤 그 플레이어의 이동 검증을 graceMs 동안
 *   면제합니다. 실제 이동은 여전히 클라이언트가 합니다.
 *   면제 창구는 새로 만들지 않고 기존 grantMoveExemption 을 씁니다 —
 *   dev 순간이동이 쓰던 것과 같은 창구입니다(개념을 두 벌로 두지 않습니다).
 *
 * ★ to 를 '순간이동 좌표'가 아니라 '도착 목표'로 쓰는 이유
 *   클라이언트는 매 물리 프레임 수평 속도를 maxSpeed(15/질주 21.5)로
 *   자릅니다. speed 38 을 주입해도 한 프레임 만에 잘리고, 거기에
 *   순간이동까지 겹치면 400ms 동안 2칸이 아니라 6칸을 갑니다.
 *   그래서 클라이언트는 대시 창 동안만 상한을 풀고 to 까지 '실제로'
 *   이동합니다. 걸리는 시간은 거리 ÷ speed ≈ 194ms 로 graceMs 의 절반입니다.
 *   순간이동이 없으므로 20Hz 스냅샷도 연속이라 다른 화면에서도 자연스럽습니다.
 * ------------------------------------------------------------------ */
const DASH = { tiles: 2, speed: 38, graceMs: 400 };

/* 대시 거리(DASH_DISTANCE)는 HEX_SIZE 에서 파생되는데, HEX_SIZE 는 아래
 * '맵 상수' 구역에서 선언됩니다. const 는 호이스팅돼도 초기화 전에는 못
 * 읽으므로(TDZ) 여기서 계산하면 서버가 기동조차 못 합니다.
 * 그래서 파생값은 HEX_SIZE 선언 바로 뒤에 둡니다. */

/* 이 보고와 직전 보고 사이에 이만큼 이상 움직였으면 '실제로 움직였다'고 봅니다.
 * 20Hz 보고 기준이라 걷기만 해도 0.7 이상 나옵니다. 낙하 중 미세한 흔들림이나
 * 부동소수점 잡음은 걸러집니다.                                       */
const MOVE_EPS = 0.05;

/** 이 타일이 신속심사 타일인가. 층 번호가 아니라 층 태그로만 판정합니다. */
function isAccelTile(tile) {
  return !!tile && tile.kind === 'special' && tile.specialType === 'accel';
}

/* ── 거절이유 타일 (REJECT_TILE) ──────────────────────────────────────
 * 의견제출통지 층 특수 타일의 75% 입니다.
 * 평소엔 일반 타일처럼 보이다가, 밟으면 delayMin~delayMax 뒤에 터지면서
 * 자기 자신과 같은 층 이웃(radius 칸)을 함께 없앱니다.
 *
 *   radius = 1  →  중앙 1 + 이웃 6 = 7칸
 *   radius = 2  →  중앙 1 + 18    = 19칸
 *
 * ★ 연쇄 폭발은 하지 않습니다.
 *   폭발 범위 안에 다른 거절이유 타일이 있어도 '같이 제거'만 하고
 *   그 타일의 폭발 예약은 취소합니다. 연쇄를 허용하면 한 번 밟는 것으로
 *   맵 절반이 사라집니다.
 *
 * ★ DEV.noFuse 여도 폭발은 돕니다.
 *   noFuse 는 '밟아서 생기는 일반 퓨즈'만 끄는 것이고, 이 폭발은
 *   dev 에서 색 변화와 제거 연출을 관찰해야 하는 대상입니다. 그래서
 *   requestTileBreak 안이 아니라 tile_step 에서 따로 부릅니다
 *   (신속심사 대시와 같은 이유·같은 구조).
 * ------------------------------------------------------------------ */
const REJECT_TILE = { delayMin: 1500, delayMax: 2000, radius: 1 };

/** 이 타일이 거절이유 타일인가. 층 번호가 아니라 태그로만 판정합니다. */
function isRejectTile(tile) {
  return !!tile && tile.kind === 'special' && tile.specialType === 'reject';
}

/* ── 보정 타일 (amend) ────────────────────────────────────────────────
 * 의견제출통지 층 특수 타일의 나머지 25%(전체의 5%)입니다.
 * 밟으면 인접 이웃 중 '이미 부서진' 타일 하나를 되살립니다.
 *
 * ★ 되살릴 타일은 서버가 고릅니다.
 *   클라이언트마다 따로 뽑으면 화면마다 다른 타일이 되살아나고, 서버가
 *   아는 맵과도 어긋납니다. 서버가 정해 tile_restore 로 알려줍니다.
 *
 * 보정 타일 자체는 특별 취급하지 않습니다 — requestTileBreak 를 그대로
 * 타서 일반 특수 타일 퓨즈로 무너집니다(1회성). 위상·거절이유 타일처럼
 * 제외 목록에 넣으면 안 됩니다.
 * ------------------------------------------------------------------ */
function isAmendTile(tile) {
  return !!tile && tile.kind === 'special' && tile.specialType === 'amend';
}

/**
 * 점프 타일이면 '몇 층 위로' 보내는지, 아니면 0.
 * specialType 이 'jump1' · 'jump2' … 형태이므로 뒤의 숫자를 그대로 씁니다.
 * 층 번호가 아니라 태그로만 판정하므로 아이디어 층이 어디로 가든 따라옵니다.
 */
function jumpLevelOf(tile) {
  if (!tile || tile.kind !== 'special') return 0;
  const m = /^jump(\d+)$/.exec(tile.specialType || '');
  if (!m) return 0;
  const lv = parseInt(m[1], 10);
  return JUMP_TILE.levels.indexOf(lv) >= 0 ? lv : 0;
}

/** 이 타일이 점프 타일인가. */
function isJumpTile(tile) {
  return jumpLevelOf(tile) > 0;
}

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

/* 1칸 = 육각 이웃 중심거리. flat-top 규약에서 √3·S 입니다.
 * HEX_SIZE 를 바꾸면 대시 거리도 자동으로 따라옵니다 (숫자를 박지 마세요).
 * DASH 상수 자체는 위 '신속심사 타일' 구역에 있고, 여기는 파생값입니다 —
 * HEX_SIZE 가 여기서 선언되므로 그 전에는 계산할 수 없습니다(TDZ).      */
/* 점프 정점을 목표 표면보다 이만큼 넘깁니다.
 * 0 이면 정점이 표면과 정확히 같아 수직 속도 0 으로 스치는데, 클라이언트
 * 착지 판정은 '내려오며 표면을 통과할 때' 잡히므로 놓칠 수 있습니다.  */
const JUMP_APEX_MARGIN = 0.6;

const HEX_NEIGHBOR_STEP = Math.sqrt(3) * HEX_SIZE;
const DASH_DISTANCE = DASH.tiles * HEX_NEIGHBOR_STEP;

/* 맵 반경은 인원에 맞춰 늘어납니다.
 * 반경 R 의 육각 그리드 타일 수 = 3R² + 3R + 1
 * 타일이 작아진 만큼 1인당 배분을 22 → 38 로 올려 층당 개수를 약 2배로 만듭니다.
 * (4인 기준: 반경 5/91타일 → 반경 7/169타일)                          */
const TILES_PER_PLAYER = parseInt(process.env.TILES_PER_PLAYER, 10) || 38;
const GRID_RADIUS = parseInt(process.env.GRID_RADIUS, 10) ||
  Math.max(7, Math.round(Math.sqrt(TILES_PER_PLAYER * MAX_PLAYERS / 3)));

/* ── 대기 발판 ────────────────────────────────────────────────────────
 * 게임 시작 전 각 플레이어가 자기 발판 위에서 대기합니다.
 * 정원이 차면 발판이 사라지고, 플레이어들이 최상층으로 떨어지며 시작됩니다. */
const PEDESTAL_RISE  = 9.0;   // 최상층 위로 띄우는 높이
/* 타일이 1.5배 작아졌으므로 발판은 상대 배율을 올려 서 있기 편한 크기를 유지합니다.
 * 1.45 × 3.2 = 4.64  →  2.1 × 2.133 = 4.48 (절대 크기가 거의 그대로)      */
const PEDESTAL_SCALE = 2.1;
const THEME_COUNT = 3;          // 배경 맵 개수 (public/assets/bg)

/* ── 층 정의 (LAYER_DEFS) ─────────────────────────────────────────────
 * ★ 층에 관한 모든 것의 유일한 출처입니다. 여기만 고치면 이름·순서·개수·
 *   높이·색·구름바다 높이·클라이언트 HUD 가 전부 따라옵니다.
 *
 * 배열 0번이 '맨 위층'입니다. 층 번호(index)는 개수에서 1까지 내려갑니다
 * (5층이면 5,4,3,2,1 / 4층이면 4,3,2,1). 그래서 배열을 뒤집으면 이름과
 * 색의 순서만 바뀌고 번호 체계는 그대로 유지됩니다.
 *
 * 기획이 아직 확정되지 않아 층이 늘거나 순서가 바뀔 것이 확실합니다.
 * 그러니 서버·클라이언트 어디에도 층 번호(3 등)를 직접 쓰지 마세요.
 * 필요하면 TOP_LAYER / BOTTOM_LAYER / LAYERS 를 쓰세요.
 *
 *   special : 그 층 특수 타일의 태그. 지금은 색으로만 구분되고 동작은
 *             일반 타일과 같습니다. 다음 작업에서 하나씩 채웁니다.
 *   trait   : 층 전체에 걸리는 성질. 아직 미사용('none').
 * ------------------------------------------------------------------ */
/* LAYER_GAP 은 검증용으로 환경변수도 받습니다: LAYER_GAP=8 npm start */
const LAYER_GAP = parseInt(process.env.LAYER_GAP, 10) || 12;   // 층 간격
const LAYER_BASE_Y = 0;                                        // 최하층 y

const LAYER_DEFS = [
  { key: 'fasttrack', name: '우선심사 패스트트랙', short: 'FAST-TRACK',
    color: '#00ffcc', special: 'accel',  trait: 'none' },
  { key: 'office',    name: '의견제출통지',       short: 'OFFICE ACTION',
    color: '#0088ff', special: 'reject', trait: 'none' },
  { key: 'exam',      name: '실체심사/선행기술조사', short: 'EXAMINATION',
    color: '#7c5cff', special: 'search', trait: 'none' },
  { key: 'claim',     name: '청구항',             short: 'CLAIM',
    color: '#ff8a3d', special: 'phase',  trait: 'none' },
  { key: 'idea',      name: '아이디어',           short: 'IDEATION',
    color: '#aa00ff', special: 'jump',   trait: 'none' }
];

/* 파생 — 여기서 만들어진 LAYERS 가 그대로 클라이언트로 내려갑니다. */
const LAYER_LAST = LAYER_DEFS.length - 1;
const LAYERS = LAYER_DEFS.map((d, i) => ({
  key: d.key,
  index: LAYER_DEFS.length - i,                    // 0번이 맨 위 → 번호가 가장 큼
  y: LAYER_BASE_Y + (LAYER_LAST - i) * LAYER_GAP,  // 0번이 가장 높음
  color: d.color,
  name: d.name,
  short: d.short,
  special: d.special,
  trait: d.trait
}));

const TOP_LAYER = LAYERS[0];
const BOTTOM_LAYER = LAYERS[LAYERS.length - 1];

/* 구름바다는 최하층에서 이만큼 아래입니다.
 * 예전에는 -16 이 박혀 있어서, 층을 늘리거나 LAYER_GAP 을 바꾸면 바닥층이
 * 구름에 잠기거나 구름이 저 아래 보이지 않는 곳으로 밀려났습니다.      */
const SEA_DROP = 16;
const SEA_Y = BOTTOM_LAYER.y - SEA_DROP;

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

/* ── 육각 축좌표 6방향 ─────────────────────────────────────────────── */
const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** 타일 id 규칙. neighborsOf 가 이 규칙으로 이웃을 찾으므로 한 곳에 둡니다. */
function tileKey(layerIndex, q, r) {
  return 'L' + layerIndex + '_' + q + '_' + r;
}

/* 타일 id 색인. map.tiles 를 매번 find 로 훑으면 타일이 800개가 넘는 5층
 * 맵에서 밟을 때마다 선형 탐색이 돕니다. map 객체는 소켓으로 그대로
 * 나가야 해서 Map 을 필드로 달 수 없으므로 WeakMap 에 붙여 둡니다.    */
const tileIndexCache = new WeakMap();

function tileIndexFor(map) {
  let idx = tileIndexCache.get(map);
  if (!idx) {
    idx = new Map();
    for (const t of map.tiles) idx.set(t.id, t);
    tileIndexCache.set(map, idx);
  }
  return idx;
}

/** 타일 id 로 한 번에 찾습니다 (선형 탐색 금지). */
function tileById(map, tileId) {
  return tileIndexFor(map).get(tileId);
}

/**
 * 같은 층에서 tile 을 중심으로 반경 radius 안의 이웃 타일들 (자기 자신 제외).
 *
 *   radius = 1  →  맞닿은 6칸 (HEX_DIRS 와 같음)
 *   radius = 2  →  그 바깥 링까지 총 18칸
 *
 * 폭발(주변 타일 연쇄 붕괴)과 복구(주변 타일 되살리기)에서 쓸 예정이라
 * 미리 만들어 둡니다. 맵 가장자리에서는 없는 칸이 자연히 빠집니다.
 *
 * 인자로 map 을 받는 이유: 타일 배열은 방마다 다릅니다(방마다 시드가 다름).
 * 호출은 neighborsOf(room.map, tile, 1) 형태입니다.
 */
function neighborsOf(map, tile, radius) {
  const R = Math.max(1, radius | 0);
  const idx = tileIndexFor(map);
  const out = [];
  // 축좌표에서 반경 R 의 육각 범위: |dq| <= R, |dr| <= R, |dq+dr| <= R
  for (let dq = -R; dq <= R; dq++) {
    const lo = Math.max(-R, -dq - R);
    const hi = Math.min(R, -dq + R);
    for (let dr = lo; dr <= hi; dr++) {
      if (dq === 0 && dr === 0) continue;
      const nb = idx.get(tileKey(tile.layer, tile.q + dq, tile.r + dr));
      if (nb) out.push(nb);
    }
  }
  return out;
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

        /* 최상층 스폰 링은 일반 타일만 깔립니다 — 떨어지자마자 취약 타일을
         * 밟아 죽는 사고를 막습니다. 층 번호를 박지 않고 TOP_LAYER 와
         * 비교하므로, 층을 늘리거나 순서를 뒤집어도 그대로 동작합니다.   */
        const protectedSpawn = layer.index === TOP_LAYER.index && dist >= GRID_RADIUS - 1;

        /* 종류와 퓨즈를 먼저 뽑고, 보호 구역이면 일반으로 되돌립니다.
         * 보호 구역에서 rand() 를 건너뛰면 안 됩니다 — 난수 소비 횟수가
         * 달라져 같은 시드인데 나머지 타일 배치가 통째로 바뀝니다.      */
        let kind = pickTileKind(rand);
        let fuse = pickTileFuse(kind, rand);
        if (protectedSpawn && kind !== 'normal') {
          kind = 'normal';
          fuse = pickTileFuse('normal', rand);
        }

        /* 특수 타일이면 그 층의 서브믹스로 세부 종류를 한 번 더 뽑습니다.
         * 서브믹스가 없는 층은 태그가 그대로 specialType 이 됩니다.    */
        const specialType = kind === 'special'
          ? pickSpecialSubtype(layer.special, rand)
          : null;

        const spec = TILE_KINDS[kind];
        tiles.push({
          id: tileKey(layer.index, q, r),
          layer: layer.index,
          q: q,
          r: r,
          x: +x.toFixed(4),
          y: layer.y,
          z: +z.toFixed(4),
          kind: kind,
          // 특수 타일에만 붙습니다 (예: 'phase' · 'accel' · 'reject' · 'amend')
          specialType: specialType,
          maxHits: spec.hits,
          autoMs: spec.autoMs,
          fuse: fuse
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
    /* tileId -> { kind, hits, phase, warnAt, breakAt, fuseMs }
     *   kind    : 'normal' | 'fragile' | 'reinforced' | 'special'
     *   hits    : 밟힌 횟수 (0 ~ maxHits). 누가 밟았든 함께 쌓입니다.
     *   phase   : 'idle' | 'warning' | 'broken'
     *   warnAt  : 경고가 시작된 시각
     *   breakAt : 파괴 예정 시각(ms). 0 이면 예약 없음.
     *   fuseMs  : 마지막 타격에서 파괴까지의 시간. 맵 생성 때 뽑아 둡니다.
     *
     * hits 가 올라가도 maxHits 에 닿기 전까지 phase 는 'idle' 로 둡니다.
     * 그래야 다음 사람이 같은 타일을 다시 밟을 수 있습니다(강화 타일).  */
    tileState: new Map(),
    players: new Map(),     // socketId -> player
    spectators: new Map(),  // socketId -> { id, name }
    phase: 'waiting',       // waiting | countdown | playing | ended
    phaseEndsAt: 0,
    roundStartedAt: 0,
    /* 위상 타일의 기준 시각. 라운드 시작에 찍고, 클라이언트는 이 값만 받아
     * 같은 공식으로 ON/OFF 를 계산합니다 (매 틱 상태를 보내지 않습니다). */
    phaseEpoch: 0,
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
    layer: TOP_LAYER.index,
    anim: 'idle',
    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    ry: 0,
    /* 접지 여부. 클라이언트 추측 항법이 "중력을 더할지" 판단하는 근거입니다.
     * 공중이면 낙하 가속을 적분하고, 접지 상태면 수평 등속으로만 밉니다.   */
    grounded: true,
    wins: 0,
    lastInput: Date.now(),
    /* 마지막으로 '실제로' 수평 이동한 시각. 0 이면 이번 라운드에 한 번도
     * 움직인 적이 없다는 뜻이고, 그때는 대시가 발동하지 않습니다
     * (스폰 낙하 직후 방향 없이 튀어나가는 것을 막습니다).            */
    lastMoveAt: 0,
    lastDashAt: 0,
    lastJumpAt: 0,

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

/**
 * 이동 검증을 잠깐 면제합니다.
 *
 * 순간이동은 정의상 검증에 걸립니다. 개발용 층 이동뿐 아니라 앞으로 만들
 * 층 이벤트(순간이동 발판, 강제 이동 등)도 같은 문제를 겪으므로, 그때마다
 * VALIDATE 를 손대는 대신 이 창구 하나를 재사용하세요.
 *
 * 면제 창을 짧게 두는 게 핵심입니다 — 길면 그동안 아무 좌표나 통과합니다.
 * 20Hz 보고 기준 1.5초면 순간이동 한 번을 받아내기에 충분합니다.
 */
function grantMoveExemption(p, ms) {
  p.exemptUntil = Date.now() + (ms || 1500);
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
/**
 * 좌표 자체가 말이 되는가 — NaN·장외·지하.
 *
 * 속도 검사와 일부러 나눴습니다. 대시나 순간이동으로 '속도 면제'를 받는
 * 동안에도 이건 반드시 봐야 합니다. 예전에는 면제가 걸리면 이 검사까지
 * 통째로 건너뛰어서, 면제 창 400ms 안에는 아무 좌표나 통과했습니다.
 */
function moveIsSane(nx, ny, nz) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return false;
  if (Math.abs(nx) > VALIDATE.BOUND_XZ || Math.abs(nz) > VALIDATE.BOUND_XZ) return false;
  if (ny < VALIDATE.MIN_Y || ny > VALIDATE.MAX_Y) return false;
  return true;
}

function moveIsPlausible(p, nx, ny, nz, now) {
  if (!moveIsSane(nx, ny, nz)) return false;

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
    /* 위상 타일 기준 시각. meta 는 init·phase·map_reset 에 모두 실리므로
     * 중도 참가자도 여기서 한 번에 받아 갑니다.                       */
    phaseEpoch: room.phaseEpoch || 0,
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
  /* 위상 타일은 라운드 시작 순간 ON 으로 출발합니다.
   * 시작 시각을 그대로 기준으로 삼으므로 elapsed 0 → ON 입니다.      */
  room.phaseEpoch = room.roundStartedAt;

  /* 플레이어를 옮기지 않습니다. 이미 각자 대기 발판 위에 서 있으므로,
   * 발판만 치우면 그 자리에서 최상층으로 떨어지며 게임이 시작됩니다. */
  for (const p of room.players.values()) {
    p.alive = true;
    p.placement = 0;
    p.layer = TOP_LAYER.index;
    p.anim = 'fall';
    /* 이동 기록을 지웁니다. 안 지우면 지난 회차에 움직인 기록이 남아
     * 이번 회차에 한 번도 안 움직이고 밟아도 대시가 나갑니다.        */
    p.lastMoveAt = 0;
    p.lastDashAt = 0;
    p.lastJumpAt = 0;
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
    phaseEpoch: room.phaseEpoch,
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
  room.phaseEpoch = 0;          // 다음 라운드 시작에서 다시 찍습니다
  room.winnerId = null;
  room.lobbyDeadline = null;
  room.nextEntityId = 1;

  for (const p of room.players.values()) {
    p.alive = true;
    p.placement = 0;
    p.layer = TOP_LAYER.index;
    p.lastMoveAt = 0;
    p.lastDashAt = 0;
    p.lastJumpAt = 0;
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
  room.tileState.clear();
  for (const t of room.map.tiles) {
    room.tileState.set(t.id, {
      kind: t.kind,
      hits: 0,
      phase: 'idle',
      warnAt: 0,
      breakAt: 0,
      fuseMs: t.fuse,
      /* true 면 breakAt 에 '혼자 사라지는' 대신 주변까지 폭발합니다.
       * 거절이유 타일을 밟았을 때만 켜집니다.                          */
      explode: false
    });
  }
}

/** 이 타일이 몇 번 밟혀야 무너지는가. 종류표(TILE_KINDS)가 정합니다. */
function maxHitsFor(tile) {
  return (tile && tile.maxHits) || 1;
}

/**
 * 붕괴를 '예약만' 합니다. 실제 파괴는 20Hz 틱(tickTiles)이 합니다.
 *
 * ★ setTimeout 을 쓰지 않는 이유
 *   앞으로 '심사 가속'에서 이미 타들어가던 퓨즈까지 빨라져야 합니다.
 *   setTimeout 은 한 번 잡으면 앞당길 수 없습니다. breakAt 을 숫자로만
 *   들고 있으면 가속은 그 숫자를 줄이는 한 줄이면 됩니다.
 */
function scheduleTileBreak(room, tileId, fuseMs, sourceId) {
  const st = room.tileState.get(tileId);
  if (!st || st.phase !== 'idle') return;

  const now = Date.now();
  const fuse = Math.max(0, fuseMs | 0);
  st.phase = 'warning';
  st.warnAt = now;
  st.breakAt = now + fuse;

  const tile = tileById(room.map, tileId);
  io.to(room.id).emit('tile_warn', {
    tileId,
    fuse,
    kind: st.kind,
    by: sourceId || null,
    at: now,
    hits: st.hits,
    maxHits: maxHitsFor(tile)
  });
}

/**
 * 거절이유 타일이 터집니다 — 자기 자신과 같은 층 이웃을 함께 없앱니다.
 *
 * 이웃 계산은 neighborsOf(map, tile, radius) 를 그대로 씁니다. 그 함수는
 * tileKey(tile.layer, …) 로 찾으므로 **같은 층만** 나옵니다 — 위아래 층은
 * 애초에 후보에 들어오지 않습니다.
 *
 * 이미 무너진 타일은 조용히 건너뜁니다(오류 아님). 맵 가장자리라 이웃이
 * 6개가 안 되는 것도 정상입니다 — neighborsOf 가 없는 칸을 알아서 뺍니다.
 */
function explodeTile(room, tile, now) {
  const radius = Math.max(1, REJECT_TILE.radius | 0);
  const targets = [tile].concat(neighborsOf(room.map, tile, radius));

  const removed = [];
  for (const t of targets) {
    const st = room.tileState.get(t.id);
    if (!st) continue;
    if (st.phase === 'broken') continue;      // 이미 무너짐 — 건너뜁니다

    /* ★ 연쇄 폭발 방지.
     * 범위 안에 카운트다운 중인 다른 거절이유 타일이 있어도 그 예약을
     * 여기서 지우고 '그냥 제거'만 합니다. 연쇄를 허용하면 한 번 밟는
     * 것으로 맵이 순식간에 사라집니다.                               */
    st.explode = false;
    st.phase = 'broken';
    st.breakAt = 0;
    removed.push(t.id);
  }

  io.to(room.id).emit('tile_explode', {
    tileId: tile.id,
    tiles: removed,
    radius: radius,
    at: now
  });
  return removed;
}

/**
 * 부서진 타일 하나를 되살립니다.
 *
 * tileState 를 '한 번도 안 밟은' 상태로 통째로 되돌립니다. 일부만 되돌리면
 * (예: phase 만 idle 로) hits 나 explode 가 남아 다음에 밟았을 때
 * 엉뚱하게 동작합니다 — 그래서 resetTileState 와 같은 모양으로 새로 씁니다.
 */
function restoreTile(room, tile) {
  if (!tile) return false;
  const st = room.tileState.get(tile.id);
  if (!st) return false;

  room.tileState.set(tile.id, {
    kind: tile.kind,
    hits: 0,
    phase: 'idle',
    warnAt: 0,
    breakAt: 0,
    fuseMs: tile.fuse,
    explode: false
  });

  io.to(room.id).emit('tile_restore', {
    tileId: tile.id,
    kind: tile.kind,
    specialType: tile.specialType || null,
    at: Date.now()
  });
  return true;
}

/**
 * 보정 타일을 밟았습니다 — 부서진 이웃 하나를 되살립니다.
 *
 * requestTileBreak 안이 아니라 tile_step 에서 따로 부릅니다.
 * DEV.noFuse 면 타일이 아예 안 무너져 되살릴 대상이 없는데, 그때도
 * "보정 성공" 문구는 떠야 하기 때문입니다 (거절이유·대시와 같은 구조).
 *
 * @returns 이벤트 페이로드 (되살린 게 없으면 restored: null)
 */
function tryAmend(room, p, tile) {
  if (!isAmendTile(tile)) return null;
  if (room.phase !== 'playing') return null;

  /* 인접 이웃 중 '이미 부서진' 것만 후보입니다.
   * neighborsOf 는 tileKey(tile.layer, …) 로 찾으므로 같은 층만 나옵니다. */
  const broken = neighborsOf(room.map, tile, 1).filter((t) => {
    const st = room.tileState.get(t.id);
    return st && st.phase === 'broken';
  });

  let restored = null;
  if (broken.length) {
    const pick = broken[Math.floor(Math.random() * broken.length)];
    if (restoreTile(room, pick)) restored = pick.id;
  }

  const payload = {
    tileId: tile.id,
    restored: restored,          // null 이면 되살릴 이웃이 없었다는 뜻
    candidates: broken.length,
    by: p ? p.id : null,
    byName: p ? p.name : null,
    at: Date.now()
  };
  io.to(room.id).emit('tile_amend', payload);
  return payload;
}

/**
 * 거절이유 타일을 밟았습니다 — 폭발을 예약합니다.
 *
 * requestTileBreak 안이 아니라 tile_step 에서 따로 부릅니다.
 * DEV.noFuse 는 '밟아서 생기는 일반 퓨즈'만 끄는 것이고, 이 폭발은
 * dev 에서도 관찰돼야 하기 때문입니다 (신속심사 대시와 같은 구조).
 *
 * @returns 예약했으면 페이로드, 아니면 null
 */
function tryReject(room, p, tile) {
  if (!isRejectTile(tile)) return null;
  if (room.phase !== 'playing') return null;

  const st = room.tileState.get(tile.id);
  if (!st || st.phase !== 'idle') return null;   // 이미 카운트다운 중이거나 부서짐

  const now = Date.now();
  const span = Math.max(0, REJECT_TILE.delayMax - REJECT_TILE.delayMin);
  const delay = REJECT_TILE.delayMin + Math.floor(Math.random() * (span + 1));

  st.phase = 'warning';        // 다시 밟혀도 중복 예약되지 않게
  st.warnAt = now;
  st.breakAt = now + delay;
  st.explode = true;

  const payload = {
    tileId: tile.id,
    delay: delay,
    radius: REJECT_TILE.radius,
    by: p ? p.id : null,
    byName: p ? p.name : null,
    at: now
  };
  io.to(room.id).emit('tile_reject', payload);
  return payload;
}

/**
 * 예약된 붕괴를 실행합니다. 20Hz 루프에서 방마다 한 번씩 부릅니다.
 *
 * 강화 타일의 자동 파괴(autoMs)도 같은 경로입니다 — 첫 밟기에서 breakAt 을
 * 걸어두고 phase 는 'idle' 로 두므로, 그 사이 두 번째로 밟히면 더 이른
 * breakAt 으로 덮어써집니다. 두 시계를 따로 굴리지 않아도 됩니다.
 */
function tickTiles(room, now) {
  if (room.phase !== 'playing') return;
  for (const [id, st] of room.tileState) {
    if (st.phase === 'broken') continue;
    if (!st.breakAt || now < st.breakAt) continue;

    /* 거절이유 타일은 혼자 사라지지 않고 주변까지 없앱니다.
     * explode 를 먼저 끄는 이유: explodeTile 이 이 타일도 대상에 넣어
     * broken 으로 바꾸므로, 여기서 안 끄면 플래그가 남습니다.
     * (Map 을 순회하는 중이지만 키를 더하거나 지우지 않고 값만 바꾸므로
     *  순회는 안전합니다. 이번 틱에 같이 부서진 이웃은 위 broken 검사에
     *  걸려 자연히 건너뜁니다.)                                       */
    if (st.explode) {
      st.explode = false;
      const tile = tileById(room.map, id);
      if (tile) { explodeTile(room, tile, now); continue; }
    }

    st.phase = 'broken';
    st.breakAt = 0;
    io.to(room.id).emit('tile_break', { tileId: id, at: now });
  }
}

/**
 * 신속심사 타일을 밟았을 때 대시를 발동합니다.
 *
 * 서버가 정하는 것: 발동 여부, 방향, 도착 지점, 면제 창.
 * 서버가 하지 않는 것: 실제 이동 — 그건 여전히 클라이언트 몫입니다.
 *
 * 방향은 p.ry 를 씁니다. 클라이언트가 입력이 있을 때만 ry 를 갱신하므로
 * (index.html 의 local.ry = atan2(wish.x, wish.z)), 멈춰 있어도 마지막으로
 * 움직인 방향이 그대로 남아 있습니다. 다만 ry 는 기본값 0 이라 그것만으로는
 * '한 번도 안 움직인 사람'과 '정북으로 움직였던 사람'을 구분할 수 없어서,
 * lastMoveAt 으로 실제 이동 이력을 함께 봅니다.
 *
 * @returns 발동했으면 impulse 페이로드, 아니면 null
 */
function tryDash(room, p, tile) {
  if (!isAccelTile(tile)) return null;
  if (!p || !p.alive || room.phase !== 'playing') return null;

  const now = Date.now();
  // 착지 한 번에 두 번 발동하는 것을 막는 최소 간격
  if (p.lastDashAt && now - p.lastDashAt < 150) return null;

  /* ★ 한 번도 움직인 적이 없으면 발동하지 않습니다.
   * 라운드 시작 직후 발판에서 떨어져 그대로 밟은 경우가 여기 걸립니다 —
   * 방향 기록이 없는데 ry 기본값 0 으로 튀어나가면 안 됩니다.        */
  if (!p.lastMoveAt) return null;

  const ry = +p.ry;
  if (!Number.isFinite(ry)) return null;

  // 클라이언트 규약: 방향 = (sin(ry), cos(ry))  — local.ry = atan2(wish.x, wish.z)
  const dx = Math.sin(ry), dz = Math.cos(ry);
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;

  const to = [
    +(p.pos.x + (dx / len) * DASH_DISTANCE).toFixed(4),
    +p.pos.y.toFixed(4),
    +(p.pos.z + (dz / len) * DASH_DISTANCE).toFixed(4)
  ];
  const vel = [
    +((dx / len) * DASH.speed).toFixed(4),
    0,
    +((dz / len) * DASH.speed).toFixed(4)
  ];

  /* 이동 검증 면제. 이게 없으면 2칸을 0.19초에 가는 순간 속도 상한에
   * 걸려 state_correction 으로 되돌려집니다 (= 캐릭터가 덜덜 떨림).  */
  grantMoveExemption(p, DASH.graceMs);
  p.lastDashAt = now;

  const payload = { id: p.id, type: 'dash', to, vel, graceMs: DASH.graceMs, at: now };

  /* 본인에게만 보내도 동작은 하지만, 방 전체에 보냅니다.
   * 대시 중에는 20Hz 스냅샷의 프레임간 이동량이 평소의 두 배가 되어
   * 원격 보간이 NET.SNAP_DIST 를 넘겨 강제 스냅(뚝 끊김)을 낼 수 있습니다.
   * 다른 클라이언트는 이 신호로 그 주자의 허용 오차를 잠깐 넓힙니다.  */
  io.to(room.id).emit('player_impulse', payload);
  return payload;
}

/**
 * 점프 타일을 밟았습니다 — 위쪽 층으로 발사합니다.
 *
 * 서버가 정하는 것: 발동 여부, 발사 속도, 목표 층·목표 타일, 착지 가능 여부,
 * 그리고 이동 검증 면제 창.
 * 서버가 하지 않는 것: 실제 이동 — 대시와 똑같이 클라이언트 물리가 합니다.
 * (수직 속도가 VALIDATE.MAX_UP_SPEED(34)를 크게 넘으므로 면제가 필수입니다.
 *  한 층 약 39.5, 두 층 약 55.2 — 대시와 달리 토큰 버킷으로는 못 넘깁니다.)
 *
 * @returns 발사했으면 impulse 페이로드, 아니면 null
 */
function tryJump(room, p, tile) {
  const level = jumpLevelOf(tile);
  if (!level) return null;
  if (!p || !p.alive || room.phase !== 'playing') return null;

  const now = Date.now();
  if (p.lastJumpAt && now - p.lastJumpAt < 150) return null;   // 한 착지에 두 번 방지

  /* ★ 목표 층이 없으면 발동하지 않습니다.
   * 층 번호는 위로 갈수록 커지므로 목표는 tile.layer + level 입니다.
   * 맨 위층에서 밟거나(1), 위에서 두 번째 층에서 두 층 점프를 밟으면(2)
   * 여기서 걸립니다. 층 개수가 바뀌어도 LAYERS 를 찾아보므로 안전합니다. */
  const fromLayer = LAYERS.find((L) => L.index === tile.layer);
  const toLayer = LAYERS.find((L) => L.index === tile.layer + level);
  if (!fromLayer || !toLayer) return null;

  /* 높이차는 두 층의 실제 y 차이로 냅니다.
   * LAYER_GAP * level 과 같은 값이지만, 나중에 층 간격이 균일하지 않게
   * 되더라도 이 식은 그대로 맞습니다.                                */
  const dy = toLayer.y - fromLayer.y;
  if (!(dy > 0)) return null;

  /* v = √(2·g·h). 그대로 쓰면 정점이 목표 표면과 정확히 같아 '스치듯'
   * 닿습니다 — 클라이언트 착지 판정은 '내려오면서 표면을 지날 때' 잡히므로
   * 아주 살짝 넘겨야 확실히 올라탑니다. 그래서 여유 높이를 더합니다.  */
  const v = Math.sqrt(2 * GRAVITY_MAG * (dy + JUMP_APEX_MARGIN));

  /* 목표 지점 — 수평 이동 없이 바로 위입니다(같은 q,r 열).
   * 착지면은 층 y + 타일 두께의 절반으로, 다른 타일과 같은 규칙입니다. */
  const targetSurface = toLayer.y + HEX_THICKNESS / 2;
  const targetTile = tileById(room.map, tileKey(toLayer.index, tile.q, tile.r));

  /* 착지 가능 여부 판정 (서버).
   *   · 목표 좌표에 타일이 아예 없음        → 실패
   *   · 이미 부서짐                          → 실패
   *   · 위상 타일인데 지금 OFF               → 실패
   * 실패해도 발사는 합니다 — 올라갔다가 그대로 떨어지는 것이 규칙입니다. */
  let landed = false;
  let reason = 'no_tile';
  if (targetTile) {
    const st = room.tileState.get(targetTile.id);
    if (!st || st.phase === 'broken') reason = 'broken';
    else if (isPhaseTile(targetTile) && !phaseTilesOn(room, now)) reason = 'phase_off';
    else { landed = true; reason = 'ok'; }
  }

  grantMoveExemption(p, JUMP_TILE.graceMs);
  p.lastJumpAt = now;

  const payload = {
    id: p.id,
    type: 'jump',
    level: level,
    to: [+p.pos.x.toFixed(4), +targetSurface.toFixed(4), +p.pos.z.toFixed(4)],
    vel: [0, +v.toFixed(4), 0],
    graceMs: JUMP_TILE.graceMs,
    fromLayer: fromLayer.index,
    toLayer: toLayer.index,
    targetTileId: targetTile ? targetTile.id : null,
    landed: landed,          // 발사 시점의 서버 판정 (연출·문구용)
    reason: reason,
    at: now
  };

  // 대시와 같은 이유로 방 전체에 보냅니다 (원격 보간 허용 오차 확대)
  io.to(room.id).emit('player_impulse', payload);
  return payload;
}

/**
 * 타일을 한 번 밟은 것으로 처리합니다.
 *
 * 마지막 타격이 아니면 hits 만 올리고 tile_hit 을 보냅니다. 이때 phase 는
 * 반드시 'idle' 로 남겨둬야 합니다 — 'warning' 으로 바꿔버리면 다음 사람이
 * 같은 타일을 밟아도 위에서 걸러져 강화 타일의 2회 규칙이 성립하지 않습니다.
 *
 * 호출처는 두 곳입니다: 플레이어의 tile_step, 관전자 서류의 착탄.
 * 서류도 여기를 타므로 1히트만 줍니다(의도된 동작).
 */
function requestTileBreak(room, tileId, sourceId, reason) {
  /* DEV.noFuse 는 '밟아서 생기는 퓨즈'만 끕니다.
   * 여기서 무조건 return 하면 앞으로 만들 특수 타일의 파괴(폭발 등)까지
   * 막혀 dev 모드에서 그 기능을 관찰할 수 없게 됩니다. 그래서 호출처가
   * 이유를 함께 넘기고, step 만 걸러냅니다.
   *   'step'     — 플레이어가 밟음        (noFuse 대상)
   *   'obstacle' — 관전자 서류 착탄       (dev 에서도 관찰해야 함)
   *   그 외      — 앞으로 만들 특수 타일  (dev 에서도 관찰해야 함)      */
  if (DEV.noFuse && (reason === undefined || reason === 'step')) return;
  if (room.phase !== 'playing') return;

  const st = room.tileState.get(tileId);
  if (!st || st.phase !== 'idle') return;

  const tile = tileById(room.map, tileId);
  if (!tile) return;

  /* ★ 위상 타일은 밟아도 무너지지 않습니다.
   * 타일 자체는 라운드 내내 그대로 있고, '밟을 수 있는 시간'만 주기적으로
   * 바뀝니다. 그래서 hits 도 올리지 않고 breakAt 도 걸지 않습니다.
   * 관전자 서류(reason 'obstacle')도 여기를 지나므로 함께 막힙니다.  */
  if (isPhaseTile(tile)) return;

  /* ★ 거절이유 타일은 일반 퓨즈를 타지 않습니다.
   * 폭발 예약은 tryReject 가 따로 겁니다(1.5~2초). 여기서 일반 퓨즈
   * (0.7~1초)까지 걸면 폭발하기도 전에 타일이 혼자 사라져 버립니다.  */
  if (isRejectTile(tile)) return;

  const maxHits = maxHitsFor(tile);
  const now = Date.now();
  st.hits++;

  /* 강화 타일: 첫 밟기에 자동 파괴 시계를 겁니다.
   * 아무도 두 번째로 밟지 않아도 autoMs 뒤에 무너집니다. phase 는 'idle'
   * 그대로라 그 사이 누가 밟으면 아래 분기가 더 이른 breakAt 으로 덮습니다. */
  if (tile.autoMs > 0 && st.hits === 1) st.breakAt = now + tile.autoMs;

  if (st.hits < maxHits) {
    // 아직 버팁니다 — 마모 단계만 올려서 알립니다 (강화 타일의 '금이 감')
    io.to(room.id).emit('tile_hit', {
      tileId,
      hits: st.hits,
      maxHits,
      kind: st.kind,
      autoAt: st.breakAt || 0,     // 자동 파괴 예정 시각 (없으면 0)
      by: sourceId || null,
      at: now
    });
    return;
  }

  // 마지막 타격 — 예약만 하고 실제 파괴는 틱이 합니다
  scheduleTileBreak(room, tileId, st.fuseMs, sourceId);
}

/**
 * 재접속·중도 참가자에게 보낼 타일 진행 상태.
 * 붕괴된 것뿐 아니라 '2번 밟힌 채 서 있는' 중간 단계까지 복원해야
 * 새로 들어온 사람 화면에서만 타일이 멀쩡해 보이는 일이 없습니다.
 */
function tileProgress(room) {
  const now = Date.now();
  const out = [];
  for (const [id, st] of room.tileState) {
    if (st.hits > 0 || st.phase !== 'idle') {
      out.push({
        id,
        hits: st.hits,
        phase: st.phase,
        kind: st.kind,
        // 경고 중이면 '남은' 퓨즈를 보냅니다 — 처음부터 다시 세면
        // 중간 참가자 화면에서만 타일이 더 오래 버팁니다.
        fuse: st.phase === 'warning' ? Math.max(0, st.breakAt - now) : 0,
        // 폭발 대기 중인 거절이유 타일. 중간 참가자도 같은 연출을 봐야 합니다.
        explode: !!st.explode
      });
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

/**
 * 클라이언트에 내려보내는 규격 전체.
 *
 * 소켓(server_hello)과 HTTP(/api/config)가 같은 것을 써야 합니다 —
 * 참가 화면은 소켓을 붙이기 전이라(연결은 참가 버튼에서 시작) 층 안내문과
 * 규칙 설명을 HTTP 로 먼저 받아야 채울 수 있습니다. 두 벌로 두면 한쪽만
 * 고쳤을 때 참가 전과 참가 후의 설명이 달라집니다.
 */
function publicConfig() {
  return {
    /* 개발 모드 상태 전체를 내려줍니다. 클라이언트는 여기에 URL 의
     * ?dev 옵션을 겹쳐서 자기 탭의 최종 설정을 만듭니다.            */
    DEV: {
      on: DEV.on,
      noFuse: DEV.noFuse,               // 서버 전역 — 읽기 전용
      fastEvents: DEV.fastEvents,       // 서버 전역 — 읽기 전용
      noEliminate: DEV.noEliminate,     // 개인 기본값 (?dev 로 덮어쓸 수 있음)
      layerJump: DEV.layerJump,         // 개인 기본값 (?dev 로 덮어쓸 수 있음)
      eventSpeedup: DEV.fastEvents ? EVENT_SPEEDUP : 1
    },
    DEV_MODE: DEV.on,   // 구 클라이언트 호환 (예전엔 이 불리언 하나였습니다)
    VALIDATE_ON: VALIDATE.ON,   // 진단 패널에 검증 동작 여부를 표시합니다
    MAX_PLAYERS, TICK_HZ, HEX_SIZE, HEX_THICKNESS, GRID_RADIUS,
    /* 층·타일 규격은 전부 서버가 내려줍니다. 클라이언트는 이 값으로만
     * 지오메트리와 HUD 를 만들고 아무것도 하드코딩하지 않습니다.     */
    SEA_Y, LAYERS, LAYER_GAP, LAYER_BASE_Y,
    TILE_MIX, TILE_KINDS, PHASE_TILE, DASH, REJECT_TILE, OFFICE_SPECIAL_MIX, JUMP_TILE,
    PEDESTAL_RISE, PEDESTAL_SCALE,
    BOOSTER_TTL_MS, OBSTACLE_FALL_MS,
    BOOSTER_COOLDOWN_MS, OBSTACLE_COOLDOWN_MS
  };
}

/* 참가 화면이 소켓 연결 전에 층/타일 규격을 읽어가는 창구입니다. */
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicConfig());
});

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

  socket.emit('server_hello', { now: Date.now(), config: publicConfig() });

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
     * 대기 중에는 발판에서 떨어진 사람을 클라이언트가 제자리로 순간이동시키므로
     * (stepPhysics 의 '대기 중 이탈 방지') 검증에 걸리면 안 됩니다.
     *
     * 면제 창이 열려 있으면 이번 보고를 그대로 받아들이고 기준점으로 삼습니다
     * (dev 층 이동 · 앞으로 만들 순간이동 이벤트가 grantMoveExemption 으로
     *  여는 창입니다). 예전에는 dev 모드면 검증을 통째로 껐는데, 그러면
     *  dev 서버에서 검증 자체를 시험해 볼 수가 없었습니다.              */
    const exempt = p.exemptUntil !== undefined && now < p.exemptUntil;

    /* '실제로 움직였는가' 기록. 대시 방향 판정에 씁니다.
     * p.pos 를 덮어쓰기 전에 재야 하므로 여기서 봅니다.
     * 수평만 봅니다 — 낙하는 이동 의사가 아닙니다.                   */
    if (Math.hypot(nx - p.pos.x, nz - p.pos.z) > MOVE_EPS) p.lastMoveAt = now;

    if (VALIDATE.ON && !exempt && room.phase === 'playing') {
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
    } else if (exempt) {
      /* 면제는 '속도 검사'만 면제입니다. 좌표가 NaN 이거나 장외인 것은
       * 면제 중에도 받지 않습니다 — 안 그러면 대시 창 400ms 안에 아무
       * 좌표나 통과합니다.                                            */
      if (!moveIsSane(nx, ny, nz)) return;
      /* 면제로 받아들인 좌표를 새 기준점으로 삼습니다. 이걸 안 하면 면제 창이
       * 닫히는 순간 '옮기기 전 위치'와 비교되어 곧바로 보정당합니다.    */
      p.lastGood.x = nx; p.lastGood.y = ny; p.lastGood.z = nz;
      p.lastGoodAt = now;
      p.budget = VALIDATE.BURST;
      p.strikes = 0;
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

  /* 개발용 순간이동 예고.
   * 클라이언트가 '위치를 바꾸기 직전에' 보냅니다. 서버는 검증 면제 창만
   * 열어 주고, 실제 이동은 여느 때처럼 player_state 로 들어옵니다
   * (이동 권한은 여전히 클라이언트에 있습니다).
   *
   * 서버가 DEV 로 떠 있을 때만 받습니다 — 운영 서버에서 이 메시지를
   * 받아 주면 그대로 순간이동 치트가 됩니다.                          */
  socket.on('dev_teleport', (data = {}) => {
    if (!DEV.on || !DEV.layerJump) return;
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    grantMoveExemption(p, 1500);
    if (typeof data.layer === 'number') p.layer = data.layer | 0;
    // 떨어져 있던 상태에서 눌렀다면 되살립니다 (noEliminate 와 짝)
    if (!p.alive && DEV.noEliminate) {
      p.alive = true;
      p.anim = 'idle';
      room.spectators.delete(p.id);
      broadcastPhase(room);
    }
  });

  socket.on('tile_step', (data = {}) => {
    if (!room || role !== 'player') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof data.tileId !== 'string') return;

    /* 아직 안 밟힌 타일일 때만 특수 효과를 봅니다.
     * requestTileBreak 도 같은 조건을 자체적으로 확인하지만, 대시는
     * 그 함수의 결과와 무관하게 발동해야 하므로 여기서 따로 봅니다
     * (DEV.noFuse 면 타일은 안 무너지지만 대시는 관찰돼야 합니다). */
    const st = room.tileState.get(data.tileId);
    const tile = tileById(room.map, data.tileId);
    const fresh = !!st && st.phase === 'idle';

    // 신속심사 타일도 밟은 뒤에는 일반 타일처럼 퓨즈가 붙어 무너집니다
    requestTileBreak(room, data.tileId, socket.id, 'step');

    if (fresh) {
      tryDash(room, p, tile);
      tryReject(room, p, tile);
      tryAmend(room, p, tile);
      tryJump(room, p, tile);
    }
  });

  socket.on('player_death', (data = {}) => {
    /* DEV.noEliminate: 떨어져도 탈락시키지 않습니다.
     * 클라이언트는 애초에 player_death 를 보내지 않지만, 개인 설정이라
     * dev 를 끈 탭에서 보내올 수도 있으므로 서버에서도 한 번 더 막습니다. */
    if (DEV.on && DEV.noEliminate) return;
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

    let targetLayer = alive[0].layer || TOP_LAYER.index;
    if (data.targetId) {
      const t = room.players.get(String(data.targetId));
      if (t && t.alive) targetLayer = t.layer || targetLayer;
    }

    /* 위상 타일은 서류를 맞아도 안 무너지므로 후보에서 뺍니다.
     * 안 빼면 관전자가 쿨다운을 쓰고도 아무 일이 안 일어납니다.       */
    const breakable = (t) =>
      !isPhaseTile(t) && (room.tileState.get(t.id) || {}).phase === 'idle';
    const candidates = room.map.tiles.filter(t => t.layer === targetLayer && breakable(t));
    const pool = candidates.length ? candidates : room.map.tiles.filter(breakable);
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
      requestTileBreak(room, tile.id, null, 'obstacle');
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

    /* 예약된 타일 붕괴를 여기서 실행합니다 (종전 setTimeout 대체).
     * 스냅샷보다 먼저 돌려야, 이번 틱에 무너진 타일을 클라이언트가
     * 같은 프레임의 위치 갱신과 함께 받습니다.                        */
    tickTiles(room, now);

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
          p.vel.y = Math.max(-90, (p.vel.y || 0) - GRAVITY_MAG * dts);
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

    /* ph: 위상 타일이 지금 켜져 있는가 (1/0).
     * 클라이언트는 평소 자기 공식으로 계산하고, 이 값은 검산용입니다 —
     * 계산이 어긋난 것을 발견하면 그때만 서버 값으로 넘어갑니다.      */
    io.to(room.id).emit('state', {
      t: now,
      players,
      ph: phaseTilesOn(room, now) ? 1 : 0
    });
  }
}, TICK_MS);

/* ------------------------------------------------------------- lifecycle */

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(' IP Guardians: Fast-Track Survival');
  console.log(' listening on http://' + HOST + ':' + PORT);
  console.log(' static dir: ' + path.join(__dirname, STATIC_DIR));
  console.log(' tick: ' + TICK_HZ + 'Hz   seats/room: ' + MAX_PLAYERS);
  const perLayer = 3 * GRID_RADIUS * GRID_RADIUS + 3 * GRID_RADIUS + 1;
  console.log(' tile: S=' + HEX_SIZE.toFixed(4) + '  radius=' + GRID_RADIUS +
    '  ' + perLayer + ' tiles/layer' +
    '  arena R=' + (HEX_SIZE * 1.5 * GRID_RADIUS).toFixed(1));
  console.log(' layers: ' + LAYERS.length + '개  gap=' + LAYER_GAP +
    '  y=' + LAYERS.map((L) => L.index + ':' + L.y).join(' ') +
    '  sea=' + SEA_Y);
  console.log(' tiles: ' + (perLayer * LAYERS.length) + '개  mix=' +
    TILE_KIND_ORDER.map((k) =>
      k + ' ' + Math.round((TILE_MIX[k] / TILE_MIX_TOTAL) * 100) + '%').join(' / '));
  const rejectLayers = LAYERS.filter((L) => L.special === 'reject');
  console.log(' 거절이유 타일: ' + (rejectLayers.length
    ? rejectLayers.map((L) => 'LAYER ' + L.index + ' ' + L.name).join(', ') +
      '  (특수 ' + Math.round(TILE_MIX.special / TILE_MIX_TOTAL * 100) + '% 중 ' +
      Math.round(OFFICE_SPECIAL_MIX.reject * 100) + '% = 전체 ' +
      (TILE_MIX.special / TILE_MIX_TOTAL * OFFICE_SPECIAL_MIX.reject * 100).toFixed(0) + '%' +
      ', ' + REJECT_TILE.delayMin + '~' + REJECT_TILE.delayMax + 'ms 뒤 반경 ' +
      REJECT_TILE.radius + ' 폭발)'
    : '없음'));
  if (rejectLayers.length) {
    console.log(' 보정 타일    : LAYER ' + rejectLayers[0].index + ' ' + rejectLayers[0].name +
      '  (특수 ' + Math.round(TILE_MIX.special / TILE_MIX_TOTAL * 100) + '% 중 ' +
      Math.round(OFFICE_SPECIAL_MIX.amend * 100) + '% = 전체 ' +
      (TILE_MIX.special / TILE_MIX_TOTAL * OFFICE_SPECIAL_MIX.amend * 100).toFixed(0) +
      '%, 밟으면 부서진 이웃 1칸 복구)');
  }
  const jumpLayers = LAYERS.filter((L) => L.special === 'jump');
  console.log(' 점프 타일    : ' + (jumpLayers.length
    ? jumpLayers.map((L) => 'LAYER ' + L.index + ' ' + L.name).join(', ') + '  (' +
      JUMP_TILE.levels.map((lv) => {
        const from = jumpLayers[0], to = LAYERS.find((L) => L.index === from.index + lv);
        if (!to) return lv + '층↑ 불가';
        const v = Math.sqrt(2 * GRAVITY_MAG * (to.y - from.y + JUMP_APEX_MARGIN));
        return lv + '층↑ v=' + v.toFixed(1) + ' 상승 ' + (v / GRAVITY_MAG).toFixed(2) + 's';
      }).join(' / ') + ', grace ' + JUMP_TILE.graceMs + 'ms)'
    : '없음'));
  const accelLayers = LAYERS.filter((L) => L.special === 'accel');
  console.log(' 신속심사 타일: ' + (accelLayers.length
    ? accelLayers.map((L) => 'LAYER ' + L.index + ' ' + L.name).join(', ') +
      '  (' + DASH.tiles + '칸 = ' + DASH_DISTANCE.toFixed(2) +
      ' 유닛 / speed ' + DASH.speed + ' → ' +
      Math.round(DASH_DISTANCE / DASH.speed * 1000) + 'ms, grace ' + DASH.graceMs + 'ms)'
    : '없음'));
  const phaseLayers = LAYERS.filter((L) => L.special === 'phase');
  console.log(' 위상 타일: ' + (phaseLayers.length
    ? phaseLayers.map((L) => 'LAYER ' + L.index + ' ' + L.name).join(', ') +
      '  (ON ' + PHASE_TILE.onMs + 'ms / OFF ' + PHASE_TILE.offMs + 'ms)'
    : '없음 (LAYER_DEFS 에 special:\'phase\' 인 층이 없습니다)'));
  if (DEV.on) {
    const mark = (b) => (b ? 'ON ' : 'off');
    console.log('----------------------------------------------');
    console.log(' ** 개발용 테스트 모드 (DEV) 켜짐 **');
    console.log('   [서버 전역]');
    console.log('    · noFuse      ' + mark(DEV.noFuse) + '  밟아도 타일이 안 무너짐 (특수 타일 파괴는 그대로)');
    console.log('    · fastEvents  ' + mark(DEV.fastEvents) + '  층 이벤트 간격 1/' + EVENT_SPEEDUP);
    console.log('   [클라이언트 개인 기본값 — 탭마다 ?dev 로 조절]');
    console.log('    · noEliminate ' + mark(DEV.noEliminate) + '  떨어져도 탈락 없이 최상층 복귀');
    console.log('    · layerJump   ' + mark(DEV.layerJump) + '  왼쪽 층 이동 버튼');
    console.log('   접속:  http://localhost:' + PORT + '/?dev=1');
    console.log('   항목만 끄기:  DEV_NOFUSE=0 DEV_MODE=1 npm start');
    console.log('   전체 끄기  :  DEV_MODE=0 npm start');
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
