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
};
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
function deltaCtx(cur, prev, { goodDown = false } = {}) {
  if (prev === 0 || prev == null) {
    if (!cur) return { html: `<span class="trend flat">—</span>` };
    return { html: `<span class="trend flat">sem base anterior</span>` };
  }
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const isGood = goodDown ? pct <= 0 : pct >= 0;
  const arrow = pct > 0.5 ? "↑" : pct < -0.5 ? "↓" : "→";
  const cls = Math.abs(pct) < 0.5 ? "flat" : (isGood ? "pos" : "neg");
  return { html: `<span class="trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1).replace(".", ",")}%</span> <span class="muted">vs período anterior</span>`, pct };
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
  const alerts = buildAlerts();
  const nome = (user?.displayName || "").split(" ")[0] || "";
  // sparklines dos últimos 6 meses (contexto de tendência)
  const spk = lastMonths(6);
  const sparkOut = spk.map(m => monthTotals(m).outs);
  const sparkIn = spk.map(m => monthTotals(m).ins);
  const savingsGoal = SETTINGS.savingsGoalPct ?? 30;

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

  <!-- CAMADA 1: situação atual -->
  <div class="kpi-hero">
    <div class="kpi hero">
      <div class="k-label">Resultado ${mks.length > 1 ? "do período" : "do mês"}</div>
      <div class="k-val" style="color:${saldo >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL(saldo)}</div>
      <div class="k-ctx">${deltaCtx(saldo, prevSaldo).html}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Recebido</div>
      <div class="k-val">${fmtBRL0(cur.ins)}</div>
      <div class="k-ctx">${deltaCtx(cur.ins, prev.ins).html}</div>
      ${p === "mes" ? sparkline(sparkIn, "var(--s1)") : ""}
    </div>
    <div class="kpi">
      <div class="k-label">Gasto</div>
      <div class="k-val">${fmtBRL0(cur.outs)}</div>
      <div class="k-ctx">${deltaCtx(cur.outs, prev.outs, { goodDown: true }).html}</div>
      ${p === "mes" ? sparkline(sparkOut, "var(--s2)") : ""}
    </div>
  </div>

  <div class="kpi-row section-gap">
    <div class="kpi">
      <div class="k-label">Taxa de economia</div>
      <div class="k-val">${savings == null ? "—" : savings.toFixed(0) + "%"}</div>
      <div class="k-ctx">${savings == null ? "sem receita no período" : `meta: ${savingsGoal}% ${savings >= savingsGoal ? '<span class="trend pos">✓ batida</span>' : `<span class="muted">(faltam ${(savingsGoal - savings).toFixed(0)} p.p.)</span>`}`}</div>
    </div>
    <div class="kpi">
      <div class="k-label">A vencer (15 dias)</div>
      ${(() => { const u = upcoming(15); return `<div class="k-val">${fmtBRL0(u.total)}</div><div class="k-ctx">${u.count ? u.count + " conta(s)" : "nada a vencer"}</div>`; })()}
    </div>
    <div class="kpi">
      <div class="k-label">Investido no período</div>
      <div class="k-val">${fmtBRL0(invPer)}</div>
      <div class="k-ctx">${p === "mes" ? `meta de aporte: ${fmtBRL0(plan.pmt)}` : deltaCtx(invPer, prevInv).html}</div>
    </div>
    ${p === "mes" ? `<div class="kpi">
      <div class="k-label">Saldo projetado <span title="Estimativa: recebido + receita esperada − gastos − contas a vencer no mês. Não é saldo bancário." style="cursor:help; color:var(--ink-3)">ⓘ</span></div>
      ${(() => { const f = forecast(); return `<div class="k-val" style="color:${f.saldo >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL0(f.saldo)}</div><div class="k-ctx">estimativa até o fim do mês</div>`; })()}
    </div>` : ""}
  </div>

  ${alerts.length ? `<div class="card section-gap">
    <div class="flex spread" style="margin-bottom:12px"><h3>Precisa da sua atenção</h3></div>
    <div class="alerts">${alerts.map(alertHTML).join("")}</div>
  </div>` : ""}

  ${dashScoreCard()}

  <!-- CAMADA 2: tendência -->
  <div class="grid two-col section-gap">
    <div class="card chart-card">
      <h3>Fluxo financeiro</h3>
      <div class="chart-sub">Entradas, saídas e saldo — ${mks.length > 1 ? "no período" : "últimos 6 meses"}</div>
      <div class="legend">
        <span class="key"><span class="swatch" style="background:var(--s1)"></span>Entradas</span>
        <span class="key"><span class="swatch" style="background:var(--s2)"></span>Saídas</span>
        <span class="key"><span class="swatch" style="background:var(--s7); border-radius:2px; height:3px"></span>Saldo</span>
      </div>
      ${chartFlow(mks.length > 1 ? mks : lastMonths(6))}
    </div>
    <div class="card chart-card">
      <h3>Para onde foi seu dinheiro</h3>
      <div class="chart-sub">${mks.length > 1 ? periodLabel(p) : monthLabel(mks[0])} · toque numa categoria para ver as transações</div>
      ${chartCats(mks)}
    </div>
  </div>

  ${p === "mes" ? forecastBlock() : ""}

  <!-- CAMADA 5: metas -->
  <div class="card section-gap">
    <div class="flex spread">
      <div><h3>Meta patrimonial</h3>
      <div class="chart-sub">Faltam ${plan.monthsLeft} meses · aporte necessário <b>${fmtBRL0(plan.pmt)}/mês</b></div></div>
      <button class="btn secondary small" data-goto="plano">Ver plano →</button>
    </div>
    <div class="flex spread" style="align-items:flex-end; margin:8px 0 6px">
      <div style="font-size:22px; font-weight:650">${fmtBRL0(plan.current)} <span class="muted" style="font-size:14px; font-weight:500">de ${fmtBRL0(plan.goal)}</span></div>
      <div style="font-weight:650; color:var(--accent)">${plan.pct.toFixed(1)}%</div>
    </div>
    <div class="meter good"><div style="width:${plan.pct}%"></div></div>
  </div>

  <div class="card section-gap">
    <div class="flex spread"><h3>Últimas transações</h3>
      <button class="btn secondary small" data-goto="transacoes">Ver extrato →</button></div>
    ${tableTx(TX.slice(0, 6), false)}
  </div>`;
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
  const mks = periodMonths(dashPeriod);
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
  const total = investedTotal();
  const mk = todayISO().slice(0, 7);
  const mesAporte = INVEST.filter(i => monthKey(i.date) === mk && i.type !== "resgate").reduce((a,i)=>a+i.amount,0);
  const plan = planCalc();
  const byType = {};
  for (const i of INVEST) byType[i.assetType || "Outros"] = (byType[i.assetType || "Outros"] || 0) + (i.type === "resgate" ? -i.amount : i.amount);
  const types = Object.entries(byType).filter(([,v]) => v > 0).sort((a,b)=>b[1]-a[1]);
  const maxT = types.length ? types[0][1] : 1;

  return `
  <div class="view-head">
    <div><h2>Investimentos</h2><div class="sub">Registre aportes e acompanhe seu patrimônio</div></div>
    <button class="btn" id="btnAddInv">+ Novo aporte</button>
  </div>
  <div class="grid tiles">
    <div class="card tile"><div class="label">Patrimônio investido</div><div class="value">${fmtBRL0(total)}</div></div>
    <div class="card tile"><div class="label">Aportado neste mês</div><div class="value">${fmtBRL0(mesAporte)}</div>
      <div class="delta ${mesAporte >= plan.pmt ? "up" : ""}">meta de aporte: ${fmtBRL0(plan.pmt)}</div></div>
    <div class="card tile"><div class="label">Progresso da meta</div><div class="value">${plan.pct.toFixed(1)}%</div>
      <div class="delta">${fmtBRL0(plan.goal)} em ${SETTINGS.goalYears || 5} anos</div></div>
  </div>

  ${types.length ? `<div class="card section-gap">
    <h3>Carteira por tipo</h3>
    <div style="display:flex; flex-direction:column; gap:9px; margin-top:10px">
      ${types.map(([t, v]) => `<div>
        <div class="flex spread" style="font-size:13px; margin-bottom:3px">
          <span style="color:var(--ink-2)">${esc(t)}</span><b style="font-variant-numeric:tabular-nums">${fmtBRL0(v)} · ${(v/total*100).toFixed(0)}%</b></div>
        <div class="meter"><div style="width:${(v/maxT*100).toFixed(1)}%"></div></div>
      </div>`).join("")}
    </div></div>` : ""}

  <div class="card section-gap">
    <h3>Movimentações</h3>
    ${!INVEST.length ? `<div class="empty"><span class="big">🌱</span>Nenhum aporte ainda. Comece hoje — juros compostos agradecem.</div>` :
    `<div class="table-wrap"><table>
      <thead><tr><th>Data</th><th>Ativo</th><th>Tipo</th><th class="num">Valor</th><th></th></tr></thead>
      <tbody>${INVEST.slice(0, 30).map(i => `<tr>
        <td style="white-space:nowrap">${i.date.split("-").reverse().slice(0,2).join("/")}</td>
        <td><b>${esc(i.name)}</b></td>
        <td><span class="chip">${esc(i.assetType || "—")}</span></td>
        <td class="num" style="color:${i.type === "resgate" ? "var(--critical)" : "var(--good-text)"}">${i.type === "resgate" ? "−" : "+"} ${fmtBRL(i.amount)}</td>
        <td><button class="icon-btn" data-del-inv="${i.id}">🗑️</button></td>
      </tr>`).join("")}</tbody></table></div>`}
  </div>`;
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

  // planejado x real (categorias com limite)
  const spentByCat = Object.fromEntries(catSpend(mk));
  const spentBudgeted = budgets.reduce((a, [c]) => a + (spentByCat[c] || 0), 0);

  // dia do mês para ritmo esperado
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPct = dayOfMonth / daysInMonth * 100;

  // categorias com gasto no mês SEM limite definido (sugerir criar)
  const semLimite = catSpend(mk).filter(([c]) => !(SETTINGS.budgets || {})[c] && !ESSENTIAL.has(c)).slice(0, 4);

  return `
  <div class="view-head">
    <div><h2>Orçamento do mês</h2><div class="sub">O que planejar com sua renda em ${monthLabel(mk)} — e se você está dentro</div></div>
    <div class="flex">
      <button class="btn secondary" id="btnBudgetAI" ${hasAIKey() ? "" : "disabled"}>🤖 Sugerir com IA</button>
      <button class="btn" id="btnSetBudgets">Definir limites</button>
    </div>
  </div>

  <div class="grid tiles">
    <div class="card tile"><div class="label">Renda planejada</div><div class="value">${fmtBRL(renda)}</div>
      <div class="delta">ajuste em Configurações</div></div>
    <div class="card tile"><div class="label">Contas fixas</div><div class="value">${fmtBRL(fixas)}</div>
      <div class="delta">${fixedBills().length} conta(s) recorrente(s)</div></div>
    <div class="card tile"><div class="label">Limites de gastos</div><div class="value">${fmtBRL(budgetTotal)}</div>
      <div class="delta">${budgets.length} categoria(s) com limite</div></div>
    <div class="card tile"><div class="label">Sobra p/ metas</div>
      <div class="value" style="color:${sobra >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL(sobra)}</div>
      <div class="delta">${sobra >= 0 ? "disponível p/ investir/guardar" : "⚠️ orçamento acima da renda"}</div></div>
  </div>

  <div id="budgetAIBox" class="section-gap hidden"></div>

  <div class="card section-gap">
    <div class="flex spread" style="margin-bottom:4px">
      <h3>Planejado × gasto real</h3>
      <span class="muted">${monthLabel(mk)} · dia ${dayOfMonth}/${daysInMonth}</span>
    </div>
    ${budgets.length ? `
    <div class="flex" style="gap:18px; margin:8px 0 14px; font-size:14px; flex-wrap:wrap">
      <span>Limite total: <b>${fmtBRL(budgetTotal)}</b></span>
      <span>Gasto até agora: <b style="color:${spentBudgeted > budgetTotal ? "var(--critical)" : "var(--good-text)"}">${fmtBRL(spentBudgeted)}</b></span>
      <span>Restante: <b>${fmtBRL(Math.max(0, budgetTotal - spentBudgeted))}</b></span>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px">
      ${budgets.sort((a,b) => (spentByCat[b[0]]||0)/b[1] - (spentByCat[a[0]]||0)/a[1]).map(([c, limit]) => {
        const spent = spentByCat[c] || 0;
        const pct = limit ? spent / limit * 100 : 0;
        const lvl = budgetLevel(spent, limit);
        const over = spent > limit;
        return `<div>
          <div class="flex spread" style="font-size:14px; margin-bottom:4px">
            <span><b>${esc(c)}</b> ${over ? '<span class="badge crit" style="margin-left:6px">estourou</span>' : pct >= 85 ? '<span class="badge warn" style="margin-left:6px">no limite</span>' : '<span class="badge good" style="margin-left:6px">dentro</span>'}</span>
            <span style="font-variant-numeric:tabular-nums">${fmtBRL(spent)} <span class="muted">/ ${fmtBRL(limit)}</span></span>
          </div>
          <div class="meter ${lvl}" style="position:relative">
            <div style="width:${Math.min(100, pct).toFixed(1)}%"></div>
            <div title="ritmo esperado do mês" style="position:absolute; top:-2px; bottom:-2px; left:${Math.min(100, monthPct).toFixed(1)}%; width:2px; background:var(--ink-3); opacity:.6"></div>
          </div>
          <div class="muted" style="margin-top:3px; font-size:12px">${over ? `passou ${fmtBRL(spent - limit)} do limite` : `restam ${fmtBRL(limit - spent)}`} · a linha cinza marca o ritmo esperado (${monthPct.toFixed(0)}% do mês)</div>
        </div>`;
      }).join("")}
    </div>` : `<div class="empty"><span class="big">🧮</span>Você ainda não definiu limites de gastos.<br>Clique em <b>Definir limites</b> ou peça uma <b>sugestão à IA</b>.</div>`}
    ${semLimite.length ? `<div class="ai-box section-gap">💡 Você gastou nestas categorias sem limite definido: ${semLimite.map(([c, v]) => `<b>${esc(c)}</b> (${fmtBRL0(v)})`).join(", ")}. Que tal definir um teto para elas?</div>` : ""}
  </div>

  <div class="card section-gap">
    <h3>📄 Suas contas fixas mensais</h3>
    <div class="chart-sub">Puxadas automaticamente dos boletos recorrentes</div>
    ${fixedBills().length ? `<div class="table-wrap"><table>
      <thead><tr><th>Conta</th><th>Categoria</th><th class="num">Valor/mês</th></tr></thead>
      <tbody>${fixedBills().map(b => `<tr>
        <td><b>${esc(b.name)}</b></td><td><span class="chip">${esc(b.category)}</span></td>
        <td class="num">${fmtBRL(b.amount)}</td></tr>`).join("")}
        <tr><td colspan="2"><b>Total comprometido/mês</b></td><td class="num"><b>${fmtBRL(fixedMonthlyTotal())}</b></td></tr>
      </tbody></table></div>
      <div class="muted section-gap">Isso representa <b>${renda > 0 ? (fixas / renda * 100).toFixed(0) : 0}%</b> da sua renda já comprometido antes de qualquer gasto variável.</div>`
    : `<div class="empty"><span class="big">📭</span>Nenhuma conta fixa cadastrada. Adicione contas recorrentes em <a href="#" data-goto="boletos">Boletos & Contas</a>.</div>`}
  </div>

  <div class="card section-gap">
    <h3>🎯 Regra 50/30/20 — referência</h3>
    <p class="muted" style="margin:6px 0 14px">Uma divisão saudável e simples da renda. Compare com o seu orçamento acima.</p>
    ${[["Essenciais (necessidades)", 0.5, "moradia, contas, mercado, transporte, saúde"],
       ["Estilo de vida (desejos)", 0.3, "delivery, lazer, assinaturas, compras"],
       ["Futuro (investir + quitar dívidas)", 0.2, "aportes e amortização de dívidas"]].map(([label, frac, ex]) => `
      <div style="margin-bottom:12px">
        <div class="flex spread" style="font-size:14px; margin-bottom:4px">
          <span><b>${label}</b> — ${(frac*100)}%</span>
          <b style="font-variant-numeric:tabular-nums">${fmtBRL(renda * frac)}</b>
        </div>
        <div class="meter"><div style="width:${frac*100}%"></div></div>
        <div class="muted" style="font-size:12px; margin-top:3px">${ex}</div>
      </div>`).join("")}
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
      <div class="field"><label>Operação</label><select id="iOp"><option value="aporte">Aporte</option><option value="resgate">Resgate</option></select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Valor (R$)</label><input id="iAmount" inputmode="decimal" placeholder="0,00"></div>
      <div class="field"><label>Data</label><input id="iDate" type="date" value="${todayISO()}"></div>
    </div>
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
        amount, date: $("#iDate").value || todayISO(), createdBy: user.email
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

  // dashboard: seletor de período global + drill-down de categoria
  document.querySelectorAll("[data-period]").forEach(b => b.onclick = () => { dashPeriod = b.dataset.period; render(); });
  document.querySelectorAll("[data-cat-detail]").forEach(b => b.onclick = () => modalCatDetail(b.dataset.catDetail));

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
  document.querySelectorAll("[data-del-inv]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir este registro?")) await deleteDoc(doc(db, "households", hid, "investments", b.dataset.delInv));
  });

  // categorias personalizadas
  $("#btnAddCatOut") && ($("#btnAddCatOut").onclick = async () => { const v = $("#newCatOut").value; if (await addCustomCat("saida", v)) $("#newCatOut").value = ""; });
  $("#btnAddCatIn") && ($("#btnAddCatIn").onclick = async () => { const v = $("#newCatIn").value; if (await addCustomCat("entrada", v)) $("#newCatIn").value = ""; });
  document.querySelectorAll("[data-rm-cat-out]").forEach(b => b.onclick = () => { if (confirm("Remover a categoria \"" + b.dataset.rmCatOut + "\"?")) removeCustomCat("saida", b.dataset.rmCatOut); });
  document.querySelectorAll("[data-rm-cat-in]").forEach(b => b.onclick = () => { if (confirm("Remover a categoria \"" + b.dataset.rmCatIn + "\"?")) removeCustomCat("entrada", b.dataset.rmCatIn); });

  // orçamento
  $("#btnSetBudgets") && ($("#btnSetBudgets").onclick = modalBudgets);
  $("#btnBudgetAI") && ($("#btnBudgetAI").onclick = budgetSuggestAI);

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
}

// modal: fechar clicando fora
document.addEventListener("click", e => { if (e.target.id === "modalBack") closeModal(); });

boot();
