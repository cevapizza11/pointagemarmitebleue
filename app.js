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
//   punches     { id, employeeId, employeeName, type ('in'|'pause'|'resume'|'out'), timestamp }
//   settings    { id:'general', adminPinHash }

// ---------- STATE ----------
let state = {
  employees: [],          // tous les équipiers actifs
  todayPunches: [],        // pointages du jour, en direct
  settings: { adminPinHash: null },
  selectedEmployee: null,  // employé en cours de pointage
  pinBuffer: "",
  pinMode: "check",        // "check" (existant) ou "create" (1ère fois)
  pinCreateStep: 1,        // 1 = première saisie, 2 = confirmation
  pinFirstEntry: "",
  pendingPunchType: null,
  isAdminUnlocked: false
};

// ---------- UTIL ----------
const ANOMALY_THRESHOLD_MS = 5 * 60 * 60 * 1000;  // 5h : session anormalement longue (probable oubli de pointage)
const MAX_DAILY_WORK_MS = 10 * 60 * 60 * 1000;     // 10h : durée de travail effectif max/jour (Code du travail)
const MAX_AMPLITUDE_MS = 13 * 60 * 60 * 1000;      // 13h : amplitude max de la journée (prise de poste → fin)
const MIN_DAILY_REST_MS = 11 * 60 * 60 * 1000;     // 11h : repos quotidien minimum entre 2 journées
const MAX_WEEKLY_WORK_MS = 48 * 60 * 60 * 1000;    // 48h : plafond absolu hebdomadaire

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

// ---------- ALERTE TEMPS RÉEL : équipier en service depuis plus de 5h ----------
let liveAnomalyShownFor = new Set(); // évite de réafficher la pop-up pour le même équipier en boucle

function checkLiveAnomalies(){
  if(document.getElementById("screen-home").classList.contains("active") === false) return;
  state.employees.forEach(emp=>{
    const {status} = lastStatusFor(emp.id);
    if(status === "out") { liveAnomalyShownFor.delete(emp.id); return; }
    const ms = totalWorkedMs(emp.id);
    if(ms > ANOMALY_THRESHOLD_MS && !liveAnomalyShownFor.has(emp.id)){
      liveAnomalyShownFor.add(emp.id);
      showLiveAnomalyBanner(emp.name, ms);
    }
  });
}
setInterval(checkLiveAnomalies, 60000);

function showLiveAnomalyBanner(name, ms){
  const modal = document.getElementById("anomaly-modal");
  const list = document.getElementById("anomaly-list");
  document.getElementById("anomaly-modal-title").textContent = "⚠ Anomalie détectée";
  list.innerHTML = `
    <div class="anomaly-item">
      <div class="anomaly-item-name">${escapeHtml(name)}</div>
      <div class="anomaly-item-detail">Toujours pointé(e) en service depuis plus de 5h (<b>${fmtDuration(ms)}</b>). Vérifiez qu'il ne s'agit pas d'un oubli de dépointage.</div>
    </div>`;
  modal.classList.add("show");
}


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
}

// ============================================================
// ADMIN — CONTRÔLE DES POINTAGES (vue jour par jour)
// ============================================================
let controlDate = new Date(); // date actuellement affichée dans l'onglet contrôle
let controlCache = [];        // dernier jeu de lignes calculé, pour export CSV

