// ============================================================
// Minha Finança — app.js
// Painel financeiro pessoal com Firebase + IA Claude
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, query, where, getDocs, addDoc, doc, setDoc,
  updateDoc, deleteDoc, onSnapshot, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Estado global ----------
let app, auth, db, user = null, hid = null;
let TX = [], DEBTS = [], INVEST = [], BILLS = [], SETTINGS = {}, HOUSEHOLD = {};
let currentView = "dashboard";
let unsubs = [];
let chatHistory = [];
let receiptDraft = null;
let dashPeriod = "mes"; // mes | mesPassado | m3 | m6 | ano
let flowRange = "12";   // 6 | 12 | ano  (gráfico de fluxo)
let analysisPeriod = "mes"; // mes | m3 | m6 (análise de gastos)

const CATS_OUT_BASE = ["Alimentação","Mercado","Moradia","Contas (água/luz/net)","Transporte","Saúde","Educação","Lazer","Assinaturas","Vestuário","Pet","Dívidas","Impostos/Taxas","Outros"];
const CATS_IN_BASE = ["Salário/Pró-labore","Vendas","Freelance","Rendimentos","Reembolso","Outros"];
// categorias = base + personalizadas do usuário (guardadas em settings).
// "Outros" sempre por último.
function catsOut() {
  const custom = (SETTINGS.customCatsOut || []);
  return [...CATS_OUT_BASE.filter(c => c !== "Outros"), ...custom, "Outros"];
}
function catsIn() {
  const custom = (SETTINGS.customCatsIn || []);
  return [...CATS_IN_BASE.filter(c => c !== "Outros"), ...custom, "Outros"];
}
// chave da IA: preferir a compartilhada (settings); localStorage é fallback/override local
function aiKey() { return (SETTINGS.claudeKey || localStorage.getItem("mf_claude_key") || "").trim(); }
function hasAIKey() { return !!aiKey(); }

async function addCustomCat(type, name) {
  name = (name || "").trim();
  if (!name) return false;
  const key = type === "entrada" ? "customCatsIn" : "customCatsOut";
  const all = type === "entrada" ? catsIn() : catsOut();
  if (all.some(c => c.toLowerCase() === name.toLowerCase())) { toast("Essa categoria já existe."); return false; }
  const cur = SETTINGS[key] || [];
  const next = [...cur, name];
  SETTINGS[key] = next; // atualização otimista para refletir na hora
  try {
    await setDoc(doc(db, "households", hid, "meta", "settings"), { [key]: next }, { merge: true });
    toast("Categoria \"" + name + "\" criada!");
    return true;
  } catch (e) { toast("Erro: " + e.message); return false; }
}
async function removeCustomCat(type, name) {
  const key = type === "entrada" ? "customCatsIn" : "customCatsOut";
  const next = (SETTINGS[key] || []).filter(c => c !== name);
  await setDoc(doc(db, "households", hid, "meta", "settings"), { [key]: next }, { merge: true });
  toast("Categoria removida.");
}
const METHODS = ["PIX","Cartão de crédito","Cartão de débito","Dinheiro","Boleto","Transferência"];
const ESSENTIAL = new Set(["Mercado","Moradia","Contas (água/luz/net)","Transporte","Saúde","Educação","Impostos/Taxas"]);

const fmtBRL = v => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL0 = v => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const monthKey = d => d.slice(0, 7); // 'YYYY-MM'
// data LOCAL (evita bug de fuso do toISOString, que é UTC — no BR pulava o dia à noite)
const isoLocal = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };
const todayISO = () => isoLocal(new Date());
const monthLabel = mk => { const [y,m] = mk.split("-"); return ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"][+m-1] + "/" + y.slice(2); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $ = sel => document.querySelector(sel);

// ---------- Ícones (SVG inline, família única, currentColor) ----------
const ICONS = {
  wallet: '<path d="M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/><path d="M16 12h.01"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9 20v-6h6v6"/>',
  heart: '<path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-7.3a5 5 0 0 0 0-7.1Z"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  file: '<path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M9 13h6M9 17h4"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.2"/>',
  pie: '<path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M14 3.5A9 9 0 0 1 20.5 10H14Z"/>',
  'trend-down': '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 17v-4h-4"/>',
  'trend-up': '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v4h-4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  sparkles: '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8Z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5Z"/><path d="M3 13l9 5 9-5"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M15 12.5c2.8-.2 6-1.4 6-3.5"/><path d="M21 9v5c0 1.7-2.7 3-6 3-1 0-2-.1-2.8-.3"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.3 1 2.5h6c0-1.2.3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6Z"/><path d="M9 12l2 2 4-4"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2.2l2.3 12.4a1.5 1.5 0 0 0 1.5 1.2h9a1.5 1.5 0 0 0 1.5-1.2L21 7H5.3"/>',
  car: '<path d="M4 12l1.6-4.4A2 2 0 0 1 7.5 6h9a2 2 0 0 1 1.9 1.6L20 12"/><path d="M3 12h18v5H3z"/><circle cx="7" cy="17.5" r="1.3"/><circle cx="17" cy="17.5" r="1.3"/>',
  shirt: '<path d="M8 3l4 3 4-3 4 4-3 2v11H7V9L4 7Z"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
  fork: '<path d="M6 3v7a2 2 0 0 0 4 0V3"/><path d="M8 10v11"/><path d="M17 3c-1.7 0-3 2-3 5s1 4 2 4v9"/>',
  paw: '<circle cx="8" cy="9" r="1.6"/><circle cx="16" cy="9" r="1.6"/><circle cx="5.5" cy="13.5" r="1.4"/><circle cx="18.5" cy="13.5" r="1.4"/><path d="M12 13c-2.5 0-4 1.8-4 3.6C8 18.4 9.5 19 12 19s4-.6 4-2.4C16 14.8 14.5 13 12 13Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9h17M8 3v4M16 3v4"/>',
  book: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 0-2 2Z"/><path d="M5 4v16"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6Z"/>',
  alert: '<path d="M12 3l9 16H3Z"/><path d="M12 10v4M12 17h.01"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
};
const CAT_ICON = {
  "Alimentação":"fork","Mercado":"cart","Moradia":"home","Contas (água/luz/net)":"bolt","Transporte":"car",
  "Saúde":"heart","Educação":"book","Lazer":"sparkles","Assinaturas":"card","Vestuário":"shirt","Pet":"paw",
  "Dívidas":"trend-down","Impostos/Taxas":"file","Outros":"more","Dízimo":"heart"
};
function catIcon(name) { return CAT_ICON[name] || "coins"; }
function icon(name, size) {
  const s = size ? ` style="width:${size}px;height:${size}px"` : "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${s}>${ICONS[name] || ""}</svg>`;
}
function fillIcons(root) {
  (root || document).querySelectorAll("[data-ic]").forEach(el => {
    if (el.dataset.done) return;
    el.innerHTML = icon(el.dataset.ic);
    el.dataset.done = "1";
  });
}

function parseMoney(str) {
  if (typeof str === "number") return str;
  if (!str) return 0;
  str = String(str).replace(/[R$\s]/g, "");
  if (str.includes(",")) str = str.replace(/\./g, "").replace(",", ".");
  return parseFloat(str) || 0;
}

function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", ms);
}

// ---------- Boot ----------
function boot() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.apiKey === "COLE_AQUI") {
    $("#setupWarning").classList.remove("hidden");
    $("#btnLogin").disabled = true;
    return;
  }
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);

  $("#btnLogin").onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { toast("Erro no login: " + e.message); }
  };

  onAuthStateChanged(auth, async u => {
    if (u) { user = u; await enterApp(); }
    else { user = null; showLogin(); }
  });
}

function showLogin() {
  unsubs.forEach(fn => fn()); unsubs = [];
  $("#app").classList.add("hidden");
  $("#loginScreen").style.display = "flex";
}

async function enterApp() {
  // localizar (ou criar) o "lar financeiro" compartilhado
  const qh = query(collection(db, "households"), where("members", "array-contains", user.email));
  const snap = await getDocs(qh);
  if (snap.empty) {
    const ref = await addDoc(collection(db, "households"), {
      name: "Finanças de " + (user.displayName || "Casa"),
      owner: user.email, members: [user.email], createdAt: todayISO()
    });
    hid = ref.id;
  } else {
    hid = snap.docs[0].id;
  }

  $("#loginScreen").style.display = "none";
  $("#app").classList.remove("hidden");
  $("#userName").textContent = user.displayName?.split(" ")[0] || user.email;
  if (user.photoURL) $("#userPhoto").src = user.photoURL;
  $("#btnLogout").onclick = () => signOut(auth);
  $("#btnTheme").onclick = toggleTheme;
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => switchView(b.dataset.view));
  document.querySelectorAll("[data-action]").forEach(b => b.onclick = () => navAction(b.dataset.action));
  fillIcons(); // ícones estáticos da navegação

  const savedTheme = localStorage.getItem("mf_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  listen("transactions", arr => { TX = arr.sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt||"").localeCompare(a.createdAt||"")); });
  listen("debts", arr => { DEBTS = arr; });
  listen("investments", arr => { INVEST = arr.sort((a,b) => b.date.localeCompare(a.date)); });
  listen("bills", arr => { BILLS = arr.sort((a,b) => (a.dueDate||"").localeCompare(b.dueDate||"")); });
  unsubs.push(onSnapshot(doc(db, "households", hid, "meta", "settings"), s => {
    SETTINGS = s.exists() ? s.data() : {};
    render();
  }));
  unsubs.push(onSnapshot(doc(db, "households", hid), s => {
    if (s.exists()) HOUSEHOLD = s.data();
    render();
  }));
  switchView("dashboard");
}

function listen(coll, assign) {
  unsubs.push(onSnapshot(collection(db, "households", hid, coll), snap => {
    assign(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    render();
  }));
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : (cur === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark"));
  document.documentElement.dataset.theme = next;
  localStorage.setItem("mf_theme", next);
}

function switchView(v) {
  currentView = v;
  document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  render();
  window.scrollTo({ top: 0 });
}

// ---------- Cálculos ----------
function monthTotals(mk) {
  let ins = 0, outs = 0;
  for (const t of TX) if (monthKey(t.date) === mk) {
    if (t.type === "entrada") ins += t.amount; else outs += t.amount;
  }
  return { ins, outs };
}
function lastMonths(n) {
  const arr = []; const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    arr.push(x.toISOString().slice(0, 7));
  }
  return arr;
}
function avgIncome() {
  const mks = lastMonths(3);
  const vals = mks.map(mk => monthTotals(mk).ins).filter(v => v > 0);
  if (!vals.length) return SETTINGS.incomeTarget || 17500;
  return vals.reduce((a,b)=>a+b,0) / vals.length;
}
function avgEssentials() {
  const mks = lastMonths(3);
  let tot = 0, months = 0;
  for (const mk of mks) {
    let m = 0;
    for (const t of TX) if (t.type === "saida" && monthKey(t.date) === mk && ESSENTIAL.has(t.category)) m += t.amount;
    if (m > 0) { tot += m; months++; }
  }
  return months ? tot / months : 0;
}
function debtTotals() {
  let open = 0, monthly = 0;
  for (const d of DEBTS) if (d.status !== "quitada") {
    open += (d.currentValue ?? d.total) - (d.paid || 0);
    monthly += d.monthlyPayment || 0;
  }
  return { open: Math.max(open, 0), monthly };
}
function investedTotal() {
  return INVEST.reduce((a, i) => a + (i.type === "resgate" ? -i.amount : i.amount), 0);
}
const INV_REND = new Set(["rendimento", "dividendo"]);
function investStats() {
  let aportes = 0, resgates = 0, rend = 0;
  for (const i of INVEST) {
    if (i.type === "resgate") resgates += i.amount;
    else if (INV_REND.has(i.type)) rend += i.amount;
    else aportes += i.amount;
  }
  const patrimonio = aportes - resgates + rend;
  const base = aportes - resgates;
  const rentPct = base > 0 ? rend / base * 100 : 0;
  return { aportes, resgates, rend, patrimonio, base, rentPct };
}
function investAllocation() {
  const map = {};
  for (const i of INVEST) map[i.assetType || "Outros"] = (map[i.assetType || "Outros"] || 0) + (i.type === "resgate" ? -i.amount : i.amount);
  return Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}
// séries cumulativas (patrimônio, aportes, rendimento) por mês
function investSeries(months) {
  return months.map(mk => {
    let aportes = 0, resg = 0, rend = 0;
    for (const i of INVEST) if (monthKey(i.date) <= mk) {
      if (i.type === "resgate") resg += i.amount;
      else if (INV_REND.has(i.type)) rend += i.amount;
      else aportes += i.amount;
    }
    return { mk, aportes: aportes - resg, rend, patrimonio: aportes - resg + rend };
  });
}
function investStreak() {
  // meses consecutivos (terminando no atual ou anterior) com aporte
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 60; i++) {
    const mk = new Date(now.getFullYear(), now.getMonth() - i, 1).toISOString().slice(0, 7);
    const has = INVEST.some(x => monthKey(x.date) === mk && x.type === "aporte");
    if (has) streak++;
    else if (i > 0) break; // permite o mês atual ainda sem aporte
  }
  return streak;
}
function catSpend(mk) {
  const map = {};
  for (const t of TX) if (t.type === "saida" && monthKey(t.date) === mk)
    map[t.category] = (map[t.category] || 0) + t.amount;
  return Object.entries(map).sort((a,b) => b[1]-a[1]);
}

// Plano milionário
function planCalc() {
  const goal = SETTINGS.goalAmount || 1000000;
  const startDate = SETTINGS.goalStart || todayISO();
  const years = SETTINGS.goalYears || 5;
  const rate = (SETTINGS.expReturn ?? 0.8) / 100; // % ao mês
  const start = new Date(startDate);
  const end = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
  const now = new Date();
  const monthsTotal = years * 12;
  const monthsLeft = Math.max(1, Math.round((end - now) / (30.44 * 864e5)));
  const current = investedTotal();
  // FV = PV(1+r)^n + PMT[((1+r)^n -1)/r]  → PMT necessário
  const fvPV = current * Math.pow(1 + rate, monthsLeft);
  const pmt = rate > 0
    ? Math.max(0, (goal - fvPV) * rate / (Math.pow(1 + rate, monthsLeft) - 1))
    : Math.max(0, (goal - current) / monthsLeft);
  const pct = Math.min(100, current / goal * 100);
  return { goal, current, pct, pmt, monthsLeft, monthsTotal, rate, end };
}

// ---------- Score de saúde financeira (transparente, item 35) ----------
function avgSavingsRate() {
  const mks = lastMonths(3);
  const rates = mks.map(mk => { const t = monthTotals(mk); return t.ins > 0 ? (t.ins - t.outs) / t.ins : null; }).filter(r => r != null);
  return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
}
function financialScore() {
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const parts = [];
  // 1) Economia (25) — média de 3 meses vs meta
  const goalPct = (SETTINGS.savingsGoalPct ?? 30) / 100;
  const sr = avgSavingsRate();
  if (sr == null) parts.push({ key: "economia", label: "Economia", max: 25, score: 0, na: true, detail: "sem histórico de receita" });
  else { const s = clamp(sr / goalPct) * 25; parts.push({ key: "economia", label: "Economia", max: 25, score: s, detail: `guarda ${(sr*100).toFixed(0)}% da renda (meta ${(goalPct*100).toFixed(0)}%)` }); }
  // 2) Controle de orçamento (20)
  const mk = todayISO().slice(0, 7), spent = Object.fromEntries(catSpend(mk)), budgets = getBudgets();
  if (!budgets.length) parts.push({ key: "orcamento", label: "Controle de gastos", max: 20, score: 12, detail: "defina limites p/ avaliar", soft: true });
  else { const dentro = budgets.filter(([c, l]) => (spent[c] || 0) <= l).length; const s = dentro / budgets.length * 20; parts.push({ key: "orcamento", label: "Controle de gastos", max: 20, score: s, detail: `${dentro}/${budgets.length} categorias dentro do limite` }); }
  // 3) Dívidas (20) — comprometimento da renda
  const renda = avgIncome(), dt = debtTotals();
  const ratio = renda > 0 ? dt.monthly / renda : 0;
  const s3 = dt.monthly === 0 ? 20 : clamp(1 - ratio / 0.4) * 20;
  parts.push({ key: "dividas", label: "Dívidas sob controle", max: 20, score: s3, detail: dt.monthly === 0 ? "sem parcelas mensais" : `${(ratio*100).toFixed(0)}% da renda em parcelas` });
  // 4) Investimentos (20) — aporte do mês vs plano
  const plan = planCalc(), invMes = investedInMonths([mk]);
  const s4 = plan.pmt > 0 ? clamp(invMes / plan.pmt) * 20 : (investedTotal() > 0 ? 16 : 0);
  parts.push({ key: "invest", label: "Investindo", max: 20, score: s4, detail: plan.pmt > 0 ? `${fmtBRL0(invMes)} de ${fmtBRL0(plan.pmt)} no mês` : (investedTotal() > 0 ? "carteira iniciada" : "nenhum aporte ainda") });
  // 5) Contas em dia (15)
  const overdue = pendingBills().filter(b => b.dueDate && b.dueDate < todayISO()).length;
  const s5 = overdue === 0 ? 15 : clamp(1 - overdue / 3) * 15;
  parts.push({ key: "contas", label: "Contas em dia", max: 15, score: s5, detail: overdue === 0 ? "nada vencido" : `${overdue} conta(s) vencida(s)` });
  const total = Math.round(parts.reduce((a, p) => a + p.score, 0));
  const band = total >= 80 ? { lbl: "Excelente", cls: "good" } : total >= 60 ? { lbl: "Boa", cls: "good" } : total >= 40 ? { lbl: "Atenção", cls: "warn" } : { lbl: "Crítica", cls: "crit" };
  parts.forEach(p => { const r = p.score / p.max; p.level = p.na ? "flat" : r >= 0.7 ? "good" : r >= 0.4 ? "warn" : "crit"; });
  return { total, band, parts };
}
function scoreColor(band) { return band.cls === "good" ? "var(--good-text)" : band.cls === "warn" ? "var(--warning)" : "var(--critical)"; }

// ---------- Insights automáticos (dirigidos a dados) ----------
function generateInsights() {
  const out = [];
  const mk = todayISO().slice(0, 7), prevMk = lastMonths(2)[0];
  const cur = monthTotals(mk), prev = monthTotals(prevMk);
  // categoria acima da média dos últimos 3 meses
  const cats = catSpend(mk);
  for (const [c, v] of cats.slice(0, 6)) {
    const mks3 = lastMonths(4).slice(0, 3);
    const hist = mks3.map(m => { let s = 0; for (const t of TX) if (t.type === "saida" && monthKey(t.date) === m && t.category === c) s += t.amount; return s; }).filter(x => x > 0);
    if (hist.length >= 2) { const avg = hist.reduce((a, b) => a + b, 0) / hist.length; if (v > avg * 1.15) { out.push({ icon: "trend-up", title: `${c} acima da média`, detail: `${fmtBRL0(v)} neste mês — ${((v/avg-1)*100).toFixed(0)}% acima da média dos últimos meses`, goto: "transacoes" }); break; } }
  }
  // taxa de economia
  const sr = cur.ins > 0 ? (cur.ins - cur.outs) / cur.ins * 100 : null;
  const goalPct = SETTINGS.savingsGoalPct ?? 30;
  if (sr != null) { if (sr >= goalPct) out.push({ icon: "shield", title: "Economia no alvo", detail: `Você guardou ${sr.toFixed(0)}% da renda este mês (meta ${goalPct}%)`, goto: "orcamento" }); else if (sr < 10) out.push({ icon: "activity", title: "Economia baixa", detail: `Só ${sr.toFixed(0)}% da renda sobrou este mês — revise os maiores gastos`, goto: "orcamento" }); }
  // dívida cara
  const caras = DEBTS.filter(d => d.status !== "quitada" && (d.interest || 0) >= 8).sort((a, b) => (b.interest||0) - (a.interest||0));
  if (caras.length) out.push({ icon: "trend-down", title: "Dívida cara para priorizar", detail: `${caras[0].name}: ${caras[0].interest}% a.m. — quitar isso rende mais que investir`, goto: "dividas" });
  // gastos caíram
  if (prev.outs > 0 && cur.outs < prev.outs * 0.9 && new Date().getDate() >= 20) out.push({ icon: "shield", title: "Gastos em queda", detail: `Despesas ${((1-cur.outs/prev.outs)*100).toFixed(0)}% menores que ${monthLabel(prevMk)}. Continue assim!`, goto: "dashboard" });
  return out.slice(0, 4);
}

// ---------- Render principal ----------
function render() {
  const el = $("#mainContent");
  if (!el) return;
  const views = {
    dashboard: viewDashboard, saude: viewSaude, transacoes: viewTransacoes, comprovante: viewComprovante,
    dividas: viewDividas, boletos: viewBoletos, orcamento: viewOrcamento, investimentos: viewInvest,
    plano: viewPlano, consultor: viewConsultor, config: viewConfig
  };
  el.innerHTML = (views[currentView] || viewDashboard)();
  attachHandlers();
  fillIcons(el);
}

