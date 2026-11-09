/* CopyTrade frontend: reads via genlayer-js (esm.sh), writes via an
   in-browser temporary test account that is clearly labelled and
   discarded when the tab closes. Wallet connect is for identity and
   network checks; GenLayer writes need a Snap the wallet does not
   have, so the temporary account is the honest write path.
   Money is real testnet GEN: the temporary account is funded from
   the Studionet faucet first (10,000 GEN, free), then copy_trader
   stakes exactly 5 GEN and challenge_audit exactly 2 GEN per call. */
import { CONFIG, EXPLORER_TX, EXPLORER_ADDRESS } from "./config.js";
import { I18N } from "./i18n.js";

const $ = (sel) => document.querySelector(sel);
const boardEl = $("#leaderboard");
const toastEl = $("#txToast");

const GEN_WEI = 10n ** 18n;
const STAKE_WEI = 5n * GEN_WEI;
const CHALLENGE_WEI = 2n * GEN_WEI;

let lang = (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
try { lang = localStorage.getItem("copytrade-lang") || lang; } catch { /* ignore */ }
const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;

let genlayer = null;      // dynamic import of genlayer-js
let readClient = null;    // ephemeral read-only client
let writeClient = null;   // temp test-account client (in-memory only)
let tempAccount = null;
let walletAddress = null;
let walletChainId = null;

let traders = [];
let audits = [];
let copies = [];
let myCreditWei = 0n;
let sortKey = "reputation";
const compareSet = new Set();

/* ---------- formatting ---------- */
function fmtWei(wei) {
  const w = BigInt(wei ?? 0);
  const neg = w < 0n;
  const abs = neg ? -w : w;
  const whole = abs / GEN_WEI;
  const frac = abs % GEN_WEI;
  let fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  if (fracStr.length > 6) fracStr = fracStr.slice(0, 6);
  return (neg ? "-" : "") + whole.toString() + (fracStr ? "." + fracStr : "");
}
function fmtGen(wei) { return `${fmtWei(wei)} GEN`; }

/* ---------- i18n ---------- */
function applyI18n() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  $("#langToggle").textContent = lang === "zh" ? "English" : "中文";
  renderWalletState();
  renderBoard(false);
  renderCopies();
  renderCompare();
}

/* ---------- genlayer client ---------- */
async function loadGenlayer() {
  if (genlayer) return genlayer;
  try {
    const mod = await import("genlayer-js");
    const chains = await import("genlayer-js/chains");
    const types = await import("genlayer-js/types");
    genlayer = { ...mod, studionet: chains.studionet, TransactionStatus: types.TransactionStatus };
    const ephemeral = genlayer.createAccount(genlayer.generatePrivateKey());
    readClient = genlayer.createClient({ chain: genlayer.studionet, account: ephemeral });
    return genlayer;
  } catch (err) {
    console.error("genlayer-js failed to load", err);
    toast(t("err.generic") + " (genlayer-js failed to load)", true);
    throw err;
  }
}

async function read(method, args) {
  await loadGenlayer();
  const raw = await readClient.readContract({ address: CONFIG.contractAddress, functionName: method, args });
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function ensureTempAccount() {
  if (tempAccount) return tempAccount;
  tempAccount = genlayer.createAccount(genlayer.generatePrivateKey());
  writeClient = genlayer.createClient({ chain: genlayer.studionet, account: tempAccount });
  $("#tempAccountBar").hidden = false;
  $("#tempAddress").textContent = tempAccount.address;
  return tempAccount;
}

function discardTempAccount() {
  tempAccount = null;
  writeClient = null;
  $("#tempAccountBar").hidden = true;
  $("#tempAddress").textContent = "";
  refreshMyAccount();
  renderCopies();
}

async function fundTempAccount() {
  await loadGenlayer();
  ensureTempAccount();
  try {
    toast(t("wallet.funding"));
    await writeClient.request({ method: "sim_fundAccount", params: [tempAccount.address, 10000 * 10 ** 18] });
    toast(t("wallet.funded"));
    await refreshMyAccount();
  } catch (err) {
    toast(`${t("err.fundFailed")} — ${t("links.faucet")}: https://studio.genlayer.com/validators`, true);
    console.error("fund temp account failed", err);
  }
}

/* ---------- toast / tx flow ---------- */
let toastTimer = null;
function toast(html, isError = false) {
  toastEl.hidden = false;
  toastEl.innerHTML = html;
  toastEl.style.background = isError ? "#8c2f16" : "#1e1b16";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 12000);
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || "");
  const m = msg.match(/EXPECTED:\s*([a-z_0-9]+)/);
  const code = m ? m[1] : "";
  const map = {
    copy_stake_must_be_5_gen: t("trader.stake"),
    challenge_stake_must_be_2_gen: t("trader.challengeStake"),
    rejected_trader_cannot_be_copied: "REJECTED",
    trader_not_audited_yet: t("trader.notAudited"),
    copy_not_open: t("copy.notOpen"),
    only_copy_owner_can_settle: t("err.notOwner"),
    only_copy_owner_can_cancel: t("err.notOwner"),
    no_credit: t("err.noCredit"),
    audit_not_challengeable: t("trader.statusClosed"),
    audit_already_closed: t("trader.statusClosed"),
    requester_cannot_challenge_own_audit: t("err.ownAudit"),
  };
  if (map[code]) return map[code];
  if (msg.includes("FINALIZED") && msg.includes("ERROR")) return t("tx.failed");
  return t("err.generic") + (msg ? ` (${msg.slice(0, 160)})` : "");
}

