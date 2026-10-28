import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import ipaddr from 'ipaddr.js';
import { SocksClient } from 'socks';
import { server as wisp, packet, logging } from '@mercuryworkshop/wisp-js/server';

logging.set_level(logging.ERROR); // Never log destination hostnames by default.
const onionPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z2-7]{56}\.onion$/;
export function classifyHost(raw) {
  const host = raw.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || /[\s/@\\\x00-\x1f]/.test(host)) throw Error('Invalid hostname');
  if (host.endsWith('.onion')) {
    if (!onionPattern.test(host)) throw Error('Only v3 onion hostnames are supported');
    return { host, onion: true };
  }
  if (!ipaddr.isValid(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+$/.test(host)) throw Error('Invalid public hostname');
  return { host, onion: false };
}
export function isPublicIP(address) {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  return ip.range() === 'unicast';
}
export function createDialer({ torHost = '127.0.0.1', torPort = 9050, timeout = 30000,
  ports = [80, 443], resolve = lookup, socksConnect = SocksClient.createConnection,
  directConnect = net.createConnection } = {}) {
  return async function dial(rawHost, port) {
    const {host, onion} = classifyHost(rawHost);
    if (!Number.isInteger(port) || !ports.includes(port)) throw Error('Destination port denied');
    if (onion) {
      // Hostname is handed verbatim to SOCKS5. NEVER resolve onion names locally.
      const { socket } = await socksConnect({ command: 'connect',
        proxy: { host: torHost, port: torPort, type: 5 },
        destination: { host, port }, timeout });
      return socket; // No catch-and-retry via direct transport.
    }
    const addresses = await resolve(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => !isPublicIP(a.address))) throw Error('Non-public destination denied');
    // Pin the validated numeric address: no second DNS lookup / rebinding window.
    const socket = directConnect({ host: addresses[0].address, port });
    socket.setTimeout(timeout, () => socket.destroy(Error('Connect timeout')));
    try { await once(socket, 'connect'); socket.setTimeout(0); return socket; }
    catch (e) { socket.destroy(); throw e; }
  };
}

export function createSocketClass(dial, { idleTimeout = 120000 } = {}) {
  return class RoutedSocket {
    constructor(hostname, port) { this.hostname = hostname; this.port = port; this.closed = false; }
    async connect() {
      const socket = await dial(this.hostname, this.port);
      if (this.closed) { socket.destroy(); throw Error('Stream closed during connect'); }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setTimeout(idleTimeout, () => socket.destroy());
      socket.on('error', () => {});
      this.iterator = socket[Symbol.asyncIterator]();
    }
    async recv() {
      try { const item = await this.iterator.next(); return item.done ? null : item.value; }
      catch (error) { if (this.closed) return null; throw error; }
    }
    async send(data) {
      if (!this.socket || this.closed) throw Error('Closed stream');
      await new Promise((resolve, reject) => this.socket.write(data, e => e ? reject(e) : resolve()));
    }
    pause() {} // Node readable async iterator provides bounded stream buffering.
    resume() {}
    close() { this.closed = true; this.socket?.destroy(); }
  };
}

/** Attach one accepted websocket. Caller owns authentication and Origin validation. */
export function attachWisp(ws, { dial = createDialer(), maxStreams = 48, maxStreamsPerHost = 12 } = {}) {
  const Socket = createSocketClass(dial);
  class Connection extends wisp.ServerConnection {
    // Deliberately replace upstream filtering: it resolves hostnames, including onions.
    create_stream(id, type, hostname, port) {
      const reject = reason => this.ws.send(new packet.WispPacket({type: packet.ClosePayload.type,
        stream_id: id, payload: new packet.ClosePayload({reason})}));
      if (this.streams[id]) { ws.close(1008, 'Duplicate stream'); return; }
      if (type !== packet.stream_types.TCP) { void reject(packet.close_reasons.HostBlocked); return; }
      const streams = Object.values(this.streams);
      if (streams.length >= maxStreams || streams.filter(s => s.socket.hostname === hostname).length >= maxStreamsPerHost) {
        void reject(packet.close_reasons.ConnThrottled); return;
      }
      const stream = new wisp.ServerStream(id, this, new Socket(hostname, port));
      this.streams[id] = stream;
      stream.setup().catch(() => this.close_stream(id, packet.close_reasons.NetworkError));
    }
  }
  const conn = new Connection(ws, '/wisp/', { TCPSocket: Socket, wisp_version: 2, wisp_extensions: [] });
  conn.setup().then(() => conn.run()).catch(() => conn.cleanup());
  return conn;
}
