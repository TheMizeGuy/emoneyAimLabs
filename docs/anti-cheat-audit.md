# Anti-cheat and API security audit

Date: 2026-08-16
Scope: browser game, score protocol, client lifecycle, Twitch OAuth and sessions, Express routes and
middleware, PostgreSQL schema/transactions, Railway production runtime/configuration, static hosting,
dependencies, and logging.
Report state: patched release candidate. Release and production verification are recorded separately
in the repository history and deployment logs so this threat assessment does not become stale.

## Verdict

The patched source closes the reproduced locator shortcut, timer-free pause, one-sided clock,
challenge answer/wait/replay paths, blind-guess burst, fixed-field, activity-feed, lifecycle-race,
liveness, ownership, and resource-control defects found in this audit. Its clean verification gate
includes adversarial, concurrency, database-invariant, and client-lifecycle cases.

One high architectural residual remains: once automation can visually solve the raster challenge, a
modified client can execute the correctly timed server protocol without actually playing Chase.
Browser-owned input state cannot serve as human attestation. The design now makes that materially
slower and more expensive; it does not make it impossible.

During read-only Railway inspection, three live credential values appeared in this private tool
transcript. They were not written to the repository, git history, report, or application logs. The
owner explicitly accepts local-only transcript storage as trusted, so this is not treated as a
compromise and rotation is not required under the declared threat model. Reassess that decision if
the transcript is exported/shared or local access assumptions change.

Read-only production evidence showed the named leaderboard account's requests used the real protocol:
valid chained heartbeats, repeated near-minimum Flappy phases, and 1-2.6 second Chase claims. That is
consistent with automation but does not prove how the player generated the inputs. A local native-input
locator reproduced a 3.638 second Practice win against the old journey gate, establishing that the
client path was exploitable independently of the production account.

The custom visual challenge materially raises automation cost. The first exact edge-matching oracle
solved 98% of three-round runs; identical candidate masks plus independent piece rotation/recoloring
reduced that attack to chance in deterministic regression. A controlled browser/vision attempt still
solved all three rounds of that hardened version. The shipped protocol therefore uses four
independently keyed rounds (1/256 blind success per run) plus a durable 0/5/15/30/60-second retry ramp.
Success or ten quiet minutes resets the ramp. This is empirical friction, not an impossibility result.

The remaining design limit is explicit: a browser-only game cannot prove a human supplied the input.
The patched protocol blocks fabricated instant scores, wait-only challenge bypasses, clock shaving,
replay, phase shortcuts, request races, blind-guess bursts, small-window advantages, and simple
synthetic events. It does not block a bot that solves the visual task and executes the complete
protocol in real time. Prize-bearing or reputation-sensitive ranking needs independently validated
external attestation; even that raises automation cost rather than making automation mathematically
impossible.

## Severity decision rules

1. **Critical** — exposed production credentials, unauthenticated account/session compromise, or
   comparable immediate trust-root failure.
2. **High** — a practical material score-integrity attack or resource-control bypass that can take down
   the service.
3. **Medium** — a partial/inconsistent control, exploitable correctness race, or issue requiring an
   adjacent compromise.
4. **Low** — shielded hardening, misleading telemetry, false positives, or defense-in-depth without a
   direct compromise path.

## Trust model

Trusted:

- Twitch's authorization-code exchange and Helix identity response after strict shape validation.
- The API process clock.
- PostgreSQL transactions, constraints, unique indexes, and row locks.
- HMAC values derived from the server-configured session secret.

Untrusted:

- Every browser-supplied value, including time, misses, near misses, `sus`, phase flags, and win
  signatures.
- Client hashes and the win-signature salt; both ship publicly and provide tamper friction only.
- `Event.isTrusted` as proof of a human; browser automation can still produce trusted events.
- `X-Forwarded-For`; Railway documents `X-Real-IP` as the client address.
- Client-side physics as authoritative evidence.

A score is eligible only when an authenticated user owns a single-use open run; the server witnessed
both Simulation phases and sufficient phase-specific paced chain progression; the claim fits the
server-observed clock and configured physical bounds; no client detector fired; and one transaction
consumes the run and records the score exactly once.