// ============================================================
// VIEW: DASHBOARD
// ============================================================
// ---------- Período global do dashboard ----------
const PERIODS = [["mes","Este mês"],["mesPassado","Mês passado"],["m3","3 meses"],["m6","6 meses"],["ano","Este ano"]];
function periodMonths(p) {
  const now = new Date(), cur = now.toISOString().slice(0, 7);
  if (p === "mes") return [todayISO().slice(0, 7)];
  if (p === "mesPassado") return [lastMonths(2)[0]];
  if (p === "m3") return lastMonths(3);
  if (p === "m6") return lastMonths(6);
  if (p === "ano") { const a = []; for (let m = 0; m <= now.getMonth(); m++) a.push(`${now.getFullYear()}-${String(m+1).padStart(2,"0")}`); return a; }
  return [cur];
}
function prevPeriodMonths(p) {
  const cur = periodMonths(p);
  const n = cur.length;
  const first = cur[0] + "-01";
  const out = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(first); d.setMonth(d.getMonth() - i);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
function sumMonths(mks) {
  return mks.reduce((a, mk) => { const t = monthTotals(mk); a.ins += t.ins; a.outs += t.outs; return a; }, { ins: 0, outs: 0 });
}
function catSpendMonths(mks) {
  const map = {};
  for (const t of TX) if (t.type === "saida" && mks.includes(monthKey(t.date))) map[t.category] = (map[t.category] || 0) + t.amount;
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
function investedInMonths(mks) {
  return INVEST.filter(i => mks.includes(monthKey(i.date)) && i.type !== "resgate").reduce((a, i) => a + i.amount, 0);
}
function periodLabel(p) { return (PERIODS.find(x => x[0] === p) || [])[1] || "período"; }

// delta com tratamento de base zero / primeiro período (item 9)
function deltaCtx(cur, prev, { goodDown = false, light = false } = {}) {
  const muted = light ? 'style="opacity:.8"' : 'class="muted"';
  if (prev === 0 || prev == null) {
    if (!cur) return { html: `<span ${light ? 'style="opacity:.85"' : 'class="trend flat"'}>—</span>` };
    return { html: `<span ${light ? 'style="opacity:.85"' : 'class="trend flat"'}>sem base anterior</span>` };
  }
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const isGood = goodDown ? pct <= 0 : pct >= 0;
  const arrow = pct > 0.5 ? "↑" : pct < -0.5 ? "↓" : "→";
  const cls = Math.abs(pct) < 0.5 ? "flat" : (isGood ? "pos" : "neg");
  const col = light ? (cls === "pos" ? "#b6f0c0" : cls === "neg" ? "#ffc9c9" : "rgba(255,255,255,.85)") : "";
  const trend = light ? `<span style="color:${col}; font-weight:600">${arrow} ${Math.abs(pct).toFixed(1).replace(".", ",")}%</span>`
    : `<span class="trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1).replace(".", ",")}%</span>`;
  return { html: `${trend} <span ${muted}>vs período anterior</span>`, pct };
}
function sparkline(vals, accent = "var(--s2)") {
  if (!vals.length || Math.max(...vals) === 0) return "";
  const W = 120, H = 30, max = Math.max(...vals, 1), n = vals.length;
  const x = i => n === 1 ? W / 2 : i / (n - 1) * W;
  const y = v => H - 3 - v / max * (H - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const path = "M" + pts.join(" L");
  const area = path + ` L${W},${H} L0,${H} Z`;
  return `<svg class="k-spark" viewBox="0 0 ${W} ${H}" width="120" height="30" aria-hidden="true">
    <path d="${area}" fill="${accent}" opacity=".10"/>
    <path d="${path}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(n-1).toFixed(1)}" cy="${y(vals[n-1]).toFixed(1)}" r="2.6" fill="${accent}"/></svg>`;
}

function viewDashboard() {
  const p = dashPeriod;
  const mks = periodMonths(p), prevMks = prevPeriodMonths(p);
  const cur = sumMonths(mks), prev = sumMonths(prevMks);
  const saldo = cur.ins - cur.outs, prevSaldo = prev.ins - prev.outs;
  const savings = cur.ins > 0 ? (cur.ins - cur.outs) / cur.ins * 100 : null;
  const invPer = investedInMonths(mks), prevInv = investedInMonths(prevMks);
  const plan = planCalc();
  const u = upcoming(15), f = forecast();
  const alerts = buildAlerts();
  const sc = financialScore();
  const nome = (user?.displayName || "").split(" ")[0] || "";
  const savingsGoal = SETTINGS.savingsGoalPct ?? 30;
  const sparkOut = lastMonths(7).map(m => monthTotals(m).outs);
  const dsel = (id, opts, val) => `<select class="mini" data-sel="${id}">${opts.map(([k, l]) => `<option value="${k}" ${val === k ? "selected" : ""}>${l}</option>`).join("")}</select>`;

  return `
  <div class="dash-head">
    <div><h2>Olá${nome ? ", " + esc(nome) : ""} 👋</h2>
      <div class="hello">Sua vida financeira — ${periodLabel(p).toLowerCase()}</div></div>
    <div class="dash-tools">
      <div class="seg scroll" id="periodSel">
        ${PERIODS.map(([k, lbl]) => `<button data-period="${k}" class="${p === k ? "active" : ""}">${lbl}</button>`).join("")}
      </div>
      <button class="btn" id="btnQuickAdd">+ Lançar</button>
    </div>
  </div>

  <!-- Linha 1: hero + KPIs -->
  <div class="hero-grid">
    <div class="home-hero">
      <div class="hh-ico">${icon("activity", 20)}</div>
      <div class="hh-label">Resultado ${mks.length > 1 ? "do período" : "do mês"} <span title="Recebido menos gasto no período selecionado." style="opacity:.8; cursor:help">ⓘ</span></div>
      <div class="hh-val">${fmtBRL(saldo)}</div>
      <div class="hh-delta">${deltaCtx(saldo, prevSaldo, { plain: true, light: true }).html}</div>
      <div class="hh-bg">${heroBg()}</div>
    </div>
    <div class="kpi-card">
      <div class="badge-ic g">${icon("trend-down")}</div>
      <div class="kc-label">Recebido</div>
      <div class="kc-val">${fmtBRL(cur.ins)}</div>
      <div class="kc-ctx">${cur.ins ? deltaCtx(cur.ins, prev.ins).html : "—"}</div>
    </div>
    <div class="kpi-card">
      <div class="badge-ic r">${icon("trend-up")}</div>
      <div class="kc-label">Gasto</div>
      <div class="kc-val">${fmtBRL(cur.outs)}</div>
      <div class="kc-ctx">${deltaCtx(cur.outs, prev.outs, { goodDown: true }).html}</div>
      <div class="kc-spark">${sparkline(sparkOut, "var(--s2)")}</div>
    </div>
    <div class="kpi-card">
      <div class="badge-ic b">${icon("pie")}</div>
      <div class="kc-label">Taxa de economia</div>
      <div class="kc-val">${savings == null ? "—" : savings.toFixed(0) + "%"}</div>
      <div class="kc-ctx">${savings == null ? "sem receita no período" : `meta ${savingsGoal}% ${savings >= savingsGoal ? '· <span class="trend pos">✓ batida</span>' : ""}`}</div>
    </div>
  </div>

  <!-- Linha 2: a vencer / investido / projetado / alertas -->
  <div class="row4">
    <div class="kpi-card">
      <div class="badge-ic b">${icon("file")}</div>
      <div class="kc-label">A vencer (15 dias)</div>
      <div class="kc-val">${fmtBRL0(u.total)}</div>
      <div class="kc-ctx">${u.count ? u.count + " conta(s)" : "nada a vencer"}</div>
    </div>
    <div class="kpi-card">
      <div class="badge-ic v">${icon("trend-up")}</div>
      <div class="kc-label">Investido no período</div>
      <div class="kc-val">${fmtBRL0(invPer)}</div>
      <div class="kc-ctx">${p === "mes" ? "meta de aporte: " + fmtBRL0(plan.pmt) : deltaCtx(invPer, prevInv).html}</div>
    </div>
    <div class="kpi-card">
      <div class="badge-ic g">${icon("wallet")}</div>
      <div class="kc-label">Saldo projetado</div>
      <div class="kc-val" style="color:${f.saldo >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL0(f.saldo)}</div>
      <div class="kc-ctx">estimativa até o fim do mês</div>
    </div>
    <div class="alert-card">
      ${alerts.length ? alerts.slice(0, 2).map(miniAlertHTML).join("") :
        `<div class="mini-alert pos"><span class="ma-ic">${icon("shield")}</span><div class="ma-b"><div class="ma-t">Tudo em ordem</div><div class="ma-d">Nenhum alerta no momento</div></div></div>`}
    </div>
  </div>

  <!-- Linha 3: fluxo / análise / saúde -->
  <div class="panel-3">
    <div class="panel">
      <div class="panel-head"><h3>Fluxo financeiro</h3>
        ${dsel("flow", [["6", "Últimos 6 meses"], ["12", "Últimos 12 meses"], ["ano", "Este ano"]], flowRange)}</div>
      <div class="legend">
        <span class="key"><span class="swatch" style="background:var(--good)"></span>Entradas</span>
        <span class="key"><span class="swatch" style="background:var(--critical)"></span>Saídas</span>
        <span class="key"><span class="swatch" style="background:var(--s1); border-radius:50%; width:9px; height:9px"></span>Saldo</span>
      </div>
      ${chartFlowDiverging(flowMonths())}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Análise de gastos</h3>
        ${dsel("analysis", [["mes", "Este mês"], ["m3", "3 meses"], ["m6", "6 meses"]], analysisPeriod)}</div>
      ${donutBlock(periodMonths(analysisPeriod))}
      <button class="panel-link" data-goto="orcamento">Ver todas as categorias →</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Saúde financeira</h3></div>
      <div class="semi-wrap">
        ${semiGauge(sc.total, sc.band)}
        <span class="semi-pill" style="background:${scoreColor(sc.band)}22; color:${scoreColor(sc.band)}">${sc.band.lbl}</span>
        <div class="muted" style="margin-top:6px; font-size:13px">${sc.total >= 60 ? "Você está no caminho certo." : sc.total >= 40 ? "Seu resultado precisa de ajustes." : "Seu resultado está abaixo do ideal."}</div>
        <div class="muted" style="font-size:12px">${(() => { const i = generateInsights()[0]; return i ? esc(i.title) : "Registre transações para gerar insights"; })()}</div>
        <button class="panel-link" data-goto="saude">Ver detalhes da saúde →</button>
      </div>
    </div>
  </div>

  <div class="tip-banner">
    <div class="tb-ic">${icon("shield")}</div>
    <div class="tb-b"><div class="tb-t">${tipOfDay().t}</div><div class="tb-d">${tipOfDay().d}</div></div>
    <button class="btn" data-goto="${tipOfDay().goto}">${tipOfDay().cta}</button>
  </div>`;
}

function flowMonths() {
  if (flowRange === "6") return lastMonths(6);
  if (flowRange === "12") return lastMonths(12);
  return periodMonths("ano");
}
function tipOfDay() {
  const dt = debtTotals();
  if (dt.open > 0) return { t: "Foco em quitar dívidas", d: "Você tem dívidas em aberto. Use a aba Dívidas para negociar e montar acordos.", cta: "Ver dívidas", goto: "dividas" };
  if (!getBudgets().length) return { t: "Defina seus limites", d: "Configure um orçamento por categoria para acompanhar seus gastos.", cta: "Criar orçamento", goto: "orcamento" };
  return { t: "Dica do dia", d: "Registre seus gastos assim que acontecem — fotografe o comprovante e a IA lança pra você.", cta: "Ler comprovante", goto: "comprovante" };
}
function miniAlertHTML(a) {
  return `<button class="mini-alert ${a.level}" data-goto="${a.goto}">
    <span class="ma-ic">${icon(a.level === "pos" ? "shield" : a.level === "info" ? "activity" : "file")}</span>
    <div class="ma-b"><div class="ma-t">${esc(a.title)}</div><div class="ma-d">${esc(a.desc)}</div></div>
    <span class="ma-chev">${icon("more", 16)}</span></button>`;
}

// ---- Fundo do hero (linha de saldo, 12 meses) ----
function heroBg() {
  const vals = lastMonths(12).map(m => { const t = monthTotals(m); return t.ins - t.outs; });
  const W = 520, H = 70, min = Math.min(...vals, 0), max = Math.max(...vals, 1), rng = (max - min) || 1;
  const x = i => i / (vals.length - 1) * W, y = v => H - 6 - (v - min) / rng * (H - 12);
  const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}">
    <path d="${line} L${W},${H} L0,${H} Z" fill="#fff" opacity=".15"/>
    <path d="${line}" fill="none" stroke="#fff" stroke-width="2"/></svg>`;
}

// ---- Rosca (donut) de gastos por categoria ----
function polar(cx, cy, r, deg) { const a = deg * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function donutBlock(mks) {
  const all = catSpendMonths(mks);
  const total = all.reduce((a, [, v]) => a + v, 0);
  if (!total) return `<div class="empty" style="padding:30px 10px"><span class="big">🍃</span>Nenhum gasto no período.</div>`;
  const top = all.slice(0, 5), restV = all.slice(5).reduce((a, [, v]) => a + v, 0);
  const items = restV > 0 ? [...top, ["Outros", restV]] : top;
  const cols = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s7)", "var(--s5)", "var(--s4)"];
  const cx = 80, cy = 80, R = 72, r = 46; let a0 = -90, paths = "";
  items.forEach(([, v], i) => {
    const a1 = a0 + v / total * 360;
    const large = (a1 - a0) > 180 ? 1 : 0;
    const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
    const [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
    paths += `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} A${r} ${r} 0 ${large} 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${cols[i % cols.length]}" stroke="var(--surface-1)" stroke-width="2.5"/>`;
    a0 = a1;
  });
  const donut = `<svg viewBox="0 0 160 160" width="160" height="160" style="flex-shrink:0">${paths}
    <text x="80" y="74" text-anchor="middle" font-size="10" fill="var(--ink-3)">Total gasto</text>
    <text x="80" y="90" text-anchor="middle" font-size="14" font-weight="700" fill="var(--ink-1)">${fmtBRL0(total)}</text>
    <text x="80" y="104" text-anchor="middle" font-size="10" fill="var(--ink-3)">100%</text></svg>`;
  const legend = `<div class="donut-legend">${items.map(([c, v], i) => `
    <button class="dl-row cat-row" data-cat-detail="${esc(c)}" style="display:grid">
      <span class="dl-dot" style="background:${cols[i % cols.length]}"></span>
      <span style="text-align:left">${esc(c)}</span>
      <span class="dl-val">${fmtBRL0(v)}</span>
      <span class="dl-pct">${(v / total * 100).toFixed(1)}%</span>
    </button>`).join("")}</div>`;
  return `<div class="flex" style="gap:16px; align-items:center; flex-wrap:wrap; justify-content:center">${donut}${legend}</div>`;
}

// ---- Gauge semicircular (score de saúde) ----
function semiArc(cx, cy, R, a0, a1, color, w) {
  const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}
function semiGauge(score, band) {
  const cx = 90, cy = 96, R = 74, col = scoreColor(band);
  const end = 180 + 180 * Math.max(0, Math.min(100, score)) / 100;
  return `<svg viewBox="0 0 180 118" width="180" height="118">
    ${semiArc(cx, cy, R, 180, 360, "var(--grid)", 13)}
    ${semiArc(cx, cy, R, 180, end, col, 13)}
    <text x="90" y="86" text-anchor="middle" font-size="34" font-weight="700" fill="${col}">${score}</text>
    <text x="90" y="104" text-anchor="middle" font-size="11" fill="var(--ink-3)">de 100</text></svg>`;
}

function dashScoreCard() {
  const sc = financialScore();
  const col = scoreColor(sc.band);
  const ins = generateInsights()[0];
  return `<div class="card section-gap">
    <div class="gauge-wrap">
      ${gaugeSVG(sc.total, sc.band)}
      <div class="score-bars">
        <div class="flex spread" style="margin-bottom:6px">
          <div><h3 style="display:inline">Saúde financeira</h3> <span class="pill" style="background:${col}22; color:${col}; margin-left:6px">${sc.band.lbl}</span></div>
          <button class="btn secondary small" data-goto="saude">Ver detalhes →</button>
        </div>
        ${ins ? `<div class="insight" style="border:none; padding:6px 0; background:none"><span class="i-ic">${icon(ins.icon)}</span>
          <div class="i-body"><div class="i-t"><b>${esc(ins.title)}</b></div><div class="i-d">${esc(ins.detail)}</div></div></div>`
          : `<div class="muted">Registre transações para gerar insights.</div>`}
      </div>
    </div>
  </div>`;
}

// ---- A vencer / previsão / alertas ----
function upcoming(days) {
  const today = todayISO();
  const lim = new Date(); lim.setDate(lim.getDate() + days);
  const limISO = isoLocal(lim);
  const list = pendingBills().filter(b => b.dueDate && b.dueDate <= limISO);
  return { list, count: list.length, total: list.reduce((a, b) => a + b.amount, 0) };
}
function forecast() {
  const mk = todayISO().slice(0, 7);
  const t = monthTotals(mk);
  const target = SETTINGS.incomeTarget || avgIncome();
  const receitaEsperada = Math.max(0, target - t.ins);         // o que ainda deve entrar
  const receitaPrevista = t.ins + receitaEsperada;
  const hoje = todayISO();
  const aVencerNoMes = pendingBills().filter(b => b.dueDate && monthKey(b.dueDate) === mk && b.dueDate >= hoje)
    .reduce((a, b) => a + b.amount, 0);
  const gastosPrevistos = t.outs + aVencerNoMes;
  return { receitaRecebida: t.ins, receitaEsperada, receitaPrevista, gastosRealizados: t.outs, aVencerNoMes, gastosPrevistos, saldo: receitaPrevista - gastosPrevistos };
}
function forecastBlock() {
  const f = forecast();
  return `<div class="card section-gap">
    <div class="flex spread" style="margin-bottom:10px"><h3>Previsão do mês</h3>
      <span class="muted">estimativa</span></div>
    <div class="forecast-row">
      <div class="fc"><div class="fc-l">Receita prevista</div><div class="fc-v">${fmtBRL0(f.receitaPrevista)}</div>
        <div class="muted" style="font-size:12px; margin-top:2px">${fmtBRL0(f.receitaRecebida)} recebidos${f.receitaEsperada > 0 ? " + " + fmtBRL0(f.receitaEsperada) + " esperados" : ""}</div></div>
      <div class="fc"><div class="fc-l">Gastos previstos</div><div class="fc-v">${fmtBRL0(f.gastosPrevistos)}</div>
        <div class="muted" style="font-size:12px; margin-top:2px">${fmtBRL0(f.gastosRealizados)} gastos${f.aVencerNoMes > 0 ? " + " + fmtBRL0(f.aVencerNoMes) + " a vencer" : ""}</div></div>
      <div class="fc" style="border-color:${f.saldo >= 0 ? "var(--good)" : "var(--critical)"}">
        <div class="fc-l">Saldo projetado</div>
        <div class="fc-v" style="color:${f.saldo >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL0(f.saldo)}</div>
        <div class="muted" style="font-size:12px; margin-top:2px">projeção até o fim do mês</div></div>
    </div>
  </div>`;
}
function buildAlerts() {
  const out = [];
  const today = todayISO();
  // CRÍTICO: contas vencidas
  const overdue = pendingBills().filter(b => b.dueDate && b.dueDate < today);
  if (overdue.length) out.push({ level: "crit", ico: "!", title: `${overdue.length} conta(s) vencida(s)`,
    desc: `${fmtBRL(overdue.reduce((a, b) => a + b.amount, 0))} em atraso — o mais antigo venceu ${overdue[0].dueDate.split("-").reverse().slice(0,2).join("/")}`, goto: "boletos", act: "Ver" });
  // ALERTA: orçamento estourado / perto do limite
  const mk = today.slice(0, 7), spent = Object.fromEntries(catSpend(mk));
  const budgets = getBudgets();
  const estourou = budgets.filter(([c, l]) => (spent[c] || 0) > l).sort((a, b) => (spent[b[0]] - b[1]) - (spent[a[0]] - a[1]));
  const perto = budgets.filter(([c, l]) => (spent[c] || 0) <= l && (spent[c] || 0) / l >= 0.85);
  if (estourou.length) { const [c, l] = estourou[0]; out.push({ level: "warn", ico: "!", title: `Orçamento estourado: ${c}`,
    desc: `${fmtBRL(spent[c])} de ${fmtBRL(l)} (${((spent[c]/l-1)*100).toFixed(0)}% acima)${estourou.length>1?` · +${estourou.length-1} categoria(s)`:""}`, goto: "orcamento", act: "Ver" }); }
  else if (perto.length) { const [c, l] = perto[0]; out.push({ level: "warn", ico: "!", title: `Orçamento perto do limite: ${c}`,
    desc: `${fmtBRL(spent[c])} de ${fmtBRL(l)} (${(spent[c]/l*100).toFixed(0)}%)`, goto: "orcamento", act: "Ver" }); }
  // ATENÇÃO: aporte abaixo do planejado
  const plan = planCalc(), invMes = investedInMonths([mk]);
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth >= 20 && plan.pmt > 0 && invMes < plan.pmt * 0.9) out.push({ level: "info", ico: "i", title: "Aporte abaixo do planejado",
    desc: `${fmtBRL0(invMes)} investidos de ${fmtBRL0(plan.pmt)} planejados neste mês`, goto: "investimentos", act: "Revisar" });
  // POSITIVO: gastos caíram vs mês anterior
  const prevMk = lastMonths(2)[0], out0 = monthTotals(mk).outs, prevOut = monthTotals(prevMk).outs;
  if (prevOut > 0 && out0 < prevOut * 0.9 && new Date().getDate() >= 25) out.push({ level: "pos", ico: "✓", title: "Gastos em queda",
    desc: `Despesas ${((1 - out0 / prevOut) * 100).toFixed(0)}% menores que ${monthLabel(prevMk)}`, goto: "transacoes", act: "Ver" });
  const order = { crit: 0, warn: 1, info: 2, pos: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]).slice(0, 4);
}
function alertHTML(a) {
  return `<div class="alert-item ${a.level}">
    <div class="a-ico" aria-hidden="true"><b>${a.ico}</b></div>
    <div class="a-body"><div class="a-title">${esc(a.title)}</div><div class="a-desc">${esc(a.desc)}</div></div>
    <button class="btn secondary small a-act" data-goto="${a.goto}">${esc(a.act)}</button>
  </div>`;
}

