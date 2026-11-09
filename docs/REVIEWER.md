# Reviewer fast path

The shortest way to recheck this project end to end.

## 1. Read the mechanism (5 minutes)

`docs/mechanism.md` — the audit's five binary checks, the
deterministic verdict table, and the worst-case spread table. The
headline result: two different validator-compatible leader outputs
cannot differ on any stored core value (spread 0), because
equivalence is exact string/integer equality on every field and
the verdict is a table over the checks, not a score.

## 2. Check the deployment (2 minutes)

- `deployment.json` — network (Stable Studionet, Chain 61999),
  contract address, deploy tx, deployer, contract source SHA-256.
- Recompute the hash: `sha256sum contracts/copytrade.py` and
  compare with `deployment.json` → `contractSha256`.
- Open the explorer link in `deployment.json` and confirm the
  contract exists on Stable Studionet.

## 3. Recheck the live state (3 minutes)

- `evidence.json` — every core tx hash with FINALIZED status and
  the read-back values recorded at flow time.
- Re-read the contract now (any GenLayer client or the Studio
  page): `get_counts`, `get_trader("t0")`, `get_trader("t1")`,
  `get_trader("t2")`, `get_audit("a1")`, `get_copy("c0")`.
- Expected standing state:
  - `t0` Ava Chen — VERIFIED, weight 100, reputation 111,
    1 follower, 1 settled copy.
  - `t1` Ben Okafor — SUSPECT, weight 50, reputation 100,
    1 follower; audit `a1` FINALIZED with round1 = round2 =
    SUSPECT and `challenge_outcome` = CHALLENGE_FAILED.
  - `t2` Cara Diaz — REJECTED, weight 0, reputation 90.
  - `c0` — SETTLED, pnl +50 mGEN on 1000 effective at +500 bps.
  - `c1` — OPEN, effective 500 mGEN (1000 at 0.5x weight).

## 4. Check the site (2 minutes)

Open the live site (link at the top of the README). The
leaderboard loads from the contract without a wallet. Follow the
evidence link to the track-record JSON of any trader and confirm
the numbers recompute: wins × 10000 equals claimed win rate ×
trade count, and the per-trade results sum to the claimed total.

## 5. Run the local logic tests (1 minute)

```
python3 tests/test_contract_logic.py
```

Pure-Python checks of the date math, the verdict table, the
evidence fixtures and the settlement exactness. These are local
mocks, not on-chain evidence — the on-chain evidence is step 3.