async function writeTx(functionName, args, value, successKey) {
  await loadGenlayer();
  ensureTempAccount();
  toast(t("tx.sending"));
  try {
    const hash = await writeClient.writeContract({
      address: CONFIG.contractAddress,
      functionName,
      args,
      value,
      leaderOnly: false,
    });
    toast(`${t("tx.waiting")} <a href="${EXPLORER_TX(hash)}" target="_blank" rel="noopener">${t("tx.view")}</a>`);
    const receipt = await writeClient.waitForTransactionReceipt({
      hash,
      status: genlayer.TransactionStatus.FINALIZED,
      retries: 240,
      interval: 5000,
    });
    const status = receipt.statusName || String(receipt.status ?? "");
    if (status !== "FINALIZED") throw new Error(`receipt status ${status}`);
    toast(`${t("tx.finalized")} — ${t(successKey)} <a href="${EXPLORER_TX(hash)}" target="_blank" rel="noopener">${t("tx.view")}</a>`);
    await refreshAll();
    return hash;
  } catch (err) {
    toast(`${t("tx.failed")}: ${friendlyError(err)}`, true);
    throw err;
  }
}

/* ---------- wallet ---------- */
function injectedProvider() {
  if (window.okxwallet) return window.okxwallet;
  if (window.ethereum) return window.ethereum;
  return null;
}

async function connectWallet() {
  const provider = injectedProvider();
  if (!provider) { toast(t("err.noWallet"), true); return; }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    walletAddress = accounts && accounts[0] ? accounts[0] : null;
    const chainHex = await provider.request({ method: "eth_chainId" });
    walletChainId = parseInt(chainHex, 16);
    renderWalletState();
    await refreshMyAccount();
    renderCopies();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function switchNetwork() {
  const provider = injectedProvider();
  if (!provider) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.chainIdHex }] });
    walletChainId = CONFIG.chainId;
    renderWalletState();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

function renderWalletState() {
  const stateEl = $("#walletState");
  const btn = $("#walletBtn");
  if (!walletAddress) {
    stateEl.textContent = t("wallet.notConnected");
    btn.textContent = t("wallet.connect");
    return;
  }
  const short = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
  if (walletChainId !== CONFIG.chainId) {
    stateEl.textContent = `${t("wallet.address")}: ${short} — ${t("wallet.wrongNetwork")}`;
    btn.textContent = t("wallet.switch");
    btn.onclick = switchNetwork;
  } else {
    stateEl.textContent = `${t("wallet.address")}: ${short} · ${t("wallet.connected")}`;
    btn.textContent = t("wallet.connected");
    btn.onclick = connectWallet;
  }
}

/* ---------- data ---------- */
async function refreshAll() {
  try {
    await read("get_counts", []);
    const [tList, aList, cList] = await Promise.all([
      read("list_traders", [0n, 20n]),
      read("list_audits", [0n, 20n]),
      read("list_copies", [0n, 20n]),
    ]);
    traders = Array.isArray(tList) ? tList : [];
    audits = Array.isArray(aList) ? aList : [];
    copies = Array.isArray(cList) ? cList : [];
    $("#boardSkeleton").hidden = true;
    $("#boardEmpty").hidden = traders.length > 0;
    $("#lastRead").textContent = new Date().toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
    renderBoard(true);
    renderCompare();
    await refreshMyAccount();
    renderCopies();
  } catch (err) {
    $("#boardSkeleton").hidden = true;
    toast(friendlyError(err), true);
  }
}

