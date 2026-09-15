#!/usr/bin/env node
/* ===========================================================================
 * GLB 텍스처 축소기
 * ---------------------------------------------------------------------------
 * 형상은 건드리지 않고 텍스처 해상도만 낮춥니다.
 * 삼각형 수·스킨·애니메이션·머티리얼 이름이 전부 그대로이므로,
 * 게임 코드(클립 이름 매칭, 좌석 색 칠하기, 자동 키 보정)가 영향을 받지
 * 않습니다.
 *
 * ★ 왜 이런 도구가 필요한가
 *   character.glb 는 7.45MB 였는데 그중 72%가 텍스처였습니다(이미지 20장
 *   5.33MB, 삼각형은 37,237개뿐). 무거운 것이 형상이 아니라 텍스처라
 *   Draco 압축은 소용이 없고, 내용물이 이미 PNG 라 gzip 도 14%뿐입니다.
 *   특히 몸통 노멀맵 한 장이 2048²·2.7MB 로 텍스처 용량의 52% 였는데,
 *   옷에 거의 다 가려지는 맵입니다.
 *
 *   그리고 게임 카메라(FOV 58°, 기본 추적 거리 33.9)에서 캐릭터는 화면에
 *   65px, 얼굴은 17px 입니다. 65px 짜리에 2048² 는 화면 해상도의 31배입니다.
 *
 * 사용법
 *   node tools/shrink_glb.js <입력.glb> <출력.glb> [프리셋]
 *   node tools/shrink_glb.js <입력.glb> --info          (분석만)
 *
 *   프리셋 safe   = 노멀 512 · 베이스 1024 · 얼굴 원본
 *          normal = 노멀 256 · 베이스 512  · 얼굴 원본   ← 현재 적용된 값
 *          small  = 노멀 128 · 베이스 512  · 얼굴 512
 *
 * 필요 패키지: pngjs (devDependency)
 * ========================================================================= */
'use strict';

const fs = require('fs');

let PNG;
try { PNG = require('pngjs').PNG; } catch (e) {
  console.error('pngjs 가 없습니다. `npm install` 로 devDependencies 를 받으세요.');
  console.error('(운영 배포에는 필요 없습니다 — 이 도구 전용입니다)');
  process.exit(1);
}

/* ------------------------------------------------------------------ GLB 파싱 */

function parseGlb(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.readUInt32LE(0) !== 0x46546C67) throw new Error('GLB 가 아닙니다: ' + file);
  const total = b.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total && off + 8 <= b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    const data = b.slice(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004E4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('JSON 청크가 없습니다');
  return { json, bin: bin || Buffer.alloc(0), bytes: b.length };
}

/* PNG/JPEG 헤더에서 해상도만 읽습니다 (디코딩 없이) */
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { fmt: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { fmt: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { fmt: 'jpeg', w: 0, h: 0 };
  }
  return { fmt: '?', w: 0, h: 0 };
}

function imageBuffer(g, img) {
  if (img.bufferView === undefined) return null;
  const bv = g.json.bufferViews[img.bufferView];
  const start = bv.byteOffset || 0;
  return g.bin.slice(start, start + bv.byteLength);
}

/* 이미지가 어느 머티리얼 슬롯에 쓰이는지. 슬롯마다 줄여도 되는 정도가
 * 다르기 때문에 이걸 알아야 합니다 — 노멀맵은 과감하게, 얼굴은 조심스럽게. */
