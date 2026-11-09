# Reviewer fast path

The shortest way to recheck this project end to end.

## 1. Read the mechanism (5 minutes)

`docs/mechanism.md` — the audit's five binary checks, the
deterministic verdict table, the settlement math, and the
worst-case spread table. The headline result: two different
validator-compatible leader outputs cannot differ on any stored
core value (spread 0), because equivalence is exact string/integer
equality on every field (11 audit fields, 11 settlement fields)
and the verdict is a table over the checks, not a score. Prices
are $100 buckets, and the PnL truncation rule (toward zero) is
deterministic and validated exactly.

## 2. Check the deployment (2 minutes)

- `deployment.json` — network (Stable Studionet, Chain 61999),
  contract address, deploy tx, deployer, contract source SHA-256.
- Recompute the hash: `sha256sum contracts/copytrade.py` and
  compare with `deployment.json` → `contractSha256`.
- Read the deployed code back: `gen_getContractCode` on
  `0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63`, base64-decode it,
  hash it — it must equal the repo file byte for byte.
- Open the explorer link in `deployment.json` and confirm the
  contract exists on Stable Studionet (balance 26 GEN, 35
  transactions).

## 3. Recheck the live state (3 minutes)

- `evidence.json` — every core tx hash with FINALIZED status and
  the read-back values recorded at flow time (three phases).
- Re-read the contract now (any GenLayer client or the Studio
  page): `get_counts`, `get_totals`, `get_trader("t0")`,
  `get_trader("t1")`, `get_trader("t4")`, `get_audit("a5")`,
  `get_copy("c0")`, `get_copy("c2")`.
- Expected standing state:
  - `t0` Ava Chen — VERIFIED, weight 100, reputation 10,
    2 followers, 2 settled copies.
  - `t1` Ben Okafor — SUSPECT, weight 50, reputation 0,
    2 followers, 1 settled copy.
  - `t2` Dana Kim — SUSPECT, weight 50, reputation 0, 1 witness.
  - `t3` Cara Diaz — REJECTED, weight 0, reputation 0.
  - `t4` Eli Park — VERIFIED, weight 100, reputation 10;
    audit `a5` closed with round1 SUSPECT, round2 VERIFIED and
    `challenge_outcome` = CHALLENGE_SUCCEEDED.
  - `c0`, `c1`, `c3` — SETTLED flat ($74,000 → $74,000, 0 bps,
    return 5 GEN each). `c2` — CANCELLED, full 5 GEN refund.
  - `get_totals`: received 26 GEN, paid out 5 GEN, credits 17.75
    GEN, house pool 3.25 GEN, `invariant_ok` true,
    `balance_matches_wei` false — the 5 GEN difference is the
    failed payable copy call (see `docs/live-verification.md`).

## 4. Check the site (2 minutes)

Open the live site (link at the top of the README). The
leaderboard loads from the contract without a wallet. Follow the
evidence link to the track-record JSON of any trader and confirm
the numbers recompute: wins × 10000 equals claimed win rate ×
trade count, and the per-trade results sum to the claimed total.
Fund a temporary test account from the faucet link, copy a trader
(5 GEN), settle, and withdraw — the value shown is GEN + wei.

## 5. Run the local logic tests (1 minute)

```
python3 tests/test_contract_logic.py
```

Pure-Python checks of the date math, the verdict table, the
evidence fixtures, the settlement exactness and the house-pool
cap (including a doubling with an empty pool). These are local
mocks, not on-chain evidence — the on-chain evidence is step 3.
Note the three live settles all landed flat (0 bps); the non-zero
PnL branches are covered here, not live.
