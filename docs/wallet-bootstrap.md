# Wallet Bootstrap

## Purpose

This document defines how the live bot obtains and manages the credentials required to trade on Polymarket.

The live system is fully automated. It does not rely on a browser wallet popup for each trade. The production live path uses the official Polymarket trading client with backend-held wallet material and stored trading credentials.

## Goals

The bootstrap process must:

- establish live trading identity
- obtain the credentials required for authenticated trading
- validate signer health
- keep private material server-side
- support deterministic startup checks before the bot enters `running`

## Wallet model

The repository supports a backend-held live trading model.

That means:

- signing material is loaded by the backend
- credentials are not stored in the frontend
- the web app is an operator console, not a signer
- live order placement happens through the worker runtime

## Bootstrap stages

## 1. Load private signing material

At boot, the system loads the configured signing material from environment or secret storage.

This includes:

- trading private key or signing material
- any required funder metadata
- signature type configuration
- chain configuration

The signing engine is responsible for loading the key material and normalizing it into the format required by the official Polymarket client.

## 2. Initialize L1 bootstrap context

The Polymarket adapter initializes the bootstrap context used to establish authenticated trading credentials.

The result of this stage should be a valid identity context for later authenticated API access.

## 3. Derive or load L2 credentials

The system must load or derive the credentials used for authenticated trading requests.

These credentials must remain server-side.

Credential handling should support:

- initial creation / derivation
- loading existing credentials
- basic validation
- secure persistence policy

## 4. Validate credential usability

Before the bot can start, the system must validate that:

- credentials are structurally present
- signer health is good
- authenticated requests can be created successfully
- the bot can communicate with the live trading venue

The system must not rely on “hopeful startup.”

## 5. Verify signer health

The signing engine must expose a signer health check.

The health check should confirm:

- signing material loaded
- expected venue credentials present
- key material is usable by the official Polymarket client
- no initialization failure occurred

If signer health is bad, the bot must not enter `running`.

## 6. Persist runtime readiness state

After successful bootstrap, the API and worker runtime should expose readiness state for:

- signer
- venue auth
- market connectivity
- live trading readiness

This is what the Start control should validate before activating the bot.

## Environment variables

The live bootstrap path expects configuration similar to:

```env
POLY_CLOB_HOST=https://clob.polymarket.com
POLY_GAMMA_HOST=https://gamma-api.polymarket.com
POLY_CHAIN_ID=137
POLY_PRIVATE_KEY=
POLY_API_KEY=
POLY_API_SECRET=
POLY_API_PASSPHRASE=
POLY_SIGNATURE_TYPE=0
POLY_FUNDER=
```

Exact validation rules are implemented in application config and signing packages.

## Where bootstrap logic lives

Bootstrap logic is split across these packages:

`packages/signing-engine`

Responsible for:

- loading signing material
- signer health checks
- Polymarket private-key normalization

`packages/polymarket-adapter/auth`

Responsible for:

- L1 bootstrap flow
- L2 credential handling
- credential persistence and loading

`packages/polymarket-adapter/src/official-trading-client.ts`

Responsible for:

- official live Polymarket SDK client construction
- live order signing inside the official SDK path
- submit / cancel / open-order / trade queries on the live venue

`apps/api/modules/bot-control`

Responsible for:

- exposing readiness state
- refusing Start when bootstrap has not succeeded

`apps/worker/runtime`

Responsible for:

- validating readiness at runtime
- refusing execution when bootstrap state is invalid

## Frontend role

The frontend does not participate in live order signing.

Its role is to display:

- signer readiness
- credential readiness
- bot control state
- health and diagnostics

The frontend should never receive private trading credentials.

## Startup sequence

The expected startup sequence is:

- process env and configuration load
- signing engine loads signing material
- Polymarket auth layer loads or derives credentials
- readiness checks run
- API exposes readiness
- worker runtime waits for Start
- Start validates readiness before transitioning to running

## Failure handling

Bootstrap failures must be explicit.

Examples:

- missing private key
- missing API key set
- signer health failure
- invalid venue host configuration
- inability to create authenticated client context

Any such failure must:

- block Start
- emit audit / log events

surface clearly in health or bot-control responses

Rotation and replacement

Credential rotation should be treated as an operational event.

Expected behavior:

bot is stopped before rotation

credentials are replaced

readiness is revalidated

bot is restarted explicitly

The system should not hot-swap live credentials silently.

Security rules

Mandatory rules:

never expose private key material to the frontend

never expose secret credentials in API responses

never log raw secrets

never allow Start if bootstrap validation is incomplete

never allow the worker to keep trading after signer readiness becomes invalid

Manual bootstrap support

If needed, the system may support a manual credential bootstrap step outside the runtime.

Examples:

one-time credential derivation

secret-store seeding

operational verification before production start

This manual step is not part of the live trade loop.

Readiness states

Recommended readiness states include:

uninitialized

loading

ready

failed

The bot Start path should require ready.

Summary

Wallet bootstrap in this repository means:

load signing material

establish authenticated trading credentials

verify signer health

expose readiness

block live execution until all prerequisites are valid

This is a server-side production trading bootstrap path, not a browser-wallet confirmation flow.

## Secret Provenance Policy

Production startup now refuses unsafe trading-secret sources.

Blocked in live production:

- repo-local `.env`
- repo-local `.env.smoke`
- local dotenv-style file sourcing
- unknown secret provenance

Allowed in live production:

- explicit process-environment injection
- approved external secret-provider file mounts

The startup verdict records which secrets were required, whether they were present, and whether each source was approved.

## Startup Verdict And Readiness

Bootstrap now ends in one persisted startup verdict that combines:

- startup runbook evidence
- signer health
- secret-policy approval
- crash recovery outcome
- market/user stream bootstrap health

The runtime must not enter `running` until that verdict passes.

## Production Readiness Suite

Run `scripts/run-production-readiness.sh` to execute the machine-readable readiness suite before live activation.
