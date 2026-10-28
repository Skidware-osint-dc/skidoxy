import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyHost,isPublicIP,createDialer,createSocketClass} from '../src/index.mjs';
const onion='a'.repeat(56)+'.onion';
test('normalizes onion names and permits subdomains',()=>{
 assert.deepEqual(classifyHost(onion.toUpperCase()+'.'),{host:onion,onion:true});
 assert.equal(classifyHost('www.'+onion).onion,true);
});
test('rejects malformed onion and hostname inputs',()=>{
 for(const h of ['abc.onion','localhost','bad/name.com','bad name.com','x@a.com','-bad.example']) assert.throws(()=>classifyHost(h));
});
test('blocks nonpublic IPv4, IPv6 and mapped addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','64:ff9b::7f00:1']) assert.equal(isPublicIP(ip),false,ip);
 assert.equal(isPublicIP('1.1.1.1'),true); assert.equal(isPublicIP('2606:4700:4700::1111'),true);
});
test('onion uses SOCKS hostname without DNS or direct calls',async()=>{
 const socket={};let request;
 const dial=createDialer({resolve:()=>{throw Error('DNS leak');},directConnect:()=>{throw Error('Direct leak');},socksConnect:async options=>{request=options;return {socket};}});
 assert.equal(await dial(onion,80),socket);assert.equal(request.destination.host,onion);assert.equal(request.proxy.type,5);
});
test('Tor outage fails closed',async()=>{
 let direct=false;
 const dial=createDialer({socksConnect:async()=>{throw Error('Tor down');},directConnect:()=>{direct=true;}});
 await assert.rejects(dial(onion,443),/Tor down/);assert.equal(direct,false);
});
test('denies non-web ports before network access',async()=>{
 await assert.rejects(createDialer()(onion,22),/port denied/);
});
test('rejects mixed public/private DNS answers',async()=>{
 const dial=createDialer({resolve:async()=>[{address:'1.1.1.1'},{address:'10.0.0.1'}],directConnect:()=>{throw Error('Must not dial');}});
 await assert.rejects(dial('example.com',443),/Non-public/);
});
test('pending connection is destroyed after stream closes',async()=>{
 let finish;let destroyed=false;
 const Socket=createSocketClass(()=>new Promise(resolve=>{finish=resolve;}));
 const s=new Socket(onion,80);const pending=s.connect();s.close();finish({destroy(){destroyed=true;}});
 await assert.rejects(pending,/closed during connect/);assert.equal(destroyed,true);
});
