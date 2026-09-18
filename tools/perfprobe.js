/* ===========================================================================
 * 클라이언트 성능 측정 — 브라우저 콘솔에 붙여넣어 쓰는 도구
 * ---------------------------------------------------------------------------
 * ★ 이 파일은 node 로 실행하지 않습니다.
 *   게임을 띄우고(사람이든 봇이든 주자가 있는 방에 들어간 뒤)
 *   F12 → Console 에 이 파일 내용을 <b>통째로 붙여넣으면</b> 됩니다.
 *   tools/ 는 서빙되지 않으므로 <script> 로 불러올 수 없습니다.
 *
 * ★ 왜 필요한가
 *   "느리다"는 말만으로는 어디가 느린지 알 수 없고, 짐작으로 고치면
 *   엉뚱한 곳을 깎게 됩니다. 실제로 2026-09-18 점검에서
 *     · CPU 로직·GC 는 멀쩡했고(갱신 함수 전부 1ms 미만, 할당 0건)
 *     · 비용은 전부 렌더 제출이었으며
 *     · 그중 <b>캐릭터가 삼각형의 52% · 드로우콜의 70%</b> 였습니다.
 *   짐작으로는 절대 못 찾을 분포입니다.
 *
 * ★ 언제 다시 돌리나 (오늘 결론의 전제를 깨는 변경)
 *     · MAX_PLAYERS 증가          · 캐릭터 모델 교체
 *     · 씬에 물체를 더하는 변경     · 매 프레임 도는 코드 추가
 *     · 스냅샷 필드 추가           · 타일/층 수 변경
 *   문구·색·규칙 수치·소리만 바꿨다면 다시 잴 필요 없습니다.
 *
 * ★ 주의 — 잘못 재면 <b>그럴듯한 거짓 숫자</b>가 나옵니다
 *   실제로 이 셋에 전부 한 번씩 속았습니다. 어느 쪽도 오류를 내지 않고
 *   태연한 숫자를 내놓기 때문에 눈으로는 못 거릅니다.
 *
 *   1) <b>탭이 앞에 있어야 합니다.</b> 자동화 브라우저는 탭을 앞으로
 *      내놓지 않습니다 — 그 상태에서 잰 값은 의미가 없습니다.
 *      (visibilityState/hasFocus 를 noise() 가 봅니다.)
 *   2) <b>GPU 를 달군 뒤에 재야 합니다.</b> warm() 주석 참고 — 식은 채로
 *      재면 먼저 잰 쪽이 무조건 느려 보여 결론의 부호가 뒤집힙니다.
 *   3) <b>장면에 실제로 뭔가 있어야 합니다.</b> 라운드가 끝나면 맵도
 *      주자도 사라지는데, 그때도 숫자는 나옵니다(전부 0.2ms 로 붙어
 *      "절감 0%" 로 읽힙니다). <b>재기 전에 화면을 한 번 보세요</b> —
 *      HUD 의 '생존 n/n' 과 '남은 층' 이 0 이면 잴 것이 없습니다.
 *
 *   시간은 <b>gl.finish()</b> 로 잽니다. renderer.render() 는 GPU 에
 *   명령을 밀어 넣고 바로 돌아오므로, 그냥 재면 CPU 제출 시간만
 *   보이고 GPU 가 실제로 그린 시간은 안 보입니다.
 *
 * 쓰는 법
 *   perf.all()        전체 (아래를 순서대로)
 *   perf.groups()     그룹별 삼각형·드로우콜·시간 기여도
 *   perf.frame()      갱신 함수별 시간·할당
 *   perf.alloc(4)     4초 동안 프레임당 힙 증가 (GC 압력)
 *   perf.quality()    화질 단계별 픽셀비·해상도·렌더 시간
 *   perf.shadow()     캐릭터 그림자 켬/끔 비교
 * ======================================================================== */