// ---- Gráfico de fluxo: barras entradas/saídas + linha de saldo (SVG) ----
// ---- Fluxo divergente: entradas ↑ (verde), saídas ↓ (vermelho), linha de saldo ----
function chartFlowDiverging(mks) {
  const data = mks.map(mk => { const t = monthTotals(mk); return { mk, ins: t.ins, outs: t.outs, saldo: t.ins - t.outs }; });
  const n = data.length;
  const maxAbs = Math.max(1, ...data.flatMap(d => [d.ins, d.outs, Math.abs(d.saldo)]));
  const step = niceStep(maxAbs);
  const W = 620, H = 300, padL = 44, padB = 24, padT = 10, padR = 6;
  const plotH = H - padB - padT, cy = padT + plotH / 2;
  const half = plotH / 2;
  const bandW = (W - padL - padR) / n;
  const barW = Math.min(16, bandW * 0.4);
  const y = v => cy - v / maxAbs * half;
  const curMK = todayISO().slice(0, 7);
  let grid = "";
  for (let g = step; g <= maxAbs; g += step) {
    for (const s of [1, -1]) grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(g*s)}" y2="${y(g*s)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y(g*s)+3}" font-size="9.5" fill="var(--ink-3)" text-anchor="end">${(s<0?"-":"")+compact(g)}</text>`;
  }
  let bars = "", pts = [];
  data.forEach((d, i) => {
    const cx = padL + bandW * i + bandW / 2;
    if (d.ins > 0) bars += barSeg(cx - barW / 2, y(d.ins), barW, cy - y(d.ins), "var(--good)", `${monthLabel(d.mk)}|Entradas|${d.ins}`, "top");
    if (d.outs > 0) bars += barSeg(cx - barW / 2, cy, barW, y(-d.outs) - cy, "var(--critical)", `${monthLabel(d.mk)}|Saídas|${d.outs}`, "bot");
    const lbl = d.mk.slice(5) === curMK.slice(5) && d.mk === curMK;
    bars += `<text x="${cx}" y="${H - 7}" font-size="10" fill="var(--ink-3)" text-anchor="middle" ${lbl ? 'font-weight="700"' : ''}>${["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"][+d.mk.split("-")[1]-1]}</text>`;
    pts.push([cx, y(d.saldo)]);
  });
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--s1)" stroke="var(--surface-1)" stroke-width="1.5" class="has-tip" data-tip="${monthLabel(data[i].mk)}|Saldo|${data[i].saldo}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto" role="img" aria-label="Fluxo de entradas, saídas e saldo">
    ${grid}
    <line x1="${padL}" x2="${W - padR}" y1="${cy}" y2="${cy}" stroke="var(--baseline)" stroke-width="1.5"/>
    ${bars}
    <path d="${line}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}</svg>`;
}
function barSeg(x, y, w, h, fill, tip, side) {
  if (h <= 0.5) return "";
  const r = Math.min(3, h);
  if (side === "top") return `<path d="M${x},${y+h} L${x},${y+r} Q${x},${y} ${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h} Z" fill="${fill}" class="has-tip" data-tip="${tip}"/>`;
  return `<path d="M${x},${y} L${x+w},${y} L${x+w},${y+h-r} Q${x+w},${y+h} ${x+w-r},${y+h} L${x+r},${y+h} Q${x},${y+h} ${x},${y+h-r} Z" fill="${fill}" class="has-tip" data-tip="${tip}"/>`;
}

