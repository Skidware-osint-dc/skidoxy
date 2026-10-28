import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {attachHMP} from '../src/hmp.mjs';
import SkidoxyTransport from '../public/transport.mjs';
globalThis.WebSocket=WebSocket;
const bytes=64*1024,total=1000,concurrency=16;
const upstream=http.createServer((req,res)=>res.end(Buffer.alloc(bytes,120)));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const server=http.createServer(),wss=new WebSocketServer({server});let gateway;
wss.on('connection',ws=>gateway=attachHMP(ws,{dial:async()=>{const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;}}));
server.listen(0,'127.0.0.1');await once(server,'listening');
const transport=new SkidoxyTransport({gateway:`ws://127.0.0.1:${server.address().port}`});
const latencies=[],errors=[];let index=0;const before=process.memoryUsage();let peak=before.rss;
const sample=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),10);
try{
 const started=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(index<total){const n=index++;const t=performance.now();try{const res=await transport.request(new URL('http://load.fixture.test/'),'GET',null,{});assert.equal(res.status,200);assert.equal((await new Response(res.body).arrayBuffer()).byteLength,bytes);latencies.push(performance.now()-t);}catch(e){errors.push({n,error:e.message});}}
 }));
 // Allow final control frames to drain before recording stream cleanup.
 await new Promise(r=>setTimeout(r,50));
 const duration=performance.now()-started;latencies.sort((a,b)=>a-b);
 const report={scope:'Local same-process transport smoke load, not a cloud benchmark or soak test',node:process.version,total,concurrency,responseBytes:bytes,success:latencies.length,fail:errors.length,durationMs:Math.round(duration),requestsPerSecond:Math.round(latencies.length/(duration/1000)),p50Ms:+latencies[Math.floor(latencies.length*.5)].toFixed(2),p95Ms:+latencies[Math.floor(latencies.length*.95)].toFixed(2),rssBeforeMiB:+(before.rss/1048576).toFixed(1),rssPeakMiB:+(peak/1048576).toFixed(1),rssAfterMiB:+(process.memoryUsage().rss/1048576).toFixed(1),gatewayStreamsRemaining:gateway.streams.size,clientStreamsRemaining:transport.streams.size,errors};
 await writeFile('qa/load-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.equal(errors.length,0);assert.equal(gateway.streams.size,0);assert.equal(transport.streams.size,0);
}finally{clearInterval(sample);transport.ws?.terminate();for(const ws of wss.clients)ws.terminate();wss.close();server.close();upstream.closeAllConnections();upstream.close();}
