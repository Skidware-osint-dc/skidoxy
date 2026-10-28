// TLS cryptography is upstream Epoxy/WASM, not custom crypto. One active operation per worker.
import {engineError} from './reliability.mjs';
import {browserWebSocket} from './rfc6455.mjs';
import init,{EpoxyClient,EpoxyClientOptions} from '/epoxy-tls/epoxy-bundled.js';
let client,gateway,sender,closer,receiveAck;let sendChain=Promise.resolve();
const headers=h=>Object.fromEntries(Object.entries(h||{}).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]));
async function upload(body,limit){
 if(body==null)return null;
 const reader=(body instanceof ReadableStream?body:new Response(body).body).getReader();const parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw engineError('UPLOAD_LIMIT');parts.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;
}
self.addEventListener('unhandledrejection',event=>{event.preventDefault();self.postMessage({type:'error',code:'UPSTREAM_FAILURE',message:'Browser TLS backend rejected an operation'});});
self.onmessage=async({data:m})=>{
 try{
  if(m.type==='received'){receiveAck?.();receiveAck=null;return;}
  if(m.type==='send'){sendChain=sendChain.then(()=>sender(m.data));await sendChain;self.postMessage({type:'sent',bytes:m.bytes});return;}
  if(m.type==='close'){await sendChain;await closer(m.code,m.reason);return;}
  if(!client){gateway=m.gateway;await init();const options=new EpoxyClientOptions();options.wisp_v2=true;options.udp_extension_required=false;options.disable_certificate_validation=false;options.user_agent=navigator.userAgent;options.header_limit=32768;client=new EpoxyClient(gateway,options);}
  if(m.gateway!==gateway)throw Error('Worker gateway isolation violation');
  if(m.type==='request'){
   const remote=new URL(m.url);if(!['http:','https:'].includes(remote.protocol)||remote.username||remote.password||typeof m.method!=='string'||!/^[A-Z]+$/.test(m.method)||['CONNECT','TRACE','TRACK'].includes(m.method))throw engineError('PROTOCOL_ERROR');
   const body=await upload(m.body,m.maxUploadBytes);
   const res=await client.fetch(m.url,{method:m.method,body,headers:headers(m.headers),redirect:'manual'});
   const stream=res.body instanceof ReadableStream?res.body:new Response(res.body).body;
   self.postMessage({type:'response',response:{status:res.status,statusText:res.statusText,headers:res.rawHeaders,body:stream}},[stream]);
  }else if(m.type==='connect'){
   const url=new URL(m.url);const secure=url.protocol==='wss:';
   if(!['ws:','wss:'].includes(url.protocol))throw Error('Invalid WebSocket URL');
   const host=url.hostname;const target=`https://${host}:${url.port|| (secure?443:80)}/`;
   const io=await (secure?client.connect_tls(target):client.connect_tcp(target));
   const socket=await browserWebSocket(io,url,m.protocols,m.headers,{
    onmessage:data=>new Promise(resolve=>{receiveAck=resolve;self.postMessage({type:'message',data},data instanceof ArrayBuffer?[data]:[]);}),
    onclose:(code,reason)=>self.postMessage({type:'closed',code,reason}),
    onerror:()=>self.postMessage({type:'error',code:'UPSTREAM_FAILURE',message:'Browser TLS WebSocket failed'})
   },{maxMessage:m.maxMessage});
   sender=data=>socket.send(data);closer=(code,reason)=>socket.close(code,reason);
   self.postMessage({type:'open',protocol:socket.protocol,extensions:socket.extensions});socket.start();
  }else throw Error('Unknown worker operation');
 }catch(error){const tls=/(cert|tls|ssl|handshake)/i.test(String(error));self.postMessage({type:'error',code:error.code==='UPLOAD_LIMIT'?'UPLOAD_LIMIT':tls?'TLS_FAILURE':'UPSTREAM_FAILURE',message:error.code==='UPLOAD_LIMIT'?'Upload byte limit exceeded':tls?'Browser destination TLS failed':'Browser TLS operation failed'});}
};
