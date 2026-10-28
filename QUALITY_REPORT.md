# Skidoxy v0.3.0 — advanced transport verification

**Date:** 28 October 2026  
**Status:** Experimental implementation suitable for controlled testing; **not production-certified**.

Source, reproducible tests and machine-readable results are included. Nothing was published to GitHub. The previous release's review and selected evidence are retained under `qa/v0.2.1/`.

## Executed results

| Area | Result |
|---|---|
| Clean `npm ci` with the repository's lifecycle-script policy | Passed |
| Node 22.23.4 unit/integration suite | **49 passed; 0 failed; 0 skipped** |
| Node 24.22.1 unit/integration suite | **49 passed; 0 failed; 0 skipped** |
| Core Chromium/Scramjet/browser-security suite | **14 passed** |
| New isolated browser-TLS suite | **10 passed** |
| JavaScript syntax checks | Passed for all engine/browser entry points |
| npm audit | **0 reported vulnerabilities** in the installed package set at review time |
| Local transport smoke load | **1000 successful; 0 failed**, 16 concurrent, 64 KiB responses |
| Live Tor checks | Gateway mode and isolated browser TLS paths passed; see breakdown below |
| Docker, ARM64, cloud deployments | **Not executed** |
| Proposed GitHub Actions workflow | Included, **not executed on GitHub** |

Environment: Linux x86-64 sandbox, Playwright 1.64.1 / Chromium 156, Node 22/24 and Tor 0.4.9.14. No custom TLS cryptography was introduced. The source uses Node TLS on the gateway and pinned Epoxy/WASM in browser workers.

## What was added and checked

### Reliability/lifecycle handlers

- Typed SDK errors and redacted wire errors; no automatic retries or replay.
- Idempotent operation scopes, explicit deadlines/AbortSignal cleanup, byte-budget accounting and limit validation.
- A dial deadline destroys a late-arriving socket rather than leaking it.
- HMP/2 client and server heartbeat checks, matching response sequences, and explicit failure of stalled operations.
- Graceful GOAWAY/drain: active HTTP work finishes; new work is denied; shutdown waits for upgraded WebSocket work as well as the HTTP listener.
- Worker pool bounds, FIFO admission, cancelled waiters and retirement of cancelled leases.

### Gateway TLS

- TLS 1.2–1.3, certificate/hostname verification and SNI, no verification-bypass flag.
- A trusted test certificate with the correct SAN succeeded; the same certificate under the wrong hostname was rejected.
- Five sequential verified requests reused **one** connection in the pooling test.
- An untrusted certificate was rejected; an unresponsive TLS handshake timed out and released pending state.
- Normal completed HTTP requests can reuse sockets; aborted work and session shutdown clean up owned resources.

### HMP/2 advanced WebSockets

- A **2 MiB binary message** and long multi-byte UTF-8 text round-tripped through the actual client/gateway/upstream chain.
- Messages larger than the 256 KiB flow-control window were fragmented/reassembled without deadlock.
- Application close code **3001** and its reason were preserved.
- Synchronous message admission limits, bounded assembly, cancellation, slow-consumer credit exhaustion and explicit HMP/1 compatibility passed.
- Empty-fragment floods are capped by a fragment count, not merely a payload byte budget.

### Browser TLS and independent website WebSocket framing

The advanced Chromium suite passed:

1. Authenticated browser-TLS configuration and the full Scramjet → bare-mux port bridge → isolated worker → Wisp path, including HTML, POST and website WebSocket traffic.
2. Direct browser-TLS WebSocket API round trip.
3. Cancelling one response body leaves an unrelated HTTP operation working.
4. Explicit AbortSignal cancellation retires its worker.
5. Large binary and UTF-8 messages, ordered sends, and exact close code/reason through the worker-backed WebSocket path.
6. A long-lived website socket does not starve HTTP capacity because its worker pool is separate.
7. An untrusted destination certificate is rejected **before an HTTP request reaches that server**.
8. A stalled HTTP body reaches its deadline and the worker is retired with a typed timeout.
9. Known-length and streamed uploads exceeding their configured cap are rejected.
10. Real external HTTPS rendered through browser TLS; the relay observed TLS handshake records over `/wisp/` and **no `/hmp/` HTTP transport connection** for that browser mode.

The independent RFC6455 tests additionally exercise client masking, a large binary/text round trip, subprotocol selection, ping/pong, close reason handling, masked-server-frame rejection and zero-length continuation limits. This framing code sits over Epoxy TCP/TLS; it does not replace the TLS implementation.

## Integration defects caught during development

- Chromium bare-mux SharedWorkers cannot instantiate the dedicated workers used for isolation. Browser TLS now lives in the controller Window and uses the supported remote message-port bridge; loading that transport inside the SharedWorker is not the supported integration.
- The first worker WebSocket integration completed a handshake but did not deliver its echo. The delivered implementation instead uses a tested, explicit RFC6455 stream adapter over Epoxy raw TCP/TLS and serializes complete outgoing messages. This report does not assert an independently established upstream-library root cause.
- Using a single worker pool for long-lived website sockets and HTTP could starve HTTP. They now have independent pools and an executed starvation-regression check.
- HTTP listener closure alone does not wait for upgraded WebSockets. The gateway drain now waits for active upgraded work as well, with an executed regression test.
- Zero-byte fragment sequences could evade a byte-only bound. Both message assemblers now independently cap fragments at 1024.

## Live onion checks

