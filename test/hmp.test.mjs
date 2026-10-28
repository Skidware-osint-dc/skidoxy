import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import WebSocket,{WebSocketServer} from 'ws';
import {attachHMP} from '../src/hmp.mjs';
import SkidoxyTransport from '../public/transport.mjs';
import {T,WINDOW,frame,parse,json,readJSON,Credit} from '../public/protocol.mjs';
globalThis.WebSocket=WebSocket;
async function fixture(t){
 const large=Buffer.alloc(1024*1024+123,97);
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/echo'){let size=0;req.on('data',c=>size+=c.length);req.on('end',()=>res.end(String(size)));return;}
  if(req.url==='/gzip'){res.writeHead(200,{'content-encoding':'gzip','set-cookie':['a=1','b=2']});res.end(gzipSync('decoded payload'));return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/gzip'}).end();return;}
  if(req.url==='/slow'){res.writeHead(200);res.write('first');return;}
  res.end(large);
 });
 const echo=new WebSocketServer({server:upstream});echo.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const server=http.createServer();const gateway=new WebSocketServer({server});const conns=[];
 gateway.on('connection',ws=>conns.push(attachHMP(ws,{dial:async()=>{
  const socket=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(socket,'connect');return socket;
 }})));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const transport=new SkidoxyTransport({gateway:`ws://127.0.0.1:${server.address().port}`});
 t.after(()=>{transport.ws?.terminate();for(const w of gateway.clients)w.terminate();for(const w of echo.clients)w.terminate();gateway.close();echo.close();server.close();upstream.closeAllConnections();upstream.close();});
 return {transport,large,conns,gatewayURL:`ws://127.0.0.1:${server.address().port}`};
}
async function text(response){return new Response(response.body).text();}
test('HMP streams a >1 MiB response with credit replenishment',{timeout:5000},async t=>{
 const {transport,large}=await fixture(t);
 const response=await transport.request(new URL('http://example.com/'),'GET',null,{});
 assert.equal(response.status,200);assert.equal((await text(response)).length,large.length);
});
test('HMP streams upload larger than initial window',{timeout:5000},async t=>{
 const {transport}=await fixture(t);const response=await transport.request(new URL('http://example.com/echo'),'POST',new Uint8Array(1000000),{});
 assert.equal(await text(response),'1000000');
});
test('HMP decompresses gzip and preserves repeated cookies',{timeout:5000},async t=>{
 const {transport}=await fixture(t);const response=await transport.request(new URL('http://example.com/gzip'),'GET',null,{});
 assert.deepEqual(response.headers['set-cookie'],['a=1','b=2']);assert.equal(response.headers['content-encoding'],undefined);assert.equal(await text(response),'decoded payload');
});
test('HMP returns redirects without following them',{timeout:5000},async t=>{
 const {transport}=await fixture(t);const response=await transport.request(new URL('http://example.com/redirect'),'GET',null,{});
 assert.equal(response.status,302);assert.equal(response.headers.location,'/gzip');await text(response);
});
test('HMP multiplexes concurrent requests',{timeout:5000},async t=>{
 const {transport}=await fixture(t);
 const responses=await Promise.all(Array.from({length:8},()=>transport.request(new URL('http://example.com/gzip'),'GET',null,{}).then(text)));
 assert.deepEqual(responses,Array(8).fill('decoded payload'));
});
test('HMP carries text and binary WebSocket messages',{timeout:5000},async t=>{
 const {transport}=await fixture(t);const messages=[];
 await new Promise((resolve,reject)=>{
  const [send,close]=transport.connect(new URL('ws://example.com/'),[],{},()=>{send('hello');send(new Uint8Array([1,2,3]).buffer);},data=>{messages.push(data);if(messages.length===2)close();},()=>resolve(),error=>reject(Error(error)));
 });
 assert.equal(messages[0],'hello');assert.deepEqual([...new Uint8Array(messages[1])],[1,2,3]);
});
test('HMP abort cancels a live response and upstream stream',{timeout:5000},async t=>{
 const {transport,conns}=await fixture(t);const controller=new AbortController();
 const response=await transport.request(new URL('http://example.com/slow'),'GET',null,{},controller.signal);
 const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'first');
 const disconnected=new Promise(resolve=>{const old=conns[0].streams.values().next().value.req;old.on('close',resolve);});
 controller.abort(Error('Test abort'));await assert.rejects(reader.read(),/Test abort/);await disconnected;
 assert.equal(conns[0].streams.size,0);
});
test('HMP rejects protocol version mismatch',{timeout:5000},async t=>{
 const {gatewayURL}=await fixture(t);const ws=new WebSocket(gatewayURL);await once(ws,'open');
 ws.send(json(T.HELLO,0,{version:99}));const [code]=await once(ws,'close');assert.equal(code,1002);
});
test('framing validates lengths and credit overflow',async()=>{
 assert.throws(()=>parse(new Uint8Array(4)),/frame size/);
 const bytes=frame(T.END,1);new DataView(bytes.buffer).setUint32(5,10);assert.throws(()=>parse(bytes),/payload length/);
 const c=new Credit();assert.throws(()=>c.add(1),/overflow/);await c.take(WINDOW);const waiting=c.take(1);c.close(Error('cancelled'));await assert.rejects(waiting,/cancelled/);
});

