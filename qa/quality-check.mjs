import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import WebSocket,{WebSocketServer} from 'ws';
import {createGateway} from '../src/gateway.mjs';
import {createDialer} from '../src/index.mjs';
import SkidoxyTransport from '../public/transport.mjs';
import {T,frame,json,parse} from '../public/protocol.mjs';
globalThis.WebSocket=WebSocket;
const token='qa-only-token-not-for-production-123456789';
const origin='http://localhost:18080';const results=[],logs=[],dials=[];
async function check(name,fn){const start=performance.now();try{const details=await fn();results.push({name,status:'PASS',ms:Math.round(performance.now()-start),details});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',ms:Math.round(performance.now()-start),error:e.stack});console.error('FAIL',name,e.message);if(name.includes('legacy')){console.log('LEGACY BODY',await page.frameLocator('iframe').locator('body').innerText().catch(()=>''));await writeFile('qa/legacy-error.html',await page.frameLocator('iframe').locator('html').innerHTML().catch(()=>''));}}}
const fixture=http.createServer((req,res)=>{
 if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(`
 document.querySelector('#script').textContent='script works';
 document.querySelector('#cookie').textContent=document.cookie;
 fetch('/empty').then(async r=>document.querySelector('#empty').textContent=r.status+':'+(await r.text()).length);
 fetch('/page',{method:'HEAD'}).then(async r=>document.querySelector('#head').textContent=r.status+':'+(await r.text()).length);
 fetch('/json').then(r=>r.json()).then(j=>document.querySelector('#fetch').textContent=j.message);
 fetch('/echo',{method:'POST',body:'posted through engine'}).then(r=>r.text()).then(s=>document.querySelector('#post').textContent=s);
 const ws=new WebSocket('ws://fixture.skidoxy.test/socket');
 ws.onopen=()=>ws.send('browser websocket');ws.onmessage=e=>{document.querySelector('#websocket').textContent=e.data;ws.close();};
 `);return;}
 if(req.url==='/empty'){res.writeHead(204).end();return;}
 if(req.url==='/json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:'fetch works'}));return;}
 if(req.url==='/echo'){let body='';req.on('data',c=>body+=c);req.on('end',()=>res.end(body));return;}
 if(req.url==='/redirect'){res.writeHead(302,{Location:'/page'}).end();return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end('h1 { color: rgb(0, 128, 0) }');return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie',['fixtureCookie=works; Path=/','otherCookie=also; Path=/']);
 res.end(`<!doctype html><title>Skidoxy controlled fixture</title><link rel="stylesheet" href="/style.css"><h1>Controlled fixture</h1><p id="script">pending</p><p id="fetch">pending</p><p id="post">pending</p><p id="empty">pending</p><p id="head">pending</p><p id="cookie">pending</p><p id="websocket">pending</p><a href="/redirect">Follow redirect</a><script src="/app.js"></script>`);
});
const fixtureWS=new WebSocketServer({server:fixture});fixtureWS.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
const productionDial=createDialer({torPort:19059,timeout:1000});
const dial=async(host,port)=>{
 dials.push({host,port});
 if(host==='fixture.skidoxy.test'&&port===80){const s=net.createConnection({host:'127.0.0.1',port:fixture.address().port});await once(s,'connect');return s;}
 return productionDial(host,port);
};
const {server,wss}=createGateway({port:18080,origin,token,dial});server.listen(18080,'127.0.0.1');await once(server,'listening');
let browser,context,page,cookie;
try{
 await check('HTTP denies unauthenticated assets',async()=>{for(const p of ['/','/app.js','/transport.mjs','/scram/scramjet.all.js'])assert.equal((await fetch(origin+p)).status,401);});
 await check('HTTP rejects wrong token and cross-origin login',async()=>{
  assert.equal((await fetch(origin+'/session',{method:'POST',headers:{Origin:origin},body:'token=wrong'})).status,401);
  assert.equal((await fetch(origin+'/session',{method:'POST',headers:{Origin:'https://evil.invalid'},body:new URLSearchParams({token})})).status,403);
 });
 browser=await chromium.launch({headless:true});context=await browser.newContext();page=await context.newPage();
 page.on('pageerror',e=>logs.push({type:'pageerror',text:e.message}));page.on('console',m=>{if(['error','warning'].includes(m.type()))logs.push({type:m.type(),text:m.text()});});
 await check('Chromium sign-in, service worker, bare-mux initialization',async()=>{
  await page.goto(origin);await page.getByLabel('Access token').fill(token);
  await Promise.all([page.waitForResponse(r=>r.url()===origin+'/session'),page.getByRole('button',{name:'Sign in'}).click()]);
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Ready'),null,{timeout:20000});
  const cookies=await context.cookies();const session=cookies.find(c=>c.name==='skidoxy');assert(session?.httpOnly);assert.equal(session.sameSite,'Strict');cookie=`skidoxy=${session.value}`;
 });
 await check('Chromium full engine: HTML, JS, CSS, fetch, POST, cookies, WebSocket',async()=>{
  await page.getByLabel('Destination URL').fill('http://fixture.skidoxy.test/page');await page.getByRole('button',{name:'Open'}).click();
  const f=page.frameLocator('iframe');
  await f.getByRole('heading',{name:'Controlled fixture'}).waitFor({timeout:20000});
  for(const [id,text] of [['script','script works'],['fetch','fetch works'],['post','posted through engine'],['websocket','browser websocket'],['empty','204:0'],['head','200:0']]){
   await f.locator('#'+id).filter({hasText:text}).waitFor({timeout:15000});
  }
  assert.match(await f.locator('#cookie').innerText(),/fixtureCookie=works/);
  assert.equal(await f.locator('h1').evaluate(e=>getComputedStyle(e).color),'rgb(0, 128, 0)');
  await page.screenshot({path:'qa/controlled-browser-pass.png',fullPage:true});
 });
 await check('Chromium relative navigation and redirect rewriting',async()=>{
  await page.frameLocator('iframe').getByRole('link',{name:'Follow redirect'}).click();
  await page.frameLocator('iframe').locator('#fetch').filter({hasText:'fetch works'}).waitFor({timeout:15000});
  assert(page.frames().some(f=>f.url().includes('/service/')));
 });
 if(!process.env.QA_OFFLINE) await check('Chromium real external HTTPS through engine',async()=>{
  await page.getByLabel('Destination URL').fill('https://example.com');await page.getByRole('button',{name:'Open'}).click();
  await page.frameLocator('iframe').getByRole('link',{name:'Learn more',exact:false}).waitFor({timeout:20000});
  assert(dials.some(d=>d.host==='example.com'&&d.port===443));
 });
 await check('Chromium legacy Epoxy/Wisp controlled browser path',async()=>{
  const before=dials.filter(d=>d.host==='fixture.skidoxy.test').length;
  await Promise.all([page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('legacy%3D2'),timeout:30000}),page.evaluate(async()=>{const c=new BareMux.BareMuxConnection('/baremux/worker.js');await c.setTransport('/legacy-transport.mjs',[{wisp:'ws://localhost:18080/wisp/'}]);document.querySelector('iframe').src='/service/'+encodeURIComponent('http://fixture.skidoxy.test/page?legacy=2');})]);
  await page.frameLocator('iframe').locator('#fetch').filter({hasText:'fetch works'}).waitFor({timeout:15000});
  await page.frameLocator('iframe').locator('#websocket').filter({hasText:'browser websocket'}).waitFor({timeout:15000});
  assert(dials.filter(d=>d.host==='fixture.skidoxy.test').length>before);
 });
 if(!process.env.QA_OFFLINE) await check('Chromium legacy Epoxy/Wisp external HTTPS',async()=>{
  const before=dials.filter(d=>d.host==='example.com').length;
  await Promise.all([page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('legacy%3D3'),timeout:30000}),page.evaluate(()=>document.querySelector('iframe').src='/service/'+encodeURIComponent('https://example.com/?legacy=3'))]);
  await page.frameLocator('iframe').getByRole('link',{name:'Learn more',exact:false}).waitFor({timeout:20000});
  assert(dials.filter(d=>d.host==='example.com').length>before);
 });
 await check('WebSocket upgrade denies missing auth and wrong Origin',async()=>{
  for(const options of [{origin},{origin:'https://evil.invalid',headers:{Cookie:cookie}}]){
   const code=await new Promise((resolve,reject)=>{const ws=new WebSocket('ws://localhost:18080/hmp/',options);ws.on('unexpected-response',(_,r)=>{r.resume();resolve(r.statusCode);});ws.on('open',()=>{ws.terminate();reject(Error('Unauthorized accepted'));});ws.on('error',()=>{});});assert.equal(code,403);
  }
 });
 await check('HTTP blocks authenticated path traversal',async()=>{
  for(const p of ['/%2e%2e%2fsrc%2fserver.mjs','/scram/%2e%2e%2fpackage.json'])assert.equal((await fetch(origin+p,{headers:{Cookie:cookie}})).status,403);
 });
 const openSocket=async()=>{const ws=new WebSocket('ws://localhost:18080/hmp/',{origin,headers:{Cookie:cookie}});await once(ws,'open');ws.send(json(T.HELLO,0,{version:1}));await once(ws,'message');return ws;};
 await check('HMP malformed frame rejects and gateway survives',async()=>{
  const ws=await openSocket();ws.send(new Uint8Array(3));const [code]=await once(ws,'close');assert.equal(code,1002);assert.equal((await fetch(origin+'/healthz')).status,200);
 });
 await check('HMP private IP and metadata destination blocked',async()=>{
  for(const url of ['http://127.0.0.1/','http://169.254.169.254/','http://[::1]/']){
   const ws=await openSocket();ws.send(json(T.OPEN,1,{url,method:'GET',headers:{}}));ws.send(frame(T.END,1));
   const [raw]=await once(ws,'message');assert.equal(parse(raw).type,T.ERROR);ws.terminate();
  }
 });
 await check('Onion outage fails closed through HMP',async()=>{
  const host='a'.repeat(56)+'.onion';const ws=await openSocket();ws.send(json(T.OPEN,1,{url:`http://${host}/`,method:'GET',headers:{}}));ws.send(frame(T.END,1));
  const [raw]=await once(ws,'message');assert.equal(parse(raw).type,T.ERROR);ws.terminate();
 });
 await check('HMP stream limit rejects abusive opens',async()=>{
  const ws=await openSocket();for(let i=0;i<49;i++)ws.send(json(T.OPEN,i*2+1,{url:'http://fixture.skidoxy.test/page',method:'POST',headers:{}}));
  const [code]=await once(ws,'close');assert.equal(code,1002);
 });
}catch(e){results.push({name:'QA harness',status:'FAIL',error:e.stack});}
finally{
 await browser?.close();for(const ws of wss.clients)ws.terminate();for(const ws of fixtureWS.clients)ws.terminate();wss.close();fixtureWS.close();server.closeAllConnections();server.close();fixture.closeAllConnections();fixture.close();
 const report={node:process.version,platform:process.platform,arch:process.arch,results,logs,fixtureDialCount:dials.filter(d=>d.host==='fixture.skidoxy.test').length};
 await writeFile('qa/quality-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
}
