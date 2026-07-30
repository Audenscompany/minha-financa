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
let TX = [], DEBTS = [], INVEST = [], SETTINGS = {}, HOUSEHOLD = {};
let currentView = "dashboard";
let unsubs = [];
let chatHistory = [];
let receiptDraft = null;

const CATS_OUT = ["Alimentação","Mercado","Moradia","Contas (água/luz/net)","Transporte","Saúde","Educação","Lazer","Assinaturas","Vestuário","Dívidas","Impostos/Taxas","Outros"];
const CATS_IN = ["Salário/Pró-labore","Vendas","Freelance","Rendimentos","Reembolso","Outros"];
const METHODS = ["PIX","Cartão de crédito","Cartão de débito","Dinheiro","Boleto","Transferência"];
const ESSENTIAL = new Set(["Mercado","Moradia","Contas (água/luz/net)","Transporte","Saúde","Educação","Impostos/Taxas"]);

const fmtBRL = v => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL0 = v => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const monthKey = d => d.slice(0, 7); // 'YYYY-MM'
const todayISO = () => { const d = new Date(); return d.toISOString().slice(0,10); };
const monthLabel = mk => { const [y,m] = mk.split("-"); return ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"][+m-1] + "/" + y.slice(2); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $ = sel => document.querySelector(sel);

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

  const savedTheme = localStorage.getItem("mf_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  listen("transactions", arr => { TX = arr.sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt||"").localeCompare(a.createdAt||"")); });
  listen("debts", arr => { DEBTS = arr; });
  listen("investments", arr => { INVEST = arr.sort((a,b) => b.date.localeCompare(a.date)); });
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

// ---------- Render principal ----------
function render() {
  const el = $("#mainContent");
  if (!el) return;
  const views = {
    dashboard: viewDashboard, transacoes: viewTransacoes, comprovante: viewComprovante,
    dividas: viewDividas, investimentos: viewInvest, plano: viewPlano,
    consultor: viewConsultor, config: viewConfig
  };
  el.innerHTML = (views[currentView] || viewDashboard)();
  attachHandlers();
}

// ============================================================
// VIEW: DASHBOARD
// ============================================================
function viewDashboard() {
  const mk = todayISO().slice(0, 7);
  const { ins, outs } = monthTotals(mk);
  const prev = lastMonths(2)[0];
  const prevT = monthTotals(prev);
  const saldo = ins - outs;
  const dt = debtTotals();
  const inv = investedTotal();
  const plan = planCalc();

  const deltaOut = prevT.outs > 0 ? ((outs - prevT.outs) / prevT.outs * 100) : null;

  return `
  <div class="view-head">
    <div><h2>Dashboard</h2><div class="sub">Visão geral de ${monthLabel(mk)}</div></div>
    <button class="btn" id="btnQuickAdd">+ Nova transação</button>
  </div>

  <div class="grid tiles">
    <div class="card tile"><div class="label">Saldo do mês</div>
      <div class="value" style="color:${saldo >= 0 ? "var(--good-text)" : "var(--critical)"}">${fmtBRL(saldo)}</div>
      <div class="delta">${ins > 0 ? Math.round(saldo / ins * 100) + "% da renda sobrou" : "sem entradas ainda"}</div></div>
    <div class="card tile"><div class="label">Entradas</div><div class="value">${fmtBRL(ins)}</div>
      <div class="delta">meta: ${fmtBRL0(SETTINGS.incomeTarget || 17500)}</div></div>
    <div class="card tile"><div class="label">Saídas</div><div class="value">${fmtBRL(outs)}</div>
      <div class="delta ${deltaOut == null ? "" : (deltaOut <= 0 ? "up" : "down")}">${deltaOut == null ? "—" : (deltaOut > 0 ? "+" : "") + deltaOut.toFixed(0) + "% vs mês anterior"}</div></div>
    <div class="card tile"><div class="label">Dívidas em aberto</div><div class="value">${fmtBRL0(dt.open)}</div>
      <div class="delta">${fmtBRL0(dt.monthly)}/mês em parcelas</div></div>
    <div class="card tile"><div class="label">Total investido</div><div class="value">${fmtBRL0(inv)}</div>
      <div class="delta">${plan.pct.toFixed(1)}% da meta de ${fmtBRL0(plan.goal)}</div></div>
  </div>

  <div class="grid two-col section-gap">
    <div class="card chart-card">
      <h3>Entradas × Saídas</h3>
      <div class="chart-sub">Últimos 6 meses</div>
      <div class="legend">
        <span class="key"><span class="swatch" style="background:var(--s1)"></span>Entradas</span>
        <span class="key"><span class="swatch" style="background:var(--s2)"></span>Saídas</span>
      </div>
      ${chartBars6m()}
    </div>
    <div class="card chart-card">
      <h3>Gastos por categoria</h3>
      <div class="chart-sub">${monthLabel(mk)}</div>
      ${chartCats(mk)}
    </div>
  </div>

  <div class="card section-gap">
    <div class="flex spread">
      <div><h3>🎯 Caminho para ${fmtBRL0(plan.goal)}</h3>
      <div class="chart-sub">Faltam ${plan.monthsLeft} meses · aporte necessário: <b>${fmtBRL0(plan.pmt)}/mês</b></div></div>
      <button class="btn secondary small" data-goto="plano">Ver plano completo →</button>
    </div>
    <div class="meter good" style="margin-top:6px"><div style="width:${plan.pct}%"></div></div>
    <div class="muted" style="margin-top:6px">${fmtBRL0(plan.current)} acumulados de ${fmtBRL0(plan.goal)}</div>
  </div>

  <div class="card section-gap">
    <h3>Últimas transações</h3>
    ${tableTx(TX.slice(0, 6), false)}
  </div>`;
}

// ---- Gráfico: barras 6 meses (SVG) ----
function chartBars6m() {
  const mks = lastMonths(6);
  const data = mks.map(mk => ({ mk, ...monthTotals(mk) }));
  const max = Math.max(1, ...data.flatMap(d => [d.ins, d.outs]));
  const W = 460, H = 210, padL = 8, padB = 26, padT = 10;
  const plotH = H - padB - padT;
  const bandW = (W - padL) / 6;
  const barW = Math.min(24, bandW / 2 - 8);
  const y = v => padT + plotH - (v / max * plotH);
  // gridlines em números redondos
  const step = niceStep(max);
  let grid = "";
  for (let g = step; g <= max; g += step) {
    grid += `<line x1="${padL}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--grid)" stroke-width="1"/>
    <text x="${padL}" y="${y(g)-4}" font-size="10" fill="var(--ink-3)">${compact(g)}</text>`;
  }
  let bars = "";
  data.forEach((d, i) => {
    const cx = padL + bandW * i + bandW / 2;
    const x1 = cx - barW - 1, x2 = cx + 1;
    bars += barRect(x1, y(d.ins), barW, plotH + padT - y(d.ins), "var(--s1)", `${monthLabel(d.mk)}|Entradas|${d.ins}`);
    bars += barRect(x2, y(d.outs), barW, plotH + padT - y(d.outs), "var(--s2)", `${monthLabel(d.mk)}|Saídas|${d.outs}`);
    bars += `<text x="${cx}" y="${H - 8}" font-size="11" fill="var(--ink-3)" text-anchor="middle">${monthLabel(d.mk)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto" role="img" aria-label="Entradas e saídas por mês">
    ${grid}
    <line x1="${padL}" x2="${W}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--baseline)" stroke-width="1"/>
    ${bars}</svg>`;
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

// ---- Gráfico: categorias (barras horizontais) ----
function chartCats(mk) {
  const cats = catSpend(mk).slice(0, 7);
  if (!cats.length) return `<div class="empty"><span class="big">🍃</span>Nenhum gasto registrado neste mês.</div>`;
  const max = cats[0][1];
  return `<div style="display:flex; flex-direction:column; gap:9px; margin-top:4px">` + cats.map(([c, v]) => `
    <div>
      <div class="flex spread" style="font-size:13px; margin-bottom:3px">
        <span style="color:var(--ink-2)">${esc(c)}</span><b style="font-variant-numeric:tabular-nums">${fmtBRL0(v)}</b>
      </div>
      <div class="meter"><div style="width:${(v/max*100).toFixed(1)}%; background:var(--s2)"></div></div>
    </div>`).join("") + `</div>`;
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
          ${t.type === "entrada" ? "+" : "−"} ${fmtBRL(t.amount)}</td>
        ${actions ? `<td style="white-space:nowrap"><button class="icon-btn" data-edit-tx="${t.id}">✏️</button><button class="icon-btn" data-del-tx="${t.id}">🗑️</button></td>` : ""}
      </tr>`).join("")}</tbody></table></div>`;
}

// ============================================================
// VIEW: COMPROVANTE IA
// ============================================================
function viewComprovante() {
  const hasKey = !!localStorage.getItem("mf_claude_key");
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
      <button class="btn secondary small" id="btnDebtAI" ${localStorage.getItem("mf_claude_key") ? "" : "disabled"}>🤖 Estratégia de quitação com IA</button>
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
        <td><span class="badge ${d.status === "negociando" ? "warn" : d.status === "em dia" ? "good" : "crit"}">${esc(d.status || "pendente")}</span></td>
        <td style="white-space:nowrap">
          <button class="icon-btn" title="Registrar pagamento" data-pay-debt="${d.id}">💵</button>
          <button class="icon-btn" data-edit-debt="${d.id}">✏️</button>
          <button class="icon-btn" data-del-debt="${d.id}">🗑️</button></td>
      </tr>`;}).join("")}</tbody></table></div>`}
    ${quitadas.length ? `<div class="muted section-gap">✅ Quitadas: ${quitadas.map(d => esc(d.name)).join(", ")}</div>` : ""}
  </div>`;
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
      <button class="btn" id="btnPlanAI" ${localStorage.getItem("mf_claude_key") ? "" : "disabled"}>Gerar meu plano</button>
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
// VIEW: CONSULTOR IA
// ============================================================
function viewConsultor() {
  const hasKey = !!localStorage.getItem("mf_claude_key");
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
  const key = localStorage.getItem("mf_claude_key") || "";
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
    <h3>🤖 Inteligência Artificial (Claude)</h3>
    <p class="muted" style="margin:6px 0 12px">Sua chave fica salva <b>somente neste dispositivo</b> (navegador) — nunca vai para o GitHub nem para o banco de dados. Crie a sua em <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> → API Keys.</p>
    <div class="field"><label>Chave da API (sk-ant-...)</label>
      <input id="cfgApiKey" type="password" value="${esc(key)}" placeholder="sk-ant-api03-..."></div>
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
    <div class="flex section-gap">
      <button class="btn secondary" id="btnExport">Exportar tudo (JSON)</button>
    </div>
  </div>`;
}

// ============================================================
// MODAIS (transação, dívida, investimento, meta)
// ============================================================
function openModal(html) {
  $("#modalBox").innerHTML = html;
  $("#modalBack").classList.remove("hidden");
}
function closeModal() { $("#modalBack").classList.add("hidden"); }

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
      <div class="field"><label>Categoria</label><select id="mCat"></select></div>
      <div class="field"><label>Forma</label><select id="mMethod">${METHODS.map(m => `<option ${t.method === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    </div>
    <div class="modal-actions">
      <button class="btn secondary" id="mCancel">Cancelar</button>
      <button class="btn" id="mSave">${tx ? "Salvar" : "Registrar"}</button>
    </div>`);
  let curType = type;
  const fillCats = () => {
    const list = curType === "entrada" ? CATS_IN : CATS_OUT;
    $("#mCat").innerHTML = list.map(c => `<option ${t.category === c ? "selected" : ""}>${c}</option>`).join("");
  };
  fillCats();
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
      <div class="field"><label>Parcela mensal (R$)</label><input id="dMonthly" inputmode="decimal" value="${t.monthlyPayment ?? ""}"></div>
      <div class="field"><label>Juros % a.m. (se souber)</label><input id="dInterest" type="number" step="0.1" value="${t.interest ?? ""}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Status</label><select id="dStatus">
        ${["em dia","atrasada","negociando","quitada"].map(s => `<option ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
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
    const data = {
      name, currentValue: parseMoney($("#dTotal").value), total: parseMoney($("#dTotal").value),
      paid: parseMoney($("#dPaid").value), monthlyPayment: parseMoney($("#dMonthly").value),
      interest: $("#dInterest").value ? +$("#dInterest").value : null,
      status: $("#dStatus").value, dueDay: $("#dDue").value ? +$("#dDue").value : null,
      note: $("#dNote").value.trim(), updatedAt: new Date().toISOString()
    };
    try {
      if (d) await updateDoc(doc(db, "households", hid, "debts", d.id), data);
      else await addDoc(collection(db, "households", hid, "debts"), data);
      closeModal(); toast("Dívida salva.");
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
  const key = localStorage.getItem("mf_claude_key");
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
{"valor": 123.45, "data": "YYYY-MM-DD", "descricao": "nome do estabelecimento/pessoa", "tipo": "saida" ou "entrada", "categoria": "uma de: ${CATS_OUT.join(", ")} (para saída) ou ${CATS_IN.join(", ")} (para entrada)", "forma": "uma de: ${METHODS.join(", ")}", "confianca": "alta|media|baixa"}
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

  // transações
  const fMonth = $("#fMonth");
  if (fMonth) fMonth.onchange = () => { $("#txTableBox").innerHTML = txTableFiltered(fMonth.value); attachHandlers(); };
  document.querySelectorAll("[data-edit-tx]").forEach(b => b.onclick = () => modalTx(TX.find(t => t.id === b.dataset.editTx)));
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

  // investimentos
  $("#btnAddInv") && ($("#btnAddInv").onclick = modalInvest);
  document.querySelectorAll("[data-del-inv]").forEach(b => b.onclick = async () => {
    if (confirm("Excluir este registro?")) await deleteDoc(doc(db, "households", hid, "investments", b.dataset.delInv));
  });

  // plano
  $("#btnEditGoal") && ($("#btnEditGoal").onclick = modalGoal);
  $("#btnPlanAI") && ($("#btnPlanAI").onclick = planAI);

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
    if (k) localStorage.setItem("mf_claude_key", k); else localStorage.removeItem("mf_claude_key");
    await setDoc(doc(db, "households", hid, "meta", "settings"), { model: $("#cfgModel").value }, { merge: true });
    toast("Chave salva neste dispositivo.");
  });
  $("#btnTestKey") && ($("#btnTestKey").onclick = async () => {
    const k = $("#cfgApiKey").value.trim();
    if (k) localStorage.setItem("mf_claude_key", k);
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
  $("#btnExport") && ($("#btnExport").onclick = () => {
    const blob = new Blob([JSON.stringify({ exportadoEm: new Date().toISOString(), transacoes: TX, dividas: DEBTS, investimentos: INVEST, config: SETTINGS }, null, 2)], { type: "application/json" });
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
