/* Phase-3 proof: withdraw_payout on the live contract + leak record.
 *
 * Phase 2 (scripts/flow-resume.mjs) completed every business step
 * except the three withdraws: its runner process was killed when the
 * VM wiped /tmp mid-run, and the phase-2 accounts' keys died with
 * it, so D/E/F credits (17.75 GEN) remain outstanding and are
 * stranded. The contract is fine — the credits are still
 * withdrawable by whoever holds those keys — but this run cannot
 * withdraw them. Phase 3 therefore proves withdraw_payout on the
 * SAME live contract with a fresh account G (copy -> settle ->
 * withdraw, EOA balance reconciled), and records the two phase-2
 * leftovers honestly:
 *   (a) the failed payable copy attempt (negative case 1) moved its
 *       5 GEN into the contract balance without creating any credit
 *       or counter entry: contract balance is 5 GEN above
 *       total_received - total_paid_out. On Studionet, value
 *       attached to a reverted write still lands in the contract.
 *       D's EOA (9985 GEN = 10000 - 10 copies - 5 leaked) proves it.
 *   (b) D/E/F credits (10 + 2.75 + 5 GEN) were never withdrawn.
 * Writes the combined evidence.json (phase 1 + 2 + 3).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address");

const GEN = 10n ** 18n;
const FUND_GEN = 10000;
const accountG = createAccount(generatePrivateKey());
console.log("Phase-3 account G:", accountG.address);
console.log("Contract:", address);

const clientG = createClient({ chain: studionet, account: accountG });
const STATUS_NAMES = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const eoaBalance = async (client, addr) => (await client.getBalance({ address: addr })).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFinal(client, hash, label) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    retries: 240,
    interval: 5000,
  });
  const status = receipt.statusName ?? STATUS_NAMES[receipt.status] ?? String(receipt.status ?? "");
  console.log(`${label} tx: ${hash} -> ${status}`);
  if (status !== "FINALIZED") throw new Error(`${label} did not finalize: ${status}`);
  return { hash, status };
}

async function writeOnce(client, functionName, args, value, label) {
  const hash = await client.writeContract({ address, functionName, args, value, leaderOnly: false });
  return waitFinal(client, hash, label);
}

async function writeChecked(client, functionName, args, value, label, checkFn, maxAttempts = 5) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await writeOnce(client, functionName, args, value, `${label} (attempt ${attempt})`);
      if (await checkFn()) return res;
      console.log(`  ${label}: read-back check not met after attempt ${attempt}, retrying...`);
    } catch (e) {
      lastErr = e;
      console.log(`  ${label}: attempt ${attempt} failed: ${String(e).slice(0, 300)}`);
    }
    await sleep(5000);
  }
  throw new Error(`${label}: did not reach expected state after ${maxAttempts} attempts: ${String(lastErr).slice(0, 500)}`);
}

async function read(client, functionName, args) {
  const raw = await client.readContract({ address, functionName, args });
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  check ${label}: ${JSON.stringify(actual)}`);
}

const phase1 = {
  note: "Phase 1 ran scripts/flow.mjs and stopped at the Dana close: the evidence file was corrected 999 -> 300, curl saw 300, but all validators still fetched the stale 999 (CDN cache), so round2 closed SUSPECT and the challenge failed. Phase-1 accounts A/B/C keys were lost with the phase-1 process; no funds need recovering from them (B's two 2 GEN challenge stakes were forfeited into the house pool by design).",
  accounts: {
    A: "0x1Ca0137b9e33Aa9435eB057ef62053eB7D7f8364",
    B: "0x550eA0f1b60a9449e4F0A15De90542F43b8DC084",
    C: "0xFD0f6D913AEefa3FdBb12Ca611523f3bA5256E63",
  },
  fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
  txs: {
    registerAva: { hash: "0x87075048e4e03a8400c0cd7bcbf3bd199c86f8c27c0f6cc8b954084236833f69", status: "FINALIZED" },
    auditAva: { hash: "0x6bf32256f2b7b5b59c5b1068f13cb29a0d87274d259c8eaaa3ebc35e9d2506c2", status: "FINALIZED" },
    finalizeAva: { hash: "0x0d622ce07cf351281bc1db859f5acc8aba2d31c1a8da044ffe0ceed5fa0084ed", status: "FINALIZED" },
    registerBen: { hash: "0x2b282aaf056fa3ad8afc9649acf5f01fbbcbd8a657a828514fb0f8231c14e52f", status: "FINALIZED" },
    auditBen: { hash: "0xf9ac6af3cbcdd875863a4c843a06d7836b0ce1ad82d84132488e53fd2b3cdd9a", status: "FINALIZED" },
    challengeBen: { hash: "0x00b3eceda5cb904eef4b6cdaadb6d214b2b18c35a44923dc1abd9fcdafc7c6b7", status: "FINALIZED" },
    finalizeBen: { hash: "0xedceae93cf05b54b6dc58ef25eef39d6357f5c59b6f2f9d422220030299e95ea", status: "FINALIZED" },
    registerDana: { hash: "0x5046dbf5b7ea12b7966d2c8a1aaa60a82e04fd275851ac03429cd5227b376202", status: "FINALIZED" },
    auditDana: { hash: "0xca3ded4e17a609386d4bcc3eaadf6f8b0da57b8167a555409b60c5aa6a99c759", status: "FINALIZED" },
    challengeDana: { hash: "0x7de7be84cd2ec52b1d2b89a08b174ff2ffd8d9475276f9633f1090b223b58fea", status: "FINALIZED" },
    finalizeDana: { hash: "0x02aa99ddb2cb6568ef9368001f01ed7386d58344b05d84e15959858a6fb0b8bc", status: "FINALIZED" },
  },
};

const phase2 = {
  note: "Phase 2 ran scripts/flow-resume.mjs. It completed every business step except the three withdraws: its runner was killed when the VM wiped /tmp mid-run, and the phase-2 accounts' keys died with it. The settleBen retry hash was recovered from the explorer address page after the run log was lost with /tmp.",
  accounts: {
    D: "0xc94d13716d0609566519cB78cf4298f0C3849218",
    E: "0x36a3F278df24c725d2623232D5C0d35D5254F754",
    F: "0xFBD3419E63b351AB2D5Fe0d180942f5c76ff7e73",
  },
  fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
  txs: {
    reauditDana: { hash: "0x0f67693b8860ed831a0f2232eca4e4f387a38a71d110ce4d02893d1c044ff7ce", status: "FINALIZED" },
    finalizeReauditDana: { hash: "0xe49bfe6fbb60234a1b4d6d7d09cecfc8ecc37d6e5e20d4047b08fc1ee0344a52", status: "FINALIZED" },
    registerCara: { hash: "0x6243af4e61e5cd24638c38726b1b779b10cc4718d659b9d212cff86409326e3b", status: "FINALIZED" },
    auditCara: { hash: "0x7aeca5b82a2dd1ec4dd72f1b0d1d0ab5987794abb99e54bb4d2afb66fd5099a0", status: "FINALIZED" },
    finalizeCara: { hash: "0x894d052f48f7f56606b6a9e5cce723528a9893b3735ab8c7d596a035556d8f43", status: "FINALIZED" },
    registerEli: { hash: "0x5d74f0f92399d0c9e70a132d83ba10f7251f848fb94b01b4d20c363b5523939b", status: "FINALIZED" },
    auditEli: { hash: "0x52a8280e64ed9a7901dc722f0b87dedd301bde8433572119ec19b6cdc80d91eb", status: "FINALIZED" },
    challengeEli: { hash: "0xcd2c38f0aa8897279f65cd87e66b5a9a068a020769e2f04837a4aa09e917a689", status: "FINALIZED" },
    probeEli6: { hash: "0xd18af864ed9d87cb611c90e7667da811817978a31c2b0d13754100d30f3f0104", status: "FINALIZED" },
    finalizeEli: { hash: "0x7fd0d5ce783297dffc1e714d106f3341d4ab982fdbedebd0f22d9a3cadff012e", status: "FINALIZED" },
    finalizeProbeEli: { hash: "0x73ba868dee3ed3464046ec2156df783293599cbec4e8bd79c39f69d5b7139a90", status: "FINALIZED" },
    copyAva: { hash: "0x0712c9c2b869a0f19d041639e9658edc66dbc798b24f037e95ae260bd233c0d2", status: "FINALIZED" },
    copyBenD: { hash: "0x2c0ae3f816d17d9c998181a87818b0fa0774ea7142fc9c42c6c7814100a09924", status: "FINALIZED" },
    copyBenF: { hash: "0xfc27c992a852572a3d3bd519d2c97e2ebbddd80180cabf7a7ea082b0d629e4aa", status: "FINALIZED" },
    negativeCopyRejected: { attempted: true, outcome: "tx submitted, receipt status FINALIZED, GenVM result ERROR (explorer)", hash: "0xea00f2d2007ff50c00b0cfea004a1e909ec8a0777561cd98a01f49f89aaaf0e6", error: null },
    cancelBenF: { hash: "0x7c467e5a2774f8f539ebc1fabc4c8931dc0d659c638a9660914cd783c8e09456", status: "FINALIZED" },
    negativeSettleCancelled: { attempted: true, outcome: "tx submitted, receipt status FINALIZED, GenVM result ERROR (explorer)", hash: "0x7f252e73d8e4b88fc092d008e70f0248e70b4a95b4dfb2b124ea4ed5e642ab31", error: null },
    settleAva: { hash: "0x81f0f60d2f58d602061c20081c855dfb00b286d50882d029d1599c010623dc55", status: "FINALIZED" },
    settleBenAttempt1: { hash: "0xa1dde09f0839c1b2341d10cc8c1a57b1ba5527298baa202c318ce90ffb08c11b", status: "FINALIZED", note: "GenVM result ERROR (price bucket crossed mid-consensus); no state changed; retried" },
    settleBen: { hash: "0xb700a8c70484038e7acfb2c9aa75ca4af886f09947b12ddf15880b647f57bd2b", status: "FINALIZED" },
  },
  withdrawsNotRun: "Runner killed when /tmp was wiped; D/E/F keys lost with it. Credits D 10 GEN, E 2.75 GEN, F 5 GEN remain outstanding (still withdrawable by the key holders).",
};

const txs = {};

// --- record the phase-2 leftovers -----------------------------------------
const leftover = {
  eoaWei: {
    D: await eoaBalance(clientG, phase2.accounts.D),
    E: await eoaBalance(clientG, phase2.accounts.E),
    F: await eoaBalance(clientG, phase2.accounts.F),
    phase1B: await eoaBalance(clientG, phase1.accounts.B),
  },
  creditsWei: {
    D: String(await read(clientG, "get_credit", [phase2.accounts.D])),
    E: String(await read(clientG, "get_credit", [phase2.accounts.E])),
    F: String(await read(clientG, "get_credit", [phase2.accounts.F])),
  },
};
console.log("Leftover EOAs:", JSON.stringify(leftover.eoaWei));
console.log("Leftover credits:", JSON.stringify(leftover.creditsWei));
assertEq("D EOA 9985 GEN (10000 - 10 copies - 5 leaked)", leftover.eoaWei.D, "9985000000000000000000");
assertEq("E EOA 9998 GEN (10000 - 2 challenge)", leftover.eoaWei.E, "9998000000000000000000");
assertEq("F EOA 9995 GEN (10000 - 5 copy)", leftover.eoaWei.F, "9995000000000000000000");
assertEq("phase-1 B EOA 9996 GEN (10000 - 4 challenges)", leftover.eoaWei.phase1B, "9996000000000000000000");
assertEq("D credit 10 GEN (two flat settles)", leftover.creditsWei.D, "10000000000000000000");
assertEq("E credit 2.75 GEN (refund + reward)", leftover.creditsWei.E, "2750000000000000000");
assertEq("F credit 5 GEN (cancel refund)", leftover.creditsWei.F, "5000000000000000000");
const totalsBeforeG = await read(clientG, "get_totals", []);
assertEq("totals invariant before G", totalsBeforeG.invariant_ok, true);
assertEq("balance_matches false before G (5 GEN leak)", totalsBeforeG.balance_matches_wei, false);
const leakWei = BigInt(totalsBeforeG.contract_balance_wei) - (BigInt(totalsBeforeG.total_received_wei) - BigInt(totalsBeforeG.total_paid_out_wei));
assertEq("leaked value in balance (5 GEN)", leakWei.toString(), "5000000000000000000");
console.log("Totals before G:", JSON.stringify(totalsBeforeG));

// --- fund G and prove withdraw on the live contract ------------------------
const fundTx = await clientG.request({ method: "sim_fundAccount", params: [accountG.address, FUND_GEN * 10 ** 18] });
const fundedG = { fundTx: String(fundTx), balanceWei: await eoaBalance(clientG, accountG.address) };
assertEq("account G funded 10000 GEN", fundedG.balanceWei, (BigInt(FUND_GEN) * GEN).toString());
txs.copyAvaG = await writeChecked(clientG, "copy_trader", ["t0"], 5n * GEN, "copy Ava 5 GEN (G)",
  async () => (await read(clientG, "get_copy", ["c3"]))?.status === "OPEN");
let copy3 = await read(clientG, "get_copy", ["c3"]);
assertEq("copy c3 stake wei", copy3.stake_wei, 5000000000000000000);
assertEq("copy c3 weight", copy3.weight, 100);
console.log("  copy c3 entry BTC bucket USD:", copy3.entry_bucket_usd);
txs.settleAvaG = await writeChecked(clientG, "settle_copy", ["c3"], 0n, "settle copy c3 (G)",
  async () => (await read(clientG, "get_copy", ["c3"]))?.status === "SETTLED");
copy3 = await read(clientG, "get_copy", ["c3"]);
console.log("  copy c3 settled:", JSON.stringify({ entry: copy3.entry_bucket_usd, exit: copy3.exit_bucket_usd, pnl_bps: copy3.pnl_bps, pnl_wei: copy3.pnl_wei, return_wei: copy3.return_wei, capped: copy3.capped }));
{
  const trunc = (a, b) => { const q = (a < 0n ? -a : a) / b; return a < 0n ? -q : q; };
  const pnlBps = Number(trunc(BigInt((copy3.exit_bucket_usd - copy3.entry_bucket_usd) * 10000), BigInt(copy3.entry_bucket_usd)));
  assertEq("copy c3 pnl_bps recomputed off-chain", copy3.pnl_bps, pnlBps);
}
const eoaBefore = await eoaBalance(clientG, accountG.address);
const creditBefore = String(await read(clientG, "get_credit", [accountG.address]));
console.log("G EOA before withdraw:", eoaBefore, "| credit:", creditBefore);
txs.withdrawG = await writeChecked(clientG, "withdraw_payout", [], 0n, "withdraw G",
  async () => String(await read(clientG, "get_credit", [accountG.address])) === "0");
await sleep(8000);
const eoaAfter = await eoaBalance(clientG, accountG.address);
console.log("G EOA after withdraw (+8s):", eoaAfter);
assertEq("EOA G after withdraw = before + credit", eoaAfter, (BigInt(eoaBefore) + BigInt(creditBefore)).toString());

// --- final read-back -------------------------------------------------------
const counts = await read(clientG, "get_counts", []);
assertEq("counts traders", counts.traders, 5);
assertEq("counts audits", counts.audits, 7);
assertEq("counts copies", counts.copies, 4);
assertEq("counts witnesses", counts.witnesses, 1);
const traders = await read(clientG, "list_traders", [0n, 20n]);
const audits = await read(clientG, "list_audits", [0n, 20n]);
const copies = await read(clientG, "list_copies", [0n, 20n]);
const witnesses = await read(clientG, "list_witnesses", [0n, 20n]);
const finalTotals = await read(clientG, "get_totals", []);
assertEq("final invariant ok", finalTotals.invariant_ok, true);
assertEq("final total received 26 GEN", finalTotals.total_received_wei, 26000000000000000000);
assertEq("final paid out == G credit withdrawn", finalTotals.total_paid_out_wei, Number(creditBefore));
assertEq("final balance == received - paid + 5 GEN leak", finalTotals.contract_balance_wei, finalTotals.total_received_wei - finalTotals.total_paid_out_wei + 5000000000000000000);
assertEq("final balance_matches false (5 GEN leak persists)", finalTotals.balance_matches_wei, false);
const finalCredits = {
  D: String(await read(clientG, "get_credit", [phase2.accounts.D])),
  E: String(await read(clientG, "get_credit", [phase2.accounts.E])),
  F: String(await read(clientG, "get_credit", [phase2.accounts.F])),
  G: String(await read(clientG, "get_credit", [accountG.address])),
};

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  deployment,
  phase1,
  phase2,
  phase3: {
    account: { G: accountG.address },
    funded: fundedG,
    txs,
    leftoverPhase2: leftover,
    leakWei: leakWei.toString(),
    leakNote: "The 5 GEN attached to the failed payable copy_trader call (negative case 1, tx 0xea00f2d2...) sits in the contract balance with no credit and no counter entry: contract_balance = total_received - total_paid_out + 5 GEN leaked. D's EOA confirms the 5 GEN left D's account. The counter invariant total_received == total_paid_out + locked + credits + pool still holds exactly.",
  },
  readBack: { counts, traders, audits, copies, witnesses, finalTotals, finalCredits },
  reconciliation: {
    fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
    phase3EoaBeforeWithdrawWei: eoaBefore,
    phase3CreditBeforeWithdrawWei: creditBefore,
    phase3EoaAfterWithdrawWei: eoaAfter,
    note: "Phase-1 B paid 4 GEN in failed challenge stakes (forfeited to the pool). Phase-2 D paid 10 GEN in copy stakes + 5 GEN leaked by the failed payable copy call; D's credits (10 GEN) were never withdrawn (keys lost). Phase-2 E paid 2 GEN in a challenge stake and was credited 2.75 GEN (never withdrawn). Phase-2 F paid 5 GEN in a copy stake and was credited 5 GEN (never withdrawn). Phase-3 G paid 5 GEN in a copy stake, settled, and withdrew its full credit; G's EOA reconciles exactly (before + credit = after). Contract balance at the end = 17.75 GEN stranded credits + house pool + 5 GEN leaked from the failed payable call.",
  },
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
console.log("PHASE-3 COMPLETE: all assertions passed");