test('HMP stops response transmission when client withholds credit',{timeout:5000},async t=>{
 const {gatewayURL,conns}=await fixture(t);const ws=new WebSocket(gatewayURL);t.after(()=>ws.terminate());await once(ws,'open');
 ws.send(json(T.HELLO,0,{version:1}));await once(ws,'message');
 let bytes=0,ended=false;
 ws.on('message',raw=>{const p=parse(raw);if(p.type===T.DATA)bytes+=p.payload.length;if(p.type===T.END)ended=true;});
 ws.send(json(T.OPEN,1,{url:'http://example.com/',method:'GET',headers:{}}));ws.send(frame(T.END,1));
 await new Promise(resolve=>setTimeout(resolve,150));
 assert(bytes>0&&bytes<=WINDOW);assert.equal(ended,false);assert.equal(conns[0].streams.size,1);
 ws.send(frame(T.CANCEL,1));await new Promise(resolve=>setTimeout(resolve,30));assert.equal(conns[0].streams.size,0);
});

test('HMP body cancellation tears down an active stream',{timeout:5000},async t=>{
 const {transport,conns}=await fixture(t);const res=await transport.request(new URL('http://example.com/slow'),'GET',null,{});
 await res.body.cancel();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(conns[0].streams.size,0);assert.equal(transport.streams.size,0);
});

test('frame parser rejects 1000 deterministic malformed lengths',()=>{
 for(let i=0;i<1000;i++){const f=frame(T.DATA,1,new Uint8Array(i%64));new DataView(f.buffer).setUint32(5,1000+i);assert.throws(()=>parse(f));}
});

test('HMP/2 fragments 2 MiB binary and long UTF-8 text in both directions',{timeout:10000},async t=>{
 const {transport}=await fixture(t);const binary=new Uint8Array(2*1024*1024).fill(173),text='🌐'.repeat(100000);const messages=[];
 await new Promise((resolve,reject)=>{
  const [send,close]=transport.connect(new URL('ws://example.com/'),[],{},()=>{send(binary.buffer);send(text);},data=>{messages.push(data);if(messages.length===2)close(3001,'verified close');},(code,reason)=>{try{assert.equal(code,3001);assert.equal(reason,'verified close');resolve();}catch(e){reject(e);}},error=>reject(Error(error)));
 });
 assert.deepEqual(new Uint8Array(messages[0]),binary);assert.equal(messages[1],text);assert.equal(transport.outboundBudget.used,0);assert.equal(transport.inboundBudget.used,0);
});
test('HMP/2 enforces message admission synchronously without corrupting connection',{timeout:5000},async t=>{
 const {transport}=await fixture(t);
 await new Promise((resolve,reject)=>{const [send,close]=transport.connect(new URL('ws://example.com/'),[],{},()=>{assert.throws(()=>send(new Uint8Array(5*1024*1024)),e=>e.code==='MESSAGE_LIMIT');send('still alive');},data=>{assert.equal(data,'still alive');close();},()=>resolve(),e=>reject(Error(e)));});
});
test('HMP/1 remains explicitly usable for old clients',{timeout:5000},async t=>{const {gatewayURL}=await fixture(t);const old=new SkidoxyTransport({gateway:gatewayURL,protocolVersion:1});t.after(()=>old.close());const res=await old.request(new URL('http://example.com/gzip'),'GET',null,{});assert.equal(await text(res),'decoded payload');assert.equal(old.meta().version,1);});