async function refreshMyAccount() {
  const addr = walletAddress || (tempAccount && tempAccount.address);
  if (!addr) { myCreditWei = 0n; $("#genBalance").textContent = ""; $("#creditLine").textContent = ""; return; }
  try {
    const [credit, bal] = await Promise.all([
      read("get_credit", [addr]),
      readClient.getBalance({ address: addr }),
    ]);
    myCreditWei = BigInt(credit ?? 0);
    $("#genBalance").textContent = `${fmtGen(bal)} · ${t("copies.credit")}: ${fmtGen(myCreditWei)}`;
    $("#creditLine").textContent = `${t("copies.credit")}: ${fmtGen(myCreditWei)} (${myCreditWei.toString()} wei)`;
  } catch { /* keep previous */ }
}

function latestAudit(traderId) {
  const list = audits.filter((a) => a.trader_id === traderId);
  return list.length ? list[list.length - 1] : null;
}

function winRateOf(traderId) {
  const a = latestAudit(traderId);
  if (!a || !a.round1 || a.round1.trade_count <= 0) return null;
  return Math.round((a.round1.wins * 10000) / a.round1.trade_count) / 100;
}

/* ---------- leaderboard render (View Transitions: the one motion) ---------- */
function sortedTraders() {
  const list = [...traders];
  if (sortKey === "followers") list.sort((a, b) => b.followers - a.followers || b.reputation - a.reputation);
  else if (sortKey === "winrate") list.sort((a, b) => (winRateOf(b.id) ?? -1) - (winRateOf(a.id) ?? -1) || b.reputation - a.reputation);
  else list.sort((a, b) => b.reputation - a.reputation || b.followers - a.followers);
  return list;
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return (parts[0][0] || "?") + (parts.length > 1 ? (parts[parts.length - 1][0] || "") : "");
}

function verdictBadge(trader) {
  if (!trader.verdict) return `<span class="badge pending">${t("trader.notAudited")}</span>`;
  const cls = trader.verdict.toLowerCase();
  return `<span class="badge ${cls}">${trader.verdict} · ${trader.weight / 100}x</span>`;
}

function auditStatusLabel(audit) {
  if (!audit) return "";
  if (audit.status === "CHALLENGED") return t("trader.statusChallenged");
  if (audit.status === "CLOSED") return t("trader.statusClosed");
  return t("trader.statusPending");
}

function buildCard(trader, rank) {
  const li = document.createElement("li");
  li.className = "trader-card";
  li.style.setProperty("--vt-name", `trader-${trader.id}`);
  const audit = latestAudit(trader.id);
  const winRate = winRateOf(trader.id);
  const totalReturn = audit && audit.round1 ? audit.round1.total_return_bps : null;
  const avatarClass = rank % 3 === 1 ? "coral" : rank % 3 === 2 ? "gold" : "";
  const auditLine = audit
    ? `<div class="audit-line">${auditStatusLabel(audit)} · ${audit.id} · ${audit.round1.verdict}${audit.round2 ? ` → ${audit.round2.verdict}` : ""}${audit.challenge_outcome ? ` · ${audit.challenge_outcome}` : ""}</div>`
    : "";
  const canCopy = trader.verdict === "VERIFIED" || trader.verdict === "SUSPECT";
  li.innerHTML = `
    <div class="trader-top">
      <div class="rank" aria-label="rank ${rank}">#${rank}</div>
      <div class="avatar ${avatarClass}" aria-hidden="true">${initials(trader.name)}</div>
      <div class="trader-id">
        <h3 class="trader-name">${escapeHtml(trader.name)}</h3>
        <p class="trader-code">${escapeHtml(trader.trader_code)} · ${escapeHtml(trader.id)}</p>
        ${verdictBadge(trader)}
      </div>
    </div>
    <div class="trader-stats">
      <div class="stat">${t("trader.winrate")}<b>${winRate === null ? "—" : winRate.toFixed(1) + "%"}</b></div>
      <div class="stat">${t("trader.totalReturn")}<b>${totalReturn === null ? "—" : (totalReturn / 100).toFixed(2) + "%"}</b></div>
      <div class="stat">${t("trader.followers")}<b>${trader.followers}</b></div>
      <div class="stat">${t("trader.reputation")}<b>${trader.reputation}</b></div>
    </div>
    <div class="trader-evidence"><a href="${escapeHtml(trader.evidence_ref)}" target="_blank" rel="noopener">${t("trader.evidence")}</a> · ${t("trader.copied")} ${fmtGen(trader.total_copied_wei)}</div>
    <div class="trader-actions">
      <button class="btn btn-small" data-act="audit" data-id="${trader.id}">${t("trader.audit")}</button>
      <button class="btn btn-small" data-act="finalize" data-audit="${audit ? audit.id : ""}" ${!audit || audit.status === "CLOSED" ? "disabled" : ""}>${t("trader.finalize")}</button>
      <button class="btn btn-small" data-act="challenge" data-audit="${audit ? audit.id : ""}" ${!audit || audit.status !== "PENDING" ? "disabled" : ""}>${t("trader.challenge")}</button>
      <button class="btn btn-small" data-act="compare" data-id="${trader.id}">${compareSet.has(trader.id) ? "✓ " : ""}${t("trader.compare")}</button>
      <button class="btn btn-small btn-coral" data-act="follow" data-id="${trader.id}" ${canCopy ? "" : "disabled"}>${t("trader.follow")}</button>
      <span class="stake-note">${t("trader.stake")}</span>
    </div>
    ${auditLine}`;
  return li;
}

