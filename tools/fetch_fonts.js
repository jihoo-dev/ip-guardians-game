#!/usr/bin/env node
/* ===========================================================================
 * 로컬 폰트 번들러
 * ---------------------------------------------------------------------------
 * Google Fonts 에서 "이 게임이 실제로 화면에 쓰는 글자"에 해당하는 서브셋만
 * 골라 내려받고, public/vendor/fonts.css 를 만듭니다.
 *
 * ★ 왜 필요한가
 *   사내망에서 fonts.googleapis.com 이 막히면 글꼴이 안 오는 정도가 아닙니다.
 *   응답이 거부(RST)가 아니라 그냥 안 오는 방식으로 막히면
 *   <link rel="stylesheet"> 가 렌더 차단 자원이라 첫 화면이 수십 초 동안
 *   비어 있게 됩니다. 외부 의존을 아예 없애는 편이 확실합니다.
 *
 * ★ 왜 전부 받지 않는가
 *   Noto Sans KR 은 한글 때문에 가중치당 124개 서브셋으로 쪼개져 있습니다
 *   (전체 @font-face 508개). 전부 받으면 관리가 안 됩니다.
 *   이 게임이 쓰는 글자는 한글 656자뿐이라 서브셋 34개면 덮입니다.
 *
 * ★ 그래서 생기는 한계
 *   플레이어가 이름에 아주 드문 음절을 쓰면 그 글자만 시스템 글꼴(맑은 고딕
 *   등)로 나옵니다. fallback 스택이 받아 주므로 깨지지는 않습니다.
 *   UI 문구를 크게 바꿨다면 이 스크립트를 다시 돌리세요.
 *
 * 사용법
 *   node tools/fetch_fonts.js
 *   node tools/fetch_fonts.js --dry     (내려받지 않고 규모만)
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const GF_URL = 'https://fonts.googleapis.com/css2' +
  '?family=Chakra+Petch:wght@500;600;700' +
  '&family=Noto+Sans+KR:wght@400;500;700;900' +
  '&display=swap';
/* woff2 를 받으려면 최신 브라우저인 척해야 합니다. 기본 UA 로 부르면
 * Google 이 ttf 를 내려줍니다(용량 3~4배).                              */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ROOT = path.join(__dirname, '..');
const OUTDIR = path.join(ROOT, 'public', 'vendor', 'fonts');
const CSSOUT = path.join(ROOT, 'public', 'vendor', 'fonts.css');
const DRY = process.argv.includes('--dry');

const fetch = (url, headers) => new Promise((res, rej) => {
  https.get(url, { headers: headers || {} }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      return fetch(r.headers.location, headers).then(res, rej);
    }
    if (r.statusCode !== 200) return rej(new Error(r.statusCode + ' ' + url));
    const bufs = []; r.on('data', (d) => bufs.push(d)); r.on('end', () => res(Buffer.concat(bufs)));
  }).on('error', rej);
});

/* ── 화면에 나올 수 있는 글자 모으기 ──────────────────────────────────
 * 주석은 렌더되지 않으므로 반드시 빼야 합니다. 이 저장소는 주석이 많아서
 * 파일 전체를 세면 쓰지도 않을 서브셋이 잔뜩 끌려옵니다(실측: 976KB →
 * 709KB 차이).                                                        */
function stripJsComments(s) {
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

function collectChars() {
  const chars = new Set();
  const add = (s) => { for (const ch of s) chars.add(ch.codePointAt(0)); };

  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const scripts = [];
  html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m, b) => { scripts.push(b); return ''; });
  add(html.replace(/<!--[\s\S]*?-->/g, ''));
  for (const sc of scripts) {
    const lits = stripJsComments(sc).match(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g) || [];
    for (const l of lits) add(l);
  }
  /* 층 이름·토스트 문구는 서버가 내려보냅니다 — 이것도 화면에 나옵니다 */
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const slits = stripJsComments(srv).match(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g) || [];
  for (const l of slits) add(l);
  return chars;
}

