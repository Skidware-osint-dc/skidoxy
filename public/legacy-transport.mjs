// bare-mux 2 uses header records; epoxy-transport 3 uses header tuples.
import EpoxyTransport from '/epoxy/index.mjs';
function tuples(headers){
 if(Array.isArray(headers))return headers;
 return Object.entries(headers || {}).flatMap(([k,v])=>(Array.isArray(v)?v:[v]).map(value=>[k,value]));
}
function record(headers){
 const out={};for(const [k,v] of headers){if(out[k]===undefined)out[k]=v;else out[k]=[].concat(out[k],v);}return out;
}
export default class LegacyTransport extends EpoxyTransport {
 constructor(options){super({...options,wisp_v2:true,udp_extension_required:false});}
 async request(remote,method,body,headers,signal){
  if(signal?.aborted)throw signal.reason || Error('Aborted');
  if(body instanceof ReadableStream)body=await new Response(body).arrayBuffer();
  const response=await super.request(remote,method,body,tuples(headers),signal);
  return {...response,headers:record(response.headers)};
 }
 connect(url,protocols,headers,...callbacks){return super.connect(url,protocols,tuples(headers),...callbacks);}
}
