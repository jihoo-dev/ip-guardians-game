/* ===========================================================================
 * favicon.ico 만들기 — 의존성 없이 직접 씁니다
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/make_favicon.js
 *           node tools/make_favicon.js --preview   (확인용 BMP 도 같이)
 *
 * 만드는 것 둘 —
 *   public/favicon.ico          탭 아이콘 (16·32·48px, 둥근 모서리·투명 배경)
 *   public/apple-touch-icon.png 홈 화면 아이콘 (180px, 꽉 찬 사각·불투명)
 *   public/icon-192.png         안드로이드 매니페스트 아이콘
 *   public/icon-512.png         〃 (스플래시 화면에도 쓰입니다)
 *   ⚠ 둘은 <b>일부러 다르게</b> 그립니다 — 아래 renderFlatRGBA 주석 참고.
 *
 * ★ 왜 도구로 남기나 — 색이나 모양을 바꿀 일이 생겼을 때 이진 파일을 손으로
 *   만들 수는 없습니다. fetch_fonts.js·fetch_vendor.js 와 같은 자리입니다.
 *
 * ★ 왜 외부 라이브러리를 안 쓰나 — 아이콘 하나 때문에 의존성을 늘리지
 *   않습니다. ICO 는 BMP 를 감싼 형식이라 손으로 쓸 수 있을 만큼 단순합니다.
 *
 * 모양: 어두운 둥근 사각(#0a1018) 위에 민트 육각(#00ffcc).
 *   · 민트는 게임의 주 강조색(--l3)이고, 어두운 바탕은 HUD 판과 같은 색입니다.
 *   · 육각형은 이 게임의 타일 그 자체라 16px 에서도 무엇인지 읽힙니다.
 *   · 꼭짓점이 위로 오는 방향(pointy-top)입니다. 판정은 게임의 아레나와
 *     같은 방식으로 <b>법선 3개</b>로 봅니다(ARENA_N 과 같은 원리).
 *
 * ⚠ 16px 에서는 <b>테두리·그라디언트가 뭉갭니다.</b> 면으로만 그립니다.
 * ⚠ ICO 의 BITMAPINFOHEADER 는 높이를 <b>실제의 2배</b>로 적습니다(XOR+AND).
 *   그리고 픽셀은 <b>아래에서 위로</b> 씁니다. 둘 중 하나만 틀려도 뒤집히거나
 *   깨집니다.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'favicon.ico');
const SIZES = [16, 32, 48];            // favicon.ico 안에 들어가는 크기들
/* 홈 화면용 PNG. 180 = 아이폰(apple-touch-icon), 192·512 = 안드로이드
   매니페스트 아이콘. 512 는 스플래시 화면에도 쓰입니다. */
const TOUCH_SIZES = [180, 192, 512];
const SS = 4;                                   // 슈퍼샘플링 배수 (계단 없애기)

const BG   = [0x0a, 0x10, 0x18];                // 어두운 바탕
const MINT = [0x00, 0xff, 0xcc];                // 육각

/* 둥근 사각 안인가 */
function inRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* 정육각형(꼭짓점 위) 안인가 — 법선 3개로 봅니다 */
const HEX_N = [0, 60, 120].map((d) => {
  const t = d * Math.PI / 180;
  return { x: Math.cos(t), y: Math.sin(t) };
});
function inHex(x, y, R) {
  const lim = R * Math.sqrt(3) / 2;             // 내접반지름
  for (const n of HEX_N) if (Math.abs(x * n.x + y * n.y) > lim) return false;
  return true;
}

/** 한 변이 size 인 BGRA 픽셀(위에서 아래로) */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = size * SS;
  const rr = S * 0.22;                          // 모서리 둥글기
  /* ⚠ 16px 에서는 육각이 <b>바탕을 거의 다 먹으면</b> 민트 덩어리로만 보입니다.
     어두운 테가 남아야 모양이 읽힙니다 — 0.40 에서 0.34 로 줄였습니다. */
  const R  = S * 0.34;                          // 육각 외접반지름
  const c  = S / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgA = 0, hexA = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x * SS + sx + 0.5, fy = y * SS + sy + 0.5;
          if (!inRoundRect(fx, fy, S, rr)) continue;
          bgA++;
          if (inHex(fx - c, fy - c, R)) hexA++;
        }
      }
      const n = SS * SS;
      const a = bgA / n;                        // 아이콘 바깥은 투명
      const h = bgA ? hexA / bgA : 0;           // 바탕 안에서 육각이 차지하는 비율
      const col = [
        Math.round(BG[0] * (1 - h) + MINT[0] * h),
        Math.round(BG[1] * (1 - h) + MINT[1] * h),
        Math.round(BG[2] * (1 - h) + MINT[2] * h)
      ];
      const o = (y * size + x) * 4;
      px[o]     = col[2];                       // B
      px[o + 1] = col[1];                       // G
      px[o + 2] = col[0];                       // R
      px[o + 3] = Math.round(a * 255);          // A
    }
  }
  return px;
}

