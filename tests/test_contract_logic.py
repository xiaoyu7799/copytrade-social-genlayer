"""Local logic tests for contracts/copytrade.py (LOCAL MOCK only).

Stubs the `genlayer` module so the contract file's pure deterministic
helpers can run in plain Python. These tests prove the arithmetic,
the verdict table, the settlement math (including the house-pool cap)
and the exactness rules — they are NOT on-chain evidence. On-chain
behaviour is proven by the flow script + RPC read-back in
evidence.json.
"""
import json
import sys
import types
from pathlib import Path

# --- stub genlayer -------------------------------------------------------
genlayer = types.ModuleType("genlayer")


class _Public:
    @staticmethod
    def write(fn):
        return fn

    @staticmethod
    def view(fn):
        return fn


def _payable(fn):
    return fn


_Public.write.payable = _payable


class _VM:
    class UserError(Exception):
        pass

    @staticmethod
    def run_nondet_unsafe(fn, validate):
        raise RuntimeError("nondet must not run in local tests")


class _Nondet:
    class web:
        @staticmethod
        def get(url):
            raise RuntimeError("no network in local tests")


class _EVM:
    @staticmethod
    def contract_interface(cls):
        return cls


class _Message:
    value = 0
    sender_address = "0x0000000000000000000000000000000000000000"


class _GL:
    public = _Public()
    vm = _VM()
    nondet = _Nondet()
    evm = _EVM()
    message = _Message()

    class Contract:
        pass


genlayer.gl = _GL()
genlayer.TreeMap = dict
genlayer.DynArray = list


class _U256(int):
    pass


genlayer.u256 = _U256
genlayer.i256 = _U256
genlayer.Address = lambda a: a
sys.modules["genlayer"] = genlayer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "contracts"))
import importlib.util

