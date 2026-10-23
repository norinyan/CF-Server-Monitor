# CF-Server-Monitor Docker validation — 2026-10-23

Result: PASS. Ready for a separately authorized production release; no release performed.

## Environment and isolation
- Existing local image: node:22.20.0-bookworm-slim
- Image ID: sha256:79c937a8af711b5fa6bb4c3ca859d71f0c5bc63105f4f7643a77ab8ea52f5b1d
- Node 22.20.0, npm 10.9.3, Debian 12, glibc 2.36, workerd 2026-08-01.
- Container: cfsm-validation-20261023; network none, no published ports, user 1000:1000,
  all capabilities dropped, no-new-privileges, 2 CPUs/2 GiB, temporary in-memory workspace.
- Only allowlisted sources/assets and npm package cache copied. No .git, .env,
  .dev.vars, OAuth files, production secrets, host home or Docker socket mounted.
- npm ci --offline installed 86 locked packages. No dependency version changes.

## Final validation
- npm run test:all: exit 0.
- Main suite: 104 passed / 0 failed / 0 skipped, including 15 API permission scenarios.
- Agent config assertions: passed.
- History D1 suite: 6 passed / 0 failed / 0 skipped.
- Real runtime: 8 nested scenarios plus parent (Node reports 9 passed), no failures/skips.
- Runtime uses actual bundled Worker, Miniflare/workerd, local D1, SQLite Durable Object,
  ASSETS, browser WebSocket and Agent WebSocket; no mocked DO or D1 in runtime suite.
- Runtime coverage: local schema initialization and admin login; anonymous/forged denial;
  Agent POST invalid/valid secret and D1 persistence; public projection; Bearer/Cookie metrics
  and history; real HTML/assets; browser hello/pong; Agent invalid secret/valid report persistence.
- Frontend build: passed. 328 files enumerated in artifact-manifest.json.
- Wrangler dry-run: passed; bundle 450039 bytes. No upload/deployment executed.
- Config: expected Worker, workers.dev + vps.norin.me Custom Domain, existing D1 UUID,
  SQLite DO migration, Assets binding retained; no API_SECRET plaintext configuration.

## Failures investigated
1. Host Docker socket sandbox denial: authorized Docker execution; no host upgrades.
2. Snapshot omitted donate image directory: corrected snapshot, no application change.
3. docker cp into tmpfs not visible: streamed allowlisted tar over docker exec stdin.
4. New runtime fixture initially routed all requests to assets (404), then forced JS
   through Worker HTML fallback: matched actual assets-first/Worker fallback; all pass.
5. mkcert: Vite SSR unit fixture explicitly disables HTTPS/HMR. Assertions retained;
   real WebSocket independently exercised. No mkcert download/CA/trust installation.

## Changes in this phase
- test/frontend-live-socket.test.js: isolate SSR test from mkcert/HTTPS/HMR.
- test/worker-runtime.test.js: actual local Worker/D1/DO/assets/WebSocket integration.
- package.json: test:runtime; include it in test:all.
- test/README.md: compatible environment, isolation and commands documented.
- No business code changes in this phase. Prior accepted feature work retained.

## Cleanup and production boundary
- Temporary container deleted; tmpfs dependencies, database, DO state removed.
- Input tar, update tar, runner script removed. Reports and artifact hashes retained only.
- Existing kin-03, vm2api (healthy), hfun-navi-simulation-dev-1 remain running with same IDs.
- Existing Docker image retained unchanged; no image/network/volume pruning.
- No production credentials loaded, no production DB modified, no Cloudflare deployment,
  no GitHub push, no host system/trust changes.
- Production DNS/TLS and real-password login still belong to post-release smoke acceptance;
  intentionally not exercised against the live site during this local test phase.
