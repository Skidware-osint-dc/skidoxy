const status = document.querySelector('#status');
let engine,activeTransport;
addEventListener('pagehide',()=>activeTransport?.close());
const ready = (async () => {
  if (!isSecureContext) throw Error('Service workers require HTTPS (or localhost).');
  const { ScramjetController } = $scramjetLoadController();
  engine = new ScramjetController({prefix:'/service/',files:{wasm:'/scram/scramjet.wasm.wasm',all:'/scram/scramjet.all.js',sync:'/scram/scramjet.sync.js'}});
  await engine.init();
  await navigator.serviceWorker.register('/sw.js', {scope:'/'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
  const mux = new BareMux.BareMuxConnection('/baremux/worker.js');
  const config=await fetch('/engine-config',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Unable to load engine configuration');return r.json();});
  const browserTLS=config.tlsMode==='browser';
  const gateway=`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/${browserTLS?'wisp':'hmp'}/`;
  if(browserTLS){
    // Chromium SharedWorkers cannot create nested dedicated workers. Keep the worker
    // pool on the controlling Window and expose it through bare-mux's supported port bridge.
    const {default:BrowserTLS}=await import('/browser-tls-transport.mjs');activeTransport=new BrowserTLS({gateway});await activeTransport.init();
    await mux.setRemoteTransport(activeTransport,'Skidoxy isolated browser TLS');
  }else await mux.setTransport('/transport.mjs',[{gateway}]);
  document.querySelector('#trust').textContent=browserTLS?'Destination TLS runs in an isolated browser worker (Epoxy). No gateway-TLS fallback.':'Destination TLS terminates at the gateway. The gateway can read HTTPS traffic.';
  status.textContent = 'Ready. Onion destinations fail closed if Tor is unavailable.';
})();
ready.catch(e => status.textContent = e.message);
document.querySelector('#browse').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await ready;
    let value = document.querySelector('#url').value.trim();
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP(S) URL without credentials.');
    document.querySelector('iframe')?.remove();
    const frame = engine.createFrame();
    frame.frame.title = 'Proxied website'; document.body.appendChild(frame.frame); frame.go(url.href);
  } catch (err) { status.textContent = err.message; }
});