function renderBoard(transition) {
  if (!boardEl) return;
  const build = () => {
    boardEl.innerHTML = "";
    sortedTraders().forEach((trader, i) => boardEl.appendChild(buildCard(trader, i + 1)));
  };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (transition && document.startViewTransition && !reduce) {
    document.startViewTransition(build);
  } else {
    build();
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- compare ---------- */
function renderCompare() {
  const section = $("#compareSection");
  const grid = $("#compareGrid");
  const picked = [...compareSet].map((id) => traders.find((tr) => tr.id === id)).filter(Boolean).slice(0, 2);
  if (picked.length === 0) { section.hidden = true; grid.innerHTML = ""; return; }
  section.hidden = false;
  grid.innerHTML = "";
  picked.forEach((trader) => {
    const winRate = winRateOf(trader.id);
    const audit = latestAudit(trader.id);
    const cell = document.createElement("div");
    cell.className = "compare-cell";
    cell.innerHTML = `
      <h3>${escapeHtml(trader.name)}</h3>
      <dl>
        <dt>${t("trader.winrate")}</dt><dd>${winRate === null ? "—" : winRate.toFixed(1) + "%"}</dd>
        <dt>${t("trader.totalReturn")}</dt><dd>${audit && audit.round1 ? (audit.round1.total_return_bps / 100).toFixed(2) + "%" : "—"}</dd>
        <dt>${t("trader.followers")}</dt><dd>${trader.followers}</dd>
        <dt>${t("trader.reputation")}</dt><dd>${trader.reputation}</dd>
        <dt>Verdict</dt><dd>${trader.verdict || "—"} · ${trader.weight / 100}x</dd>
        <dt>${t("trader.copied")}</dt><dd>${fmtGen(trader.total_copied_wei)}</dd>
      </dl>`;
    grid.appendChild(cell);
  });
}

/* ---------- copies ---------- */
function copyStatusBadge(copy) {
  if (copy.status === "SETTLED") return `<span class="badge verified">${t("copy.settled")}</span>`;
  if (copy.status === "CANCELLED") return `<span class="badge rejected">${t("copy.cancelled")}</span>`;
  return `<span class="badge pending">${t("copy.open")}</span>`;
}

function renderCopies() {
  const listEl = $("#copiesList");
  const addr = walletAddress || (tempAccount && tempAccount.address);
  const mine = addr ? copies.filter((c) => c.follower === addr) : [];
  $("#copiesEmpty").hidden = mine.length > 0;
  $("#withdrawBtn").disabled = myCreditWei <= 0n;
  listEl.innerHTML = "";
  mine.forEach((copy) => {
    const trader = traders.find((tr) => tr.id === copy.trader_id);
    const li = document.createElement("li");
    li.className = "copy-card";
    const settled = copy.status === "SETTLED";
    li.innerHTML = `
      <div class="copy-head">
        <b>${escapeHtml(trader ? trader.name : copy.trader_id)}</b>
        ${copyStatusBadge(copy)}
      </div>
      <div class="copy-numbers">
        <span>${t("copy.stake")}: <b>${fmtGen(copy.stake_wei)}</b></span>
        <span>${t("copy.effective")}: <b>${fmtGen(copy.effective_wei)}</b></span>
        <span>${t("copies.entryPrice")}: <b>$${copy.entry_bucket_usd}</b></span>
        ${settled ? `<span>${t("copies.exitPrice")}: <b>$${copy.exit_bucket_usd}</b></span><span>${t("copy.pnl")}: <b>${fmtGen(copy.pnl_wei)} (${copy.pnl_bps} bps)</b>${copy.capped ? ` · ${t("copies.capped")}` : ""}</span><span>${t("copy.settledValue")}: <b>${fmtGen(copy.return_wei)}</b></span>` : ""}
        ${copy.status === "CANCELLED" ? `<span>${t("copy.settledValue")}: <b>${fmtGen(copy.return_wei)}</b></span>` : ""}
      </div>
      ${copy.status === "OPEN" ? `
      <div class="copy-settle">
        <button class="btn btn-small btn-solid" data-act="settle" data-id="${copy.id}">${t("trader.settle")}</button>
        <button class="btn btn-small" data-act="cancel" data-id="${copy.id}">${t("copies.cancel")}</button>
      </div>` : ""}`;
    listEl.appendChild(li);
  });
}

/* ---------- events ---------- */
boardEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  const auditId = btn.dataset.audit;
  const act = btn.dataset.act;
  try {
    if (act === "audit") await writeTx("audit_trader", [id], 0n, "audit.requested");
    else if (act === "finalize") await writeTx("finalize_audit", [auditId], 0n, "audit.closed");
    else if (act === "challenge") {
      const reason = window.prompt(t("challenge.prompt"));
      if (!reason) { toast(t("err.challengeReason"), true); return; }
      await writeTx("challenge_audit", [auditId, reason.slice(0, 200)], CHALLENGE_WEI, "challenge.sent");
    } else if (act === "compare") {
      if (compareSet.has(id)) compareSet.delete(id); else compareSet.add(id);
      renderBoard(false);
      renderCompare();
    } else if (act === "follow") {
      if (!window.confirm(`${t("trader.stake")} — ${t("trader.follow")}?`)) return;
      await writeTx("copy_trader", [id], STAKE_WEI, "follow.done");
    }
  } catch { /* toast already shown */ }
});

