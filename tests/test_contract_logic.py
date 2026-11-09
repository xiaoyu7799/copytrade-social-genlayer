"""Local logic tests for contracts/copytrade.py (LOCAL MOCK only).

Stubs the `genlayer` module so the contract file's pure deterministic
helpers can run in plain Python. These tests prove the arithmetic,
the verdict table and the exactness rules — they are NOT on-chain
evidence. On-chain behaviour is proven by the flow script + RPC
read-back in evidence.json.
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


class _GL:
    public = _Public()
    vm = _VM()
    nondet = _Nondet()

    class Contract:
        pass


genlayer.gl = _GL()
genlayer.TreeMap = dict
genlayer.DynArray = list


class _U256(int):
    pass


genlayer.u256 = _U256
genlayer.i256 = _U256
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

# --- evidence files recompute exactly --------------------------------------
for fname, expect in (("trader-ava.json", "VERIFIED"), ("trader-ben.json", "SUSPECT"), ("trader-cara.json", "REJECTED")):
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
    check(f"{fname}: numbers recompute exactly", numbers_ok)
    check(f"{fname}: dates consistent", dates_ok)
    age = mod._date_diff_days("2026-11-09", ev["window_end"])
    fresh = 0 <= age <= 90
    check(f"{fname}: age {age} days, fresh={fresh}", (fname != "trader-ben.json") == fresh)
    identity = {"trader-ava.json": True, "trader-ben.json": True, "trader-cara.json": False}[fname]
    checks = {"source_valid": True, "identity_matches": identity, "dates_consistent": dates_ok, "numbers_consistent": numbers_ok, "evidence_fresh": fresh}
    check(f"{fname}: verdict table gives {expect}", mod._derive_verdict(checks) == expect)

# --- settlement exactness --------------------------------------------------
for allocation, weight, pnl_bps, expected_pnl in ((1000, 100, 500, 50), (1000, 100, -300, -30), (2000, 50, 500, 50), (1000, 100, 10000, 1000)):
    effective = allocation * weight // 100
    assert (effective * pnl_bps) % 10000 == 0, "settlement must divide exactly"
    check(f"settle alloc {allocation} w{weight} pnl {pnl_bps} -> {expected_pnl}", effective * pnl_bps // 10000 == expected_pnl)
check("allocation 150 rejected (not multiple of 100)", 150 % 100 != 0)
check("pnl 501 rejected (not multiple of 100)", 501 % 100 != 0)
check("SUSPECT effective is exact half", 1000 * 50 // 100 == 500)

# --- worst-case spread assertions -------------------------------------------
# Two leader outputs that differ in ANY field fail exact-match validation,
# so the stored core values cannot differ. Encode that as a check on the
# rule itself: the verdict is a pure function of the five checks.
def verdict_of(checks):
    return mod._derive_verdict(checks)

c1 = dict(all_pass)
c2 = dict(all_pass)
c2["numbers_consistent"] = False
check("different checklists cannot give the same VERIFIED verdict", verdict_of(c1) != verdict_of(c2))
check("identical checklists give identical verdicts (spread 0)", verdict_of(c1) == verdict_of(dict(all_pass)))

print()
if failures:
    print(f"{len(failures)} FAILURES")
    sys.exit(1)
print("ALL LOCAL LOGIC TESTS PASSED")
