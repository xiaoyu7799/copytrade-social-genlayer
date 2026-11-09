# CopyTrade — Follow people, not tickers

People, not tickers: a social copy-trading board where every trader publishes a track record, GenLayer validators audit it, and only an audited trader can be copied — with a copy weight set by the verdict. Copying stakes real testnet GEN (5 GEN per copy); settlement fetches the live BTC price on-chain and pays principal plus PnL back in GEN.

**Live site:** https://xiaoyu7799.github.io/copytrade-social-genlayer/

**Contract:** [`0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63`](https://explorer-studio.genlayer.com/address/0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63) on Stable Studionet (Chain 61999)

**Evidence:** [`evidence.json`](https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/evidence.json) · [`docs/live-verification.md`](docs/live-verification.md) · [`docs/mechanism.md`](docs/mechanism.md)

## How it works

1. A trader registers with a track record published as JSON at a public URL.
2. Anyone can request an audit. Validators independently fetch the record and check five things: the source is valid, the identity matches the registration, the dates are consistent, the claimed numbers recompute exactly, and the record is fresh (≤ 90 days old). There are no score bands — every field must match exactly, so two passing evaluations cannot disagree on the verdict. The audit result has exactly 11 fields, all validated exactly.
3. The verdict sets the copy weight: VERIFIED → 1.0x, SUSPECT → 0.5x, REJECTED → 0x (cannot be copied). Trader reputation starts at 0: audit +10 for VERIFIED, −10 for REJECTED (floored at 0).
4. While an audit is open, anyone except the requester can challenge it with exactly 2 GEN (2000000000000000000 wei). Closing a challenged audit runs a second evaluation: if it agrees with the first, the challenge fails and the 2 GEN is forfeited into the house pool; if it differs, the challenger is refunded 2 GEN plus a 0.75 GEN reward from the pool.
5. Copying stakes exactly 5 GEN (5000000000000000000 wei) and records the live BTC price (bucketed to whole $100) as the entry price. Settlement fetches the live BTC price again and pays `stake + PnL` on the weighted exposure back as a withdrawable GEN credit: `pnl_bps = trunc((exit − entry) × 10000 / entry)`, exact integer division, no rounding. Upside above the stake is paid from the house pool and capped by it.
6. Any OPEN copy can be cancelled before settlement for a full 5 GEN refund as credit — SUSPECT copies always have an exit. Credits are pulled with `withdraw_payout` (credit zeroed before the transfer).

All money is real testnet GEN on Stable Studionet, free from the faucet, zero cash cost. No trade is executed on any exchange.

## Live state

| Trader | Verdict | Weight | Reputation | Followers |
|---|---|---|---|---|
| Ava Chen (AVA-001) | VERIFIED | 100 | 10 | 2 |
| Ben Okafor (BEN-002) | SUSPECT | 50 | 0 | 2 |
| Dana Kim (DAN-004) | SUSPECT | 50 | 0 | 0 |
| Cara Diaz (CAR-003) | REJECTED | 0 | 0 | 0 |
| Eli Park (ELI-005) | VERIFIED | 100 | 10 | 0 |

- Copy `c0` (Ava): 5 GEN at 1.0x, entry $74,000 → exit $74,000, pnl 0 bps, return 5 GEN, SETTLED.
- Copy `c1` (Ben): 5 GEN at 0.5x (effective 2.5 GEN), entry $74,000 → exit $74,000, pnl 0 bps, return 5 GEN, SETTLED.
- Copy `c2` (Ben): 5 GEN at 0.5x, CANCELLED, full 5 GEN refund as credit.
- Copy `c3` (Ava): 5 GEN at 1.0x, entry $74,000 → exit $74,000, pnl 0 bps, return 5 GEN, SETTLED and withdrawn (account back to exactly 10,000 GEN).
- Audit `a1` (Ben) was challenged and closed with an identical second evaluation (SUSPECT = SUSPECT), so the challenge failed and 2 GEN went to the house pool.
- Audit `a2` (Dana) was challenged after the evidence was corrected, but every validator still fetched the stale record (evidence CDN cache), so round2 agreed SUSPECT and the challenge failed. A later re-audit (`a3`) read VERIFIED and recorded witness `w0` (standing SUSPECT vs new VERIFIED); the trader keeps SUSPECT.
- Audit `a5` (Eli) was challenged after the evidence was corrected; after an 11-minute cache wait and a probe audit reading VERIFIED, it closed VERIFIED, so the challenge succeeded and the challenger was refunded 2 GEN + 0.75 GEN from the pool.
- Money: 26 GEN received in total (6 GEN challenge stakes + 20 GEN copy stakes); 5 GEN paid out (one withdrawal); 17.75 GEN in outstanding credits; house pool 3.25 GEN; contract balance 26 GEN. The balance is 5 GEN above `received − paid`: the failed payable copy attempt against the REJECTED trader moved its 5 GEN into the balance with no credit — see `docs/live-verification.md` and `docs/KNOWN_LIMITATIONS.md`.

## Repo layout

- `contracts/copytrade.py` — the GenLayer contract (SHA-256 `baed62ab9581f384625e6d574cd7717b85ab0f026851dc9de8be11a37b3224e9`, matches the deployed code byte for byte).
- `frontend/` — the site (people-centred leaderboard, View Transitions for rank changes, bilingual CN/EN, OKX-first wallet with a labelled temporary test-account fallback for writes; the test account is funded from the Studionet faucet first). Published copy in `docs/`.
- `evidence/` — the five audited track records (Ava fresh + consistent, Ben stale, Dana corrected, Cara identity mismatch, Eli corrected).
- `scripts/` — deploy, end-to-end flow (`flow.mjs`, phase 1), resume flow (`flow-resume.mjs`, phase 2), withdraw proof (`flow-withdraw-proof.mjs`, phase 3), i18n parity check (all run against Stable Studionet with ephemeral accounts; no keys stored).
- `tests/` — local logic tests (date math, verdict table, settlement exactness, house-pool cap). Local mocks, not on-chain evidence.
- `docs/` — `mechanism.md` (worst-case spread table), `live-verification.md` (every tx + read-back), `KNOWN_LIMITATIONS.md`, `REVIEWER.md`.
- `deployment.json`, `evidence.json` — machine-readable deployment + evidence.

## Run it yourself

```bash
npm install
node scripts/deploy.mjs                       # deploys a fresh contract (ephemeral deployer)
CONTRACT_ADDRESS=0x... node scripts/flow-resume.mjs   # runs the full business flow (phase 2)
python3 tests/test_contract_logic.py           # local logic tests
node scripts/check_i18n.mjs                   # i18n parity (zero missing keys)
```

## Key transactions

Deploy: [`0x292fbfc9ca9941bd1dbc4b2e4d27c6a4234bfb83c3b2bbe7a5cd8b17bd2c2129`](https://explorer-studio.genlayer.com/tx/0x292fbfc9ca9941bd1dbc4b2e4d27c6a4234bfb83c3b2bbe7a5cd8b17bd2c2129)

| Step | Tx |
|---|---|
| Audit Ava (VERIFIED) | [`0x6bf32256f2b7b5b59c5b1068f13cb29a0d87274d259c8eaaa3ebc35e9d2506c2`](https://explorer-studio.genlayer.com/tx/0x6bf32256f2b7b5b59c5b1068f13cb29a0d87274d259c8eaaa3ebc35e9d2506c2) |
| Challenge Eli audit (2 GEN) | [`0xcd2c38f0aa8897279f65cd87e66b5a9a068a020769e2f04837a4aa09e917a689`](https://explorer-studio.genlayer.com/tx/0xcd2c38f0aa8897279f65cd87e66b5a9a068a020769e2f04837a4aa09e917a689) |
| Close Eli (CHALLENGE_SUCCEEDED) | [`0x7fd0d5ce783297dffc1e714d106f3341d4ab982fdbedebd0f22d9a3cadff012e`](https://explorer-studio.genlayer.com/tx/0x7fd0d5ce783297dffc1e714d106f3341d4ab982fdbedebd0f22d9a3cadff012e) |
| Copy Ava, 5 GEN | [`0x0712c9c2b869a0f19d041639e9658edc66dbc798b24f037e95ae260bd233c0d2`](https://explorer-studio.genlayer.com/tx/0x0712c9c2b869a0f19d041639e9658edc66dbc798b24f037e95ae260bd233c0d2) |
| Withdraw payout (G) | [`0x6c4138c695df99282f9c70e51d7c5981990c1bc54c24d100ef09b42ccc8c5f73`](https://explorer-studio.genlayer.com/tx/0x6c4138c695df99282f9c70e51d7c5981990c1bc54c24d100ef09b42ccc8c5f73) |
| Copy REJECTED trader (rejected on-chain) | [`0xea00f2d2007ff50c00b0cfea004a1e909ec8a0777561cd98a01f49f89aaaf0e6`](https://explorer-studio.genlayer.com/tx/0xea00f2d2007ff50c00b0cfea004a1e909ec8a0777561cd98a01f49f89aaaf0e6) |

All 35 transactions (deploy + 34 business) are FINALIZED; see `docs/live-verification.md` for the full list. The old contract [`0xF9FC6D2244b8032827EBea844Ce56D44233A69d6`](https://explorer-studio.genlayer.com/address/0xF9FC6D2244b8032827EBea844Ce56D44233A69d6) is abandoned: it kept balances on an in-contract ledger with no real GEN.