$("#copiesList").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "settle") await writeTx("settle_copy", [id], 0n, "settle.done");
    else if (btn.dataset.act === "cancel") await writeTx("cancel_copy", [id], 0n, "cancel.done");
  } catch { /* toast already shown */ }
});

$("#withdrawBtn").addEventListener("click", async () => {
  try { await writeTx("withdraw_payout", [], 0n, "withdraw.done"); } catch { /* toast already shown */ }
});

$("#registerForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("#regName").value.trim();
  const code = $("#regCode").value.trim().toUpperCase();
  const evidence = $("#regEvidence").value.trim();
  if (!name || !code || !evidence) return;
  try {
    await writeTx("register_trader", [name, code, evidence], 0n, "register.done");
    ev.target.reset();
  } catch { /* toast already shown */ }
});

$("#sortSelect").addEventListener("change", (ev) => { sortKey = ev.target.value; renderBoard(true); });
$("#refreshBtn").addEventListener("click", () => refreshAll());
$("#compareClear").addEventListener("click", () => { compareSet.clear(); renderBoard(false); renderCompare(); });
$("#langToggle").addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh";
  try { localStorage.setItem("copytrade-lang", lang); } catch { /* ignore */ }
  applyI18n();
});
$("#walletBtn").addEventListener("click", () => {
  if (walletAddress && walletChainId !== CONFIG.chainId) switchNetwork();
  else connectWallet();
});
$("#tempDiscard").addEventListener("click", discardTempAccount);
$("#tempFundBtn").addEventListener("click", fundTempAccount);

/* ---------- static links + boot ---------- */
function fillLinks() {
  const contractUrl = EXPLORER_ADDRESS(CONFIG.contractAddress);
  $("#contractLink").href = contractUrl;
  $("#trustContract").href = contractUrl;
  $("#trustContract").textContent = CONFIG.contractAddress;
  $("#evidenceLink").href = CONFIG.evidenceUrl;
  $("#repoLink").href = CONFIG.repoUrl;
  $("#mechanismLink").href = CONFIG.mechanismUrl;
  $("#footerRepo").href = CONFIG.repoUrl;
  $("#footerExplorer").href = contractUrl;
}

fillLinks();
applyI18n();
refreshAll();
if (injectedProvider()) {
  injectedProvider().request({ method: "eth_accounts" }).then((accs) => {
    if (accs && accs[0]) { walletAddress = accs[0]; return injectedProvider().request({ method: "eth_chainId" }).then((c) => { walletChainId = parseInt(c, 16); renderWalletState(); refreshMyAccount(); renderCopies(); }); }
  }).catch(() => {});
}
