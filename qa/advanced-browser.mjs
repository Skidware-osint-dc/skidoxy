import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {WebSocketServer} from 'ws';
import {createGateway} from '../src/gateway.mjs';
import {createDialer} from '../src/index.mjs';
const token='advanced-qa-token-not-for-production-123456';const results=[],errors=[],upgrades=[],firstTLS=[];
const html=`<!doctype html><title>Isolated TLS fixture</title><h1>Isolated TLS fixture</h1><p id="post">pending</p><p id="ws">pending</p><script>fetch('/echo',{method:'POST',body:'isolated upload'}).then(r=>r.text()).then(v=>document.querySelector('#post').textContent=v);const w=new WebSocket('ws://fixture.skidoxy.test/socket');w.onopen=()=>w.send('isolated socket');w.onmessage=e=>{document.querySelector('#ws').textContent=e.data;w.close();};</script>`;
const fixture=http.createServer((req,res)=>{if(req.url==='/slow'){res.writeHead(200);res.write('first');return;}if(req.url==='/echo'){let body='';req.on('data',c=>body+=c);req.on('end',()=>res.end(body));return;}res.setHeader('Content-Type','text/html');res.end(html);});
const echo=new WebSocketServer({server:fixture});echo.on('connection',ws=>ws.on('message',(d,b)=>ws.send(d,{binary:b})));
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');const publicDial=createDialer();
const certDir=mkdtempSync(path.join(tmpdir(),'skidoxy-browser-tls-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',certDir+'/key.pem','-out',certDir+'/cert.pem','-subj','/CN=untrusted.fixture.skidoxy.test','-addext','subjectAltName=DNS:untrusted.fixture.skidoxy.test','-days','1'],{stdio:'ignore'});
let untrustedHTTP=0;const untrusted=https.createServer({key:readFileSync(certDir+'/key.pem'),cert:readFileSync(certDir+'/cert.pem')},(_,res)=>{untrustedHTTP++;res.end('not trusted');});untrusted.listen(0,'127.0.0.1');await once(untrusted,'listening');
const dial=async(host,port)=>{
 let socket;if(host==='fixture.skidoxy.test'&&port===80){socket=net.createConnection({host:'127.0.0.1',port:fixture.address().port});await once(socket,'connect');}else if(host==='untrusted.fixture.skidoxy.test'&&port===443){socket=net.createConnection({host:'127.0.0.1',port:untrusted.address().port});await once(socket,'connect');}else socket=await publicDial(host,port);
 if(port===443){let seen=false;const write=socket.write.bind(socket);socket.write=(data,...args)=>{if(!seen){seen=true;firstTLS.push({host,prefix:Array.from(new Uint8Array(data.buffer??Buffer.from(data),data.byteOffset||0,Math.min(data.byteLength||data.length,5)))});}return write(data,...args);};}
 return socket;
};
const origin='http://localhost:18082';const {server,wss}=createGateway({port:18082,origin,token,dial,tlsMode:'browser'});server.on('upgrade',req=>upgrades.push(req.url));server.listen(18082,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e.message);if(name.includes('mode:')||name.includes('external')){console.log('IFRAME ERROR',await page.frameLocator('iframe').locator('#errorTrace').inputValue({timeout:1000}).catch(()=>''));console.log('POOL',await page.evaluate(()=>({workers:activeTransport?.pool.all.size,idle:activeTransport?.pool.idle.length,queued:activeTransport?.pool.waiters.length,active:activeTransport?.active.size,mode:activeTransport?.meta().tlsTermination})));}}}
try{
 await check('Browser TLS mode: authenticated config and worker-backed Scramjet HTTP/POST/WebSocket',async()=>{
  await page.goto(origin);await page.getByLabel('Access token').fill(token);await page.getByRole('button',{name:'Sign in'}).click();
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Ready'),null,{timeout:20000});
  assert.match(await page.locator('#trust').textContent(),/isolated browser worker/);
  await page.getByLabel('Destination URL').fill('http://fixture.skidoxy.test/');await page.getByRole('button',{name:'Open'}).click();
  const frame=page.frameLocator('iframe');await frame.getByRole('heading',{name:'Isolated TLS fixture'}).waitFor({timeout:20000});
  await frame.locator('#post').filter({hasText:'isolated upload'}).waitFor({timeout:20000});await frame.locator('#ws').filter({hasText:'isolated socket'}).waitFor({timeout:20000});
 });
 await check('Direct browser TLS WebSocket API',async()=>{
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/'});await t.init();return await new Promise(resolve=>{const timer=setTimeout(()=>{resolve('timeout');t.close();},5000);const [send,close]=t.connect(new URL('ws://fixture.skidoxy.test/socket'),[],{},()=>send('direct socket'),data=>{clearTimeout(timer);resolve(String(data));close();t.close();},()=>{},error=>{clearTimeout(timer);t.close();resolve('error:'+error);});});});assert.equal(result,'direct socket');
 });
 await check('Browser TLS isolation: body cancellation retires only its own leased worker',async()=>{
  const result=await page.evaluate(async()=>{
   const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/'});
   const slow=await t.request(new URL('http://fixture.skidoxy.test/slow'),'GET',null,{});
   const other=t.request(new URL('http://fixture.skidoxy.test/echo'),'POST','unrelated survives',{});
   await slow.body.cancel();const response=await other;const text=await new Response(response.body).text();const active=t.active.size;t.close();return {text,active};
  });assert.equal(result.text,'unrelated survives');assert.equal(result.active,0);
 });
 await check('Browser TLS explicit AbortSignal terminates its worker',async()=>{
  const result=await page.evaluate(async()=>{
   const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/'}),controller=new AbortController();
   const res=await t.request(new URL('http://fixture.skidoxy.test/slow'),'GET',null,{},controller.signal);controller.abort(Error('test abort'));
   let message='';try{await res.body.getReader().read();}catch(e){message=e.message;}const workers=t.pool.all.size;t.close();return {message,workers};
  });assert.match(result.message,/test abort/);assert.equal(result.workers,0);
 });
 await check('Browser TLS WebSocket: >window binary/text messages, serialized sends and exact close metadata',async()=>{
  const result=await page.evaluate(async()=>{
   const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/'});await t.init();
   return await new Promise(resolve=>{const messages=[],binary=new Uint8Array(900000).fill(43),text='🌐'.repeat(90000);let complete=false;
    const timer=setTimeout(()=>{if(!complete){complete=true;resolve({error:'timeout'});t.close();}},15000);
    const [send,close]=t.connect(new URL('ws://fixture.skidoxy.test/socket'),[],{},()=>{send(binary.buffer);send(text);},data=>{messages.push(typeof data==='string'?data:new Uint8Array(data));if(messages.length===2)close(3001,'browser verified');},(code,reason)=>{if(!complete){complete=true;clearTimeout(timer);resolve({code,reason,binaryLength:messages[0]?.length,binaryFirst:messages[0]?.[0],textExact:messages[1]===text});t.close();}},error=>{if(!complete){complete=true;clearTimeout(timer);resolve({error});t.close();}});
   });
  });assert.deepEqual(result,{code:3001,reason:'browser verified',binaryLength:900000,binaryFirst:43,textExact:true});
 });
 await check('Browser TLS separates HTTP capacity from long-lived WebSocket workers',async()=>{
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/',maxWorkers:1,maxWebSocketWorkers:1,requestTimeout:2000});await t.init();let close;await new Promise((resolve,reject)=>{[,close]=t.connect(new URL('ws://fixture.skidoxy.test/socket'),[],{},resolve,()=>{},()=>{},e=>reject(Error(e)));});const response=await t.request(new URL('http://fixture.skidoxy.test/echo'),'POST','HTTP not starved',{});const text=await new Response(response.body).text();close();t.close();return text;});assert.equal(result,'HTTP not starved');
 });
 await check('Browser TLS rejects an untrusted destination certificate before HTTP',async()=>{
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/'});try{await t.request(new URL('https://untrusted.fixture.skidoxy.test/'),'GET',null,{});return 'accepted';}catch(e){return e.code;}finally{t.close();}});
  assert.equal(result,'TLS_FAILURE');assert.equal(untrustedHTTP,0);
 });
 await check('Browser TLS deadlines retire stalled operations and report a typed timeout',async()=>{
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/',requestTimeout:150});let code;try{const res=await t.request(new URL('http://fixture.skidoxy.test/slow'),'GET',null,{});const reader=res.body.getReader();for(;;){const {done}=await reader.read();if(done)break;}}catch(e){code=e.code;}const workers=t.pool.all.size;t.close();return {code,workers};});assert.deepEqual(result,{code:'DEADLINE',workers:0});
 });
 await check('Browser TLS enforces known and streaming upload limits before oversized data reaches upstream',async()=>{
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18082/wisp/',maxUploadBytes:10});const codes=[];for(const body of ['12345678901',new ReadableStream({start(c){c.enqueue(new Uint8Array(11));c.close();}})]){try{await t.request(new URL('http://fixture.skidoxy.test/echo'),'POST',body,{});codes.push('accepted');}catch(e){codes.push(e.code);}}t.close();return codes;});assert.deepEqual(result,['UPLOAD_LIMIT','UPLOAD_LIMIT']);
 });
 if(!process.env.QA_OFFLINE) await check('Browser TLS external HTTPS: gateway receives TLS records over Wisp, never HMP HTTP metadata',async()=>{
  await page.getByLabel('Destination URL').fill('https://example.com/?browser-tls=1');await page.getByRole('button',{name:'Open'}).click();
  await page.frameLocator('iframe').getByRole('link',{name:'Learn more',exact:false}).waitFor({timeout:30000});
  assert(firstTLS.some(r=>r.host==='example.com'&&r.prefix[0]===22));assert(!upgrades.includes('/hmp/'));
 });
}catch(e){results.push({name:'advanced browser harness',status:'FAIL',error:e.stack});}
finally{await browser.close();for(const ws of wss.clients)ws.terminate();for(const ws of echo.clients)ws.terminate();wss.close();echo.close();server.closeAllConnections();server.close();fixture.closeAllConnections();fixture.close();untrusted.closeAllConnections();untrusted.close();rmSync(certDir,{recursive:true,force:true});await writeFile('qa/advanced-browser-results.json',JSON.stringify({results,errors,upgrades,firstTLS},null,2));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;}