function fmtControlDateLabel(d){
  const label = d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function isSameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

const LEGAL_ANOMALY_LABELS = {
  amplitude: "Amplitude > 13h",
  daily_work: "Travail effectif > 10h/jour",
  daily_rest: "Repos quotidien < 11h",
  weekly_max: "Plafond 48h/semaine dépassé",
  complementary: "Heures complémentaires (temps partiel)",
  long_session: "Session anormalement longue (>5h sans pointage)"
};

// Enregistre les anomalies détectées dans Firestore avec un ID stable (pas de doublons).
// Chaque anomalie garde sa date de première détection (detectedAt) si elle existe déjà.
async function persistAnomalies(sessionAnomalies, legalAnomalies){
  const all = [
    ...sessionAnomalies.map(r=>({
      type:"long_session", employeeId:r.employeeId, name:r.name, refDateKey:r.refDateKey,
      detail:`Session ${r.inTime} → ${r.outTime !== "—" ? r.outTime : "en cours"} : ${fmtDuration(r.totalMs)} sans pointage intermédiaire`,
      docId: `${r.employeeId}_long_session_${r.refDateKey}_${r.sessionIdx}`
    })),
    ...legalAnomalies.map(a=>({
      ...a,
      docId: `${a.employeeId}_${a.type}_${a.refDateKey}`
    }))
  ];

  for(const a of all){
    try{
      const ref = db.collection("anomalies").doc(a.docId);
      const existing = await ref.get();
      if(!existing.exists){
        await ref.set({
          type:a.type, employeeId:a.employeeId, name:a.name,
          refDateKey:a.refDateKey, detail:a.detail,
          detectedAt: firebase.firestore.Timestamp.now()
        });
      }
    }catch(e){
      console.error("persistAnomalies error", e);
    }
  }
}

// Supprime de Firestore les anomalies enregistrées pour ce jour qui ne sont plus détectées
// (le pointage a été corrigé depuis). Compare les docId actuellement valides à ceux en base.
async function cleanupResolvedAnomalies(refDateKey, sessionAnomalies, legalAnomalies){
  const stillValidIds = new Set([
    ...sessionAnomalies.map(r=>`${r.employeeId}_long_session_${r.refDateKey}_${r.sessionIdx}`),
    ...legalAnomalies.map(a=>`${a.employeeId}_${a.type}_${a.refDateKey}`)
  ]);

  try{
    const snap = await db.collection("anomalies").where("refDateKey","==", refDateKey).get({source: "server"});
    const deletions = [];
    snap.forEach(doc=>{
      if(!stillValidIds.has(doc.id)) deletions.push(db.collection("anomalies").doc(doc.id).delete());
    });
    if(deletions.length>0) await Promise.all(deletions);
  }catch(e){
    console.error("cleanupResolvedAnomalies error", e);
  }
}

// Scanne une plage de jours (du plus ancien au plus récent) et synchronise les anomalies
// détectées (persiste les nouvelles, supprime les résolues), jour par jour.
async function scanAndSyncAnomalies(daysBack=7){
  for(let i=daysBack; i>=0; i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    await syncAnomaliesForDay(d);
  }
}

// Logique de détection + persistance + nettoyage pour un jour donné, sans toucher à l'affichage du tableau.
async function syncAnomaliesForDay(refDate){
  const refDateKey = todayKey(refDate);
  const dayStart = new Date(refDate); dayStart.setHours(0,0,0,0);
  const dayEnd = new Date(refDate); dayEnd.setHours(23,59,59,999);

  let dayPunches;
  try{
    dayPunches = await fetchPunchesBetween(dayStart, dayEnd);
  }catch(e){ console.error("syncAnomaliesForDay fetch error", e); return; }

  const byEmployee = {};
  dayPunches.forEach(p=>{
    if(!byEmployee[p.employeeId]) byEmployee[p.employeeId] = { name:p.employeeName, punches:[] };
    byEmployee[p.employeeId].punches.push(p);
  });

  function splitIntoSessionsLocal(punchList){
    const sorted = [...punchList].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    const sessions = []; let current = null;
    sorted.forEach(p=>{
      if(p.type === "in"){ current = { in:p, pause:null, resume:null, out:null }; sessions.push(current); }
      else if(current){
        if(p.type==="pause") current.pause = p;
        else if(p.type==="resume") current.resume = p;
        else if(p.type==="out") current.out = p;
      } else {
        current = { in:null, pause:null, resume:null, out:null };
        if(p.type==="pause") current.pause = p;
        else if(p.type==="resume") current.resume = p;
        else if(p.type==="out") current.out = p;
        sessions.push(current);
      }
    });
    return sessions;
  }
  function sessionMs(s){
    let total=0, openStart = s.in ? s.in.timestamp.toMillis() : null;
    if(s.pause && openStart!==null){ total += s.pause.timestamp.toMillis()-openStart; openStart=null; }
    if(s.resume){ openStart = s.resume.timestamp.toMillis(); }
    if(s.out && openStart!==null){ total += s.out.timestamp.toMillis()-openStart; openStart=null; }
    return total;
  }

  const sessionAnomalies = [];
  Object.entries(byEmployee).forEach(([empId, data])=>{
    const sessions = splitIntoSessionsLocal(data.punches);
    sessions.forEach((s, idx)=>{
      const ms = sessionMs(s);
      if(ms > ANOMALY_THRESHOLD_MS){
        sessionAnomalies.push({
          employeeId: empId, name: data.name, refDateKey, sessionIdx: idx,
          inTime: s.in ? fmtTime(s.in.timestamp.toDate()) : "—",
          outTime: s.out ? fmtTime(s.out.timestamp.toDate()) : "—",
          totalMs: ms
        });
      }
    });
  });

  const legalAnomalies = await checkLegalAnomalies(refDate);
  await persistAnomalies(sessionAnomalies, legalAnomalies);
  await cleanupResolvedAnomalies(refDateKey, sessionAnomalies, legalAnomalies);
}

// ============================================================
// ADMIN — ONGLET ANOMALIES (récap persistant)
// ============================================================
async function renderAnomaliesTab(){
  const tbody = document.getElementById("anomalies-table-body");
  const statsEl = document.getElementById("anomalies-stats");
  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Chargement…</td></tr>`;

  let snap;
  try{
    snap = await db.collection("anomalies").orderBy("detectedAt","desc").get();
  }catch(e){
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--danger);">Erreur de chargement</td></tr>`;
    return;
  }

  const items = snap.docs.map(d=>({id:d.id, ...d.data()}));

  if(items.length === 0){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:rgba(30,38,36,0.4);">✅ Aucune anomalie en attente</td></tr>`;
  } else {
    tbody.innerHTML = items.map(a=>{
      const dateLabel = a.refDateKey ? a.refDateKey.split("-").reverse().join("/") : "—";
      const typeLabel = LEGAL_ANOMALY_LABELS[a.type] || a.type;
      const isLegal = a.type !== "long_session";
      return `<tr${isLegal ? ' style="background:rgba(168,65,43,0.04);"' : ""}>
        <td><b>${escapeHtml(a.name)}</b></td>
        <td>${dateLabel}</td>
        <td>${isLegal ? `<span style="color:var(--danger);font-weight:600;">${typeLabel}</span>` : typeLabel}</td>
        <td>${escapeHtml(a.detail)}</td>
      </tr>`;
    }).join("");
  }

  const legalCount = items.filter(a=>a.type!=="long_session").length;
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-num">${items.length}</div><div class="stat-label">Anomalies en attente</div></div>
    <div class="stat-card"><div class="stat-num">${legalCount}</div><div class="stat-label">dont seuils légaux dépassés</div></div>
  `;
}

document.getElementById("anomalies-refresh-btn").addEventListener("click", async ()=>{
  showToast("Vérification en cours…");
  await scanAndSyncAnomalies(30);
  await renderAnomaliesTab();
  showToast("Anomalies à jour ✓");
});

function showAnomalyPopupIfNeeded(rows, legalAnomalies){
  const sessionAnomalies = rows.filter(r=>r.anomaly);
  const hasLegal = legalAnomalies && legalAnomalies.length > 0;
  if(sessionAnomalies.length === 0 && !hasLegal) return;

  const modal = document.getElementById("anomaly-modal");
  const list = document.getElementById("anomaly-list");
  document.getElementById("anomaly-modal-title").textContent = "⚠ Anomalies détectées ce jour-là";

  let html = "";

  sessionAnomalies.forEach(r=>{
    html += `
    <div class="anomaly-item">
      <div class="anomaly-item-name">${escapeHtml(r.name)}${r.sessionLabel ? ` · ${r.sessionLabel}` : ""}</div>
      <div class="anomaly-item-detail">Session anormalement longue : ${r.inTime} → ${r.outTime !== "—" ? r.outTime : "toujours en service"} · <b>${fmtDuration(r.totalMs)}</b><br>Vérifiez qu'il ne s'agit pas d'un oubli de pointage.</div>
    </div>`;
  });

  if(hasLegal){
    legalAnomalies.forEach(a=>{
      html += `
      <div class="anomaly-item anomaly-item-legal">
        <div class="anomaly-item-name">${escapeHtml(a.name)} · <span style="color:var(--danger);">${LEGAL_ANOMALY_LABELS[a.type] || "Seuil légal dépassé"}</span></div>
        <div class="anomaly-item-detail">${escapeHtml(a.detail)}</div>
      </div>`;
    });
  }

  list.innerHTML = html;
  modal.classList.add("show");
}

document.getElementById("anomaly-modal-close").addEventListener("click", ()=>{
  document.getElementById("anomaly-modal").classList.remove("show");
});

// ============================================================
// GARDE-FOUS LÉGAUX (Code du travail)
// ============================================================
// Calcule, pour une liste de pointages déjà triés par heure, le temps de travail
// effectif total (ms) en traitant in/resume comme "ouverture" et pause/out comme "fermeture".
function effectiveWorkMs(sortedPunches){
  let total = 0, openStart = null;
  sortedPunches.forEach(p=>{
    if(p.type==="in" || p.type==="resume") openStart = p.timestamp.toMillis();
    else if((p.type==="pause" || p.type==="out") && openStart!==null){
      total += p.timestamp.toMillis() - openStart;
      openStart = null;
    }
  });
  return total;
}

// Amplitude = du tout premier pointage au tout dernier pointage de la journée
function amplitudeMs(sortedPunches){
  if(sortedPunches.length < 2) return 0;
  return sortedPunches[sortedPunches.length-1].timestamp.toMillis() - sortedPunches[0].timestamp.toMillis();
}

// Récupère tous les pointages entre deux dates (incluses), tous employés confondus
async function fetchPunchesBetween(startDate, endDate){
  const snap = await db.collection("punches")
    .where("timestamp",">=", firebase.firestore.Timestamp.fromDate(startDate))
    .where("timestamp","<=", firebase.firestore.Timestamp.fromDate(endDate))
    .orderBy("timestamp","asc")
    .get({source: "server"}); // lecture serveur forcée : évite un cache local périmé juste après une modification
  return snap.docs.map(d=>({id:d.id, ...d.data()}));
}

// Vérifie les garde-fous légaux pour le jour affiché (controlDate) :
// amplitude >13h, travail effectif >10h/jour, repos <11h avec la veille, >48h sur 7 jours glissants,
// et heures complémentaires temps partiel (>10% du contrat) sur la semaine glissante.
async function checkLegalAnomalies(refDate){
  const legalAnomalies = [];
  const refDateKey = todayKey(refDate);

  const dayStart = new Date(refDate); dayStart.setHours(0,0,0,0);
  const dayEnd = new Date(refDate); dayEnd.setHours(23,59,59,999);
  const prevDayStart = new Date(dayStart); prevDayStart.setDate(prevDayStart.getDate()-1);
  const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate()-6); // 7 jours glissants incl. refDate

  let todayP, prevDayP, weekP;
  try{
    [todayP, prevDayP, weekP] = await Promise.all([
      fetchPunchesBetween(dayStart, dayEnd),
      fetchPunchesBetween(prevDayStart, dayStart),
      fetchPunchesBetween(weekStart, dayEnd)
    ]);
  }catch(e){
    console.error("checkLegalAnomalies fetch error", e);
    return legalAnomalies;
  }

  // --- Regroupement par employé pour le jour affiché ---
  const byEmpToday = {};
  todayP.forEach(p=>{
    if(!byEmpToday[p.employeeId]) byEmpToday[p.employeeId] = { name:p.employeeName, punches:[] };
    byEmpToday[p.employeeId].punches.push(p);
  });

  Object.entries(byEmpToday).forEach(([empId, data])=>{
    const sorted = [...data.punches].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());

    // Amplitude >13h
    const amp = amplitudeMs(sorted);
    if(amp > MAX_AMPLITUDE_MS){
      legalAnomalies.push({
        type:"amplitude", employeeId:empId, name:data.name, refDateKey,
        detail:`Amplitude de la journée : ${fmtDuration(amp)} (max légal 13h)`
      });
    }

    // Travail effectif >10h/jour
    const work = effectiveWorkMs(sorted);
    if(work > MAX_DAILY_WORK_MS){
      legalAnomalies.push({
        type:"daily_work", employeeId:empId, name:data.name, refDateKey,
        detail:`Travail effectif : ${fmtDuration(work)} sur la journée (max légal 10h)`
      });
    }
  });

  // --- Repos quotidien <11h : comparer dernière sortie de la veille à 1ère entrée du jour ---
  const byEmpPrev = {};
  prevDayP.forEach(p=>{
    if(!byEmpPrev[p.employeeId]) byEmpPrev[p.employeeId] = [];
    byEmpPrev[p.employeeId].push(p);
  });
  Object.entries(byEmpToday).forEach(([empId, data])=>{
    const todaySorted = [...data.punches].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    const firstInToday = todaySorted.find(p=>p.type==="in");
    const prevPunches = byEmpPrev[empId];
    if(!firstInToday || !prevPunches || prevPunches.length===0) return;
    const prevSorted = [...prevPunches].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    const lastOfPrevDay = prevSorted[prevSorted.length-1];
    const restMs = firstInToday.timestamp.toMillis() - lastOfPrevDay.timestamp.toMillis();
    if(restMs >= 0 && restMs < MIN_DAILY_REST_MS){
      legalAnomalies.push({
        type:"daily_rest", employeeId:empId, name:data.name, refDateKey,
        detail:`Repos entre les deux journées : ${fmtDuration(restMs)} seulement (minimum légal 11h)`
      });
    }
  });

  // --- >48h sur 7 jours glissants + heures complémentaires temps partiel ---
  const byEmpWeek = {};
  weekP.forEach(p=>{
    if(!byEmpWeek[p.employeeId]) byEmpWeek[p.employeeId] = { name:p.employeeName, punches:[] };
    byEmpWeek[p.employeeId].punches.push(p);
  });
  Object.entries(byEmpWeek).forEach(([empId, data])=>{
    const sorted = [...data.punches].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    const weekWork = effectiveWorkMs(sorted);
    if(weekWork > MAX_WEEKLY_WORK_MS){
      legalAnomalies.push({
        type:"weekly_max", employeeId:empId, name:data.name, refDateKey,
        detail:`${fmtDuration(weekWork)} sur les 7 derniers jours (plafond légal 48h)`
      });
    }

    const emp = state.employees.find(e=>e.id===empId);
    if(emp && emp.contractType === "temps_partiel" && emp.contractHours){
      const contractMs = emp.contractHours * 60 * 60 * 1000;
      const thresholdMs = contractMs * 1.10; // 10% d'heures complémentaires max
      if(weekWork > thresholdMs){
        legalAnomalies.push({
          type:"complementary", employeeId:empId, name:data.name, refDateKey,
          detail:`${fmtDuration(weekWork)} cette semaine pour un contrat de ${emp.contractHours}h (dépasse les 10% d'heures complémentaires autorisées)`
        });
      }
    }
  });

  return legalAnomalies;
}

