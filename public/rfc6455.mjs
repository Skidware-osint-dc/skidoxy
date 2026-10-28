import {Heartbeat,engineError} from './reliability.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function validCloseCode(code){return code>=1000&&code<=4999&&![1004,1005,1006,1015].includes(code)&&!(code>=1016&&code<=2999);}
export function clientFrame(opcode,data=new Uint8Array(),fin=true){
 const length=data.byteLength,extra=length<126?0:length<65536?2:8;
 const output=new Uint8Array(6+extra+length),view=new DataView(output.buffer);output[0]=(fin?128:0)|opcode;output[1]=128|(extra===0?length:extra===2?126:127);
 if(extra===2)view.setUint16(2,length);if(extra===8){view.setUint32(2,0);view.setUint32(6,length);}
 const mask=crypto.getRandomValues(new Uint8Array(4));output.set(mask,2+extra);for(let i=0;i<length;i++)output[6+extra+i]=data[i]^mask[i%4];return output;
}
class Bytes {
 constructor(stream){this.reader=stream.getReader();this.chunk=new Uint8Array();this.offset=0;}
 async take(n){const result=new Uint8Array(n);let offset=0;while(offset<n){if(this.offset===this.chunk.length){const next=await this.reader.read();if(next.done)throw engineError('DISCONNECTED');this.chunk=next.value;this.offset=0;}const count=Math.min(n-offset,this.chunk.length-this.offset);result.set(this.chunk.subarray(this.offset,this.offset+count),offset);this.offset+=count;offset+=count;}return result;}
 async header(limit=32768){const bytes=[];while(bytes.length<limit){bytes.push((await this.take(1))[0]);const n=bytes.length;if(n>=4&&bytes[n-4]===13&&bytes[n-3]===10&&bytes[n-2]===13&&bytes[n-1]===10)return decoder.decode(new Uint8Array(bytes));}throw engineError('PROTOCOL_ERROR');}
 cancel(){void this.reader.cancel().catch(()=>{});}
}
/** RFC6455 framing over an already-established browser TCP/TLS stream; no custom cryptography. */
export async function browserWebSocket(io,url,protocols=[],requestHeaders={},callbacks={},options={}){
 const {maxMessage=4*1024*1024,heartbeatInterval=30000,heartbeatTimeout=10000,maxFragments=1024}=options;
 const reader=new Bytes(io.read),writer=io.write.getWriter();let ended=false,closeSent=false,writeQueue=Promise.resolve(),pulse;
 const write=(opcode,bytes,fin=true)=>{writeQueue=writeQueue.then(()=>writer.write(clientFrame(opcode,bytes,fin)));return writeQueue;};
 const end=(code,reason,error)=>{if(ended)return;ended=true;pulse?.stop();reader.cancel();void writer.abort(error||engineError('ABORTED')).catch(()=>{});if(error)try{callbacks.onerror?.(error);}catch{}try{callbacks.onclose?.(code,reason);}catch{}};
 let protocol='';
 try{
 if(url.username||url.password||url.hash||url.href.length>8192)throw engineError('PROTOCOL_ERROR');
 const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
 const headers=Object.create(null);for(const [name,raw]of Object.entries(requestHeaders)){
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))throw engineError('PROTOCOL_ERROR');
  if(/^(host|connection|upgrade|sec-websocket-.*|proxy-.*|content-length|transfer-encoding)$/i.test(name))continue;
  const value=Array.isArray(raw)?raw.join(name.toLowerCase()==='cookie'?'; ':', '):String(raw);if(/[\r\n\0]/.test(value))throw engineError('PROTOCOL_ERROR');headers[name]=value;
 }
 if(protocols.some(p=>!p||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p))||new Set(protocols).size!==protocols.length)throw engineError('PROTOCOL_ERROR');
 let request=`GET ${url.pathname||'/'}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
 if(protocols.length)request+=`Sec-WebSocket-Protocol: ${protocols.join(', ')}\r\n`;
 for(const[k,v]of Object.entries(headers))request+=`${k}: ${v}\r\n`;
 const requestBytes=encoder.encode(request+'\r\n');if(requestBytes.length>32768)throw engineError('PROTOCOL_ERROR');await writer.write(requestBytes);
 const response=await reader.header(),lines=response.split('\r\n'),status=lines.shift();const parsed=Object.create(null);
 for(const line of lines){if(!line)continue;const index=line.indexOf(':');if(index<1)throw engineError('PROTOCOL_ERROR');const name=line.slice(0,index).toLowerCase();if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))throw engineError('PROTOCOL_ERROR');const value=line.slice(index+1).trim();parsed[name]=parsed[name]===undefined?value:parsed[name]+', '+value;}
 const accept=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1',encoder.encode(key+GUID)))));
 if(!/^HTTP\/1\.1 101(?: |$)/.test(status)||parsed.upgrade?.toLowerCase()!=='websocket'||!parsed.connection?.toLowerCase().split(',').map(s=>s.trim()).includes('upgrade')||parsed['sec-websocket-accept']!==accept||parsed['sec-websocket-extensions'])throw engineError('PROTOCOL_ERROR');
 protocol=parsed['sec-websocket-protocol']||'';if(protocol&&!protocols.includes(protocol))throw engineError('PROTOCOL_ERROR');
 }catch(error){reader.cancel();await writer.abort(error).catch(()=>{});throw error;}
 async function send(data){
  if(ended||closeSent)throw engineError('ABORTED');const binary=typeof data!=='string';const bytes=binary?(data instanceof Blob?new Uint8Array(await data.arrayBuffer()):new Uint8Array(data)):encoder.encode(data);
  if(bytes.length>maxMessage)throw engineError('MESSAGE_LIMIT');
  if(!bytes.length){await write(binary?2:1,bytes);return;}
  for(let offset=0;offset<bytes.length;offset+=65536){if(ended)throw engineError('DISCONNECTED');await write(offset===0?(binary?2:1):0,bytes.subarray(offset,offset+65536),offset+65536>=bytes.length);}
 }
 async function close(code=1000,reason=''){
  if(!validCloseCode(code))throw engineError('PROTOCOL_ERROR');const text=encoder.encode(reason);if(text.length>123)throw engineError('PROTOCOL_ERROR');if(ended||closeSent)return;closeSent=true;
  const bytes=new Uint8Array(text.length+2);new DataView(bytes.buffer).setUint16(0,code);bytes.set(text,2);await write(8,bytes);
 }
 async function readLoop(){
  let parts=[],size=0,messageOpcode=0;
  try{
   for(;;){
    const header=await reader.take(2),fin=Boolean(header[0]&128),opcode=header[0]&15,control=opcode>=8;
    if(header[0]&112||header[1]&128||![0,1,2,8,9,10].includes(opcode)||control&&!fin)throw engineError('PROTOCOL_ERROR');
    let length=header[1]&127;
    if(length===126){const b=await reader.take(2);length=new DataView(b.buffer).getUint16(0);if(length<126)throw engineError('PROTOCOL_ERROR');}
    else if(length===127){const b=await reader.take(8),v=new DataView(b.buffer);if(v.getUint32(0)!==0)throw engineError('MESSAGE_LIMIT');length=v.getUint32(4);if(length<65536)throw engineError('PROTOCOL_ERROR');}
    if(control&&length>125||length>maxMessage)throw engineError('MESSAGE_LIMIT');const payload=await reader.take(length);
    if(opcode===9){await write(10,payload);continue;}if(opcode===10){pulse?.ack(Number(new TextDecoder().decode(payload)));continue;}
    if(opcode===8){let code=1005,reason='';if(length===1)throw engineError('PROTOCOL_ERROR');if(length>=2){code=new DataView(payload.buffer).getUint16(0);if(!validCloseCode(code))throw engineError('PROTOCOL_ERROR');reason=decoder.decode(payload.subarray(2));}if(!closeSent){closeSent=true;await write(8,payload);}end(code,reason);return;}
    if(closeSent)continue;
    if(opcode===0&&!messageOpcode || opcode!==0&&messageOpcode)throw engineError('PROTOCOL_ERROR');if(opcode!==0)messageOpcode=opcode;
    if(parts.length>=maxFragments||size+length>maxMessage)throw engineError('MESSAGE_LIMIT');parts.push(payload);size+=length;
    if(fin){const value=new Uint8Array(size);let offset=0;for(const part of parts){value.set(part,offset);offset+=part.length;}await callbacks.onmessage?.(messageOpcode===1?decoder.decode(value):value.buffer);parts=[];size=0;messageOpcode=0;}
   }
  }catch(error){end(1006,'Browser WebSocket transport failed',error);}
 }
 return {protocol,extensions:'',send,close,start(){pulse=new Heartbeat({interval:heartbeatInterval,timeout:heartbeatTimeout,send:n=>{void write(9,encoder.encode(String(n))).catch(error=>end(1006,'Heartbeat failed',error));},onTimeout:()=>end(1006,'Heartbeat timeout',engineError('HEARTBEAT_TIMEOUT'))});void readLoop();}};
}
