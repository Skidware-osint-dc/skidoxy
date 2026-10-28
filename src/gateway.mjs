import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { attachWisp, createDialer } from './index.mjs';
import {Heartbeat,boundedInteger} from '../public/reliability.mjs';
import { attachHMP } from './hmp.mjs';


/** Dependency injection is for embedders/tests; production supplies the policy-enforcing dialer. */
export function createGateway(options={}) {
const root = fileURLToPath(new URL('../', import.meta.url));
const {port=8080,origin=`http://localhost:${port}`,token,dial=createDialer({torHost:process.env.TOR_HOST || '127.0.0.1',torPort:Number(process.env.TOR_PORT || 9050)}),maxClients=8,sessionTTL=8*60*60*1000,tlsMode='gateway',hmpOptions={}}=options;
boundedInteger('maxClients',maxClients,1,256);boundedInteger('port',port,0,65535);boundedInteger('sessionTTL',sessionTTL,1,24*60*60*1000);
if(!['http:','https:'].includes(new URL(origin).protocol))throw Error('PUBLIC_ORIGIN must use HTTP(S)');
if(!['gateway','browser'].includes(tlsMode))throw Error('Invalid TLS mode');
let shuttingDown=false,drainPromise;const connections=new Map();
if (!token || token.length < 32) throw Error('Set ACCESS_TOKEN to at least 32 random characters');
if (new URL(origin).origin !== origin) throw Error('PUBLIC_ORIGIN must be an exact origin without trailing slash');
const secure = origin.startsWith('https:');
const sessions = new Map();
const cookieName = secure ? '__Host-skidoxy' : 'skidoxy';
const authorized = req => (req.headers.cookie || '').split(';').some(c => { const [name,value]=c.trim().split('='); return name===cookieName && (sessions.get(value) || 0)>Date.now(); });
const equal = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
const login = `<!doctype html><meta charset="utf-8"><title>Skidoxy sign in</title><style>body{background:#0b1018;color:#dce5f1;font:18px system-ui;max-width:520px;margin:15vh auto;padding:24px}input,button{padding:14px;margin:8px 0;width:100%;box-sizing:border-box}</style><h1>Skidoxy engine</h1><p>Private gateway. Enter your access token.</p><form method="post" action="/session"><input name="token" type="password" autocomplete="current-password" required aria-label="Access token"><button>Sign in</button></form>`;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
const mounts = [
 ['/scram/',path.join(root,'node_modules/@mercuryworkshop/scramjet/dist')],
 ['/baremux/',path.join(root,'node_modules/@mercuryworkshop/bare-mux/dist')],
 ['/epoxy-tls/',path.join(root,'node_modules/@mercuryworkshop/epoxy-tls/full')],
 ['/epoxy/',path.join(root,'node_modules/@mercuryworkshop/epoxy-transport/dist')],
 ['/',path.join(root,'public')]
];
let attempts = 0;
const reset = setInterval(() => { attempts=0;for(const [id,expires] of sessions)if(expires<=Date.now())sessions.delete(id); },60000); reset.unref();
const server = http.createServer(async (req,res) => {
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Cache-Control','no-store');
 try {
  const url = new URL(req.url, origin);
  if(url.pathname === '/healthz') { res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"status":"alive","tor":"not-checked"}'); return; }
  if(shuttingDown){res.writeHead(503).end('Gateway draining');return;}
  if(req.method === 'POST' && url.pathname === '/session') {
   if(req.headers.origin !== origin) { res.writeHead(403).end(); return; }
   if(++attempts > 30) { res.writeHead(429).end('Try again later'); return; }
   let body=''; for await(const chunk of req) { body+=chunk; if(body.length > 4096) { res.writeHead(413).end(); return; } }
   if(!equal(new URLSearchParams(body).get('token') || '',token)) { res.writeHead(401).end('Invalid token'); return; }
   const session=randomBytes(32).toString('hex');
   if(sessions.size>=256)sessions.delete(sessions.keys().next().value);
   sessions.set(session,Date.now()+sessionTTL);
   res.setHeader('Set-Cookie',`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTTL/1000)}${secure ? '; Secure' : ''}`);
   res.writeHead(303,{Location:'/'}).end(); return;
  }
  if(!authorized(req)) { res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'}).end(login); return; }
  if(url.pathname==='/engine-config'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({tlsMode,protocolVersion:2}));return;}
  if(req.method!=='GET' && req.method!=='HEAD') {res.writeHead(405).end();return;}
  let pathname=decodeURIComponent(url.pathname);
  if(pathname==='/') pathname='/index.html';
  const [prefix,dir]=mounts.find(([prefix])=>pathname.startsWith(prefix));
  const file=path.resolve(dir,pathname.slice(prefix.length));
  if(!file.startsWith(dir+path.sep)) {res.writeHead(403).end();return;}
  // Read small/medium library assets once per request; browser caches immutable dependencies.
  if(prefix!=='/') res.setHeader('Cache-Control','private, max-age=3600');
  const data=await readFile(file);
  res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
  if(pathname==='/sw.js') res.setHeader('Service-Worker-Allowed','/');
  res.writeHead(200); res.end(req.method==='HEAD' ? undefined : data);
 } catch { res.writeHead(404).end('Not found'); }
});
server.requestTimeout=15000; server.headersTimeout=10000;
const wss = new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
server.on('upgrade',(req,socket,head) => {
 if(shuttingDown){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
 if(!['/hmp/', '/wisp/'].includes(req.url) || req.headers.origin !== origin || !authorized(req) || wss.clients.size >= maxClients) {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
 }
 wss.handleUpgrade(req,socket,head,ws => {
  ws.on('error',()=>{});
  const timer=setTimeout(()=>ws.terminate(),8*60*60*1000); timer.unref();
  const pulse=new Heartbeat({send:n=>ws.ping(String(n)),onTimeout:()=>ws.terminate()});
  ws.on('pong',data=>pulse.ack(Number(data.toString())));
  ws.once('close',()=>{clearTimeout(timer);pulse.stop();connections.delete(ws);});
  try{if(req.url === '/hmp/')connections.set(ws,attachHMP(ws,{...hmpOptions,dial}));else connections.set(ws,attachWisp(ws,{dial}));}
  catch{ws.close(1011,'Transport configuration error');}
 });
});
server.once('close',()=>clearInterval(reset));
function drain({timeout=5000}={}){
 if(drainPromise)return drainPromise;shuttingDown=true;
 drainPromise=new Promise(resolve=>{
  let httpClosed=false;
  const finish=()=>{if(httpClosed&&!wss.clients.size){clearTimeout(timer);resolve();}};
  const timer=setTimeout(()=>{for(const ws of wss.clients)ws.terminate();server.closeAllConnections();resolve();},timeout+100);timer.unref();
  for(const [ws,conn]of connections){ws.once('close',finish);if(conn.drain)conn.drain({timeout});else ws.close(1001,'Draining');}
  server.close(()=>{httpClosed=true;finish();});wss.close();finish();
 });return drainPromise;
}

return {server,wss,origin,drain};
}
