# Live verification

Network: Stable Studionet, Chain 61999, RPC https://studio.genlayer.com/api.
Contract: `0xF9FC6D2244b8032827EBea844Ce56D44233A69d6`
([explorer](https://explorer-studio.genlayer.com/address/0xF9FC6D2244b8032827EBea844Ce56D44233A69d6)).

Every transaction below was waited to FINALIZED with
genlayer-js `waitForTransactionReceipt` (status FINALIZED) in
`scripts/flow.mjs`, and its receipt was re-fetched from the RPC
afterwards (all 15 present, status `0x1`). Every state change was
read back through the contract's own view methods, independently
re-read a second time after the flow finished. The full machine
record is `evidence.json`.

## Deployed code matches the repo

The deploy transaction's embedded `contract_code` was decoded from
the chain and hashed:

- Deployed code SHA-256: `4f545d35039e3a88c59936977c0bf895cac739e43af1e552c4b4058b6152cc0a`
- Repo file SHA-256 (`contracts/copytrade.py` at the deploy commit):
  `4f545d35039e3a88c59936977c0bf895cac739e43af1e552c4b4058b6152cc0a`
- Result: MATCH — the deployed code is the repo code.

## Transactions

Flow accounts (ephemeral, generated for this run only, keys never
stored): A `0x48Bc7D00C7D455279fc55b4DB0Ca87e0fF992F20` (auditor,
follower), B `0x0F18AACa398Ab5120C883b8f12d2e7B848712ad3` (challenger).

| # | step | tx hash | status | read-back |
|---|---|---|---|---|
| 0 | deploy | `0x42d468144904f0aaf1103a968284fd2e557235c06b5c843417f36d16dc9681e9` | FINALIZED | contract `0xF9FC6D2244b8032827EBea844Ce56D44233A69d6` |
| 1 | register Ava Chen (AVA-001) | `0xa78c681633d3b5a3799cc2f55e6f99cdc2b9139ccfcfcb1ba49fb92aa0653dc6` | FINALIZED | trader `t0`, status REGISTERED |
| 2 | audit Ava | `0x2cf241ebb3fdd8af5e12e11023a0e020be8885ff0315916dca9c548494b4c553` | FINALIZED | audit `a0` EVALUATING, round1 VERIFIED, all 5 checks true, wins 7/10, total return 1390 bps |
| 3 | finalize Ava | `0x51047937f6dce3f50ff68baf62a95e3cb0a64bde52b6a91e5d83d096f703eab6` | FINALIZED | trader `t0` VERIFIED, weight 100, reputation 110 |
| 4 | claim demo funds (A) | `0x4587f6bf6a8f181964eaa8157b219f629ba820b9b011ddd82c7089259fd85503` | FINALIZED | account A balance 10000 mGEN |
| 5 | follow Ava, 1000 mGEN | `0xcea0c8273ca92a0bda64f97a856abf42471a6b54f4bfa609293ba87bd605a882` | FINALIZED | copy `c0` OPEN, weight 100, effective 1000; balance 9000 |
| 6 | settle copy `c0`, +500 bps | `0x5161669a458c510bd3d36b2cb79f807a94654dddd79e45f9592363960e907c2b` | FINALIZED | copy `c0` SETTLED, pnl +50, settled value 1050; balance 10050; trader reputation 111 |
| 7 | register Ben Okafor (BEN-002) | `0x21163b48dd328cf04fdfdfc6641e5c33f48eb1bd17cd1b085491c2144c34ae63` | FINALIZED | trader `t1`, status REGISTERED |
| 8 | audit Ben | `0xcc7bf444dac66463323dead72d9221a7e66d29f8e86c2006f11790d9fca0e104` | FINALIZED | audit `a1` EVALUATING, round1 SUSPECT, `check_evidence_fresh` false (record ends 2026-08-10, 91 days old) |
| 9 | challenge audit `a1` (B) | `0x58830ccd7dd2a401cd3433d60ee3e22dd309ad9bb5dc26e48dc7765e6ade4e7f` | FINALIZED | audit `a1` CHALLENGED, challenger B |
| 10 | finalize Ben (challenged) | `0x9f247a340d58b21a2d9fbba4ed8c5dd6c26038b26042a0cd7cb2e11ed7a19cc9` | FINALIZED | audit `a1` FINALIZED, round2 SUSPECT = round1, `challenge_outcome` CHALLENGE_FAILED; trader `t1` SUSPECT, weight 50, reputation 100; account B reputation 95 |
| 11 | follow Ben, 1000 mGEN | `0x5c9af6dc996ab0584d130264a4b192ff68f65ccfec075255c926348a18837df3` | FINALIZED | copy `c1` OPEN, weight 50, effective 500; balance 9050 |
| 12 | register Cara Diaz (CAR-003) | `0x55b0c5fbab26c036c718800b83acbd89a05354c3f9884d33e6675969576d1570` | FINALIZED | trader `t2`, status REGISTERED |
| 13 | audit Cara | `0xeaf28aba514aba34183f7d012a95e35a89aa9dc06fe4628eb2148596219a2332` | FINALIZED | audit `a2` EVALUATING, round1 REJECTED, `check_identity_matches` false (evidence says CAR-999) |
| 14 | finalize Cara | `0xbc66b7d599a44bfa6b5aa36b757f0793bd9e6ab6438716f9f33558909e7ea0df` | FINALIZED | trader `t2` REJECTED, weight 0, reputation 90 |

## Final state (re-read after the flow)

- `get_counts`: traders 3, audits 3, copies 2, witnesses 0.
- `t0` Ava Chen: AUDITED_VERIFIED, weight 100, reputation 111,
  followers 1, total_copied 1000, settled_copies 1.
- `t1` Ben Okafor: AUDITED_SUSPECT, weight 50, reputation 100,
  followers 1, total_copied 500, settled_copies 0.
- `t2` Cara Diaz: AUDITED_REJECTED, weight 0, reputation 90,
  followers 0, total_copied 0, settled_copies 0.
- `c0`: SETTLED, allocation 1000, effective 1000, pnl_bps 500,
  pnl 50, settled_value 1050.
- `c1`: OPEN, allocation 1000, weight 50, effective 500.
- Account A: balance 9050, claimed_demo true, reputation 100.
- Account B: balance 0, claimed_demo false, reputation 95.

## Consensus note

Audit `a1` ran the evaluation twice (round1 at audit time, round2
at finalisation after the challenge). Both rounds returned the
identical result field-for-field — same verdict SUSPECT, same five
checks, same dates, same recomputed numbers (wins 5, trade_count 8,
total_return_bps 860). Two independent consensus evaluations of
the same evidence agreed exactly, which is the zero-spread claim
in `docs/mechanism.md` demonstrated live, not just calculated.
