# Live verification

Network: Stable Studionet, Chain 61999, RPC https://studio.genlayer.com/api.
Contract: `0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63`
([explorer](https://explorer-studio.genlayer.com/address/0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63)).

Every transaction below was waited to FINALIZED with
genlayer-js `waitForTransactionReceipt` (status FINALIZED) in
`scripts/flow.mjs` (phase 1), `scripts/flow-resume.mjs` (phase 2)
and `scripts/flow-withdraw-proof.mjs` (phase 3), and every state
change was read back through the contract's own view methods. The
full machine record is `evidence.json`.

## Deployed code matches the repo

The deployed code was read back with `gen_getContractCode`
(base64), decoded, and hashed:

- Deployed code SHA-256: `baed62ab9581f384625e6d574cd7717b85ab0f026851dc9de8be11a37b3224e9`
- Repo file SHA-256 (`contracts/copytrade.py` at HEAD):
  `baed62ab9581f384625e6d574cd7717b85ab0f026851dc9de8be11a37b3224e9`
- Result: MATCH, byte-identical — the deployed code is the repo code.

## Transactions

Flow accounts (ephemeral, generated for each run, keys never
stored): phase 1 — A `0x1Ca0137b9e33Aa9435eB057ef62053eB7D7f8364`
(auditor, follower), B `0x550eA0f1b60a9449e4F0A15De90542F43b8DC084`
(challenger), C `0xFD0f6D913AEefa3FdBb12Ca611523f3bA5256E63`;
phase 2 — D `0xc94d13716d0609566519cB78cf4298f0C3849218`,
E `0x36a3F278df24c725d2623232D5C0d35D5254F754`,
F `0xFBD3419E63b351AB2D5Fe0d180942f5c76ff7e73`;
phase 3 — G `0x28d4b665dBF3DB5a8533838f4F3A10769aD5F86b`.
Each account was funded with 10,000 GEN from the faucet interface.

### Phase 1

| # | step | tx hash | status | read-back |
|---|---|---|---|---|
| 0 | deploy | `0x292fbfc9ca9941bd1dbc4b2e4d27c6a4234bfb83c3b2bbe7a5cd8b17bd2c2129` | FINALIZED | contract `0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63` |
| 1 | register Ava Chen (AVA-001) | `0x87075048e4e03a8400c0cd7bcbf3bd199c86f8c27c0f6cc8b954084236833f69` | FINALIZED | trader `t0`, status REGISTERED |
| 2 | audit Ava | `0x6bf32256f2b7b5b59c5b1068f13cb29a0d87274d259c8eaaa3ebc35e9d2506c2` | FINALIZED | audit `a0` PENDING, round1 VERIFIED, all 5 checks true, wins 7/10, total return 1390 bps, 11 result fields |
| 3 | close Ava audit | `0x0d622ce07cf351281bc1db859f5acc8aba2d31c1a8da044ffe0ceed5fa0084ed` | FINALIZED | trader `t0` VERIFIED, weight 100, reputation 10 |
| 4 | register Ben Okafor (BEN-002) | `0x2b282aaf056fa3ad8afc9649acf5f01fbbcbd8a657a828514fb0f8231c14e52f` | FINALIZED | trader `t1`, status REGISTERED |
| 5 | audit Ben | `0xf9ac6af3cbcdd875863a4c843a06d7836b0ce1ad82d84132488e53fd2b3cdd9a` | FINALIZED | audit `a1` PENDING, round1 SUSPECT, `check_evidence_fresh` false (record ends 2026-08-10, 91 days old) |
| 6 | challenge audit `a1` (B, 2 GEN) | `0x00b3eceda5cb904eef4b6cdaadb6d214b2b18c35a44923dc1abd9fcdafc7c6b7` | FINALIZED | audit `a1` CHALLENGED, challenge stake 2000000000000000000 wei, locked challenges 2 GEN |
| 7 | close Ben audit (challenged) | `0xedceae93cf05b54b6dc58ef25eef39d6357f5c59b6f2f9d422220030299e95ea` | FINALIZED | audit `a1` CLOSED, round2 SUSPECT = round1, `challenge_outcome` CHALLENGE_FAILED; trader `t1` SUSPECT, weight 50, reputation 0; house pool 2 GEN |
| 8 | register Dana Kim (DAN-004) | `0x5046dbf5b7ea12b7966d2c8a1aaa60a82e04fd275851ac03429cd5227b376202` | FINALIZED | trader `t2`, status REGISTERED |
| 9 | audit Dana | `0xca3ded4e17a609386d4bcc3eaadf6f8b0da57b8167a555409b60c5aa6a99c759` | FINALIZED | audit `a2` PENDING, round1 SUSPECT, `check_numbers_consistent` false (claimed total 999, trades sum to 300) |
| 10 | challenge audit `a2` (B, 2 GEN) | `0x7de7be84cd2ec52b1d2b89a08b174ff2ffd8d9475276f9633f1090b223b58fea` | FINALIZED | audit `a2` CHALLENGED |
| 11 | close Dana audit (challenged, evidence corrected 999 → 300) | `0x02aa99ddb2cb6568ef9368001f01ed7386d58344b05d84e15959858a6fb0b8bc` | FINALIZED | audit `a2` CLOSED, round2 SUSPECT, `check_numbers_consistent` false — every validator still fetched the stale 999 (evidence CDN cache), so the challenge failed and 2 GEN went to the pool. House pool 4 GEN. Phase 1 stopped here. |

### Phase 2

| # | step | tx hash | status | read-back |
|---|---|---|---|---|
| 12 | re-audit Dana | `0x0f67693b8860ed831a0f2232eca4e4f387a38a71d110ce4d02893d1c044ff7ce` | FINALIZED | audit `a3` PENDING, round1 VERIFIED (corrected file now past the cache window) |
| 13 | close Dana re-audit | `0xe49bfe6fbb60234a1b4d6d7d09cecfc8ecc37d6e5e20d4047b08fc1ee0344a52` | FINALIZED | trader `t2` stays SUSPECT, `witness_count` 1; witness `w0` standing SUSPECT vs new VERIFIED |
| 14 | register Cara Diaz (CAR-003) | `0x6243af4e61e5cd24638c38726b1b779b10cc4718d659b9d212cff86409326e3b` | FINALIZED | trader `t3`, status REGISTERED |
| 15 | audit Cara | `0x7aeca5b82a2dd1ec4dd72f1b0d1d0ab5987794abb99e54bb4d2afb66fd5099a0` | FINALIZED | audit `a4` PENDING, round1 REJECTED, `check_identity_matches` false (evidence says CAR-999) |
| 16 | close Cara audit | `0x894d052f48f7f56606b6a9e5cce723528a9893b3735ab8c7d596a035556d8f43` | FINALIZED | trader `t3` REJECTED, weight 0, reputation 0 (0 − 10 clamped to 0) |
| 17 | register Eli Park (ELI-005) | `0x5d74f0f92399d0c9e70a132d83ba10f7251f848fb94b01b4d20c363b5523939b` | FINALIZED | trader `t4`, status REGISTERED |
| 18 | audit Eli | `0x52a8280e64ed9a7901dc722f0b87dedd301bde8433572119ec19b6cdc80d91eb` | FINALIZED | audit `a5` PENDING, round1 SUSPECT, `check_numbers_consistent` false (claimed total 999, trades sum to 500) |
| 19 | challenge audit `a5` (E, 2 GEN) | `0xcd2c38f0aa8897279f65cd87e66b5a9a068a020769e2f04837a4aa09e917a689` | FINALIZED | audit `a5` CHALLENGED, locked challenges 2 GEN, total received 6 GEN |
| 20 | probe audit Eli (after 11-minute cache wait) | `0xd18af864ed9d87cb611c90e7667da811817978a31c2b0d13754100d30f3f0104` | FINALIZED | audit `a6` PENDING, round1 VERIFIED — validators now see the corrected file |
| 21 | close Eli audit (challenged, evidence corrected 999 → 500) | `0x7fd0d5ce783297dffc1e714d106f3341d4ab982fdbedebd0f22d9a3cadff012e` | FINALIZED | audit `a5` CLOSED, round2 VERIFIED, `challenge_outcome` CHALLENGE_SUCCEEDED; trader `t4` VERIFIED, weight 100, reputation 10; challenger E credited 2750000000000000000 wei (2 GEN refund + 0.75 GEN reward); house pool 3.25 GEN |
| 22 | close Eli probe audit | `0x73ba868dee3ed3464046ec2156df783293599cbec4e8bd79c39f69d5b7139a90` | FINALIZED | trader `t4` still VERIFIED, witnesses still 1 |
| 23 | copy Ava, 5 GEN (D) | `0x0712c9c2b869a0f19d041639e9658edc66dbc798b24f037e95ae260bd233c0d2` | FINALIZED | copy `c0` OPEN, weight 100, effective 5000000000000000000 wei, entry BTC bucket $74,000 |
| 24 | copy Ben, 5 GEN (D) | `0x2c0ae3f816d17d9c998181a87818b0fa0774ea7142fc9c42c6c7814100a09924` | FINALIZED | copy `c1` OPEN, weight 50, effective 2500000000000000000 wei, entry BTC bucket $74,000 |
| 25 | copy Ben, 5 GEN (F) | `0xfc27c992a852572a3d3bd519d2c97e2ebbddd80180cabf7a7ea082b0d629e4aa` | FINALIZED | copy `c2` OPEN, weight 50, effective 2500000000000000000 wei |
| 26 | copy REJECTED trader `t3` (negative case) | `0xea00f2d2007ff50c00b0cfea004a1e909ec8a0777561cd98a01f49f89aaaf0e6` | FINALIZED (GenVM ERROR) | no copy created, copies count still 3, total received unchanged — but see the leak note below |
| 27 | cancel copy `c2` (F) | `0x7c467e5a2774f8f539ebc1fabc4c8931dc0d659c638a9660914cd783c8e09456` | FINALIZED | copy `c2` CANCELLED, return 5000000000000000000 wei; F credited 5 GEN; locked copies 10 GEN |
| 28 | settle cancelled copy `c2` (negative case) | `0x7f252e73d8e4b88fc092d008e70f0248e70b4a95b4dfb2b124ea4ed5e642ab31` | FINALIZED (GenVM ERROR) | copy `c2` still CANCELLED |
| 29 | settle copy `c0` (Ava) | `0x81f0f60d2f58d602061c20081c855dfb00b286d50882d029d1599c010623dc55` | FINALIZED | copy `c0` SETTLED, entry $74,000 → exit $74,000, pnl_bps 0, pnl 0, return 5000000000000000000 wei; pnl recomputed off-chain and matched |
| 30 | settle copy `c1` (Ben), attempt 1 | `0xa1dde09f0839c1b2341d10cc8c1a57b1ba5527298baa202c318ce90ffb08c11b` | FINALIZED (GenVM ERROR) | no state changed — BTC crossed the $100 bucket line mid-consensus; retried |
| 31 | settle copy `c1` (Ben), retry | `0xb700a8c70484038e7acfb2c9aa75ca4af886f09947b12ddf15880b647f57bd2b` | FINALIZED | copy `c1` SETTLED, entry $74,000 → exit $74,000, pnl_bps 0, pnl 0, return 5000000000000000000 wei; pnl recomputed off-chain and matched |

Phase 2 stopped after step 31: its runner was killed when the
VM wiped `/tmp` mid-run, before the three withdraws. The phase-2
accounts' keys died with it, so their credits (D 10 GEN,
E 2.75 GEN, F 5 GEN) remain outstanding and were never withdrawn.

### Phase 3

| # | step | tx hash | status | read-back |
|---|---|---|---|---|
| 32 | copy Ava, 5 GEN (G) | `0x145313d3f73cfb5ae7fe70ddba379baba61cec1f84abafbc92db08c866d14f1e` | FINALIZED | copy `c3` OPEN, weight 100, effective 5000000000000000000 wei, entry BTC bucket $74,000 |
| 33 | settle copy `c3` (Ava, G) | `0xaba0b6eb0d647fdaf612243b492730e4e3c82c1955ccaf23e63943fe97b0d7e5` | FINALIZED | copy `c3` SETTLED, entry $74,000 → exit $74,000, pnl_bps 0, return 5000000000000000000 wei |
| 34 | withdraw payout (G) | `0x6c4138c695df99282f9c70e51d7c5981990c1bc54c24d100ef09b42ccc8c5f73` | FINALIZED | G credit 0 after withdraw; G EOA 9995 GEN before → 10000 GEN after (+8s), exactly `before + credit` |

## Final state (re-read after all three phases)

- `get_counts`: traders 5, audits 7, copies 4, witnesses 1.
- `t0` Ava Chen: AUDITED_VERIFIED, weight 100, reputation 10,
  followers 2, open 0, settled 2, total_copied_wei 10000000000000000000.
- `t1` Ben Okafor: AUDITED_SUSPECT, weight 50, reputation 0,
  followers 2, open 0, settled 1, total_copied_wei 5000000000000000000.
- `t2` Dana Kim: AUDITED_SUSPECT, weight 50, reputation 0,
  followers 0, witness_count 1.
- `t3` Cara Diaz: AUDITED_REJECTED, weight 0, reputation 0.
- `t4` Eli Park: AUDITED_VERIFIED, weight 100, reputation 10.
- `c0`: SETTLED, stake 5 GEN, effective 5 GEN, pnl 0 bps, return 5 GEN.
- `c1`: SETTLED, stake 5 GEN, effective 2.5 GEN, pnl 0 bps, return 5 GEN.
- `c2`: CANCELLED, stake 5 GEN, return 5 GEN.
- `c3`: SETTLED, stake 5 GEN, effective 5 GEN, pnl 0 bps, return 5 GEN, withdrawn.
- `w0`: standing SUSPECT vs new VERIFIED (Dana re-audit).
- `get_totals`: total_received 26 GEN, total_paid_out 5 GEN,
  locked_copies 0, locked_challenges 0, credits_total 17.75 GEN,
  house_pool 3.25 GEN, accounted 26 GEN, `invariant_ok` true,
  contract balance 26 GEN, `balance_matches_wei` false.

## GEN reconciliation

| Account | Funded | Paid in | Credited | Withdrew | EOA now |
|---|---|---|---|---|---|
| A (phase 1) | 10,000 GEN | 0 | 0 | 0 | not re-read (keys lost) |
| B (phase 1) | 10,000 GEN | 4 GEN (2 failed challenges) | 0 | 0 | 9,996 GEN |
| C (phase 1) | 10,000 GEN | 0 | 0 | 0 | not re-read (keys lost) |
| D (phase 2) | 10,000 GEN | 10 GEN (2 copies) + 5 GEN leaked | 10 GEN | 0 (keys lost) | 9,985 GEN |
| E (phase 2) | 10,000 GEN | 2 GEN (1 challenge) | 2.75 GEN | 0 (keys lost) | 9,998 GEN |
| F (phase 2) | 10,000 GEN | 5 GEN (1 copy) | 5 GEN | 0 (keys lost) | 9,995 GEN |
| G (phase 3) | 10,000 GEN | 5 GEN (1 copy) | 5 GEN | 5 GEN | 10,000 GEN |

Counter invariant: 26 GEN received == 5 GEN paid out + 0 locked
+ 0 locked challenges + 17.75 GEN credits + 3.25 GEN house pool.

## The 5 GEN leak (failed payable call)

Step 26 (the rejected copy attempt) finalised with a GenVM
ERROR and wrote nothing — no copy, no counter change — but its
attached 5 GEN still moved into the contract balance. Proof:
D's EOA is 9,985 GEN (10,000 − 10 GEN in successful copies − 5 GEN
from the failed call), and the contract balance is 26 GEN while
`total_received − total_paid_out` is 21 GEN. The 5 GEN sits in the
balance with no credit and no counter entry, and
`get_totals.balance_matches_wei` is false. The counter invariant
above still holds exactly. This is recorded in
`docs/KNOWN_LIMITATIONS.md` and in `docs/mechanism.md`, not hidden.

