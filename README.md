# CopyTrade — Follow people, not tickers

People, not tickers: a social copy-trading board where every trader publishes a track record, GenLayer validators audit it, and only an audited trader can be copied — with a copy weight set by the verdict.

**Live site:** https://xiaoyu7799.github.io/copytrade-social-genlayer/

**Contract:** [`0xF9FC6D2244b8032827EBea844Ce56D44233A69d6`](https://explorer-studio.genlayer.com/address/0xF9FC6D2244b8032827EBea844Ce56D44233A69d6) on Stable Studionet (Chain 61999)

**Evidence:** [`evidence.json`](https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/evidence.json) · [`docs/live-verification.md`](docs/live-verification.md) · [`docs/mechanism.md`](docs/mechanism.md)

## How it works

1. A trader registers with a track record published as JSON at a public URL.
2. Anyone can request an audit. Validators independently fetch the record and check five things: the source is valid, the identity matches the registration, the dates are consistent, the claimed numbers recompute exactly, and the record is fresh (≤ 90 days old). There are no score bands — every field must match exactly, so two passing evaluations cannot disagree on the verdict.
3. The verdict sets the copy weight: VERIFIED → 1.0x, SUSPECT → 0.5x, REJECTED → 0x (cannot be followed).
4. While an audit is open, anyone can challenge it. Finalising a challenged audit runs a second evaluation: if it agrees with the first, the challenge fails and the challenger loses 5 reputation; if it differs, the second verdict stands and the challenger gains 5.
5. Following a trader allocates simulated mGEN from the follower's ledger balance. Settlement applies the trader's reported period result in basis points — only for VERIFIED traders — and credits principal plus PnL back to the follower.

All money is simulated mGEN on an in-contract ledger. Claim 10,000 demo mGEN once per address. No real GEN moves, no trade is executed on any exchange.

## Live state

| Trader | Verdict | Weight | Reputation | Followers |
|---|---|---|---|---|
| Ava Chen (AVA-001) | VERIFIED | 100 | 111 | 1 |
| Ben Okafor (BEN-002) | SUSPECT | 50 | 100 | 1 |
| Cara Diaz (CAR-003) | REJECTED | 0 | 90 | 0 |

- Copy `c0` (Ava): 1000 mGEN at 1.0x, settled at +500 bps → PnL +50, settled value 1050.
- Copy `c1` (Ben): 1000 mGEN at 0.5x → effective 500, open.
- Audit `a1` (Ben) was challenged and finalised with an identical second evaluation (SUSPECT = SUSPECT), so the challenge failed and the challenger lost 5 reputation.

## Repo layout

- `contracts/copytrade.py` — the GenLayer contract (SHA-256 `4f545d35039e3a88c59936977c0bf895cac739e43af1e552c4b4058b6152cc0a`, matches the deployed code).
- `frontend/` — the site (people-centred leaderboard, View Transitions for rank changes, bilingual CN/EN, OKX-first wallet with a labelled temporary test-account fallback for writes). Published copy in `docs/`.
- `evidence/` — the three audited track records (Ava fresh + consistent, Ben stale, Cara identity mismatch).
- `scripts/` — deploy, end-to-end flow, i18n parity check (all run against Stable Studionet with ephemeral accounts; no keys stored).
- `tests/` — local logic tests (date math, verdict table, settlement exactness). Local mocks, not on-chain evidence.
- `docs/` — `mechanism.md` (worst-case spread table), `live-verification.md` (every tx + read-back), `KNOWN_LIMITATIONS.md`, `REVIEWER.md`.
- `deployment.json`, `evidence.json` — machine-readable deployment + evidence.

## Run it yourself

```bash
npm install
node scripts/deploy.mjs          # deploys a fresh contract (ephemeral deployer)
CONTRACT_ADDRESS=0x... node scripts/flow.mjs   # runs the full business flow
python3 tests/test_contract_logic.py           # local logic tests
node scripts/check_i18n.mjs                   # i18n parity (zero missing keys)
```

## Key transactions

Deploy: [`0x42d468144904f0aaf1103a968284fd2e557235c06b5c843417f36d16dc9681e9`](https://explorer-studio.genlayer.com/tx/0x42d468144904f0aaf1103a968284fd2e557235c06b5c843417f36d16dc9681e9)

| Step | Tx |
|---|---|
| Audit Ava (VERIFIED) | [`0x2cf241ebb3fdd8af5e12e11023a0e020be8885ff0315916dca9c548494b4c553`](https://explorer-studio.genlayer.com/tx/0x2cf241ebb3fdd8af5e12e11023a0e020be8885ff0315916dca9c548494b4c553) |
| Settle copy c0 (+50 mGEN) | [`0x5161669a458c510bd3d36b2cb79f807a94654dddd79e45f9592363960e907c2b`](https://explorer-studio.genlayer.com/tx/0x5161669a458c510bd3d36b2cb79f807a94654dddd79e45f9592363960e907c2b) |
| Challenge Ben audit | [`0x58830ccd7dd2a401cd3433d60ee3e22dd309ad9bb5dc26e48dc7765e6ade4e7f`](https://explorer-studio.genlayer.com/tx/0x58830ccd7dd2a401cd3433d60ee3e22dd309ad9bb5dc26e48dc7765e6ade4e7f) |
| Finalize Ben (challenge failed) | [`0x9f247a340d58b21a2d9fbba4ed8c5dd6c26038b26042a0cd7cb2e11ed7a19cc9`](https://explorer-studio.genlayer.com/tx/0x9f247a340d58b21a2d9fbba4ed8c5dd6c26038b26042a0cd7cb2e11ed7a19cc9) |
| Audit Cara (REJECTED) | [`0xeaf28aba514aba34183f7d012a95e35a89aa9dc06fe4628eb2148596219a2332`](https://explorer-studio.genlayer.com/tx/0xeaf28aba514aba34183f7d012a95e35a89aa9dc06fe4628eb2148596219a2332) |

All 15 transactions (deploy + 14 business) are FINALIZED; see `docs/live-verification.md` for the full list.