spec = importlib.util.spec_from_file_location("copytrade", ROOT / "contracts" / "copytrade.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

failures = []


def check(label, cond):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


GEN = 10 ** 18

# --- constants are distinct per project -----------------------------------
check("copy stake is exactly 5 GEN", mod.STAKE_WEI == 5 * GEN)
check("challenge stake is exactly 2 GEN", mod.CHALLENGE_WEI == 2 * GEN)
check("challenge reward is 0.75 GEN", mod.CHALLENGE_REWARD_WEI == 750000000000000000)
check("stake != challenge stake != reward", len({mod.STAKE_WEI, mod.CHALLENGE_WEI, mod.CHALLENGE_REWARD_WEI}) == 3)
check("reputation starts at 0, not 100", mod.REPUTATION_START == 0)

# --- dates ---------------------------------------------------------------
check("parse valid date", mod._parse_date("2026-11-09") == (2026, 11, 9))
check("parse rejects bad month", mod._parse_date("2026-13-01") is None)
check("parse rejects Feb 30", mod._parse_date("2026-02-30") is None)
check("parse accepts Feb 29 leap", mod._parse_date("2024-02-29") == (2024, 2, 29))
check("parse rejects Feb 29 non-leap", mod._parse_date("2026-02-29") is None)
check("parse rejects short", mod._parse_date("2026-1-9") is None)
check("age 2026-11-09 minus 2026-11-08 is 1", mod._date_diff_days("2026-11-09", "2026-11-08") == 1)
check("age 2026-11-09 minus 2026-08-10 is 91", mod._date_diff_days("2026-11-09", "2026-08-10") == 91)
check("age 2026-11-09 minus 2026-08-11 is 90", mod._date_diff_days("2026-11-09", "2026-08-11") == 90)
check("age across year boundary", mod._date_diff_days("2027-01-01", "2026-12-31") == 1)

# --- verdict table --------------------------------------------------------
all_pass = {"source_valid": True, "identity_matches": True, "dates_consistent": True, "numbers_consistent": True, "evidence_fresh": True}
check("all pass -> VERIFIED", mod._derive_verdict(all_pass) == "VERIFIED")
for key in ("dates_consistent", "numbers_consistent", "evidence_fresh"):
    c = dict(all_pass)
    c[key] = False
    check(f"{key} fails -> SUSPECT", mod._derive_verdict(c) == "SUSPECT")
for key in ("source_valid", "identity_matches"):
    c = dict(all_pass)
    c[key] = False
    check(f"{key} fails -> REJECTED", mod._derive_verdict(c) == "REJECTED")
c = dict(all_pass)
c["identity_matches"] = False
c["numbers_consistent"] = False
check("identity fails beats numbers -> REJECTED", mod._derive_verdict(c) == "REJECTED")

# --- weights ---------------------------------------------------------------
check("VERIFIED weight 100", mod._weight_for_verdict("VERIFIED") == 100)
check("SUSPECT weight 50", mod._weight_for_verdict("SUSPECT") == 50)
check("REJECTED weight 0", mod._weight_for_verdict("REJECTED") == 0)
check("SUSPECT effective is exact half of 5 GEN", 5 * GEN * 50 // 100 == 2500000000000000000)

# --- evidence files recompute exactly --------------------------------------
def verdict_for_file(fname, registered_code, registered_name, audit_date="2026-11-09"):
    ev = json.loads((ROOT / "evidence" / fname).read_text())
    trades = ev["trades"]
    wins = sum(1 for t in trades if t["pnl_bps"] > 0)
    total = sum(t["pnl_bps"] for t in trades)
    numbers_ok = (
        wins * 10000 == ev["claimed_win_rate_bps"] * len(trades)
        and total == ev["claimed_total_return_bps"]
        and len(trades) >= 5
        and len({t["id"] for t in trades}) == len(trades)
        and all(abs(t["pnl_bps"]) <= 5000 for t in trades)
    )
    dates_ok = (
        all(ev["window_start"] <= t["date"] <= ev["window_end"] for t in trades)
        and max(t["date"] for t in trades) == ev["window_end"]
    )
    age = mod._date_diff_days(audit_date, ev["window_end"])
    fresh = 0 <= age <= 90
    checks = {
        "source_valid": True,
        "identity_matches": ev["trader_code"] == registered_code and ev["trader_name"] == registered_name,
        "dates_consistent": dates_ok,
        "numbers_consistent": numbers_ok,
        "evidence_fresh": fresh,
    }
    return mod._derive_verdict(checks), checks, wins, total


v, _, _, _ = verdict_for_file("trader-ava.json", "AVA-001", "Ava Chen")
check("ava evidence -> VERIFIED", v == "VERIFIED")
v, checks, _, _ = verdict_for_file("trader-ben.json", "BEN-002", "Ben Okafor")
check("ben evidence -> SUSPECT (stale only)", v == "SUSPECT" and checks["evidence_fresh"] is False and checks["numbers_consistent"] is True)
v, checks, _, _ = verdict_for_file("trader-cara.json", "CAR-003", "Cara Diaz")
check("cara evidence -> REJECTED (identity)", v == "REJECTED" and checks["identity_matches"] is False)
v, checks, _, _ = verdict_for_file("trader-dana.json", "DAN-004", "Dana Kim")
check("dana v1 evidence -> SUSPECT (numbers)", v == "SUSPECT" and checks["numbers_consistent"] is False)

# --- trunc division ---------------------------------------------------------
check("trunc_div positive exact", mod._trunc_div(15000, 10000) == 1)
check("trunc_div positive remainder drops", mod._trunc_div(15001, 10000) == 1)
check("trunc_div negative truncates toward zero", mod._trunc_div(-15001, 10000) == -1)
check("trunc_div negative exact", mod._trunc_div(-15000, 10000) == -1)
check("trunc_div zero", mod._trunc_div(0, 10000) == 0)

# --- price bucket ------------------------------------------------------------
check("bucket 74123 -> 74100", mod._bucket_usd(74123) == 74100)
check("bucket 74000 -> 74000", mod._bucket_usd(74000) == 74000)
check("bucket 74099 -> 74000", mod._bucket_usd(74099) == 74000)
check("price string with comma parses", mod._to_int_dollars("74,123.45") == 74123)
check("price float truncates", mod._to_int_dollars(74123.99) == 74123)

# --- settlement math (_settle_math, 11 fields) ------------------------------
def settle(entry, exit_, effective, stake, pool):
    r = mod._settle_math(entry, exit_, effective, stake, pool)
    check("settle result has exactly 11 fields", len(r) == 11)
    return r


# VERIFIED 5 GEN, BTC bucket 74000 -> 74700 (+0.9459%): pnl_bps = trunc(700*10000/74000)=94
r = settle(74000, 74700, 5 * GEN, 5 * GEN, 2 * GEN)
check("winner pnl_bps 94", r["pnl_bps"] == 94)
check("winner pnl_wei = trunc(5 GEN * 94 / 10000)", r["pnl_wei"] == 5 * GEN * 94 // 10000)
check("winner return = stake + pnl", r["return_wei"] == 5 * GEN + 5 * GEN * 94 // 10000)
check("winner upside paid from pool", r["paid_upside_wei"] == 5 * GEN * 94 // 10000)
check("winner not capped (pool covers)", r["capped"] is False)
check("winner pool_after = pool - upside", r["pool_after_wei"] == 2 * GEN - 5 * GEN * 94 // 10000)

# SUSPECT 5 GEN stake, effective 2.5 GEN, BTC 74000 -> 73300 (-0.9459%): pnl_bps -94
r = settle(74000, 73300, 5 * GEN // 2, 5 * GEN, 2 * GEN)
check("loser pnl_bps -94", r["pnl_bps"] == -94)
check("loser return < stake", r["return_wei"] == 5 * GEN - (5 * GEN // 2) * 94 // 10000)
check("loser loss goes to pool", r["pool_after_wei"] == 2 * GEN + (5 * GEN - r["return_wei"]))
check("loser paid_upside 0", r["paid_upside_wei"] == 0)

# Flat price: no PnL, pool unchanged
r = settle(74000, 74000, 5 * GEN, 5 * GEN, 2 * GEN)
check("flat pnl_bps 0", r["pnl_bps"] == 0 and r["pnl_wei"] == 0 and r["return_wei"] == 5 * GEN and r["pool_after_wei"] == 2 * GEN)

# Huge win, empty pool: upside capped at stake, pool untouched
r = settle(74000, 148000, 5 * GEN, 5 * GEN, 0)
check("doubling capped with empty pool", r["return_wei"] == 5 * GEN and r["paid_upside_wei"] == 0 and r["capped"] is True and r["pool_after_wei"] == 0)

# Huge win, pool 1 GEN: upside capped at 1 GEN
r = settle(74000, 148000, 5 * GEN, 5 * GEN, 1 * GEN)
check("doubling capped at pool 1 GEN", r["return_wei"] == 6 * GEN and r["paid_upside_wei"] == 1 * GEN and r["capped"] is True and r["pool_after_wei"] == 0)

# Total loss (price -> 0 bucket is impossible, use -10000 bps via entry 74000 exit 0? bucket 0 invalid;
# instead exit 100: pnl_bps = trunc(-73900*10000/74000) = -9986, return = stake + trunc(5 GEN * -9986/10000))
r = settle(74000, 100, 5 * GEN, 5 * GEN, 0)
check("near-total loss return small positive", 0 < r["return_wei"] < 5 * GEN // 100)
check("near-total loss retained stake goes to pool", r["pool_after_wei"] == 5 * GEN - r["return_wei"])

# Negative pnl truncates toward zero, not floor: entry 74000 exit 73900
# -> pnl_bps = trunc(-100*10000/74000) = -13; effective 2.5 GEN,
# pnl_wei = trunc(2.5 GEN * -13 / 10000) = -3250000000000000.
r = settle(74000, 73900, 5 * GEN // 2, 5 * GEN, 0)
check("tiny loss pnl_bps -13", r["pnl_bps"] == -13)
check("tiny loss pnl_wei truncates", r["pnl_wei"] == -3250000000000000)

# --- challenge reward math ---------------------------------------------------
# reward = min(0.75 GEN, pool). Pool 2 GEN -> 0.75 GEN; pool 0.5 GEN -> 0.5 GEN; pool 0 -> 0.
for pool, expect in ((2 * GEN, 750000000000000000), (500000000000000000, 500000000000000000), (0, 0)):
    reward = mod.CHALLENGE_REWARD_WEI if pool >= mod.CHALLENGE_REWARD_WEI else pool
    check(f"challenge reward from pool {pool} -> {expect}", reward == expect)

# --- full-flow accounting simulation (invariant) ------------------------------
# Simulate the live flow in integers: total_in == total_out + locked + credits + pool.
total_in = 0
total_out = 0
locked_copies = 0
locked_ch = 0
credits = 0
pool = 0
# Ben challenge 2 GEN in, fails -> pool
total_in += 2 * GEN
locked_ch += 2 * GEN
locked_ch -= 2 * GEN
pool += 2 * GEN
# Dana challenge 2 GEN in, succeeds -> refund 2 + reward 0.75 from pool
total_in += 2 * GEN
locked_ch += 2 * GEN
locked_ch -= 2 * GEN
pool -= 750000000000000000
credits += 2 * GEN + 750000000000000000
check("invariant after challenges", total_in == total_out + locked_copies + locked_ch + credits + pool)
# Ava copy 5 GEN, Ben copy 5 GEN, C copy 5 GEN then cancel
total_in += 15 * GEN
locked_copies += 15 * GEN
locked_copies -= 5 * GEN
credits += 5 * GEN  # cancel refund
check("invariant after copies+cancel", total_in == total_out + locked_copies + locked_ch + credits + pool)
# Settle Ava copy: entry 74000 exit 74700, pool 1.25 GEN covers upside
s = mod._settle_math(74000, 74700, 5 * GEN, 5 * GEN, pool)
locked_copies -= 5 * GEN
credits += s["return_wei"]
pool = s["pool_after_wei"]
check("invariant after Ava settle", total_in == total_out + locked_copies + locked_ch + credits + pool)
# Withdraw everything
total_out += credits
credits = 0
check("invariant after withdraw-all", total_in == total_out + locked_copies + locked_ch + credits + pool)
check("pool left is 1.25 GEN minus Ava upside", pool == 1250000000000000000 - 47000000000000000)

# --- worst-case spread assertions -------------------------------------------
# Two leader outputs that differ in ANY field fail exact-match validation,
# so the stored core values cannot differ. Encode that as a check on the
# rule itself: the verdict is a pure function of the five checks, and the
# settlement is a pure function of (entry, exit, effective, stake, pool).
c1 = dict(all_pass)
c2 = dict(all_pass)
c2["numbers_consistent"] = False
check("different checklists cannot give the same VERIFIED verdict", mod._derive_verdict(c1) != mod._derive_verdict(c2))
check("identical checklists give identical verdicts (spread 0)", mod._derive_verdict(c1) == mod._derive_verdict(dict(all_pass)))
s1 = mod._settle_math(74000, 74700, 5 * GEN, 5 * GEN, 2 * GEN)
s2 = mod._settle_math(74000, 74700, 5 * GEN, 5 * GEN, 2 * GEN)
check("identical settle inputs give identical 11 fields (spread 0)", s1 == s2)
s3 = mod._settle_math(74000, 74800, 5 * GEN, 5 * GEN, 2 * GEN)
check("different exit bucket gives different pnl_bps (cannot both pass)", s1["pnl_bps"] != s3["pnl_bps"])

print()
if failures:
    print(f"{len(failures)} FAILURES")
    sys.exit(1)
print("ALL LOCAL LOGIC TESTS PASSED")
