import {WorkerPool} from './worker-pool.mjs';
import {OperationScope,ByteBudget,engineError,EngineError,boundedInteger} from './reliability.mjs';
/** Browser destination TLS. No transparent fallback to gateway TLS. */
export default class BrowserTLSTransport {
 constructor({gateway,maxWorkers=2,maxWebSocketWorkers=2,maxQueued=32,requestTimeout=120000,handshakeTimeout=30000,closeTimeout=5000,maxUploadBytes=8*1024*1024,maxMessage=4*1024*1024,maxQueuedBytes=8*1024*1024}={}){
  if(!gateway)throw Error('gateway required');for(const [name,value]of Object.entries({requestTimeout,handshakeTimeout,closeTimeout}))boundedInteger(name,value,1,7*24*60*60*1000);boundedInteger('maxUploadBytes',maxUploadBytes,1,64*1024*1024);boundedInteger('maxMessage',maxMessage,1,16*1024*1024);this.gateway=gateway;this.ready=false;this.client_version='skidoxy-browser-tls/1';this.options={requestTimeout,handshakeTimeout,closeTimeout,maxUploadBytes,maxMessage};this.active=new Set();this.budget=new ByteBudget(maxQueuedBytes);
  const create=()=>new Worker(new URL('./browser-tls-worker.mjs',import.meta.url),{type:'module'});
  this.pool=new WorkerPool({max:maxWorkers,maxQueued,create});this.socketPool=new WorkerPool({max:maxWebSocketWorkers,maxQueued,create});
 }
 async init(){if(typeof Worker==='undefined')throw Error('Dedicated module workers are required');this.ready=true;}
 meta(){return {name:'Skidoxy isolated browser TLS',tlsTermination:'browser',cryptoBackend:'Epoxy/WASM',wireProtocol:'Wisp v2'};}
 async request(remote,method,body,headers,signal){
  if(!this.ready)await this.init();
  if(body!=null){
   const size=typeof body==='string'?(body.length>this.options.maxUploadBytes?Infinity:new TextEncoder().encode(body).length):body.byteLength??body.size;
   if(size>this.options.maxUploadBytes)throw engineError('UPLOAD_LIMIT');
   if(!(body instanceof ReadableStream)){const encoded=new Response(body);const type=encoded.headers.get('content-type');headers={...headers};if(type&&!Object.keys(headers).some(k=>k.toLowerCase()==='content-type'))headers['Content-Type']=type;body=encoded.body;}
  }
  const scope=new OperationScope({timeout:this.options.requestTimeout,signal});
  let lease,done=false,reader;
  const cleanup=healthy=>{if(done)return;done=true;scope.close(healthy?undefined:engineError('ABORTED'));this.active.delete(cancel);lease?.release(healthy);};
  let rejectOperation,bodyController;
  const cancel=error=>{if(done)return;cleanup(false);rejectOperation?.(error);try{bodyController?.error(error);}catch{}void reader?.cancel().catch(()=>{});};
  this.active.add(cancel);
  scope.signal.addEventListener('abort',()=>cancel(scope.signal.reason),{once:true});
  try{
   lease=await this.pool.acquire(scope.signal);if(scope.signal.aborted){lease.release(false);throw scope.signal.reason;}
   const worker=lease.worker;
   return await new Promise((resolve,reject)=>{
    rejectOperation=reject;
    worker.onerror=()=>cancel(engineError('DISCONNECTED'));
    worker.onmessage=({data:m})=>{
     if(m.type==='error'){cancel(new EngineError(m.code,m.message));return;}
     if(m.type!=='response')return;
     reader=m.response.body.getReader();
     const stream=new ReadableStream({start:c=>{bodyController=c;},pull:async c=>{try{const {done:ended,value}=await reader.read();if(ended){c.close();cleanup(true);}else c.enqueue(value);}catch(error){cancel(error);}},cancel:()=>cancel(engineError('ABORTED'))},{highWaterMark:0});
     resolve({...m.response,body:stream});
    };
    const transfer=body instanceof ReadableStream?[body]:[];
    worker.postMessage({type:'request',gateway:this.gateway,url:remote.toString(),method,body,headers,maxUploadBytes:this.options.maxUploadBytes},transfer);
   });
  }catch(error){cleanup(false);throw error;}
 }
 connect(url,protocols,headers,onopen,onmessage,onclose,onerror){
  const scope=new OperationScope({timeout:this.options.handshakeTimeout});let lease,done=false,closing=false,opened=false,closeTimer;
  const pending=[];
  const cleanup=()=>{if(done)return;done=true;clearTimeout(closeTimer);scope.close(engineError('ABORTED'));lease?.release(false);this.active.delete(fail);for(const size of pending)this.budget.release(size);pending.length=0;};
  const fail=error=>{if(done)return;cleanup();try{onerror(error.message);}catch{}try{onclose(1006,'Browser TLS operation failed');}catch{}};
  this.active.add(fail);scope.signal.addEventListener('abort',()=>fail(scope.signal.reason),{once:true});
  this.socketPool.acquire(scope.signal).then(value=>{
   lease=value;if(done){lease.release(false);return;}
   const worker=lease.worker;worker.onerror=()=>fail(engineError('DISCONNECTED'));
   worker.onmessage=({data:m})=>{
    if(done)return;
    if(m.type==='open'){opened=true;scope.close();try{onopen(m.protocol,m.extensions);}catch(error){fail(error);}return;}
    if(m.type==='sent'){const size=pending.shift();if(size!==undefined)this.budget.release(size);return;}
    if(m.type==='message'){const size=typeof m.data==='string'?new TextEncoder().encode(m.data).length:m.data.byteLength||m.data.size||0;if(size>this.options.maxMessage){fail(engineError('MESSAGE_LIMIT'));return;}try{onmessage(m.data);if(!done)worker.postMessage({type:'received'});}catch(error){fail(error);}return;}
    if(m.type==='closed'){cleanup();try{onclose(m.code,m.reason);}catch{}return;}
    if(m.type==='error')fail(new EngineError(m.code,m.message));
   };
   worker.postMessage({type:'connect',gateway:this.gateway,url:url.toString(),protocols,headers,maxMessage:this.options.maxMessage});
  }).catch(fail);
  return [data=>{
   if(done||closing||!opened)throw engineError('ABORTED');const size=typeof data==='string'?new TextEncoder().encode(data).length:data.byteLength??data.size;
   if(size>this.options.maxMessage)throw engineError('MESSAGE_LIMIT');if(pending.length>=256)throw engineError('QUEUE_LIMIT');this.budget.reserve(size+64);pending.push(size+64);
   try{lease.worker.postMessage({type:'send',data,bytes:size});}catch(error){fail(error);}
  },(code=1000,reason='')=>{
   if(code!==1000&&!(code>=3000&&code<=4999)||new TextEncoder().encode(reason).length>123)throw Error('Invalid WebSocket close');
   if(done||closing)return;closing=true;
   if(!opened){cleanup();try{onclose(1000,'Closed before open');}catch{}return;}
   closeTimer=setTimeout(()=>fail(engineError('DEADLINE')),this.options.closeTimeout);lease.worker.postMessage({type:'close',code,reason});
  }];
 }
 close(){for(const cancel of [...this.active])cancel(engineError('ABORTED'));this.pool.close();this.socketPool.close();this.ready=false;}
}