function parseFaces(css) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const b = m[1];
    const fam = (b.match(/font-family:\s*'([^']+)'/) || [])[1];
    const url = (b.match(/url\((https:\/\/[^)]+)\)/) || [])[1];
    if (!fam || !url) continue;
    const ur = (b.match(/unicode-range:\s*([^;]+);/) || [])[1];
    const ranges = (ur || 'U+0-10FFFF').split(',').map((r) => {
      const t = r.trim().replace(/^U\+/i, '');
      if (t.includes('-')) { const [a, z] = t.split('-'); return [parseInt(a, 16), parseInt(z, 16)]; }
      if (t.includes('?')) return [parseInt(t.replace(/\?/g, '0'), 16), parseInt(t.replace(/\?/g, 'F'), 16)];
      return [parseInt(t, 16), parseInt(t, 16)];
    });
    out.push({
      fam, url, ranges,
      wt: (b.match(/font-weight:\s*(\d+)/) || [])[1] || '400',
      style: (b.match(/font-style:\s*(\w+)/) || [])[1] || 'normal',
      unicodeRange: ur
    });
  }
  return out;
}

/* 파일명은 패밀리+가중치+원본 조각으로. 파일만 봐도 뭔지 알아야 관리가 됩니다. */
const nameOf = (f) => {
  const m = f.url.match(/\/s\/([^/]+)\/[^/]+\/([^/]+)$/);
  return (m ? m[1] : 'font') + '-' + f.wt + '-' + (m ? m[2] : path.basename(f.url));
};

(async () => {
  const chars = collectChars();
  const kr = [...chars].filter((c) => (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x3130 && c <= 0x318F)).length;
  console.log('화면에 나올 수 있는 고유 문자 ' + chars.size + '자 (한글 ' + kr + '자)');

  const css = (await fetch(GF_URL, { 'User-Agent': UA })).toString('utf8');
  const faces = parseFaces(css);
  const needed = faces.filter((f) => {
    for (const c of chars) for (const [a, z] of f.ranges) if (c >= a && c <= z) return true;
    return false;
  });
  const uniq = [...new Set(needed.map((f) => f.url))];
  console.log('@font-face ' + faces.length + '개 → 필요 ' + needed.length + '개 (고유 woff2 ' + uniq.length + '개)');
  if (DRY) { console.log('--dry 라 내려받지 않았습니다.'); return; }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const fileOf = new Map();
  let bytes = 0;
  for (const f of needed) {
    if (!fileOf.has(f.url)) {
      const fn = nameOf(f);
      const buf = await fetch(f.url);
      fs.writeFileSync(path.join(OUTDIR, fn), buf);
      fileOf.set(f.url, fn);
      bytes += buf.length;
    }
    f.file = fileOf.get(f.url);
  }

  const head = [
    '/* 로컬 폰트 — tools/fetch_fonts.js 가 만듭니다. 직접 고치지 마세요.',
    ' *',
    ' * 사내망에서 fonts.googleapis.com 이 막히면 글꼴이 안 오는 정도가 아니라,',
    ' * 응답이 아예 안 오는 방식이면 <link rel=stylesheet> 가 렌더 차단 자원이라',
    ' * 첫 화면이 수십 초 비어 있게 됩니다. 그래서 외부 의존을 없앴습니다.',
    ' *',
    ' * 서브셋은 이 게임이 실제로 쓰는 글자(한글 ' + kr + '자)만 받았습니다.',
    ' * 플레이어가 이름에 아주 드문 음절을 쓰면 그 글자만 시스템 글꼴로 나옵니다',
    ' * — fallback 스택이 받아 주므로 깨지지는 않습니다.',
    ' * UI 문구를 크게 바꿨다면 tools/fetch_fonts.js 를 다시 돌리세요.',
    ' */',
    ''
  ];
  const rules = needed.map((f) =>
    "@font-face{font-family:'" + f.fam + "';font-style:" + f.style +
    ';font-weight:' + f.wt + ';font-display:swap;' +
    /* ?v= 를 붙여야 서버가 1년 캐시로 내려줍니다(server.js 정적 미들웨어).
     * 파일명에 Google 의 콘텐츠 해시가 들어 있어 내용이 바뀌면 이름이 바뀝니다. */
    "src:url(fonts/" + f.file + "?v=1) format('woff2');" +
    (f.unicodeRange ? 'unicode-range:' + f.unicodeRange.trim() + ';' : '') + '}');
  fs.writeFileSync(CSSOUT, head.concat(rules).join('\n') + '\n');

  console.log('woff2 ' + fileOf.size + '개 · ' + (bytes / 1024).toFixed(0) + ' KB → public/vendor/fonts/');
  console.log('CSS  ' + rules.length + '규칙 → public/vendor/fonts.css');
})().catch((e) => { console.error(e.message); process.exit(1); });