function chartFlow(mks) {
  const data = mks.map(mk => { const t = monthTotals(mk); return { mk, ins: t.ins, outs: t.outs, saldo: t.ins - t.outs }; });
  const n = data.length;
  const maxBar = Math.max(1, ...data.flatMap(d => [d.ins, d.outs]));
  const minSaldo = Math.min(0, ...data.map(d => d.saldo)), maxSaldo = Math.max(0, ...data.map(d => d.saldo));
  const W = 480, H = 220, padL = 8, padB = 26, padT = 10;
  const plotH = H - padB - padT;
  const bandW = (W - padL) / n;
  const barW = Math.min(22, bandW / 2 - 6);
  const y = v => padT + plotH - (v / maxBar * plotH);
  // escala do saldo (pode ser negativo) mapeada no mesmo plot
  const sRange = (maxSaldo - minSaldo) || 1;
  const ys = v => padT + plotH - ((v - minSaldo) / sRange * plotH);
  const step = niceStep(maxBar);
  let grid = "";
  for (let g = step; g <= maxBar; g += step) grid += `<line x1="${padL}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--grid)"/><text x="${padL}" y="${y(g)-4}" font-size="10" fill="var(--ink-3)">${compact(g)}</text>`;
  let bars = "", saldoPts = [];
  data.forEach((d, i) => {
    const cx = padL + bandW * i + bandW / 2;
    bars += barRect(cx - barW - 1, y(d.ins), barW, plotH + padT - y(d.ins), "var(--s1)", `${monthLabel(d.mk)}|Entradas|${d.ins}`);
    bars += barRect(cx + 1, y(d.outs), barW, plotH + padT - y(d.outs), "var(--s2)", `${monthLabel(d.mk)}|Saídas|${d.outs}`);
    bars += `<text x="${cx}" y="${H - 8}" font-size="11" fill="var(--ink-3)" text-anchor="middle">${monthLabel(d.mk)}</text>`;
    saldoPts.push([cx, ys(d.saldo)]);
  });
  const line = saldoPts.map((pt, i) => (i ? "L" : "M") + pt[0].toFixed(1) + "," + pt[1].toFixed(1)).join(" ");
  const dots = saldoPts.map((pt, i) => `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="3" fill="var(--s7)" stroke="var(--surface-1)" stroke-width="2" class="has-tip" data-tip="${monthLabel(data[i].mk)}|Saldo|${data[i].saldo}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto" role="img" aria-label="Entradas, saídas e saldo por mês">
    ${grid}
    <line x1="${padL}" x2="${W}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--baseline)"/>
    ${bars}
    ${n > 1 ? `<path d="${line}" fill="none" stroke="var(--s7)" stroke-width="2" stroke-linejoin="round"/>` : ""}
    ${dots}</svg>`;
}
function barRect(x, y, w, h, fill, tip) {
  if (h <= 0) return "";
  const r = Math.min(4, h);
  return `<path d="M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z"
    fill="${fill}" class="has-tip" data-tip="${tip}"/>`;
}
function niceStep(max) {
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
  return raw;
}
const compact = v => v >= 1e6 ? (v/1e6).toFixed(1)+"M" : v >= 1e3 ? Math.round(v/1e3)+"k" : Math.round(v);

// ---- Gráfico: categorias clicável (drill-down) ----
function chartCats(mks) {
  const cats = catSpendMonths(mks).slice(0, 8);
  if (!cats.length) return `<div class="empty"><span class="big">🍃</span>Nenhum gasto registrado neste período.</div>`;
  const max = cats[0][1];
  return `<div style="display:flex; flex-direction:column; gap:9px; margin-top:4px">` + cats.map(([c, v]) => `
    <button class="cat-row" data-cat-detail="${esc(c)}" aria-label="Ver transações de ${esc(c)}">
      <div class="flex spread" style="font-size:13px; margin-bottom:3px">
        <span style="color:var(--ink-2)">${esc(c)}</span><b style="font-variant-numeric:tabular-nums">${fmtBRL0(v)}</b>
      </div>
      <div class="meter"><div style="width:${(v/max*100).toFixed(1)}%; background:var(--s2)"></div></div>
    </button>`).join("") + `</div>`;
}
function modalCatDetail(cat) {
  const mks = periodMonths(analysisPeriod);
  const rows = TX.filter(t => t.type === "saida" && t.category === cat && mks.includes(monthKey(t.date)))
    .sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((a, t) => a + t.amount, 0);
  openModal(`
    <h3>${esc(cat)} · ${fmtBRL(total)}</h3>
    <p class="muted" style="margin:-8px 0 14px">${rows.length} transação(ões) em ${periodLabel(dashPeriod).toLowerCase()} — as maiores primeiro</p>
    ${rows.length ? `<div class="table-wrap" style="max-height:52vh; overflow-y:auto"><table>
      <thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th></tr></thead>
      <tbody>${rows.map(t => `<tr>
        <td style="white-space:nowrap">${t.date.split("-").reverse().slice(0,2).join("/")}</td>
        <td>${esc(t.desc || "—")}${t.aiRead ? " 🤖" : ""}</td>
        <td class="num">${fmtBRL(t.amount)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">Nenhuma transação.</div>`}
    <div class="modal-actions"><button class="btn" id="mCancel">Fechar</button></div>`);
  $("#mCancel").onclick = closeModal;
}

// ============================================================
// VIEW: TRANSAÇÕES
// ============================================================
function viewTransacoes() {
  const mk = $("#fMonth")?.value || todayISO().slice(0, 7);
  return `
  <div class="view-head">
    <div><h2>Transações</h2><div class="sub">Entradas e saídas registradas</div></div>
    <div class="flex">
      <button class="btn secondary" data-goto="comprovante">📸 Ler comprovante</button>
      <button class="btn" id="btnQuickAdd">+ Nova</button>
    </div>
  </div>
  <div class="card">
    <div class="flex spread" style="margin-bottom:12px">
      <input type="month" id="fMonth" value="${mk}" style="padding:8px 10px; border-radius:9px; border:1px solid var(--border); background:var(--page)">
      <span class="muted" id="fCount"></span>
    </div>
    <div id="txTableBox">${txTableFiltered(mk)}</div>
  </div>`;
}
function txTableFiltered(mk) {
  const rows = TX.filter(t => monthKey(t.date) === mk);
  const ins = rows.filter(t=>t.type==="entrada").reduce((a,t)=>a+t.amount,0);
  const outs = rows.filter(t=>t.type==="saida").reduce((a,t)=>a+t.amount,0);
  return `
    <div class="flex" style="gap:18px; margin-bottom:10px; font-size:14px">
      <span>Entradas: <b style="color:var(--good-text)">${fmtBRL(ins)}</b></span>
      <span>Saídas: <b style="color:var(--critical)">${fmtBRL(outs)}</b></span>
      <span>Saldo: <b>${fmtBRL(ins-outs)}</b></span>
    </div>` + tableTx(rows, true);
}
function tableTx(rows, actions) {
  if (!rows.length) return `<div class="empty"><span class="big">🗒️</span>Nenhuma transação. Registre a primeira!</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th>${actions ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows.map(t => `
      <tr>
        <td style="white-space:nowrap">${t.date.split("-").reverse().slice(0,2).join("/")}</td>
        <td>${esc(t.desc || "—")}${t.aiRead ? ' <span title="Lido por IA">🤖</span>' : ""}</td>
        <td><span class="chip">${esc(t.category)}</span></td>
        <td class="num" style="color:${t.type === "entrada" ? "var(--good-text)" : "var(--critical)"}">
          ${t.type === "entrada" ? "↑ +" : "↓ −"} ${fmtBRL(t.amount)}</td>
        ${actions ? `<td style="white-space:nowrap"><button class="icon-btn" title="Duplicar" data-dup-tx="${t.id}">⧉</button><button class="icon-btn" title="Editar" data-edit-tx="${t.id}">✏️</button><button class="icon-btn" title="Excluir" data-del-tx="${t.id}">🗑️</button></td>` : ""}
      </tr>`).join("")}</tbody></table></div>`;
}

// ============================================================
// VIEW: COMPROVANTE IA
// ============================================================
function viewComprovante() {
  const hasKey = hasAIKey();
  return `
  <div class="view-head">
    <div><h2>Comprovante IA</h2><div class="sub">Fotografe ou envie o comprovante — a IA lê, categoriza e registra</div></div>
  </div>
  ${hasKey ? "" : `<div class="card" style="margin-bottom:14px; border-color:var(--warning)">
    ⚠️ Configure sua <b>chave da API Claude</b> em <a href="#" data-goto="config">Configurações</a> para usar a leitura automática.</div>`}
  <div class="card">
    <div class="dropzone" id="dropzone">
      <span class="big">📸</span>
      <b>Arraste o comprovante aqui</b><br>ou
      <div class="flex" style="justify-content:center; margin-top:12px">
        <button class="btn" id="btnPickFile">Escolher imagem</button>
        <button class="btn secondary" id="btnCamera">Usar câmera</button>
      </div>
      <div class="muted" style="margin-top:10px">PIX, cartão, boleto, nota fiscal — JPG, PNG ou WebP</div>
      <input type="file" id="fileInput" accept="image/*" class="hidden">
      <input type="file" id="cameraInput" accept="image/*" capture="environment" class="hidden">
    </div>
    <div id="receiptStatus" class="section-gap hidden"></div>
    <div id="receiptResult" class="section-gap hidden"></div>
  </div>
  <div class="card section-gap">
    <h3>Como funciona</h3>
    <p class="muted" style="margin-top:6px">A imagem é enviada diretamente do seu navegador para a IA Claude, que extrai valor, data, estabelecimento e sugere a categoria. Você confirma antes de salvar — nada é registrado sem sua aprovação. A imagem não fica armazenada.</p>
  </div>`;
}

// ============================================================
// VIEW: DÍVIDAS
// ============================================================
function viewDividas() {
  const dt = debtTotals();
  const renda = avgIncome();
  const essenciais = avgEssentials();
  const investRes = renda * ((SETTINGS.investPct ?? 20) / 100);
  const limitePct = SETTINGS.debtPct ?? 30;
  const limiteRecom = renda * limitePct / 100;
  const capacidade = Math.max(0, renda - essenciais - investRes);
  const maxNegociavel = Math.min(limiteRecom, capacidade);
  const usoPct = maxNegociavel > 0 ? dt.monthly / maxNegociavel * 100 : 0;
  const ativas = DEBTS.filter(d => d.status !== "quitada");
  const quitadas = DEBTS.filter(d => d.status === "quitada");

  return `
  <div class="view-head">
    <div><h2>Planejamento de Dívidas</h2><div class="sub">Quanto você pode negociar sem apertar o orçamento</div></div>
    <button class="btn" id="btnAddDebt">+ Nova dívida</button>
  </div>

  <div class="grid tiles">
    <div class="card tile"><div class="label">Total em aberto</div><div class="value">${fmtBRL0(dt.open)}</div></div>
    <div class="card tile"><div class="label">Parcelas atuais/mês</div><div class="value">${fmtBRL0(dt.monthly)}</div></div>
    <div class="card tile"><div class="label">Máx. recomendado/mês</div><div class="value" style="color:var(--accent)">${fmtBRL0(maxNegociavel)}</div>
      <div class="delta">${limitePct}% da renda média, respeitando gastos e aportes</div></div>
    <div class="card tile"><div class="label">Margem p/ negociar</div>
      <div class="value" style="color:${maxNegociavel - dt.monthly >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL0(Math.max(0, maxNegociavel - dt.monthly))}</div>
      <div class="delta">disponível para novas parcelas</div></div>
  </div>

  <div class="card section-gap">
    <div class="flex spread">
      <h3>Comprometimento do orçamento com dívidas</h3>
      <span class="badge ${usoPct > 100 ? "crit" : usoPct > 75 ? "warn" : "good"}">${usoPct > 100 ? "⛔ acima do limite" : usoPct > 75 ? "⚠️ perto do limite" : "✅ saudável"} · ${usoPct.toFixed(0)}%</span>
    </div>
    <div class="meter ${usoPct > 100 ? "crit" : usoPct > 75 ? "warn" : "good"}" style="margin-top:10px">
      <div style="width:${Math.min(100, usoPct)}%"></div></div>
    <div class="muted" style="margin-top:8px">
      Base do cálculo: renda média ${fmtBRL0(renda)} − essenciais ${fmtBRL0(essenciais)} − reserva p/ investir ${fmtBRL0(investRes)} (${SETTINGS.investPct ?? 20}%). Ajuste os percentuais em Configurações.</div>
  </div>

  <div class="card section-gap">
    <div class="flex spread" style="margin-bottom:8px">
      <h3>Dívidas ativas</h3>
      <button class="btn secondary small" id="btnDebtAI" ${hasAIKey() ? "" : "disabled"}>🤖 Estratégia de quitação com IA</button>
    </div>
    <div id="debtAIBox" class="hidden section-gap"></div>
    ${!ativas.length ? `<div class="empty"><span class="big">🎉</span>Nenhuma dívida ativa.</div>` :
    `<div class="table-wrap"><table>
      <thead><tr><th>Credor</th><th class="num">Valor atual</th><th class="num">Parcela</th><th class="num">Juros a.m.</th><th>Status</th><th></th></tr></thead>
      <tbody>${ativas.map(d => {
        const rest = (d.currentValue ?? d.total) - (d.paid || 0);
        return `<tr>
        <td><b>${esc(d.name)}</b><div class="muted">${esc(d.note || "")}</div></td>
        <td class="num">${fmtBRL(Math.max(0, rest))}</td>
        <td class="num">${d.monthlyPayment ? fmtBRL(d.monthlyPayment) : "—"}</td>
        <td class="num">${d.interest != null ? d.interest + "%" : "—"}</td>
        <td><span class="badge ${d.status === "acordo" || d.status === "em dia" ? "good" : d.status === "negociando" ? "warn" : "crit"}">${esc(d.status || "pendente")}</span></td>
        <td style="white-space:nowrap">
          <button class="icon-btn" title="Negociar — criar acordo em parcelas nos Boletos" data-negotiate="${d.id}">🤝</button>
          <button class="icon-btn" title="Registrar pagamento avulso" data-pay-debt="${d.id}">💵</button>
          <button class="icon-btn" data-edit-debt="${d.id}">✏️</button>
          <button class="icon-btn" data-del-debt="${d.id}">🗑️</button></td>
      </tr>`;}).join("")}</tbody></table></div>`}
    ${quitadas.length ? `<div class="muted section-gap">✅ Quitadas: ${quitadas.map(d => esc(d.name)).join(", ")}</div>` : ""}
  </div>`;
}

// ============================================================
// VIEW: BOLETOS & CONTAS
// ============================================================
function addMonthISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(y, m + 1, 0).getDate(); // último dia do mês seguinte
  const day = Math.min(d, last);
  return isoLocal(new Date(y, m, day));
}
function billTimesLabel(b) {
  if (!b.recurring) return "única";
  const done = (b.paidTimes || 0) + 1;
  return b.totalTimes ? `${done}ª de ${b.totalTimes}x` : `${done}ª · repete sempre`;
}
function pendingBills() {
  return BILLS.filter(b => !["pago", "encerrado", "convertido"].includes(b.status));
}
// parcelas com vencimento em MESES ANTERIORES ao atual (a do mês corrente fica nos boletos)
function overdueOccurrences(b) {
  const curMK = todayISO().slice(0, 7);
  const maxN = b.recurring ? (b.totalTimes ? Math.max(0, b.totalTimes - (b.paidTimes || 0)) : 999) : 1;
  let d = b.dueDate, n = 0;
  const months = [];
  while (monthKey(d) < curMK && n < maxN) {
    months.push(monthKey(d)); n++;
    if (!b.recurring) break;
    d = addMonthISO(d);
  }
  return { n, nextDue: d, months };
}

async function regularizeBill(b) {
  const { n, nextDue, months } = overdueOccurrences(b);
  if (!n) return;
  const total = n * b.amount;
  const remaining = b.recurring && b.totalTimes ? b.totalTimes - (b.paidTimes || 0) : Infinity;
  const allPast = n >= remaining || !b.recurring;
  if (!confirm(`Mover ${n} parcela(s) atrasada(s) de "${b.name}" (${months.map(monthLabel).join(", ")} — total ${fmtBRL(total)}) para o Planejamento de Dívidas?`)) return;
  try {
    await addDoc(collection(db, "households", hid, "debts"), {
      name: `${b.name} — ${n} parcela(s) atrasada(s)`,
      total, currentValue: total, paid: 0,
      monthlyPayment: b.amount, interest: null, status: "atrasada",
      dueDay: b.dueDate ? +b.dueDate.split("-")[2] : null,
      note: `Parcelas vencidas de ${months.map(monthLabel).join(", ")} (${fmtBRL(b.amount)} cada), movidas dos Boletos em ${todayISO().split("-").reverse().join("/")}` + (b.dda ? " · boleto DDA" : ""),
      updatedAt: new Date().toISOString()
    });
    if (allPast) {
      await updateDoc(doc(db, "households", hid, "bills", b.id), { status: "convertido", paidTimes: (b.paidTimes || 0) + n });
      toast(`📉 ${n} parcela(s) viraram dívida. Esta conta não tinha mais parcelas futuras.`);
    } else {
      await updateDoc(doc(db, "households", hid, "bills", b.id), { paidTimes: (b.paidTimes || 0) + n, dueDate: nextDue });
      toast(`📉 ${n} parcela(s) viraram dívida. Nos Boletos ficou a parcela de ${monthLabel(monthKey(nextDue))}.`);
    }
  } catch (e) { toast("Erro: " + e.message); }
}

function viewBoletos() {
  const today = todayISO();
  const mk = today.slice(0, 7);
  const pend = pendingBills();
  const overdue = pend.filter(b => b.dueDate < today);
  const monthSum = pend.filter(b => monthKey(b.dueDate) === mk).reduce((a, b) => a + b.amount, 0);
  const ddaCount = pend.filter(b => b.dda).length;
  const done = BILLS.filter(b => ["pago", "encerrado", "convertido"].includes(b.status)).slice(-8).reverse();

  return `
  <div class="view-head">
    <div><h2>Boletos & Contas</h2><div class="sub">Contas a pagar, recorrências e boletos DDA no seu CPF</div></div>
    <button class="btn" id="btnAddBill">+ Novo boleto/conta</button>
  </div>

  <div class="grid tiles">
    <div class="card tile"><div class="label">A pagar em ${monthLabel(mk)}</div><div class="value">${fmtBRL(monthSum)}</div></div>
    <div class="card tile"><div class="label">Vencidos</div>
      <div class="value" style="color:${overdue.length ? "var(--critical)" : "var(--good-text)"}">${overdue.length}</div>
      <div class="delta">${overdue.length ? fmtBRL(overdue.reduce((a,b)=>a+b.amount,0)) + " em atraso" : "tudo em dia 🎉"}</div></div>
    <div class="card tile"><div class="label">Boletos DDA</div><div class="value">${ddaCount}</div>
      <div class="delta">registrados no seu CPF</div></div>
  </div>

  ${(() => {
    const late = pend.map(b => ({ b, o: overdueOccurrences(b) })).filter(x => x.o.n > 0);
    if (!late.length) return "";
    return `<div class="card section-gap" style="border-color:var(--warning)">
      <h3>⚠️ Parcelas de meses anteriores em atraso</h3>
      <p class="muted" style="margin:6px 0 10px">O recomendado é mover essas parcelas para o Planejamento de Dívidas e deixar nos Boletos apenas a conta do mês atual.</p>
      ${late.map(({ b, o }) => `
      <div class="flex spread" style="padding:9px 0; border-top:1px solid var(--grid)">
        <span><b>${esc(b.name)}</b>
          <div class="muted">${o.n} parcela(s) vencida(s): ${o.months.map(monthLabel).join(", ")} · total ${fmtBRL(o.n * b.amount)}</div></span>
        <button class="btn small" data-regularize="${b.id}">📉 Mover para Dívidas</button>
      </div>`).join("")}
    </div>`;
  })()}

  <div class="card section-gap">
    <h3>Contas pendentes</h3>
    ${!pend.length ? `<div class="empty"><span class="big">📭</span>Nenhuma conta pendente. Cadastre boletos, assinaturas e contas do mês.</div>` :
    `<div class="table-wrap"><table>
      <thead><tr><th>Vencimento</th><th>Conta</th><th class="num">Valor</th><th>Recorrência</th><th></th></tr></thead>
      <tbody>${pend.map(b => {
        const isOver = b.dueDate < today;
        const isToday = b.dueDate === today;
        return `<tr>
        <td style="white-space:nowrap">
          <span class="badge ${isOver ? "crit" : isToday ? "warn" : "good"}">${isOver ? "⛔ venceu" : isToday ? "hoje" : b.dueDate.split("-").reverse().slice(0,2).join("/")}</span>
        </td>
        <td><b>${esc(b.name)}</b>${b.dda ? ' <span class="chip" title="Boleto DDA no seu CPF">DDA</span>' : ""}
          <div class="muted">${esc(b.category || "")}</div></td>
        <td class="num">${fmtBRL(b.amount)}</td>
        <td><span class="chip">${b.recurring ? "🔁 " : ""}${billTimesLabel(b)}</span></td>
        <td style="white-space:nowrap">
          <button class="icon-btn" title="Marcar como pago" data-pay-bill="${b.id}">💵</button>
          <button class="icon-btn" title="Transformar em dívida" data-debt-bill="${b.id}">📉</button>
          <button class="icon-btn" data-edit-bill="${b.id}">✏️</button>
          <button class="icon-btn" data-del-bill="${b.id}">🗑️</button></td>
      </tr>`;}).join("")}</tbody></table></div>`}
    <p class="muted section-gap">💡 <b>Pagar</b> registra a saída automaticamente e, se a conta for recorrente, agenda o próximo mês. <b>📉 Transformar em dívida</b> leva o boleto não pago para o Planejamento de Dívidas.</p>
  </div>

  ${done.length ? `<div class="card section-gap">
    <h3>Histórico recente</h3>
    <div class="table-wrap"><table><tbody>
    ${done.map(b => `<tr><td>${esc(b.name)}</td><td class="num">${fmtBRL(b.amount)}</td>
      <td><span class="badge ${b.status === "convertido" ? "crit" : "good"}">${b.status === "convertido" ? "virou dívida" : b.status}</span></td></tr>`).join("")}
    </tbody></table></div></div>` : ""}`;
}

function modalBill(b = null) {
  const t = b || {};
  openModal(`
    <h3>${b ? "Editar" : "Novo"} boleto / conta</h3>
    <div class="field"><label>Nome da conta</label><input id="bName" value="${esc(t.name || "")}" placeholder="Ex.: Energia CEMIG, Aluguel, Internet"></div>
    <div class="form-row">
      <div class="field"><label>Valor (R$)</label><input id="bAmount" inputmode="decimal" value="${t.amount != null ? String(t.amount).replace(".", ",") : ""}" placeholder="0,00"></div>
      <div class="field"><label>Vencimento</label><input id="bDue" type="date" value="${t.dueDate || todayISO()}"></div>
    </div>
    <div class="field"><label>Categoria (para o registro da saída)</label>
      <select id="bCat">${catsOut().map(c => `<option ${(t.category || "Contas (água/luz/net)") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    <div class="field" style="flex-direction:row; align-items:center; gap:9px">
      <input type="checkbox" id="bRecurring" style="width:18px; height:18px" ${t.recurring ? "checked" : ""}>
      <label for="bRecurring" style="margin:0">🔁 Esta conta se repete todo mês</label>
    </div>
    <div class="field ${t.recurring ? "" : "hidden"}" id="bTimesRow">
      <label>Quantas vezes ela se repete?</label>
      <input id="bTimes" type="number" min="2" max="480" value="${t.totalTimes ?? ""}" placeholder="deixe vazio para repetir sempre">
      <span class="hint">Ex.: parcelamento em 12x → digite 12. Conta fixa (luz, aluguel) → deixe vazio.</span>
    </div>
    <div class="field" style="flex-direction:row; align-items:center; gap:9px">
      <input type="checkbox" id="bDda" style="width:18px; height:18px" ${t.dda ? "checked" : ""}>
      <label for="bDda" style="margin:0">📄 É boleto DDA registrado no meu CPF</label>
    </div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Salvar</button>
    </div>`);
  $("#bRecurring").onchange = e => $("#bTimesRow").classList.toggle("hidden", !e.target.checked);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const amount = parseMoney($("#bAmount").value);
    const name = $("#bName").value.trim();
    if (!name || !amount) return toast("Preencha nome e valor.");
    const recurring = $("#bRecurring").checked;
    const data = {
      name, amount, dueDate: $("#bDue").value || todayISO(),
      category: $("#bCat").value, recurring,
      totalTimes: recurring && $("#bTimes").value ? +$("#bTimes").value : null,
      paidTimes: t.paidTimes || 0,
      dda: $("#bDda").checked,
      status: t.status || "pendente",
      createdBy: user.email
    };
    try {
      if (b) await updateDoc(doc(db, "households", hid, "bills", b.id), data);
      else await addDoc(collection(db, "households", hid, "bills"), data);
      closeModal(); toast("Conta salva.");
    } catch (e) { toast("Erro: " + e.message); }
  };
}

async function payBill(b) {
  try {
    await addDoc(collection(db, "households", hid, "transactions"), {
      type: "saida", amount: b.amount, date: todayISO(),
      desc: "Boleto: " + b.name, category: b.category || "Contas (água/luz/net)",
      method: "Boleto", createdBy: user.email, createdAt: new Date().toISOString()
    });
    const paidTimes = (b.paidTimes || 0) + 1;
    const continues = b.recurring && (!b.totalTimes || paidTimes < b.totalTimes);
    if (continues) {
      await updateDoc(doc(db, "households", hid, "bills", b.id), {
        paidTimes, dueDate: addMonthISO(b.dueDate)
      });
      toast(`💵 Pago! Próxima cobrança agendada para ${addMonthISO(b.dueDate).split("-").reverse().slice(0,2).join("/")}.`);
    } else {
      await updateDoc(doc(db, "households", hid, "bills", b.id), {
        paidTimes, status: b.recurring ? "encerrado" : "pago"
      });
      toast(b.recurring ? "💵 Pago! Recorrência concluída — todas as parcelas quitadas. 🎉" : "💵 Conta paga e registrada!");
    }
    // parcela de acordo → abate a dívida vinculada
    if (b.debtId) {
      const d = DEBTS.find(x => x.id === b.debtId);
      if (d) {
        const paid = (d.paid || 0) + b.amount;
        const rest = (d.currentValue ?? d.total) - paid;
        await updateDoc(doc(db, "households", hid, "debts", d.id), {
          paid, status: rest <= 0.01 ? "quitada" : d.status
        });
        if (rest <= 0.01) toast("🎉 Acordo quitado — dívida \"" + d.name + "\" LIQUIDADA!", 5500);
        else toast(`💪 Abatido ${fmtBRL(b.amount)} — restam ${fmtBRL(rest)} do acordo "${d.name}".`, 4500);
      }
    }
  } catch (e) { toast("Erro: " + e.message); }
}

async function billToDebt(b) {
  if (!confirm(`Transformar "${b.name}" (${fmtBRL(b.amount)}) em dívida no Planejamento?`)) return;
  try {
    await addDoc(collection(db, "households", hid, "debts"), {
      name: b.name, total: b.amount, currentValue: b.amount, paid: 0,
      monthlyPayment: 0, interest: null, status: "atrasada",
      dueDay: b.dueDate ? +b.dueDate.split("-")[2] : null,
      note: "Originado de boleto" + (b.dda ? " DDA" : "") + " não pago (venc. " + b.dueDate.split("-").reverse().join("/") + ")",
      updatedAt: new Date().toISOString()
    });
    await updateDoc(doc(db, "households", hid, "bills", b.id), { status: "convertido" });
    toast("📉 Boleto virou dívida — veja no Planejamento de Dívidas.");
  } catch (e) { toast("Erro: " + e.message); }
}

// ============================================================
// VIEW: INVESTIMENTOS
// ============================================================
function viewInvest() {
  const s = investStats(), mk = todayISO().slice(0, 7), plan = planCalc();
  const mesAporte = INVEST.filter(i => monthKey(i.date) === mk && i.type === "aporte").reduce((a, i) => a + i.amount, 0);
  const alloc = investAllocation();

  return `
  <div class="view-head">
    <div><h2>Investimentos</h2><div class="sub">Registre aportes e acompanhe seu patrimônio</div></div>
    <div class="flex">
      <button class="btn secondary" id="btnImportInv"><span class="ico" data-ic="file" style="width:15px;height:15px"></span> Importar extrato</button>
      <button class="btn" id="btnAddInv"><span class="ico" data-ic="plus" style="width:15px;height:15px"></span> Novo aporte</button>
    </div>
  </div>

  <div class="inv-kpi">
    <div class="kpi-card"><div class="badge-ic b">${icon("pie")}</div>
      <div><div class="kc-label">Patrimônio investido</div><div class="kc-val">${fmtBRL(s.patrimonio)}</div>
      <div class="kc-ctx">${s.rend > 0 ? `<span class="trend pos">↑ ${fmtBRL0(s.rend)} (${s.rentPct.toFixed(1)}%)</span>` : "sem rendimento registrado"}</div></div></div>
    <div class="kpi-card"><div class="badge-ic b">${icon("wallet")}</div>
      <div><div class="kc-label">Aportado neste mês</div><div class="kc-val">${fmtBRL(mesAporte)}</div>
      <div class="kc-ctx">meta de aporte: ${fmtBRL0(plan.pmt)}</div></div></div>
    <div class="kpi-card"><div class="badge-ic g">${icon("trend-up")}</div>
      <div><div class="kc-label">Rentabilidade acumulada</div><div class="kc-val" style="color:${s.rend >= 0 ? "var(--good-text)" : "var(--critical)"}">${s.rend >= 0 ? "+" : ""}${fmtBRL(s.rend)}</div>
      <div class="kc-ctx">${s.base > 0 ? s.rentPct.toFixed(1) + "% sobre o investido" : "—"}</div></div></div>
    <div class="kpi-card"><div class="badge-ic v">${icon("target")}</div>
      <div><div class="kc-label">Progresso da meta</div><div class="kc-val">${plan.pct.toFixed(1)}%</div>
      <div class="kc-ctx">${fmtBRL0(plan.goal)} em ${SETTINGS.goalYears || 5} anos</div></div></div>
  </div>

  <div class="inv-2col">
    <div>
      <div class="panel">
        <div class="panel-head"><h3>Evolução do patrimônio</h3>
          <select class="mini" data-sel="flow">${[["6","Últimos 6 meses"],["12","Últimos 12 meses"],["ano","Este ano"]].map(([k,l])=>`<option value="${k}" ${flowRange===k?"selected":""}>${l}</option>`).join("")}</select></div>
        <div class="inv-legend3">
          <span class="l3"><span class="d" style="background:var(--s1)"></span>Patrimônio <b>${fmtBRL0(s.patrimonio)}</b></span>
          <span class="l3"><span class="d" style="background:var(--good)"></span>Aportes <b>${fmtBRL0(s.base)}</b></span>
          <span class="l3"><span class="d" style="background:var(--s7)"></span>Rendimento <b>${fmtBRL0(s.rend)}</b></span>
        </div>
        ${INVEST.length ? investEvolutionChart(flowMonths()) : `<div class="empty"><span class="big">🌱</span>Registre aportes para ver a evolução.</div>`}
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h3>Movimentações</h3></div>
        ${!INVEST.length ? `<div class="empty"><span class="big">🌱</span>Nenhum aporte ainda. Comece hoje — juros compostos agradecem.</div>` :
        `<div class="table-wrap"><table class="inv-table">
          <thead><tr><th>Ativo</th><th>Tipo</th><th>Data</th><th class="num">Valor</th><th>Conta</th><th></th></tr></thead>
          <tbody>${INVEST.slice(0, 8).map(i => {
            const isOut = i.type === "resgate";
            return `<tr>
            <td><div class="inv-asset"><span class="ia-ic">${icon(assetIcon(i.assetType))}</span><b>${esc(i.name)}</b></div></td>
            <td><span class="type-pill ${i.type || "aporte"}">${({aporte:"Aporte",rendimento:"Rendimento",dividendo:"Dividendo",resgate:"Resgate"})[i.type] || "Aporte"}</span></td>
            <td style="white-space:nowrap; color:var(--ink-2)">${i.date.split("-").reverse().join("/")}</td>
            <td class="num" style="color:${isOut ? "var(--critical)" : "var(--good-text)"}">${isOut ? "− " : ""}${fmtBRL(i.amount)}</td>
            <td style="color:var(--ink-2)">${esc(i.conta || "Conta Investimentos")}</td>
            <td><button class="icon-btn" title="Excluir" data-del-inv="${i.id}">🗑️</button></td>
          </tr>`;}).join("")}</tbody></table></div>
        ${INVEST.length > 8 ? `<div style="text-align:center; margin-top:12px"><span class="muted" style="font-size:13px">Mostrando as 8 mais recentes de ${INVEST.length}</span></div>` : ""}`}
      </div>
    </div>

    <div>
      <div class="panel">
        <div class="panel-head"><h3>Alocação da carteira</h3></div>
        ${alloc.length ? allocDonut(alloc) : `<div class="empty" style="padding:24px 10px"><span class="big">🥧</span>Sem ativos ainda.</div>`}
        <button class="panel-link" id="btnAddInv2">Ver detalhes da carteira →</button>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h3>Meta de 1 milhão</h3></div>
        <div class="meta-ring">
          <div class="mr-num">${ringGauge(plan.pct)}<div class="c"><b>${plan.pct.toFixed(1)}%</b><span>concluída</span></div></div>
          <div style="flex:1; min-width:170px">
            <div style="font-size:17px; font-weight:650">${fmtBRL0(plan.current)} <span class="muted" style="font-size:13px; font-weight:500">de ${fmtBRL0(plan.goal)}</span></div>
            <div class="meter" style="margin:8px 0 6px"><div style="width:${plan.pct}%"></div></div>
            <div class="muted" style="font-size:12.5px">Faltam ${fmtBRL0(plan.goal - plan.current)} · Aporte sugerido: <b>${fmtBRL0(plan.pmt)}/mês</b></div>
          </div>
        </div>
        <button class="panel-link" data-goto="plano">Ver plano da meta →</button>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h3>Insights da carteira</h3></div>
        ${investInsights(s, alloc)}
        <button class="panel-link" id="btnInvestAI" ${hasAIKey() ? "" : "disabled"}>Ver análise completa →</button>
      </div>
    </div>
  </div>

  ${INVEST.length ? `<div class="insight-banner">
    <span class="ib-ic">${icon("sparkles")}</span>
    <div class="ib-b"><div class="ib-t">Projeção</div><div class="ib-d">${investProjection(plan)}</div></div>
    <button class="btn" data-goto="plano">Ver plano completo</button>
  </div>` : ""}`;
}

function assetIcon(t) {
  const m = { "Renda fixa":"coins","Tesouro":"shield","FIIs":"home","Ações BR":"trend-up","Ações/ETF exterior":"trend-up","Cripto":"bolt","Fundo":"pie","Outros":"coins" };
  return m[t] || "coins";
}
function allocDonut(items) {
  const total = items.reduce((a, [, v]) => a + v, 0);
  const cols = ["var(--s1)", "var(--s7)", "var(--s3)", "var(--s8)", "var(--s6)", "var(--s4)", "var(--s5)", "var(--baseline)"];
  const cx = 80, cy = 80, R = 72, r = 48; let a0 = -90, paths = "";
  items.forEach(([, v], i) => {
    const a1 = a0 + v / total * 360, large = (a1 - a0) > 180 ? 1 : 0;
    const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1), [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
    paths += `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} A${r} ${r} 0 ${large} 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${cols[i % cols.length]}" stroke="var(--surface-1)" stroke-width="2.5"/>`;
    a0 = a1;
  });
  const donut = `<svg viewBox="0 0 160 160" width="150" height="150" style="flex-shrink:0">${paths}
    <text x="80" y="78" text-anchor="middle" font-size="14" font-weight="700" fill="var(--ink-1)">${fmtBRL0(total)}</text>
    <text x="80" y="93" text-anchor="middle" font-size="10" fill="var(--ink-3)">Total investido</text></svg>`;
  const legend = `<div class="donut-legend">${items.map(([c, v], i) => `
    <div class="dl-row" style="display:grid">
      <span class="dl-dot" style="background:${cols[i % cols.length]}"></span>
      <span style="text-align:left">${esc(c)}</span>
      <span class="dl-val">${fmtBRL0(v)}</span>
      <span class="dl-pct">${(v / total * 100).toFixed(1)}%</span>
    </div>`).join("")}</div>`;
  return `<div class="flex" style="gap:14px; align-items:center; flex-wrap:wrap; justify-content:center">${donut}${legend}</div>`;
}
function ringGauge(pct) {
  const r = 40, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, pct) / 100);
  return `<svg viewBox="0 0 92 92" width="92" height="92">
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--grid)" stroke-width="9"/>
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 46 46)"/></svg>`;
}
function investInsights(s, alloc) {
  const out = [];
  const streak = investStreak();
  if (streak >= 2) out.push(`<div class="inv-insight good"><span class="ii-ic">${icon("check")}</span>
    <div class="ii-b"><div class="ii-t">Consistência de aportes</div><div class="ii-d">${streak} meses seguidos investindo. Continue assim!</div></div></div>`);
  if (alloc.length) { const total = alloc.reduce((a, [, v]) => a + v, 0); const [c, v] = alloc[0];
    out.push(`<div class="inv-insight star"><span class="ii-ic">${icon("target")}</span>
      <div class="ii-b"><div class="ii-t">Maior posição</div><div class="ii-d">${esc(c)} representa ${(v/total*100).toFixed(0)}% da sua carteira${v/total>0.5?" — considere diversificar":""}.</div></div></div>`); }
  const rf = new Set(["Renda fixa", "Tesouro"]);
  const rfVal = alloc.filter(([c]) => rf.has(c)).reduce((a, [, v]) => a + v, 0);
  const rvVal = alloc.filter(([c]) => !rf.has(c)).reduce((a, [, v]) => a + v, 0);
  if (alloc.length >= 2) out.push(`<div class="inv-insight div"><span class="ii-ic">${icon("pie")}</span>
    <div class="ii-b"><div class="ii-t">Diversificação</div><div class="ii-d">${rvVal > 0 && rfVal > 0 ? "Carteira distribuída entre renda fixa e variável." : "Concentrada em " + (rfVal >= rvVal ? "renda fixa" : "renda variável") + " — avalie diversificar."}</div></div></div>`);
  return out.join("") || `<div class="muted" style="font-size:13px">Registre mais aportes para gerar insights.</div>`;
}
function investEvolutionChart(months) {
  const data = investSeries(months);
  const n = data.length;
  const maxV = Math.max(1, ...data.map(d => d.patrimonio));
  const W = 640, H = 300, padL = 46, padB = 26, padT = 10, padR = 12;
  const plotH = H - padB - padT, plotW = W - padL - padR;
  const x = i => padL + (n <= 1 ? plotW / 2 : i / (n - 1) * plotW);
  const y = v => padT + plotH - v / maxV * plotH;
  const step = niceStep(maxV);
  let grid = "";
  for (let g = 0; g <= maxV; g += step) grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y(g)+3}" font-size="9.5" fill="var(--ink-3)" text-anchor="end">${g === 0 ? "R$ 0" : "R$ " + compact(g)}</text>`;
  const mkLine = (key, color) => data.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(d[key]).toFixed(1)).join(" ");
  const patrimPath = mkLine("patrimonio", "var(--s1)");
  const area = patrimPath + ` L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const dot = (key, color) => data.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d[key]).toFixed(1)}" r="2.6" fill="${color}" stroke="var(--surface-1)" stroke-width="1.5"/>`).join("");
  const hover = data.map((d, i) => {
    const bw = plotW / n;
    return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" fill="transparent" class="has-tipm" data-tipm="${monthLabel(d.mk)}||Patrimônio:${d.patrimonio.toFixed(0)}||Aportes:${d.aportes.toFixed(0)}||Rendimento:${d.rend.toFixed(0)}"/>`;
  }).join("");
  const xlabels = data.map((d, i) => (n <= 8 || i % 2 === 0) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" font-size="9.5" fill="var(--ink-3)" text-anchor="middle">${monthLabel(d.mk)}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto" role="img" aria-label="Evolução do patrimônio">
    ${grid}
    <path d="${area}" fill="var(--s1)" opacity=".08"/>
    <path d="${mkLine("aportes")}" fill="none" stroke="var(--good)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${mkLine("rend")}" fill="none" stroke="var(--s7)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${patrimPath}" fill="none" stroke="var(--s1)" stroke-width="2.5" stroke-linejoin="round"/>
    ${dot("aportes","var(--good)")}${dot("rend","var(--s7)")}${dot("patrimonio","var(--s1)")}
    ${xlabels}${hover}</svg>`;
}

async function investAnaliseIA() {
  openModal(`<h3>Análise da carteira com IA</h3><div class="ai-box loading-dots" id="invAIout">Analisando sua carteira</div>
    <div class="modal-actions"><button class="btn secondary" id="mCancel">Fechar</button></div>`);
  $("#mCancel").onclick = closeModal;
  const s = investStats(), alloc = investAllocation();
  const carteira = alloc.map(([c, v]) => `${c}: ${fmtBRL0(v)} (${(v / (s.patrimonio || 1) * 100).toFixed(0)}%)`).join("; ");
  try {
    const reply = await callClaude({
      maxTokens: 1400,
      system: SYSTEM_ADVISOR + "\n\n" + financialContext(),
      messages: [{ role: "user", content: `Minha carteira de investimentos: patrimônio ${fmtBRL0(s.patrimonio)}, rentabilidade acumulada ${fmtBRL0(s.rend)} (${s.rentPct.toFixed(1)}%). Alocação: ${carteira || "vazia"}. Em texto curto: avalie a diversificação, aponte concentração de risco, e sugira o próximo passo de aporte considerando minha meta. Sem recomendar ativos específicos obscuros.` }]
    });
    const box = $("#invAIout"); if (box) { box.classList.remove("loading-dots"); box.textContent = ""; box.innerHTML = esc(reply); }
  } catch (e) { const box = $("#invAIout"); if (box) { box.classList.remove("loading-dots"); box.innerHTML = "⚠️ " + esc(e.message); } }
}

function investProjection(plan) {
  const next = 0.20; // próximo marco: 20% da meta
  if (plan.pmt <= 0 || plan.rate < 0) return "Continue aportando com consistência para acelerar sua meta.";
  const target = plan.goal * next;
  if (plan.current >= target) return `Você já passou de ${(next*100).toFixed(0)}% da meta. Próximo marco: ${(30)}% — mantenha o ritmo!`;
  // meses p/ atingir 20% com aportes constantes e juros compostos
  const r = plan.rate, fvNeeded = target;
  let m = 0, val = plan.current;
  while (val < fvNeeded && m < 600) { val = val * (1 + r) + plan.pmt; m++; }
  return `Se você mantiver o ritmo atual de aportes, pode atingir <b>${(next*100).toFixed(0)}% da meta</b> em aproximadamente <b>${m} meses</b>.`;
}

// ============================================================
// VIEW: PLANO 5 ANOS
// ============================================================
function viewPlano() {
  const p = planCalc();
  const renda = avgIncome();
  const pctRenda = renda > 0 ? p.pmt / renda * 100 : 0;
  return `
  <div class="view-head">
    <div><h2>🎯 Plano Milionário — ${SETTINGS.goalYears || 5} anos</h2>
    <div class="sub">Meta: ${fmtBRL0(p.goal)} até ${p.end.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</div></div>
    <button class="btn secondary" id="btnEditGoal">Ajustar meta</button>
  </div>

  <div class="card">
    <div style="font-size:13px; color:var(--ink-2)">Aporte mensal necessário a partir de agora</div>
    <div style="font-size:48px; font-weight:650; line-height:1.15; margin:4px 0">${fmtBRL0(p.pmt)}</div>
    <div class="muted">≈ ${pctRenda.toFixed(0)}% da sua renda média (${fmtBRL0(renda)}) · rendimento estimado de ${(p.rate*100).toFixed(2)}% a.m. · ${p.monthsLeft} meses restantes</div>
    <div class="meter good" style="margin-top:16px"><div style="width:${p.pct}%"></div></div>
    <div class="flex spread" style="margin-top:6px; font-size:13px; color:var(--ink-2)">
      <span>${fmtBRL0(p.current)} acumulados</span><span>${p.pct.toFixed(1)}%</span></div>
  </div>

  <div class="card section-gap chart-card">
    <h3>Projeção do patrimônio</h3>
    <div class="chart-sub">Se você aportar ${fmtBRL0(p.pmt)}/mês com rendimento de ${(p.rate*100).toFixed(2)}% a.m.</div>
    ${chartProjection(p)}
  </div>

  <div class="card section-gap">
    <div class="flex spread">
      <h3>🤖 Plano de ação com IA</h3>
      <button class="btn" id="btnPlanAI" ${hasAIKey() ? "" : "disabled"}>Gerar meu plano</button>
    </div>
    <p class="muted" style="margin-top:6px">A IA analisa sua renda, gastos, dívidas e investimentos reais e monta um plano personalizado, mês a mês, para chegar ao seu primeiro milhão.</p>
    <div id="planAIBox" class="section-gap hidden"></div>
  </div>`;
}

function chartProjection(p) {
  const W = 640, H = 240, padL = 10, padB = 26, padT = 14, padR = 70;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = p.monthsLeft;
  const pts = [];
  let v = p.current;
  pts.push(v);
  for (let m = 1; m <= n; m++) { v = v * (1 + p.rate) + p.pmt; pts.push(v); }
  const maxV = Math.max(p.goal, v) * 1.05;
  const x = i => padL + i / n * plotW;
  const y = val => padT + plotH - val / maxV * plotH;
  const path = pts.map((val, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(val).toFixed(1)).join(" ");
  const area = path + ` L${x(n)},${y(0)} L${x(0)},${y(0)} Z`;
  const gy = y(p.goal);
  const step = niceStep(maxV);
  let grid = "";
  for (let g = step; g <= maxV; g += step)
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}" stroke="var(--grid)"/>
      <text x="${padL}" y="${y(g)-4}" font-size="10" fill="var(--ink-3)">${compact(g)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto" role="img" aria-label="Projeção do patrimônio até a meta">
    ${grid}
    <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--baseline)"/>
    <line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="none" opacity=".8"/>
    <text x="${W - padR + 6}" y="${gy + 4}" font-size="11" fill="var(--good-text)" font-weight="600">Meta ${compact(p.goal)}</text>
    <path d="${area}" fill="var(--s1)" opacity=".10"/>
    <path d="${path}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(n)}" cy="${y(pts[n])}" r="4.5" fill="var(--s1)" stroke="var(--surface-1)" stroke-width="2"/>
    ${Math.abs(y(pts[n]) - gy) < 15
      ? `<text x="${W - padR + 6}" y="${gy + 18}" font-size="11" fill="var(--ink-2)" font-weight="600">${compact(pts[n])}</text>`
      : `<text x="${W - padR + 6}" y="${y(pts[n]) + 4}" font-size="11" fill="var(--ink-2)" font-weight="600">${compact(pts[n])}</text>`}
  </svg>`;
}

// ============================================================
// VIEW: ORÇAMENTO (PLANEJADO)
// ============================================================
// contas fixas mensais = boletos recorrentes ainda ativos (inclui parcelas de acordo)
function fixedBills() {
  return pendingBills().filter(b => b.recurring);
}
function fixedMonthlyTotal() {
  return fixedBills().reduce((a, b) => a + b.amount, 0);
}
function getBudgets() {
  const b = SETTINGS.budgets || {};
  return Object.entries(b).filter(([, v]) => +v > 0).map(([c, v]) => [c, +v]);
}
function budgetLevel(spent, limit) {
  if (!limit) return "good";
  const p = spent / limit * 100;
  return p > 100 ? "crit" : p >= 85 ? "warn" : "good";
}

function viewOrcamento() {
  const mk = todayISO().slice(0, 7);
  const renda = SETTINGS.incomeTarget || avgIncome();
  const fixas = fixedMonthlyTotal();
  const budgets = getBudgets();
  const budgetTotal = budgets.reduce((a, [, v]) => a + v, 0);
  const sobra = renda - fixas - budgetTotal;
  const spentByCat = Object.fromEntries(catSpend(mk));
  const spentBudgeted = budgets.reduce((a, [c]) => a + (spentByCat[c] || 0), 0);
  const now = new Date(), dayOfMonth = now.getDate(), daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPct = dayOfMonth / daysInMonth * 100;
  const ordered = [...budgets].sort((a, b) => (spentByCat[b[0]] || 0) / b[1] - (spentByCat[a[0]] || 0) / a[1]);
  const rowsShown = ordered.slice(0, 7);

  return `
  <div class="view-head">
    <div><h2>Orçamento do mês <span title="Planeje limites por categoria e acompanhe o gasto real." style="color:var(--ink-3); cursor:help; font-size:15px">ⓘ</span></h2>
      <div class="sub">Planeje seus gastos e acompanhe em tempo real</div></div>
    <div class="flex">
      <button class="btn secondary" id="btnBudgetAI" ${hasAIKey() ? "" : "disabled"}><span class="ico" data-ic="sparkles" style="width:16px;height:16px"></span> Sugerir com IA</button>
      <button class="btn" id="btnSetBudgets"><span class="ico" data-ic="settings" style="width:15px;height:15px"></span> Definir limites</button>
    </div>
  </div>

  <div class="bkpi-grid">
    <div class="bkpi"><div class="bk-label">Renda planejada <button class="icon-btn" id="btnSetBudgets2" title="Editar" style="padding:0">${icon("settings", 15)}</button></div>
      <div class="bk-val" style="color:var(--accent)">${fmtBRL(renda)}</div>
      <div class="bk-foot"><span class="ico">${icon("wallet")}</span> Ajuste em Configurações</div></div>
    <div class="bkpi"><div class="bk-label">Contas fixas</div>
      <div class="bk-val">${fmtBRL(fixas)}</div>
      <div class="bk-foot"><span class="ico">${icon("calendar")}</span> ${fixedBills().length} conta(s) recorrente(s)</div></div>
    <div class="bkpi"><div class="bk-label">Limites de gastos</div>
      <div class="bk-val">${fmtBRL(budgetTotal)}</div>
      <div class="bk-foot"><span class="ico">${icon("folder")}</span> ${budgets.length} categoria(s) com limite</div></div>
    <div class="bkpi"><div class="bk-label">Sobra p/ metas</div>
      <div class="bk-val" style="color:${sobra >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL(sobra)}</div>
      <div class="bk-foot"><span class="ico">${icon("target")}</span> ${sobra >= 0 ? "Disponível p/ investir/guardar" : "Acima da renda — reveja"}</div></div>
  </div>

  <div id="budgetAIBox" class="section-gap hidden"></div>

  <div class="bud-2col">
    <div class="panel">
      <div class="panel-head" style="margin-bottom:8px"><h3>Planejado × gasto real</h3>
        <span class="muted" style="display:inline-flex; align-items:center; gap:6px; font-size:12.5px">${icon("calendar", 15)} ${monthLabel(mk)} · dia ${dayOfMonth}/${daysInMonth}</span></div>
      ${budgets.length ? `
      <div class="flex" style="gap:16px; margin:4px 0 16px; font-size:13.5px; flex-wrap:wrap">
        <span>Limite total: <b>${fmtBRL(budgetTotal)}</b></span>
        <span style="color:var(--ink-3)">|</span>
        <span>Gasto até agora: <b style="color:${spentBudgeted > budgetTotal ? "var(--critical)" : "var(--good-text)"}">${fmtBRL(spentBudgeted)}</b></span>
        <span style="color:var(--ink-3)">|</span>
        <span>Restante: <b style="color:var(--accent)">${fmtBRL(Math.max(0, budgetTotal - spentBudgeted))}</b></span>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px">
        ${rowsShown.map(([c, limit]) => {
          const spent = spentByCat[c] || 0, pct = limit ? spent / limit * 100 : 0, lvl = budgetLevel(spent, limit), over = spent > limit;
          const pill = over ? '<span class="status-pill crit">estourou</span>' : pct >= 85 ? '<span class="status-pill warn">atenção</span>' : '<span class="status-pill good">dentro</span>';
          return `<button class="bud-row cat-row" data-cat-detail="${esc(c)}" style="text-align:left">
            <div class="br-head">
              <span class="br-ic">${icon(catIcon(c))}</span>
              <span class="br-name">${esc(c)}</span> ${pill}
              <span class="br-vals">${fmtBRL(spent)} <span class="muted">/ ${fmtBRL(limit)}</span></span>
            </div>
            <div class="meter ${lvl}"><div style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
            <div class="br-sub">${over ? `passou ${fmtBRL(spent - limit)} do limite` : `restam ${fmtBRL(limit - spent)}`} · ${pct.toFixed(0)}% do limite</div>
          </button>`;
        }).join("")}
      </div>
      ${ordered.length > 7 ? `<div style="text-align:center; margin-top:14px"><button class="panel-link" id="btnSetBudgets3">Ver todas as categorias</button></div>` : ""}`
      : `<div class="empty"><span class="big">🧮</span>Você ainda não definiu limites de gastos.<br>Clique em <b>Definir limites</b> ou peça uma <b>sugestão à IA</b>.</div>`}
    </div>

    <div>
      <div class="panel">
        <h3 style="margin-bottom:14px">Distribuição dos gastos</h3>
        ${budgetDonut([mk])}
        <button class="btn secondary small" data-goto="transacoes" style="width:100%; justify-content:center; margin-top:14px">Ver análise completa →</button>
      </div>
      <div class="panel" style="margin-top:16px">
        <h3 style="margin-bottom:14px">Alertas do orçamento</h3>
        ${budgetAlerts(budgets, spentByCat, budgetTotal, spentBudgeted)}
      </div>
    </div>
  </div>

  ${budgets.length ? budgetInsightBanner(budgetTotal, spentBudgeted, monthPct) : ""}`;
}

function budgetDonut(mks) {
  const all = catSpendMonths(mks);
  const total = all.reduce((a, [, v]) => a + v, 0);
  if (!total) return `<div class="empty" style="padding:24px 10px"><span class="big">🍃</span>Nenhum gasto no mês.</div>`;
  const top = all.slice(0, 5), restV = all.slice(5).reduce((a, [, v]) => a + v, 0);
  const items = restV > 0 ? [...top, ["Outros", restV]] : top;
  const cols = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s7)", "var(--s5)", "var(--baseline)"];
  const cx = 80, cy = 80, R = 72, r = 48; let a0 = -90, paths = "";
  items.forEach(([, v], i) => {
    const a1 = a0 + v / total * 360, large = (a1 - a0) > 180 ? 1 : 0;
    const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1), [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
    paths += `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} A${r} ${r} 0 ${large} 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${cols[i % cols.length]}" stroke="var(--surface-1)" stroke-width="2.5"/>`;
    a0 = a1;
  });
  const donut = `<svg viewBox="0 0 160 160" width="150" height="150" style="flex-shrink:0">${paths}
    <text x="80" y="78" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink-1)">${fmtBRL0(total)}</text>
    <text x="80" y="94" text-anchor="middle" font-size="10" fill="var(--ink-3)">gasto total</text></svg>`;
  const legend = `<div class="donut-legend">${items.map(([c, v], i) => `
    <button class="dl-row cat-row" data-cat-detail="${esc(c)}" style="display:grid">
      <span class="dl-dot" style="background:${cols[i % cols.length]}"></span>
      <span style="text-align:left">${esc(c)}</span>
      <span class="dl-pct">${(v / total * 100).toFixed(1)}%</span>
      <span class="dl-val">${fmtBRL0(v)}</span>
    </button>`).join("")}</div>`;
  return `<div class="flex" style="gap:14px; align-items:center; flex-wrap:wrap; justify-content:center">${donut}${legend}</div>`;
}

