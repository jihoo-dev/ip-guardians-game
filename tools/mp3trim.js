#!/usr/bin/env node
/* ===========================================================================
 * MP3 무손실 절단 — 재인코딩 없이 프레임 경계에서 자릅니다
 * ---------------------------------------------------------------------------
 *   node tools/mp3trim.js 입력.mp3 출력.mp3 <초>
 *
 * ★ 왜 ffmpeg 을 안 쓰나
 *   이 PC 에 ffmpeg 이 없었습니다(README 의 재인코딩 명령은 다른 환경에서
 *   쓴 것입니다). MP3 는 프레임이 줄줄이 붙은 구조라, <b>프레임 경계에서
 *   자르면 재인코딩 없이</b> 짧아집니다 — 음질이 전혀 손상되지 않습니다.
 *   실측으로 자르기 전후 파형 차이가 <b>0</b> 이었습니다.
 *
 * ★ 페이드아웃은 못 합니다.
 *   음량을 건드리려면 다시 인코딩해야 합니다. 그래서 <b>이미 잦아든 지점</b>
 *   에서 잘라야 합니다. 자를 자리는 귀가 아니라 파형으로 고르세요 —
 *   브라우저 콘솔에서 decodeAudioData 로 읽어 구간별 peak 를 보면 됩니다
 *   (sfx_win 은 5.65초에 음악이 끝나고 그 뒤는 −53dB 이하였습니다).
 *
 * ★ Xing/Info 헤더를 <b>지우지 말고 고쳐야</b> 합니다.
 *   그 안에 인코더 지연(앞에 붙는 빈 샘플) 정보가 들어 있어서, 지우면
 *   재생할 때 <b>앞에 20ms 무음</b>이 생깁니다(실측). 그렇다고 그냥 두면
 *   잘라낸 뒤에도 옛 길이를 알려 줍니다 — 프레임 수·바이트 수만 고칩니다.
 * ======================================================================== */
const fs = require('fs');
const [,, IN, OUT, SEC] = process.argv;
const target = parseFloat(SEC);
const buf = fs.readFileSync(IN);

let p = 0;
if (buf.slice(0,3).toString('latin1') === 'ID3') {
  const sz = (buf[6]&0x7f)<<21 | (buf[7]&0x7f)<<14 | (buf[8]&0x7f)<<7 | (buf[9]&0x7f);
  p = 10 + sz;
  console.log('ID3v2 태그 ' + p + '바이트 건너뜀');
}

const BR_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BR_V2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
const SR_V1 = [44100,48000,32000,0], SR_V2 = [22050,24000,16000,0], SR_V25 = [11025,12000,8000,0];

const frames = [];
let t = 0, sr = 0, kbps = 0, xing = null;
while (p + 4 <= buf.length) {
  if (buf[p] !== 0xFF || (buf[p+1] & 0xE0) !== 0xE0) { p++; continue; }
  const verBits = (buf[p+1] >> 3) & 3;          // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer   = (buf[p+1] >> 1) & 3;          // 1 = Layer III
  if (layer !== 1 || verBits === 1) { p++; continue; }
  const brIdx = (buf[p+2] >> 4) & 15, srIdx = (buf[p+2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) { p++; continue; }
  const mpeg1 = verBits === 3;
  const rate = (mpeg1 ? BR_V1L3 : BR_V2L3)[brIdx] * 1000;
  const freq = (verBits === 3 ? SR_V1 : verBits === 2 ? SR_V2 : SR_V25)[srIdx];
  const pad = (buf[p+2] >> 1) & 1;
  const spf = mpeg1 ? 1152 : 576;
  const len = Math.floor((spf / 8) * rate / freq) + pad;
  if (len < 24 || p + len > buf.length) break;
  sr = freq; kbps = rate/1000;

  /* 첫 프레임의 Xing/Info 헤더.
   * ★ 지우면 안 됩니다. 이 안에 인코더 지연(앞쪽에 붙는 빈 샘플) 정보가
   *   들어 있어서, 없애면 재생할 때 <b>앞에 20ms 무음</b>이 생깁니다
   *   (실측). 그래서 지우지 않고 <b>프레임 수·바이트 수만 고쳐</b> 씁니다 —
   *   안 고치면 잘라낸 뒤에도 옛 길이(8.6초)를 그대로 알려 줍니다.      */
  const tag = buf.slice(p, p+len).toString('latin1');
  const xi = Math.max(tag.indexOf('Xing'), tag.indexOf('Info'));
  if (frames.length === 0 && xi > 0) {
    xing = { off: p, len, magicAt: xi };
    p += len; continue;
  }

  if (t + spf/freq > target) break;
  frames.push([p, len]);
  t += spf / freq;
  p += len;
}

const body = Buffer.concat(frames.map(([o,l]) => buf.slice(o, o+l)));
let head = Buffer.alloc(0);
if (xing) {
  head = Buffer.from(buf.slice(xing.off, xing.off + xing.len));   // 복사본
  const m = xing.magicAt;                       // 'Xing'/'Info' 위치
  const flags = head.readUInt32BE(m + 4);
  let q = m + 8;
  /* bit0 = frames, bit1 = bytes. 있는 것만 제자리에 고쳐 씁니다 —
   * 필드 순서가 정해져 있어 앞의 것을 건너뛰어야 뒤가 맞습니다. */
  if (flags & 1) { head.writeUInt32BE(frames.length + 1, q); q += 4; }   // +1: 이 헤더 프레임 자신
  if (flags & 2) { head.writeUInt32BE(xing.len + body.length, q); q += 4; }
  console.log('Xing/Info 헤더 갱신 (flags 0x' + flags.toString(16) + ')');
}
const out = Buffer.concat([head, body]);
fs.writeFileSync(OUT, out);
console.log('원본 ' + buf.length + 'B → ' + out.length + 'B');
console.log('프레임 ' + frames.length + '개 · ' + kbps + 'kbps · ' + sr + 'Hz');
console.log('길이 ' + t.toFixed(3) + '초 (목표 ' + target + '초)');
