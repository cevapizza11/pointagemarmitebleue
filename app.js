/* ============================================================
   POINTEUSE LA MARMITE BLEUE
   ============================================================ */

// ---------- FIREBASE CONFIG ----------
// ⚠️ Thomas : remplace ces valeurs par celles de TON nouveau projet Firebase
// (Console Firebase > Paramètres du projet > Tes applications > Config SDK)
const firebaseConfig = {
  apiKey: "AIzaSyBZ03rRzX8DL5Xgqn7U1p8PfiL83Zqtmvc",
  authDomain: "pointagemarmitebleue.firebaseapp.com",
  projectId: "pointagemarmitebleue",
  storageBucket: "pointagemarmitebleue.firebasestorage.app",
  messagingSenderId: "483578019330",
  appId: "1:483578019330:web:f15b69bfd7d652b773711b"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Collections Firestore utilisées :
//   employees   { id, name, pinHash, plannedTime, active, createdAt }
//   punches     { id, employeeId, employeeName, type ('in'|'pause'|'resume'|'out'), timestamp, isLate }
//   settings    { id:'general', lateTime, adminPinHash }

// ---------- STATE ----------
let state = {
  employees: [],          // tous les équipiers actifs
  todayPunches: [],        // pointages du jour, en direct
  settings: { lateTime: "11:00", adminPinHash: null },
  selectedEmployee: null,  // employé en cours de pointage
  pinBuffer: "",
  pinMode: "check",        // "check" (existant) ou "create" (1ère fois)
  pinCreateStep: 1,        // 1 = première saisie, 2 = confirmation
  pinFirstEntry: "",
  pendingPunchType: null,
  isAdminUnlocked: false
};

// ---------- UTIL ----------
function pad(n){ return n.toString().padStart(2,"0"); }
function nowParts(){
  const d = new Date();
  return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), d };
}
function fmtTime(d){ return pad(d.getHours())+":"+pad(d.getMinutes()); }
function fmtTimeSec(d){ return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds()); }
function fmtDateLong(d){
  return d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
}
function todayKey(d=new Date()){
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}
function initials(name){
  return name.trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()||"").join("");
}
async function sha256(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
function showToast(msg, ms=2400){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove("show"), ms);
}
function showScreen(id){
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ---------- CLOCK ----------
function tickClock(){
  const d = new Date();
  const clockEl = document.getElementById("home-clock");
  const dateEl = document.getElementById("home-date");
  if(clockEl){
    clockEl.childNodes[0].nodeValue = fmtTime(d);
  }
  if(dateEl) dateEl.textContent = fmtDateLong(d);
}
setInterval(tickClock, 1000);
tickClock();

// ============================================================
// FIRESTORE LISTENERS
// ============================================================
function listenEmployees(){
  db.collection("employees").where("active","==",true).orderBy("name")
    .onSnapshot(snap=>{
      state.employees = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderHomeGrid();
      renderEmployeesTable();
    }, err=>console.error("employees listener", err));
}

function listenTodayPunches(){
  const start = new Date(); start.setHours(0,0,0,0);
  db.collection("punches")
    .where("timestamp",">=", start)
    .orderBy("timestamp","asc")
    .onSnapshot(snap=>{
      state.todayPunches = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderHomeGrid();
      renderTodayTable();
    }, err=>console.error("punches listener", err));
}

async function loadSettings(){
  try{
    const doc = await db.collection("settings").doc("general").get();
    if(doc.exists){
      state.settings = { ...state.settings, ...doc.data() };
    } else {
      await db.collection("settings").doc("general").set(state.settings);
    }
  }catch(e){ console.error("loadSettings", e); }
  document.getElementById("setting-late-time").value = state.settings.lateTime || "11:00";
}

// ============================================================
// EMPLOYEE STATUS HELPERS
// ============================================================
// Renvoie le dernier statut du jour pour un employé : 'out' | 'in' | 'pause'
function lastStatusFor(employeeId){
  const punches = state.todayPunches.filter(p=>p.employeeId===employeeId);
  if(punches.length===0) return {status:"out", last:null};
  const last = punches[punches.length-1];
  let status = "out";
  if(last.type==="in" || last.type==="resume") status = "in";
  else if(last.type==="pause") status = "pause";
  else if(last.type==="out") status = "out";
  return {status, last};
}

function totalWorkedMs(employeeId){
  const punches = state.todayPunches.filter(p=>p.employeeId===employeeId)
    .sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
  let total = 0, openStart = null;
  for(const p of punches){
    const t = p.timestamp.toMillis();
    if(p.type==="in" || p.type==="resume"){
      openStart = t;
    } else if((p.type==="pause" || p.type==="out") && openStart!==null){
      total += (t - openStart);
      openStart = null;
    }
  }
  if(openStart!==null) total += (Date.now() - openStart); // session en cours
  return total;
}

function fmtDuration(ms){
  const totalMin = Math.floor(ms/60000);
  const h = Math.floor(totalMin/60), m = totalMin%60;
  return `${h}h${pad(m)}`;
}

// Type de pointage suivant logique : out->in, in->pause, pause->resume, in/resume->out (choix via UI)
function nextActionsFor(status){
  if(status==="out") return [{type:"in", label:"Pointer l'arrivée"}];
  if(status==="in") return [{type:"pause", label:"Partir en pause"}, {type:"out", label:"Pointer la sortie"}];
  if(status==="pause") return [{type:"resume", label:"Reprendre le travail"}, {type:"out", label:"Pointer la sortie"}];
  return [];
}

// ============================================================
// RENDER : HOME GRID
// ============================================================
function renderHomeGrid(){
  const grid = document.getElementById("emp-grid");
  if(state.employees.length===0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <b>Aucun équipier configuré</b>
      Demandez à votre gérant de vous ajouter dans l'espace administration.
    </div>`;
    return;
  }
  grid.innerHTML = state.employees.map(emp=>{
    const {status} = lastStatusFor(emp.id);
    const statusLabel = status==="in" ? "En service" : status==="pause" ? "En pause" : "Hors service";
    const statusClass = status==="in" ? "status-in" : status==="pause" ? "status-pause" : "status-out";
    return `
      <div class="emp-card" data-id="${emp.id}">
        <div class="emp-avatar">${initials(emp.name)}</div>
        <div class="emp-name">${escapeHtml(emp.name)}</div>
        <div class="emp-status ${statusClass}">${statusLabel}</div>
      </div>`;
  }).join("");
  grid.querySelectorAll(".emp-card").forEach(card=>{
    card.addEventListener("click", ()=>openPinScreen(card.dataset.id));
  });
}

function escapeHtml(str){
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ============================================================
// PIN SCREEN
// ============================================================
function buildNumpad(){
  const pad_ = document.getElementById("numpad");
  const keys = ["1","2","3","4","5","6","7","8","9","","0","del"];
  pad_.innerHTML = keys.map(k=>{
    if(k==="") return `<div></div>`;
    if(k==="del") return `<button class="num-btn ghost" data-key="del">Effacer</button>`;
    return `<button class="num-btn" data-key="${k}">${k}</button>`;
  }).join("");
  pad_.querySelectorAll(".num-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>onNumpadPress(btn.dataset.key));
  });
}

function openPinScreen(employeeId){
  const emp = state.employees.find(e=>e.id===employeeId);
  if(!emp) return;
  state.selectedEmployee = emp;
  state.pinBuffer = "";
  state.pinCreateStep = 1;
  state.pinFirstEntry = "";
  state.pinMode = emp.pinHash ? "check" : "create";

  document.getElementById("pin-avatar").textContent = initials(emp.name);
  document.getElementById("pin-name").textContent = emp.name;
  document.getElementById("pin-msg").textContent = "";

  if(state.pinMode === "create"){
    document.getElementById("pin-sub").textContent = "Première fois ? Créez votre code à 4 chiffres";
  } else {
    document.getElementById("pin-sub").textContent = "Entrez votre code";
  }
  renderPinDots();
  showScreen("screen-pin");
}

function renderPinDots(){
  const dots = document.querySelectorAll("#pin-dots .pin-dot");
  dots.forEach((dot,i)=>{
    dot.className = "pin-dot" + (i < state.pinBuffer.length ? " filled" : "");
  });
}

function shakeDotsError(msg){
  const dots = document.querySelectorAll("#pin-dots .pin-dot");
  dots.forEach(d=>d.classList.add("error"));
  document.getElementById("pin-msg").textContent = msg;
  setTimeout(()=>{
    dots.forEach(d=>d.classList.remove("error"));
    state.pinBuffer = "";
    renderPinDots();
  }, 550);
}

async function onNumpadPress(key){
  if(key === "del"){
    state.pinBuffer = state.pinBuffer.slice(0,-1);
    renderPinDots();
    return;
  }
  if(state.pinBuffer.length >= 4) return;
  state.pinBuffer += key;
  renderPinDots();

  if(state.pinBuffer.length === 4){
    await handlePinComplete();
  }
}

async function handlePinComplete(){
  const emp = state.selectedEmployee;

  if(state.pinMode === "create"){
    if(state.pinCreateStep === 1){
      state.pinFirstEntry = state.pinBuffer;
      state.pinBuffer = "";
      state.pinCreateStep = 2;
      document.getElementById("pin-sub").textContent = "Confirmez votre code";
      renderPinDots();
      return;
    } else {
      if(state.pinBuffer !== state.pinFirstEntry){
        shakeDotsError("Les codes ne correspondent pas");
        state.pinCreateStep = 1;
        state.pinFirstEntry = "";
        document.getElementById("pin-sub").textContent = "Première fois ? Créez votre code à 4 chiffres";
        return;
      }
      // Enregistrer le PIN
      const hash = await sha256(emp.id + ":" + state.pinBuffer);
      try{
        await db.collection("employees").doc(emp.id).update({ pinHash: hash });
        showToast("Code créé ✓ Bienvenue " + emp.name.split(" ")[0]);
        proceedToPunch(emp);
      }catch(e){
        console.error(e);
        shakeDotsError("Erreur, réessayez");
      }
    }
  } else {
    // mode check
    const hash = await sha256(emp.id + ":" + state.pinBuffer);
    if(hash === emp.pinHash){
      proceedToPunch(emp);
    } else {
      shakeDotsError("Code incorrect");
    }
  }
}

document.getElementById("pin-back-btn").addEventListener("click", ()=>{
  state.pinBuffer = "";
  showScreen("screen-home");
});

// ============================================================
// PUNCH FLOW
// ============================================================
function proceedToPunch(emp){
  const {status} = lastStatusFor(emp.id);
  const actions = nextActionsFor(status);

  if(actions.length === 1){
    doPunch(emp, actions[0].type);
  } else {
    // plusieurs choix possibles (pause ou sortie) -> mini choix rapide via confirm screen actions
    showChoiceForPunch(emp, actions);
  }
}

function showChoiceForPunch(emp, actions){
  // Réutilise l'écran PIN en mode "choix" simplifié : on construit un petit menu dans pin-msg
  const pinWrap = document.querySelector(".pin-wrap");
  document.getElementById("pin-sub").textContent = "Que voulez-vous faire ?";
  document.getElementById("pin-dots").style.display = "none";
  document.getElementById("numpad").innerHTML = actions.map(a=>
    `<button class="num-btn ghost" style="grid-column:span 3;background:rgba(250,246,238,0.08);border-radius:14px;aspect-ratio:auto;padding:16px;font-family:Inter;font-size:15px;" data-action="${a.type}">${a.label}</button>`
  ).join("");
  document.querySelectorAll("#numpad [data-action]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      doPunch(emp, btn.dataset.action);
      // reset numpad pour le prochain usage
      setTimeout(()=>{
        document.getElementById("pin-dots").style.display = "flex";
        buildNumpad();
      }, 100);
    });
  });
}

async function doPunch(emp, type){
  const now = new Date();
  let isLate = false;

  if(type === "in"){
    const lateTime = state.settings.lateTime || "11:00";
    const [lh, lm] = lateTime.split(":").map(Number);
    const limit = new Date(now); limit.setHours(lh, lm, 0, 0);
    if(now > limit) isLate = true;
  }

  try{
    await db.collection("punches").add({
      employeeId: emp.id,
      employeeName: emp.name,
      type: type,
      timestamp: firebase.firestore.Timestamp.fromDate(now),
      isLate: isLate
    });
  }catch(e){
    console.error("doPunch error", e);
    showToast("Erreur réseau, réessayez");
    showScreen("screen-home");
    return;
  }

  showConfirmScreen(emp, type, now, isLate);
}

function showConfirmScreen(emp, type, time, isLate){
  const icon = document.getElementById("confirm-icon");
  const title = document.getElementById("confirm-title");
  const lateWrap = document.getElementById("confirm-late-wrap");

  const ICONS = {
    in: `<svg viewBox="0 0 24 24" fill="none" stroke="#4C7A5E" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>`,
    resume: `<svg viewBox="0 0 24 24" fill="none" stroke="#4C7A5E" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="none" stroke="#C1602F" stroke-width="2.5"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
    out: `<svg viewBox="0 0 24 24" fill="none" stroke="#A8412B" stroke-width="2.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>`
  };
  const TITLES = { in:"Arrivée enregistrée", resume:"Reprise enregistrée", pause:"Bonne pause !", out:"Sortie enregistrée" };
  const CLASS = { in:"in", resume:"in", pause:"pause", out:"out" };

  icon.className = "confirm-icon " + CLASS[type];
  icon.innerHTML = ICONS[type];
  title.textContent = TITLES[type];
  document.getElementById("confirm-name").textContent = emp.name;
  document.getElementById("confirm-time").textContent = fmtTime(time);
  lateWrap.innerHTML = isLate ? `<div class="confirm-late">⏱ Arrivée après l'heure prévue</div>` : "";

  showScreen("screen-confirm");
  document.getElementById("pin-dots").style.display = "flex";

  setTimeout(()=>{
    showScreen("screen-home");
  }, 2200);
}

// ============================================================
// ADMIN — UNLOCK
// ============================================================
document.getElementById("admin-dot-trigger").addEventListener("click", openLock);
let dotClicks = 0;

function openLock(){
  document.getElementById("lock-screen").style.display = "flex";
  document.getElementById("lock-input").value = "";
  document.getElementById("lock-error").textContent = "";
  setTimeout(()=>document.getElementById("lock-input").focus(), 100);
}
document.getElementById("lock-cancel-btn").addEventListener("click", ()=>{
  document.getElementById("lock-screen").style.display = "none";
});
document.getElementById("lock-confirm-btn").addEventListener("click", checkAdminPin);
document.getElementById("lock-input").addEventListener("keydown", (e)=>{
  if(e.key === "Enter") checkAdminPin();
});

async function checkAdminPin(){
  const val = document.getElementById("lock-input").value.trim();
  if(!val){ return; }
  const hash = await sha256("ADMIN:" + val);
  if(!state.settings.adminPinHash){
    // Premier réglage : on définit ce code comme code admin
    await db.collection("settings").doc("general").set({ ...state.settings, adminPinHash: hash }, {merge:true});
    state.settings.adminPinHash = hash;
    showToast("Code administration défini ✓");
    enterAdmin();
    return;
  }
  if(hash === state.settings.adminPinHash){
    enterAdmin();
  } else {
    document.getElementById("lock-error").textContent = "Code incorrect";
  }
}

function enterAdmin(){
  document.getElementById("lock-screen").style.display = "none";
  state.isAdminUnlocked = true;
  showScreen("screen-admin");
  renderTodayTable();
  renderEmployeesTable();
  populateReportMonths();
}

document.getElementById("admin-exit-btn").addEventListener("click", ()=>{
  state.isAdminUnlocked = false;
  showScreen("screen-home");
});

// ---------- ADMIN TABS ----------
document.querySelectorAll(".admin-tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".admin-tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".admin-section").forEach(s=>s.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-"+tab.dataset.tab).classList.add("active");
    if(tab.dataset.tab === "reports") renderReportTable();
  });
});

