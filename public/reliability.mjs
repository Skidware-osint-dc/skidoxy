/** Shared reliability primitives; no automatic retries or request replay. */
export class EngineError extends Error {
 constructor(code,message,{cause,retryable=false}={}){super(message,{cause});this.name='EngineError';this.code=code;this.retryable=retryable;}
}
const messages={UPLOAD_LIMIT:'Upload byte limit exceeded',ABORTED:'Operation cancelled',DEADLINE:'Operation deadline exceeded',TLS_FAILURE:'Destination TLS verification or handshake failed',UPSTREAM_FAILURE:'Upstream operation failed',PROTOCOL_ERROR:'Transport protocol violation',QUEUE_LIMIT:'Transport queue limit exceeded',MESSAGE_LIMIT:'WebSocket message limit exceeded',DRAINING:'Gateway is draining',DISCONNECTED:'Gateway disconnected',HEARTBEAT_TIMEOUT:'Transport heartbeat timed out'};
export function engineError(code,cause){return new EngineError(code,messages[code]||'Transport operation failed',{cause});}
export function publicError(error){const code=error instanceof EngineError?error.code:/CERT|TLS|SSL|ALTNAME/.test(error?.code||'')?'TLS_FAILURE':'UPSTREAM_FAILURE';return {code,message:messages[code]||messages.UPSTREAM_FAILURE,retryable:false};}
export class ByteBudget {
 constructor(limit){if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid byte limit');this.limit=limit;this.used=0;}
 reserve(bytes){if(!Number.isSafeInteger(bytes)||bytes<0||this.used+bytes>this.limit)throw engineError('QUEUE_LIMIT');this.used+=bytes;}
 release(bytes){if(!Number.isSafeInteger(bytes)||bytes<0||bytes>this.used)throw Error('Byte budget underflow');this.used-=bytes;}
}
export class OperationScope {
 constructor({timeout=0,onTimeout,signal}={}){
  boundedInteger('timeout',timeout,0,7*24*60*60*1000);this.controller=new AbortController();this.signal=this.controller.signal;this.cleanups=new Set();this.done=false;
  if(timeout>0){const timer=setTimeout(()=>{const e=engineError('DEADLINE');this.close(e);onTimeout?.(e);},timeout);timer.unref?.();this.add(()=>clearTimeout(timer));}
  if(signal){const abort=()=>this.close(signal.reason||engineError('ABORTED'));signal.addEventListener('abort',abort,{once:true});this.add(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();}
 }
 add(cleanup){if(this.done){cleanup();return ()=>{};}this.cleanups.add(cleanup);return ()=>this.cleanups.delete(cleanup);}
 close(error){if(this.done)return;this.done=true;if(error)this.controller.abort(error);for(const fn of this.cleanups){try{fn();}catch{}}this.cleanups.clear();}
}
/** Time out uncancellable dials, and destroy a socket if it arrives after cancellation. */
export function deadlineDial(dial,host,port,{timeout=30000,signal}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const finish=(error,socket)=>{if(settled){socket?.destroy();return;}settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(socket);};
  const abort=()=>finish(signal.reason||engineError('ABORTED'));
  if(signal?.aborted){abort();return;}
  signal?.addEventListener('abort',abort,{once:true});
  if(timeout>0){timer=setTimeout(()=>finish(engineError('DEADLINE')),timeout);timer.unref?.();}
  Promise.resolve().then(()=>dial(host,port)).then(socket=>finish(null,socket),error=>finish(error));
 });
}
export class Heartbeat {
 constructor({send,onTimeout,interval=30000,timeout=10000}){
  this.pending=null;this.seq=0;this.closed=false;
  if(interval<=0)return;
  this.interval=setInterval(()=>{if(this.pending!==null||this.closed)return;this.pending=++this.seq;try{send(this.pending);}catch{this.stop();onTimeout();return;}this.deadline=setTimeout(()=>{this.stop();onTimeout();},timeout);this.deadline.unref?.();},interval);this.interval.unref?.();
 }
 ack(sequence){if(sequence!==this.pending)return false;clearTimeout(this.deadline);this.pending=null;return true;}
 stop(){this.closed=true;clearInterval(this.interval);clearTimeout(this.deadline);this.pending=null;}
}

export function abortable(promise,signal){
 if(!signal)return promise;if(signal.aborted)return Promise.reject(signal.reason||engineError('ABORTED'));
 return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason||engineError('ABORTED'));};const cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});});
}
export function boundedInteger(name,value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new EngineError('INVALID_CONFIGURATION',`${name} must be an integer between ${min} and ${max}`);return value;}