## Findings

| ID | Severity | State | Finding and remediation |
|---|---|---|---|
| AC-13 | High | Open architectural limit | A controlled browser/vision agent solved every round of the randomized server raster challenge. Once a solver supplies those answers, a modified client can keep the chained heartbeat live, wait the configured floor, sign the public-salt claim, and omit Chase gameplay. A protocol-only probe against the preceding client-answer design returned HTTP 200/rank 1; the new wait-only regression is closed, but no browser-owned visual task proves a human. Closing this requires independently validated proof outside browser-owned state; see API6 remediation. |
| AC-14 | High | Reproduced path fixed; broader automation remains | Native CDP input is browser-trusted. A live locator loop read the moving Close rect and won Practice in 3.638 s against the old gate. A winning press now requires a current 96+ ms, four-frame middle-band approach. That blocks the reproduced teleport path, not a bot deliberately generating the same multi-frame journey. |
| AC-01 | High | Fixed and deployed | Simulation validation counted Flappy heartbeats as Chase liveness. `chase_start_beats` now snapshots the credited count at the phase boundary, and validation independently checks both phases. An end-to-end exploit regression fails closed. |
| RC-01 | High | Fixed and deployed | All address-based limits used Express `req.ip` with hop-count proxy trust. Railway documents `X-Real-IP`, while a regression proved rotating caller-controlled `X-Forwarded-For` minted new buckets. One validated `X-Real-IP` helper now drives the global, auth, public-read, SSE, and audit identities; XFF is ignored. |
| AC-15 | High | Fixed and deployed | Score timing was one-sided: a modified client could wait out a long live run, then claim the configured floor. Validation now pins claims to both sides of the server-observed scored window, excluding only the server-timestamped Practice challenge. A backwards claim closes the run and publishes `cheat_detected`, so it cannot be retried with a corrected number. |
| AC-02 | Medium | Fixed and deployed | Closing an old run and opening its successor were separate operations. Replacement now locks the stable user row and closes, counts, inserts, and prunes in one transaction. A unique expression index independently permits at most one open run per user. |
| AC-03 | Medium | Fixed | Late run-open replies and overlapping heartbeats could revive a replaced attempt or reuse one chain token. Opens are ordered and generation-guarded; beats are serialized; phase transitions queue; teardown invalidates late completions. |
| AC-04 | Medium | Fixed | Score submission could overtake the final heartbeat/phase stamp. A win now waits for the owning heartbeat chain and rechecks run generation before submitting. |
| AC-05 | Medium | Fixed | A delayed ban event selected the newest run rather than the run that raised it. Ban events now require and update the exact run ID, so an old event cannot close a replacement. |
| AC-06 | Medium | Fixed | Run closure and lifetime failure counters were separate writes. Ban, stale sweep, and open-run replacement now update state and counters atomically; deterministic failure-injection tests prove rollback and safe retry. |
| AC-07 | Medium | Fixed | A score could commit and consume its run, then return 500 if rank or feed identity lookup failed. Rank is now computed inside the score transaction; feed publication is explicitly best-effort after commit. |
| AC-12 | Medium | Fixed and deployed | A clean, fast Practice win could finish before its `/run` response and discard an otherwise valid attempt. A clean finish now waits for the run-open promise belonging to its generation, then waits for the owning heartbeat before submitting; flagged, abandoned, banned, and replaced attempts still invalidate late replies. |
| AC-16 | Medium | Fixed | The advertised one-time challenge could be reopened after a solve, and a solve rejected as impossibly fast could wait and retry the same open run. Validator, SQL writer, and database constraint now enforce exactly one cycle; a too-fast solve closes the run. Ownership, expiry, replay, and terminal-state regressions pass. |
| AC-17 | Medium | Fixed | Resizing below the old viewport-dependent play area made Chase easier and also created timer-free pause windows. Every ranked run now uses a centered 1120 x 620 field; smaller viewports pause input while wall-clock time keeps running, and larger viewports add scenery rather than escape room. |
| AC-18 | Medium | Fixed | A cold run-open could settle after the visible challenge was solved, compressing server start/solve timestamps into a false automation verdict. The piece now stays inert until challenge-start acknowledgement, and Simulation does not start its local scored timer until solve plus the urgent server Chase stamp settle. |
| AC-19 | Medium | Fixed | The browser used to own the challenge answer, so a modified client could emit the expected lifecycle and simply wait. The server now generates a fresh CSPRNG seed, stores it immutably on the owned run, returns raster scenes without seed/answer metadata, compares all four choices in constant time, and consumes an incorrect or impossibly fast attempt. Concurrent start/solve requests are idempotent. |
| AC-20 | Medium | Fixed with multi-account residual | Three four-choice rounds left a 1/64 blind success chance, while the route limits still permitted enough fresh runs to guess quickly. Four independent rounds reduce one blind attempt to 1/256. Server-observed mismatches durably ramp retry delay through 0/5/15/30/60 seconds, count once despite concurrent client reports, and reset on a correct solve or ten quiet minutes. A mismatch fails the run but never publishes `cheat_detected`; separate Twitch accounts or addresses remain a budget-evasion residual. |
| FEED-01 | Medium | Fixed | The server and renderer supported `cheat_detected`, but `js/net.js` omitted it from the EventSource allowlist, silently discarding every live event. The transport allowlist and renderer are now covered together. |
| AUTH-01 | Medium | Fixed; architecture residual remains | The fallback bearer persisted in `localStorage` on the shared `themizeguy.github.io` origin. It is now tab-scoped in `sessionStorage`, and legacy persistent copies are purged without migration. A same-origin sibling compromise can still reach the token in the same top-level context; isolate the game on a dedicated origin. |
| AUTH-02 | Medium | Fixed | Logout deleted the bearer before constructing the request, could be suppressed by a prior 30-second client cooldown, and returned success when the server epoch bump failed. It now sends the bearer first, bypasses cooldown, removes local copies immediately, and returns an explicit 503/false result when revocation cannot be confirmed. |
| RC-02 | Medium | Fixed and deployed | SSE writes ignored backpressure and best-effort feed persistence had no in-flight bound, so slow readers or a stalled database could accumulate process memory/pool waiters. A false `write()` drops that client immediately; persistence is capped at 32 in-flight saves with an explicit dropped-save counter. |
| API-02 | Medium | Fixed and deployed | The seven-day rejection prune ran only on successful run creation and leaderboard reads, so mutation-only invalid traffic could retain audit rows indefinitely. Every authenticated mutation can now trigger independently throttled retention. Stale-run closure uses a separate clock/path so maintenance cannot close the score or beat currently being validated. |
| DB-01 | Medium | Fixed | PostgreSQL acquisition was bounded but statements, locks, queries, and idle transactions were not. Pool policy now sets 10 s statement, 12 s query, 5 s lock, and 15 s idle-transaction timeouts. |
| DB-02 | Medium | Fixed | Connection-string query options override explicit node-postgres pool options. `DATABASE_URL` now rejects every query parameter, preventing `ssl=0`, host replacement, and other hidden policy overrides. Public hosts require verified TLS/channel binding; Railway private hosts use the encrypted private network. |
| API-01 | Medium | Fixed | The 4 KB JSON cap applied only under `/api`; `/auth/logout` and unknown state-changing paths accepted larger bodies. The parser/cap now covers every JSON-bearing route after the CSRF wall. |
| CFG-01 | Medium | Fixed | Partial integers, unknown booleans, public HTTP origins, unsafe return paths, weak secrets, invalid ports/TTLs/floors, empty salts, and ambiguous database URLs did not all fail closed. Exact bounded parsing now rejects them at boot. |
| AC-08 | Low | Fixed | A two-beat clamp imposed a hidden four-second minimum despite a 700 ms engine arming gate. One fresh chained witness is now sufficient for a short Chase; honest 1839 ms Practice and Simulation regressions pass. |
| SEC-01 | Low | Risk accepted by owner | Railway configuration inspection displayed three live credential values in this private local transcript. Repository, history, application-log, and report scans are clean. The owner treats local transcripts as trusted storage and does not require rotation; rotate if this transcript is shared/exported or the local-access model changes. |
| AC-09 | Low | Fixed | A future `last_beat_at` timestamp produced a negative age that passed freshness. Negative heartbeat age now fails closed. |
| AC-10 | Low | Fixed as friction | Flappy accepted ordinary script-dispatched pointer/touch/key events. It now rejects events not marked trusted, matching Chase-side defenses. CDP/WebDriver remains a stated residual. |
| AC-11 | Low | Fixed | `nearMisses >= 3` rejected a legitimate browser win while providing no integrity because the field is client-controlled. Cosmetic counters remain bounded telemetry and are never anti-cheat proof. |
| DB-03 | Low | Fixed | Database state could drift beyond application assumptions. Users now reject negative counters/epochs; runs reject impossible counter/state combinations; the submission ledger has FK, mode, time, shot-clock, and counter constraints. |
| WEB-01 | Low | Partially fixed | Static CSP now restricts scripts and API connections. GitHub Pages cannot emit a response `frame-ancestors` policy, so clickjacking protection requires a configurable host/CDN. |
| AUTH-03 | Low | Fixed | Session claims and Twitch identity fields accepted weak shapes. Tokens now require one delimiter, bounded subjects, safe timestamps/lifetimes/epochs; Twitch IDs/logins are bounded and validated. |
| EXT-01 | Low | Fixed and deployed | Twitch JSON responses were parsed without a decoded-size ceiling, and token-revocation refusal was silent. Provider bodies are now streamed through a 64 KiB cap before parsing; revoke returns a status and login logs only a generic failure without retaining or exposing the token. |
| RC-03 | Low | Fixed and deployed | Client cooldown covered transport failures but not HTTP 5xx or malformed successful JSON, allowing repeated requests during a broken API response loop. Both now enter the same bounded cooldown; deliberate logout still bypasses it. |