function budgetAlerts(budgets, spentByCat, budgetTotal, spentBudgeted) {
  if (!budgets.length) return `<div class="muted" style="font-size:13px">Defina limites para receber alertas do orçamento.</div>`;
  const out = [];
  const estourou = budgets.filter(([c, l]) => (spentByCat[c] || 0) > l);
  const perto = budgets.filter(([c, l]) => (spentByCat[c] || 0) <= l && (spentByCat[c] || 0) / l >= 0.85);
  const dentro = budgets.filter(([c, l]) => (spentByCat[c] || 0) / l < 0.85).length;
  estourou.slice(0, 2).forEach(([c, l]) => out.push(`<div class="bud-alert warn"><span class="ba-ic">${icon("alert")}</span>
    <div class="ba-b"><div class="ba-t">${esc(c)} estourou o limite</div><div class="ba-d">${fmtBRL(spentByCat[c])} de ${fmtBRL(l)} · ${fmtBRL(spentByCat[c]-l)} acima</div></div>
    <button class="btn secondary small" data-cat-detail="${esc(c)}">Ver detalhes</button></div>`));
  perto.slice(0, 2).forEach(([c, l]) => out.push(`<div class="bud-alert warn"><span class="ba-ic">${icon("alert")}</span>
    <div class="ba-b"><div class="ba-t">${esc(c)} está em ${((spentByCat[c]||0)/l*100).toFixed(0)}% do limite</div><div class="ba-d">Faltam ${fmtBRL(l-(spentByCat[c]||0))} para atingir o limite</div></div>
    <button class="btn secondary small" data-cat-detail="${esc(c)}">Ver detalhes</button></div>`));
  if (dentro > 0) out.push(`<div class="bud-alert info"><span class="ba-ic">${icon("activity")}</span>
    <div class="ba-b"><div class="ba-t">Muito bem! ${dentro} categoria(s) dentro do planejado</div><div class="ba-d">Continue assim para alcançar suas metas 💪</div></div></div>`);
  const restante = budgetTotal - spentBudgeted;
  if (restante > 0) out.push(`<div class="bud-alert pos"><span class="ba-ic">${icon("check")}</span>
    <div class="ba-b"><div class="ba-t">Você ainda tem ${fmtBRL(restante)} de limite disponível</div><div class="ba-d">Aproveite para investir ou guardar</div></div>
    <button class="btn secondary small" data-goto="investimentos">${icon("more", 16)}</button></div>`);
  return out.join("") || `<div class="muted" style="font-size:13px">Tudo dentro do planejado. 🎉</div>`;
}

function budgetInsightBanner(budgetTotal, spentBudgeted, monthPct) {
  const expected = budgetTotal * monthPct / 100;
  const projected = monthPct > 0 ? spentBudgeted / (monthPct / 100) : spentBudgeted;
  const leftover = budgetTotal - projected;
  let msg;
  if (expected > 0 && spentBudgeted < expected * 0.97) {
    const pct = ((expected - spentBudgeted) / expected * 100).toFixed(0);
    msg = `Seus gastos estão <b>${pct}% abaixo do planejado</b> até agora.${leftover > 0 ? ` Se mantiver esse ritmo, você poderá guardar cerca de <b>${fmtBRL0(leftover)}</b> a mais neste mês.` : ""}`;
  } else if (spentBudgeted > expected * 1.03) {
    const pct = ((spentBudgeted - expected) / expected * 100).toFixed(0);
    msg = `Seus gastos estão <b>${pct}% acima do ritmo planejado</b>. Segure um pouco para não estourar o orçamento no fim do mês.`;
  } else {
    msg = `Seus gastos estão <b>no ritmo do planejado</b>. Continue acompanhando para bater suas metas.`;
  }
  return `<div class="insight-banner">
    <span class="ib-ic">${icon("sparkles")}</span>
    <div class="ib-b"><div class="ib-t">Insight do mês</div><div class="ib-d">${msg}</div></div>
    <button class="btn" id="btnBudgetAI2" ${hasAIKey() ? "" : "disabled"}>Ver sugestão completa</button>
  </div>`;
}

