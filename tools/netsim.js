/* ===========================================================================
 * 네트워크 열화 재현 — 지연·지터를 끼워 넣는 TCP 중계
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/netsim.js --in 3500 --to 3000 --delay 80 --jitter 40
 *           그 뒤 브라우저·봇은 포트 3500 으로 접속합니다.
 *
 * ★ 왜 필요한가 — 이 저장소의 모든 검증이 <b>localhost(RTT 1~2ms)</b> 였습니다.
 *   행사장은 사내 WiFi 라 RTT 30~200ms 에 지터가 큽니다. 보간 지연(Interp)·
 *   이동 검증(VALIDATE)·타일 재동기화가 전부 그 흔들림 위에서 도는데,
 *   그 조건을 한 번도 재현해 본 적이 없었습니다.
 *
 * ⚠ <b>순서를 절대 바꾸면 안 됩니다.</b> 청크마다 setTimeout 으로 제각각
 *   지터를 주면 뒤 청크가 먼저 도착해 TCP 스트림이 깨집니다 — 실측으로
 *   24명 전원이 'xhr poll error' 로 접속 실패했고, 그걸 게임 문제로
 *   오해할 뻔했습니다. <b>release 시각을 단조증가</b>로 잡아야 합니다.
 * ⚠ 보낼 것이 남았는데 끊으면 그 데이터가 사라집니다 — 폴링 전송은 요청
 *   하나가 통째로 날아가 접속이 실패합니다. <b>대기 중인 것을 다 흘려보낸 뒤</b>
 *   닫습니다.
 * ⚠ TCP 라 '패킷 손실'은 흉내 낼 수 없습니다(커널이 재전송). 손실은 결국
 *   지연·지터로 나타나므로 그 둘로 재현합니다.
 * ======================================================================== */
const net = require('net');

const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const IN     = parseInt(get('--in', '3500'), 10);
const TO     = parseInt(get('--to', '3000'), 10);
const HOST   = get('--host', '127.0.0.1');
const DELAY  = parseFloat(get('--delay', '80'));    // 왕복 지연(ms)
const JITTER = parseFloat(get('--jitter', '40'));   // ± 지터(ms)

let conns = 0, bytes = 0, live = 0;
const half = DELAY / 2, jHalf = JITTER / 2;

const server = net.createServer((client) => {
  conns++; live++;
  client.setNoDelay(true);
  const up = net.connect(TO, HOST);
  up.setNoDelay(true);

  /* 한 방향 중계. release 시각을 단조증가로 잡아 순서를 보존합니다. */
  function pipe(from, to) {
    let last = 0, pending = 0, ended = false;
    from.on('data', (buf) => {
      bytes += buf.length;
      const now = Date.now();
      const want = now + Math.max(0, half + (Math.random() * 2 - 1) * jHalf);
      const at = Math.max(want, last);      // ← 추월 금지
      last = at;
      pending++;
      const wait = at - now;
      const send = () => {
        pending--;
        if (!to.destroyed) { try { to.write(buf); } catch (e) {} }
        if (ended && pending === 0 && !to.destroyed) { try { to.end(); } catch (e) {} }
      };
      if (wait < 1) send(); else setTimeout(send, wait);
    });
    from.on('end', () => {                  // 남은 것을 다 흘린 뒤 닫습니다
      ended = true;
      if (pending === 0 && !to.destroyed) { try { to.end(); } catch (e) {} }
    });
  }
  pipe(client, up); pipe(up, client);

  const kill = () => { try { client.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
  client.on('error', kill); up.on('error', kill);
  let closed = 0;
  const onClose = () => { if (++closed === 1) live--; };
  client.on('close', onClose); up.on('close', onClose);
});

server.listen(IN, () => {
  console.log('[netsim] ' + IN + ' → ' + HOST + ':' + TO +
    '  왕복지연 ' + DELAY + 'ms ± ' + JITTER + 'ms (순서 보존)');
});
const t = setInterval(() => {
  console.log('[netsim] 누적 연결 ' + conns + ' · 유지 ' + live +
    ' · 중계 ' + (bytes / 1048576).toFixed(1) + 'MB');
}, 20000);
if (t.unref) t.unref();