async function renderControlTable(){
  const tbody = document.getElementById("control-table-body");
  const statsEl = document.getElementById("control-stats");
  document.getElementById("control-date-label").textContent = fmtControlDateLabel(controlDate);
  document.getElementById("control-today-btn").style.visibility = isSameDay(controlDate, new Date()) ? "hidden" : "visible";

  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Chargement…</td></tr>`;

  const start = new Date(controlDate); start.setHours(0,0,0,0);
  const end = new Date(controlDate); end.setHours(23,59,59,999);

  let snap;
  try{
    snap = await db.collection("punches")
      .where("timestamp",">=", firebase.firestore.Timestamp.fromDate(start))
      .where("timestamp","<=", firebase.firestore.Timestamp.fromDate(end))
      .orderBy("timestamp","asc")
      .get({source: "server"});
  }catch(e){
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--danger);">Erreur de chargement</td></tr>`;
    return;
  }

  const punches = snap.docs.map(d=>({id:d.id, ...d.data()}));

  // Regrouper par employé pour ce jour précis
  const byEmployee = {};
  punches.forEach(p=>{
    if(!byEmployee[p.employeeId]) byEmployee[p.employeeId] = { name:p.employeeName, punches:[] };
    byEmployee[p.employeeId].punches.push(p);
  });

  // Découpe la liste de pointages d'un employé en sessions successives.
  // Une session démarre à un "in" et se termine à un "out" (ou reste ouverte).
  // "pause"/"resume" à l'intérieur d'une session sont rattachés à celle-ci.
  function splitIntoSessions(punchList){
    const sorted = [...punchList].sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    const sessions = [];
    let current = null;
    sorted.forEach(p=>{
      if(p.type === "in"){
        current = { in:p, pause:null, resume:null, out:null };
        sessions.push(current);
      } else if(current){
        if(p.type==="pause") current.pause = p;
        else if(p.type==="resume") current.resume = p;
        else if(p.type==="out") current.out = p;
      } else {
        // pointage orphelin (pause/reprise/sortie sans entrée préalable ce jour-là)
        current = { in:null, pause:null, resume:null, out:null };
        if(p.type==="pause") current.pause = p;
        else if(p.type==="resume") current.resume = p;
        else if(p.type==="out") current.out = p;
        sessions.push(current);
      }
    });
    return sessions;
  }

  // Calcule le temps de travail effectif d'une session en traitant TOUS ses pointages
  // dans l'ordre chronologique (gère plusieurs pauses/reprises successives sans en perdre).
  function sessionDurationMs(s){
    const all = [s.in, s.pause, s.resume, s.out].filter(Boolean)
      .sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
    let total = 0, openStart = null;
    all.forEach(p=>{
      if(p.type==="in" || p.type==="resume") openStart = p.timestamp.toMillis();
      else if((p.type==="pause" || p.type==="out") && openStart!==null){
        total += p.timestamp.toMillis() - openStart;
        openStart = null;
      }
    });
    return total;
  }

  let rows = [];
  const refDateKeyForRows = todayKey(controlDate);
  Object.entries(byEmployee).forEach(([empId, data])=>{
    const sessions = splitIntoSessions(data.punches);
    sessions.forEach((s, idx)=>{
      const ms = sessionDurationMs(s);
      rows.push({
        employeeId: empId,
        name: data.name,
        refDateKey: refDateKeyForRows,
        sessionLabel: sessions.length > 1 ? `Passage ${idx+1}` : "",
        sessionIdx: idx,
        inP: s.in, pauseP: s.pause, resumeP: s.resume, outP: s.out,
        inTime: s.in ? fmtTime(s.in.timestamp.toDate()) : "—",
        pauseTime: s.pause ? fmtTime(s.pause.timestamp.toDate()) : "—",
        resumeTime: s.resume ? fmtTime(s.resume.timestamp.toDate()) : "—",
        outTime: s.out ? fmtTime(s.out.timestamp.toDate()) : "—",
        totalMs: ms,
        incomplete: !s.in || !s.out,
        anomaly: ms > ANOMALY_THRESHOLD_MS
      });
    });
  });

  rows.sort((a,b)=> a.name.localeCompare(b.name) || (a.inTime||"").localeCompare(b.inTime||""));
  controlCache = rows;

  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Aucun pointage ce jour-là</td></tr>`;
  } else {
    // Regrouper les sessions (rows) par équipier pour n'afficher qu'une seule ligne par personne
    const byEmpDisplay = {};
    rows.forEach((r, i)=>{
      if(!byEmpDisplay[r.employeeId]) byEmpDisplay[r.employeeId] = { name:r.name, sessions:[] };
      byEmpDisplay[r.employeeId].sessions.push({...r, rowIndex:i});
    });

    const cell = (punch, time, rowIndex, type, label)=>{
      if(punch){
        return `<div class="punch-cell">
          <span>${time}</span>
          <button class="punch-edit-btn" data-row="${rowIndex}" data-field="${type}" title="Modifier ${label}">✎</button>
        </div>`;
      } else {
        return `<button class="punch-add-btn" data-row="${rowIndex}" data-field="${type}" title="Ajouter ${label}">+ ${label}</button>`;
      }
    };

    tbody.innerHTML = Object.values(byEmpDisplay).map(emp=>{
      const totalMs = emp.sessions.reduce((sum,s)=>sum+s.totalMs,0);
      const hasIncomplete = emp.sessions.some(s=>s.incomplete);
      const hasAnomaly = emp.sessions.some(s=>s.anomaly);

      return `
      <tr>
        <td><b>${escapeHtml(emp.name)}</b></td>
        <td>${emp.sessions.map(s=>`<div class="slot-line">${cell(s.inP, s.inTime, s.rowIndex, "in", "Entrée")}</div>`).join("")}</td>
        <td>${emp.sessions.map(s=>`<div class="slot-line">${cell(s.pauseP, s.pauseTime, s.rowIndex, "pause", "Pause")}</div>`).join("")}</td>
        <td>${emp.sessions.map(s=>`<div class="slot-line">${cell(s.resumeP, s.resumeTime, s.rowIndex, "resume", "Reprise")}</div>`).join("")}</td>
        <td>${emp.sessions.map(s=>`<div class="slot-line">${cell(s.outP, s.outTime, s.rowIndex, "out", "Sortie")}</div>`).join("")}</td>
        <td><b>${totalMs>0 ? fmtDuration(totalMs) : "—"}</b>${hasIncomplete ? ' <span class="pill pill-late" style="margin-left:4px;">incomplet</span>' : ""}${hasAnomaly ? ' <span class="pill pill-late" style="margin-left:4px;">⚠ anomalie</span>' : ""}</td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".punch-edit-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>openPunchEditModal(rows[btn.dataset.row], btn.dataset.field));
    });
    tbody.querySelectorAll(".punch-add-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>openPunchAddModal(rows[btn.dataset.row], btn.dataset.field));
    });
  }

  const totalDayMs = rows.reduce((sum,r)=>sum+r.totalMs,0);
  const uniqueEmployees = new Set(rows.map(r=>r.name)).size;
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-num">${uniqueEmployees}</div><div class="stat-label">Équipiers présents</div></div>
    <div class="stat-card"><div class="stat-num">${rows.length}</div><div class="stat-label">Passages enregistrés</div></div>
    <div class="stat-card"><div class="stat-num">${fmtDuration(totalDayMs)}</div><div class="stat-label">Total heures du jour</div></div>
  `;

  const legalAnomalies = await checkLegalAnomalies(controlDate);
  const sessionAnomalies = rows.filter(r=>r.anomaly);
  await persistAnomalies(sessionAnomalies, legalAnomalies);
  await cleanupResolvedAnomalies(refDateKeyForRows, sessionAnomalies, legalAnomalies);
  showAnomalyPopupIfNeeded(rows, legalAnomalies);
}

document.getElementById("control-prev-btn").addEventListener("click", ()=>{
  controlDate.setDate(controlDate.getDate()-1);
  renderControlTable();
});
document.getElementById("control-next-btn").addEventListener("click", ()=>{
  controlDate.setDate(controlDate.getDate()+1);
  renderControlTable();
});
document.getElementById("control-today-btn").addEventListener("click", ()=>{
  controlDate = new Date();
  renderControlTable();
});
document.getElementById("control-date-picker").addEventListener("change", (e)=>{
  if(!e.target.value) return;
  const [y,m,d] = e.target.value.split("-").map(Number);
  controlDate = new Date(y, m-1, d);
  renderControlTable();
});

// ---------- ÉDITION / AJOUT / SUPPRESSION D'UN POINTAGE ----------
const FIELD_LABELS = { in:"Entrée", pause:"Pause", resume:"Reprise", out:"Sortie" };
const FIELD_KEY = { in:"inP", pause:"pauseP", resume:"resumeP", out:"outP" };

function openPunchEditModal(row, field){
  const punch = row[FIELD_KEY[field]];
  if(!punch) return;
  const modal = document.getElementById("punch-modal");
  document.getElementById("punch-modal-title").textContent = `Modifier : ${row.name} — ${FIELD_LABELS[field]}`;
  document.getElementById("punch-modal-id").value = punch.id;
  document.getElementById("punch-modal-employee").value = row.employeeId;
  document.getElementById("punch-modal-type").value = field;
  document.getElementById("punch-modal-mode").value = "edit";
  const d = punch.timestamp.toDate();
  document.getElementById("punch-modal-time").value = pad(d.getHours())+":"+pad(d.getMinutes());
  document.getElementById("punch-modal-delete-btn").style.display = "inline-block";
  modal.classList.add("show");
}

function openPunchAddModal(row, field){
  const modal = document.getElementById("punch-modal");
  document.getElementById("punch-modal-title").textContent = `Ajouter : ${row.name} — ${FIELD_LABELS[field]}`;
  document.getElementById("punch-modal-id").value = "";
  document.getElementById("punch-modal-employee").value = row.employeeId;
  document.getElementById("punch-modal-type").value = field;
  document.getElementById("punch-modal-mode").value = "add";
  document.getElementById("punch-modal-time").value = "12:00";
  document.getElementById("punch-modal-delete-btn").style.display = "none";
  modal.classList.add("show");
}

document.getElementById("punch-modal-cancel").addEventListener("click", ()=>{
  document.getElementById("punch-modal").classList.remove("show");
});

document.getElementById("punch-modal-save").addEventListener("click", async ()=>{
  const mode = document.getElementById("punch-modal-mode").value;
  const id = document.getElementById("punch-modal-id").value;
  const employeeId = document.getElementById("punch-modal-employee").value;
  const type = document.getElementById("punch-modal-type").value;
  const timeVal = document.getElementById("punch-modal-time").value; // "HH:MM"
  if(!timeVal){ showToast("Choisissez une heure"); return; }

  const [h,m] = timeVal.split(":").map(Number);
  const newDate = new Date(controlDate);
  newDate.setHours(h, m, 0, 0);

  try{
    if(mode === "edit"){
      await db.collection("punches").doc(id).update({
        timestamp: firebase.firestore.Timestamp.fromDate(newDate)
      });
      showToast("Pointage modifié ✓");
    } else {
      const emp = state.employees.find(e=>e.id===employeeId);
      await db.collection("punches").add({
        employeeId: employeeId,
        employeeName: emp ? emp.name : "",
        type: type,
        timestamp: firebase.firestore.Timestamp.fromDate(newDate)
      });
      showToast("Pointage ajouté ✓");
    }
    document.getElementById("punch-modal").classList.remove("show");
    renderControlTable();
  }catch(e){
    console.error(e);
    showToast("Erreur lors de l'enregistrement");
  }
});

document.getElementById("punch-modal-delete-btn").addEventListener("click", async ()=>{
  const id = document.getElementById("punch-modal-id").value;
  if(!id) return;
  if(!confirm("Supprimer définitivement ce pointage ?")) return;
  try{
    await db.collection("punches").doc(id).delete();
    showToast("Pointage supprimé ✓");
    document.getElementById("punch-modal").classList.remove("show");
    renderControlTable();
  }catch(e){
    console.error(e);
    showToast("Erreur lors de la suppression");
  }
});

document.getElementById("control-export-btn").addEventListener("click", ()=>{
  if(controlCache.length === 0){ showToast("Aucune donnée à exporter"); return; }
  const dayLabel = todayKey(controlDate);
  let csv = "Équipier;Passage;Entrée;Pause;Reprise;Sortie;Total\n";
  controlCache.forEach(r=>{
    const total = r.totalMs>0 ? fmtDuration(r.totalMs).replace("h",",") : "";
    csv += `${r.name};${r.sessionLabel || "1"};${r.inTime};${r.pauseTime};${r.resumeTime};${r.outTime};${total}\n`;
  });
  const blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pointage_${dayLabel}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Export CSV téléchargé ✓");
});


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

  try{
    await db.collection("punches").add({
      employeeId: emp.id,
      employeeName: emp.name,
      type: type,
      timestamp: firebase.firestore.Timestamp.fromDate(now)
    });
  }catch(e){
    console.error("doPunch error", e);
    showToast("Erreur réseau, réessayez");
    showScreen("screen-home");
    return;
  }

  showConfirmScreen(emp, type, now);
}

function showConfirmScreen(emp, type, time){
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
  lateWrap.innerHTML = "";

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
  controlDate = new Date();
  renderControlTable();
  scanAndSyncAnomalies(7).then(renderAnomaliesTab); // synchro silencieuse des 7 derniers jours
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
    if(tab.dataset.tab === "control") renderControlTable();
    if(tab.dataset.tab === "anomalies") renderAnomaliesTab();
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

  let presentCount = 0;

  tbody.innerHTML = state.employees.map(emp=>{
    const punches = state.todayPunches.filter(p=>p.employeeId===emp.id);
    const get = (type)=> punches.find(p=>p.type===type);
    const inP = get("in"), pauseP = get("pause"), resumeP = get("resume"), outP = get("out");
    const {status} = lastStatusFor(emp.id);
    if(status !== "out" || inP) presentCount++;

    const statusPill = status==="in" ? `<span class="pill pill-in">En service</span>`
      : status==="pause" ? `<span class="pill pill-pause">En pause</span>`
      : inP ? `<span class="pill pill-out">Terminé</span>`
      : `<span class="pill pill-out">—</span>`;

    const total = punches.length>0 ? fmtDuration(totalWorkedMs(emp.id)) : "—";

    return `<tr>
      <td><b>${escapeHtml(emp.name)}</b></td>
      <td>${inP ? fmtTime(inP.timestamp.toDate()) : "—"}</td>
      <td>${pauseP ? fmtTime(pauseP.timestamp.toDate()) : "—"}</td>
      <td>${resumeP ? fmtTime(resumeP.timestamp.toDate()) : "—"}</td>
      <td>${outP ? fmtTime(outP.timestamp.toDate()) : "—"}</td>
      <td>${total}</td>
      <td>${statusPill}</td>
    </tr>`;
  }).join("");

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-num">${presentCount}</div><div class="stat-label">Présents aujourd'hui</div></div>
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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:rgba(30,38,36,0.4);padding:30px;">Aucun équipier. Cliquez sur "+ Ajouter".</td></tr>`;
    return;
  }
  const CONTRACT_LABELS = { temps_plein:"Temps plein", temps_partiel:"Temps partiel" };
  tbody.innerHTML = state.employees.map(emp=>{
    const {status} = lastStatusFor(emp.id);
    const statusPill = status==="in" ? `<span class="pill pill-in">En service</span>`
      : status==="pause" ? `<span class="pill pill-pause">En pause</span>`
      : `<span class="pill pill-out">Hors service</span>`;
    const contractLabel = emp.contractType ? `${CONTRACT_LABELS[emp.contractType]} · ${emp.contractHours}h` : "—";
    return `<tr>
      <td><b>${escapeHtml(emp.name)}</b></td>
      <td>${contractLabel}</td>
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
    document.getElementById("emp-contract-type-field").value = emp.contractType || "";
    document.getElementById("emp-contract-hours-field").value = emp.contractHours || "";
    document.getElementById("emp-time-field").value = emp.plannedTime || "";
  } else {
    title.textContent = "Ajouter un équipier";
    document.getElementById("emp-id-field").value = "";
    document.getElementById("emp-name-field").value = "";
    document.getElementById("emp-contract-type-field").value = "";
    document.getElementById("emp-contract-hours-field").value = "";
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
  const contractType = document.getElementById("emp-contract-type-field").value;
  const contractHoursRaw = document.getElementById("emp-contract-hours-field").value;
  const contractHours = contractHoursRaw ? parseFloat(contractHoursRaw) : null;
  const plannedTime = document.getElementById("emp-time-field").value;

  if(!name){ showToast("Le nom est obligatoire"); return; }
  if(!contractType){ showToast("Le type de contrat est obligatoire"); return; }
  if(!contractHours || contractHours <= 0){ showToast("Les heures contractuelles sont obligatoires"); return; }
  if(contractType === "temps_partiel" && contractHours >= 35){
    showToast("Un temps partiel doit être inférieur à 35h/semaine"); return;
  }
  if(contractType === "temps_plein" && contractHours > 48){
    showToast("Un temps plein ne peut pas dépasser 48h/semaine"); return;
  }

  try{
    if(id){
      await db.collection("employees").doc(id).update({ name, contractType, contractHours, plannedTime });
      showToast("Équipier modifié ✓");
    } else {
      await db.collection("employees").add({
        name, contractType, contractHours, plannedTime, active:true, pinHash:null,
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
  let totalHoursAll = 0;

  Object.entries(byEmployee).forEach(([empId, data])=>{
    let totalMs = 0, daysWorked = 0;
    Object.values(data.byDay).forEach(dayPunches=>{
      daysWorked++;
      dayPunches.sort((a,b)=>a.timestamp.toMillis()-b.timestamp.toMillis());
      let openStart = null;
      dayPunches.forEach(p=>{
        if(p.type==="in" || p.type==="resume"){
          openStart = p.timestamp.toMillis();
        } else if((p.type==="pause"||p.type==="out") && openStart!==null){
          totalMs += p.timestamp.toMillis() - openStart;
          openStart = null;
        }
      });
    });
    totalHoursAll += totalMs;
    rows.push({ name:data.name, daysWorked, totalMs });
  });

  rows.sort((a,b)=>a.name.localeCompare(b.name));
  reportCache = rows;

  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:rgba(30,38,36,0.4);">Aucun pointage ce mois-ci</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r=>`
      <tr>
        <td><b>${escapeHtml(r.name)}</b></td>
        <td>${r.daysWorked}</td>
        <td>${fmtDuration(r.totalMs)}</td>
      </tr>`).join("");
  }

  document.getElementById("report-stats").innerHTML = `
    <div class="stat-card"><div class="stat-num">${fmtDuration(totalHoursAll)}</div><div class="stat-label">Total heures équipe</div></div>
    <div class="stat-card"><div class="stat-num">${rows.length}</div><div class="stat-label">Équipiers actifs ce mois</div></div>
  `;
}

document.getElementById("export-csv-btn").addEventListener("click", ()=>{
  if(reportCache.length === 0){ showToast("Aucune donnée à exporter"); return; }
  const monthLabel = document.getElementById("report-month").selectedOptions[0]?.textContent || "rapport";
  let csv = "Équipier;Jours travaillés;Heures totales\n";
  reportCache.forEach(r=>{
    csv += `${r.name};${r.daysWorked};${fmtDuration(r.totalMs).replace("h",",")}\n`;
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
  const newAdminPin = document.getElementById("setting-admin-pin").value.trim();
  if(!newAdminPin){ showToast("Entrez un nouveau code admin pour le modifier"); return; }
  if(newAdminPin.length < 4){ showToast("Le code admin doit faire au moins 4 chiffres"); return; }

  const update = { adminPinHash: await sha256("ADMIN:" + newAdminPin) };

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