function modalBudgets() {
  const cur = SETTINGS.budgets || {};
  const discretionary = ["Alimentação", "Lazer", "Assinaturas", "Vestuário", "Transporte", "Mercado", "Pet"];
  const ordered = [...discretionary, ...catsOut().filter(c => !discretionary.includes(c))];
  openModal(`
    <h3>Definir limites de gastos</h3>
    <p class="muted" style="margin:-8px 0 14px">Defina um teto mensal por categoria. Deixe em branco (ou 0) as que não quer limitar. As de estilo de vida estão no topo.</p>
    <div class="field"><label>Renda planejada do mês (R$)</label>
      <input id="uIncome" inputmode="decimal" value="${String(SETTINGS.incomeTarget || 17500).replace(".", ",")}"></div>
    <div style="max-height:44vh; overflow-y:auto; padding-right:4px">
      ${ordered.map(c => `
      <div class="flex spread" style="padding:6px 0; border-bottom:1px solid var(--grid)">
        <label style="font-size:14px; margin:0">${esc(c)}</label>
        <input class="bud-inp" data-cat="${esc(c)}" inputmode="decimal" placeholder="0,00"
          value="${cur[c] ? String(cur[c]).replace(".", ",") : ""}"
          style="width:120px; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--page); text-align:right">
      </div>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Salvar orçamento</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const budgets = {};
    document.querySelectorAll(".bud-inp").forEach(i => { budgets[i.dataset.cat] = parseMoney(i.value); });
    try {
      await setDoc(doc(db, "households", hid, "meta", "settings"), {
        incomeTarget: parseMoney($("#uIncome").value) || (SETTINGS.incomeTarget || 17500),
        budgets
      }, { merge: true });
      closeModal(); toast("Orçamento salvo!");
    } catch (e) { toast("Erro: " + e.message); }
  };
}

async function budgetSuggestAI() {
  const box = $("#budgetAIBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ai-box loading-dots">🤖 Analisando seus gastos e montando um orçamento</div>`;
  try {
    const raw = await callClaude({
      maxTokens: 1500,
      system: `Você é um consultor financeiro brasileiro. Com base nos dados reais do usuário, proponha limites mensais de gastos por categoria seguindo a lógica 50/30/20 e o padrão de gastos dele. Categorias válidas: ${catsOut().join(", ")}. Considere que as contas fixas recorrentes já estão comprometidas. Responda APENAS com JSON válido, sem markdown:
{"resumo":"2-3 frases explicando a lógica e onde ele pode cortar","budgets":{"Categoria":valor_numerico, ...}}
Inclua no budgets só categorias de gasto variável que fazem sentido limitar (ex.: Alimentação, Lazer, Assinaturas, Mercado, Transporte, Vestuário). Valores realistas para a renda dele.`,
      messages: [{ role: "user", content: "Monte um orçamento mensal de limites por categoria para mim." }]
    });
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const b = json.budgets || {};
    box.innerHTML = `<div class="card" style="border-color:var(--accent)">
      <h3>🤖 Sugestão de orçamento</h3>
      <p style="margin:6px 0 12px">${esc(json.resumo || "")}</p>
      <div class="table-wrap"><table><tbody>
      ${Object.entries(b).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num"><b>${fmtBRL(+v)}</b></td></tr>`).join("")}
      <tr><td><b>Total dos limites</b></td><td class="num"><b>${fmtBRL(Object.values(b).reduce((a,v)=>a+ +v,0))}</b></td></tr>
      </tbody></table></div>
      <div class="flex section-gap">
        <button class="btn" id="btnApplyBudget">✅ Aplicar estes limites</button>
        <button class="btn secondary" id="btnCloseBudgetAI">Descartar</button>
      </div></div>`;
    $("#btnCloseBudgetAI").onclick = () => box.classList.add("hidden");
    $("#btnApplyBudget").onclick = async () => {
      const clean = {};
      Object.entries(b).forEach(([c, v]) => { if (catsOut().includes(c) && +v > 0) clean[c] = +v; });
      await setDoc(doc(db, "households", hid, "meta", "settings"), { budgets: clean }, { merge: true });
      box.classList.add("hidden");
      toast("✅ Limites aplicados! Veja o planejado × real.");
    };
  } catch (e) {
    box.innerHTML = `<div class="ai-box" style="background:rgba(208,59,59,.1)">⚠️ ${esc(e.message)}</div>`;
  }
}

// ============================================================
// VIEW: SAÚDE FINANCEIRA (score + insights)
// ============================================================
function gaugeSVG(total, band) {
  const r = 56, c = 2 * Math.PI * r, off = c * (1 - total / 100), col = scoreColor(band);
  return `<div class="gauge"><svg viewBox="0 0 132 132" width="132" height="132">
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--grid)" stroke-width="11"/>
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="${col}" stroke-width="11" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 66 66)"/>
  </svg><div class="g-num"><b style="color:${col}">${total}</b><span>de 100</span></div></div>`;
}
function scoreBreakdownHTML(sc) {
  return sc.parts.map(p => {
    const pct = Math.max(2, p.score / p.max * 100);
    const col = p.level === "good" ? "var(--good)" : p.level === "warn" ? "var(--warning)" : p.level === "crit" ? "var(--critical)" : "var(--accent)";
    return `<div class="sb-row">
      <div class="flex spread"><span><b>${esc(p.label)}</b> <span class="muted">· ${esc(p.detail)}</span></span>
        <b style="font-variant-numeric:tabular-nums">${Math.round(p.score)}/${p.max}</b></div>
      <div class="meter"><div style="width:${pct.toFixed(0)}%; background:${col}"></div></div>
    </div>`;
  }).join("");
}
function viewSaude() {
  const sc = financialScore();
  const insights = generateInsights();
  const col = scoreColor(sc.band);
  return `
  <div class="view-head">
    <div><h2>Saúde financeira</h2><div class="sub">Uma nota de 0 a 100 — e exatamente de onde ela vem</div></div>
    <button class="btn" id="btnScoreAI" ${hasAIKey() ? "" : "disabled"}><span class="ico" data-ic="sparkles" style="width:16px;height:16px"></span> Analisar com IA</button>
  </div>

  <div class="card">
    <div class="gauge-wrap">
      ${gaugeSVG(sc.total, sc.band)}
      <div class="score-bars">
        <div class="flex" style="gap:10px; margin-bottom:4px"><span class="pill" style="background:${col}22; color:${col}">${sc.band.lbl}</span>
          <span class="muted">${sc.total >= 80 ? "Você está no caminho certo." : sc.total >= 60 ? "Bom, com pontos a melhorar." : sc.total >= 40 ? "Precisa de ajustes." : "Requer atenção imediata."}</span></div>
        ${scoreBreakdownHTML(sc)}
      </div>
    </div>
    <p class="muted" style="margin-top:14px; font-size:12.5px">Cálculo transparente: Economia (25) + Controle de gastos (20) + Dívidas sob controle (20) + Investindo (20) + Contas em dia (15). Cada barra mostra sua nota e o motivo.</p>
    <div id="scoreAIBox" class="section-gap hidden"></div>
  </div>

  <div class="card section-gap">
    <h3>Insights</h3>
    <div class="chart-sub">O que os seus números estão dizendo agora</div>
    ${insights.length ? `<div style="display:flex; flex-direction:column; gap:10px; margin-top:12px">
      ${insights.map(i => `<div class="insight">
        <span class="i-ic">${icon(i.icon)}</span>
        <div class="i-body"><div class="i-t"><b>${esc(i.title)}</b></div><div class="i-d">${esc(i.detail)}</div></div>
        ${i.goto ? `<button class="btn secondary small" data-goto="${i.goto}" style="align-self:center">Ver</button>` : ""}
      </div>`).join("")}</div>`
      : `<div class="empty"><span class="big">🌱</span>Registre mais transações para gerar insights.</div>`}
  </div>`;
}
async function scoreAnaliseIA() {
  const box = $("#scoreAIBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ai-box loading-dots">Analisando sua saúde financeira</div>`;
  const sc = financialScore();
  const resumo = sc.parts.map(p => `${p.label}: ${Math.round(p.score)}/${p.max} (${p.detail})`).join("; ");
  try {
    const reply = await callClaude({
      maxTokens: 1200,
      system: SYSTEM_ADVISOR + "\n\n" + financialContext(),
      messages: [{ role: "user", content: `Meu score de saúde financeira é ${sc.total}/100 (${sc.band.lbl}). Composição: ${resumo}. Em texto curto: quais 2-3 ações concretas mais elevam meu score no próximo mês, na ordem de impacto? Seja específico com valores.` }]
    });
    box.innerHTML = `<div class="ai-box">${esc(reply)}</div>`;
  } catch (e) { box.innerHTML = `<div class="ai-box" style="background:rgba(208,59,59,.1)">⚠️ ${esc(e.message)}</div>`; }
}

// ============================================================
// VIEW: CONSULTOR IA
// ============================================================
function viewConsultor() {
  const hasKey = hasAIKey();
  return `
  <div class="view-head">
    <div><h2>🤖 Consultor Financeiro IA</h2><div class="sub">Decisões com base nos seus números reais</div></div>
  </div>
  ${hasKey ? "" : `<div class="card" style="margin-bottom:14px; border-color:var(--warning)">
    ⚠️ Configure sua <b>chave da API Claude</b> em <a href="#" data-goto="config">Configurações</a> para conversar com o consultor.</div>`}
  <div class="card">
    <div id="chatLog">${chatHistory.length ? chatHistory.map(m =>
      `<div class="msg ${m.role === "user" ? "user" : "ai"}">${esc(m.content)}</div>`).join("") :
      `<div class="empty"><span class="big">💬</span>Pergunte qualquer coisa sobre suas finanças.<br>
      O consultor conhece suas entradas, saídas, dívidas, investimentos e sua meta.</div>`}</div>
    <div class="flex" style="gap:8px; margin-bottom:10px; overflow-x:auto; flex-wrap:nowrap; padding-bottom:2px">
      <button class="chip sug" style="border:none">Vale a pena quitar dívida ou investir?</button>
      <button class="chip sug" style="border:none">Onde estou gastando demais?</button>
      <button class="chip sug" style="border:none">Como acelerar minha meta do milhão?</button>
    </div>
    <div class="chat-input">
      <textarea id="chatText" placeholder="Ex.: Posso assumir uma parcela de R$ 800/mês?" rows="1"></textarea>
      <button class="btn" id="btnSend" ${hasKey ? "" : "disabled"}>Enviar</button>
    </div>
  </div>`;
}

// ============================================================
// VIEW: CONFIGURAÇÕES
// ============================================================
function viewConfig() {
  const members = HOUSEHOLD.members || [];
  const key = aiKey();
  const keyShared = !!SETTINGS.claudeKey;
  return `
  <div class="view-head"><div><h2>Configurações</h2></div></div>

  <div class="card">
    <h3>💡 Parâmetros financeiros</h3>
    <div class="form-row section-gap">
      <div class="field"><label>Meta de renda mensal (R$)</label>
        <input id="cfgIncome" value="${SETTINGS.incomeTarget ?? 17500}"></div>
      <div class="field"><label>% da renda para investir</label>
        <input id="cfgInvestPct" type="number" min="0" max="80" value="${SETTINGS.investPct ?? 20}"></div>
      <div class="field"><label>% máx. da renda para dívidas</label>
        <input id="cfgDebtPct" type="number" min="5" max="60" value="${SETTINGS.debtPct ?? 30}"></div>
      <div class="field"><label>Rendimento estimado (% ao mês)</label>
        <input id="cfgReturn" type="number" step="0.05" value="${SETTINGS.expReturn ?? 0.8}"
        ><span class="hint">CDI hoje rende ≈ 0,8–1,1% a.m. Seja conservador.</span></div>
    </div>
    <button class="btn" id="btnSaveCfg">Salvar parâmetros</button>
  </div>

  <div class="card section-gap">
    <h3>👥 Quem usa este painel</h3>
    <p class="muted" style="margin:6px 0 12px">Pessoas com acesso total aos dados (login Google com o e-mail cadastrado).</p>
    ${members.map(m => `<div class="flex spread" style="padding:7px 0; border-bottom:1px solid var(--grid)">
      <span>${esc(m)}${m === HOUSEHOLD.owner ? ' <span class="chip">dono</span>' : ""}</span>
      ${m !== user.email && user.email === HOUSEHOLD.owner ? `<button class="icon-btn" data-rm-member="${esc(m)}">🗑️</button>` : ""}
    </div>`).join("")}
    <div class="flex section-gap">
      <input id="newMember" placeholder="email@gmail.com" style="flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:var(--page)">
      <button class="btn secondary" id="btnAddMember">Convidar</button>
    </div>
  </div>

  <div class="card section-gap">
    <h3>🏷️ Categorias personalizadas</h3>
    <p class="muted" style="margin:6px 0 12px">Crie suas próprias categorias — elas aparecem nas transações, boletos e orçamento. As padrão do sistema não podem ser removidas.</p>
    <div class="two-col grid">
      <div>
        <div class="muted" style="font-weight:600; margin-bottom:6px">Saídas</div>
        ${(SETTINGS.customCatsOut || []).length ? (SETTINGS.customCatsOut || []).map(c => `
          <div class="flex spread" style="padding:6px 0; border-bottom:1px solid var(--grid)">
            <span class="chip">${esc(c)}</span><button class="icon-btn" data-rm-cat-out="${esc(c)}">🗑️</button></div>`).join("")
          : `<div class="muted" style="font-size:13px">Nenhuma personalizada ainda.</div>`}
        <div class="flex" style="margin-top:10px">
          <input id="newCatOut" placeholder="Ex.: Pet, Viagem, Filhos" style="flex:1; padding:9px 11px; border-radius:9px; border:1px solid var(--border); background:var(--page)">
          <button class="btn secondary small" id="btnAddCatOut">Adicionar</button>
        </div>
      </div>
      <div>
        <div class="muted" style="font-weight:600; margin-bottom:6px">Entradas</div>
        ${(SETTINGS.customCatsIn || []).length ? (SETTINGS.customCatsIn || []).map(c => `
          <div class="flex spread" style="padding:6px 0; border-bottom:1px solid var(--grid)">
            <span class="chip">${esc(c)}</span><button class="icon-btn" data-rm-cat-in="${esc(c)}">🗑️</button></div>`).join("")
          : `<div class="muted" style="font-size:13px">Nenhuma personalizada ainda.</div>`}
        <div class="flex" style="margin-top:10px">
          <input id="newCatIn" placeholder="Ex.: Aluguel recebido, Bônus" style="flex:1; padding:9px 11px; border-radius:9px; border:1px solid var(--border); background:var(--page)">
          <button class="btn secondary small" id="btnAddCatIn">Adicionar</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card section-gap">
    <h3>🤖 Inteligência Artificial (Claude)</h3>
    <p class="muted" style="margin:6px 0 12px">Crie sua chave em <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> → API Keys. ${keyShared ? '<b>A chave está compartilhada</b> com todos que você autorizou — eles usam a IA sem precisar configurar nada.' : "Marque a opção abaixo para compartilhar a chave com quem você autorizar."}</p>
    <div class="field"><label>Chave da API (sk-ant-...)</label>
      <input id="cfgApiKey" type="password" value="${esc(key)}" placeholder="sk-ant-api03-..."></div>
    <div class="field" style="flex-direction:row; align-items:center; gap:9px">
      <input type="checkbox" id="cfgShareKey" style="width:18px; height:18px" ${keyShared ? "checked" : ""}>
      <label for="cfgShareKey" style="margin:0">Compartilhar a chave com os usuários autorizados</label>
    </div>
    <p class="muted" style="font-size:12px; margin:-4px 0 12px">Quando compartilhada, a chave é gravada no banco de dados do seu painel — protegido pelas regras do Firestore, acessível só aos e-mails que você liberou. Sem marcar, ela fica só neste dispositivo.</p>
    <div class="field"><label>Modelo</label>
      <select id="cfgModel">
        ${["claude-sonnet-4-5","claude-haiku-4-5","claude-opus-4-1"].map(m =>
          `<option ${(SETTINGS.model || "claude-sonnet-4-5") === m ? "selected" : ""}>${m}</option>`).join("")}
      </select><span class="hint">Sonnet = equilíbrio ideal. Haiku = mais barato. Opus = análises mais profundas.</span></div>
    <div class="flex">
      <button class="btn" id="btnSaveKey">Salvar chave</button>
      <button class="btn secondary" id="btnTestKey">Testar conexão</button>
    </div>
  </div>

  <div class="card section-gap">
    <h3>📦 Dados</h3>
    <p class="muted" style="margin:6px 0 4px">Importe dívidas, boletos e transações de um arquivo JSON no formato <code>{"dividas":[...], "boletos":[...], "transacoes":[...]}</code>.</p>
    <div class="flex section-gap">
      <button class="btn secondary" id="btnExport">Exportar tudo (JSON)</button>
      <button class="btn secondary" id="btnImport">Importar dados (JSON)</button>
      <input type="file" id="importFile" accept=".json,application/json" class="hidden">
    </div>
    <div id="importStatus" class="muted section-gap"></div>
  </div>`;
}

// ============================================================
// MODAIS (transação, dívida, investimento, meta)
// ============================================================
function openModal(html) {
  $("#modalBack").classList.remove("as-sheet");
  $("#modalBox").innerHTML = html;
  $("#modalBack").classList.remove("hidden");
  fillIcons($("#modalBox"));
}
function closeModal() { $("#modalBack").classList.add("hidden"); $("#modalBack").classList.remove("as-sheet"); }

// ---------- Action sheet (bottom sheet no mobile) ----------
function openSheet(title, items) {
  $("#modalBox").innerHTML = `
    <h3 style="margin-bottom:14px">${esc(title)}</h3>
    <div class="sheet-list">
      ${items.map((it, i) => `<button class="sheet-item ${it.tone || ""}" data-sheet-i="${i}">
        <span class="s-ic">${icon(it.icon)}</span>
        <span class="s-tx"><b>${esc(it.label)}</b>${it.desc ? `<span>${esc(it.desc)}</span>` : ""}</span>
      </button>`).join("")}
    </div>
    <div class="modal-actions" style="margin-top:8px"><button class="btn secondary" id="sheetCancel">Cancelar</button></div>`;
  $("#modalBack").classList.add("as-sheet");
  $("#modalBack").classList.remove("hidden");
  $("#sheetCancel").onclick = closeModal;
  items.forEach((it, i) => { const b = $(`[data-sheet-i="${i}"]`); if (b) b.onclick = () => { closeModal(); it.onClick(); }; });
}
function navAction(action) {
  if (action === "lancar") return openSheet("O que você quer lançar?", [
    { icon: "trend-down", tone: "out", label: "Despesa", desc: "Um gasto que você fez", onClick: () => modalTx(null, { type: "saida" }) },
    { icon: "trend-up", tone: "in", label: "Receita", desc: "Um dinheiro que entrou", onClick: () => modalTx(null, { type: "entrada" }) },
    { icon: "camera", label: "Ler comprovante", desc: "IA registra por foto", onClick: () => switchView("comprovante") },
    { icon: "file", label: "Conta / boleto", desc: "A pagar, com vencimento", onClick: () => modalBill() },
    { icon: "coins", label: "Investimento", desc: "Aporte ou resgate", onClick: () => modalInvest() },
  ]);
  if (action === "planejar") return openSheet("Planejamento", [
    { icon: "pie", label: "Orçamento", desc: "Limites e gastos do mês", onClick: () => switchView("orcamento") },
    { icon: "trend-down", label: "Dívidas", desc: "Negociar e quitar", onClick: () => switchView("dividas") },
    { icon: "trend-up", label: "Investimentos", desc: "Sua carteira", onClick: () => switchView("investimentos") },
    { icon: "target", label: "Meta 5 anos", desc: "Rumo ao milhão", onClick: () => switchView("plano") },
    { icon: "heart", label: "Saúde financeira", desc: "Seu score", onClick: () => switchView("saude") },
  ]);
  if (action === "mais") return openSheet("Mais", [
    { icon: "file", label: "Contas & Boletos", onClick: () => switchView("boletos") },
    { icon: "camera", label: "Ler comprovante", onClick: () => switchView("comprovante") },
    { icon: "sparkles", label: "Consultor IA", onClick: () => switchView("consultor") },
    { icon: "settings", label: "Configurações", onClick: () => switchView("config") },
  ]);
}