## Physics and protocol conclusions

- The earliest deterministic Simulation handoff is 15.922 seconds: 250 ms ready lock, 15.072
  seconds to clear ten pipes, and a 600 ms victory handoff. The 12-second server-observed Flappy
  minimum leaves under four seconds for cold run-registration latency.
- Chase can be configured down to the engine's 700 ms arming gate. A real browser completed a clean
  win in 1.839 seconds, so the live 2-second floor can reject a legitimate fast result. Lowering the
  floor also makes the protocol-only bypass faster; a floor is anomaly filtering, not gameplay proof.
- A claim may exceed the server-observed scored Chase duration by at most three seconds and may be
  shorter by at most 1.5 seconds for request timing. Practice subtracts only its server-timestamped
  puzzle interval. Required heartbeats cover that scored window, and the latest credited beat must
  be fresh. A materially backwards claim is terminal and public.
- The visual challenge is freshly CSPRNG-seeded on the server, four rounds, one-attempt, and placed
  after Flappy/before Chase in Simulation or 0.5-1.8 seconds into Practice. Simulation samples a new
  independent x/y popup spawn after it closes. The browser receives only rasters and public candidate
  coordinates; a visual solver can still recover the choices, so this remains friction rather than
  proof.
- A wrong visual choice fails only that run and is not called cheating. Rapid repeated mismatches add
  short server-persisted retry delays capped at 60 seconds; success or ten quiet minutes resets them.
