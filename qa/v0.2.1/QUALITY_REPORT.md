# Helios v0.2.1 — pre-GitHub quality review

**Date:** 28 October 2026  
**Recommendation:** **Ready for private/experimental repository testing, not production deployment.**

This was an executed engineering smoke review, not a third-party security audit or a stability certification. Reproducible fixes, test harnesses, evidence and a proposed CI workflow are included. No repository was created and nothing was pushed to GitHub.

## Executive results

| Check | Executed result |
|---|---|
| Clean lockfile install on Node 22 | Passed after fixing dependency lifecycle-script handling |
| Unit/integration suite | **24/24 passed**, no skips, on Node **22.23.4** and **24.22.1** |
| JavaScript syntax checks | Passed for gateway, SDK, protocol, transports and browser entry points |
| Chromium browser/security suite | **14/14 passed** in the final online run |
| Live onion tests | Latest isolated run: **4/4 passed**; see hot-switch qualification below |
| Local transport load | **1000/1000 successful**, 16 concurrent operations, 64 KiB each |
| npm audit | **0 reported vulnerabilities** across the installed dependency set at review time |
| Docker/Compose, ARM64, cloud deployment | **Not executed**; Docker is not installed in this environment |
| GitHub Actions | Workflow supplied; **not executed on GitHub** |

Environment: Linux x86-64 sandbox, Playwright 1.64.1 / Chromium 156, Node 22/24; live Tor daemon 0.4.9.14 reached 100% bootstrap. A clean reinstall was performed, not just tests against an existing dependency directory.

## Defects found and fixed

### 1. Browser sign-in failed (release blocker)

**Observed:** Actual Chromium form submissions carried `Origin: null`, so the exact-Origin check rejected valid users with HTTP 403. The root cause was the gateway's `Referrer-Policy: no-referrer` combined with browser navigation behavior.

**Fix:** Use `Referrer-Policy: same-origin`. Do not weaken the exact-Origin check or accept null origins.

**Verification:** Chromium form sign-in, cookie issuance, service-worker registration and bare-mux initialization now pass. Cross-origin login remains denied.

### 2. Legacy transport was incompatible (release blocker for that path)

**Observed:** bare-mux 2 uses header records, but epoxy-transport 3 consumes/returns header tuples. After adapting headers, the Wisp connection still failed with `InvalidPacketType(5)` because the client wasn't explicitly configured for the server's Wisp v2 handshake.

**Fix:** Added `public/legacy-transport.mjs`: translates header formats, enables Wisp v2, and disables the UDP-extension requirement for this TCP-only server. Upstream packages were not edited.

**Verification:** Real Chromium + Scramjet + Epoxy/Wisp passed controlled HTTP/JavaScript/fetch/WebSocket checks, external HTTPS, and an isolated live onion render. Use the wrapper, not `/epoxy/index.mjs` directly, with this pinned bare-mux version.

### 3. Session expiry was only browser-enforced (security correctness)

**Observed by inspection:** A process-wide session value was accepted indefinitely until restart; cookie Max-Age alone did not reject an expired cookie replayed by a non-browser client.

**Fix:** Unique random server-side sessions with explicit expiry, bounded storage and periodic expired-session cleanup. Production default remains eight hours.

**Verification:** Added tests showing an expired cookie is rejected by the server, separate logins get distinct values, and HTTPS cookies include `__Host-`, Secure, HttpOnly, Path=/ and SameSite=Strict.

### 4. Clean `npm ci` failed (release/deployment blocker)

**Observed:** A fresh install triggered Scramjet's `npx only-allow pnpm` lifecycle hook and failed. The earlier already-installed dependency tree had hidden this issue.

**Fix:** Added project `.npmrc` with `ignore-scripts=true`; Docker explicitly installs with `--ignore-scripts`. This project consumes the tested published prebuilt browser assets and does not require dependency build hooks. Optional native acceleration hooks are not built; performance must be measured accordingly.

**Verification:** Fresh `npm ci`, then all 24 unit/integration tests and 14 Chromium/security checks passed. Docker's command has been corrected, but the container image itself has not been built here.

## What the browser checks cover

The controlled fixture uses a test-injected dialer that maps **only** `fixture.helios.test:80` to a local HTTP/WebSocket server. This is not a production private-network bypass and is not exposed as an environment flag. Separate tests use the real production policy for private-IP denial and public HTTPS.

The full browser path exercised:

- Login form → HttpOnly session → service worker → Scramjet → bare-mux → HMP gateway.
- HTML rewriting/rendering, external JavaScript and CSS, and computed stylesheet application.
- JavaScript fetch, POST bodies, 204 empty responses and HEAD responses.
- Destination cookies, relative links and redirects.
- Website WebSocket text echo.
- Real public HTTPS through both HMP and legacy Epoxy/Wisp.
- Denial of unauthenticated assets and WebSocket upgrades.
- Wrong-token/cross-origin login and wrong-Origin WebSocket rejection.
- Authenticated path traversal rejection.
- Malformed HMP frame rejection without killing the HTTP server.
- Loopback, IPv6 loopback and cloud metadata destination denial.
- Onion outage error propagation and stream-limit enforcement.

The unit/integration suite additionally checks large streamed uploads/downloads, concurrent streams, repeated cookies, decompression, text/binary WebSockets, AbortSignal cancellation, body cancellation, credit exhaustion/slow consumers, malformed lengths, public-IP checks, pending-connect cleanup, and rejection of an untrusted TLS certificate.

