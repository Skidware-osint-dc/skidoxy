import { createGateway } from './gateway.mjs';
import {boundedInteger} from '../public/reliability.mjs';
const port=Number(process.env.PORT || 8080);
for(const name of ['WS_LIFETIME_MS','WS_IDLE_MS'])if(process.env[name]!==undefined)boundedInteger(name,Number(process.env[name]),0,7*24*60*60*1000);
const {server,wss,origin,drain}=createGateway({port,origin:process.env.PUBLIC_ORIGIN || `http://localhost:${port}`,token:process.env.ACCESS_TOKEN,maxClients:Number(process.env.MAX_CLIENTS || 8),tlsMode:process.env.TLS_MODE||'gateway',hmpOptions:{websocketLifetime:Number(process.env.WS_LIFETIME_MS||0),websocketIdle:Number(process.env.WS_IDLE_MS||300000)}});
server.listen(port,'0.0.0.0',()=>console.log(`Skidoxy listening on ${port}; configured origin ${origin}`));
function shutdown(){drain({timeout:5000}).then(()=>process.exit(0));}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