- A bot that solves the visual task can still wait out the real server windows and claim the configured
  floor without playing Chase. The earlier protocol-only 700 ms Practice probe was accepted at rank 1
  before server-owned answers were added; the current direct wait-only version is rejected. Neither
  result changes the architectural fact that correctly timed browser protocol is not gameplay proof.
- Misses, near misses, clicks, ban reasons, and Flappy deaths are cosmetic/client-controlled. They do
  not establish skill or authorize a leaderboard write.

## OWASP API and control matrix

| Control | Verdict | Evidence / severity rule |
|---|---|---|
| API1 Broken Object Level Authorization | Pass | `server/api.js:302-313`, `397-414`, and `496-500` scope run reads/mutations to the signed subject; public rows are explicit DTOs at `server/api.js:109-131`. |
| API2 Broken Authentication | Partial — Medium | Sessions are signed, strictly parsed, expiring, and epoch-revocable (`server/session.js:37-73`; `server/middleware.js:107-153`), with `HttpOnly`, `Secure`, and `SameSite` cookie policy (`server/session.js:165-190`). The tab bearer still shares the broad GitHub Pages origin, requiring an adjacent same-origin compromise: decision-test rule 3. See remediation block. |
| API3 Broken Object Property Level Authorization | Pass | Boundary parsers explicitly select mutation fields (`server/validation.js:116-203`); response DTOs are explicit (`server/api.js:109-131`, `247-264`). No row is mass-assigned or returned wholesale. |
| API4 Unrestricted Resource Consumption | Partial — Medium | The service has a global address ceiling and route/user budgets (`server/app.js:67-75`; `server/api.js:146-170`), 4 KiB JSON bodies (`server/app.js:84-88`), bounded feed/pool/audit state, DB timeouts, and durable challenge-guess backoff. Process-local budgets remain a rule-3 scaling gap and multiply if the service is scaled beyond one replica. See remediation block. |
| API5 Broken Function Level Authorization | Pass | Every mutation route at `server/api.js:269-546` is session-gated; there is no admin route, and the shared fallback returns 404 (`server/app.js:92-94`). |
| API6 Unrestricted Access to Sensitive Business Flows | Fail — High | The server verifies four exact visual answers, challenge timing, phase order, two-sided elapsed time, and liveness (`server/api.js`; `server/validation.js`), but it never verifies that Chase gameplay occurred. A controlled browser/vision agent solved the randomized raster task, and an earlier protocol-only probe then received HTTP 200/rank 1 without Chase. This exceeds the authenticated caller's intended scoring privilege: decision-test rule 2. See remediation block. |
| API7 Server Side Request Forgery | N/A | No caller controls an outbound URL. Twitch destinations are module constants and only fixed endpoints are fetched (`server/twitch.js:90-169`). |
| API8 Security Misconfiguration | Partial — Low | API headers/CSP/CORS/CSRF are strict (`server/middleware.js:33-102`), configuration fails closed, and public DB TLS is verified. The static GitHub Pages response cannot send `frame-ancestors`: decision-test rule 3. See remediation block. |
| API9 Improper Inventory Management | Pass | The complete small route inventory is visible at `server/api.js:247-681` and the auth router; audit/admin/debug probes are covered, and unknown routes fail closed at `server/app.js:92-94`. |
| API10 Unsafe Consumption of APIs | Pass | Twitch calls use fixed destinations, ten-second aborts, status/shape checks, a 64 KiB decoded-body cap, bounded identity, and no provider-body logging (`server/twitch.js:29-70`, `90-169`). |
| Secret management | Pass under declared threat model | `.env` is ignored, `.env.example` contains placeholders, and source/history scans found no committed credential. Three values appeared only in this owner-trusted local transcript; the owner explicitly accepts that storage. Rotation becomes required if the transcript is shared/exported or local access ceases to be trusted. |
| JWT-specific controls | N/A | No JWT or header-selected algorithm is used. The fixed HMAC session format has strict claims, constant-time comparison, expiry, and epoch revocation (`server/session.js:37-73`; `server/middleware.js:129-153`). |
| Dependency supply chain | Partial — Medium | `server/package-lock.json` is pinned; runtime dependencies are only Express and node-postgres (`server/package.json:15-18`); clean install used 104 packages; `npm audit` reports zero vulnerabilities and `npm outdated` is empty. No SBOM, artifact signing, Dependabot, or repository secret-scanning workflow exists: missing inventory/telemetry under decision-test rule 3. See remediation block. |
| Logging security | Pass | Request logs remove query strings (`server/app.js:30-47`); rejection logs omit tokens/cookies/raw addresses and HMAC the address (`server/recorder.js:10-17`, `76-150`). Provider response bodies are never logged. |
| Input validation | Pass in source | Origin/media type/body size, modes, tokens, challenge events, score bounds, configuration, Twitch identity, and URL policy are boundary-validated (`server/middleware.js:69-102`; `server/validation.js:116-203`; `server/twitch.js:135-151`). SQL is parameterized throughout `server/store.js`. |

