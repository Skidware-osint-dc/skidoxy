import {ByteBudget,OperationScope,engineError,EngineError,abortable,Heartbeat,boundedInteger} from './reliability.mjs';
import {fragments,MessageAssembler,MAX_MESSAGE} from './protocol.mjs';
import {T,WINDOW,CHUNK,frame,parse,json,readJSON,credit,readCredit,Credit} from './protocol.mjs';

export default class SkidoxyTransport {
 constructor({gateway,protocolVersion=2,maxMessage=MAX_MESSAGE,maxQueuedBytes=8*1024*1024,requestTimeout=120000,closeTimeout=5000,heartbeatInterval=30000,heartbeatTimeout=10000}={}){
  if(!gateway)throw Error('gateway URL required');
  this.gateway=gateway;this.ready=false;this.streams=new Map();this.nextId=1;this.client_version='skidoxy-hmp/2';this.version=protocolVersion;this.maxMessage=maxMessage;this.requestTimeout=requestTimeout;this.closeTimeout=closeTimeout;this.inboundBudget=new ByteBudget(16*1024*1024);this.outboundBudget=new ByteBudget(maxQueuedBytes);this.draining=false;this.pendingSends=0;boundedInteger('heartbeatInterval',heartbeatInterval,0,7*24*60*60*1000);boundedInteger('heartbeatTimeout',heartbeatTimeout,1,300000);this.heartbeatOptions={interval:heartbeatInterval,timeout:heartbeatTimeout};
 }
 meta(){return {name:'Skidoxy Multiplex Protocol',version:this.version,tlsTermination:'gateway'};}
 async init(){
  if(this.draining)throw engineError('DRAINING');
  if(this.ready)return;if(this.initializing)return this.initializing;
  this.initializing=new Promise((resolve,reject)=>{
   const ws=this.ws=new WebSocket(this.gateway);ws.binaryType='arraybuffer';
   const timer=setTimeout(()=>{reject(Error('Gateway handshake timeout'));ws.close();},10000);
   ws.onopen=()=>this.send(json(T.HELLO,0,{version:this.version}));
   ws.onmessage=event=>{
    try{
     const p=parse(event.data);
     if(!this.ready){if(p.type!==T.HELLO||p.id!==0||readJSON(p.payload).version!==this.version)throw Error('Protocol mismatch');this.maxMessage=Math.min(this.maxMessage,readJSON(p.payload).maxMessage||CHUNK-1);this.ready=true;clearTimeout(timer);if(this.version>=2)this.pulse=new Heartbeat({...this.heartbeatOptions,send:n=>this.send(json(T.PING,0,{sequence:n})),onTimeout:()=>this.failConnection(engineError('HEARTBEAT_TIMEOUT'))});resolve();return;}
     this.receive(p);
    }catch(error){reject(error);ws.close(1002,'Protocol violation');}
   };
   ws.onerror=()=>{if(!this.ready)reject(Error('Gateway connection failed'));};
   ws.onclose=()=>{
    clearTimeout(timer);this.pulse?.stop();this.ready=false;this.initializing=null;reject(Error('Gateway disconnected'));
    for(const id of [...this.streams.keys()])this.fail(id,Error('Gateway disconnected'));
   };
  });
  return this.initializing;
 }
 send(data){if(this.ws?.readyState!==1)throw Error('Gateway not connected');if(this.ws.bufferedAmount>4*1024*1024)throw Error('Gateway send buffer exceeded');this.ws.send(data);}
 allocate(s){if(this.draining)throw engineError('DRAINING');if(this.streams.size>=48)throw Error('Stream limit reached');if(this.nextId>0xffffffff)throw Error('Stream IDs exhausted; recreate transport');const id=this.nextId;this.nextId+=2;this.streams.set(id,s);s.out=new Credit();s.granted=WINDOW;return id;}
 dispose(id){const s=this.streams.get(id);if(!s)return;s.closed=true;s.out.close();s.assembler?.clear();s.scope?.close();clearTimeout(s.closeTimer);s.openReject?.(engineError('DISCONNECTED'));void s.reader?.cancel().catch(()=>{});s.cleanup?.();this.streams.delete(id);}
 fail(id,error){const s=this.streams.get(id);if(!s)return;this.dispose(id);if(s.isWS){try{s.onerror(error.message);}catch{}try{s.onclose(1006,'Transport error');}catch{}}else{s.reject(error);try{s.controller?.error(error);}catch{}}}
 failConnection(error){this.draining=true;this.ready=false;this.pulse?.stop();for(const id of [...this.streams.keys()])this.fail(id,error);this.ws?.close(1000,'Transport failed');}
 close(){this.pulse?.stop();this.draining=true;for(const id of [...this.streams.keys()]){try{this.send(frame(T.CANCEL,id));}catch{}this.fail(id,engineError('ABORTED'));}this.ws?.close(1000,'Closed');}
 receive({type,id,payload}){
  if(id===0&&this.version>=2){if(type===T.PING){this.send(frame(T.PONG,0,payload));return;}if(type===T.GOAWAY){this.draining=true;return;}if(type===T.PONG){this.pulse?.ack(readJSON(payload).sequence);return;}}
  const s=this.streams.get(id);if(!s)return;
  if(type===T.ERROR){this.fail(id,new EngineError(readJSON(payload).code||'UPSTREAM_FAILURE',readJSON(payload).message));return;}
  if(type===T.CREDIT){s.out.add(readCredit(payload));return;}
  if(s.isWS){
   if(type===T.WSOPEN){const m=readJSON(payload);s.openResolve?.();s.openReject=null;try{s.onopen(m.protocol,m.extensions);}catch{this.send(frame(T.CANCEL,id));this.fail(id,engineError('ABORTED'));}return;}
   if(type===T.WSCLOSE){const m=readJSON(payload);this.dispose(id);try{s.onclose(m.code,m.reason);}catch{}return;}
   if(type===T.WSMESSAGE&&this.version===1 || type===T.WSFRAGMENT&&this.version>=2){
    if(!payload.length||payload.length>CHUNK||payload.length>s.granted)throw Error('Invalid message');
    s.granted-=payload.length;
    let message;
    try{message=this.version>=2?s.assembler.push(payload):{bytes:payload.slice(1),binary:payload[0]===1};}
    catch(error){this.send(frame(T.CANCEL,id));this.fail(id,engineError('MESSAGE_LIMIT',error));return;}
    s.granted+=payload.length;this.send(credit(id,payload.length));
    if(message)try{s.onmessage(message.binary?message.bytes.buffer:new TextDecoder('utf-8',{fatal:true}).decode(message.bytes));}
    catch(error){this.send(frame(T.CANCEL,id));this.fail(id,engineError('PROTOCOL_ERROR',error));}
    return;
   }
   throw Error('Unexpected WebSocket frame');
  }
  if(type===T.META){
   if(s.controller)throw Error('Duplicate response metadata');
   const m=readJSON(payload);
   const body=new ReadableStream({
    start:controller=>{s.controller=controller;},
    pull:controller=>{
     const n=Math.floor(controller.desiredSize-s.granted);
     if(n>0&&!s.closed){s.granted+=n;this.send(credit(id,n));}
    },
    cancel:()=>{if(!s.closed)this.send(frame(T.CANCEL,id));void s.reader?.cancel().catch(()=>{});this.dispose(id);}
   },{highWaterMark:WINDOW,size:chunk=>chunk.byteLength});
   s.resolve({...m,body});return;
  }
  if(type===T.DATA){if(!s.controller||!payload.length||payload.length>CHUNK||payload.length>s.granted)throw Error('Receive window exceeded');s.granted-=payload.length;s.controller.enqueue(payload.slice());return;}
  if(type===T.END){if(!s.controller)throw Error('Missing metadata');s.controller.close();if(!s.uploadFinished)this.send(frame(T.CANCEL,id));void s.reader?.cancel().catch(()=>{});this.dispose(id);return;}
  throw Error('Unexpected HTTP frame');
 }
 async request(remote,method,body,headers,signal){
  await abortable(this.init(),signal);if(signal?.aborted)throw signal.reason||Error('Aborted');
  return new Promise((resolve,reject)=>{
   const s={resolve,reject,isWS:false};let id;
   try{
    id=this.allocate(s);s.scope=new OperationScope({timeout:this.requestTimeout,onTimeout:error=>{if(!s.closed){try{this.send(frame(T.CANCEL,id));}catch{}this.fail(id,error);}}});
    const abort=()=>{if(!s.closed){this.send(frame(T.CANCEL,id));void s.reader?.cancel().catch(()=>{});this.fail(id,signal.reason||Error('Aborted'));}};
    signal?.addEventListener('abort',abort,{once:true});s.cleanup=()=>signal?.removeEventListener('abort',abort);
    this.send(json(T.OPEN,id,{url:remote.toString(),method,headers}));
    (async()=>{
     if(body!=null){
      const readable=body instanceof ReadableStream?body:new Response(body).body;
      const reader=s.reader=readable.getReader();
      try{while(!s.closed){const {done,value}=await reader.read();if(done)break;for(let i=0;i<value.length;i+=CHUNK){const part=value.subarray(i,i+CHUNK);await s.out.take(part.length);if(s.closed)return;this.send(frame(T.DATA,id,part));}}}
      finally{reader.releaseLock();}
     }
     if(!s.closed){s.uploadFinished=true;this.send(frame(T.END,id));}
    })().catch(error=>{if(!s.closed){try{this.send(frame(T.CANCEL,id));}catch{}this.fail(id,error);}});
   }catch(error){if(id)this.fail(id,error);else reject(error);}
  });
 }
 connect(url,protocols,requestHeaders,onopen,onmessage,onclose,onerror){
  const s={isWS:true,onopen,onmessage,onclose,onerror};let id,closing=false,closingBeforeOpen=false;
  const opened=this.init().then(()=>{
   if(closingBeforeOpen)return;
   id=this.allocate(s);s.assembler=new MessageAssembler({maxMessage:this.maxMessage,budget:this.inboundBudget});
   s.opened=new Promise((resolve,reject)=>{s.openResolve=resolve;s.openReject=reject;});
   s.opened.catch(()=>{});
   s.scope=new OperationScope({timeout:30000,onTimeout:error=>{if(!s.closed){this.send(frame(T.CANCEL,id));this.fail(id,error);}}});
   const onReady=s.openResolve;s.openResolve=()=>{s.scope.close();onReady();};
   this.send(json(T.WSOPEN,id,{url:url.toString(),protocols,headers:requestHeaders}));
   return s.opened;
  });
  opened.catch(error=>{if(id){if(!s.closed)this.fail(id,error);}else if(!closingBeforeOpen){try{onerror(error.message);}catch{}try{onclose(1006,'Connection failed');}catch{}}});
  let queue=opened;
  const send=data=>{
   if(closing||s.closed)throw engineError('ABORTED');
   const text=typeof data==='string',bytes=text?new TextEncoder().encode(data):data instanceof Blob?null:new Uint8Array(data);
   const size=bytes?.byteLength??data.size;
   if(size>(this.version>=2?this.maxMessage:CHUNK-1))throw engineError('MESSAGE_LIMIT');
   if(this.pendingSends>=256)throw engineError('QUEUE_LIMIT');this.outboundBudget.reserve(size+64);this.pendingSends++;
   queue=queue.then(async()=>{
    if(s.closed||closingBeforeOpen)return;
    const value=bytes||new Uint8Array(await data.arrayBuffer());
    const parts=this.version>=2?fragments(value,!text):[new Uint8Array([text?0:1,...value])];
    for(const payload of parts){await s.out.take(payload.length);if(s.closed)return;this.send(frame(this.version>=2?T.WSFRAGMENT:T.WSMESSAGE,id,payload));}
   }).catch(error=>{if(id&&!s.closed){try{this.send(frame(T.CANCEL,id));}catch{}this.fail(id,error);}}).finally(()=>{this.outboundBudget.release(size+64);this.pendingSends--;});
  };
  const close=(code=1000,reason='')=>{
   if(code!==1000&&!(code>=3000&&code<=4999))throw Error('Invalid close code');
   if(new TextEncoder().encode(reason).length>123)throw Error('Close reason too long');
   if(closing||s.closed)return;closing=true;
   if(!id){closingBeforeOpen=true;try{onclose(1000,'Closed before opening');}catch{}return;}
   s.closeTimer=setTimeout(()=>{if(!s.closed){try{this.send(frame(T.CANCEL,id));}catch{}this.fail(id,engineError('DEADLINE'));}},this.closeTimeout);
   queue.then(()=>{if(!s.closed)this.send(json(T.WSCLOSE,id,{code,reason}));}).catch(error=>this.fail(id,error));
  };
  return [send,close];
 }
}
