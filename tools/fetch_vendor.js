#!/usr/bin/env node
/* ===========================================================================
 * three.js 및 로더 로컬 번들러
 * ---------------------------------------------------------------------------
 * ★ 왜 CDN 을 쓰지 않는가
 *   사내망에서 cdnjs / jsdelivr 이 막히면 three.min.js 가 안 옵니다.
 *   그러면 글꼴이 이상해지는 정도가 아니라 게임이 아예 뜨지 않습니다
 *   (THREE 가 없으면 스크립트 전체가 첫 줄에서 죽습니다).
 *   자체 서버에서 내려주면 이 실패 모드 자체가 사라집니다.
 *
 * ★ Draco 디코더는 받지 않습니다
 *   DRACOLoader.js(13KB)는 방어적으로 두지만, 실제 디코더는 1.05MB 입니다.
 *   지금 쓰는 두 모델 다 extensionsRequired 가 비어 있어(Draco 아님)
 *   한 번도 내려받히지 않습니다. Draco 모델을 쓰게 되면 그때
 *   `node tools/fetch_vendor.js --draco` 로 받으세요.
 *
 * 사용법
 *   node tools/fetch_vendor.js            (three.js + 로더 3종)
 *   node tools/fetch_vendor.js --draco    (Draco 디코더까지)
 *
 * ★ 버전을 올릴 때는 아래 THREE_VER 과 index.html 의 <script src> 에 붙은
 *   ?v= 를 함께 바꾸세요. 안 바꾸면 이미 받은 브라우저가 옛 파일을 씁니다.
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const THREE_VER = 'r128';
const NPM_VER = '0.128.0';

const FILES = [
  ['three.min.js',     'https://cdnjs.cloudflare.com/ajax/libs/three.js/' + THREE_VER + '/three.min.js'],
  ['GLTFLoader.js',    'https://cdn.jsdelivr.net/npm/three@' + NPM_VER + '/examples/js/loaders/GLTFLoader.js'],
  ['DRACOLoader.js',   'https://cdn.jsdelivr.net/npm/three@' + NPM_VER + '/examples/js/loaders/DRACOLoader.js'],
  ['SkeletonUtils.js', 'https://cdn.jsdelivr.net/npm/three@' + NPM_VER + '/examples/js/utils/SkeletonUtils.js']
];
const DRACO = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']
  .map((f) => ['draco/' + f, 'https://cdn.jsdelivr.net/npm/three@' + NPM_VER + '/examples/js/libs/draco/' + f]);

const OUT = path.join(__dirname, '..', 'public', 'vendor');

const fetch = (url) => new Promise((res, rej) => {
  https.get(url, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return fetch(r.headers.location).then(res, rej);
    if (r.statusCode !== 200) return rej(new Error(r.statusCode + ' ' + url));
    const b = []; r.on('data', (d) => b.push(d)); r.on('end', () => res(Buffer.concat(b)));
  }).on('error', rej);
});

(async () => {
  const list = process.argv.includes('--draco') ? FILES.concat(DRACO) : FILES;
  let total = 0;
  for (const [name, url] of list) {
    const dest = path.join(OUT, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = await fetch(url);
    fs.writeFileSync(dest, buf);
    total += buf.length;
    console.log('  ' + name.padEnd(24) + (buf.length / 1024).toFixed(0).padStart(6) + ' KB');
  }
  console.log('\n합계 ' + (total / 1024).toFixed(0) + ' KB → public/vendor/  (three.js ' + THREE_VER + ')');
})().catch((e) => { console.error(e.message); process.exit(1); });
