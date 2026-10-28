import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {Readable,Writable} from 'node:stream';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {browserWebSocket,clientFrame,validCloseCode} from '../public/rfc6455.mjs';
async function fixture(t,options={}){
 const server=http.createServer();const wss=new WebSocketServer({server,...options});server.listen(0,'127.0.0.1');await once(server,'listening');
 const socket=net.createConnection({host:'127.0.0.1',port:server.address().port});await once(socket,'connect');
 t.after(()=>{socket.destroy();for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();});
 return {wss,io:{read:Readable.toWeb(socket),write:Writable.toWeb(socket)}};
}
test('browser RFC6455 masks client frames and validates close codes',()=>{const f=clientFrame(1,new TextEncoder().encode('hello'));assert.equal(f[0],129);assert.equal(f[1],133);assert.deepEqual(Array.from(f.subarray(6), (v,i)=>v^f[2+i%4]),[104,101,108,108,111]);assert.equal(validCloseCode(1006),false);assert.equal(validCloseCode(3001),true);});
test('browser RFC6455 round-trips large binary, fragmented UTF-8, subprotocol and close reason',{timeout:5000},async t=>{
 const {wss,io}=await fixture(t);wss.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
 let closeResolve;const closed=new Promise(r=>closeResolve=r);const messages=[];let receive;
 const message=new Promise(r=>receive=r);
 const socket=await browserWebSocket(io,new URL('ws://fixture.test/socket'),['skidoxy.v2'],{}, {onmessage:data=>{messages.push(data);if(messages.length===2)receive();},onclose:(code,reason)=>closeResolve({code,reason}),onerror:error=>assert.fail(error.message)});
 assert.equal(socket.protocol,'skidoxy.v2');socket.start();const binary=new Uint8Array(800000).fill(79),text='🌐'.repeat(90000);
 await socket.send(binary.buffer);await socket.send(text);await message;assert.deepEqual(new Uint8Array(messages[0]),binary);assert.equal(messages[1],text);
 await socket.close(3001,'complete');assert.deepEqual(await closed,{code:3001,reason:'complete'});
});
test('browser RFC6455 responds to ping without exposing it as a website message',{timeout:5000},async t=>{
 const {wss,io}=await fixture(t);let pong;const pongPromise=new Promise(r=>pong=r);wss.on('connection',ws=>{ws.on('pong',data=>pong(data.toString()));ws.ping('peer health');});
 const socket=await browserWebSocket(io,new URL('ws://fixture.test/'),[],{},{});socket.start();assert.equal(await pongPromise,'peer health');await socket.close();
});
test('browser RFC6455 rejects masked server frames and fails closed',{timeout:5000},async t=>{
 const {wss,io}=await fixture(t);wss.on('connection',ws=>ws._socket.write(Buffer.from([129,128,1,2,3,4])));
 let errorResolve;const error=new Promise(r=>errorResolve=r);
 const socket=await browserWebSocket(io,new URL('ws://fixture.test/'),[],{},{onerror:errorResolve});socket.start();assert.equal((await error).code,'PROTOCOL_ERROR');
});
test('browser RFC6455 caps zero-length continuation floods',{timeout:5000},async t=>{
 const {wss,io}=await fixture(t);wss.on('connection',ws=>{for(let i=0;i<12;i++)ws.send('',{fin:false});});let rejectPeer;const failed=new Promise(r=>rejectPeer=r);
 const socket=await browserWebSocket(io,new URL('ws://fixture.test/'),[],{},{onerror:rejectPeer},{maxFragments:8});socket.start();assert.equal((await failed).code,'MESSAGE_LIMIT');
});