function modalTx(tx = null, prefill = null) {
  const t = tx || prefill || {};
  const type = t.type || "saida";
  openModal(`
    <h3>${tx ? "Editar" : "Nova"} transação</h3>
    <div class="seg" style="margin-bottom:14px" id="segType">
      <button data-t="entrada" class="${type === "entrada" ? "active in" : ""}">↑ Entrada</button>
      <button data-t="saida" class="${type === "saida" ? "active out" : ""}">↓ Saída</button>
    </div>
    <div class="form-row">
      <div class="field"><label>Valor (R$)</label><input id="mAmount" inputmode="decimal" value="${t.amount != null ? String(t.amount).replace(".", ",") : ""}" placeholder="0,00"></div>
      <div class="field"><label>Data</label><input id="mDate" type="date" value="${t.date || todayISO()}"></div>
    </div>
    <div class="field"><label>Descrição</label><input id="mDesc" value="${esc(t.desc || "")}" placeholder="Ex.: Supermercado Pão de Açúcar"></div>
    <div class="form-row">
      <div class="field"><label>Categoria <button type="button" id="mAddCat" class="link-btn" style="float:right; font-weight:600">+ nova</button></label><select id="mCat"></select></div>
      <div class="field"><label>Forma</label><select id="mMethod">${METHODS.map(m => `<option ${t.method === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    </div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">${tx ? "Salvar" : "Registrar"}</button>
    </div>`);
  let curType = type;
  const fillCats = (selected) => {
    const list = curType === "entrada" ? catsIn() : catsOut();
    const sel = selected || t.category;
    $("#mCat").innerHTML = list.map(c => `<option ${sel === c ? "selected" : ""}>${c}</option>`).join("");
  };
  fillCats();
  $("#mAddCat").onclick = async () => {
    const nm = prompt(`Nome da nova categoria de ${curType === "entrada" ? "entrada" : "saída"}:`);
    if (nm && await addCustomCat(curType, nm)) fillCats(nm.trim());
  };
  $("#segType").querySelectorAll("button").forEach(b => b.onclick = () => {
    curType = b.dataset.t;
    $("#segType").querySelectorAll("button").forEach(x => x.className = "");
    b.className = "active " + (curType === "entrada" ? "in" : "out");
    fillCats();
  });
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const amount = parseMoney($("#mAmount").value);
    if (!amount) return toast("Informe o valor.");
    const data = {
      type: curType, amount, date: $("#mDate").value || todayISO(),
      desc: $("#mDesc").value.trim(), category: $("#mCat").value, method: $("#mMethod").value,
      createdBy: user.email, createdAt: new Date().toISOString(),
      ...(prefill?.aiRead ? { aiRead: true } : {})
    };
    try {
      if (tx) await updateDoc(doc(db, "households", hid, "transactions", tx.id), data);
      else await addDoc(collection(db, "households", hid, "transactions"), data);
      closeModal(); toast(curType === "entrada" ? "💚 Entrada registrada!" : "Saída registrada!");
    } catch (e) { toast("Erro: " + e.message); }
  };
}

function modalDebt(d = null) {
  const t = d || {};
  openModal(`
    <h3>${d ? "Editar" : "Nova"} dívida</h3>
    <div class="field"><label>Credor / nome</label><input id="dName" value="${esc(t.name || "")}" placeholder="Ex.: Cartão Nubank, Financiamento carro"></div>
    <div class="form-row">
      <div class="field"><label>Valor total atual (R$)</label><input id="dTotal" inputmode="decimal" value="${t.currentValue ?? t.total ?? ""}"></div>
      <div class="field"><label>Já pago (R$)</label><input id="dPaid" inputmode="decimal" value="${t.paid ?? 0}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Parcela mensal (R$)</label><input id="dMonthly" inputmode="decimal" value="${t.monthlyPayment ?? ""}">
        <span class="hint">Ao salvar, o app oferece criar essas parcelas nos Boletos</span></div>
      <div class="field"><label>Juros % a.m. (se souber)</label><input id="dInterest" type="number" step="0.1" value="${t.interest ?? ""}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Status</label><select id="dStatus">
        ${["em dia","atrasada","negociando","acordo","quitada"].map(s => `<option ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label>Dia de vencimento</label><input id="dDue" type="number" min="1" max="31" value="${t.dueDay ?? ""}"></div>
    </div>
    <div class="field"><label>Observações</label><input id="dNote" value="${esc(t.note || "")}"></div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Salvar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const name = $("#dName").value.trim();
    if (!name) return toast("Dê um nome à dívida.");
    const monthly = parseMoney($("#dMonthly").value);
    const data = {
      name, currentValue: parseMoney($("#dTotal").value), total: parseMoney($("#dTotal").value),
      paid: parseMoney($("#dPaid").value), monthlyPayment: monthly,
      interest: $("#dInterest").value ? +$("#dInterest").value : null,
      status: $("#dStatus").value, dueDay: $("#dDue").value ? +$("#dDue").value : null,
      note: $("#dNote").value.trim(), updatedAt: new Date().toISOString()
    };
    try {
      let debtId;
      if (d) { await updateDoc(doc(db, "households", hid, "debts", d.id), data); debtId = d.id; }
      else { const ref = await addDoc(collection(db, "households", hid, "debts"), data); debtId = ref.id; }
      closeModal(); toast("Dívida salva.");
      // oferecer gerar as parcelas nos Boletos (se houver parcela e ainda não existir boleto vinculado)
      const jaTem = BILLS.some(b => b.debtId === debtId && !["pago", "encerrado", "convertido"].includes(b.status));
      if (monthly > 0 && data.status !== "quitada" && !jaTem) {
        const rest = Math.max(0, data.currentValue - data.paid);
        const n = rest > 0 ? Math.ceil(rest / monthly) : 12;
        if (confirm(`Criar as parcelas de ${fmtBRL(monthly)}/mês de "${name}" em Boletos & Contas? Serão ${n} parcela(s) e cada pagamento abate a dívida automaticamente.`)) {
          const dd = data.dueDay || 10;
          const now = new Date();
          const firstDue = new Date(now.getFullYear(), now.getMonth() + (now.getDate() > dd ? 1 : 0), dd);
          await addDoc(collection(db, "households", hid, "bills"), {
            name, amount: monthly, dueDate: isoLocal(firstDue), category: "Dívidas",
            recurring: n > 1, totalTimes: n > 1 ? n : null, paidTimes: 0, dda: false,
            status: "pendente", debtId, createdBy: user.email
          });
          await updateDoc(doc(db, "households", hid, "debts", debtId), { status: "acordo" });
          toast(`📄 ${n} parcela(s) criadas em Boletos & Contas!`);
        }
      }
    } catch (e) { toast("Erro: " + e.message); }
  };
}

function modalNegotiate(d) {
  const restante = Math.max(0, (d.currentValue ?? d.total) - (d.paid || 0));
  const nextMonth10 = (() => { const t = new Date(); return isoLocal(new Date(t.getFullYear(), t.getMonth() + 1, 10)); })();
  openModal(`
    <h3>🤝 Negociar — ${esc(d.name)}</h3>
    <p class="muted" style="margin:-8px 0 14px">Valor em aberto hoje: <b>${fmtBRL(restante)}</b>. Preencha as condições fechadas com o credor — o acordo vira parcelas em Boletos & Contas e cada pagamento abate esta dívida automaticamente.</p>
    <div class="form-row">
      <div class="field"><label>Valor total do acordo (R$)</label>
        <input id="nTotal" inputmode="decimal" value="${String(restante.toFixed(2)).replace(".", ",")}">
        <span class="hint">Com o desconto que você conseguiu</span></div>
      <div class="field"><label>Entrada (R$, opcional)</label>
        <input id="nEntry" inputmode="decimal" value="0"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Nº de parcelas (sem contar a entrada)</label>
        <input id="nTimes" type="number" min="1" max="240" value="12"></div>
      <div class="field"><label>Vencimento da 1ª parcela</label>
        <input id="nFirst" type="date" value="${nextMonth10}"></div>
    </div>
    <div class="ai-box" id="nPreview" style="margin-bottom:14px"></div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Fechar acordo</button>
    </div>`);
  const preview = () => {
    const tot = parseMoney($("#nTotal").value), ent = parseMoney($("#nEntry").value);
    const n = Math.max(1, +$("#nTimes").value || 1);
    const parcela = Math.max(0, Math.round((tot - ent) / n * 100) / 100);
    $("#nPreview").innerHTML = `📋 Acordo: ${ent > 0 ? `entrada de <b>${fmtBRL(ent)}</b> + ` : ""}<b>${n}x de ${fmtBRL(parcela)}</b> = total ${fmtBRL(ent + parcela * n)}${tot < restante ? ` <span style="color:var(--good-text)">(desconto de ${fmtBRL(restante - tot)} 🎉)</span>` : ""}`;
    return { tot, ent, n, parcela };
  };
  preview();
  ["nTotal", "nEntry", "nTimes"].forEach(id => $("#" + id).oninput = preview);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const { ent, n, parcela } = preview();
    if (!parcela && !ent) return toast("Informe o valor do acordo.");
    const first = $("#nFirst").value || nextMonth10;
    const totalAcordo = Math.round((ent + parcela * n) * 100) / 100;
    try {
      if (ent > 0) {
        await addDoc(collection(db, "households", hid, "bills"), {
          name: "Entrada acordo — " + d.name, amount: ent, dueDate: todayISO(),
          category: "Dívidas", recurring: false, totalTimes: null, paidTimes: 0,
          dda: false, status: "pendente", debtId: d.id, createdBy: user.email
        });
      }
      await addDoc(collection(db, "households", hid, "bills"), {
        name: "Acordo — " + d.name, amount: parcela, dueDate: first,
        category: "Dívidas", recurring: n > 1, totalTimes: n > 1 ? n : null, paidTimes: 0,
        dda: false, status: "pendente", debtId: d.id, createdBy: user.email
      });
      await updateDoc(doc(db, "households", hid, "debts", d.id), {
        originalValue: d.originalValue ?? (d.currentValue ?? d.total),
        currentValue: totalAcordo, paid: 0, monthlyPayment: parcela, status: "acordo",
        note: ((d.note || "") + ` · 🤝 Acordo em ${todayISO().split("-").reverse().join("/")}: ${ent > 0 ? `entrada ${fmtBRL(ent)} + ` : ""}${n}x de ${fmtBRL(parcela)} (total ${fmtBRL(totalAcordo)})`).trim(),
        updatedAt: new Date().toISOString()
      });
      closeModal();
      toast("🤝 Acordo fechado! As parcelas estão em Boletos & Contas — cada pagamento abate a dívida.");
    } catch (e) { toast("Erro: " + e.message); }
  };
}

function modalInvest() {
  openModal(`
    <h3>Novo aporte / resgate</h3>
    <div class="field"><label>Ativo</label><input id="iName" placeholder="Ex.: CDB Liquidez diária, IVVB11, Tesouro Selic"></div>
    <div class="form-row">
      <div class="field"><label>Tipo de ativo</label><select id="iType">
        ${["Renda fixa","Tesouro","FIIs","Ações BR","Ações/ETF exterior","Cripto","Fundo","Outros"].map(x => `<option>${x}</option>`).join("")}</select></div>
      <div class="field"><label>Operação</label><select id="iOp">
        <option value="aporte">Aporte</option><option value="rendimento">Rendimento</option>
        <option value="dividendo">Dividendo</option><option value="resgate">Resgate</option></select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Valor (R$)</label><input id="iAmount" inputmode="decimal" placeholder="0,00"></div>
      <div class="field"><label>Data</label><input id="iDate" type="date" value="${todayISO()}"></div>
    </div>
    <div class="field"><label>Conta (opcional)</label><input id="iConta" placeholder="Ex.: Conta Investimentos, XP, NuInvest"></div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Registrar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const amount = parseMoney($("#iAmount").value);
    if (!amount || !$("#iName").value.trim()) return toast("Preencha ativo e valor.");
    try {
      await addDoc(collection(db, "households", hid, "investments"), {
        name: $("#iName").value.trim(), assetType: $("#iType").value, type: $("#iOp").value,
        amount, date: $("#iDate").value || todayISO(), conta: $("#iConta").value.trim() || "Conta Investimentos", createdBy: user.email
      });
      closeModal(); toast("📈 Registrado!");
    } catch (e) { toast("Erro: " + e.message); }
  };
}

function modalGoal() {
  openModal(`
    <h3>🎯 Ajustar meta</h3>
    <div class="form-row">
      <div class="field"><label>Valor da meta (R$)</label><input id="gAmount" inputmode="decimal" value="${SETTINGS.goalAmount ?? 1000000}"></div>
      <div class="field"><label>Prazo (anos)</label><input id="gYears" type="number" min="1" max="30" value="${SETTINGS.goalYears ?? 5}"></div>
    </div>
    <div class="field"><label>Data de início do plano</label><input id="gStart" type="date" value="${SETTINGS.goalStart || todayISO()}"></div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">Salvar meta</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    await setDoc(doc(db, "households", hid, "meta", "settings"), {
      goalAmount: parseMoney($("#gAmount").value) || 1000000,
      goalYears: +$("#gYears").value || 5,
      goalStart: $("#gStart").value || todayISO()
    }, { merge: true });
    closeModal(); toast("Meta atualizada. Rumo ao milhão! 🚀");
  };
}

// ============================================================
// IA — Claude API
// ============================================================
async function callClaude({ system, messages, maxTokens = 1600 }) {
  const key = aiKey();
  if (!key) throw new Error("Configure sua chave da API em Configurações.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: SETTINGS.model || "claude-sonnet-4-5",
      max_tokens: maxTokens, system, messages
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || "Erro " + res.status + " na API Claude.");
  }
  const data = await res.json();
  return data.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

function financialContext() {
  const mks = lastMonths(6);
  const months = mks.map(mk => { const t = monthTotals(mk); return `${mk}: entradas ${t.ins.toFixed(0)}, saídas ${t.outs.toFixed(0)}`; }).join("; ");
  const mk = todayISO().slice(0, 7);
  const cats = catSpend(mk).map(([c, v]) => `${c}: ${v.toFixed(0)}`).join(", ") || "nenhum gasto no mês";
  const dt = debtTotals();
  const debts = DEBTS.filter(d => d.status !== "quitada").map(d =>
    `${d.name}: resta ${(((d.currentValue ?? d.total) - (d.paid || 0))).toFixed(0)}, parcela ${d.monthlyPayment || 0}/mês, juros ${d.interest ?? "?"}% a.m., status ${d.status}`).join("; ") || "nenhuma";
  const p = planCalc();
  return `DADOS FINANCEIROS REAIS DO USUÁRIO (moeda: BRL):
- Renda média mensal (últimos meses): ${avgIncome().toFixed(0)} (meta declarada: ${SETTINGS.incomeTarget ?? 17500})
- Últimos 6 meses: ${months}
- Gastos do mês atual por categoria: ${cats}
- Gastos essenciais médios/mês: ${avgEssentials().toFixed(0)}
- Dívidas ativas: ${debts}
- Total dívidas em aberto: ${dt.open.toFixed(0)}; parcelas atuais: ${dt.monthly.toFixed(0)}/mês
- Limite recomendado p/ dívidas: ${(SETTINGS.debtPct ?? 30)}% da renda
- Boletos/contas pendentes: ${pendingBills().map(b => `${b.name} ${b.amount.toFixed(0)} venc ${b.dueDate}${b.dda ? " (DDA)" : ""}${b.recurring ? " (recorrente)" : ""}`).join("; ") || "nenhum"}
- Contas fixas mensais (recorrentes): ${fmtBRL0(fixedMonthlyTotal())}
- Limites de orçamento definidos: ${getBudgets().map(([c, v]) => `${c} ${v.toFixed(0)}`).join(", ") || "nenhum"}
- Total investido: ${investedTotal().toFixed(0)}
- META: ${p.goal} em ${SETTINGS.goalYears || 5} anos. Faltam ${p.monthsLeft} meses. Aporte necessário: ${p.pmt.toFixed(0)}/mês com ${(p.rate*100).toFixed(2)}% a.m.
- % da renda destinado a investir: ${SETTINGS.investPct ?? 20}%`;
}

const SYSTEM_ADVISOR = `Você é um consultor financeiro pessoal brasileiro, direto e prático. Responda SEMPRE em português do Brasil, em texto corrido curto (sem markdown pesado, sem tabelas). Use os dados reais fornecidos. Seja específico com números. Priorize: 1) quitar dívidas caras, 2) reserva de emergência, 3) investir para a meta. Lembre que rentabilidade passada não garante futura e que você não substitui um assessor certificado — mas dê recomendações claras e acionáveis mesmo assim.`;

// ---- Chat consultor ----
async function sendChat(text) {
  if (!text.trim()) return;
  chatHistory.push({ role: "user", content: text });
  render();
  const log = $("#chatLog");
  const thinking = document.createElement("div");
  thinking.className = "msg ai thinking loading-dots";
  thinking.textContent = "Analisando seus números";
  log.appendChild(thinking); log.scrollTop = log.scrollHeight;
  try {
    const reply = await callClaude({
      system: SYSTEM_ADVISOR + "\n\n" + financialContext(),
      messages: chatHistory.slice(-12).map(m => ({ role: m.role, content: m.content }))
    });
    chatHistory.push({ role: "assistant", content: reply });
  } catch (e) {
    chatHistory.push({ role: "assistant", content: "⚠️ " + e.message });
  }
  render();
  const l2 = $("#chatLog"); if (l2) l2.scrollTop = l2.scrollHeight;
}

// ---- Leitura de comprovante ----
async function readReceipt(file) {
  const status = $("#receiptStatus");
  status.classList.remove("hidden");
  status.innerHTML = `<div class="ai-box loading-dots">🤖 Lendo o comprovante com IA</div>`;
  try {
    const { b64, mime } = await fileToB64(file);
    const raw = await callClaude({
      maxTokens: 600,
      system: `Você extrai dados de comprovantes financeiros brasileiros (PIX, cartão, boleto, nota fiscal). Responda APENAS com JSON válido, sem markdown, no formato:
{"valor": 123.45, "data": "YYYY-MM-DD", "descricao": "nome do estabelecimento/pessoa", "tipo": "saida" ou "entrada", "categoria": "uma de: ${catsOut().join(", ")} (para saída) ou ${catsIn().join(", ")} (para entrada)", "forma": "uma de: ${METHODS.join(", ")}", "confianca": "alta|media|baixa"}
Se a imagem não for um comprovante, responda {"erro": "descreva o problema"}. Data ausente → use null. Tipo: pagamento/compra/transferência enviada = saida; recebimento = entrada.`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          { type: "text", text: "Extraia os dados deste comprovante." }
        ]
      }]
    });
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (json.erro) throw new Error(json.erro);
    receiptDraft = {
      type: json.tipo === "entrada" ? "entrada" : "saida",
      amount: +json.valor || 0,
      date: json.data || todayISO(),
      desc: json.descricao || "",
      category: json.categoria || "Outros",
      method: json.forma || "PIX",
      aiRead: true
    };
    status.classList.add("hidden");
    const res = $("#receiptResult");
    res.classList.remove("hidden");
    res.innerHTML = `
      <div class="ai-box">
        <b>✅ Comprovante lido${json.confianca !== "alta" ? " (confira os dados!)" : ""}</b><br>
        ${receiptDraft.type === "entrada" ? "↑ Entrada" : "↓ Saída"} de <b>${fmtBRL(receiptDraft.amount)}</b><br>
        ${esc(receiptDraft.desc)} · ${esc(receiptDraft.category)} · ${esc(receiptDraft.method)} · ${receiptDraft.date.split("-").reverse().join("/")}
      </div>
      <div class="flex section-gap">
        <button class="btn" id="btnConfirmReceipt">✅ Confirmar e salvar</button>
        <button class="btn secondary" id="btnEditReceipt">✏️ Ajustar antes</button>
      </div>`;
    $("#btnConfirmReceipt").onclick = async () => {
      try {
        await addDoc(collection(db, "households", hid, "transactions"), {
          ...receiptDraft, createdBy: user.email, createdAt: new Date().toISOString()
        });
        toast("🤖 Transação registrada pela IA!");
        res.classList.add("hidden");
      } catch (e) { toast("Erro: " + e.message); }
    };
    $("#btnEditReceipt").onclick = () => modalTx(null, receiptDraft);
  } catch (e) {
    status.innerHTML = `<div class="ai-box" style="background:rgba(208,59,59,.1)">⚠️ ${esc(e.message)}</div>`;
  }
}
function fileToB64(file) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ b64: r.result.split(",")[1], mime: file.type || "image/jpeg" });
    r.onerror = bad;
    r.readAsDataURL(file);
  });
}
function fileToText(file) {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsText(file); });
}
let _xlsx = null;
function loadXLSX() {
  if (_xlsx) return Promise.resolve(_xlsx);
  if (window.XLSX) { _xlsx = window.XLSX; return Promise.resolve(_xlsx); }
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => { _xlsx = window.XLSX; ok(_xlsx); };
    s.onerror = () => bad(new Error("Não foi possível carregar o leitor de planilha."));
    document.head.appendChild(s);
  });
}
async function xlsxToText(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  return wb.SheetNames.map(n => `# Planilha: ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n\n");
}

const IMPORT_SYS = `Você extrai investimentos de extratos/posições de corretoras e da B3 (Área do Investidor). A entrada pode ser uma POSIÇÃO (saldo atual de cada ativo) ou um EXTRATO DE MOVIMENTAÇÕES.
Responda APENAS com JSON válido, sem markdown:
{"tipo_arquivo":"posicao|movimentacoes","itens":[{"name":"nome do ativo","assetType":"uma de: Renda fixa, Tesouro, FIIs, Ações BR, Ações/ETF exterior, Cripto, Fundo, Outros","type":"aporte|rendimento|dividendo|resgate","amount":1234.56,"date":"YYYY-MM-DD","conta":"corretora/instituição"}],"resumo":"1 frase"}
Regras:
- Se for POSIÇÃO (saldo atual), gere UM item por ativo com type "aporte", amount = valor atual/bruto do ativo, date = hoje.
- Se for MOVIMENTAÇÕES, mapeie cada linha: aplicação/compra=aporte, provento/rendimento de renda fixa=rendimento, dividendo/JCP/rendimento de FII=dividendo, resgate/venda=resgate.
- assetType: CDB/LCI/LCA/LC/debênture/CRI/CRA→"Renda fixa"; Tesouro Direto→"Tesouro"; FII (ticker terminando em 11)→"FIIs"; ações BR (ticker 3/4/5/6)→"Ações BR"; ETF/BDR/exterior→"Ações/ETF exterior"; cripto→"Cripto"; fundo→"Fundo".
- amount sempre número com ponto decimal. Ignore linhas de cabeçalho/total. Se não houver investimentos, {"itens":[]}.`;

let importDraft = [];
function modalImportInvest() {
  if (!hasAIKey()) return toast("Configure sua chave da API Claude em Configurações para importar.");
  openModal(`
    <h3>Importar extrato de investimentos</h3>
    <p class="muted" style="margin:-8px 0 12px; font-size:13px">Envie o arquivo da B3 (Área do Investidor) ou da sua corretora — Excel, CSV, PDF ou um print. A IA lê e você confirma antes de salvar.</p>
    <div class="dropzone" id="impDrop">
      <span class="big">📄</span><b>Arraste o extrato aqui</b><br>ou
      <div class="flex" style="justify-content:center; margin-top:10px"><button class="btn small" id="impPick">Escolher arquivo</button></div>
      <div class="muted" style="margin-top:8px; font-size:12px">.xlsx, .csv, .pdf, .png, .jpg</div>
      <input type="file" id="impFile" accept=".xlsx,.xls,.csv,.txt,.pdf,image/*" class="hidden">
    </div>
    <div id="impStatus" class="section-gap"></div>
    <div id="impResult"></div>
    <div class="modal-actions"><button class="btn secondary" id="mCancel">Fechar</button></div>`);
  $("#mCancel").onclick = closeModal;
  $("#impPick").onclick = () => $("#impFile").click();
  $("#impFile").onchange = e => e.target.files[0] && importReadFile(e.target.files[0]);
  const dz = $("#impDrop");
  dz.ondragover = e => { e.preventDefault(); dz.classList.add("drag"); };
  dz.ondragleave = () => dz.classList.remove("drag");
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove("drag"); e.dataTransfer.files[0] && importReadFile(e.dataTransfer.files[0]); };
}
async function importReadFile(file) {
  const status = $("#impStatus");
  status.innerHTML = `<div class="ai-box loading-dots">🤖 Lendo ${esc(file.name)}</div>`;
  $("#impResult").innerHTML = "";
  try {
    const name = (file.name || "").toLowerCase();
    let content;
    if (file.type.startsWith("image/")) {
      const { b64, mime } = await fileToB64(file);
      content = [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: "Extraia os investimentos deste extrato." }];
    } else if (file.type === "application/pdf" || name.endsWith(".pdf")) {
      const { b64 } = await fileToB64(file);
      content = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }, { type: "text", text: "Extraia os investimentos deste extrato." }];
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const txt = await xlsxToText(file);
      content = [{ type: "text", text: "Extraia os investimentos desta planilha:\n\n" + txt.slice(0, 40000) }];
    } else {
      const txt = await fileToText(file);
      content = [{ type: "text", text: "Extraia os investimentos deste extrato:\n\n" + txt.slice(0, 40000) }];
    }
    const raw = await callClaude({ maxTokens: 3000, system: IMPORT_SYS, messages: [{ role: "user", content }] });
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    importDraft = (json.itens || []).filter(i => +i.amount > 0);
    if (!importDraft.length) throw new Error("Nenhum investimento encontrado no arquivo. Tente outro export (posição ou movimentações).");
    status.innerHTML = `<div class="ai-box">✅ ${importDraft.length} ativo(s) encontrado(s) ${json.tipo_arquivo === "posicao" ? "(posição atual)" : "(movimentações)"} — confira e marque os que quer importar.</div>`;
    $("#impResult").innerHTML = `
      <div style="max-height:38vh; overflow-y:auto; display:flex; flex-direction:column; gap:6px; margin-top:10px">
        ${importDraft.map((i, idx) => `
        <label style="display:flex; align-items:center; gap:10px; padding:9px 11px; border:1px solid var(--border); border-radius:10px; cursor:pointer">
          <input type="checkbox" class="imp-chk" data-i="${idx}" checked style="width:17px; height:17px">
          <span style="flex:1; min-width:0"><b>${esc(i.name)}</b>
            <div class="muted" style="font-size:12px">${esc(i.assetType || "Outros")} · ${({aporte:"Aporte",rendimento:"Rendimento",dividendo:"Dividendo",resgate:"Resgate"})[i.type] || "Aporte"} · ${i.date || "sem data"}${i.conta ? " · " + esc(i.conta) : ""}</div></span>
          <b style="font-variant-numeric:tabular-nums; white-space:nowrap">${fmtBRL(+i.amount)}</b>
        </label>`).join("")}
      </div>
      <button class="btn" id="impConfirm" style="width:100%; justify-content:center; margin-top:12px">✅ Importar selecionados</button>`;
    $("#impConfirm").onclick = async () => {
      const chosen = [...document.querySelectorAll(".imp-chk:checked")].map(c => importDraft[+c.dataset.i]);
      if (!chosen.length) return toast("Marque ao menos um ativo.");
      $("#impConfirm").disabled = true; $("#impConfirm").textContent = "Importando…";
      try {
        for (const i of chosen) {
          await addDoc(collection(db, "households", hid, "investments"), {
            name: String(i.name || "Ativo"), assetType: i.assetType || "Outros",
            type: ["aporte", "rendimento", "dividendo", "resgate"].includes(i.type) ? i.type : "aporte",
            amount: +i.amount || 0, date: i.date || todayISO(),
            conta: i.conta || "Importado", createdBy: user.email, imported: true
          });
        }
        closeModal(); toast(`📥 ${chosen.length} investimento(s) importado(s)!`);
      } catch (e) { toast("Erro: " + e.message); $("#impConfirm").disabled = false; }
    };
  } catch (e) {
    status.innerHTML = `<div class="ai-box" style="background:rgba(208,59,59,.1)">⚠️ ${esc(e.message)}</div>`;
  }
}

