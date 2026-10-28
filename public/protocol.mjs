// Skidoxy transport protocol (HMP) 1/2 — independent of Wisp.
export const T = Object.freeze({HELLO:1,OPEN:2,META:3,DATA:4,END:5,CANCEL:6,ERROR:7,CREDIT:8,WSOPEN:9,WSMESSAGE:10,WSCLOSE:11,PING:12,PONG:13,GOAWAY:14,WSFRAGMENT:15});
export const WINDOW=262144, CHUNK=65536, MAX_FRAME=1048576;
const encoder=new TextEncoder(), decoder=new TextDecoder();
export function frame(type,id,payload=new Uint8Array()) {
 if(!(payload instanceof Uint8Array)) payload=new Uint8Array(payload);
 const out=new Uint8Array(9+payload.byteLength), view=new DataView(out.buffer);
 view.setUint8(0,type);view.setUint32(1,id);view.setUint32(5,payload.byteLength);out.set(payload,9);return out;
}
export function parse(raw) {
 const bytes=raw instanceof Uint8Array ? raw : new Uint8Array(raw);
 if(bytes.length<9 || bytes.length>MAX_FRAME) throw Error('Invalid frame size');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.getUint32(5)!==bytes.length-9) throw Error('Invalid payload length');
 return {type:view.getUint8(0),id:view.getUint32(1),payload:bytes.subarray(9)};
}
export function json(type,id,value){return frame(type,id,encoder.encode(JSON.stringify(value)));}
export function readJSON(payload){if(payload.length>32768)throw Error('Metadata too large');return JSON.parse(decoder.decode(payload));}
export function credit(id,n){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n);return frame(T.CREDIT,id,b);}
export function readCredit(b){if(b.length!==4)throw Error('Invalid credit');const n=new DataView(b.buffer,b.byteOffset,4).getUint32(0);if(!n || n>WINDOW)throw Error('Invalid credit');return n;}
export class Credit {
 constructor(){this.value=WINDOW;this.waiters=[];this.error=null;}
 add(n){if(this.value+n>WINDOW)throw Error('Credit overflow');this.value+=n;this.waiters.splice(0).forEach(f=>f());}
 async take(n){while(this.value<n){if(this.error)throw this.error;await new Promise(r=>this.waiters.push(r));}if(this.error)throw this.error;this.value-=n;}
 close(error=Error('Stream closed')){this.error=error;this.waiters.splice(0).forEach(f=>f());}
}

export const MAX_MESSAGE=4*1024*1024;
/** Fragment flags: binary=1, start=2, final=4. A stream carries one ordered message at a time. */
export function* fragments(bytes,binary){
 const size=CHUNK-1;
 if(!bytes.length){yield new Uint8Array([(binary?1:0)|2|4]);return;}
 for(let offset=0;offset<bytes.length;offset+=size){const part=bytes.subarray(offset,offset+size);const payload=new Uint8Array(part.length+1);payload[0]=(binary?1:0)|(offset===0?2:0)|(offset+size>=bytes.length?4:0);payload.set(part,1);yield payload;}
}
export class MessageAssembler {
 constructor({maxMessage=MAX_MESSAGE,budget,maxFragments=1024}={}){this.maxFragments=maxFragments;this.maxMessage=maxMessage;this.budget=budget;this.clear();}
 clear(){if(this.bytes)this.budget?.release(this.bytes);this.parts=[];this.bytes=0;this.active=false;this.binary=false;}
 push(payload){
  if(!payload.length||payload.length>CHUNK||payload[0]&~7)throw Error('Invalid fragment');
  const flags=payload[0],start=Boolean(flags&2),final=Boolean(flags&4),binary=Boolean(flags&1);
  if(start===this.active || !start&&!this.active || this.active&&binary!==this.binary)throw Error('Invalid fragment sequence');
  if(start){this.active=true;this.binary=binary;}
  if(this.parts.length>=this.maxFragments)throw Error('Fragment count exceeded');
  const part=payload.subarray(1);
  if(this.bytes+part.length>this.maxMessage)throw Error('Message size exceeded');
  this.budget?.reserve(part.length);this.bytes+=part.length;this.parts.push(part.slice());
  if(!final)return null;
  const bytes=new Uint8Array(this.bytes);let offset=0;for(const p of this.parts){bytes.set(p,offset);offset+=p.length;}
  const result={bytes,binary:this.binary};this.clear();return result;
 }
}