### Required remediation for partial/failed controls

API2 — isolate the bearer from unrelated same-origin content:

```text
Put the game on a dedicated origin with no sibling applications
Update GAME_ORIGIN and Twitch's allowed callback/return configuration
Serve a response CSP with frame-ancestors 'none'
Keep the bearer tab-scoped; do not restore localStorage persistence
Retest cookie-blocked Safari/Firefox login and logout
```

API4 — close the live resource-control gap and preserve the one-replica invariant:

```text
Keep the API at exactly one replica
Before scaling, move rate budgets and OAuth nonce consumption to shared atomic state
Externalize SSE accounting/replay coordination or enforce a global equivalent
Load-test every global/auth/run/beat/score/public/SSE ceiling across the final topology
```

API6 — if records become prize-bearing or tournament-grade:

```js
// Fail closed at the score boundary until an independently operated verifier
// has validated a one-time token bound to this user and run. `humanVerifier`
// must perform the provider's server-to-server verification; a browser boolean
// or a locally generated puzzle result is not sufficient.
if (!humanVerifier) return fail(req, res, 'verification_unavailable');
const proof = await humanVerifier.verify({
  token: claim.verificationToken,
  userId: req.session.sub,
  runId: claim.runId,
  remoteAddress: clientAddress(req),
});
if (!proof.ok || proof.consumed || proof.action !== 'leaderboard_score') {
  return fail(req, res, 'challenge_required');
}
await store.consumeVerification(proof.id, req.session.sub, claim.runId, nowDate);
```