function slotMap(J) {
  const slots = {}, faceish = {};
  const mark = (ti, slot, matName) => {
    if (ti === undefined || !J.textures || !J.textures[ti]) return;
    const src = J.textures[ti].source;
    (slots[src] = slots[src] || new Set()).add(slot);
    /* 이 캐릭터가 '싸 보이게' 되는 지점은 몸통이 아니라 눈·눈썹·아이라인
     * 입니다. 그래서 얼굴 계열은 따로 표시해 두고 기본적으로 건드리지
     * 않습니다.                                                          */
    if (/face|eye|brow|mouth|eyelin/i.test(matName || '')) faceish[src] = true;
  };
  for (const m of J.materials || []) {
    const p = m.pbrMetallicRoughness || {};
    mark(p.baseColorTexture && p.baseColorTexture.index, 'baseColor', m.name);
    mark(p.metallicRoughnessTexture && p.metallicRoughnessTexture.index, 'metalRough', m.name);
    mark(m.normalTexture && m.normalTexture.index, 'normal', m.name);
    mark(m.emissiveTexture && m.emissiveTexture.index, 'emissive', m.name);
    mark(m.occlusionTexture && m.occlusionTexture.index, 'occlusion', m.name);
  }
  return { slots, faceish };
}

/* ------------------------------------------------------------------ 축소 */

const PRESETS = {
  safe:   { baseColor: 1024, normal: 512, emissive: 256, metalRough: 256, occlusion: 256, face: 99999 },
  normal: { baseColor: 512,  normal: 256, emissive: 128, metalRough: 128, occlusion: 128, face: 99999 },
  small:  { baseColor: 512,  normal: 128, emissive: 128, metalRough: 128, occlusion: 128, face: 512   }
};

/* 박스 필터.
 * ★ 알파를 미리 곱해서 평균을 냅니다. 안 그러면 투명 픽셀의 RGB(보통 검정)가
 *   가장자리로 번져 머리카락·눈 테두리에 검은 띠가 생깁니다.            */
