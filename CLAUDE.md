# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**IP Guardians: Fast-Track Survival** — 특허 심사 과정을 테마로 한 3D 실시간 멀티플레이어 서바이벌 게임(폴가이즈류 "무너지는 타일" 장르). Express + Socket.io 서버와 단일 HTML 파일 three.js 클라이언트로 구성됩니다.

3개 레이어(아이디어 구상 → 의견제출통지 → 우선심사 패스트트랙)의 육각 타일 위를 달리며, 밟은 타일이 무너지기 전에 이동해 마지막까지 살아남는 것이 목표입니다.

## 명령어

```bash
npm install
npm start                       # http://0.0.0.0:3000

MAX_PLAYERS=8 npm start         # 좌석 수 변경 (좌석/색/맵 크기/대기발판이 전부 따라옴)
PORT=8080 npm start
LOBBY_WAIT_MS=5000 SOLO_WAIT_MS=3000 npm start   # 테스트 시 대기 시간 단축

docker build -t ip-guardians . && docker run -p 3000:3000 ip-guardians
```

테스트 프레임워크, 린터, 빌드 단계가 없습니다. 검증은 **브라우저 탭 2개 이상을 `http://localhost:3000` 에 띄워** 직접 플레이하는 방식입니다. 클라이언트에서 **F2** 를 누르면 진단 패널(소켓 연결/transport, init 수신, 룸, 타일 수, 아바타 생성, 위치 보정 횟수, GLB 로드 상태)이 열립니다. 서버 상태는 `GET /healthz`, `GET /api/rooms` 로 확인합니다.

`index.html` 을 파일로 직접 열면 동작하지 않습니다 — `/socket.io/socket.io.js` 를 서버가 서빙해야 합니다.

## 아키텍처

### 파일 구조

- `server.js` (~1000줄) — 권위 서버 전체. 설정, 맵 생성, 룸 상태 머신, 소켓 핸들러, 20Hz 브로드캐스트가 한 파일에 있습니다.
- `public/index.html` (~3800줄) — 클라이언트 전체. CSS + three.js 씬 + 물리 + 네트워킹이 한 파일에 있으며, 번호가 붙은 섹션 주석(`/* ==== 8. physics ==== */`)으로 구획됩니다. 코드를 찾을 때는 이 섹션 헤더를 grep 하세요.
- `public/assets/` — `character.glb`(스켈레탈 애니메이션 포함), `face_atlas.png`, `audio/bgm_main.mp3`. **모든 에셋은 선택 사항** — GLB 로드에 실패하면 절차적 치비 캐릭터로 폴백하므로 게임은 항상 동작합니다.
- `public/patent_storytelling_concept.html` — 독립 기획서 문서. 게임과 무관합니다.
- `*_YYYYMMDD`, `*_YYYYMMDD_NN` 접미사 파일 — 수동 백업 스냅샷. 이 저장소의 관례입니다. 편집 대상이 아니며, 새 백업을 만들지도 마세요(사용자가 직접 관리).

### 권한 분리 (중요)

**이동은 클라이언트 권위, 나머지는 서버 권위**입니다.

- 클라이언트가 자기 물리(중력/점프/AABB 충돌)를 60Hz 고정 스텝으로 돌리고 20Hz로 `player_state` 를 보고합니다. 서버는 이를 검증 후 중계만 합니다.
- 서버가 소유하는 것: 맵 시드/타일 배치, **타일 붕괴 타이밍**(`tileState`: idle→warning→broken), 페이즈 전환, 관전자 개입, 승패 판정.
- 타일은 클라이언트가 낙관적으로 warning 애니메이션을 시작하고(즉각 피드백), 서버 `tile_warn`/`tile_break` 가 도착하면 재동기화합니다. 붕괴 시각의 단일 진실 원천은 서버입니다.

`server.js` 의 `VALIDATE` 블록이 이동 검증을 담당합니다. 위반 시 강제 퇴장이 아니라 **마지막 정상 위치로 되돌리기**(`state_correction`)입니다 — 렉으로 인한 오탐이 퇴장으로 이어지면 안 되기 때문입니다. `VALIDATE.WARN_AT` 회 연속 위반해야 보정이 발동합니다.

### 설정 전파 원칙

클라이언트는 맵 지오메트리를 **하드코딩하지 않습니다**. 서버가 `server_hello` 로 `config`(HEX_SIZE, GRID_RADIUS, LAYERS, SEA_Y, 퓨즈 시간, 쿨다운 등)를, `init`/`map_reset` 으로 `map`(타일 배열 + 스폰 + 대기 발판)을 내려주고 클라이언트가 그대로 지오메트리를 만듭니다. **맵/인원 관련 상수는 `server.js` 에서만 바꾸면 됩니다.**

