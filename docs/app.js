/* CopyTrade frontend: reads via genlayer-js (esm.sh), writes via an
   in-browser temporary test account that is clearly labelled and
   discarded when the tab closes. Wallet connect is for identity and
   network checks; GenLayer writes need a Snap the wallet does not
   have, so the temporary account is the honest write path. */
import { CONFIG, EXPLORER_TX, EXPLORER_ADDRESS } from "./config.js";
import { I18N } from "./i18n.js";

const $ = (sel) => document.querySelector(sel);
const boardEl = $("#leaderboard");
const toastEl = $("#txToast");

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
let myAccount = null;
let sortKey = "reputation";
const compareSet = new Set();

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
    insufficient_demo_balance: t("err.insufficient"),
    demo_funds_already_claimed: t("trader.claimed"),
    allocation_must_be_positive_multiple_of_100: t("err.allocation"),
    pnl_bps_must_be_multiple_of_100_in_range: t("err.pnl"),
    rejected_trader_cannot_be_followed: "REJECTED",
    trader_not_audited_yet: t("trader.notAudited"),
    only_verified_trader_copies_settle: "VERIFIED",
    audit_already_finalized: t("trader.statusFinalized"),
  };
  if (map[code]) return map[code];
  if (msg.includes("FINALIZED") && msg.includes("ERROR")) return t("tx.failed");
  return t("err.generic") + (msg ? ` (${msg.slice(0, 160)})` : "");
}