// ============================================================
// ADMIN — TODAY TABLE
// ============================================================
function renderTodayTable(){
  const tbody = document.getElementById("today-table-body");
  const statsEl = document.getElementById("today-stats");

  if(state.employees.length === 0){
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:rgba(30,38,36,0.4);padding:30px;">Aucun équipier configuré</td></tr>`;
    statsEl.innerHTML = "";
    return;
  }

  let presentCount = 0, lateCount = 0;

  tbody.innerHTML = state.employees.map(emp=>{
    const punches = state.todayPunches.filter(p=>p.employeeId===emp.id);
    const get = (type)=> punches.find(p=>p.type===type);
    const inP = get("in"), pauseP = get("pause"), resumeP = get("resume"), outP = get("out");
    const {status} = lastStatusFor(emp.id);
    if(status !== "out" || inP) presentCount++;
    if(inP && inP.isLate) lateCount++;

    const statusPill = status==="in" ? `<span class="pill pill-in">En service</span>`
      : status==="pause" ? `<span class="pill pill-pause">En pause</span>`
      : inP ? `<span class="pill pill-out">Terminé</span>`
      : `<span class="pill pill-out">—</span>`;

    const total = punches.length>0 ? fmtDuration(totalWorkedMs(emp.id)) : "—";

    return `<tr>
      <td><b>${escapeHtml(emp.name)}</b></td>
      <td>${inP ? fmtTime(inP.timestamp.toDate()) : "—"} ${inP && inP.isLate ? '<span class="pill pill-late">retard</span>' : ""}</td>
      <td>${pauseP ? fmtTime(pauseP.timestamp.toDate()) : "—"}</td>
      <td>${resumeP ? fmtTime(resumeP.timestamp.toDate()) : "—"}</td>
      <td>${outP ? fmtTime(outP.timestamp.toDate()) : "—"}</td>
      <td>${total}</td>
      <td>${statusPill}</td>
    </tr>`;
  }).join("");

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-num">${presentCount}</div><div class="stat-label">Présents aujourd'hui</div></div>
    <div class="stat-card"><div class="stat-num">${lateCount}</div><div class="stat-label">Retards aujourd'hui</div></div>
    <div class="stat-card"><div class="stat-num">${state.employees.length}</div><div class="stat-label">Équipiers actifs</div></div>
  `;
}
document.getElementById("refresh-today-btn").addEventListener("click", renderTodayTable);

// ============================================================
// ADMIN — EMPLOYEES TABLE
// ============================================================
function renderEmployeesTable(){
  const tbody = document.getElementById("employees-table-body");
  if(state.employees.length === 0){
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:rgba(30,38,36,0.4);padding:30px;">Aucun équipier. Cliquez sur "+ Ajouter".</td></tr>`;
    return;
  }
  tbody.innerHTML = state.employees.map(emp=>{
    const {status} = lastStatusFor(emp.id);
    const statusPill = status==="in" ? `<span class="pill pill-in">En service</span>`
      : status==="pause" ? `<span class="pill pill-pause">En pause</span>`
      : `<span class="pill pill-out">Hors service</span>`;
    return `<tr>
      <td><b>${escapeHtml(emp.name)}</b></td>
      <td>${emp.pinHash ? "✅ Oui" : "— Pas encore"}</td>
      <td>${emp.plannedTime || "—"}</td>
      <td>${statusPill}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${emp.id}">Modifier</button>
        <button class="btn btn-ghost btn-sm" data-action="reset-pin" data-id="${emp.id}">Réinit. PIN</button>
        <button class="btn btn-danger btn-sm" data-action="remove" data-id="${emp.id}">Retirer</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action='edit']").forEach(b=>b.addEventListener("click", ()=>openEmployeeModal(b.dataset.id)));
  tbody.querySelectorAll("[data-action='reset-pin']").forEach(b=>b.addEventListener("click", ()=>resetEmployeePin(b.dataset.id)));
  tbody.querySelectorAll("[data-action='remove']").forEach(b=>b.addEventListener("click", ()=>removeEmployee(b.dataset.id)));
}

async function resetEmployeePin(id){
  const emp = state.employees.find(e=>e.id===id);
  if(!confirm(`Réinitialiser le code PIN de ${emp.name} ?\nIl/elle devra en créer un nouveau au prochain pointage.`)) return;
  await db.collection("employees").doc(id).update({ pinHash: null });
  showToast("Code PIN réinitialisé");
}

async function removeEmployee(id){
  const emp = state.employees.find(e=>e.id===id);
  if(!confirm(`Retirer ${emp.name} de la liste des équipiers actifs ?\n(L'historique de pointage est conservé)`)) return;
  await db.collection("employees").doc(id).update({ active: false });
  showToast("Équipier retiré");
}

// ---------- EMPLOYEE MODAL ----------
document.getElementById("add-employee-btn").addEventListener("click", ()=>openEmployeeModal(null));
document.getElementById("emp-modal-cancel").addEventListener("click", closeEmployeeModal);

function openEmployeeModal(id){
  const modal = document.getElementById("employee-modal");
  const title = document.getElementById("employee-modal-title");
  if(id){
    const emp = state.employees.find(e=>e.id===id);
    title.textContent = "Modifier l'équipier";
    document.getElementById("emp-id-field").value = emp.id;
    document.getElementById("emp-name-field").value = emp.name;
    document.getElementById("emp-time-field").value = emp.plannedTime || "";
  } else {
    title.textContent = "Ajouter un équipier";
    document.getElementById("emp-id-field").value = "";
    document.getElementById("emp-name-field").value = "";
    document.getElementById("emp-time-field").value = "";
  }
  modal.classList.add("show");
}
function closeEmployeeModal(){
  document.getElementById("employee-modal").classList.remove("show");
}

document.getElementById("emp-modal-save").addEventListener("click", async ()=>{
  const id = document.getElementById("emp-id-field").value;
  const name = document.getElementById("emp-name-field").value.trim();
  const plannedTime = document.getElementById("emp-time-field").value;
  if(!name){ showToast("Le nom est obligatoire"); return; }

  try{
    if(id){
      await db.collection("employees").doc(id).update({ name, plannedTime });
      showToast("Équipier modifié ✓");
    } else {
      await db.collection("employees").add({
        name, plannedTime, active:true, pinHash:null,
        createdAt: firebase.firestore.Timestamp.now()
      });
      showToast("Équipier ajouté ✓");
    }
    closeEmployeeModal();
  }catch(e){
    console.error(e);
    showToast("Erreur lors de l'enregistrement");
  }
});

// ============================================================
// ADMIN — MONTHLY REPORTS
// ============================================================
function populateReportMonths(){
  const sel = document.getElementById("report-month");
  const now = new Date();
  let opts = [];
  for(let i=0;i<12;i++){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const label = d.toLocaleDateString('fr-FR', {month:'long', year:'numeric'});
    const value = d.getFullYear()+"-"+pad(d.getMonth()+1);
    opts.push(`<option value="${value}">${label.charAt(0).toUpperCase()+label.slice(1)}</option>`);
  }
  sel.innerHTML = opts.join("");
  sel.addEventListener("change", renderReportTable);
}

let reportCache = []; // dernier rapport calculé, pour export CSV

async function renderReportTable(){
  const monthVal = document.getElementById("report-month").value; // "YYYY-MM"
  if(!monthVal) return;
  const [year, month] = monthVal.split("-").map(Number);
  const start = new Date(year, month-1, 1, 0,0,0);
  const end = new Date(year, month, 1, 0,0,0);

  const tbody = document.getElementById("report-table-body");
  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Chargement…</td></tr>`;

  let snap;
  try{
    snap = await db.collection("punches")
      .where("timestamp",">=", firebase.firestore.Timestamp.fromDate(start))
      .where("timestamp","<", firebase.firestore.Timestamp.fromDate(end))
      .orderBy("timestamp","asc")
      .get();
  }catch(e){
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--danger);">Erreur de chargement</td></tr>`;
    return;
  }

  const punches = snap.docs.map(d=>({id:d.id, ...d.data()}));

  // Regrouper par employé puis par jour pour calculer les heures
  const byEmployee = {};
  punches.forEach(p=>{
    if(!byEmployee[p.employeeId]) byEmployee[p.employeeId] = { name:p.employeeName, byDay:{} };
    const day = todayKey(p.timestamp.toDate());
    if(!byEmployee[p.employeeId].byDay[day]) byEmployee[p.employeeId].byDay[day] = [];
    byEmployee[p.employeeId].byDay[day].push(p);
  });

  let rows = [];
  let totalHoursAll = 0, totalLateAll = 0;

  Object.entries(byEmployee).forEach(([empId, data])=>{
    let totalMs = 0, lateCount = 0, daysWorked = 0;
    Object.values(data.byDay).forEach(dayPunches=>{
      daysWorked++;
      dayPunches.sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
      let openStart = null;
      dayPunches.forEach(p=>{
        if(p.type==="in"){
          if(p.isLate) lateCount++;
          openStart = p.timestamp.toMillis();
        } else if(p.type==="resume"){
          openStart = p.timestamp.toMillis();
        } else if((p.type==="pause"||p.type==="out") && openStart!==null){
          totalMs += p.timestamp.toMillis() - openStart;
          openStart = null;
        }
      });
    });
    totalHoursAll += totalMs;
    totalLateAll += lateCount;
    rows.push({ name:data.name, daysWorked, totalMs, lateCount });
  });

  rows.sort((a,b)=>a.name.localeCompare(b.name));
  reportCache = rows;

  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Aucun pointage ce mois-ci</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r=>`
      <tr>
        <td><b>${escapeHtml(r.name)}</b></td>
        <td>${r.daysWorked}</td>
        <td>${fmtDuration(r.totalMs)}</td>
        <td>${r.lateCount > 0 ? `<span class="pill pill-late">${r.lateCount}</span>` : "0"}</td>
      </tr>`).join("");
  }

  document.getElementById("report-stats").innerHTML = `
    <div class="stat-card"><div class="stat-num">${fmtDuration(totalHoursAll)}</div><div class="stat-label">Total heures équipe</div></div>
    <div class="stat-card"><div class="stat-num">${totalLateAll}</div><div class="stat-label">Retards ce mois</div></div>
    <div class="stat-card"><div class="stat-num">${rows.length}</div><div class="stat-label">Équipiers actifs ce mois</div></div>
  `;
}