Do not deploy this sketch with a self-issued token. Provider selection, keys, privacy terms, and
server-side verification need owner approval. A server-owned raster/trajectory challenge is a useful
fallback but is still automatable; external attestation and reversible record moderation remain the
stronger design.

API8 — complete hosting isolation:

```text
Choose FLOOR_PRACTICE_MS and FLOOR_SIM_MS explicitly after weighing fast-player false positives
against the open protocol-only bypass; do not describe either value as proof of gameplay
Serve the static client from an isolated host/CDN that sends frame-ancestors 'none'
Verify strict headers, CORS/CSRF, DB TLS classification, and both game modes live
```

Dependency supply chain — add inventory and update/secret-scanning automation:

```sh
cd server
npm exec --yes @cyclonedx/cyclonedx-npm -- --output-file sbom.cdx.json
npm audit --audit-level=low
# Add reviewed Dependabot and secret-scanning workflows using the repository's
# approved self-hosted/Namespace runners; never use GitHub-hosted runner labels.
```

## Residual risks and invariants

1. **Single-replica invariant.** Rate limits, OAuth nonce replay state, SSE connection counts, and
   parts of feed state are process-local. Core run/score invariants are database-safe, but abuse
   budgets multiply on scale-out.
2. **Human-vs-bot limit.** Trusted browser events, hashes, signatures, and liveness raise cost but
   cannot distinguish skilled automation from a human.
3. **Shared static origin.** `sessionStorage` narrows bearer persistence but does not isolate it from
   a same-origin frame/page in the same top-level context.
4. **Clickjacking header.** Meta CSP cannot enforce `frame-ancestors`; GitHub Pages does not provide
   arbitrary response headers.
