import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { once } from 'node:events';
import { createGunzip,createInflate,createBrotliDecompress } from 'node:zlib';
import WebSocket from 'ws';
import { T,WINDOW,CHUNK,frame,parse,json,readJSON,credit,readCredit,Credit } from '../public/protocol.mjs';
import {GatewayTLS} from './tls-transport.mjs';
import {OperationScope,ByteBudget,Heartbeat,EngineError,engineError,publicError,boundedInteger} from '../public/reliability.mjs';
import {fragments,MessageAssembler,MAX_MESSAGE} from '../public/protocol.mjs';
import { createDialer } from './index.mjs';

function headers(input={}){
 const result=Object.create(null);
 const nominated=Object.entries(input).filter(([k])=>k.toLowerCase()==='connection').flatMap(([,v])=>String(v).toLowerCase().split(',').map(x=>x.trim()));
 for(const [key,value] of Object.entries(input)){
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))throw Error('Invalid header');
  if(nominated.includes(key.toLowerCase()) || /^(host|connection|proxy-.*|transfer-encoding|content-length|upgrade|keep-alive|te|trailer|accept-encoding|sec-websocket-.*)$/i.test(key))continue;
  const values=Array.isArray(value)?value:[value];
  if(values.some(v=>typeof v!=='string'||/[\r\n\x00]/.test(v)))throw Error('Invalid header value');
  result[key]=value;
 }
 return result;
}
function rawHeaders(list){const out=Object.create(null);for(let i=0;i<list.length;i+=2){const k=list[i].toLowerCase();if(out[k]===undefined)out[k]=list[i+1];else out[k]=[].concat(out[k],list[i+1]);}return out;}
export function routedAgent(url,dial){
 const secure=['https:','wss:'].includes(url.protocol);
 const agent=secure ? new https.Agent({keepAlive:false}) : new http.Agent({keepAlive:false});
 let destroyed=false;const originalDestroy=agent.destroy.bind(agent);
 agent.destroy=()=>{destroyed=true;originalDestroy();};
 agent.createConnection=(_opts,callback)=>{
  (async()=>{
   const host=url.hostname.replace(/^\[|\]$/g,'');
   let socket=await dial(host,Number(url.port || (secure?443:80)));
   if(destroyed){socket.destroy();throw Error('Request cancelled during connect');}
   if(secure){
    const plain=socket;
    socket=tls.connect({socket:plain,host,servername:net.isIP(host)?undefined:host,rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
    socket.setTimeout(30000,()=>socket.destroy(Error('TLS handshake timeout')));
    try{await once(socket,'secureConnect');socket.setTimeout(120000,()=>socket.destroy());}
    catch(e){socket.destroy();throw e;}
   }
   if(destroyed){socket.destroy();throw Error('Request cancelled during TLS handshake');}
   return socket;
  })().then(socket=>callback(null,socket),error=>callback(error));
 };
 return agent;
}
export function attachHMP(ws,{dial=createDialer(),maxStreams=48,streamTimeout=120000,websocketLifetime=0,websocketIdle=300000,heartbeatInterval=30000,heartbeatTimeout=10000,closeTimeout=5000,maxMessage=MAX_MESSAGE,maxQueuedBytes=8*1024*1024,tlsOptions={}}={}){
 boundedInteger('maxStreams',maxStreams,1,512);boundedInteger('maxMessage',maxMessage,1,16*1024*1024);boundedInteger('maxQueuedBytes',maxQueuedBytes,CHUNK,32*1024*1024);
 for(const [name,value]of Object.entries({streamTimeout,websocketLifetime,websocketIdle,heartbeatInterval}))boundedInteger(name,value,0,7*24*60*60*1000);
 boundedInteger('heartbeatTimeout',heartbeatTimeout,1,300000);boundedInteger('closeTimeout',closeTimeout,1,300000);
 const streams=new Map();let hello=false,version=1,draining=false,drainTimer;
 const pool=new GatewayTLS({dial,...tlsOptions});const budget=new ByteBudget(16*1024*1024),outboundBudget=new ByteBudget(16*1024*1024),upstreamBudget=new ByteBudget(16*1024*1024);let heartbeat;
 const send=data=>{if(ws.readyState!==WebSocket.OPEN)throw Error('Transport closed');if(ws.bufferedAmount>4*1024*1024){ws.close(1009,'Send buffer exceeded');throw Error('Send buffer exceeded');}ws.send(data);};
 function dispose(id,normal=false){const s=streams.get(id);if(!s)return;s.closed=true;s.out.close();s.scope.close(normal?undefined:engineError('ABORTED'));s.assembler?.clear();if(s.queuedBytes){outboundBudget.release(s.queuedBytes);s.queuedBytes=0;}if(s.upstreamBytes){upstreamBudget.release(s.upstreamBytes);s.upstreamBytes=0;}if(!normal)s.req?.destroy();s.remote?.terminate();streams.delete(id);if(draining&&!streams.size)ws.close(1001,'Drained');}
 function fail(id,error=engineError('UPSTREAM_FAILURE')){try{send(json(T.ERROR,id,publicError(error)));}catch{}dispose(id);}
 function touch(s){if(!s.isWS||websocketIdle<=0)return;clearTimeout(s.idle);s.idle=setTimeout(()=>fail(s.id,engineError('DEADLINE')),websocketIdle);s.idle.unref();}
 async function sendMessage(id,s,data,binary){
  const messages=version>=2?fragments(new Uint8Array(data),binary):[new Uint8Array([binary?1:0,...data])];
  for(const payload of messages){await s.out.take(payload.length);if(s.closed)return;send(frame(version>=2?T.WSFRAGMENT:T.WSMESSAGE,id,payload));}
 }

 async function sendBody(id,s,body){
  try{
   for await(const chunk of body){for(let i=0;i<chunk.length;i+=CHUNK){const part=chunk.subarray(i,i+CHUNK);await s.out.take(part.length);if(s.closed)return;send(frame(T.DATA,id,part));}}
   if(!s.closed){send(frame(T.END,id));s.responseEnded=true;if(s.uploadEnded)dispose(id,true);}
  }catch{if(!s.closed)fail(id);}
 }
 function open(id,meta,isWS){
  if(draining){send(json(T.ERROR,id,publicError(engineError('DRAINING'))));return;}
  if(!id || !(id&1) || streams.has(id) || streams.size>=maxStreams)throw Error('Invalid stream id or stream limit');
  const url=new URL(meta.url);
  if(url.username||url.password||!(isWS?['ws:','wss:']:['http:','https:']).includes(url.protocol))throw Error('Invalid URL');
  const s={id,out:new Credit(),incoming:WINDOW,closed:false,uploadEnded:false,responseEnded:false,isWS,queuedBytes:0};
  s.scope=new OperationScope({timeout:isWS?websocketLifetime:streamTimeout,onTimeout:error=>fail(id,error)});
  if(isWS){s.assembler=new MessageAssembler({maxMessage,budget});s.scope.add(()=>{clearTimeout(s.idle);clearTimeout(s.closeTimer);s.pulse?.stop();});touch(s);}
  streams.set(id,s);
  try{
   const agent=pool.agent(url);
   if(isWS){
    const protocols=meta.protocols||[];if(!Array.isArray(protocols)||protocols.length>16)throw Error('Invalid protocols');
    const remote=s.remote=new WebSocket(url,protocols,{headers:headers(meta.headers),agent,followRedirects:false,maxPayload:version>=2?maxMessage:CHUNK-1,perMessageDeflate:false,handshakeTimeout:30000});
    let sendChain=Promise.resolve();
    remote.on('open',()=>{
     send(json(T.WSOPEN,id,{protocol:remote.protocol,extensions:remote.extensions}));touch(s);
     s.pulse=new Heartbeat({interval:heartbeatInterval,timeout:heartbeatTimeout,send:n=>remote.ping(String(n)),onTimeout:()=>fail(id,engineError('HEARTBEAT_TIMEOUT'))});
     remote.on('pong',data=>s.pulse?.ack(Number(data.toString())));
    });
    remote.on('message',(data,binary)=>{
     if(s.closed)return;
     if(s.queuedBytes+data.length+64>maxQueuedBytes||(s.queuedMessages||0)>=128){fail(id,engineError('QUEUE_LIMIT'));return;}
     try{outboundBudget.reserve(data.length+64);}catch(error){fail(id,error);return;}s.queuedBytes+=data.length+64;s.queuedMessages=(s.queuedMessages||0)+1;remote.pause();touch(s);
     sendChain=sendChain.then(()=>sendMessage(id,s,data,binary)).then(()=>{if(!s.closed){s.queuedBytes-=data.length+64;s.queuedMessages--;outboundBudget.release(data.length+64);if(!s.queuedBytes)remote.resume();}}).catch(error=>{if(!s.closed)fail(id,error);});
    });
    remote.on('close',(code,reason)=>{sendChain.then(()=>{if(!s.closed){try{send(json(T.WSCLOSE,id,{code,reason:reason.toString()}));}catch{}dispose(id,true);}}).catch(error=>{if(!s.closed)fail(id,error);});});
    remote.on('error',error=>fail(id,error));
   }else{
    if(typeof meta.method!=='string'||!meta.method.match(/^[A-Z]+$/)||['CONNECT','TRACE','TRACK'].includes(meta.method))throw Error('Invalid method');
    const req=s.req=(url.protocol==='https:'?https:http).request(url,{method:meta.method,headers:{...headers(meta.headers),'accept-encoding':'identity'},agent,signal:s.scope.signal},response=>{
     const h=rawHeaders(response.rawHeaders);let body=response;
     const encoding=String(h['content-encoding']||'').toLowerCase();
     if(['gzip','deflate','br'].includes(encoding)){
      body=encoding==='gzip'?createGunzip():encoding==='br'?createBrotliDecompress():createInflate();
      response.on('error',()=>body.destroy());response.pipe(body);delete h['content-encoding'];delete h['content-length'];
     }
     delete h['transfer-encoding'];delete h.connection;
     try{send(json(T.META,id,{status:response.statusCode,statusText:response.statusMessage,headers:h}));void sendBody(id,s,body);}catch{fail(id);}
    });
    req.on('socket',socket=>{pool.activate(socket);socket.setTimeout(streamTimeout>0?streamTimeout:120000);});
    req.on('error',error=>{if(!s.closed)fail(id,error);});
   }
  }catch(error){fail(id,error);}
 }
 ws.on('message',(raw,binary)=>{
  let id=0;
  try{
   if(!binary)throw Error('Binary frames required');
   const p=parse(raw);id=p.id;
   if(!hello){if(p.type!==T.HELLO||id!==0||![1,2].includes(readJSON(p.payload).version))throw Error('Version mismatch');hello=true;version=readJSON(p.payload).version;send(json(T.HELLO,0,{version,window:WINDOW,chunk:CHUNK,maxMessage:version>=2?maxMessage:CHUNK-1}));
    if(version>=2)heartbeat=new Heartbeat({interval:heartbeatInterval,timeout:heartbeatTimeout,send:n=>send(json(T.PING,0,{sequence:n})),onTimeout:()=>ws.terminate()});return;}
   if(version>=2&&p.id===0&&p.type===T.PONG){heartbeat?.ack(readJSON(p.payload).sequence);return;}
   if(version>=2&&p.id===0&&p.type===T.PING){send(frame(T.PONG,0,p.payload));return;}
   if(p.type===T.OPEN||p.type===T.WSOPEN){open(id,readJSON(p.payload),p.type===T.WSOPEN);return;}
   const s=streams.get(id);if(!s)return;
   if(p.type===T.CANCEL){dispose(id);return;}
   if(p.type===T.CREDIT){s.out.add(readCredit(p.payload));return;}
   if(p.type===T.END&&!s.isWS){if(s.uploadEnded)throw Error('Duplicate end');s.uploadEnded=true;s.req.end();if(s.responseEnded)dispose(id,true);return;}
   if(p.type===T.WSCLOSE&&s.isWS){if(s.closeTimer)return;const close=readJSON(p.payload);if(close.code!==1000&&!(close.code>=3000&&close.code<=4999)||typeof close.reason!=='string'||Buffer.byteLength(close.reason)>123)throw Error('Invalid close');s.remote.close(close.code,close.reason);s.closeTimer=setTimeout(()=>{if(!s.closed){try{send(json(T.WSCLOSE,id,{code:1006,reason:'Close handshake timeout'}));}catch{}dispose(id);}},closeTimeout);s.closeTimer.unref();return;}
   if(p.type===T.DATA&&!s.isWS || (p.type===T.WSMESSAGE&&version===1||p.type===T.WSFRAGMENT&&version>=2)&&s.isWS){
    if(s.uploadEnded||!p.payload.length||p.payload.length>CHUNK||p.payload.length>s.incoming)throw Error('Receive window exceeded');
    s.incoming-=p.payload.length;
    const ack=error=>{if(s.closed)return;if(error){fail(id);return;}s.incoming+=p.payload.length;try{send(credit(id,p.payload.length));}catch{dispose(id);}};
    if(s.isWS){
     touch(s);if(s.remote.readyState!==WebSocket.OPEN)throw engineError('PROTOCOL_ERROR');
     if(version>=2){
      const message=s.assembler.push(p.payload);
      // Credit fragments on bounded assembly, not only at final message (avoids window deadlock).
      if(!message){ack();return;}
      if((s.upstreamBytes||0)+message.bytes.length>maxQueuedBytes)throw engineError('QUEUE_LIMIT');
      upstreamBudget.reserve(message.bytes.length);s.upstreamBytes=(s.upstreamBytes||0)+message.bytes.length;
      s.remote.send(message.bytes,{binary:message.binary},error=>{if(!s.closed){s.upstreamBytes-=message.bytes.length;upstreamBudget.release(message.bytes.length);}ack(error);});
     }else{if(p.payload[0]>1)throw Error('Invalid message kind');s.remote.send(p.payload.subarray(1),{binary:p.payload[0]===1},ack);}
    }
    else s.req.write(p.payload,ack);
    return;
   }
   throw Error('Unexpected frame');
  }catch(error){if(id&&streams.has(id))fail(id,error instanceof EngineError?error:engineError('PROTOCOL_ERROR',error));else ws.close(1002,'Protocol violation');}
 });
 const handshake=setTimeout(()=>{if(!hello)ws.close(1002,'Handshake timeout');},5000);handshake.unref();
 ws.on('close',()=>{clearTimeout(handshake);clearTimeout(drainTimer);heartbeat?.stop();for(const id of streams.keys())dispose(id);pool.destroy();});
 function drain({timeout=5000}={}){if(draining)return;draining=true;if(version>=2&&hello)try{send(json(T.GOAWAY,0,{code:'DRAINING'}));}catch{}if(!streams.size){ws.close(1001,'Drained');return;}drainTimer=setTimeout(()=>{for(const id of streams.keys())dispose(id);ws.close(1001,'Drain timeout');},timeout);drainTimer.unref();}
 return {streams,pool,drain,close:()=>drain()};
}
