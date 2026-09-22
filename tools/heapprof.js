/* ===========================================================================
 * 프레임당 힙 할당 측정 — 크롬 샘플링 힙 프로파일러(CDP)
 * ---------------------------------------------------------------------------
 * 쓰는 법:  node tools/heapprof.js <포트> [초]
 *   예)     PORT=3400 npm start   후   node tools/heapprof.js 3400 20
 *   봇으로 방을 채워 두면(tools/testbots.js) 실제 라운드에서 잽니다.
 *   ⚠ 대기 시간 안에 들어가야 주자로 잽니다 — LOBBY_STALL_MS 를 넉넉히 주세요.
 *
 * ★ 왜 별도 도구인가 — <b>performance.memory 로는 할당량을 못 잽니다.</b>
 *   그 값은 "지금 힙이 얼마나 차 있나" 이지 "얼마나 할당했나" 가 아닙니다.
 *   GC 가 톱니처럼 깎으므로 정상 상태에서는 순증가가 0 에 수렴합니다
 *   (실측: 주자 20초에 −0.63MB). 2026-09-21 에 이것으로 재다가
 *   <b>실제의 313배</b>(159,724B vs 510B)로 오판했습니다 — 짧은 창을 여러 번
 *   재고 <b>음수 창(=GC 가 돈 창)을 버린 것</b>이 원인입니다. 그러면 톱니의
 *   봉우리만 골라내는 편향된 추정이 됩니다.
 *
 * ★ 그래서 이 도구는 <b>총 할당</b>을 세는 계기(HeapProfiler.startSampling)를
 *   쓰고, <b>귀무 대조를 먼저 통과해야</b> 본 측정으로 넘어갑니다.
 *
 * ⚠ 이 계기는 <b>형식배열·ArrayBuffer 를 못 봅니다</b> — 백업 저장소가 V8 힙
 *   밖이기 때문입니다(실측: 18.75MB 할당을 0.06MB 로 보고). 그래서 귀무
 *   대조를 형식배열로 짜면 <b>계기가 고장난 것처럼 보입니다</b>. 대조는 일반
 *   배열로 합니다 — new Array(n).fill(i) 는 포인터 압축으로 요소당 4바이트라
 *   기대값이 명확하고, 실측 정확도 100% 였습니다.
 *
 * ⚠ 확장이 없는 <b>새 프로필</b>로 크롬을 띄웁니다. 자동화 확장이 페이지에
 *   주입하는 코드가 숫자를 부풀리지 않는지 같이 가르기 위해서입니다
 *   (실측 결과 확장 유무와 무관했습니다).
 *
 * 2026-09-22 실측: 주자 0.51 KB/프레임 · 관전자 0.15 KB/프레임.
 * ======================================================================== */
const { spawn }=require('child_process');
const fs=require('fs'), os=require('os'), path=require('path');
const WebSocket=require('C:/jihoo/fast-track/ip-guardians-game/node_modules/ws');
const PORT=process.argv[2]||'3400', SEC=parseInt(process.argv[3]||'20',10), DPORT=9335;
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE=path.join(os.tmpdir(),'ipg_final_'+process.pid);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const http=async(p)=>(await fetch('http://127.0.0.1:'+DPORT+p)).json();
let id=0;
function rpc(ws,m,p){return new Promise((res,rej)=>{const i=++id;
  const on=(raw)=>{let x;try{x=JSON.parse(raw)}catch(e){return}
    if(x.id===i){ws.off('message',on);x.error?rej(new Error(m+': '+x.error.message)):res(x.result);}};
  ws.on('message',on); ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});}
const sum=(prof)=>{let s=0;(function w(n){s+=n.selfSize||0;(n.children||[]).forEach(w)})(prof.head);return s;};
const MB=(b)=>(b/1048576).toFixed(2);

