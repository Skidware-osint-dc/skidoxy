import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {routedAgent} from '../src/hmp.mjs';
test('gateway TLS rejects an untrusted destination certificate',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'skidoxy-tls-'));
 try{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key.pem','-out',dir+'/cert.pem','-subj','/CN=example.com','-days','1'],{stdio:'ignore'});}catch(e){rmSync(dir,{recursive:true,force:true});t.skip('openssl unavailable');return;}
 const upstream=https.createServer({key:readFileSync(dir+'/key.pem'),cert:readFileSync(dir+'/cert.pem')},(_,res)=>res.end('should not be trusted'));
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const agent=routedAgent(new URL('https://example.com'),async()=>{const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;});
 t.after(()=>{agent.destroy();upstream.closeAllConnections();upstream.close();rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(new Promise((resolve,reject)=>{const req=https.get('https://example.com',{agent},res=>{res.resume();resolve();});req.on('error',reject);}),e=>e.code==='DEPTH_ZERO_SELF_SIGNED_CERT');
});

import {GatewayTLS} from '../src/tls-transport.mjs';
test('pooled gateway TLS verifies SAN, reuses a trusted connection and rejects wrong hostname',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'skidoxy-pool-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key.pem','-out',dir+'/cert.pem','-subj','/CN=trusted.fixture.test','-addext','subjectAltName=DNS:trusted.fixture.test','-days','1'],{stdio:'ignore'});
 const cert=readFileSync(dir+'/cert.pem');const upstream=https.createServer({key:readFileSync(dir+'/key.pem'),cert},(_,res)=>res.end('verified'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 let dials=0;const pool=new GatewayTLS({ca:cert,dial:async()=>{dials++;const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;}});
 t.after(()=>{pool.destroy();upstream.closeAllConnections();upstream.close();rmSync(dir,{recursive:true,force:true});});
 const request=host=>new Promise((resolve,reject)=>{const req=https.get('https://'+host,{agent:pool.agent(new URL('https://'+host))},res=>{res.resume();res.on('end',resolve);});req.on('socket',socket=>pool.activate(socket));req.on('error',reject);});
 for(let i=0;i<5;i++)await request('trusted.fixture.test');assert.equal(dials,1);
 await assert.rejects(request('wrong.fixture.test'),e=>e.code==='TLS_FAILURE'&&e.cause?.code==='ERR_TLS_CERT_ALTNAME_INVALID');
 assert.equal(dials,2);
});
test('gateway TLS handshake deadline closes an unresponsive TCP peer',async t=>{
 const accepted=[];const upstream=net.createServer(s=>accepted.push(s));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const pool=new GatewayTLS({handshakeTimeout:15,dial:async()=>{const s=net.createConnection({host:'127.0.0.1',port:upstream.address().port});await once(s,'connect');return s;}});
 t.after(()=>{pool.destroy();for(const s of accepted)s.destroy();upstream.close();});
 await assert.rejects(pool.connect({host:'example.com',port:443},true),e=>e.code==='TLS_FAILURE'&&e.cause?.code==='DEADLINE');assert.equal(pool.pending.size,0);
});