(function () {
  'use strict';

  if (typeof renderer === 'undefined' || typeof scene === 'undefined') {
    console.error('[perf] 게임 화면에서 실행하세요 — renderer/scene 이 없습니다.');
    return;
  }

  const gl = renderer.getContext();
  const n2 = (v) => +v.toFixed(2);
  const n3 = (v) => +v.toFixed(3);

  /* GPU 완료까지 기다려 재는 벤치. 이게 이 도구의 핵심입니다. */
  function bench(N) {
    N = N || 80;
    renderer.render(scene, camera); gl.finish();          // 워밍업
    const t0 = performance.now();
    for (let i = 0; i < N; i++) renderer.render(scene, camera);
    gl.finish();
    return n2((performance.now() - t0) / N);
  }

  /* ── 예열 ────────────────────────────────────────────────────────────
   * ★ 이게 없으면 <b>모든 숫자가 거짓말</b>이 됩니다.
   *   노트북 GPU 는 쉬는 동안 클럭을 내립니다. 식은 상태에서 연달아 재면
   *     7.00 → 2.10 → 1.08 → 1.08 → 0.87ms   (편차 705%)
   *   로 나오다가, 달구고 나면
   *     2.45 → 2.67 → 2.73 → 2.56 → 2.62ms   (편차 11%)
   *   로 앉습니다. 앞의 값을 그대로 쓰면 먼저 잰 쪽이 무조건 느려 보여,
   *   "그림자를 끄면 오히려 느려진다" 같은 뒤집힌 결론이 납니다
   *   (실제로 한 번 냈습니다).
   *
   *   그러니 <b>비교하기 전에 반드시 달굽니다.</b> 최근 3회의 편차가
   *   15% 안에 들면 앉은 것으로 봅니다. 1.5초 안에 못 앉으면 포기하고
   *   진행하되, noiseCheck() 가 경고를 냅니다.               */
  function warm() {
    const t0 = performance.now();
    const a = [];
    while (performance.now() - t0 < 1500) {
      a.push(bench(30));
      if (a.length >= 3) {
        const last = a.slice(-3);
        const lo = Math.min(...last), hi = Math.max(...last);
        if ((hi - lo) / (lo || 1) <= 0.15) return true;
      }
    }
    return false;
  }

  /* 같은 상태를 여러 번 재고 <b>중앙값</b>을 씁니다.
   * 한 번씩만 재면 첫 측정의 셰이더 컴파일·GPU 클럭 상승이 그대로
   * 차이로 잡혀, "그림자를 끄면 느려진다" 같은 뒤집힌 결과가 나옵니다
   * (실제로 그랬습니다 — 켜짐 2.02ms · 꺼짐 3.36ms).                */
  let noisy = 0;
  function med(list) {
    const a = list.slice().sort((x, y) => x - y);
    const m = a[a.length >> 1];
    /* ★ 중앙값만 돌려주면 안 됩니다. 기계가 시끄러우면 같은 조건에서도
     *   2배 넘게 흔들리는데(실측 6.08 → 14.13ms), 그때도 중앙값은
     *   태연한 숫자 하나를 내놓습니다. 그걸 믿고 "그림자 절감 0%" 같은
     *   결론을 내면 멀쩡한 최적화를 되돌리게 됩니다.                */
    if ((a[a.length - 1] - a[0]) / (m || 1) > 0.25) noisy++;
    return n2(m);
  }

  /** 방금 낸 표를 믿어도 되는지 알려 줍니다. 표 끝마다 부릅니다. */
  function noiseCheck() {
    if (!noisy) return;
    console.warn('[perf] ⚠ 이 표는 믿지 마세요 — 같은 조건에서 편차 25% 초과가 ' + noisy + '회.');
    console.warn('        다른 프로그램(부하 테스트 서버·봇·빌드)을 끄고, 창을 맨 앞으로 놓고 다시 재세요.');
    console.warn('        perf.noise() 로 먼저 조용한지 확인할 수 있습니다.');
    noisy = 0;
  }

  /** 잴 수 있는 상태인가 — 아무것도 안 바꾸고 같은 장면만 5번 잽니다. */
  function noise() {
    const settled = warm();
    const a = [bench(40), bench(40), bench(40), bench(40), bench(40)];
    const lo = Math.min(...a), hi = Math.max(...a);
    const pct = (hi - lo) / (lo || 1) * 100;
    /* 장면이 비었는지도 봅니다 — 라운드가 끝나면 타일도 주자도 없는데,
     * 그 상태에서도 숫자는 태연히 나옵니다(머리말 ③).            */
    renderer.render(scene, camera);
    const tri = renderer.info.render.triangles;
    const hasScene = tri > 20000;
    const ok = settled && hasScene && pct <= 25 &&
               document.hasFocus() && document.visibilityState === 'visible';
    console.log('%c' + (ok ? '[perf] 잴 수 있는 상태입니다.' : '[perf] ⚠ 지금 재면 안 됩니다.'),
                'font-weight:bold;color:' + (ok ? '#0a7' : '#c33'));
    console.table([{ '측정 5회': a.join(' / '), '편차 %': +pct.toFixed(0),
                     '예열': settled ? '완료' : '안 앉음 ← 다시',
                     '장면': hasScene ? ('삼각형 ' + tri) : ('비어 있음(' + tri + ') ← 라운드 중에 재세요'),
                     '창이 맨 앞': document.hasFocus() ? '예' : '아니오 ← 맨 앞으로',
                     '탭이 보임': document.visibilityState === 'visible' ? '예' : '아니오' }]);
    return ok;
  }

  function table(title, rows) {
    console.log('%c' + title, 'font-weight:bold');
    console.table(rows);
    return rows;
  }

  /* ── ① 그룹별 기여도 ────────────────────────────────────────────────
   * 하나씩 숨겼다 되돌리며 삼각형·드로우콜·시간의 차이를 봅니다.
   * ⚠ renderer.info.render.calls 는 <b>마지막 패스</b>만 셉니다 —
   *   그림자 패스의 드로우콜은 여기 안 잡힙니다. 그래서 그림자 비용은
   *   개수가 아니라 perf.shadow() 의 <b>시간</b>으로 판단하세요.      */
  function groups() {
    warm();
    const g = {};
    if (typeof TileInst !== 'undefined' && TileInst.groups) g['타일(Instanced)'] = TileInst.groups.map((x) => x.mesh);
    if (typeof seaGroup !== 'undefined' && seaGroup) g['구름바다'] = [seaGroup];
    if (typeof cloudGroup !== 'undefined' && cloudGroup) g['주변 구름'] = [cloudGroup];
    if (typeof propGroup !== 'undefined' && propGroup) g['소품'] = [propGroup];
    if (typeof G !== 'undefined' && G.fences && G.fences.length) g['난간'] = G.fences;
    if (typeof actorGroup !== 'undefined') g['캐릭터'] = [actorGroup];
    if (typeof skyMesh !== 'undefined' && skyMesh) g['하늘돔'] = [skyMesh];

    renderer.render(scene, camera);
    /* 기준값도 중앙값으로 잡습니다. 한 번만 재면 아래 "절감 ms" 가
     * 음수로 나오는 그룹이 생깁니다(구름처럼 값이 작은 그룹).      */
    const base = { tri: renderer.info.render.triangles, calls: renderer.info.render.calls,
                   ms: med([bench(40), bench(40), bench(40)]) };
    const rows = [];
    for (const [name, objs] of Object.entries(g)) {
      if (!objs || !objs.length) continue;
      const was = objs.map((o) => o.visible);
      objs.forEach((o) => { o.visible = false; });
      renderer.render(scene, camera);
      const tri = base.tri - renderer.info.render.triangles;
      const calls = base.calls - renderer.info.render.calls;
      const off = med([bench(40), bench(40), bench(40)]);
      objs.forEach((o, i) => { o.visible = was[i]; });
      rows.push({ 그룹: name, 삼각형: tri, '삼각형 %': +(tri / base.tri * 100).toFixed(0),
                  드로우콜: calls, '끄면 ms': off, '절감 ms': n2(base.ms - off) });
    }
    renderer.render(scene, camera);
    rows.sort((a, b) => b.삼각형 - a.삼각형);
    console.log('전체 — 삼각형 ' + base.tri + ' · 드로우콜 ' + base.calls + ' · ' + base.ms + 'ms');
    table('① 그룹별 기여도', rows); noiseCheck(); return rows;
  }

  /* ── ② 갱신 함수별 시간·할당 ───────────────────────────────────────
   * 이름을 하드코딩하지 않고 window 에서 찾습니다 — 함수가 늘거나
   * 이름이 바뀌어도 목록만 고치면 됩니다.                            */
  const FRAME_FNS = ['updateTiles', 'updateDebris', 'updateDashTrails', 'updatePaperBits',
    'updateFinale', 'updateSearchFx', 'updateDashArrow', 'updateBoosters', 'updateObstacles',
    'updateCamera', 'updateFenceEdge', 'updateSky', 'updatePedestals', 'updateCloudSea',
    'updateSplash', 'updateLayerStack', 'updateCountdown', 'updateReadyUI',
    'updateActionCooldowns', 'updateRoster', 'updateSpectatorUI'];

  function frame() {
    const rows = [];
    const meas = (label, fn, N) => {
      N = N || 300;
      const h0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) { try { fn(); } catch (e) { return { 항목: label, 오류: e.message }; } }
      const t1 = performance.now();
      const h1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      return { 항목: label, ms: n3((t1 - t0) / N), 'KB/회': n3(((h1 - h0) / N) / 1024) };
    };
    for (const name of FRAME_FNS) {
      const f = window[name];
      if (typeof f !== 'function') continue;
      rows.push(meas(name, () => f(1 / 60, performance.now())));
    }
    if (typeof TileInst !== 'undefined' && TileInst.sync) rows.push(meas('TileInst.sync', () => TileInst.sync()));
    if (typeof G !== 'undefined' && typeof RemoteRunner !== 'undefined') {
      rows.push(meas('원격 주자 update', () => {
        for (const r of G.players.values()) if (r instanceof RemoteRunner) r.update(1 / 60, performance.now());
      }));
    }
    rows.push({ 항목: 'renderer.render (GPU 포함)', ms: bench(60), 'KB/회': '-' });
    rows.sort((a, b) => (b.ms || 0) - (a.ms || 0));
    console.log('※ KB/회 가 음수면 재는 중에 GC 가 돈 것입니다 — 0 으로 보세요.');
    return table('② 갱신 함수별 시간·할당', rows);
  }

  /* ── ③ GC 압력 ──────────────────────────────────────────────────────
   * 프레임당 힙 증가가 <b>수 KB</b> 면 정상입니다. 수십 KB 로 올라가면
   * 매 프레임 도는 코드 어딘가에 new/배열/문자열이 생긴 것입니다.     */
  async function alloc(sec) {
    sec = sec || 4;
    if (!performance.memory) { console.warn('[perf] performance.memory 가 없습니다 (크롬 계열에서만).'); return null; }
    const h0 = performance.memory.usedJSHeapSize, t0 = performance.now();
    let frames = 0;
    const end = t0 + sec * 1000;
    while (performance.now() < end) {
      renderFrame(1 / 60, performance.now()); frames++;
      await new Promise((r) => setTimeout(r, 0));
    }
    const dt = (performance.now() - t0) / 1000;
    const dh = performance.memory.usedJSHeapSize - h0;
    const row = { 초: n2(dt), 프레임: frames,
                  'KB/프레임': n3((dh / 1024) / (frames || 1)),
                  'KB/초': n2((dh / 1024) / dt) };
    return table('③ GC 압력 (참고: 2026-09-18 기준 약 0.9 KB/프레임)', [row]);
  }

  /* ── ④ 화질 단계 ────────────────────────────────────────────────────
   * ⚠ Quality.apply() 는 <b>인자를 받지 않습니다</b> — this.level 을 씁니다.
   *   apply(lv) 로 부르면 아무것도 안 바뀌는데 바뀐 것처럼 보여,
   *   "적응형 화질이 고장났다"는 오진을 하게 됩니다(실제로 한 번 했습니다).
   * ⚠ 이 게임에서 해상도를 낮춰도 거의 안 빨라집니다 — 비용이 화소가
   *   아니라 드로우콜이기 때문입니다. 그게 정상이니 놀라지 마세요.   */
  function quality() {
    warm();
    if (typeof Quality === 'undefined') { console.warn('[perf] Quality 가 없습니다.'); return null; }
    const start = Quality.level;
    const rows = [];
    for (let lv = 0; lv < QLEVELS.length; lv++) {
      Quality.level = lv; Quality.apply();
      renderer.render(scene, camera);
      rows.push({ 단계: lv + ' ' + QLEVELS[lv].name,
                  픽셀비: n2(renderer.getPixelRatio()),
                  해상도: renderer.domElement.width + '×' + renderer.domElement.height,
                  '캐릭터 그림자': (typeof avatarShadowOn !== 'undefined' && avatarShadowOn) ? '켜' : '꺼',
                  ms: med([bench(40), bench(40), bench(40)]) });
    }
    Quality.level = start; Quality.apply();
    table('④ 화질 단계별 (기기 등급 ' + (typeof GPU_TIER !== 'undefined' ? GPU_TIER : '?') + ')', rows);
    noiseCheck(); return rows;
  }

  /* ── ⑤ 캐릭터 그림자 ───────────────────────────────────────────────
   * 2026-09-18 기준 가장 큰 단일 레버였습니다(−25%). 캐릭터 모델을
   * 바꿨다면 이 값부터 다시 보세요.                                   */
  function shadow() {
    warm();
    if (typeof applyAvatarShadows !== 'function') { console.warn('[perf] applyAvatarShadows 가 없습니다.'); return null; }
    const was = (typeof avatarShadowOn !== 'undefined') ? avatarShadowOn : true;
    const count = () => { let n = 0; scene.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.castShadow) n++; }); return n; };
    /* ★ 켜고 한 번, 끄고 한 번이 아니라 <b>번갈아 5회</b> 잽니다.
     *   그림자를 끄면 재질이 재컴파일되지는 않지만 그리는 목록이 바뀌어
     *   첫 프레임이 유독 느립니다. 번갈아 재야 그 비용이 양쪽에 똑같이
     *   섞여 서로 상쇄됩니다.                                        */
    const onMs = [], offMs = [];
    let onN = 0, offN = 0;
    for (let i = 0; i < 5; i++) {
      applyAvatarShadows(true);  onN  = count(); onMs.push(bench(40));
      applyAvatarShadows(false); offN = count(); offMs.push(bench(40));
    }
    applyAvatarShadows(was);
    const on  = { 상태: '그림자 켜짐', 'castShadow 메시': onN,  ms: med(onMs) };
    const off = { 상태: '그림자 꺼짐', 'castShadow 메시': offN, ms: med(offMs) };
    const rows = [on, off, { 상태: '절감', 'castShadow 메시': on['castShadow 메시'] - off['castShadow 메시'],
                             ms: n2(on.ms - off.ms) + ' (' + ((on.ms - off.ms) / on.ms * 100).toFixed(0) + '%)' }];
    table('⑤ 캐릭터 그림자 (참고: 2026-09-18 −25%)', rows); noiseCheck(); return rows;
  }

  async function all() {
    console.log('%c=== 클라이언트 성능 측정 ===', 'font-size:14px;font-weight:bold');
    console.log('탭이 화면에 보이는 상태여야 합니다. 주자가 있는 방에서 재세요.');
    console.log('지금: 타일 ' + (typeof G !== 'undefined' ? G.tiles.size : '?') +
                ' · 주자 ' + (typeof G !== 'undefined' ? G.players.size : '?') +
                ' · 화질 ' + (typeof Quality !== 'undefined' ? QLEVELS[Quality.level].name : '?'));
    /* 시끄러운 기계에서 낸 표는 없느니만 못합니다 — 먼저 확인합니다. */
    if (!noise()) {
      console.warn('[perf] 그대로 진행합니다만, 위 경고를 먼저 해결하는 편이 좋습니다.');
    }
    groups(); frame(); await alloc(4); quality(); shadow();
    console.log('%c=== 끝 ===', 'font-weight:bold');
  }

  window.perf = { all, groups, frame, alloc, quality, shadow, noise, warm, bench };
  console.log('%c[perf] 준비됐습니다.', 'font-weight:bold;color:#0a7');
  console.log('  perf.noise()  먼저 — 지금 재도 되는 상태인지');
  console.log('  perf.all()    전체');
  console.log('  낱개: perf.groups() / perf.frame() / perf.alloc() / perf.quality() / perf.shadow()');
})();
