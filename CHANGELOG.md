# Changelog

## Unreleased

### Bug Fixes

* silence Baileys protocol logs by default and publish Actions results outside raw logs

### Documentation

* explain billed wait windows, per-account Actions serialization, and the single-socket backend pattern

## [0.1.9](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.8...v0.1.9) (2026-08-03)

### Bug Fixes

* use an available GitHub context for the encrypted state directory

### Integration

* upgrade with `npm install baileys-agent-kit@0.1.9`
* GitHub Actions users should update the included `whatsapp-action.yml`; local CLI/MCP and existing Upstash integrations need no configuration changes from `0.1.8`

## [0.1.8](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.7...v0.1.8) (2026-08-03)

### Features

* use free secure local file storage by default with optional Upstash compatibility
* add encrypted GitHub Actions state synchronization without caches, artifacts, Vercel, or a hosted database
* automatically prefer one-time-code pairing on Israeli machines without external geolocation

### Security

* persist safety reservations before GitHub Actions sends and use unified account concurrency
* require the patched Hono release used by the MCP transport

### Integration

* upgrade with `npm install baileys-agent-kit@0.1.8`
* local CLI and MCP users need no database configuration; run `baileys-agent doctor`, then `baileys-agent pair`
* Israeli interactive terminals now prompt for a `+972...` number and return a one-time code; JSON or other non-interactive use must pass `--phone-number` or `WA_PHONE_NUMBER`
* existing Upstash users continue unchanged; new GitHub Actions users can pair locally and run `baileys-agent github-state setup --repository OWNER/REPO`

## [0.1.7](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.6...v0.1.7) (2026-08-03)

### Bug Fixes

* verify Redis write access in doctor and return structured pairing API failures
* preserve credentials before pairing reconnects and classify broker HTTP failures correctly

### Features

* load local environment files in CLI, MCP, and scripts
* add the `recent-accounts` CLI command

## [0.1.6](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.5...v0.1.6) (2026-08-03)

### Features

* add QR-alternative one-time-code pairing to the private page, CLI, MCP, and core API
* add bounded, opt-in recent-account metadata prefetching

### Performance

* skip dependency installation in GitHub Actions on exact-lockfile cache hits

## [0.1.5](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.4...v0.1.5) (2026-08-03)

### Features

* add replies, media albums, bounded message receiving, and profile lookup
* add private square-QR pairing links with manual refresh

## [0.1.4](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.3...v0.1.4) (2026-08-02)


### Bug Fixes

* allow empty send limits ([07c0d9b](https://github.com/I-No-oNe/baileys-agent-kit/commit/07c0d9b8aeafda754f866c75602f4375cdf92636))

## [0.1.3](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.2...v0.1.3) (2026-08-02)


### Bug Fixes

* refresh expired pairing QR codes ([41d7fcd](https://github.com/I-No-oNe/baileys-agent-kit/commit/41d7fcdcf28ec8682761f2ad852fd8963617b800))

## [0.1.2](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.1...v0.1.2) (2026-08-02)


### Bug Fixes

* explain failures to agents ([347902f](https://github.com/I-No-oNe/baileys-agent-kit/commit/347902fb8216d3d1134b11c4bca4d40a5ce929aa))

## [0.1.1](https://github.com/I-No-oNe/baileys-agent-kit/compare/v0.1.0...v0.1.1) (2026-08-02)


### Bug Fixes

* add reliable npm publishing ([6b396df](https://github.com/I-No-oNe/baileys-agent-kit/commit/6b396df58d5c96a771161f11112f72da7d7da07f))
