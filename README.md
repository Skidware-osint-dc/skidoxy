# skidoxy-engine — 0.3.0 experimental

Scramjet-based browser proxy SDK with **HMP/2**, reliability/lifecycle handlers, two explicit destination-TLS modes, and an advanced full-duplex WebSocket implementation.

**This is an experimental implementation, not a production stability, anonymity or speed guarantee.** See [QUALITY_REPORT.md](QUALITY_REPORT.md) for executed checks and remaining risks; [ADVANCED_TRANSPORTS.md](ADVANCED_TRANSPORTS.md) for APIs and configuration; [PROTOCOL.md](PROTOCOL.md) for the wire format.

## What's new

- Typed/redacted errors, deadlines, cancellation scopes, late-socket disposal, bounded byte queues, worker admission limits, heartbeats and graceful gateway draining. No automatic replay or reconnect of active operations.
- **Gateway TLS:** Node TLS 1.2–1.3, mandatory certificate/hostname verification and SNI, handshake/connect timeouts, per-gateway-session bounded keep-alive pools, idle eviction and shutdown cleanup.
- **Browser TLS:** Epoxy/WASM cryptography inside isolated dedicated workers. HTTP operations and website sockets lease separate bounded worker pools. Cancelling an operation retires its worker without killing unrelated operations. Browser TLS does not silently fall back to gateway TLS.
- **Advanced WebSockets:** HMP/2 fragments messages larger than a flow-control window, with bounded assembly and queues. Browser TLS uses our RFC6455 framing/handshake adapter over Epoxy raw TCP/TLS streams, with masking, fragmented binary/text messages, subprotocol validation, ping/pong, close code/reason handling, and bounded message/fragment counts. TLS cryptography itself remains upstream.
- HMP/1 and the earlier Epoxy/Wisp adapter remain available for explicit compatibility use.

## Architecture and trust

```
Gateway TLS mode (default)
Browser → Scramjet → bare-mux → custom HMP/2 → Node HTTP/TLS + website WS
                                                   ├ public host → validated/pinned IP
                                                   └ v3 onion → Tor SOCKS5 hostname

Browser TLS mode
Browser → Scramjet → bare-mux port bridge → isolated browser workers
                                         ├ Epoxy HTTP/TLS
                                         └ our RFC6455 framing over Epoxy TCP/TLS
                                                      ↓
                                         Wisp v2 compatibility gateway → same routing policy
```

**Gateway mode decrypts destination HTTPS at the gateway.** Browser mode terminates destination HTTPS/WSS in the browser worker; the gateway relays destination TLS records. Plain HTTP/WS is not encrypted by destination TLS in either mode. Production access still requires HTTPS/WSS for the browser-to-gateway connection.

Browser TLS is not protection against an actively malicious operator serving modified frontend code. The controller page must remain open for its remote bare-mux bridge and worker pool. These are different trust/lifecycle modes, not transparent per-request fallbacks. Changing the reference app's mode requires restarting the server and reopening the control page, not hot-swapping a loading website.

## Quick start

Requires Docker with Compose, or Node 22.12+ plus a separate Tor daemon. Node 22 and 24 were tested. Docker/ARM64/cloud deployment itself has not been executed in this environment.

```sh
cp .env.example .env
# Set ACCESS_TOKEN to a secret generated with: openssl rand -hex 32
# Set TLS_MODE=gateway (default) or TLS_MODE=browser.
docker compose up --build -d
```

Open http://localhost:8080 and sign in. Tor must bootstrap before onion requests can succeed. Normal destinations route directly; v3 `.onion` names go to Tor without local hostname resolution or direct fallback. Default destination ports are 80 and 443. UDP is not supported. An ordinary domain referenced by an onion page still uses the direct route: this is onion access, not Tor-only browsing.

For public HTTPS:

1. Point a domain at your VM and permit TCP 80/443 in host/cloud firewalls.
2. Set `DOMAIN=proxy.example.com`, `PUBLIC_ORIGIN=https://proxy.example.com`, and a strong `ACCESS_TOKEN` in `.env`.
3. Run `docker compose --profile https up --build -d`.

Caddy proxies HTTP/WebSocket traffic to the engine. Tor's SOCKS port is not published. Review current provider policies, capacity and charges yourself; no Always Free availability or egress-cost guarantee is made. A VPS is the simplest initial target. Fly.io/Render need persistent engine and private Tor services; the Compose file does not directly deploy there.

Local Node:

```sh
npm ci
# Set a known strong token in your shell; never commit it.
ACCESS_TOKEN='replace-with-at-least-32-random-characters' TLS_MODE=gateway npm start
```

Set `TOR_HOST`/`TOR_PORT` for your Tor instance; defaults are localhost:9050. HTTP localhost supports service workers; remote browsers need HTTPS. `PUBLIC_ORIGIN` must exactly match the browser's origin, without a trailing slash.

The checked-in `.npmrc` disables dependency lifecycle scripts because the pinned Scramjet package otherwise rejects a clean npm install. The tested paths consume published prebuilt browser assets. Docker uses the same `--ignore-scripts` policy. Optional native acceleration hooks are not built; reassess this decision when dependencies change.

