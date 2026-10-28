# Skidoxy transport protocol (HMP) — versions 1 and 2

Experimental application protocol over one ordered WebSocket at `/hmp/`. This is not Wisp or raw TCP. It carries HTTP operations and website WebSocket messages. WSS and destination TLS supply encryption; HMP invents no cryptography. See ADVANCED_TRANSPORTS.md for the separate Epoxy/Wisp browser-TLS mode.

## Connection and framing

The reference gateway authenticates its HttpOnly session cookie and exact Origin before upgrade. Client HELLO, ID 0: `{"version":2}`. The server accepts explicit version 1 or 2 and responds with the same version plus `window`, `chunk`, and `maxMessage`. Unknown versions close with code 1002. There is no implicit downgrade. Handshake deadlines remain 10 seconds client / 5 seconds server.

Each native WebSocket message contains exactly one binary frame:

| Offset | Bytes | Meaning |
|---|---:|---|
| 0 | 1 | type |
| 1 | 4 | unsigned stream ID, big endian |
| 5 | 4 | unsigned payload length, big endian |
| 9 | length | payload |

Maximum frame: 1 MiB. Metadata: at most 32 KiB UTF-8 JSON. Body/fragments: at most 65536 payload bytes. Client stream IDs are nonzero odd integers allocated monotonically; active IDs cannot be reused. New server-originated streams are not defined. ID 0 is reserved for connection control.

## Frame types

| Type | Name | Payload |
|---:|---|---|
| 1 | HELLO | Version JSON, ID 0 |
| 2 | OPEN | `{url,method,headers}` HTTP(S) operation |
| 3 | META | `{status,statusText,headers}` before response DATA |
| 4 | DATA | Raw HTTP upload or decoded response bytes |
| 5 | END | End of HTTP body in that direction |
| 6 | CANCEL | Dispose stream resources |
| 7 | ERROR | `{code,message,retryable:false}`; generic terminal error |
| 8 | CREDIT | Four-byte unsigned big-endian positive byte count |
| 9 | WSOPEN | Client `{url,protocols,headers}`; server `{protocol,extensions}` |
| 10 | WSMESSAGE | Version 1 only: byte 0 = text/binary (0/1), remaining complete message |
| 11 | WSCLOSE | `{code,reason}` |
| 12 | PING | Version 2 only, ID 0: `{sequence}` |
| 13 | PONG | Version 2 only, ID 0: matching PING payload |
| 14 | GOAWAY | Version 2 only, ID 0: `{code:"DRAINING"}` |
| 15 | WSFRAGMENT | Version 2 only: flags byte then message bytes |

Headers use string keys and string/string-array values. Repeated destination cookies are preserved. Hop-by-hop/request framing fields are stripped; gateway-generated Host/transfer framing replaces them. CONNECT, TRACE and TRACK are denied on HMP. Redirects are returned, not followed by the gateway. gzip/deflate/br decoding removes corresponding compressed encoding/length fields. Onion or private-IP policy is checked on every new upstream socket.

## HMP/2 website-message fragments

WSFRAGMENT flags: binary=1, start=2, final=4; no other bits are valid. The first fragment has start; the last has final. A single-fragment message has both. All fragments have the same text/binary bit. One ordered message is assembled at a time per stream. A fragment with no message bytes still carries the flags byte.

Defaults:

- Maximum assembled message: **4 MiB**.
- Maximum fragments/message: **1024**, independently of byte count.
- Per-stream outbound queued payload: **8 MiB**, plus explicit message-count/overhead limits.
- Gateway aggregate assembly, outgoing-message and pending-upstream-write budgets: separate **16 MiB** budgets per connection.
- Client aggregate inbound assembly budget: **16 MiB**; queued outbound application sends: **8 MiB** plus a maximum of **256** outstanding sends.

Exceeding limits fails the affected stream. Malformed connection framing or invalid stream creation may close the multiplexed connection. Native WebSocket/TCP ordering still has head-of-line blocking; there is no weighted priority scheduler.

## Flow control and cancellation

Each stream begins with **262144 send-credit bytes in each direction**. DATA/WSMESSAGE/WSFRAGMENT consume their payload length, including message flags/discriminator. CREDIT must be positive, at most the initial window, and cannot grow a sender beyond that window. Metadata/control frames do not consume data credit.

- HTTP upload credit: restored after the destination request write callback.
- HTTP response credit: restored according to available byte-counted ReadableStream capacity.
- HMP/2 incoming website fragments: restored as they enter bounded assembly, with the last fragment tied to its upstream message write. Waiting until a multi-window message is complete before crediting every fragment would deadlock, so admission is also protected by message/aggregate budgets.
- Outgoing website messages: chunked and stalled when credits are unavailable. Node upstream reads are paused while outgoing messages queue.
- Incoming website delivery: credited after bounded assembly/callback delivery, not after an ultimate web application has processed its own message-port queue.

AbortSignal, response-body cancellation, stream deadline and disconnect trigger cleanup rather than retries. HTTP normal completion permits socket reuse. An early completed response cancels a still-running upload so the upstream stream is not orphaned. Browser TLS uses worker retirement for its operation-local cancellation; it is a different wire path.

## Lifecycle

HMP HTTP sequence: OPEN → DATA* → END in the request direction; META → DATA* → END in the response direction. Both directions ending normally releases the stream; cancellation/error closes owned resources. HTTP default absolute deadline: 120 seconds.

Website sequence: WSOPEN → acknowledgement → complete WSMESSAGEs (v1) or WSFRAGMENT sequences (v2) → WSCLOSE. Application close requests accept 1000 or 3000–4999 with a UTF-8 reason no longer than 123 bytes. Upstream close codes/reasons are preserved in notifications. Close timeout: 5 seconds. HMP/2 default website lifetime has no absolute cap, but a 5-minute application-idle timer applies. Heartbeats do not reset application-idle time.

Both client and server send HMP/2 liveness probes every 30 seconds and expect the matching sequence within 10 seconds. A client-side liveness failure fails active work immediately rather than waiting indefinitely for TCP to close. It also probes upstream website sockets. The reference HTTP gateway sends native WebSocket pings for transport liveness, including the compatibility Wisp path; browsers answer those natively.

GOAWAY prevents new streams while existing streams can finish. A drain deadline cancels remaining work. No operation or website message is replayed, and no session is declared resumed after disconnection. HMP/1 remains supported without v2 fragments, heartbeats or GOAWAY; its website-message payload limit remains under 64 KiB.

## Trust boundaries and validation status

HMP HTTPS/WSS terminates at the Node gateway. Gateway TLS uses verified Node TLS 1.2–1.3, SNI and HTTP/1.1 ALPN, with bounded per-connection pools. Browser TLS is implemented separately using Epoxy raw TCP/TLS over Wisp v2; it does not send HMP HTTP metadata and never silently falls back to this mode.

Executed checks include Node wire integration, Chromium/Scramjet, large messages, backpressure, typed errors, cancellation, heartbeats, graceful drain, TLS chain/hostname rejection and live onion HTTP/HTTPS. See QUALITY_REPORT.md for exact results. Full fuzzing, adversarial peer hardening, cross-browser/site coverage, cloud deployment and anonymity certification remain outstanding.