// ---- IA: estratégia de dívidas ----
async function debtStrategy() {
  const box = $("#debtAIBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ai-box loading-dots">🤖 Montando estratégia de quitação</div>`;
  try {
    const reply = await callClaude({
      maxTokens: 1800,
      system: SYSTEM_ADVISOR + "\n\n" + financialContext(),
      messages: [{ role: "user", content: "Monte minha estratégia de quitação de dívidas: em que ordem quitar (considere juros — método avalanche vs bola de neve), quanto oferecer de entrada em negociação, qual parcela máxima assumir sem estourar meu limite, e metas de prazo. Se eu não tiver dívidas, diga como usar essa folga para acelerar meus investimentos." }]
    });
    box.innerHTML = `<div class="ai-box">${esc(reply)}</div>`;
  } catch (e) { box.innerHTML = `<div class="ai-box">⚠️ ${esc(e.message)}</div>`; }
}

// ---- IA: plano milionário ----
async function planAI() {
  const box = $("#planAIBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ai-box loading-dots">🤖 Desenhando seu plano rumo ao milhão</div>`;
  try {
    const reply = await callClaude({
      maxTokens: 2000,
      system: SYSTEM_ADVISOR + "\n\n" + financialContext(),
      messages: [{ role: "user", content: "Monte meu plano personalizado para chegar à minha meta patrimonial no prazo. Estruture em fases (próximos 90 dias, ano 1, anos 2-5), com: aporte mensal alvo, onde investir considerando o cenário brasileiro (renda fixa, bolsa, exterior — sem recomendar ativos específicos obscuros), o que fazer com as dívidas antes, como aumentar a renda, e os 3 maiores riscos do plano. Seja realista com os números que você tem de mim." }]
    });
    box.innerHTML = `<div class="ai-box">${esc(reply)}</div>`;
  } catch (e) { box.innerHTML = `<div class="ai-box">⚠️ ${esc(e.message)}</div>`; }
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  // navegação interna
  document.querySelectorAll("[data-goto]").forEach(b => b.onclick = e => { e.preventDefault(); switchView(b.dataset.goto); });
  $("#btnQuickAdd") && ($("#btnQuickAdd").onclick = () => modalTx());

  // dashboard: seletor de período global + drill-down de categoria + selects dos painéis
  document.querySelectorAll("[data-period]").forEach(b => b.onclick = () => { dashPeriod = b.dataset.period; render(); });
  document.querySelectorAll("[data-cat-detail]").forEach(b => b.onclick = () => modalCatDetail(b.dataset.catDetail));
  document.querySelectorAll("[data-sel]").forEach(s => s.onchange = () => {
    if (s.dataset.sel === "flow") flowRange = s.value;
    if (s.dataset.sel === "analysis") analysisPeriod = s.value;
    render();
  });

  // transações
  const fMonth = $("#fMonth");
  if (fMonth) fMonth.onchange = () => { $("#txTableBox").innerHTML = txTableFiltered(fMonth.value); attachHandlers(); };
  document.querySelectorAll("[data-edit-tx]").forEach(b => b.onclick = () => modalTx(TX.find(t => t.id === b.dataset.editTx)));
  document.querySelectorAll("[data-dup-tx]").forEach(b => b.onclick = () => {
    const t = TX.find(x => x.id === b.dataset.dupTx); if (!t) return;
    modalTx(null, { type: t.type, amount: t.amount, desc: t.desc, category: t.category, method: t.method, date: todayISO() });
  });
  document.querySelectorAll("[data-del-tx]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir esta transação?")) await deleteDoc(doc(db, "households", hid, "transactions", b.dataset.delTx));
  });

  // comprovante
  const dz = $("#dropzone");
  if (dz) {
    $("#btnPickFile").onclick = () => $("#fileInput").click();
    $("#btnCamera").onclick = () => $("#cameraInput").click();
    $("#fileInput").onchange = e => e.target.files[0] && readReceipt(e.target.files[0]);
    $("#cameraInput").onchange = e => e.target.files[0] && readReceipt(e.target.files[0]);
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove("drag"); e.dataTransfer.files[0] && readReceipt(e.dataTransfer.files[0]); };
  }

  // dívidas
  $("#btnAddDebt") && ($("#btnAddDebt").onclick = () => modalDebt());
  $("#btnDebtAI") && ($("#btnDebtAI").onclick = debtStrategy);
  document.querySelectorAll("[data-negotiate]").forEach(b => b.onclick = () => modalNegotiate(DEBTS.find(d => d.id === b.dataset.negotiate)));
  document.querySelectorAll("[data-edit-debt]").forEach(b => b.onclick = () => modalDebt(DEBTS.find(d => d.id === b.dataset.editDebt)));
  document.querySelectorAll("[data-del-debt]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir esta dívida?")) await deleteDoc(doc(db, "households", hid, "debts", b.dataset.delDebt));
  });
  document.querySelectorAll("[data-pay-debt]").forEach(b => b.onclick = async () => {
    const d = DEBTS.find(x => x.id === b.dataset.payDebt);
    const v = parseMoney(prompt(`Quanto você pagou de "${d.name}"?`, d.monthlyPayment || ""));
    if (!v) return;
    const paid = (d.paid || 0) + v;
    const rest = (d.currentValue ?? d.total) - paid;
    await updateDoc(doc(db, "households", hid, "debts", d.id), {
      paid, status: rest <= 0 ? "quitada" : d.status
    });
    await addDoc(collection(db, "households", hid, "transactions"), {
      type: "saida", amount: v, date: todayISO(), desc: "Pagamento dívida: " + d.name,
      category: "Dívidas", method: "PIX", createdBy: user.email, createdAt: new Date().toISOString()
    });
    toast(rest <= 0 ? "🎉 Dívida quitada! Parabéns!" : "Pagamento registrado.");
  });

  // boletos
  $("#btnAddBill") && ($("#btnAddBill").onclick = () => modalBill());
  document.querySelectorAll("[data-edit-bill]").forEach(b => b.onclick = () => modalBill(BILLS.find(x => x.id === b.dataset.editBill)));
  document.querySelectorAll("[data-del-bill]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir esta conta?")) await deleteDoc(doc(db, "households", hid, "bills", b.dataset.delBill));
  });
  document.querySelectorAll("[data-pay-bill]").forEach(b => b.onclick = () => payBill(BILLS.find(x => x.id === b.dataset.payBill)));
  document.querySelectorAll("[data-debt-bill]").forEach(b => b.onclick = () => billToDebt(BILLS.find(x => x.id === b.dataset.debtBill)));
  document.querySelectorAll("[data-regularize]").forEach(b => b.onclick = () => regularizeBill(BILLS.find(x => x.id === b.dataset.regularize)));

  // investimentos
  $("#btnAddInv") && ($("#btnAddInv").onclick = modalInvest);
  $("#btnAddInv2") && ($("#btnAddInv2").onclick = modalInvest);
  $("#btnImportInv") && ($("#btnImportInv").onclick = modalImportInvest);
  $("#btnInvestAI") && ($("#btnInvestAI").onclick = investAnaliseIA);
  document.querySelectorAll("[data-del-inv]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir este registro?")) await deleteDoc(doc(db, "households", hid, "investments", b.dataset.delInv));
  });

  // categorias personalizadas
  $("#btnAddCatOut") && ($("#btnAddCatOut").onclick = async () => { const v = $("#newCatOut").value; if (await addCustomCat("saida", v)) $("#newCatOut").value = ""; });
  $("#btnAddCatIn") && ($("#btnAddCatIn").onclick = async () => { const v = $("#newCatIn").value; if (await addCustomCat("entrada", v)) $("#newCatIn").value = ""; });
  document.querySelectorAll("[data-rm-cat-out]").forEach(b => b.onclick = () => { if (confirm("Remover a categoria \"" + b.dataset.rmCatOut + "\"?")) removeCustomCat("saida", b.dataset.rmCatOut); });
  document.querySelectorAll("[data-rm-cat-in]").forEach(b => b.onclick = () => { if (confirm("Remover a categoria \"" + b.dataset.rmCatIn + "\"?")) removeCustomCat("entrada", b.dataset.rmCatIn); });

  // orçamento
  ["btnSetBudgets", "btnSetBudgets2", "btnSetBudgets3"].forEach(id => $("#" + id) && ($("#" + id).onclick = modalBudgets));
  ["btnBudgetAI", "btnBudgetAI2"].forEach(id => $("#" + id) && ($("#" + id).onclick = budgetSuggestAI));

  // plano
  $("#btnEditGoal") && ($("#btnEditGoal").onclick = modalGoal);
  $("#btnPlanAI") && ($("#btnPlanAI").onclick = planAI);

  // saúde financeira
  $("#btnScoreAI") && ($("#btnScoreAI").onclick = scoreAnaliseIA);

  // consultor
  const send = $("#btnSend");
  if (send) {
    const doSend = () => { const t = $("#chatText").value; $("#chatText").value = ""; sendChat(t); };
    send.onclick = doSend;
    $("#chatText").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } };
    document.querySelectorAll(".sug").forEach(s => s.onclick = () => sendChat(s.textContent));
    const log = $("#chatLog"); if (log) log.scrollTop = log.scrollHeight;
  }

  // config
  $("#btnSaveCfg") && ($("#btnSaveCfg").onclick = async () => {
    const s = {
      incomeTarget: parseMoney($("#cfgIncome").value),
      investPct: +$("#cfgInvestPct").value || 20,
      debtPct: +$("#cfgDebtPct").value || 30,
      expReturn: +$("#cfgReturn").value || 0.8
    };
    await setDoc(doc(db, "households", hid, "meta", "settings"), s, { merge: true });
    toast("Parâmetros salvos.");
  });
  $("#btnSaveKey") && ($("#btnSaveKey").onclick = async () => {
    const k = $("#cfgApiKey").value.trim();
    const share = $("#cfgShareKey").checked;
    const patch = { model: $("#cfgModel").value };
    if (share) {
      patch.claudeKey = k;                 // compartilhada no banco
      localStorage.removeItem("mf_claude_key");
    } else {
      patch.claudeKey = "";                // remove a compartilhada
      if (k) localStorage.setItem("mf_claude_key", k); else localStorage.removeItem("mf_claude_key");
    }
    SETTINGS.claudeKey = patch.claudeKey;   // reflete na hora
    await setDoc(doc(db, "households", hid, "meta", "settings"), patch, { merge: true });
    toast(share ? "🔐 Chave salva e compartilhada com os usuários autorizados." : "Chave salva neste dispositivo.");
  });
  $("#btnTestKey") && ($("#btnTestKey").onclick = async () => {
    const k = $("#cfgApiKey").value.trim();
    if (k && !SETTINGS.claudeKey) localStorage.setItem("mf_claude_key", k);
    else if (k) SETTINGS.claudeKey = k;
    toast("Testando…");
    try {
      await callClaude({ maxTokens: 20, messages: [{ role: "user", content: "Responda apenas: ok" }] });
      toast("✅ Conexão com a IA funcionando!");
    } catch (e) { toast("⚠️ " + e.message, 5000); }
  });
  $("#btnAddMember") && ($("#btnAddMember").onclick = async () => {
    const em = $("#newMember").value.trim().toLowerCase();
    if (!em.includes("@")) return toast("Digite um e-mail válido.");
    await updateDoc(doc(db, "households", hid), { members: arrayUnion(em) });
    toast(em + " agora tem acesso. Peça para entrar com o Google usando esse e-mail.");
  });
  document.querySelectorAll("[data-rm-member]").forEach(b => b.onclick = async () => {
    if (confirm("Remover acesso de " + b.dataset.rmMember + "?"))
      await updateDoc(doc(db, "households", hid), { members: arrayRemove(b.dataset.rmMember) });
  });
  $("#btnImport") && ($("#btnImport").onclick = () => $("#importFile").click());
  const impF = $("#importFile");
  if (impF) impF.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const st = $("#importStatus");
    try {
      const data = JSON.parse(await file.text());
      const dividas = data.dividas || [], boletos = data.boletos || [], transacoes = data.transacoes || [];
      const total = dividas.length + boletos.length + transacoes.length;
      if (!total) { st.textContent = "⚠️ Arquivo válido, mas sem itens para importar."; return; }
      if (!confirm(`Importar ${dividas.length} dívida(s), ${boletos.length} boleto(s) e ${transacoes.length} transação(ões)?`)) return;
      let done = 0;
      st.textContent = "Importando…";
      for (const d of dividas) {
        await addDoc(collection(db, "households", hid, "debts"), {
          name: String(d.name || "Dívida"), total: +d.currentValue || +d.total || 0,
          currentValue: +d.currentValue || +d.total || 0, paid: +d.paid || 0,
          monthlyPayment: +d.monthlyPayment || 0, interest: d.interest != null ? +d.interest : null,
          status: d.status || "atrasada", dueDay: d.dueDay != null ? +d.dueDay : null,
          note: String(d.note || ""), updatedAt: new Date().toISOString()
        });
        st.textContent = `Importando… ${++done}/${total}`;
      }
      for (const b of boletos) {
        await addDoc(collection(db, "households", hid, "bills"), {
          name: String(b.name || "Conta"), amount: +b.amount || 0,
          dueDate: b.dueDate || todayISO(), category: b.category || "Contas (água/luz/net)",
          recurring: !!b.recurring, totalTimes: b.totalTimes != null ? +b.totalTimes : null,
          paidTimes: +b.paidTimes || 0, dda: !!b.dda, status: b.status || "pendente",
          createdBy: user.email
        });
        st.textContent = `Importando… ${++done}/${total}`;
      }
      for (const t of transacoes) {
        await addDoc(collection(db, "households", hid, "transactions"), {
          type: t.type === "entrada" ? "entrada" : "saida", amount: +t.amount || 0,
          date: t.date || todayISO(), desc: String(t.desc || ""),
          category: t.category || "Outros", method: t.method || "PIX",
          createdBy: user.email, createdAt: new Date().toISOString()
        });
        st.textContent = `Importando… ${++done}/${total}`;
      }
      st.textContent = `✅ Importação concluída: ${total} item(ns).`;
      toast("✅ Dados importados com sucesso!");
    } catch (err) {
      st.textContent = "⚠️ Erro na importação: " + err.message;
    } finally { e.target.value = ""; }
  };
  $("#btnExport") && ($("#btnExport").onclick = () => {
    const blob = new Blob([JSON.stringify({ exportadoEm: new Date().toISOString(), transacoes: TX, dividas: DEBTS, boletos: BILLS, investimentos: INVEST, config: SETTINGS }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "minha-financa-backup-" + todayISO() + ".json";
    a.click();
  });

  // tooltips dos gráficos
  const tip = $("#tooltip");
  document.querySelectorAll(".has-tip").forEach(el => {
    el.addEventListener("mousemove", e => {
      const [title, series, val] = el.dataset.tip.split("|");
      tip.innerHTML = `<div class="t-title">${esc(title)}</div><div class="t-row">${esc(series)}<b>${fmtBRL(+val)}</b></div>`;
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 200) + "px";
      tip.style.top = (e.clientY + 14) + "px";
    });
    el.addEventListener("mouseleave", () => tip.style.display = "none");
  });
  // tooltip múltiplo (gráfico de evolução)
  document.querySelectorAll(".has-tipm").forEach(el => {
    el.addEventListener("mousemove", e => {
      const parts = el.dataset.tipm.split("||");
      const rows = parts.slice(1).map(p => { const [s, v] = p.split(":"); return `<div class="t-row">${esc(s)}<b>${fmtBRL(+v)}</b></div>`; }).join("");
      tip.innerHTML = `<div class="t-title">${esc(parts[0])}</div>${rows}`;
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + "px";
      tip.style.top = (e.clientY + 14) + "px";
    });
    el.addEventListener("mouseleave", () => tip.style.display = "none");
  });
}

// modal: fechar clicando fora
document.addEventListener("click", e => { if (e.target.id === "modalBack") closeModal(); });

boot();