document.getElementById("export-csv-btn").addEventListener("click", ()=>{
  if(reportCache.length === 0){ showToast("Aucune donnée à exporter"); return; }
  const monthLabel = document.getElementById("report-month").selectedOptions[0]?.textContent || "rapport";
  let csv = "Équipier;Jours travaillés;Heures totales;Retards\n";
  reportCache.forEach(r=>{
    csv += `${r.name};${r.daysWorked};${fmtDuration(r.totalMs).replace("h",",")};${r.lateCount}\n`;
  });
  const blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pointage_${monthLabel.replace(/\s+/g,"_")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Export CSV téléchargé ✓");
});

// ============================================================
// ADMIN — SETTINGS
// ============================================================
document.getElementById("save-settings-btn").addEventListener("click", async ()=>{
  const lateTime = document.getElementById("setting-late-time").value;
  const newAdminPin = document.getElementById("setting-admin-pin").value.trim();

  const update = { lateTime };
  if(newAdminPin){
    if(newAdminPin.length < 4){ showToast("Le code admin doit faire au moins 4 chiffres"); return; }
    update.adminPinHash = await sha256("ADMIN:" + newAdminPin);
  }

  try{
    await db.collection("settings").doc("general").set(update, {merge:true});
    state.settings = { ...state.settings, ...update };
    document.getElementById("setting-admin-pin").value = "";
    showToast("Réglages enregistrés ✓");
  }catch(e){
    console.error(e);
    showToast("Erreur lors de l'enregistrement");
  }
});

// ============================================================
// INIT
// ============================================================
async function init(){
  buildNumpad();
  await loadSettings();
  listenEmployees();
  listenTodayPunches();
}
init();
