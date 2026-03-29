# Resolved Position Settlement Integration Design

## Scope

This design is limited to the four winning resolved positions already identified on the current `.env` account:

- `854388...6004`
- `207317...2990`
- `349293...3834`
- `672817...7121`

Out of scope for the first executor pass:

- loser residues `399639...3823`, `137551...3188`, `114987...2814`, `595259...8417`, `102513...1963`, `506329...4396`, `236119...2562`
- historical-only trade `204699...0832`
- any `SELL`-based liquidation
- any `postOrder` / `cancelOrder` path

## Discovery Summary

### Confirmed non-path

The bundled `@polymarket/clob-client@5.8.0` does not expose any redeem / claim / settle / merge primitive. It only exposes order-management and market-data methods.

### Confirmed real settlement path

Polymarket documents resolved-position settlement as a gasless relayer flow, not a CLOB flow:

- standard resolved conditional tokens: submit `ConditionalTokens.redeemPositions(...)`
- negative-risk markets: submit `NegRiskAdapter.redeemPositions(...)`
- transport: `@polymarket/builder-relayer-client`
- builder authentication: `@polymarket/builder-signing-sdk`

For the current account, the validated relayer mode is `RelayerTxType.SAFE`, because:

- `.env` uses `POLY_SIGNATURE_TYPE=2`
- the private-key EOA is `0x9d4653179C6a6d3AE3F036317663Bc9F6b4E1C4e`
- the configured trading account / funder is `0xc01d605ACD41A68FaC08685e0AA61700726dF7E6`
- Polymarket documents signature type `2` as `GNOSIS_SAFE`
- the relayer client's deterministic Safe derivation for that EOA matches the configured funder exactly
- relayer `GET /nonce?address=<EOA>&type=SAFE` returns a live nonce while `type=PROXY` does not reflect the same wallet history

That means a plain direct `ethers.Contract` call from the private-key EOA would not execute from the funded trading wallet that currently owns the position inventory, and the correct relayer transaction type for settlement is `SAFE`, not `PROXY`.

## Exact Primitive

### Standard CTF redeem

Contract:

- Conditional Tokens Framework on Polygon: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`

Collateral:

- USDC.e on Polygon: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

Minimal ABI:

```ts
const ctfRedeemAbi = [
  {
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
```

Required inputs:

- `collateralToken`: USDC.e address
- `parentCollectionId`: `0x000...000`
- `conditionId`: bytes32 condition id for the resolved market
- `indexSets`: one or more index-set integers for the outcome slots being redeemed

### NegRisk redeem

Polymarket also documents a separate adapter path:

- NegRisk Adapter on Polygon: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

Minimal ABI:

```ts
const negRiskRedeemAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256[]", name: "_amounts", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
```

This adapter path should not be used unless the target position is positively identified as a negative-risk market.

## Current Account Readiness

### What the repo already has

- `ethers@5.8.0`
- private-key loading via `ServerSigner`
- current dry-run planner and snapshot hashing
- the exact target token set and settlement ordering

### What the repo does not yet have

- `@polymarket/builder-relayer-client`
- explicit settlement relayer env/config
- a dedicated settlement adapter/service
- transaction receipt polling and artifact schema for relayer settlement

### Auth gap

The validated package path for authenticated settlement is:

- `RelayClient(relayerUrl, chainId, signer, builderConfig, RelayerTxType.SAFE)`
- with `BuilderConfig` using either:
  - local builder credentials: `key`, `secret`, `passphrase`
  - or remote builder signer config: `url`, optional `token`

The current repo/env already has trading API credentials for the CLOB client, but it does not currently define builder settlement credentials or remote builder signer config. Non-mutating relayer probes confirm:

- `GET /deployed?address=0xc01d...F7E6` returns `{"deployed":true}`
- `GET /nonce?address=0x9d46...1C4e&type=SAFE` returns a live nonce
- `GET /transactions` returns `401 invalid authorization`

Because the current account is not a plain EOA trading directly from the private-key address, a direct onchain `ethers.Contract` call is not the safe first implementation path here.

## Important Shared-Condition Constraint

The canonical `ConditionalTokens.redeemPositions` implementation redeems by `conditionId` plus `indexSets`. For each provided index set, it burns the caller's entire balance for that position id.

That matters for:

- winning token `672817...7121`
- loser residue `595259...8417`

Both sit on condition `0x7fd89f90b33db6ee7f1cd5cb3e6f1cd87a3977ec12c792339aaa733ca870d8fd`.

Implications:

- If the executor submits `indexSets` covering both outcomes, it will burn both the winning and losing balances for that condition.
- A winner-only claim may still be possible by supplying only the winning index set, but that must be derived from the outcome slot ordering and verified against live market metadata before implementation.
- The first executor must therefore treat `672817...7121` as a special case and refuse execution unless the winner-only index set can be proven exactly.

## Pair-Merge Judgment

`mergePositions(...)` exists on the underlying Conditional Tokens contract, so merge is real at the contract layer.

However, for this repo and this pass:

- pair-merge is not part of the first settlement executor
- pair-merge would necessarily consume both winner and loser balances
- that conflicts with the current narrow scope of leaving loser residues untouched

So pair-merge should remain excluded from the first live executor, even though the underlying contract supports merging in principle.

## Smallest Safe Implementation Path

### 1. Add a settlement adapter surface

Add a new non-generic adapter module, for example:

- `packages/polymarket-adapter/src/official-settlement-client.ts`

Responsibilities:

- build relayer client in `SAFE` mode for the current account shape
- encode only the supported redeem calldata
- submit one transaction at a time
- poll to `STATE_CONFIRMED` or fail truthfully
- expose typed results and raw transaction metadata

### 2. Add settlement configuration

Add explicit env for settlement auth and transport:

- `POLY_RELAYER_URL` default `https://relayer-v2.polymarket.com/`
- builder auth:
  - `POLY_BUILDER_API_KEY`
  - `POLY_BUILDER_SECRET`
  - `POLY_BUILDER_PASSPHRASE`
- or remote builder signer auth:
  - `POLY_BUILDER_REMOTE_URL`
  - `POLY_BUILDER_REMOTE_TOKEN` (optional)

Do not silently fall back from one auth mode to another.

### 3. Keep the existing planner as the source of truth

The current `settlement-reconciliation.command.ts` should remain the planner / guard layer:

- refresh live snapshot
- abort on open orders
- abort on token-set drift
- reuse the current snapshot hash
- reuse the current confirmation string
- preserve dry-run as default

### 4. Add a strictly limited execute branch

Only after all current gates pass:

- allow execution only for the 4 winning target positions
- keep the exact order:
  1. `854388...6004`
  2. `207317...2990`
  3. `349293...3834`
  4. `672817...7121`

Execution model:

- one transaction per condition
- wait for a terminal relayer state before moving to the next item
- write per-token result immediately after each terminal outcome

### 5. Gate `672817...7121` separately

Before sending any live transaction for `672817...7121`, the executor must prove:

- the market is standard CTF, not neg-risk
- the exact winning index set for the `Up` outcome
- that the calldata redeems only the winner side intended for this pass

If that proof cannot be established from live market metadata plus deterministic mapping logic, skip that token and report it as unresolved.

## Repo Modules Likely To Change Later

- `apps/worker/src/commands/settlement-reconciliation.command.ts`
- `apps/worker/src/config/env.ts`
- `packages/polymarket-adapter/src/index.ts`
- `packages/polymarket-adapter/src/official-settlement-client.ts` (new)
- optionally `packages/polymarket-adapter/src/parsers/...` only if outcome-slot mapping needs a typed helper

## Future Artifact Requirements

Dry-run artifacts should remain unchanged except for adding settlement-readiness evidence.

Execute artifacts should add:

- relayer transaction id
- relayer state
- onchain transaction hash
- target token id
- condition id
- chosen settlement primitive
- exact calldata target contract
- claimed amount if determinable
- skipped reason if not executed
- final unresolved residues

## Failure Modes To Design For

- missing builder or relayer auth
- relayer rejecting unauthenticated requests
- wrong relayer transaction type
- signer / account mismatch
- token-set drift since dry run
- open order drift
- wrong outcome index-set mapping
- shared-condition accidental burn of loser residues
- relayer timeout or `STATE_FAILED`
- settlement succeeds onchain but artifact write fails

## Mapping Proof

All four winning tokens were validated as standard CTF, not neg-risk:

- Gamma slug metadata reports `negRisk=false`
- binary outcomes are `["Up","Down"]`
- live `clobTokenIds` arrays match the outcome ordering
- direct non-mutating `eth_call` against the Polygon CTF contract proves the exact `indexSet -> positionId` mapping

Proven mappings:

- `854388...6004`
  - slug `btc-updown-5m-1773743400`
  - condition `0xf7dbefff7afa138b3605a85ef1d86f5a7e433187261001c6802164e097f2f61f`
  - winner outcome `Down`
  - primitive `ConditionalTokens.redeemPositions`
  - exact winner-only parameter: `indexSets=[2]`

- `207317...2990`
  - slug `btc-updown-5m-1774266300`
  - condition `0xf1a24b08211f6a5765ff5d926611483bc1cade7443f134789edeb2e5a279d814`
  - winner outcome `Down`
  - primitive `ConditionalTokens.redeemPositions`
  - exact winner-only parameter: `indexSets=[2]`

- `349293...3834`
  - slug `btc-updown-5m-1773750600`
  - condition `0x4d302c4c48ae67e3840aa79f5bb6703bd5bb38fb1d92a1bff850d713f6f39e68`
  - winner outcome `Up`
  - primitive `ConditionalTokens.redeemPositions`
  - exact winner-only parameter: `indexSets=[1]`

- `672817...7121`
  - slug `btc-updown-5m-1773742500`
  - condition `0x7fd89f90b33db6ee7f1cd5cb3e6f1cd87a3977ec12c792339aaa733ca870d8fd`
  - winner outcome `Up`
  - primitive `ConditionalTokens.redeemPositions`
  - exact winner-only parameter: `indexSets=[1]`

Shared-condition loser residue:

- `595259...8417`
  - same condition `0x7fd89f90b33db6ee7f1cd5cb3e6f1cd87a3977ec12c792339aaa733ca870d8fd`
  - loser outcome `Down`
  - exact loser mapping: `indexSets=[2]`

Because `redeemPositions` iterates only over the supplied `indexSets`, redeeming `672817...7121` with `indexSets=[1]` does not require burning `595259...8417`.

## Readiness Judgment

Partial path identified, more discovery needed.

What is now precise:

- real settlement is not a CLOB method
- the supported path is relayer + direct redeem calldata
- the current account needs a relayer-capable `SAFE` path, not a plain direct contract call
- the repo can support the signer side with the existing private key tooling

What remains unresolved before a safe live implementation:

- whether the current `.env` stack has, or can safely obtain, builder settlement credentials or remote builder signer config