async function writeTx(functionName, args, successKey) {
  await loadGenlayer();
  ensureTempAccount();
  toast(t("tx.sending"));
  try {
    const hash = await writeClient.writeContract({
      address: CONFIG.contractAddress,
      functionName,
      args,
      value: 0n,
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
    const counts = await read("get_counts", []);
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
  if (!addr) { myAccount = null; $("#demoBalance").textContent = ""; return; }
  try {
    myAccount = await read("get_account", [addr]);
    const bal = myAccount ? myAccount.balance : 0;
    $("#demoBalance").textContent = `mGEN ${Number(bal).toLocaleString()} · ${t("trader.reputation")} ${myAccount ? myAccount.reputation : 100}`;
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

function buildCard(trader, rank) {
  const li = document.createElement("li");
  li.className = "trader-card";
  li.style.setProperty("--vt-name", `trader-${trader.id}`);
  const audit = latestAudit(trader.id);
  const winRate = winRateOf(trader.id);
  const totalReturn = audit && audit.round1 ? audit.round1.total_return_bps : null;
  const avatarClass = rank % 3 === 1 ? "coral" : rank % 3 === 2 ? "gold" : "";
  const auditLine = audit
    ? `<div class="audit-line">${audit.status === "FINALIZED" ? t("trader.statusFinalized") : audit.status === "CHALLENGED" ? t("trader.statusChallenged") : t("trader.statusEvaluating")} · ${audit.id} · ${audit.round1.verdict}${audit.round2 ? ` → ${audit.round2.verdict}` : ""}${audit.challenge_outcome ? ` · ${audit.challenge_outcome}` : ""}</div>`
    : "";
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
    <div class="trader-evidence"><a href="${escapeHtml(trader.evidence_ref)}" target="_blank" rel="noopener">${t("trader.evidence")}</a> · ${t("trader.copied")} ${trader.total_copied} mGEN</div>
    <div class="trader-actions">
      <button class="btn btn-small" data-act="audit" data-id="${trader.id}">${t("trader.audit")}</button>
      <button class="btn btn-small" data-act="finalize" data-id="${trader.id}" ${!audit || audit.status === "FINALIZED" ? "disabled" : ""}>${t("trader.finalize")}</button>
      <button class="btn btn-small" data-act="challenge" data-id="${trader.id}" ${!audit || audit.status !== "EVALUATING" ? "disabled" : ""}>${t("trader.challenge")}</button>
      <button class="btn btn-small" data-act="compare" data-id="${trader.id}">${compareSet.has(trader.id) ? "✓ " : ""}${t("trader.compare")}</button>
      <span class="field">
        <input type="number" min="100" step="100" value="1000" data-alloc="${trader.id}" aria-label="${t("trader.allocation")}" ${trader.verdict !== "VERIFIED" && trader.verdict !== "SUSPECT" ? "disabled" : ""}>
        <button class="btn btn-small btn-coral" data-act="follow" data-id="${trader.id}" ${trader.verdict !== "VERIFIED" && trader.verdict !== "SUSPECT" ? "disabled" : ""}>${t("trader.follow")}</button>
      </span>
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
        <dt>${t("trader.copied")}</dt><dd>${trader.total_copied} mGEN</dd>
      </dl>`;
    grid.appendChild(cell);
  });
}

/* ---------- copies ---------- */
function renderCopies() {
  const listEl = $("#copiesList");
  const addr = walletAddress || (tempAccount && tempAccount.address);
  const mine = addr ? copies.filter((c) => c.follower === addr) : [];
  $("#copiesEmpty").hidden = mine.length > 0;
  listEl.innerHTML = "";
  mine.forEach((copy) => {
    const trader = traders.find((tr) => tr.id === copy.trader_id);
    const li = document.createElement("li");
    li.className = "copy-card";
    li.innerHTML = `
      <div class="copy-head">
        <b>${escapeHtml(trader ? trader.name : copy.trader_id)}</b>
        <span class="badge ${copy.status === "SETTLED" ? "verified" : "pending"}">${copy.status === "SETTLED" ? t("copy.settled") : t("copy.open")}</span>
      </div>
      <div class="copy-numbers">
        <span>${t("trader.allocation")}: <b>${copy.allocation} mGEN</b></span>
        <span>${t("copy.effective")}: <b>${copy.effective} mGEN</b></span>
        ${copy.status === "SETTLED" ? `<span>${t("copy.pnl")}: <b>${copy.pnl} mGEN (${copy.pnl_bps} bps)</b></span><span>${t("copy.settledValue")}: <b>${copy.settled_value} mGEN</b></span>` : ""}
      </div>
      ${copy.status === "OPEN" ? `
      <div class="copy-settle">
        <input type="number" step="100" value="500" data-pnl="${copy.id}" aria-label="${t("trader.settlePnl")}">
        <button class="btn btn-small btn-solid" data-act="settle" data-id="${copy.id}">${t("trader.settle")}</button>
      </div>` : ""}`;
    listEl.appendChild(li);
  });
}

/* ---------- events ---------- */
boardEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "audit") await writeTx("audit_trader", [id], "audit.evaluating");
    else if (act === "finalize") await writeTx("finalize_audit", [id], "audit.finalized");
    else if (act === "challenge") {
      const reason = window.prompt(t("challenge.prompt"));
      if (!reason) { toast(t("err.challengeReason"), true); return; }
      await writeTx("challenge_audit", [id, reason.slice(0, 200)], "challenge.sent");
    } else if (act === "compare") {
      if (compareSet.has(id)) compareSet.delete(id); else compareSet.add(id);
      renderBoard(false);
      renderCompare();
    } else if (act === "follow") {
      const input = document.querySelector(`[data-alloc="${id}"]`);
      const allocation = Number(input ? input.value : 0);
      if (!allocation || allocation <= 0 || allocation % 100 !== 0) { toast(t("err.allocation"), true); return; }
      await writeTx("follow_trader", [id, BigInt(allocation)], "follow.done");
    }
  } catch { /* toast already shown */ }
});

$("#copiesList").addEventListener("click", async (ev) => {
  const btn = ev.target.closest('[data-act="settle"]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  const input = document.querySelector(`[data-pnl="${id}"]`);
  const pnl = Number(input ? input.value : 0);
  if (!Number.isInteger(pnl) || pnl < -10000 || pnl > 10000 || pnl % 100 !== 0) { toast(t("err.pnl"), true); return; }
  try { await writeTx("settle_copy", [id, BigInt(pnl)], "settle.done"); } catch { /* toast already shown */ }
});

$("#registerForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("#regName").value.trim();
  const code = $("#regCode").value.trim().toUpperCase();
  const evidence = $("#regEvidence").value.trim();
  if (!name || !code || !evidence) return;
  try {
    await writeTx("register_trader", [name, code, evidence], "register.done");
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

/* claim button (created in JS so it only appears once the app loads) */
const claimBtn = document.createElement("button");
claimBtn.className = "btn btn-small";
claimBtn.type = "button";
claimBtn.textContent = t("trader.claim");
claimBtn.addEventListener("click", async () => {
  try { await writeTx("claim_demo_funds", [], "claim.done"); } catch { /* toast already shown */ }
});
$("#networkStrip").appendChild(claimBtn);

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