`MAX_PLAYERS` 는 파생 상수의 진입점입니다: 좌석 수 → 플레이어 색상(`buildPlayerColors`, 4명 초과 시 황금각으로 색상환 분할) → `GRID_RADIUS`(1인당 ~22타일) → 대기 발판 개수.

### 룸 라이프사이클

```
waiting ──(정원 충족 또는 LOBBY_WAIT_MS/SOLO_WAIT_MS 만료)──▶ countdown (5s)
   ▲                                                              │
   │                                                              ▼
ended ◀──(최후 1인 / 전멸 / 5분 타임아웃 / 전원 이탈)──── playing
   │
   └──(RESET_DELAY_MS 후 resetRoom: 새 시드·새 테마, 관전자 승격)──▶ waiting
```

주의할 점들:

- **대기 발판(pedestal)**: 게임 시작 전 플레이어는 최상층 위 공중 발판에 서 있습니다. `startRound` 는 플레이어를 이동시키지 않고 발판만 치웁니다(`pedestals_clear`) — 그 자리에서 최상층으로 낙하하며 라운드가 시작됩니다.
- **라운드 중 접속자는 관전자**로 밀리지만 `wantsPlay: true` 로 표시되어 다음 `resetRoom` 에서 자동으로 주자 승격됩니다. 탈락한 주자는 즉시 관전자 개입 권한을 얻고, 다음 라운드 시작 시 회수됩니다.
- **`findOpenRoom` 은 진행 중인 방에도 빈 자리가 있으면 배정**합니다. 새 방을 파버리면 탭 2개로 테스트할 때 서로 다른 방에 갇히기 때문입니다.
- 20Hz 틱 루프가 매번 끊어진 소켓을 정리하고 `checkRoundEnd` 를 재평가합니다. `started === 0` (전원 새로고침) 을 `abandoned` 로 처리하지 않으면 방이 5분간 playing 에 묶여 이후 접속자가 전부 관전자로 밀립니다.

### 소켓 프로토콜

클라이언트 → 서버: `join`, `player_state`, `tile_step`, `player_death`, `cheer_booster`, `drop_obstacle`, `chat`, `ping_probe`

서버 → 클라이언트: `server_hello`(config), `init`(내 상태 + 맵 전체), `phase`, `round_start`, `pedestals_clear`, `tile_warn`, `tile_break`, `state`(20Hz 스냅샷), `eliminated`, `game_over`, `map_reset`, `booster_spawn`/`booster_expire`, `obstacle_drop`/`obstacle_impact`, `state_correction`, `action_denied`, `toast`, `chat`

`state` 스냅샷은 필드명을 축약합니다(`p`=pos, `v`=vel, `ry`, `l`=layer, `a`=anim, `al`=alive). 클라이언트는 `NET.INTERP_DELAY_MS`(110ms) 만큼 과거를 렌더링하는 보간 버퍼로 원격 플레이어를 그리고, 버퍼가 마르면 `EXTRAPOLATE_CAP_MS` 까지만 외삽합니다.

### 클라이언트 주의사항

- **three.js r128 을 CDN에서 전역 스크립트로 로드**합니다(모듈 아님, importmap 아님). `THREE.CapsuleGeometry` 등 최신 API가 없으므로 대체 지오메트리를 씁니다. 버전을 올릴 때는 `GLTFLoader`/`DRACOLoader`/`SkeletonUtils` CDN URL도 함께 맞춰야 합니다.
- socket.io 연결은 `transports: ['polling', 'websocket']` + `tryAllTransports: true` 로 고정되어 있습니다. websocket 을 첫 transport 로 두면 사내 프록시/방화벽이 업그레이드를 막을 때 연결 자체가 실패합니다.
- 서버가 HTML 에는 `no-cache` 를, 나머지 정적 파일에는 `max-age=3600` 을 붙입니다. 에셋을 교체했는데 반영이 안 되면 하드 리프레시가 필요합니다.
- 오디오는 브라우저 자동재생 정책 때문에 반드시 첫 사용자 클릭(참가 버튼)에서 `Sound.unlock()` 으로 열어야 합니다.
- 배경 테마는 이미지가 아니라 셰이더 스카이돔 + 절차적 구름/소품입니다(`applyTheme`, `THEMES`). 서버 `THEME_COUNT` 와 클라이언트 `THEMES` 배열 길이를 함께 맞추세요.

## 언어

코드 주석, UI 텍스트, 토스트 메시지, 커밋 메시지 모두 한국어입니다. 새 코드도 같은 방식으로 작성하세요. 코드 주석은 "무엇을" 보다 **"왜 이렇게 했는지"**(어떤 버그/제약 때문인지)를 남기는 스타일입니다.