## SDK entry points

```js
import { createDialer } from './src/index.mjs';
import { attachHMP } from './src/hmp.mjs';

const dial = createDialer({ torHost: 'tor.internal', torPort: 9050 });
// Authenticate the upgrade and validate its exact Origin BEFORE this call.
const connection = attachHMP(acceptedWebSocket, {
  dial,
  maxStreams: 48,
  websocketLifetime: 0,       // no absolute WS lifetime
  websocketIdle: 300_000,    // idle application traffic timeout
});
// Later: connection.drain({ timeout: 5000 });
```

`createGateway()` in `src/gateway.mjs` includes the reference HTTP/authentication layer and returns `{server,wss,origin,drain}`. Test-injected dialers are a controlled SDK extension, not a production private-network bypass flag.

Package exports also expose `./hmp`, `./gateway`, `./tls`, `./reliability`, `./transport`, `./browser-tls`, `./protocol`, and `./websocket`. This project is currently private and is not published as an npm package.

## Repeat the checks

```sh
npm ci
npm run check
npm test
npx playwright install --with-deps chromium
npm run qa:browser
npm run qa:advanced
npm run qa:load
# Optional, after Tor has bootstrapped on localhost:19050:
npm run qa:tor
QA_TLS_MODE=browser npm run qa:tor
```

`QA_OFFLINE=1` excludes external destination checks from both browser scripts; controlled localhost fixtures still use networking. Browser scripts need free ports 18080 and 18082; live Tor tests use 18081. Test tokens are intentionally public fixtures, not production credentials.

Executed results: **49 unit/integration tests on Node 22 and 24**, **14 core browser checks**, **10 advanced browser-TLS checks**, and successful live onion checks. A short local 1000-operation transport load completed without failures; it is not a cloud benchmark or soak test. Proposed GitHub Actions jobs are included but have not run on GitHub here.

## Important limits

- Default HMP/2 and browser WebSocket message maximum: **4 MiB**, at most **1024 fragments**. HMP/1 retains its under-64-KiB message limit. Per-stream and aggregate queue budgets can reject excess work rather than grow forever.
- HTTP operation deadline: **120 seconds**. HMP WebSockets: **no absolute lifetime** by default, **5-minute application-idle timeout**; pings do not count as application messages. Close-handshake limit: **5 seconds**. Heartbeats: **30 seconds**, with a **10-second** peer-response deadline.
- Browser TLS defaults: **2 HTTP workers + 2 website WebSocket workers**, FIFO queues capped at 32 per pool, **8 MiB buffered upload maximum**. It buffers uploads before Epoxy fetch; this is not zero-copy streaming upload mode. Browser Wisp/HTTP connection behavior remains dependent on upstream Epoxy.
- A socket closing does not mean a website session can safely resume. There is no automatic reconnect, message replay, failover between TLS modes, or seamless hot-swap guarantee.
- HTTPS/WSS over HTTP/1.1 only for the gateway path. No HTTP/2/3, HTTP CONNECT endpoint, general UDP support or custom cryptography.
- TLS validation and transport isolation are not a full privacy audit. Browser fingerprinting, WebRTC, rewriter escapes, malicious authenticated clients and packet-level DNS/privacy behavior still require review. Upstream Wisp peer/queue hardening is not certified.
- Use a dedicated hostname and browser profile, trusted users only. Never host sensitive apps on the proxy origin. Scramjet rewriting is not a hardened origin boundary.
- Scramjet v1 and bare-mux are pinned legacy dependencies; upstream recommends newer replacements. Migration is a separate compatibility project, not silently included here.

## Licensing and upstream

Original Skidoxy source is MIT. Dependencies retain their own licenses; review AGPL/LGPL attribution, hosting and corresponding-source obligations before distribution/deployment. No upstream TLS implementation was modified; runtime assets are loaded from pinned packages.

- Scramjet 1.1.0 — MIT: https://github.com/MercuryWorkshop/scramjet
- bare-mux 2.1.9: https://github.com/MercuryWorkshop/bare-mux
- Epoxy transport 3.0.2 and Epoxy TLS 2.1.20-1 — AGPL-3.0-only: https://github.com/MercuryWorkshop/epoxy-tls
- wisp-js 0.5.1 — LGPL-3.0-or-later: https://github.com/MercuryWorkshop/wisp-js
- Ultraviolet background: https://github.com/titaniumnetwork-dev/Ultraviolet

Ultraviolet and InvisiProxy code are not merged into this project. InvisiProxy's supplied README could not be verified during the initial implementation. No equivalence or attribution to its Tor implementation is implied.

## Project rename

The project/package is now `skidoxy-engine`; the GitHub repository is named `skidoxy`. HMP/1 and HMP/2 wire versions remain unchanged. Runtime branding, SDK class names, cookie names and test fixture names use Skidoxy. Existing browser sessions must sign in again after upgrading because the cookie name changed. Historical QA artifacts retain their recorded original names.
