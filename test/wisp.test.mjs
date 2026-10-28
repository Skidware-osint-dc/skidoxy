import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { client } from '@mercuryworkshop/wisp-js/client';
import { attachWisp } from '../src/index.mjs';

test('Wisp v2 carries TCP bytes through custom routed socket', {timeout:5000}, async t => {
 const echo=net.createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');
 const server=http.createServer();const wss=new WebSocketServer({server});
 let conn;
 wss.on('connection',ws=>{conn=attachWisp(ws,{dial:async()=>{
  const socket=net.createConnection({host:'127.0.0.1',port:echo.address().port});await once(socket,'connect');return socket;
 }});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const c=new client.ClientConnection(`ws://127.0.0.1:${server.address().port}/wisp/`);
 t.after(()=>{c.close();for(const ws of wss.clients)ws.terminate();wss.close();server.close();echo.close();void conn?.cleanup();});
 await new Promise((resolve,reject)=>{c.onopen=resolve;c.onerror=reject;});
 const stream=c.create_stream('example.com',80);
 const received=new Promise(resolve=>stream.onmessage=data=>resolve(new TextDecoder().decode(data)));
 stream.send(new TextEncoder().encode('skidoxy-wire-test'));
 assert.equal(await received,'skidoxy-wire-test');
});
