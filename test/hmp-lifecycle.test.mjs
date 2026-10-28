import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {attachHMP} from '../src/hmp.mjs';
import SkidoxyTransport from '../public/transport.mjs';
import {T,json,parse,readJSON} from '../public/protocol.mjs';
globalThis.WebSocket=WebSocket;
async function fixture(t,options={}){
 const upstream=http.createServer((_,res)=>setTimeout(()=>res.end('drained response'),50));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const server=http.createServer(),wss=new WebSocketServer({server});let connection;const opened=new Promise(resolve=>wss.once('connection',ws=>{connection=attachHMP(ws,{dial:async()=>{const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;},...options});resolve();}));
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`ws://127.0.0.1:${server.address().port}`;
 t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();});return {url,opened,get connection(){return connection;}};
}
test('HMP/2 heartbeat terminates a peer that never answers pings',{timeout:3000},async t=>{
 const f=await fixture(t,{heartbeatInterval:10,heartbeatTimeout:10});const ws=new WebSocket(f.url);await once(ws,'open');ws.send(json(T.HELLO,0,{version:2}));const [code]=await once(ws,'close');assert.equal(code,1006);
});
test('HMP/2 browser transport answers heartbeats and stays usable',{timeout:3000},async t=>{
 const f=await fixture(t,{heartbeatInterval:10,heartbeatTimeout:20});const client=new SkidoxyTransport({gateway:f.url});t.after(()=>client.close());await client.init();await new Promise(r=>setTimeout(r,90));const response=await client.request(new URL('http://example.com/'),'GET',null,{});assert.equal(await new Response(response.body).text(),'drained response');
});
test('HMP graceful drain lets in-flight HTTP finish and refuses new work',{timeout:3000},async t=>{
 const f=await fixture(t);const client=new SkidoxyTransport({gateway:f.url});t.after(()=>client.close());await client.init();const request=client.request(new URL('http://example.com/'),'GET',null,{});
 await new Promise(r=>setTimeout(r,10));f.connection.drain({timeout:1000});
 await new Promise(r=>setTimeout(r,10));assert.equal(client.draining,true);await assert.rejects(client.request(new URL('http://example.com/'),'GET',null,{}),e=>e.code==='DRAINING');
 const res=await request;assert.equal(await new Response(res.body).text(),'drained response');
});
test('HMP/2 client heartbeat fails stalled operations even if gateway never closes TCP',{timeout:3000},async t=>{
 const server=http.createServer(),wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',raw=>{const p=parse(raw);if(p.type===T.HELLO)ws.send(json(T.HELLO,0,{version:2,window:262144,chunk:65536,maxMessage:4194304}));}));
 server.listen(0,'127.0.0.1');await once(server,'listening');const client=new SkidoxyTransport({gateway:`ws://127.0.0.1:${server.address().port}`,heartbeatInterval:10,heartbeatTimeout:10});
 t.after(()=>{client.close();for(const ws of wss.clients)ws.terminate();wss.close();server.close();});
 await assert.rejects(client.request(new URL('http://example.com/'),'GET',null,{}),e=>e.code==='HEARTBEAT_TIMEOUT');assert.equal(client.draining,true);
});