function downscale(png, tw, th) {
  const out = new PNG({ width: tw, height: th });
  const sx = png.width / tw, sy = png.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(png.height, Math.ceil((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(png.width, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, aw = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * png.width + xx) * 4;
          const al = png.data[i + 3] / 255;
          r += png.data[i] * al; g += png.data[i + 1] * al; b += png.data[i + 2] * al;
          a += png.data[i + 3]; aw += al; n++;
        }
      }
      const o = (y * tw + x) * 4;
      out.data[o]     = aw > 0 ? Math.round(r / aw) : 0;
      out.data[o + 1] = aw > 0 ? Math.round(g / aw) : 0;
      out.data[o + 2] = aw > 0 ? Math.round(b / aw) : 0;
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 실행 */

const [,, IN, OUT, PRESET = 'normal'] = process.argv;
if (!IN) {
  console.error('사용법: node tools/shrink_glb.js <입력.glb> <출력.glb> [safe|normal|small]');
  console.error('        node tools/shrink_glb.js <입력.glb> --info');
  process.exit(1);
}

const g = parseGlb(IN);
const J = g.json;
const { slots, faceish } = slotMap(J);
const INFO_ONLY = OUT === '--info' || !OUT;

if (!INFO_ONLY && !PRESETS[PRESET]) {
  console.error('프리셋: ' + Object.keys(PRESETS).join(' / '));
  process.exit(1);
}
const CAP = PRESETS[PRESET];

const newBytes = {};
const report = [];

for (let i = 0; i < (J.images || []).length; i++) {
  const buf = imageBuffer(g, J.images[i]);
  if (!buf) continue;
  const sz = imageSize(buf);
  const sl = [...(slots[i] || ['baseColor'])];
  const row = { i, slots: sl.join('+'), from: sz.w + 'x' + sz.h, to: '그대로',
                kb0: Math.round(buf.length / 1024), kb1: Math.round(buf.length / 1024),
                face: !!faceish[i] };

  if (INFO_ONLY) { report.push(row); continue; }

  let cap = Math.max(...sl.map((s) => CAP[s] || CAP.baseColor));
  if (faceish[i] && sl.includes('baseColor')) cap = Math.max(cap, CAP.face);

  if (sz.fmt === 'png' && sz.w > 0 && Math.max(sz.w, sz.h) > cap) {
    const k = cap / Math.max(sz.w, sz.h);
    const tw = Math.max(4, Math.round(sz.w * k)), th = Math.max(4, Math.round(sz.h * k));
    const dst = downscale(PNG.sync.read(buf), tw, th);
    /* 노멀·metalRough·occlusion 은 알파가 의미 없으니 버려 더 줄입니다 */
    const dropAlpha = sl.every((s) => s === 'normal' || s === 'metalRough' || s === 'occlusion');
    const enc = PNG.sync.write(dst, { colorType: dropAlpha ? 2 : 6, deflateLevel: 9 });
    newBytes[i] = enc;
    row.to = tw + 'x' + th;
    row.kb1 = Math.round(enc.length / 1024);
  }
  report.push(row);
}

if (!INFO_ONLY) {
  /* BIN 재구성 — 모든 bufferView 를 순서대로 다시 깔며 byteOffset 만 새로
   * 씁니다. accessor 는 bufferView 안의 상대 offset 을 쓰므로 그대로
   * 유효합니다. byteStride 가 있는 뷰 때문에 4바이트 정렬은 필수입니다. */
  const imgView = {};
  for (let i = 0; i < (J.images || []).length; i++) {
    const bv = J.images[i].bufferView;
    if (bv !== undefined && newBytes[i]) imgView[bv] = i;
  }
  const chunks = [];
  let pos = 0;
  for (let v = 0; v < J.bufferViews.length; v++) {
    const bv = J.bufferViews[v];
    const data = imgView[v] !== undefined ? newBytes[imgView[v]]
      : g.bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const pad = (4 - (pos % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); pos += pad; }
    bv.byteOffset = pos;
    bv.byteLength = data.length;
    chunks.push(data);
    pos += data.length;
  }
  const tail = (4 - (pos % 4)) % 4;
  if (tail) { chunks.push(Buffer.alloc(tail)); pos += tail; }
  const bin = Buffer.concat(chunks, pos);
  J.buffers[0].byteLength = bin.length;
  delete J.buffers[0].uri;

  let js = Buffer.from(JSON.stringify(J), 'utf8');
  const jp = (4 - (js.length % 4)) % 4;
  if (jp) js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);   // JSON 패딩은 공백

  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  fs.writeFileSync(OUT, Buffer.concat([head, jh, js, bh, bin]));
}

/* ------------------------------------------------------------------ 보고 */

report.sort((a, b) => b.kb0 - a.kb0);
console.log(IN + (INFO_ONLY ? '  (분석만)' : '  →  ' + OUT + '  [' + PRESET + ']'));
console.log('이미지 ' + (J.images || []).length + '개 · 텍스처 ' + (J.textures || []).length +
            '개 · 머티리얼 ' + (J.materials || []).length + '개\n');
console.log('  # ' + '슬롯'.padEnd(12) + (INFO_ONLY ? '해상도'.padEnd(12) + '용량'
                                                    : '해상도'.padEnd(24) + '용량'));
for (const r of report) {
  const tag = r.face ? ' (얼굴)' : '';
  console.log(String(r.i).padStart(3) + ' ' + (r.slots + tag).padEnd(12) +
    (INFO_ONLY ? r.from.padEnd(12) + (r.kb0 + 'KB').padStart(8)
               : (r.from + ' → ' + r.to).padEnd(24) + (r.kb0 + 'KB → ' + r.kb1 + 'KB').padStart(18)));
}
if (!INFO_ONLY) {
  const a = fs.statSync(IN).size, b = fs.statSync(OUT).size;
  console.log('\n' + (a / 1048576).toFixed(2) + ' MB → ' + (b / 1048576).toFixed(2) + ' MB  (' +
              Math.round((1 - b / a) * 100) + '% 감소)');
  console.log('삼각형·스킨·애니메이션은 손대지 않았습니다.');
  console.log('\n★ public/assets/ 에 넣었다면 index.html 의 ASSET_VER 을 반드시 올리세요.');
}
