const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../web-ui/tools/common');
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>광고 차단 브라우저 회귀 검증</title><style>body{font:18px system-ui;margin:32px}#controls{position:fixed;top:0;left:0;z-index:2147483647;background:white;padding:12px}button{padding:10px}main{margin-top:100px}.adsbox{display:none!important}ins{display:block;width:320px;height:90px;background:#cdf}</style><div id="controls"><button id="pending">재시도 중</button><button id="blocked">차단 유지</button><button id="recovered">정상화</button><output id="state">차단 + 숨겨진 filled 광고</output></div><main><h1>도구 테스트 화면</h1><button id="work">배경 작업</button><output id="work-count">0</output><ins class="adsbygoogle" data-ad-status="filled" style="display:none" id="hidden-ad"></ins><ins class="adsbygoogle" id="visible-ad"></ins></main><script type="module">
import {installGlobals} from '/common/site-modal.js';
import {pageShowsAdCreative} from '/common/adsense.js';
installGlobals();
let state={scriptLoaded:false,scriptUnavailable:true,filledCount:1,unfilledCount:0,pendingInsCount:1};
window.__itmatzipGetAdSenseGuardSnapshot=()=>state;
window.__itmatzipPageShowsAdCreative=pageShowsAdCreative;
let n=0; document.querySelector('#work').onclick=()=>document.querySelector('#work-count').textContent=++n;
const change=(name)=>{state.scriptLoaded=name==='recovered';state.scriptUnavailable=name==='blocked';document.querySelector('#visible-ad').setAttribute('data-ad-status',name==='recovered'?'filled':'');document.querySelector('#state').textContent=name;document.dispatchEvent(new CustomEvent('itz:adsense-script-state'));};
for(const name of ['pending','blocked','recovered'])document.getElementById(name).onclick=()=>change(name);
const script=document.createElement('script');script.src='/common/site-guard.js';document.head.append(script);
</script></html>`;
http.createServer((req,res)=>{
const url=new URL(req.url,'http://localhost');
if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;}
const file=path.resolve(root,'.'+url.pathname.replace(/^\/common/,''));
if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(file));
}).listen(4187,'127.0.0.1',()=>console.log('Browser regression fixture: http://127.0.0.1:4187/?_sg_full=1'));
