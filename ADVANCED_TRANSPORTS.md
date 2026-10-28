# Advanced transport and reliability API — v0.3.0

## 1. Reliability handlers

`public/reliability.mjs` is shared between Node and browser code:

| Handler | Purpose |
|---|---|
| `EngineError`, `engineError`, `publicError` | Typed SDK errors, generic/redacted wire messages and conservative `retryable:false` |
| `OperationScope` | Deadline/AbortSignal ownership and idempotent cleanup |
| `ByteBudget` | Explicit reserve/release accounting; overflow is rejected |
| `deadlineDial` | Bound an asynchronous dial; destroy a socket that arrives after cancellation/deadline |
| `abortable` | Cancel one waiter without cancelling a shared initialization |
| `Heartbeat` | Nonce/sequence-matched liveness probes with a separate response deadline |
| `boundedInteger` | Reject invalid safety-limit configuration instead of disabling timers accidentally |

Representative codes: `ABORTED`, `DEADLINE`, `TLS_FAILURE`, `UPSTREAM_FAILURE`, `PROTOCOL_ERROR`, `QUEUE_LIMIT`, `MESSAGE_LIMIT`, `UPLOAD_LIMIT`, `DRAINING`, `DISCONNECTED`, `HEARTBEAT_TIMEOUT`, `INVALID_CONFIGURATION`.

Wire errors do not include destination names, TLS internals, tokens or stack traces. Local error `cause` can retain diagnostic context for a trusted caller. Native `Response` readers and framework message-port error cloning can normalize exceptions, so do not assume every proxied website sees the original custom error fields. There is no automatic retry, including for GET: the engine cannot prove that a failed request was never committed.

```js
import { OperationScope, engineError } from './public/reliability.mjs';
const scope = new OperationScope({
  timeout: 15_000,
  onTimeout: error => handleFailure(error),
  signal: callerAbortSignal,
});
scope.add(() => removeOwnedListeners());
// Complete successfully without aborting a pooled socket:
scope.close();
// Or cancel owned work:
// scope.close(engineError('ABORTED'));
```

Uncancellable system DNS/SOCKS operations may still finish in the background after a deadline; late sockets are destroyed. This is bounded caller lifetime/resource cleanup, not a claim that the OS cancels every underlying syscall immediately.

## 2. Gateway TLS

`GatewayTLS` owns HTTP and HTTPS agents **per authenticated HMP connection**, not a global cross-user pool.

```js
import { GatewayTLS } from './src/tls-transport.mjs';
const pool = new GatewayTLS({
  dial,                       // use createDialer() in production
  connectTimeout: 30_000,
  handshakeTimeout: 15_000,
  idleTimeout: 30_000,
  maxSockets: 4,               // per origin per agent
  maxTotalSockets: 16,         // each of HTTP and HTTPS agents
  maxFreeSockets: 2,
  // ca: trustedOrganizationCA // optional explicit Node trust anchors, not a bypass
});
const agent = pool.agent(new URL('https://example.com/'));
// If embedding it directly, call pool.activate(socket) on request socket assignment
// so an old free-socket eviction timer does not follow an active request.
const stats = pool.snapshot();
pool.destroy();
```

The pool always uses TLS 1.2–1.3, `rejectUnauthorized:true`, Node's hostname verifier, SNI for DNS names and HTTP/1.1 ALPN. No `insecure` or certificate-validation bypass option is exposed. Destination policy and pinning apply whenever a new socket is dialled. Reuse stays on the established numeric peer. HTTP cookies remain request headers; the pool is not a cookie jar. Upgraded website WebSockets are not reused as HTTP connections.

HMP owns this pool automatically and destroys it when its gateway connection closes. In-flight request cancellation destroys that request's socket as needed; a normal completed HTTP response is not forcibly destroyed, allowing keep-alive reuse. TLS session-ticket caching is not enabled by this adapter. Idle pools can reduce setup work, but no comparative speed claim is made.

## 3. Browser destination TLS

Set `TLS_MODE=browser` before starting the reference server. Its authenticated `/engine-config` response selects the mode. The browser uses the **Wisp v2 TCP compatibility endpoint**, not HMP HTTP frames, for this path.

```js
import BrowserTLS from './public/browser-tls-transport.mjs';
const transport = new BrowserTLS({
  gateway: 'wss://proxy.example.com/wisp/',
  maxWorkers: 2,                // HTTP pool
  maxWebSocketWorkers: 2,       // separate website socket pool
  maxQueued: 32,                // per pool
  requestTimeout: 120_000,      // queue + operation + response body
  handshakeTimeout: 30_000,     // website WebSocket acquisition/handshake
  closeTimeout: 5_000,
  maxUploadBytes: 8 * 1024 * 1024,
  maxMessage: 4 * 1024 * 1024,
  maxQueuedBytes: 8 * 1024 * 1024,
});
await transport.init();
// Chromium SharedWorkers cannot create dedicated workers here. Run this instance
// in the controlling Window and use bare-mux's supported remote transport API:
await mux.setRemoteTransport(transport, 'Skidoxy isolated browser TLS');
```

Do **not** load this class with `mux.setTransport()` inside the bare-mux SharedWorker. The reference app establishes the correct bridge automatically and closes its transport on pagehide. Keep the controller page open. Reload/restart for a different trust mode; do not use active-page hot switching as a failover strategy.

