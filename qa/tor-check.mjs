import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {chromium} from '@playwright/test';
import {createGateway} from '../src/gateway.mjs';
import {createDialer} from '../src/index.mjs';
import SkidoxyTransport from '../public/transport.mjs';
const origin='http://localhost:18081',token='qa-only-token-not-for-production-123456789';
const events=[];let localDNSCalls=0;
const base=createDialer({torHost:'127.0.0.1',torPort:19050,timeout:60000,resolve:async()=>{localDNSCalls++;throw Error('Local DNS forbidden during onion-only QA');},directConnect:()=>{throw Error('Direct fallback forbidden during onion-only QA');}});
const dial=async(host,port)=>{events.push({host,port});return base(host,port);};
const {server,wss}=createGateway({port:18081,origin,token,dial,tlsMode:process.env.QA_TLS_MODE||'gateway'});server.listen(18081,'127.0.0.1');await once(server,'listening');
const report={node:process.version,results:[],events};let browser,transport;
try{
 const login=await fetch(origin+'/session',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({token}),redirect:'manual'});const cookie=login.headers.get('set-cookie').split(';')[0];
 globalThis.WebSocket=class extends WebSocket{constructor(url){super(url,{origin,headers:{Cookie:cookie}});}};
 transport=new SkidoxyTransport({gateway:'ws://localhost:18081/hmp/'});
 for(const url of ['http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/','https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/']){
  const started=performance.now();
  try{const res=await transport.request(new URL(url),'GET',null,{});const text=await new Response(res.body).text();assert(res.status>=200&&res.status<400);assert(text.length>100);report.results.push({name:'Live Tor '+new URL(url).protocol,status:'PASS',upstreamStatus:res.status,bytes:Buffer.byteLength(text),title:text.match(/<title[^>]*>(.*?)<\/title>/is)?.[1],ms:Math.round(performance.now()-started)});}
  catch(e){report.results.push({name:'Live Tor '+new URL(url).protocol,status:'FAIL',error:e.message,ms:Math.round(performance.now()-started)});}
 }
 assert.equal(localDNSCalls,0);
 browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
 await context.addCookies([{name:'skidoxy',value:cookie.split('=')[1],url:origin,httpOnly:true,sameSite:'Strict'}]);
 await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Ready'));
 await page.getByLabel('Destination URL').fill('http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/');await page.getByRole('button',{name:'Open'}).click();
 await page.frameLocator('iframe').getByRole('heading',{name:'Browse Privately.',exact:true}).waitFor({timeout:70000});
 await page.frameLocator('iframe').getByRole('heading',{name:'Browse Privately.',exact:true}).scrollIntoViewIfNeeded();
 const onionFrame=page.frames().find(f=>f.url().includes('/service/'));assert.match(await onionFrame.title(),/Tor Project/);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 report.results.push({name:process.env.QA_TLS_MODE==='browser'?'Chromium isolated browser TLS live onion render':'Chromium Scramjet/HMP live onion render',status:'PASS'});await page.screenshot({path:'qa/live-onion-browser.png',fullPage:true});
 if(process.env.QA_TLS_MODE==='browser'){
  const result=await page.evaluate(async()=>{const {default:Transport}=await import('/browser-tls-transport.mjs');const t=new Transport({gateway:'ws://localhost:18081/wisp/'});try{const res=await t.request(new URL('https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/'),'GET',null,{});const body=await new Response(res.body).text();return {status:res.status,expected:body.includes('DuckDuckGo')};}finally{t.close();}});
  assert.equal(result.status,200);assert.equal(result.expected,true);report.results.push({name:'Isolated browser TLS HTTPS onion fetch',status:'PASS'});
 }
 const before=events.length;
 // Isolate the legacy transport from in-flight subresources of the prior live page.
 const legacyContext=await browser.newContext();
 await legacyContext.addCookies([{name:'skidoxy',value:cookie.split('=')[1],url:origin,httpOnly:true,sameSite:'Strict'}]);
 const legacyPage=await legacyContext.newPage();await legacyPage.goto(origin);
 await legacyPage.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Ready'));
 await legacyPage.evaluate(async()=>{const c=new BareMux.BareMuxConnection('/baremux/worker.js');await c.setTransport('/legacy-transport.mjs',[{wisp:'ws://localhost:18081/wisp/'}]);});
 await legacyPage.getByLabel('Destination URL').fill('http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/?legacy=1');await legacyPage.getByRole('button',{name:'Open'}).click();
 await legacyPage.frameLocator('iframe').getByRole('heading',{name:'Browse Privately.',exact:true}).waitFor({timeout:70000});
 assert(events.length>before);assert.equal(localDNSCalls,0);
 report.results.push({name:'Chromium Scramjet/Epoxy/Wisp live onion render',status:'PASS'});
}catch(e){report.results.push({name:'Live onion browser/harness',status:'FAIL',error:e.stack});}
finally{await browser?.close();transport?.ws?.terminate();for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();report.localDNSCalls=localDNSCalls;await writeFile(process.env.QA_TLS_MODE==='browser'?'qa/tor-browser-results.json':'qa/tor-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.results.some(r=>r.status==='FAIL'))process.exitCode=1;}