## Consensus notes

- Audit `a1` ran the evaluation twice (round1 at audit time,
  round2 at finalisation after the challenge). Both rounds returned
  the identical result field-for-field — same verdict SUSPECT, same
  five checks, same dates, same recomputed numbers (wins 5,
  trade_count 8, total_return_bps 860). Two independent consensus
  evaluations of the same evidence agreed exactly.
- Audit `a2` shows the opposite failure mode honestly: the evidence
  file was corrected between challenge and close, but the
  validators' fetches still returned the stale file, so round2
  agreed with round1 and the challenge failed. The re-audit `a3`
  later read the corrected file as VERIFIED. Evidence URLs are
  subject to CDN caching; a corrected record needs time (here an
  11-minute wait plus a probe audit) before a challenged close can
  see it.
- Settlement `c1` attempt 1 failed the same way a price bucket can:
  BTC crossed the $100 line mid-consensus, the buckets disagreed,
  validation failed and nothing was stored. The retry settled flat.
  All three settled copies happened to settle flat ($74,000 →
  $74,000, 0 bps) because BTC stayed inside the $74,000 bucket
  between copy and settle; the non-zero PnL branches (winner paid
  from the pool, loser retained to the pool, upside capped) are
  covered by the local logic tests, not by a live non-zero settle.

## Old contract (abandoned)

`0xF9FC6D2244b8032827EBea844Ce56D44233A69d6` used an in-contract ledger with no real GEN. It is abandoned and replaced by
`0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63`.
