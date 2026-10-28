import {engineError,boundedInteger} from './reliability.mjs';
/** Each leased worker owns exactly one HTTP body or website WebSocket. */
export class WorkerPool {
 constructor({create,max=2,maxQueued=32}={}){boundedInteger('maxWorkers',max,1,8);boundedInteger('maxQueued',maxQueued,0,128);this.create=create;this.max=max;this.maxQueued=maxQueued;this.all=new Set();this.idle=[];this.waiters=[];this.closed=false;}
 acquire(signal){
  if(this.closed)return Promise.reject(engineError('DRAINING'));
  if(signal?.aborted)return Promise.reject(signal.reason||engineError('ABORTED'));
  if(this.idle.length)return Promise.resolve(this.lease(this.idle.pop()));
  if(this.all.size<this.max){try{const worker=this.create();this.all.add(worker);return Promise.resolve(this.lease(worker));}catch(e){return Promise.reject(e);}}
  if(this.waiters.length>=this.maxQueued)return Promise.reject(engineError('QUEUE_LIMIT'));
  return new Promise((resolve,reject)=>{const entry={resolve,reject,signal};entry.abort=()=>{const i=this.waiters.indexOf(entry);if(i>=0)this.waiters.splice(i,1);reject(signal.reason||engineError('ABORTED'));};signal?.addEventListener('abort',entry.abort,{once:true});this.waiters.push(entry);});
 }
 lease(worker){let released=false;return {worker,release:(healthy=true)=>{if(released)return;released=true;worker.onmessage=null;worker.onerror=null;if(!healthy||this.closed){this.all.delete(worker);worker.terminate();}else this.idle.push(worker);this.pump();}};}
 pump(){while(!this.closed&&this.waiters.length&&(this.idle.length||this.all.size<this.max)){const w=this.waiters.shift();w.signal?.removeEventListener('abort',w.abort);this.acquire(w.signal).then(w.resolve,w.reject);}}
 close(){if(this.closed)return;this.closed=true;for(const w of this.waiters){w.signal?.removeEventListener('abort',w.abort);w.reject(engineError('DRAINING'));}this.waiters=[];for(const worker of this.all)worker.terminate();this.all.clear();this.idle=[];}
}