## Live Tor verification

Latest run, using real Tor SOCKS5 on localhost:19050:

| Path | Result |
|---|---|
| HMP → Tor Project v3 onion over HTTP | HTTP 200; expected Tor Project title/body |
| HMP → DuckDuckGo v3 onion over HTTPS | HTTP 200; expected title/body; gateway TLS validation enabled |
| Chromium → Scramjet → HMP → Tor Project onion | Expected visible “Browse Privately.” heading and Tor Project title |
| Chromium → Scramjet → Epoxy/Wisp → Tor Project onion, isolated browser context | Expected visible heading |

The test dialer made local DNS and direct fallback throw errors. The application-level local resolver call count was **zero**. This is evidence about those code paths, **not packet-capture proof of all browser/OS privacy behavior**. Ordinary domains referenced by onion content intentionally route directly in the normal production policy; the live QA guard was stricter to detect unintended calls.

### Important reliability qualification: live hot-switch timeout

A repeat run **timed out once** while switching an already-loading onion page from HMP to Epoxy/Wisp. The failure evidence is retained in `qa/tor-switch-timeout.json`. The same path had passed earlier. Repeating the legacy test in a fresh browser context passed.

This does **not** prove the underlying cause has been fixed: in-flight transport switching and/or Tor timing is still unqualified. The canonical test now isolates each transport so it measures cold-session behavior instead of depending on an active-page switch. **Do not advertise seamless live transport hot-swapping.** Reproduce and diagnose this separately before adding a transport-switching UI. The reference UI initializes HMP once and has no such toggle.

Live onion WebSockets, real Tor outages/restart recovery, many onion services and high-risk anonymity use remain unverified.

## Local load smoke test — not a speed claim

Final measured run (`qa/load-results.json`):

- **1000 requests**, **16 concurrent**, **64 KiB** response per operation.
- **1000 successful; 0 failed**; response lengths checked.
- Duration **1.528 seconds**, approximately **654 operations/second**.
- Latency **p50 22.26 ms**, **p95 34.85 ms**.
- Whole-process RSS: **73.4 MiB before**, **101.5 MiB sampled peak**, **96.7 MiB after**.
- Client and gateway active-stream maps both returned to **zero**.

The client, gateway and upstream fixture share one local Node process. These measurements exclude production authentication, Scramjet rewrite costs, cloud networking and Tor. They are not a cloud capacity estimate, a long-duration memory-leak test, or a comparison against Ultraviolet/Scramjet/Wisp. No “faster than upstream” claim is justified.

## Remaining release risks

1. **Production/security:** Scramjet rewriting is not a hardened origin boundary. Trusted users and a dedicated hostname/browser profile only. No independent audit, comprehensive privacy-leak capture or hostile-client fuzzing has occurred.
2. **TLS trust:** HMP terminates destination TLS on the gateway. Its operator can read proxied HTTPS traffic. WSS secures the browser-to-gateway leg, not end-to-end destination secrecy from the gateway.
3. **Prototype limits:** HMP website WebSocket messages must be under 64 KiB; streams have a 120-second absolute lifetime; no upstream pooling, HTTP/2/3 or automatic reconnect/replay. Legacy Epoxy uploads can buffer, and upstream abort handling remains limited.
4. **Upstream maintenance:** The pinned Scramjet runtime warns that v1 is superseded by v2. Plan a separately tested migration rather than silently upgrading during this review.
5. **Compatibility:** Chromium fixtures and a few live pages passed; Firefox/WebKit, major complex apps, workers, downloads, media and long-lived sessions are not certified.
6. **Deployment:** Docker, Compose networking, Caddy certificates, ARM64 and Oracle/GCP/Fly/Render deployment are untested here. No free-tier cost or capacity guarantee.
7. **Operational resilience:** No hours-long soak, automatic recovery test, distributed abuse protection or comprehensive malicious-authenticated-client test.
8. **Live switching:** The timeout described above remains a known qualification.
9. **Licensing:** Dependency audit is not a license audit. Review AGPL/LGPL distribution/hosting obligations before publication or deployment.

## Included evidence and rerun commands

- `qa/unit-node22.txt`, `qa/unit-node24.txt` — executed unit/integration results.
- `qa/quality-results.json`, `qa/quality-run.txt` — final 14-check Chromium/security result.
- `qa/tor-results.json`, `qa/tor-run.txt` — latest isolated live onion run.
- `qa/tor-switch-timeout.json` — earlier repeated-run failure, deliberately retained.
- `qa/load-results.json`, `qa/load-run.txt` — local smoke load.
- `qa/npm-audit.json`, `qa/npm-ci.txt`, `qa/syntax-check.txt` — dependency/install/syntax checks.
- `qa/controlled-browser-pass.png`, `qa/live-onion-browser.png` — screenshots.

```sh
# Node 22.12+; Node 22 and 24 were tested
npm ci
npm run check
npm test
npx playwright install --with-deps chromium
npm run qa:browser
npm run qa:load
# Optional: first bootstrap Tor on localhost:19050
npm run qa:tor
```

`QA_OFFLINE=1 npm run qa:browser` excludes the two public HTTPS destination checks, retaining controlled localhost fixture coverage. `.github/workflows/quality.yml` supplies this offline browser job and a Node 22/24 unit matrix; that workflow has not run on GitHub yet.

**Decision:** Publish/test as an **experimental prototype** with these limitations visible. Do not label this production-stable, anonymously safe, or faster than upstream engines.