(async()=>{
  fs.mkdirSync(PROFILE,{recursive:true});
  const chrome=spawn(CHROME,['--remote-debugging-port='+DPORT,'--user-data-dir='+PROFILE,
    '--no-first-run','--no-default-browser-check','--disable-renderer-backgrounding',
    '--window-size=1280,800','http://localhost:'+PORT+'/?fs=0'],{stdio:'ignore'});
  let t=null;
  for(let i=0;i<40&&!t;i++){await sleep(500);
    try{t=(await http('/json')).find(x=>x.type==='page'&&x.url.includes('localhost:'+PORT))}catch(e){}}
  if(!t){console.log('타깃 없음');chrome.kill();process.exit(1);}
  const ws=new WebSocket(t.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:512*1024*1024});
  await new Promise(r=>ws.on('open',r));
  await rpc(ws,'Runtime.enable'); await rpc(ws,'HeapProfiler.enable');
  const ev=async(e,a)=>(await rpc(ws,'Runtime.evaluate',{expression:e,awaitPromise:!!a,returnByValue:true})).result.value;
  await sleep(2500);

  /* ① 귀무 대조 — 일반 배열(PACKED_SMI). 포인터 압축으로 요소당 4바이트입니다.
   *    ⚠ Float64Array 로 재면 안 됩니다 — 형식배열 백업스토어는 V8 힙 <b>밖</b>이라
   *      샘플러가 아예 못 봅니다(실측: 18.75MB 를 0.06MB 로 보고). */
  const N=400, LEN=13000, expect=N*LEN*4;
  await rpc(ws,"HeapProfiler.startSampling",{samplingInterval:4096});
  await ev(`(async()=>{window.__k=[];for(let i=0;i<${N};i++){window.__k.push(new Array(${LEN}).fill(i));
    if(i%50===0)await new Promise(r=>setTimeout(r,0));}return 1})()`,true);
  await sleep(400);
  const got=sum((await rpc(ws,"HeapProfiler.stopSampling")).profile);
  await ev("window.__k=null,1");
  const ratio=got/expect;
  console.log("① 귀무 대조 — 일반배열 "+N+"×"+LEN+" = 기대 "+MB(expect)+" MB");
  console.log("   샘플러 측정 "+MB(got)+" MB  → 정확도 "+(ratio*100).toFixed(0)+"%  "+
    (ratio>0.75&&ratio<1.3?"✅ 계기 정상":"❌ 계기 못 믿음"));
  if(!(ratio>0.75&&ratio<1.3)){ws.close();chrome.kill();process.exit(1);}

  /* ② 실제 플레이 */
  await ev(`(()=>{const n=document.querySelector('#joinName');
    if(n){n.value='프로파일';n.dispatchEvent(new Event('input',{bubbles:true}));}
    document.querySelector('#btnJoin').click();return 1})()`);
  await ev(`(async()=>{const t0=Date.now();
    while(document.body.classList.contains('lobby')&&Date.now()-t0<60000)await new Promise(r=>setTimeout(r,400));
    await new Promise(r=>setTimeout(r,4000));return 1})()`,true);
  const role=await ev(`document.body.className||'(주자)'`);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true})),1`);
  await sleep(1500);

  await rpc(ws,'HeapProfiler.startSampling',{samplingInterval:2048});
  const mem0=await ev('performance.memory.usedJSHeapSize');
  const f0=await ev(`(()=>{window.__fc=0;const l=()=>{window.__fc++;requestAnimationFrame(l)};requestAnimationFrame(l);return 0})()`);
  await sleep(SEC*1000);
  const frames=await ev('window.__fc');
  const mem1=await ev('performance.memory.usedJSHeapSize');
  const prof=(await rpc(ws,'HeapProfiler.stopSampling')).profile;
  const tot=sum(prof);
  await ev(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w',bubbles:true})),1`);

  console.log('\n② 실제 플레이 '+SEC+'초 ('+role+') — 프레임 '+frames+'개');
  console.log('   ┌ 힙 샘플러(할당 총량)    : '+MB(tot)+' MB → 초당 '+(tot/SEC/1024).toFixed(0)+' KB'+
    ' → <b>프레임당 '+(tot/frames/1024).toFixed(2)+' KB</b>');
  console.log('   └ performance.memory 차이 : '+MB(mem1-mem0)+' MB → 프레임당 '+((mem1-mem0)/frames/1024).toFixed(2)+' KB (참고용 · 아래 설명)');

  const agg=new Map();
  (function w(n){const f=n.callFrame||{};
    if(n.selfSize>0){const k=(f.functionName||'(익명)')+' @ '+((f.url||'').replace(/^.*\//,''))+':'+((f.lineNumber|0)+1);
      agg.set(k,(agg.get(k)||0)+n.selfSize);}
    (n.children||[]).forEach(w)})(prof.head);
  console.log('\n   할당처 상위 10 (총 '+MB(tot)+' MB 기준)');
  for(const [k,v] of [...agg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10))
    console.log('     '+k.slice(0,48).padEnd(50)+(v/1024).toFixed(0).padStart(8)+' KB  '+(v/tot*100).toFixed(1)+'%');

  ws.close(); chrome.kill(); await sleep(700);
  try{fs.rmSync(PROFILE,{recursive:true,force:true})}catch(e){}
  process.exit(0);
})().catch(e=>{console.error('오류:',e.message);process.exit(1)});