Each worker owns one active HTTP body or website socket. HTTP workers can be reused only after the body is consumed. Cancellation/body cancellation/deadline retires the leased worker, closing that operation's TLS/TCP state, while other leases survive. A long-lived website socket cannot occupy all HTTP worker capacity because the pools are separate. A closed website socket's worker is retired, not reused.

`browser-tls-worker.mjs` loads the pinned Epoxy TLS/WASM directly, with certificate validation explicitly enabled. No new TLS cryptography was written. HTTPS uses Epoxy fetch; WSS uses Epoxy's verified raw TLS stream, with our independent RFC6455 framing above it. Plain HTTP/WS is still visible to the relay. Browser TLS does not defend against malicious frontend code served by the operator, nor does it eliminate origin/fingerprinting risks from the rewriter.

Uploads are buffered up to a known 8 MiB default before the Epoxy fetch. Unknown-length streams are counted while reading and rejected if they exceed the cap. Workers and their upstream libraries have their own runtime memory; the engine's budgets are not a measurement of the entire browser's RSS. Body streams must be consumed or cancelled to return a lease; the operation deadline is the final guard for abandoned bodies.

## 4. Advanced website WebSockets

### Gateway TLS / HMP/2

`public/transport.mjs` implements bare-mux. Default protocol version is 2. Client/server have byte credits, message fragmentation/reassembly, per-stream and aggregate queue budgets, at most 256 outstanding client send operations, and a 1024-fragment cap. Metadata and control traffic are separate from data credit. Current default message cap is 4 MiB; larger supported policies require matching limits on both ends.

```js
await mux.setTransport('/transport.mjs', [{
  gateway: 'wss://proxy.example.com/hmp/',
  protocolVersion: 2,
  maxMessage: 4 * 1024 * 1024,
  maxQueuedBytes: 8 * 1024 * 1024,
}]);
```

HMP/1 is still selectable with `protocolVersion:1`, but retains its small-message limit and no v2 features. There is no downgrade negotiation or automatic retry after version failure.

### Browser TLS / RFC6455

`public/rfc6455.mjs` implements the website WebSocket handshake and framing over Epoxy TCP/TLS:

- Exact 101/Upgrade/Connection/Sec-WebSocket-Accept validation; requested subprotocol validation; no compression/extensions negotiated.
- Client masking via platform cryptographic randomness, strict lengths/flags/opcodes, server-mask rejection and UTF-8 validation.
- Ordered fragmented binary/text writes; bounded reassembly; message and fragment-count caps, including empty-fragment floods.
- Ping/pong and heartbeat deadlines, peer close-code/reason validation, and valid close echo.
- The worker serializes complete outbound messages so fragments from two messages cannot interleave. It waits for a parent delivery acknowledgement before reading another complete incoming message.

The HTTP handshake's SHA-1 accept digest is the RFC6455 standard challenge check, not a new encryption/authentication scheme. TLS is still Epoxy's implementation. Compression, reconnect/replay and transparent website-session resume are not provided.

### Backpressure boundary

HMP credits are returned when bounded assembly or transport writes permit progress. Browser-TLS delivery acknowledgements follow the parent's callback. Neither can measure when an ultimate website/application has processed a message after framework message-port delivery. The implementation bounds its own queues, but does not promise a hard bound for every upstream library or browser internals under a malicious authenticated peer.

## 5. Lifetimes, liveness and shutdown

Reference settings:

| Setting | Default |
|---|---:|
| HMP HTTP operation deadline | 120 seconds |
| HMP WebSocket absolute lifetime | Disabled (`0`) |
| HMP WebSocket application-idle timeout | 300 seconds |
| Website close handshake | 5 seconds |
| Heartbeat interval / response deadline | 30 / 10 seconds |
| Gateway native WS connection cap | 8 hours |
| Session cookie/server expiry | 8 hours |

Both HMP/2 peers probe one another; a missing matching reply fails active work without waiting for TCP EOF. Heartbeats prove transport liveness, not website session resumability. HMP application-idle tracking is based on message traffic; pings alone do not keep an abandoned application socket alive. Browser-TLS website sockets use heartbeats and no default absolute application lifetime while their controller page remains open; upstream raw socket idle and outer gateway limits still apply.

Set `WS_LIFETIME_MS` and `WS_IDLE_MS` for the reference HMP server. Standalone `attachHMP()` also accepts `streamTimeout`, `heartbeatInterval`, `heartbeatTimeout`, `closeTimeout`, `maxMessage`, `maxQueuedBytes`, and `tlsOptions`. Invalid safety limits are rejected; the CLI validates its environment limits before listening.

`createGateway().drain({timeout:5000})` rejects new work, sends HMP/2 GOAWAY, waits for active upgraded work as well as the HTTP listener, and force-closes after the deadline. SIGINT/SIGTERM use this path. Standalone `attachHMP().drain()` is available too. Non-HMP legacy/Wisp connections get an explicit close rather than synthetic session recovery.

A credential is checked when opening a native WebSocket; an established connection has its own lifetime cap. Expiring a cookie is not a website-message replay/recovery mechanism. Do not treat the current session model as a multi-user identity/authorization system.