A real Tor daemon reached 100% bootstrap. Two scripted runs exercised:

- HMP/2 → gateway TLS/dialer → Tor Project onion HTTP: **200** with expected title/body.
- HMP/2 → gateway TLS → DuckDuckGo onion HTTPS: **200** with expected title/body.
- Chromium/Scramjet/HMP rendered the Tor Project onion heading.
- Chromium's **isolated browser-TLS mode** rendered the Tor Project onion site.
- An isolated browser-TLS worker fetched the DuckDuckGo **HTTPS onion** and returned 200 with expected content.
- The legacy Epoxy/Wisp path also rendered the onion site in a fresh browser context.

The script's Node dialer was configured to throw on local DNS or direct fallback; its local resolver count was **zero**. This verifies the application's routing hooks for these paths, not a complete packet-capture audit of browser/OS privacy behavior. The two reports repeat some of the same Node checks; they should not be interpreted as nine unique destination-service tests.

As before, seamless hot-switching of an actively loading page remains unqualified. The reference implementation deliberately uses a configured mode and cold-page initialization, not transparent failover. The prior live-switch timeout remains documented in `qa/v0.2.1/` and `qa/tor-switch-timeout.json`.

## Local load smoke results

`qa/load-results.json` records the latest transport-only run:

- 1000 operations; concurrency 16; 64 KiB checked response each.
- **1000 succeeded, zero failed**; duration **1.093 seconds**.
- Approximately **915 operations/second**; p50 **15.15 ms**, p95 **25.24 ms**.
- Whole-process RSS: **72.8 MiB before**, **112.9 MiB sampled peak**, **104.7 MiB after**.
- Client and gateway stream maps returned to **zero**.

Client, gateway and fixture share one process. These figures exclude browser rewriting, production auth, cloud networking and Tor. They are not a benchmark against upstream engines, a cloud-capacity estimate or a long-duration memory-leak proof.

## Important remaining limits

- **No production/security certification.** The rewriter is not a hardened origin boundary; dedicated hostname/profile and trusted users only. No independent audit, full fuzzing or comprehensive WebRTC/fingerprint/DNS leak capture.
- **Different TLS trust models.** HMP decrypts at the gateway. Browser TLS encrypts destination HTTPS/WSS through the relay, but cannot protect against malicious frontend code served by that operator. HTTP/WS remains plaintext at the destination layer.
- **Dependency maintenance:** pinned Scramjet v1 and bare-mux are legacy; a migration to newer upstream APIs is a separate tested change. npm audit does not audit every Rust/WASM component, OS library, license obligation or security design.
- **Message/lifetime policy:** 4 MiB messages, 1024 fragments, bounded queues; HTTP deadline 120 seconds; HMP website idle default 5 minutes; close timeout 5 seconds. No HTTP/2/3, compression negotiation, transparent reconnect, session replay or hot switching.
- **Browser TLS:** 2 HTTP workers and 2 socket workers by default; 8 MiB buffered upload cap; the controller page must remain open. Cancellation is operation-local by retiring its worker, not by pretending an active website session can resume.
- **WSS coverage:** the verified TLS building blocks and website framing were exercised, but no public end-to-end WSS echo service or live onion WSS service was tested. Long-lived sessions, Tor restarts and hours-long load remain outstanding.
- **Peer hardening:** budgets cover this implementation's queues, not every library/browser allocation. Upstream Wisp malicious-peer/queue behavior still needs adversarial review.
- **Deployment:** Docker/Caddy certificates, ARM64, Oracle/GCP/Fly/Render behavior and free-tier charges/capacity have not been validated here.
- **CI/licensing:** the workflow is proposed, not a GitHub execution result. Review AGPL/LGPL hosting/source/attribution obligations before publishing or deploying.

## Evidence and reproduction

- `qa/unit-node22.txt`, `qa/unit-node24.txt`
- `qa/quality-results.json`, `qa/quality-run.txt`
- `qa/advanced-browser-results.json`, `qa/advanced-browser-run.txt`
- `qa/tor-results.json`, `qa/tor-run.txt`
- `qa/tor-browser-results.json`, `qa/tor-browser-run.txt`
- `qa/load-results.json`, `qa/load-run.txt`
- `qa/npm-ci.txt`, `qa/npm-audit.json`, `qa/syntax-check.txt`

Run `npm ci`, `npm run check`, `npm test`, `npx playwright install --with-deps chromium`, `npm run qa:browser`, `npm run qa:advanced`, and `npm run qa:load`. Optional live Tor commands are in README.md. `QA_OFFLINE=1` excludes public destination checks from browser suites; the CI workflow uses this controlled-fixture mode.

**Recommendation:** use v0.3.0 for controlled experimental testing, keeping the trust-mode distinction and these limitations visible. Do not market it as production-stable, anonymity-safe or faster than upstream engines.

## Rename validation — skidoxy-engine

The source/package and current runtime branding have been renamed to `skidoxy-engine` (Skidoxy). The HMP wire name and versions are unchanged. After the rename, a clean dependency install, all **49 Node 22 unit/integration tests**, and every engine/browser syntax check passed. Evidence: `qa/rename-install.txt`, `qa/rename-unit-node22.txt`, `qa/rename-syntax.txt`.

Earlier browser, Node 24, load and Tor results above are the pre-rename functional baseline; those broader checks were not repeated solely for this branding change. Historical JSON/logs/screenshots retain their original recorded names and paths. The cookie rename intentionally requires existing sessions to sign in again.
