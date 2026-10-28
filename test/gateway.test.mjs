import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway} from '../src/gateway.mjs';
const token='unit-test-only-token-01234567890123456789';
test('gateway checks session expiry server-side, not just cookie Max-Age',async t=>{
 const {server,wss}=createGateway({port:0,token,sessionTTL:200});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{wss.close();server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(url+'/session',{method:'POST',headers:{Origin:'http://localhost:0'},body:new URLSearchParams({token}),redirect:'manual'});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(url+'/',{headers:{Cookie:cookie}})).status,200);
 await new Promise(r=>setTimeout(r,230));
 assert.equal((await fetch(url+'/',{headers:{Cookie:cookie}})).status,401);
});
test('gateway issues distinct sessions and HTTPS cookie security flags',async t=>{
 const {server,wss}=createGateway({port:0,origin:'https://qa.example',token});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{wss.close();server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}`;const cookies=[];
 for(let i=0;i<2;i++){const r=await fetch(url+'/session',{method:'POST',headers:{Origin:'https://qa.example'},body:new URLSearchParams({token}),redirect:'manual'});cookies.push(r.headers.get('set-cookie'));}
 assert.notEqual(cookies[0],cookies[1]);assert.match(cookies[0],/^__Host-skidoxy=/);for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert(cookies[0].includes(flag));
});

import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import SkidoxyTransport from '../public/transport.mjs';
test('gateway shutdown waits for active upgraded HMP work, not only HTTP listener close',{timeout:3000},async t=>{
 let finished=false;const upstream=http.createServer((_,res)=>setTimeout(()=>{finished=true;res.end('finished before shutdown');},80));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const gateway=createGateway({port:0,token,dial:async()=>{const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;}});gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');
 const url=`http://127.0.0.1:${gateway.server.address().port}`;const r=await fetch(url+'/session',{method:'POST',headers:{Origin:'http://localhost:0'},body:new URLSearchParams({token}),redirect:'manual'});const cookie=r.headers.get('set-cookie').split(';')[0];
 globalThis.WebSocket=class extends WebSocket{constructor(url){super(url,{origin:'http://localhost:0',headers:{Cookie:cookie}});}};
 const client=new SkidoxyTransport({gateway:url.replace('http:','ws:')+'/hmp/'});t.after(()=>{client.close();for(const ws of gateway.wss.clients)ws.terminate();gateway.server.closeAllConnections();gateway.server.close();upstream.closeAllConnections();upstream.close();});
 await client.init();const request=client.request(new URL('http://fixture.test/'),'GET',null,{}).then(res=>new Response(res.body).text());await new Promise(r=>setTimeout(r,15));
 const draining=gateway.drain({timeout:1000});assert.equal(gateway.drain(),draining);await draining;assert.equal(finished,true);assert.equal(await request,'finished before shutdown');
});