5. **Deployment draining.** Railway's default drain interval is zero, so a deploy can terminate an
   in-flight score. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` for the controlled rollout.
6. **Process outage during logout.** Local bearer copies are removed immediately, but if the API or
   database is genuinely unavailable, server-side revocation cannot complete. The client now reports
   false and the API reports 503 instead of claiming success.
7. **Cosmetic event abuse.** A player can inflate their own Flappy deaths/failure captions. Those
   values never move a score, but the public stats order could become noisy.
8. **Real-PostgreSQL test gap.** No local/remote ephemeral PostgreSQL runtime was available for the
   newly added rollback tests. Deterministic transaction fakes test BEGIN/COMMIT/ROLLBACK behavior,
   pg-mem tests schema/query behavior, and production read-only queries prove current data is
   migration-compatible. The actual migration/rollback behavior remains a rollout gate.

Railway documents `X-Real-IP` as the public client address and a zero-second default deployment drain:
[public networking specifications](https://docs.railway.com/networking/public-networking/specs-and-limits),
[deployment reference](https://docs.railway.com/deployments/reference). GitHub documents custom-domain
support for isolating a Pages site: [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).

## Verification evidence

| Layer | Result |
|---|---|
| Latest focused touched-surface tests | 196 passed, 0 failed, 0 skipped across challenge, API, client, store, and validation tests. |
| Full clean remote `npm test` | 226 passed, 0 failed, 0 skipped after a fresh `npm ci`. |
| Syntax/whitespace | `node --check` across server/client JavaScript and `git diff --check`: pass. |
| Client manifest | SHA-256 of all five scripts exactly matches the embedded build manifest. |
| Dependency state | `npm audit`: 0 vulnerabilities across 104 packages; `npm outdated`: empty. |
| Browser runtime | Against the old gate, a native browser-input locator loop won Practice in 3.638 s. Exact boundary matching initially solved 98% of three-round raster runs; candidate masking and piece transformation reduced that regression to chance. A controlled browser/vision attempt then solved all three hardened rounds, proving the human-vs-bot residual. Four rounds now ship. The page produced Practice challenge timing inside the 0.5-1.8 s window, kept small viewports paused without refunding wall time, and rendered Simulation at 128 x 93 versus Practice at 136 x 172. |
| Direct-protocol adversarial probe | Against the preceding client-answer design, a modified authenticated client emitted the signed lifecycle and waited 700 ms without Chase; the server returned HTTP 200/rank 1. The current no-answer and wrong-answer versions are rejected and cannot qualify a run. AC-13/API6 remains because the controlled vision attempt recovered the server-owned answers. |
| Physics | Deterministic earliest Simulation handoff: 15.922 s; honest 1.839 s Chase regression accepted at a 700 ms source floor. |
| Pre-release production data | Read-only PostgreSQL checks: 0 duplicate open users, 0 invalid run-state/counter groups observed, 0 orphan submission rows, and 0 submission rows incompatible with new constraints. No records were altered during the audit. |
| Production API rollout | Railway deployment `308cf46c-1d36-4ca9-a7d4-c48b3773a239` reached `SUCCESS`; boot logged `schema ready`, `/healthz` returned 200 with hardened headers, the allowed-origin leaderboard returned 200, all five new challenge/retry columns and three state constraints were present, and both post-migration invariant queries returned zero invalid rows. |
| Secret scans | Current tree and complete git history: no AWS/GitHub/OpenAI/Slack/PEM pattern match and no tracked `.env`/private-key file. The owner accepts private-transcript storage under the declared threat model. |

## Controlled rollout gate

Do not call production cheat-proof. A browser-owned game cannot supply independent proof that it was
played. Do not call the narrower source fixes production-hardened until all of these are complete:

- Owner explicitly approves the production rollout.
- Owner either accepts AC-13 for a casual leaderboard or selects an independently validated verifier
  and approves its provider, keys, privacy terms, failure policy, and record-moderation workflow.
- Score floors are chosen explicitly with the documented false-positive/bypass tradeoff, and the
  drain interval is set to 30 seconds.
- Reviewed files are committed intentionally, pushed once, and CI passes from that one push.
- Railway performs one deployment; boot migration succeeds on real PostgreSQL.
- Static page, CSP, and exact manifest hashes are live.
- Signed-in Practice and Simulation wins work end to end without an unnecessary forced logout.
- Rotating `X-Forwarded-For` values cannot escape a public limit; phase-prepayment and concurrent-run probes fail live.
- Logout invalidates a captured token; Twitch OAuth and PostgreSQL remain healthy with the existing credentials.
- No credential value is read back or printed during rollout verification.
- Logs contain no credential values or unexpected 5xx responses during the observation window.
- API replica count remains one, or every process-local security control has been externalized.
