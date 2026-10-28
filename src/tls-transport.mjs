import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import {once} from 'node:events';
import {deadlineDial,engineError,boundedInteger} from '../public/reliability.mjs';

/** Per-gateway-session pool. No certificate verification bypass option is exposed. */
export class GatewayTLS {
 constructor({dial,connectTimeout=30000,handshakeTimeout=15000,idleTimeout=30000,maxSockets=4,maxTotalSockets=16,maxFreeSockets=2,ca}={}){
  if(typeof dial!=='function')throw Error('dial is required');
  for(const [name,value]of Object.entries({connectTimeout,handshakeTimeout,idleTimeout}))boundedInteger(name,value,1,300000);
  boundedInteger('maxSockets',maxSockets,1,64);boundedInteger('maxTotalSockets',maxTotalSockets,1,128);boundedInteger('maxFreeSockets',maxFreeSockets,0,maxSockets);
  this.dial=dial;this.options={connectTimeout,handshakeTimeout,idleTimeout,ca};this.closed=false;this.pending=new Set();this.timers=new Map();this.watched=new WeakSet();
  const opts={keepAlive:true,maxSockets,maxTotalSockets,maxFreeSockets,scheduling:'lifo',timeout:idleTimeout};
  this.http=new http.Agent(opts);this.https=new https.Agent({...opts,maxCachedSessions:0});
  for(const [agent,secure] of [[this.http,false],[this.https,true]]){
   agent.createConnection=(options,callback)=>{
    this.connect(options,secure).then(socket=>callback(null,socket),error=>callback(error));
   };
   agent.on('free',socket=>{this.activate(socket);const timer=setTimeout(()=>{this.timers.delete(socket);socket.destroy();},idleTimeout);timer.unref();this.timers.set(socket,timer);if(!this.watched.has(socket)){this.watched.add(socket);socket.once('close',()=>this.activate(socket));}});
  }
 }
 agent(url){if(this.closed)throw engineError('DRAINING');return ['https:','wss:'].includes(url.protocol)?this.https:this.http;}
 activate(socket){clearTimeout(this.timers.get(socket));this.timers.delete(socket);}
 async connect(options,secure){
  if(this.closed)throw engineError('DRAINING');
  const host=String(options.hostname||options.host).replace(/^\[|\]$/g,''),port=Number(options.port||(secure?443:80));
  const controller=new AbortController();this.pending.add(controller);let socket;
  try{
   socket=await deadlineDial(this.dial,host,port,{timeout:this.options.connectTimeout,signal:controller.signal});
   if(secure){
    const plain=socket;
    socket=tls.connect({socket:plain,host,servername:net.isIP(host)?undefined:host,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,ALPNProtocols:['http/1.1'],...(this.options.ca?{ca:this.options.ca}:{})});
    const abort=()=>socket.destroy(engineError('ABORTED'));controller.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>socket.destroy(engineError('DEADLINE')),this.options.handshakeTimeout);timer.unref();
    try{await once(socket,'secureConnect');}catch(error){throw engineError('TLS_FAILURE',error);}finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
   }
   if(this.closed){socket.destroy();throw engineError('DRAINING');}
   socket.setNoDelay(true);socket.on('timeout',()=>socket.destroy(engineError('DEADLINE')));return socket;
  }catch(error){socket?.destroy();throw error;}
  finally{this.pending.delete(controller);}
 }
 snapshot(){const counts=agent=>({active:Object.values(agent.sockets).reduce((n,s)=>n+s.length,0),idle:Object.values(agent.freeSockets).reduce((n,s)=>n+s.length,0),queued:Object.values(agent.requests).reduce((n,s)=>n+s.length,0)});return {http:counts(this.http),https:counts(this.https),pending:this.pending.size};}
 destroy(){if(this.closed)return;this.closed=true;for(const c of this.pending)c.abort(engineError('DRAINING'));for(const t of this.timers.values())clearTimeout(t);this.timers.clear();this.http.destroy();this.https.destroy();}
}