/* ── 홈 화면용 PNG (apple-touch-icon) ──────────────────────────────────
 * ⚠ 탭 아이콘과 <b>다르게 그려야 합니다.</b>
 *   · iOS 는 아이콘에 <b>자기 마스크(둥근 사각)를 다시 씌웁니다.</b> 그래서
 *     여기서 모서리를 둥글리면 이중으로 깎여 테가 지저분해집니다 — 꽉 찬
 *     사각으로 뽑고 둥글리기는 iOS 에 맡깁니다.
 *   · iOS 는 <b>투명을 검정으로 깔아 버립니다.</b> 알파를 남기면 모서리가
 *     새까맣게 찍히므로 <b>전부 불투명</b>으로 만듭니다.
 *   · 육각은 지름이 캔버스의 0.68 이라 마스크에 잘리지 않습니다(안전 영역 안).
 * 크기는 180px — 아이폰 홈 화면 기준입니다.                            */
function renderFlatRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = size * SS, R = S * 0.34, c = S / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hexA = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inHex(x * SS + sx + 0.5 - c, y * SS + sy + 0.5 - c, R)) hexA++;
        }
      }
      const h = hexA / (SS * SS);
      const o = (y * size + x) * 4;
      px[o]     = Math.round(BG[0] * (1 - h) + MINT[0] * h);   // R
      px[o + 1] = Math.round(BG[1] * (1 - h) + MINT[1] * h);   // G
      px[o + 2] = Math.round(BG[2] * (1 - h) + MINT[2] * h);   // B
      px[o + 3] = 255;                                          // ⚠ 전부 불투명
    }
  }
  return px;
}

/* PNG 를 직접 씁니다 — 아이콘 둘 때문에 의존성을 늘리지 않습니다.
 * PNG = 시그니처 + 청크들이고, 청크마다 CRC32 가 붙습니다.
 * 각 줄 앞에는 필터 바이트(0 = 필터 없음)가 하나씩 들어갑니다. */
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 채널당 8비트
  ihdr[9] = 6;    // 색 유형 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = size * 4;
  const raw = Buffer.alloc((row + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (row + 1)] = 0;                        // 필터 없음
    rgba.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', require('zlib').deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** BGRA(위→아래) → ICO 안에 들어가는 DIB 한 덩어리 */
function toDib(px, size) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);                    // biSize
  head.writeInt32LE(size, 4);                   // biWidth
  head.writeInt32LE(size * 2, 8);               // ⚠ biHeight 는 XOR+AND 라 2배
  head.writeUInt16LE(1, 12);                    // biPlanes
  head.writeUInt16LE(32, 14);                   // biBitCount
  head.writeUInt32LE(0, 16);                    // BI_RGB
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {              // ⚠ 아래에서 위로
    px.copy(xor, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  }
  const maskRow = Math.ceil(size / 32) * 4;     // AND 마스크는 32비트 정렬
  const and = Buffer.alloc(maskRow * size);     // 전부 0 = 전부 보임
  head.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([head, xor, and]);
}

const dibs = SIZES.map((s) => ({ size: s, buf: toDib(render(s), s) }));
const dir = Buffer.alloc(6 + 16 * dibs.length);
dir.writeUInt16LE(0, 0);                        // reserved
dir.writeUInt16LE(1, 2);                        // type = icon
dir.writeUInt16LE(dibs.length, 4);
let off = dir.length;
dibs.forEach((d, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(d.size === 256 ? 0 : d.size, e);
  dir.writeUInt8(d.size === 256 ? 0 : d.size, e + 1);
  dir.writeUInt8(0, e + 2);                     // 팔레트 없음
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4);                  // planes
  dir.writeUInt16LE(32, e + 6);                 // bpp
  dir.writeUInt32LE(d.buf.length, e + 8);
  dir.writeUInt32LE(off, e + 12);
  off += d.buf.length;
});
fs.writeFileSync(OUT, Buffer.concat([dir, ...dibs.map((d) => d.buf)]));
console.log('만들었습니다: ' + OUT + '  (' +
  SIZES.join('/') + 'px · ' + fs.statSync(OUT).size + '바이트)');

/* 홈 화면용 PNG */
for (const s of TOUCH_SIZES) {
  const p = path.join(__dirname, '..', 'public',
    s === 180 ? 'apple-touch-icon.png' : ('icon-' + s + '.png'));
  fs.writeFileSync(p, toPng(renderFlatRGBA(s), s));
  console.log('만들었습니다: ' + p + '  (' + s + 'px · ' + fs.statSync(p).size + '바이트)');
}

/* --preview: 눈으로 확인할 수 있게 48px 를 BMP 로도 씁니다
   (ffmpeg 등으로 PNG 로 바꿔 보면 됩니다) */
if (process.argv.includes('--preview')) {
  const s = 48, px = render(s);
  const row = s * 4, body = Buffer.alloc(row * s);
  for (let y = 0; y < s; y++) px.copy(body, (s - 1 - y) * row, y * row, (y + 1) * row);
  const fh = Buffer.alloc(14), ih = Buffer.alloc(40);
  fh.write('BM', 0); fh.writeUInt32LE(54 + body.length, 2); fh.writeUInt32LE(54, 10);
  ih.writeUInt32LE(40, 0); ih.writeInt32LE(s, 4); ih.writeInt32LE(s, 8);
  ih.writeUInt16LE(1, 12); ih.writeUInt16LE(32, 14);
  const p = path.join(__dirname, '..', 'public', '_favicon_preview.bmp');
  fs.writeFileSync(p, Buffer.concat([fh, ih, body]));
  console.log('확인용: ' + p + '  (확인 뒤 지우세요)');
}
