{
'use strict';
const H = window.HQA, ENG = window.HarnessEngine;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();
const fmtDate = s => { try { return new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return s || ''; } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

// ---------------- state ----------------
const S = { db: null, user: null, me: null, canWrite: true, sample: null, downloads: null, ready: false,
  netlists: [], runs: [], cases: [], programs: [], names: {}, local: false, draft: {}, newRun: null };
const VERDICT = {
  INCOMPLETE: ['הבדיקה לא בוצעה במלואה', 'bad'], BLOCKED: ['כיסוי שלם — קיימים חסמים', 'warn'],
  COMPLETE_PENDING_ENGINEERING_REVIEW: ['כיסוי שלם — ממתין לסקירה הנדסית', 'ok']
};
const CMP = { MATCH: ['תואם', 'ok'], PARTIAL: ['נבדק חלקית', 'bad'], SPLIT: ['מפוצל בבודק', 'bad'], EXTRA: ['נקודות עודפות בבודק', 'warn'], NOT_TESTED: ['לא נבדק', 'bad'], NOT_IN_DRAWING: ['לא קיים בשרטוט', 'bad'] };
const SEV = { blocker: 'חסמים ואי־התאמות', gap: 'פערי כיסוי — לא נבדק', review: 'לסקירה הנדסית', info: 'מידע' };
const CODE_HE = { ISOLATION_GAP: 'בידוד לא נבדק', COVERAGE_GAP: 'מקטע לא נבדק', ORPHAN_ATP: 'נקודת בדיקה שאינה בשרטוט', REVISION_MISMATCH: 'אי־התאמת מהדורות',
  UNTESTED_POINT: 'נקודה לא נבדקה', OUT_OF_LIMIT: 'חריגה מגבולות', RECORDED_FAIL: 'כשל שנרשם בבודק', SPARE_PIN_UNTESTED: 'פין פנוי ללא בידוד', MISSING_EVIDENCE: 'חסרה ראיה מספרית',
  PARALLEL_PATH: 'ענף מקביל לא הוכח', ENGINEERING_REVIEW: 'לסקירה הנדסית', END_TO_END_REVIEW: 'מדידה קצה־לקצה לסקירה', UNAPPROVED_SOURCES: 'נטליסט לא מאומת', LIMITS_UNDEFINED: 'אין גבולות קבלה',
  PATH_TEST_TYPE_RISK: 'סוג בדיקה לא מתאים לרכיב', DUPLICATE_RESULT: 'תוצאה כפולה', RESULT_WITHOUT_TEST: 'תוצאה ללא בדיקה', NO_DRAWING_PATH: 'אין מסלול בשרטוט', PIN_NOT_IN_MECHANICAL: 'פין שאינו במחבר',
  CONNECTOR_NOT_IN_MECHANICAL: 'מחבר לא מוגדר', UNJUSTIFIED_DUPLICATE: 'בדיקה כפולה', NODE_IN_MULTIPLE_NETS: 'נקודה בשתי רשתות' };
const codeHe = c => CODE_HE[c] || (c.startsWith('COMPONENT_') ? 'בדיקת רכיב: ' + c.slice(10) : c);
const CASE_ST = { OPEN: 'פתוח', IN_PROGRESS: 'בטיפול', PENDING_VERIFICATION: 'ממתין לאימות', CLOSED: 'סגור', WAIVED: 'חריגה מאושרת' };

function toast(msg, ms) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), ms || 3500); }
function dialog(title, bodyHtml, okText) {
  return new Promise(res => {
    const d = $('#dlg'); $('#dlgTitle').textContent = title; $('#dlgBody').innerHTML = bodyHtml; $('#dlgOk').textContent = okText || 'אישור';
    d.onclose = () => res(d.returnValue === 'ok' ? d : null);
    try { d.showModal(); } catch (e) { res(null); }
  });
}
async function names(ids) {
  ids = [...new Set(ids.filter(Boolean))].filter(i => !(i in S.names));
  if (ids.length && S.user && S.user.profiles) { try { const ps = await S.user.profiles(ids); for (const i of ids) S.names[i] = (ps[i] && ps[i].name) || 'משתמש'; } catch (e) { } }
}
const nameOf = id => id ? (S.names[id] || 'משתמש') : '—';

// ---------------- data layer (shared db, or in-memory fallback) ----------------
const mem = { netlists: new Map(), runs: new Map(), runData: new Map(), cases: new Map(), programs: new Map(), requirements: new Map() };
async function put(col, id, data) {
  if (S.fs) { await S.fs.put(col, id, data); return; }
  if (S.db) { await S.db.doc(col + '/' + id).set(data); }
  else { mem[col].set(id, data); refreshLocal(); }
}
async function patch(col, id, data) {
  if (S.fs) { await S.fs.patch(col, id, data); return; }
  if (S.db) await S.db.doc(col + '/' + id).update(data);
  else { mem[col].set(id, deepMerge(mem[col].get(id) || {}, data)); refreshLocal(); }
}
function deepMerge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v; return o; }
async function getDoc(col, id) {
  if (S.fs) return S.fs.get(col, id);
  if (S.db) { const s = await S.db.doc(col + '/' + id).get(); return s.exists ? s.data() : null; }
  return mem[col].get(id) || null;
}
function refreshLocal() {
  S.netlists = [...mem.netlists].map(([id, d]) => ({ id, ...d }));
  S.runs = [...mem.runs].map(([id, d]) => ({ id, ...d })).sort((a, b) => b.createdAt < a.createdAt ? -1 : 1);
  S.cases = [...mem.cases].map(([id, d]) => ({ id, ...d }));
  S.programs = [...mem.programs].map(([id, d]) => ({ id, ...d }));
  liveRender();
}
const SORTS = { netlists: (a, b) => (a.pn + a.rev).localeCompare(b.pn + b.rev), runs: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
  programs: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''), cases: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') };
function subscribeFolder() {
  for (const col of ['netlists', 'runs', 'programs', 'cases']) S.fs.watch(col, (rows, err) => {
    if (err) { toast('לא ניתן לקרוא מהתיקייה המשותפת: ' + (err.message || err.name)); return; }
    S[col] = rows.sort(SORTS[col]); liveRender();
  });
}
function subscribe() {
  const watch = (q, key, sort) => {
    let timer = setTimeout(() => toast('המאגר המשותף לא מגיב עדיין — ייתכן שהנתונים אינם עדכניים'), 10000);
    q.onSnapshot(snap => {
      if (!snap.metadata.fromCache) clearTimeout(timer);
      S[key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (sort) S[key].sort(sort);
      liveRender();
    }, e => { clearTimeout(timer); toast('שגיאת מאגר: ' + e.code); });
  };
  watch(S.db.collection('netlists'), 'netlists', (a, b) => (a.pn + a.rev).localeCompare(b.pn + b.rev));
  watch(S.db.collection('runs').orderBy('createdAt', 'desc').limit(500), 'runs');
  watch(S.db.collection('programs'), 'programs', (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  watch(S.db.collection('cases'), 'cases', (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---------------- routing ----------------
const liveViews = new Set(['home', 'netlists', 'findings', 'history', 'programs']);
S.mode = null;
function route() {
  if (S.mode === 'folder' && !S.me) return;
  const h = (location.hash || '#home').slice(1);
  const [v, ...rest] = h.split('-'); const arg = rest.join('-');
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.getAttribute('href') === '#' + v || (v === 'program' && a.getAttribute('href') === '#programs') || (v === 'netlist' && a.getAttribute('href') === '#netlists'));
  S.view = v; S.arg = arg;
  ({ home: vHome, run: arg ? vRunResult : vRunNew, netlists: vNetlists, netlist: vNetlistEdit, findings: vFindings, history: vHistory, programs: vPrograms, program: arg === 'new' ? vProgramNew : vProgram, team: vTeam }[v] || vHome)(arg);
  window.scrollTo(0, 0);
}
function liveRender() {
  if (!(liveViews.has(S.view) || (S.view === 'run' && (S.arg || !(S.newRun && S.newRun.run))) || (S.view === 'program' && S.arg && S.arg !== 'new'))) return;
  const a = document.activeElement;
  if (a && a !== document.body && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { S.pendingRender = true; return; } // don't wipe what someone is typing
  route();
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) { S.pendingRender = false; liveRender(); } }, 50));
window.addEventListener('hashchange', route);
const view = html => { $('#view').innerHTML = html; };

// ---------------- views ----------------
function vHome() {
  const open = S.cases.filter(c => !['CLOSED', 'WAIVED'].includes(c.status)).length;
  const ver = S.netlists.filter(n => n.status === 'verified').length;
  const last30 = S.runs.filter(r => Date.now() - new Date(r.createdAt) < 30 * 864e5).length;
  names(S.runs.slice(0, 12).map(r => r.createdBy)).then(() => S.view === 'home' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  view(`
  ${S.local ? '<div class="note err">מצב ניסיון — אין חיבור למאגר משותף, והנתונים יימחקו כשסוגרים את הדף.</div>' : ''}${S.mode === 'folder' ? `<p class="small muted">תיקייה משותפת: <b>${esc(S.fs.name)}</b> · מתעדכן כל כמה שניות</p>` : ''}
  <h1>בדיקת שלמות כיסוי לרתמות</h1>
  <div class="panel"><div class="row" style="justify-content:space-between">
    <p style="margin:0;max-width:62ch">משווים דוח של מכשיר הבדיקה מול נטליסט מאומת של השרטוט, ומקבלים מה נבדק, מה לא נבדק כלל, ואילו רשתות אינן תואמות.</p>
    <a class="btn" href="#run" style="text-decoration:none;background:var(--acc);color:#fff">בדיקה חדשה</a></div>
    <div class="kpis">
      <div class="kpi"><strong>${last30}</strong>בדיקות ב־30 יום</div>
      <div class="kpi"><strong class="${open ? 't-bad' : 't-ok'}">${open}</strong>ממצאים פתוחים</div>
      <div class="kpi"><strong>${ver}/${S.netlists.length}</strong>נטליסטים מאומתים</div>
      <div class="kpi"><strong>${S.programs.filter(isApproved).length}/${S.programs.length}</strong>תוכניות מאושרות</div>
      <div class="kpi"><strong class="${S.programs.filter(p => p.status === 'submitted').length ? 't-warn' : ''}">${S.programs.filter(p => p.status === 'submitted').length}</strong>ממתינות לאישור</div>
    </div></div>
  <div class="panel"><h2>בדיקות אחרונות</h2>${runsTable(S.runs.slice(0, 12))}</div>`);
}
function runsTable(runs) {
  if (!runs.length) return '<div class="empty">אין עדיין בדיקות. התחילו בהוספת נטליסט ואז "בדיקה חדשה".</div>';
  return `<div class="scroll"><table class="stack"><thead><tr><th>מק"ט</th><th>מהדורה</th><th>מספר סידורי</th><th>הכרעה</th><th>רשתות</th><th>מתי</th><th>מי</th></tr></thead><tbody>${runs.map(r => {
    const v = VERDICT[r.verdict?.status] || ['—', ''];
    return `<tr class="click" onclick="location.hash='run-${esc(r.id)}'"><td class="mono">${esc(r.pn)}</td><td>${esc(r.rev)}</td><td class="mono">${esc(r.serial)}</td><td><span class="tag t-${v[1]}">${esc(v[0])}</span></td><td>${r.compareCount ? `${r.compareCount.MATCH || 0}/${Object.values(r.compareCount).reduce((a, b) => a + b, 0)}` : ''}</td><td>${esc(fmtDate(r.createdAt))}</td><td data-uid="${esc(r.createdBy || '')}">${esc(nameOf(r.createdBy))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// ----- netlists library -----
function vNetlists() {
  const by = {};
  for (const n of S.netlists) (by[n.pn] = by[n.pn] || []).push(n);
  view(`<h1>ספריית נטליסטים</h1>
  <div class="panel"><div class="row" style="justify-content:space-between"><p class="muted" style="margin:0">נטליסט לכל מק"ט ומהדורת שרטוט. רק נטליסט מאומת נחשב מקור אמת לבדיקה.</p>
  <button class="acc" onclick="location.hash='netlist-new'">נטליסט חדש</button></div></div>
  ${Object.keys(by).length ? Object.entries(by).map(([pn, list]) => `<div class="panel"><h2 class="mono">${esc(pn)}</h2><table class="stack"><thead><tr><th>מהדורה</th><th>כותרת</th><th>רשתות</th><th>מצב</th><th>עודכן</th></tr></thead><tbody>${list.map(n =>
    `<tr class="click" onclick="location.hash='netlist-${esc(n.id)}'"><td>${esc(n.rev)}</td><td>${esc(n.title)}</td><td>${esc(n.netCount)}</td><td>${n.status === 'verified' ? '<span class="tag t-ok">מאומת</span>' : '<span class="tag t-warn">טיוטה</span>'}</td><td>${esc(fmtDate(n.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`).join('') : '<div class="panel empty">אין נטליסטים עדיין.</div>'}`);
}

const NLF_HELP = `פורמט: שורה לכל רשת — שם: נקודות מופרדות בפסיק.
PN: HX-1000
REV: C
CONN J3: 1-78, BK        # רשימת פינים במחבר (רשות — מאפשר בדיקת פינים פנויים)
S1: J1-1, J1-2, J2-1   # רשת דרך פיצול
W1: J3-5, J3-6             # חוט בין שתי נקודות
R R1 3.48: J1-9, J1-10     # נגד
D D1: X1-1, X2-3              # דיודה (אנודה ראשונה)
SH DATA_SHIELD: J3-12        # שילוד בקצה אחד`;

function vNetlistEdit(id) {
  const isNew = id === 'new';
  const n = isNew ? (S.draft.netlist || { pn: '', rev: '', title: '', text: '', status: 'draft' }) : S.netlists.find(x => x.id === id);
  if (!n) { view('<div class="panel empty">הנטליסט לא נמצא (ייתכן שעדיין נטען).</div>'); return; }
  const ed = { ...n, checks: new Set() };
  S.edit = ed;
  view(`<h1>${isNew ? 'נטליסט חדש' : 'נטליסט <span class="mono">' + esc(n.pn) + '</span> מהדורה ' + esc(n.rev)}</h1>
  ${n.status === 'verified' ? `<div class="note">מאומת ע"י <span data-uid="${esc(n.verifiedBy)}">${esc(nameOf(n.verifiedBy))}</span> ב־${esc(fmtDate(n.verifiedAt))}. כל שינוי יחזיר אותו לטיוטה.</div>` : ''}
  <div class="panel"><div class="grid">
    <div><label for="pn">מק"ט</label><input id="pn" class="mono" value="${esc(n.pn)}"></div>
    <div><label for="rev">מהדורת שרטוט</label><input id="rev" value="${esc(n.rev)}"></div>
    <div><label for="title">כותרת / מספר שרטוט</label><input id="title" value="${esc(n.title)}"></div>
  </div></div>
  <div class="split">
  <div class="panel" id="drawPanel"><h2>שרטוט</h2>
    <div class="row">
      <input type="file" id="drawFile" accept=".pdf,image/png,image/jpeg" aria-label="קובץ שרטוט" style="max-width:260px">
      <select id="rot" aria-label="סיבוב" style="max-width:170px"><option value="0">ללא סיבוב</option><option value="90">90° עם השעון</option><option value="270">90° נגד השעון</option><option value="180">180°</option></select>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin:0">זום<input type="range" id="zoom" min="40" max="400" value="180" style="min-height:0;width:140px"></label>
    </div>
    <div id="drawMsg" class="small muted"></div>
    <div id="sheetBox" class="sheetbox"><div class="empty">טענו את השרטוט כדי לעבוד מולו.</div></div>
    <div id="aiPanel"></div>
  </div>
  <div class="panel"><h2>נטליסט</h2>
    <div class="addnet"><div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)">
      <div><label for="anName">שם רשת / פיצול</label><input id="anName" class="mono" placeholder="E28"></div>
      <div><label for="anPin">נקודה (Enter להוספה)</label><input id="anPin" class="mono" list="pinList" placeholder="JU1-27" autocomplete="off"><datalist id="pinList"></datalist></div></div>
      <div id="anChips" class="chips"></div>
      <div class="row"><button class="ghost" id="anAdd" disabled>הוסף רשת לנטליסט</button><span id="anMsg" class="small muted"></span></div></div>
    <details><summary>פורמט</summary><pre class="mono small" style="white-space:pre-wrap">${esc(NLF_HELP)}</pre></details>
    <textarea id="nlf" class="code" spellcheck="false">${esc(n.text)}</textarea>
    <div id="parseInfo" class="small"></div>
    <div id="unassigned"></div></div>
  </div>
  <div class="panel"><h2>אימות מול השרטוט</h2>
    <p class="small muted">סמנו כל רשת אחרי שבדקתם אותה בשרטוט. סימון "מאומת" אפשרי רק כשכל הרשתות סומנו, ונרשם על שמכם.</p>
    <div class="row"><button class="ghost" id="checkAll">סמן הכל</button><span id="checkCount" class="small"></span></div>
    <div id="checklist" class="netlist-check"></div></div>
  <div class="panel row"><button id="saveDraft">שמור טיוטה</button><button id="saveVerified" class="acc" disabled>שמור כמאומת</button>${isNew ? '' : '<button class="ghost" id="dup">שכפל למהדורה חדשה</button>'}<span id="saveMsg" class="small muted"></span></div>`);
  names([n.verifiedBy]).then(() => document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  const reparse = () => {
    const nl = H.parseNLF($('#nlf').value);
    ed.parsed = nl;
    const pins = nl.nets.reduce((s, x) => s + x.pins.length, 0);
    $('#parseInfo').innerHTML = `<p>${nl.nets.length} רשתות · ${pins} נקודות · ${nl.resistors.length} נגדים · ${nl.diodes.length} דיודות · ${Object.keys(nl.connectors).length} מחברים מוגדרים</p>${nl.errors.length ? `<div class="note err">${nl.errors.map(esc).join('<br>')}</div>` : ''}${/# לא ודאי/.test($('#nlf').value) ? '<div class="note">Claude סימן קטעים לא ודאיים (שורות # לא ודאי) — יש לבדוק אותם בשרטוט.</div>' : ''}`;
    const items = [...nl.nets.map(x => ({ k: 'N:' + x.name + ':' + x.pins.join(','), t: `${x.name}: ${x.pins.slice().sort(H.pinCmp).join(', ')}` })),
      ...nl.resistors.map(r => ({ k: 'R:' + r.name + r.a + r.b + r.ohms, t: `נגד ${r.name} ${r.ohms}Ω: ${r.a} ↔ ${r.b}` })),
      ...nl.diodes.map(d => ({ k: 'D:' + d.name + d.a + d.k, t: `דיודה ${d.name}: ${d.a} → ${d.k}` })),
      ...nl.shields.map(s => ({ k: 'S:' + s.name + s.pin, t: `שילוד חד־צדדי ${s.name}: ${s.pin}` }))];
    ed.items = items;
    const used = new Set([...nl.nets.flatMap(x => x.pins), ...nl.resistors.flatMap(r => [r.a, r.b]), ...nl.diodes.flatMap(d => [d.a, d.k]), ...nl.shields.map(x => x.pin)]);
    const all = [...new Set([...Object.entries(nl.connectors).flatMap(([c, ps]) => ps.map(p => c + '-' + p)), ...used])].sort(H.pinCmp);
    ed.used = used; $('#pinList').innerHTML = all.map(p => `<option value="${esc(p)}">`).join('');
    const free = all.filter(p => !used.has(p)), byC = {};
    for (const p of free) (byC[p.replace(/-[^-]*$/, '')] = byC[p.replace(/-[^-]*$/, '')] || []).push(p);
    $('#unassigned').innerHTML = Object.keys(nl.connectors).length ? `<details ${free.length && free.length < 60 ? 'open' : ''}><summary>פינים שלא שויכו לאף רשת (${free.length})</summary><p class="small muted">ודאו בשרטוט שהם באמת פנויים. לחיצה מוסיפה לרשת שבעריכה.</p>${Object.entries(byC).map(([c, ps]) => `<div class="chips"><b class="small">${esc(c)}</b>${ps.map(p => `<button class="chip" data-pin="${esc(p)}">${esc(p.replace(/^.*-/, ''))}</button>`).join('')}</div>`).join('')}</details>`
      : '<p class="small muted">הוסיפו שורות CONN (רשימת פינים לכל מחבר) כדי לקבל השלמה אוטומטית ורשימת פינים שלא שויכו.</p>';
    for (const k of [...ed.checks]) if (!items.some(i => i.k === k)) ed.checks.delete(k);
    $('#checklist').innerHTML = items.map((i, n) => `<label><input type="checkbox" data-k="${esc(i.k)}" ${ed.checks.has(i.k) ? 'checked' : ''}><span class="mono small">${esc(i.t)}</span></label>`).join('') || '<div class="muted">אין רשתות עדיין.</div>';
    updChecks();
  };
  const updChecks = () => {
    const total = ed.items.length, done = ed.items.filter(i => ed.checks.has(i.k)).length;
    $('#checkCount').textContent = `${done}/${total} אומתו`;
    $('#saveVerified').disabled = !total || done < total || ed.parsed.errors.length > 0 || !$('#pn').value.trim() || !$('#rev').value.trim();
  };
  let tmr; $('#nlf').addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(reparse, 300); });
  // quick add-net
  const chips = [];
  const drawChips = () => {
    $('#anChips').innerHTML = chips.map((p, i) => `<button class="chip on" data-rm="${i}" title="הסר">${esc(p)} ✕</button>`).join('');
    $('#anAdd').disabled = !(chips.length >= 1 && $('#anName').value.trim());
  };
  const addPin = raw => {
    const p = H.normPin(raw); if (!p) { $('#anMsg').textContent = 'נקודה לא תקינה: ' + raw; return; }
    if (chips.includes(p)) return;
    $('#anMsg').textContent = ed.used && ed.used.has(p) ? `${p} כבר משויך לרשת אחרת` : '';
    chips.push(p); drawChips();
  };
  $('#anPin').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = $('#anPin').value.trim(); if (v) { v.split(/[,\s]+/).filter(Boolean).forEach(addPin); $('#anPin').value = ''; } } });
  $('#anPin').addEventListener('change', () => { const v = $('#anPin').value.trim(); if (v && ed.used && /-/.test(v) && $('#pinList').querySelector(`option[value="${CSS.escape(v)}"]`)) { addPin(v); $('#anPin').value = ''; } });
  $('#anName').addEventListener('input', drawChips);
  $('#anChips').addEventListener('click', e => { const i = e.target.dataset.rm; if (i != null) { chips.splice(+i, 1); drawChips(); } });
  $('#unassigned').addEventListener('click', e => { const p = e.target.dataset.pin; if (p) addPin(p); });
  $('#anAdd').onclick = () => {
    const name = $('#anName').value.trim().replace(/[:#,]/g, '_');
    const ta = $('#nlf'); ta.value = ta.value.replace(/\s*$/, '\n') + `${name}: ${chips.join(', ')}\n`;
    chips.length = 0; $('#anName').value = ''; drawChips(); reparse(); $('#anName').focus();
    $('#anMsg').textContent = 'נוספה שורה ' + name;
  };
  setupDrawing(ed, n);
  for (const f of ['pn', 'rev']) $('#' + f).addEventListener('input', updChecks);
  $('#checklist').addEventListener('change', e => { const k = e.target.dataset.k; if (!k) return; e.target.checked ? ed.checks.add(k) : ed.checks.delete(k); updChecks(); });
  $('#checkAll').onclick = async () => {
    if (!(await dialog('לסמן את כל הרשתות?', '<p>סמנו הכל רק אם בדקתם בפועל כל רשת מול השרטוט.</p>', 'כן, בדקתי'))) return;
    ed.items.forEach(i => ed.checks.add(i.k)); reparse();
  };
  const save = async verified => {
    const pn = $('#pn').value.trim(), rev = $('#rev').value.trim();
    if (!pn || !rev) { toast('יש למלא מק"ט ומהדורה'); return; }
    const text = $('#nlf').value, nl = H.parseNLF(text);
    const docId = isNew ? (pn + '__' + rev).replace(/[^\w\-.~:@+]/g, '_') + '__' + uid().slice(-4) : id;
    const changed = !isNew && text !== n.text;
    const data = { pn, rev, title: $('#title').value.trim(), text, netCount: nl.nets.length, updatedAt: now(), updatedBy: S.me,
      createdAt: n.createdAt || now(), createdBy: n.createdBy || S.me, source: n.source || 'manual',
      status: verified ? 'verified' : (changed ? 'draft' : (n.status || 'draft')),
      verifiedBy: verified ? S.me : (changed ? null : (n.verifiedBy || null)), verifiedAt: verified ? now() : (changed ? null : (n.verifiedAt || null)) };
    if (S.fs && ed.drawFile) { try { data.drawingFile = await S.fs.saveDrawing(docId, ed.drawFile); data.drawingName = ed.drawFile.name; } catch (e) { toast('השרטוט לא נשמר בתיקייה: ' + e.message); } }
    else if (n.drawingFile) { data.drawingFile = n.drawingFile; data.drawingName = n.drawingName; }
    try { await put('netlists', docId, data); $('#saveMsg').textContent = 'נשמר ' + fmtDate(now()); S.draft.netlist = null; if (isNew) location.hash = 'netlist-' + docId; }
    catch (e) { toast(e.code === 'quota_exceeded' ? 'המאגר מלא — יש למחוק נתונים ישנים' : 'השמירה נכשלה: ' + (e.code || e.message)); }
  };
  $('#saveDraft').onclick = () => save(false);
  $('#saveVerified').onclick = async () => { if (await dialog('לשמור כמאומת?', `<p>אתם מאשרים שכל ${ed.items.length} הרשתות נבדקו מול השרטוט. האישור יירשם על שמכם.</p>`, 'שמור כמאומת')) save(true); };
  if ($('#dup')) $('#dup').onclick = () => { S.draft.netlist = { pn: n.pn, rev: '', title: n.title, text: n.text.replace(/^REV:.*$/m, 'REV: '), status: 'draft' }; location.hash = 'netlist-new'; };
  reparse();
}

// ----- drawing viewer (+ optional Claude extraction) -----
async function renderSheets(f, rot) {
  const sheets = [];
  if (/pdf$/i.test(f.name) || f.type === 'application/pdf') {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const v0 = page.getViewport({ scale: 1, rotation: (page.rotate + rot) % 360 });
      const scale = Math.min(4, 3300 / Math.max(v0.width, v0.height));
      const vp = page.getViewport({ scale, rotation: (page.rotate + rot) % 360 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      sheets.push(c);
    }
  } else {
    const img = await createImageBitmap(f);
    const c = document.createElement('canvas'); const sw = rot % 180 ? img.height : img.width, sh = rot % 180 ? img.width : img.height;
    c.width = sw; c.height = sh; const ctx = c.getContext('2d'); ctx.translate(sw / 2, sh / 2); ctx.rotate(rot * Math.PI / 180); ctx.drawImage(img, -img.width / 2, -img.height / 2);
    sheets.push(c);
  }
  return sheets;
}
function setupDrawing(ed, n) {
  const box = $('#sheetBox');
  const show = async () => {
    const f = ed.drawFile; if (!f) return;
    $('#drawMsg').textContent = 'טוען שרטוט…';
    try {
      ed.sheets = await renderSheets(f, +$('#rot').value);
      box.innerHTML = ''; ed.sheets.forEach(c => box.append(c));
      box.style.setProperty('--z', $('#zoom').value);
      $('#drawMsg').textContent = `${f.name} · ${ed.sheets.length} גיליונות. גררו לגלילה, זום מהמחוון.`;
      if (S.sample) setupAI(ed);
    } catch (e) { $('#drawMsg').textContent = 'לא ניתן להציג: ' + (e.message || e); }
  };
  $('#drawFile').onchange = () => { ed.drawFile = $('#drawFile').files[0] || null; show(); };
  $('#rot').onchange = show;
  $('#zoom').oninput = () => box.style.setProperty('--z', $('#zoom').value);
  // drag to pan
  let drag = null;
  box.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, l: box.scrollLeft, t: box.scrollTop }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', e => { if (drag) { box.scrollLeft = drag.l - (e.clientX - drag.x); box.scrollTop = drag.t - (e.clientY - drag.y); } });
  box.addEventListener('pointerup', () => drag = null);
  if (S.fs && n.drawingFile) S.fs.readDrawing(n.drawingFile).then(f => { if (f) { ed.drawFile = new File([f], n.drawingName || n.drawingFile, { type: f.type }); show(); } });
}
async function setupAI(ed) {
  const box = $('#aiPanel');
  let lim = null; try { lim = await S.sample.limits(); } catch (e) { }
  if (!lim || !lim.images) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3>חילוץ בעזרת Claude</h3><p class="small muted">כל גיליון נחתך לאריחים ו־Claude מתמלל את החיבורים. התוצאה טיוטה — חובה לאשר כל רשת.</p>
    <label for="hint">הערה ל־Claude (רשות)</label><input id="hint" placeholder="למשל: E = פיצול, BK = גוף המחבר">
    <div class="row" style="margin-top:8px"><button id="aiGo" class="acc">חלץ נטליסט</button><button id="aiStop" class="ghost" hidden>עצור</button><span id="aiStatus" class="small muted"></span></div>`;
  let ctl = null;
  $('#aiStop').onclick = () => ctl && ctl.abort();
  $('#aiGo').onclick = async () => {
    const sheets = ed.sheets || []; if (!sheets.length) return;
    if ($('#nlf').value.trim() && !(await dialog('להחליף את הנטליסט הקיים?', '<p>הטקסט הנוכחי יוחלף בתוצאת החילוץ.</p>', 'החלף'))) return;
    $('#aiGo').disabled = true; $('#aiStop').hidden = false; const results = [];
    try {
      for (let i = 0; i < sheets.length; i++) {
        const tiles = await tile(sheets[i], Math.min(lim.images.maxCount || 6, 12));
        $('#aiStatus').textContent = `גיליון ${i + 1}/${sheets.length}: Claude קורא ${tiles.length} אריחים… (עשוי לקחת דקה-שתיים)`;
        ctl = new AbortController();
        results.push(await S.sample.json(H.aiNetlistPrompt(i + 1, tiles.length, $('#hint').value.trim()), { images: tiles, modelTier: 'complex', signal: ctl.signal }));
      }
      const out = H.aiNetlistToNLF(results, { pn: $('#pn').value.trim(), rev: $('#rev').value.trim(), title: $('#title').value.trim() });
      $('#nlf').value = out.text;
      if (!$('#pn').value && /PN: (.+)/.test(out.text)) $('#pn').value = out.text.match(/PN: (.+)/)[1].trim();
      if (!$('#rev').value && /REV: (.+)/.test(out.text)) $('#rev').value = out.text.match(/REV: (.+)/)[1].trim();
      $('#nlf').dispatchEvent(new Event('input'));
      $('#aiStatus').textContent = `החילוץ הסתיים. ${out.notes.length ? out.notes.length + ' קטעים לא ודאיים סומנו. ' : ''}עברו על כל רשת מול השרטוט לפני אימות.`;
    } catch (e) {
      $('#aiStatus').textContent = e.code === 'cancelled' ? 'נעצר.' : e.code === 'not_granted' ? 'לא ניתן אישור להשתמש ב־Claude.' : e.code === 'rate_limited' ? 'הגעתם למגבלת שימוש — נסו שוב מאוחר יותר.' : e.code === 'invalid_json' ? 'התשובה לא התקבלה בפורמט תקין — נסו שוב.' : 'החילוץ נכשל: ' + (e.code || e.message);
    } finally { $('#aiGo').disabled = false; $('#aiStop').hidden = true; }
  };
}
async function tile(canvas, maxCount) {
  const W = canvas.width, H0 = canvas.height;
  let cols = Math.ceil(W / 1100), rows = Math.ceil(H0 / 1100);
  while (cols * rows > maxCount) { if (cols >= rows) cols--; else rows--; }
  cols = Math.max(1, cols); rows = Math.max(1, rows);
  const ov = 0.08, tw = Math.ceil(W / cols * (1 + ov)), th = Math.ceil(H0 / rows * (1 + ov));
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = Math.max(0, Math.min(W - tw, Math.round(c * W / cols - tw * ov / 2))), y = Math.max(0, Math.min(H0 - th, Math.round(r * H0 / rows - th * ov / 2)));
    const t = document.createElement('canvas'); t.width = Math.min(tw, W); t.height = Math.min(th, H0);
    t.getContext('2d').drawImage(canvas, x, y, t.width, t.height, 0, 0, t.width, t.height);
    out.push(await new Promise(res => t.toBlob(res, 'image/png')));
  }
  return out;
}

// ----- new run -----
function vRunNew() {
  const nr = S.newRun || (S.newRun = { netlistId: '', serial: '', note: '', run: null, fileName: '' });
  const opts = S.netlists.map(n => `<option value="${esc(n.id)}" ${n.id === nr.netlistId ? 'selected' : ''}>${esc(n.pn)} · מהדורה ${esc(n.rev)}${n.status === 'verified' ? '' : ' (טיוטה)'}</option>`).join('');
  view(`<h1>בדיקה חדשה</h1>
  ${S.netlists.length ? '' : '<div class="note">אין עדיין נטליסטים. <a href="#netlist-new">הוסיפו נטליסט</a> לפני הבדיקה.</div>'}
  <div class="panel"><h2>1. רתמה</h2><div class="grid">
    <div><label for="nlSel">מק"ט ומהדורת שרטוט</label><select id="nlSel"><option value="">בחרו…</option>${opts}</select></div>
    <div><label for="serial">מספר סידורי</label><input id="serial" class="mono" value="${esc(nr.serial)}"></div>
    <div><label for="note">הערה (רשות)</label><input id="note" value="${esc(nr.note)}"></div></div>
    <div id="nlWarn"></div></div>
  <div class="panel"><h2>2. דוח מכשיר הבדיקה</h2>
    <label for="repFile">קובץ דוח (PDF / TXT / CSV)</label><input type="file" id="repFile" accept=".pdf,.txt,.csv,.log,text/plain">
    <p class="small muted">פורמטים נתמכים: ${H.testers.map(t => esc(t.name)).join(' · ')}. פורמט אחר — אפשר להמיר בעזרת Claude.</p>
    <div id="repInfo"></div></div>
  <div class="panel row"><button id="go" class="acc" disabled>הרץ בדיקה</button><span id="goMsg" class="small muted"></span></div>`);
  const upd = () => {
    nr.netlistId = $('#nlSel').value; nr.serial = $('#serial').value.trim(); nr.note = $('#note').value;
    const n = S.netlists.find(x => x.id === nr.netlistId);
    $('#nlWarn').innerHTML = n && n.status !== 'verified' ? '<div class="note">הנטליסט הזה עדיין טיוטה — תוצאות הבדיקה יסומנו כלא מבוססות על מקור מאומת.</div>' : '';
    $('#go').disabled = !(n && nr.serial && nr.run);
    $('#goMsg').textContent = !n ? 'בחרו נטליסט' : !nr.serial ? 'הזינו מספר סידורי' : !nr.run ? 'טענו דוח' : '';
  };
  for (const id of ['nlSel', 'serial', 'note']) $('#' + id).addEventListener('input', upd);
  const showRun = () => {
    const r = nr.run; if (!r) { $('#repInfo').innerHTML = ''; return; }
    const cont = r.groups.reduce((s, g) => s + g.cont.length, 0);
    $('#repInfo').innerHTML = `<div class="kpis"><div class="kpi"><strong>${r.groups.length}</strong>קבוצות</div><div class="kpi"><strong>${r.groups.filter(g => g.pins.length > 1).length}</strong>רשתות מחוברות</div><div class="kpi"><strong>${cont}</strong>מדידות רציפות</div><div class="kpi"><strong>${r.fourWire.length}</strong>מדידות 4 חוטים</div></div>
      <p class="small">${esc(nr.fileName)} · ${esc(H.testers.find(t => t.id === r.format)?.name || r.format)}${r.meta.program ? ' · תוכנית ' + esc(r.meta.program) : ''}${r.meta.schemaRev ? ' · מהדורת שרטוט בתוכנית: <b>' + esc(r.meta.schemaRev) + '</b>' : ''}${r.meta.runDate ? ' · ' + esc(r.meta.runDate) : ''}${r.overall ? ' · ' + esc(r.overall) : ''}${r.aiConverted ? ' · <span class="t-warn">הומר ע"י Claude — לבדוק</span>' : ''}</p>
      ${r.warnings.length ? `<div class="note">${r.warnings.map(esc).join('<br>')}</div>` : ''}`;
  };
  $('#repFile').onchange = async () => {
    const f = $('#repFile').files[0]; if (!f) return;
    nr.run = null; nr.fileName = f.name; $('#repInfo').innerHTML = '<p class="muted">קורא…</p>'; upd();
    try {
      let lines;
      if (/pdf$/i.test(f.name)) lines = (await H.pdfToLines(pdfjsLib, new Uint8Array(await f.arrayBuffer()))).lines;
      else lines = (await f.text()).replace(/\r/g, '').split('\n');
      nr.lines = lines;
      const run = H.parseTester(lines);
      if (run && run.groups.length) { nr.run = run; showRun(); }
      else {
        $('#repInfo').innerHTML = `<div class="note">הפורמט לא זוהה.</div>${S.sample ? '<button id="aiConv" class="acc">המר בעזרת Claude</button> <span id="aiConvMsg" class="small muted"></span>' : '<p class="muted small">שלחו דוגמה מהמכשיר כדי להוסיף מתאם קבוע.</p>'}`;
        if ($('#aiConv')) $('#aiConv').onclick = async () => {
          $('#aiConv').disabled = true; $('#aiConvMsg').textContent = 'Claude ממיר… (עד כמה דקות)';
          try {
            const { text } = await S.sample(H.aiTesterPrompt(lines.join('\n')), { modelTier: 'default' });
            const csv = text.replace(/^```\w*\n?|```$/gm, '').trim().split('\n');
            const r2 = H.parseTester(csv, 'generic-csv');
            if (!r2 || !r2.groups.length) throw { code: 'empty' };
            r2.aiConverted = true; r2.warnings.unshift('הדוח הומר ע"י Claude מפורמט לא מוכר — יש לאמת דגימה מול המקור.');
            nr.run = r2; showRun(); upd();
          } catch (e) { $('#aiConvMsg').textContent = 'ההמרה נכשלה: ' + (e.code || e.message); $('#aiConv').disabled = false; }
        };
      }
    } catch (e) { $('#repInfo').innerHTML = '<div class="note err">לא ניתן לקרוא את הקובץ: ' + esc(e.message || e) + '</div>'; }
    upd();
  };
  $('#go').onclick = async () => {
    const n = S.netlists.find(x => x.id === nr.netlistId);
    $('#go').disabled = true; $('#goMsg').textContent = 'מריץ…';
    await new Promise(r => setTimeout(r, 30));
    try {
      const id = await executeRun(n, nr.run, nr.serial, nr.note, nr.fileName);
      S.newRun = null; location.hash = 'run-' + id;
    } catch (e) { $('#goMsg').textContent = 'שגיאה: ' + (e.code || e.message); $('#go').disabled = false; }
  };
  if (nr.run) showRun();
  upd();
}

function analyse(n, run) {
  const nl = H.parseNLF(n.text); nl.verified = n.status === 'verified'; nl.pn = n.pn; nl.rev = n.rev;
  const cmp = H.compareNets(nl, run);
  const { drawing, mechanical, derivedConnectors } = H.netlistToEngine(nl, cmp.singles);
  const { atp, results } = H.runToEngine(run);
  atp.approved_source = results.approved_source = true; // the tester report is the record itself; approval is about the netlist
  const rep = ENG.audit({ drawing, mechanical, atp, results });
  return { nl, cmp, rep, derivedConnectors, atp };
}
// engine ids -> the names inspectors use (J3:12 -> J3-12, @S1 -> פיצול S1, W181 -> its two ends)
function prettifier(rep, atp) {
  const pin = s => String(s).replace(/@([\w.+-]+)~open/g, '$1(open)').replace(/@([\w.+-]+)/g, '$1').replace(/\b([A-Z][\w]*):([\w]+)\b/g, '$1-$2');
  const ends = new Map();
  for (const m of rep.matrix) ends.set(m.edge, pin(m.a) + ' ↔ ' + pin(m.b));
  for (const t of atp.tests) if (!t.id.startsWith('I')) ends.set(t.id, pin(t.a) + ' ↔ ' + pin(t.b));
  return { pin, subject: s => ends.get(s) || pin(s) };
}
async function executeRun(n, run, serial, note, fileName) {
  const { cmp, rep, derivedConnectors, atp } = analyse(n, run);
  const pr = prettifier(rep, atp);
  const fp = P.fingerprint(P.programStructure(run)); const prog = programFor(n.pn, fp);
  const id = (n.pn + '__' + serial).replace(/[^\w\-.~:@+]/g, '_').slice(0, 80) + '__' + uid();
  const order = { blocker: 0, gap: 1, review: 2, info: 3 };
  const findings = rep.findings.filter(f => f.code !== 'END_TO_END_SPLICE')
    .sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 250)
    .map(f => ({ id: f.id, code: f.code, severity: f.severity, subject: pr.subject(f.subject), detail: pr.pin(f.detail).slice(0, 300), action: f.action }));
  const doc = {
    pn: n.pn, rev: n.rev, netlistId: n.id, netlistStatus: n.status, netlistVerifiedBy: n.verifiedBy || null, serial, note: note || '', fileName: fileName || '',
    format: run.format, meta: run.meta, reportWarnings: run.warnings.slice(0, 50), overall: run.overall || null, aiConverted: !!run.aiConverted,
    verdict: { ...rep.verdict, untested_points: rep.verdict.untested_points.map(pr.pin), partially_tested_spares: rep.verdict.partially_tested_spares.map(pr.pin) }, summary: { ...rep.summary, by_severity: rep.summary.by_severity }, derivedConnectors,
    compareCount: cmp.count, compareRows: cmp.rows.filter(r => r.status !== 'MATCH').slice(0, 200), compareStrip: cmp.rows.map(r => r.status === 'MATCH' ? 0 : ['EXTRA'].includes(r.status) ? 1 : 2),
    findings, findingsTotal: rep.findings.length, routineSplicePaths: rep.findings.filter(f => f.code === 'END_TO_END_SPLICE').length,
    programFingerprint: fp, programId: prog ? prog.id : null, programStatusAtRun: prog ? prog.status : 'none',
    createdAt: now(), createdBy: S.me
  };
  await put('runs', id, doc);
  try { await put('runData', id, { run: compactRun(run) }); } catch (e) { /* re-run data optional */ }
  return id;
}
const compactRun = r => ({ format: r.format, meta: r.meta, params: r.params, overall: r.overall, warnings: r.warnings, aiConverted: !!r.aiConverted,
  groups: r.groups.map(g => ({ first: g.first, last: g.last, isoKind: g.isoKind, result: g.result, pins: g.pins, cont: g.cont, iso: g.iso, comment: g.comment })), nonContinuity: r.nonContinuity, fourWire: r.fourWire });

// ----- run result -----
function vRunResult(id) {
  const r = S.runs.find(x => x.id === id);
  if (!r) { view('<div class="panel empty">טוען בדיקה…</div>'); return; }
  const v = VERDICT[r.verdict.status] || ['—', ''];
  const caseOf = f => S.cases.find(c => c.id === id + '__' + f.id);
  const bySev = {}; for (const f of r.findings) (bySev[f.severity] = bySev[f.severity] || []).push(f);
  const total = Object.values(r.compareCount || {}).reduce((a, b) => a + b, 0);
  names([r.createdBy, r.netlistVerifiedBy]).then(() => S.view === 'run' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  const revMismatch = r.meta?.schemaRev && r.rev && r.meta.schemaRev !== r.rev;
  view(`<h1>מק"ט <span class="mono">${esc(r.pn)}</span> · מספר סידורי <span class="mono">${esc(r.serial)}</span></h1>
  <div class="panel"><div class="verdict"><div class="dial ${v[1]}">${esc(v[0])}</div><div>
    <p style="margin:0 0 6px">${r.compareCount?.MATCH || 0} מתוך ${total} רשתות בשרטוט תואמות לבודק פין־אחר־פין.
    ${r.verdict.untested_points.length ? `<b class="t-bad">${r.verdict.untested_points.length} נקודות לא נבדקו.</b>` : 'כל הנקודות המחווטות נבדקו.'}
    ${r.verdict.isolation_gaps ? `<b class="t-bad">${r.verdict.isolation_gaps} זוגות רשתות ללא בידוד במתח גבוה.</b>` : ''}</p>
    <div class="strip" aria-label="רשתות לפי מצב">${(r.compareStrip || []).map(s => `<i class="${s === 2 ? 'b' : s === 1 ? 'w' : ''}"></i>`).join('')}</div>
    <div class="legend"><span><b style="background:var(--ok)"></b>תואם</span><span><b style="background:var(--warn)"></b>נקודות עודפות</span><span><b style="background:var(--bad)"></b>לא תואם / לא נבדק</span></div>
    <p class="small muted" style="margin:8px 0 0">נטליסט מהדורה ${esc(r.rev)} (${r.netlistStatus === 'verified' ? 'מאומת' : '<b class="t-warn">טיוטה</b>'}) · דוח: ${esc(r.fileName)} · ${esc(r.meta?.program || '')} ${esc(r.meta?.runDate || '')} · הורץ ע"י <span data-uid="${esc(r.createdBy)}">${esc(nameOf(r.createdBy))}</span> ${esc(fmtDate(r.createdAt))}</p>
  </div></div>
  ${revMismatch ? `<div class="note err">אי־התאמת מהדורות: הנטליסט מהדורה <b>${esc(r.rev)}</b>, תוכנית הבדיקה נבנתה למהדורה <b>${esc(r.meta.schemaRev)}</b>.</div>` : ''}
  ${programBanner(r)}
  ${r.aiConverted ? '<div class="note">הדוח הומר ע"י Claude מפורמט לא מוכר.</div>' : ''}
  <div class="row" style="margin-top:10px"><button id="dl" class="acc">הורד דוח</button><button id="openAll" class="ghost">פתח לטיפול את כל החסמים והפערים</button><button id="rerun" class="ghost">הרץ שוב מול הנטליסט העדכני</button></div></div>
  <div class="panel"><h2>השוואת רשתות: שרטוט מול בודק</h2>
    ${r.compareRows.length ? `<div class="scroll"><table class="stack"><thead><tr><th>רשת בשרטוט</th><th>מצב</th><th>פירוט</th><th>נקודות</th></tr></thead><tbody>${r.compareRows.map(x => `<tr><td class="mono">${esc(x.net)}</td><td><span class="tag t-${CMP[x.status]?.[1]}">${esc(CMP[x.status]?.[0] || x.status)}</span></td><td>${esc(x.detail)}</td><td class="mono small">${esc(x.pins.join(' '))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="t-ok">כל הרשתות תואמות.</p>'}</div>
  ${r.reportWarnings?.length ? `<div class="panel"><h2>הערות מתוך הדוח עצמו</h2>${r.reportWarnings.map(w => `<div class="find review">${esc(w)}</div>`).join('')}</div>` : ''}
  <div class="panel"><h2>ממצאי המנוע</h2>
  ${['blocker', 'gap', 'review', 'info'].filter(s => bySev[s]).map((s, i) => `<details ${i < 2 ? 'open' : ''}><summary>${SEV[s]} (${bySev[s].length})</summary>${groupFindings(bySev[s]).map(g => g.many ?
    `<div class="find ${s}"><b>${esc(codeHe(g.code))}</b> × ${g.items.length} <span class="small muted">— ${esc(g.items[0].detail)}${g.items.length > 1 ? ' …' : ''}</span></div>` :
    g.items.map(f => { const c = caseOf(f); return `<div class="find ${s}"><div class="row" style="justify-content:space-between"><span><b class="mono">${esc(f.subject)}</b> — ${esc(f.detail)}</span>${c ? `<a class="tag" href="#findings">${esc(CASE_ST[c.status])}</a>` : `<button class="ghost small" data-open="${esc(f.id)}" style="min-height:36px;padding:4px 10px">פתח לטיפול</button>`}</div><div class="small muted">${esc(codeHe(f.code))} · ${esc(f.action)}</div></div>`; }).join('')).join('')}</details>`).join('')}
  ${r.routineSplicePaths ? `<p class="small muted">${r.routineSplicePaths} מדידות עוברות דרך פיצולים כמצופה (לא מוצגות).</p>` : ''}
  <p class="small muted">אין בבדיקה זו אישור שחרור. כיסוי שלם הוא תנאי לסקירה הנדסית.</p></div>`);
  $('#view').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openCase(r, r.findings.find(f => f.id === b.dataset.open)));
  $('#openAll').onclick = async () => {
    const list = r.findings.filter(f => ['blocker', 'gap'].includes(f.severity) && !caseOf(f));
    if (!list.length) { toast('אין חסמים או פערים פתוחים'); return; }
    if (!(await dialog('לפתוח ממצאים לטיפול?', `<p>${list.length} ממצאים ייפתחו במעקב המשותף.</p>`, 'פתח'))) return;
    for (const f of list) await openCase(r, f, true);
    toast(list.length + ' ממצאים נפתחו');
  };
  $('#dl').onclick = () => downloadReport(r);
  $('#rerun').onclick = async () => {
    const n = S.netlists.filter(x => x.pn === r.pn).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const pick = n.find(x => x.id === r.netlistId) || n[0];
    if (!pick) { toast('לא נמצא נטליסט למק"ט'); return; }
    const d = await getDoc('runData', r.id); if (!d) { toast('נתוני הדוח המקוריים אינם שמורים'); return; }
    const id2 = await executeRun(pick, d.run, r.serial, 'הרצה חוזרת של ' + r.id, r.fileName);
    location.hash = 'run-' + id2;
  };
}
function programBanner(r) {
  if (!r.programFingerprint) return '';
  const p = programFor(r.pn, r.programFingerprint);
  if (p && isApproved(p)) return `<div class="note" style="border-color:var(--ok)">התוכנית שבה בוצעה הבדיקה <b>${esc(PST[p.status][0])}</b> (טביעת אצבע <span class="mono">${esc(r.programFingerprint.slice(0, 8))}</span>). <a href="#program-${esc(p.id)}">לאישור</a></div>`;
  if (p) return `<div class="note err">התוכנית שבה בוצעה הבדיקה במצב <b>${esc(PST[p.status][0])}</b>. <a href="#program-${esc(p.id)}">לבדיקת התוכנית</a></div>`;
  return `<div class="note err">התוכנית שבה בוצעה הבדיקה (טביעת אצבע <span class="mono">${esc(r.programFingerprint.slice(0, 8))}</span>) <b>לא נבדקה ולא אושרה</b> — ייתכן שהיא חדשה או ששונתה. <a href="#program-new">בדיקת תוכנית</a></div>`;
}
function groupFindings(list) {
  const by = new Map(); for (const f of list) { if (!by.has(f.code)) by.set(f.code, []); by.get(f.code).push(f); }
  return [...by].map(([code, items]) => ({ code, items, many: items.length > 8 }));
}
async function openCase(r, f, quiet) {
  const id = r.id + '__' + f.id;
  const data = { runId: r.id, pn: r.pn, rev: r.rev, serial: r.serial, findingId: f.id, code: f.code, severity: f.severity, subject: f.subject, detail: f.detail, engineAction: f.action,
    status: 'OPEN', owner: null, action: '', evidence: '', verification: '', closedBy: null, closedAt: null, createdBy: S.me, createdAt: now(), updatedAt: now(),
    history: [{ at: now(), by: S.me, event: 'OPENED' }] };
  try { await put('cases', id, data); if (!quiet) toast('נפתח לטיפול'); } catch (e) { toast('שגיאה: ' + (e.code || e.message)); }
}

// ----- findings tracker -----
function vFindings() {
  const f = S.findFilter || (S.findFilter = { status: 'open', pn: '' });
  const list = S.cases.filter(c => (f.status === 'all' || (f.status === 'open' ? !['CLOSED', 'WAIVED'].includes(c.status) : ['CLOSED', 'WAIVED'].includes(c.status))) && (!f.pn || (c.pn + ' ' + c.serial).toLowerCase().includes(f.pn.toLowerCase())));
  names(list.flatMap(c => [c.owner, c.closedBy, c.createdBy])).then(() => S.view === 'findings' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  view(`<h1>מעקב ממצאים</h1>
  <div class="panel"><div class="grid"><div><label for="fs">מצב</label><select id="fs"><option value="open">פתוחים</option><option value="closed">סגורים</option><option value="all">הכל</option></select></div>
  <div><label for="fp">סינון לפי מק"ט / מספר סידורי</label><input id="fp" value="${esc(f.pn)}"></div></div></div>
  ${list.length ? list.map(c => caseCard(c)).join('') : '<div class="panel empty">אין ממצאים בסינון הזה.</div>'}`);
  $('#fs').value = f.status;
  $('#fs').onchange = () => { f.status = $('#fs').value; vFindings(); };
  $('#fp').onchange = () => { f.pn = $('#fp').value; vFindings(); };
  $('#view').querySelectorAll('[data-case]').forEach(el => wireCase(el));
}
function caseCard(c) {
  const closed = ['CLOSED', 'WAIVED'].includes(c.status);
  return `<details class="panel" data-case="${esc(c.id)}" ${S.openCase === c.id ? 'open' : ''}><summary><span class="tag ${closed ? 't-ok' : c.severity === 'blocker' ? 't-bad' : 't-warn'}">${esc(CASE_ST[c.status])}</span> <b>${esc(codeHe(c.code))}</b> · <span class="mono">${esc(c.subject)}</span> <span class="small muted">(${esc(c.pn)} · ${esc(c.serial)})</span></summary>
  <p>${esc(c.detail)}</p><p class="small muted">המלצת מנוע: ${esc(c.engineAction)} · <a href="#run-${esc(c.runId)}">לבדיקה</a></p>
  <div class="grid"><div><label>אחראי</label><div class="row"><span data-uid="${esc(c.owner || '')}">${esc(nameOf(c.owner))}</span>${closed ? '' : '<button class="ghost" data-act="mine" style="min-height:36px;padding:4px 10px">אני אחראי</button>'}</div></div>
  <div><label>מצב</label><select data-f="status" ${closed ? 'disabled' : ''}>${['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'].map(s => `<option value="${s}" ${c.status === s ? 'selected' : ''}>${CASE_ST[s]}</option>`).join('')}${closed ? `<option selected>${CASE_ST[c.status]}</option>` : ''}</select></div></div>
  <div class="grid"><div><label>פעולה מתקנת</label><textarea data-f="action" ${closed ? 'disabled' : ''}>${esc(c.action)}</textarea></div>
  <div><label>ראיה (מס' דוח / בדיקה חוזרת)</label><textarea data-f="evidence" ${closed ? 'disabled' : ''}>${esc(c.evidence)}</textarea></div>
  <div><label>תיעוד אימות</label><textarea data-f="verification" ${closed ? 'disabled' : ''}>${esc(c.verification)}</textarea></div></div>
  <div class="row" style="margin-top:10px">${closed ? `<span class="small">נסגר ע"י <span data-uid="${esc(c.closedBy)}">${esc(nameOf(c.closedBy))}</span> ${esc(fmtDate(c.closedAt))}</span><button class="ghost" data-act="reopen">פתח מחדש</button>` : '<button class="acc" data-act="close">סגור לאחר אימות</button><button class="ghost" data-act="waive">חריגה מאושרת</button>'}</div>
  <details><summary class="small">היסטוריה (${(c.history || []).length})</summary>${(c.history || []).map(h => `<div class="small">${esc(fmtDate(h.at))} · <span data-uid="${esc(h.by)}">${esc(nameOf(h.by))}</span> · ${esc(h.event)}${h.field ? ' ' + esc(h.field) : ''}</div>`).join('')}</details></details>`;
}
function wireCase(el) {
  const id = el.dataset.case, c = () => S.cases.find(x => x.id === id);
  el.addEventListener('toggle', () => { if (el.open) S.openCase = id; });
  const hist = (ev, field) => [...(c().history || []), { at: now(), by: S.me, event: ev, ...(field ? { field } : {}) }].slice(-100);
  el.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', async () => {
    const k = inp.dataset.f, val = inp.value; if (c()[k] === val) return;
    try { await patch('cases', id, { [k]: val, updatedAt: now(), history: hist('EDIT', k) }); } catch (e) { toast('שמירה נכשלה: ' + (e.code || e.message)); }
  }));
  el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.act, cur = c();
    if (a === 'mine') return patch('cases', id, { owner: S.me, status: cur.status === 'OPEN' ? 'IN_PROGRESS' : cur.status, updatedAt: now(), history: hist('ASSIGNED') });
    if (a === 'reopen') return patch('cases', id, { status: 'IN_PROGRESS', closedBy: null, closedAt: null, updatedAt: now(), history: hist('REOPENED') });
    const vals = Object.fromEntries([...el.querySelectorAll('[data-f]')].map(i => [i.dataset.f, i.value.trim()]));
    if (a === 'close') {
      const miss = [!vals.action && 'פעולה מתקנת', !vals.evidence && 'ראיה', !vals.verification && 'תיעוד אימות'].filter(Boolean);
      const later = S.runs.find(r => r.pn === cur.pn && r.serial === cur.serial && r.createdAt > (S.runs.find(x => x.id === cur.runId)?.createdAt || ''));
      const still = later && later.findings.some(f => f.code === cur.code && f.subject === cur.subject);
      if (miss.length) { toast('חסר: ' + miss.join(', ')); return; }
      const warn = !later ? '<p class="t-warn">לא נמצאה בדיקה חוזרת לאותו מספר סידורי — הסגירה תתבסס על התיעוד בלבד.</p>' : still ? '<p class="t-bad">הממצא עדיין מופיע בבדיקה החוזרת האחרונה!</p>' : '<p class="t-ok">הממצא לא מופיע בבדיקה החוזרת האחרונה.</p>';
      if (!(await dialog('סגירה לאחר אימות', warn + '<p>הסגירה תירשם על שמכם כמאמתים. אין בכך אישור שחרור.</p>', 'סגור'))) return;
      return patch('cases', id, { ...vals, status: 'CLOSED', closedBy: S.me, closedAt: now(), recheckRunId: later?.id || null, updatedAt: now(), history: hist('CLOSED') });
    }
    if (a === 'waive') {
      if (S.user && S.user.canEdit && !(await S.user.canEdit())) { toast('חריגה מאושרת דורשת הרשאת עורך'); return; }
      const d = await dialog('חריגה מאושרת', '<label for="wj">נימוק ומספר אישור</label><textarea id="wj"></textarea>', 'אשר חריגה');
      const just = d && d.querySelector('#wj').value.trim(); if (!d) return; if (!just) { toast('נדרש נימוק'); return; }
      return patch('cases', id, { ...vals, status: 'WAIVED', waiver: just, closedBy: S.me, closedAt: now(), updatedAt: now(), history: hist('WAIVED') });
    }
  }));
}

// ----- history -----
function vHistory() {
  const f = S.histFilter || (S.histFilter = { pn: '', serial: '' });
  const list = S.runs.filter(r => (!f.pn || r.pn.toLowerCase().includes(f.pn.toLowerCase())) && (!f.serial || String(r.serial).toLowerCase().includes(f.serial.toLowerCase())));
  const bySerial = {}; for (const r of list) (bySerial[r.pn + ' · ' + r.serial] = bySerial[r.pn + ' · ' + r.serial] || []).push(r);
  names(list.map(r => r.createdBy)).then(() => S.view === 'history' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  view(`<h1>היסטוריה לפי מק"ט ומספר סידורי</h1>
  <div class="panel"><div class="grid"><div><label for="hp">מק"ט</label><input id="hp" class="mono" value="${esc(f.pn)}"></div><div><label for="hs">מספר סידורי</label><input id="hs" class="mono" value="${esc(f.serial)}"></div></div>
  <p class="small muted">${list.length} בדיקות · ${Object.keys(bySerial).length} יחידות</p></div>
  ${Object.entries(bySerial).map(([k, runs]) => `<div class="panel"><h2 class="mono">${esc(k)}</h2>${runsTable(runs)}</div>`).join('') || '<div class="panel empty">אין בדיקות.</div>'}`);
  $('#hp').onchange = () => { f.pn = $('#hp').value.trim(); vHistory(); };
  $('#hs').onchange = () => { f.serial = $('#hs').value.trim(); vHistory(); };
}

// ----- downloadable report -----
function reportHtml(r) {
  const v = VERDICT[r.verdict.status] || ['—'];
  const total = Object.values(r.compareCount || {}).reduce((a, b) => a + b, 0);
  const rows = (r.findings || []).filter(f => f.severity !== 'info');
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>דוח בדיקה ${esc(r.pn)} ${esc(r.serial)}</title>
<style>body{font:14px/1.5 Arial,sans-serif;color:#111;margin:24px;max-width:900px}h1{font-size:22px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #bbb;padding:5px;text-align:right;vertical-align:top}th{background:#eee}.v{font-size:18px;font-weight:bold;padding:10px;border:2px solid #111;margin:12px 0}.mono{font-family:monospace;direction:ltr;unicode-bidi:isolate}.sig{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:40px}.sig div{border-top:1px solid #111;padding-top:4px}@media print{body{margin:10mm}}</style></head><body>
<h1>דוח בדיקת שלמות כיסוי — רתמה</h1>
<table><tr><th>מק"ט</th><td class="mono">${esc(r.pn)}</td><th>מספר סידורי</th><td class="mono">${esc(r.serial)}</td></tr>
<tr><th>מהדורת נטליסט</th><td>${esc(r.rev)} (${r.netlistStatus === 'verified' ? 'מאומת' : 'טיוטה'})</td><th>מהדורה בתוכנית הבדיקה</th><td>${esc(r.meta?.schemaRev || '—')}</td></tr>
<tr><th>תוכנית / דוח</th><td>${esc(r.meta?.program || '')} · ${esc(r.fileName)}</td><th>תאריך בדיקה</th><td>${esc(r.meta?.runDate || '')}</td></tr>
<tr><th>הופק</th><td>${esc(fmtDate(r.createdAt))}</td><th>הערה</th><td>${esc(r.note)}</td></tr>
<tr><th>תוכנית בדיקה</th><td colspan="3">${(() => { const p = r.programFingerprint && programFor(r.pn, r.programFingerprint); return p ? esc(PST[p.status][0]) + (p.decision ? ' · ' + esc(nameOf(p.decision.by)) + ' ' + esc(fmtDate(p.decision.at)) : '') : 'לא אושרה'; })()} · <span class="mono">${esc(r.programFingerprint || '')}</span></td></tr></table>
<div class="v">הכרעה: ${esc(v[0])}</div>
<p>${r.compareCount?.MATCH || 0}/${total} רשתות תואמות · נקודות שלא נבדקו: ${r.verdict.untested_points.length} · זוגות ללא בידוד: ${r.verdict.isolation_gaps} · חסמים: ${r.verdict.blockers}</p>
${r.compareRows.length ? `<h2>רשתות שאינן תואמות</h2><table><tr><th>רשת</th><th>מצב</th><th>פירוט</th></tr>${r.compareRows.map(x => `<tr><td class="mono">${esc(x.net)}</td><td>${esc(CMP[x.status]?.[0] || x.status)}</td><td>${esc(x.detail)}</td></tr>`).join('')}</table>` : '<p>כל הרשתות תואמות.</p>'}
${r.reportWarnings?.length ? `<h2>הערות מתוך דוח הבודק</h2><ul>${r.reportWarnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<h2>ממצאים</h2><table><tr><th>חומרה</th><th>נושא</th><th>פירוט</th><th>פעולה</th></tr>${rows.map(f => `<tr><td>${esc(SEV[f.severity])}<br><small>${esc(codeHe(f.code))}</small></td><td class="mono">${esc(f.subject)}</td><td>${esc(f.detail)}</td><td>${esc(f.action)}</td></tr>`).join('')}</table>
<p><b>אין בדוח זה אישור שחרור.</b> כיסוי שלם הוא תנאי לסקירה הנדסית ואינו מחליף אותה.</p>
<div class="sig"><div>בודק: ____________ תאריך: ______</div><div>מאשר: ____________ תאריך: ______</div></div></body></html>`;
}
function downloadReport(r) { return downloadHtml(reportHtml(r), `harness_report_${r.pn}_${r.serial}.html`); }

// ---------------- program approval ----------------
const P = window.HQAP;
const PST = { draft: ['טיוטה', 'warn'], submitted: ['ממתין לאישור', 'info'], approved: ['מאושרת', 'ok'], approved_with_deviations: ['מאושרת עם חריגות', 'ok'], rejected: ['נדחתה', 'bad'] };
const IST = { pass: ['תקין', 'ok'], justify: ['דורש נימוק', 'warn'], fail: ['כשל', 'bad'] };
const reqKey = pn => String(pn).replace(/[^\w\-.~:@+]/g, '_');
const isApproved = p => p && (p.status === 'approved' || p.status === 'approved_with_deviations');
function programFor(pn, fp) { return S.programs.filter(p => p.pn === pn && p.fingerprint === fp).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] || null; }

function vPrograms() {
  const by = {}; for (const p of S.programs) (by[p.pn] = by[p.pn] || []).push(p);
  names(S.programs.flatMap(p => [p.preparedBy, p.decision?.by])).then(() => S.view === 'programs' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  view(`<h1>אישור תוכניות בדיקה</h1>
  <div class="panel"><div class="row" style="justify-content:space-between"><p class="muted" style="margin:0;max-width:64ch">בודקים את תוכנית הבודק מול הנטליסט המאומת ודרישות המק"ט, מנמקים כל חריגה, ומאשר אחר מחליט. תוכנית מאושרת ננעלת לפי טביעת האצבע שלה.</p>
  <button class="acc" onclick="location.hash='program-new'">בדיקת תוכנית חדשה</button></div></div>
  ${Object.keys(by).length ? Object.entries(by).map(([pn, list]) => `<div class="panel"><h2 class="mono">${esc(pn)}</h2><div class="scroll"><table class="stack"><thead><tr><th>תוכנית</th><th>טביעת אצבע</th><th>נטליסט</th><th>מצב</th><th>הוכן ע"י</th><th>הוחלט ע"י</th></tr></thead><tbody>${list.map(p =>
    `<tr class="click" onclick="location.hash='program-${esc(p.id)}'"><td class="mono">${esc(p.structure?.program || '—')}</td><td class="mono small">${esc(p.fingerprint.slice(0, 8))}</td><td>מהדורה ${esc(p.netlistRev)}</td><td><span class="tag t-${PST[p.status][1]}">${esc(PST[p.status][0])}</span></td><td data-uid="${esc(p.preparedBy)}">${esc(nameOf(p.preparedBy))}</td><td>${p.decision ? `<span data-uid="${esc(p.decision.by)}">${esc(nameOf(p.decision.by))}</span> ${esc(fmtDate(p.decision.at))}` : '—'}</td></tr>`).join('')}</tbody></table></div></div>`).join('') : '<div class="panel empty">עדיין לא נבדקו תוכניות.</div>'}`);
}

function reqFields(r) {
  r = r || {};
  return `<div class="grid">
   <div><label for="rqV">מתח בידוד נדרש (V)</label><input id="rqV" inputmode="decimal" value="${esc(r.isoVolt ?? '')}"></div>
   <div><label for="rqM">מינימום בידוד נדרש (MΩ)</label><input id="rqM" inputmode="decimal" value="${esc(r.isoMinMohm ?? '')}"></div>
   <div><label for="rqC">מקסימום רציפות (Ω)</label><input id="rqC" inputmode="decimal" value="${esc(r.contMaxOhm ?? '')}"></div>
   <div><label for="rqT">טולרנס נגדים נדרש (±%)</label><input id="rqT" inputmode="decimal" value="${esc(r.resTolPct ?? '')}"></div>
   <div style="grid-column:1/-1"><label for="rqS">מסמך מקור לדרישות</label><input id="rqS" value="${esc(r.source ?? '')}" placeholder="מפרט / נוהל / מהדורה"></div></div>`;
}
const readReq = () => { const n = id => { const v = $('#' + id).value.trim(); return v === '' ? null : +v; }; return { isoVolt: n('rqV'), isoMinMohm: n('rqM'), contMaxOhm: n('rqC'), resTolPct: n('rqT'), source: $('#rqS').value.trim() }; };

function vProgramNew() {
  const st = S.newProg || (S.newProg = { netlistId: '', run: null, fileName: '' });
  const opts = S.netlists.map(n => `<option value="${esc(n.id)}" ${n.id === st.netlistId ? 'selected' : ''}>${esc(n.pn)} · מהדורה ${esc(n.rev)}${n.status === 'verified' ? '' : ' (טיוטה — לא ניתן לאשר)'}</option>`).join('');
  view(`<h1>בדיקת תוכנית חדשה</h1>
  <div class="panel"><h2>1. נטליסט מאומת</h2><label for="pnl">מק"ט ומהדורה</label><select id="pnl"><option value="">בחרו…</option>${opts}</select><div id="pnlW"></div></div>
  <div class="panel"><h2>2. דרישות למק"ט</h2><p class="small muted">נשמרות למק"ט ומשמשות כל בדיקת תוכנית שלו. שדה ריק = לא נבדק.</p><div id="reqBox">${reqFields()}</div></div>
  <div class="panel"><h2>3. התוכנית</h2><label for="pfile">דוח ריצה או הדפסת תוכנית (PDF / TXT / CSV)</label><input type="file" id="pfile" accept=".pdf,.txt,.csv,.log,text/plain">
  <p class="small muted">נלקח רק מבנה התוכנית — קבוצות, סוג בידוד, פרמטרים וגבולות — לא הערכים שנמדדו.</p><div id="pinfo"></div></div>
  <div class="panel row"><button id="pgo" class="acc" disabled>בצע בדיקת תוכנית</button><span id="pmsg" class="small muted"></span></div>`);
  const loadReq = async () => {
    const n = S.netlists.find(x => x.id === st.netlistId);
    $('#pnlW').innerHTML = n && n.status !== 'verified' ? '<div class="note err">אפשר לבדוק, אבל תוכנית תאושר רק מול נטליסט מאומת.</div>' : '';
    if (n) { const r = await getDoc('requirements', reqKey(n.pn)).catch(() => null); $('#reqBox').innerHTML = reqFields(r); }
    upd();
  };
  const upd = () => { const ok = st.netlistId && st.run; $('#pgo').disabled = !ok; $('#pmsg').textContent = !st.netlistId ? 'בחרו נטליסט' : !st.run ? 'טענו קובץ' : ''; };
  $('#pnl').onchange = () => { st.netlistId = $('#pnl').value; loadReq(); };
  $('#pfile').onchange = async () => {
    const f = $('#pfile').files[0]; if (!f) return; st.fileName = f.name; st.run = null; $('#pinfo').innerHTML = '<p class="muted">קורא…</p>';
    try {
      const lines = /pdf$/i.test(f.name) ? (await H.pdfToLines(pdfjsLib, new Uint8Array(await f.arrayBuffer()))).lines : (await f.text()).replace(/\r/g, '').split('\n');
      const run = H.parseTester(lines);
      if (!run || !run.groups.length) { $('#pinfo').innerHTML = '<div class="note err">הפורמט לא זוהה. אפשר להמיר דוח בעזרת Claude במסך "בדיקה חדשה" ולהשתמש בבדיקה שנוצרה.</div>'; upd(); return; }
      st.run = run; const s = P.programStructure(run);
      $('#pinfo').innerHTML = `<p>תוכנית <b class="mono">${esc(s.program || '—')}</b> · מהדורת שרטוט ${esc(s.schemaRev || '?')} · ${s.groups.length} קבוצות · ${s.fourWire.length} מדידות 4 חוטים · בידוד ${esc(s.params.isoVolt ?? '?')}V/${s.params.isoMinOhm != null ? s.params.isoMinOhm / 1e6 : '?'}MΩ · רציפות עד ${esc(s.params.contMaxOhm ?? '?')}Ω · טביעת אצבע <span class="mono">${esc(P.fingerprint(s).slice(0, 8))}</span></p>`;
    } catch (e) { $('#pinfo').innerHTML = '<div class="note err">לא ניתן לקרוא: ' + esc(e.message || e) + '</div>'; }
    upd();
  };
  $('#pgo').onclick = async () => {
    const n = S.netlists.find(x => x.id === st.netlistId), req = readReq();
    $('#pgo').disabled = true;
    try {
      await put('requirements', reqKey(n.pn), { pn: n.pn, ...req, updatedBy: S.me, updatedAt: now() });
      const structure = P.programStructure(st.run), fp = P.fingerprint(structure);
      const existing = S.programs.find(p => p.pn === n.pn && p.fingerprint === fp && p.netlistId === n.id && p.status !== 'rejected');
      if (existing && !(await dialog('התוכנית כבר נבדקה', `<p>קיימת בדיקה של אותה תוכנית מול אותו נטליסט (${esc(PST[existing.status][0])}). לפתוח אותה?</p>`, 'פתח'))) { $('#pgo').disabled = false; return; }
      if (existing) { S.newProg = null; location.hash = 'program-' + existing.id; return; }
      const id = reqKey(n.pn) + '__' + fp.slice(0, 8) + '__' + uid().slice(-4);
      const review = P.reviewProgram(H.parseNLF(n.text), structure, req);
      await put('programs', id, { pn: n.pn, netlistId: n.id, netlistRev: n.rev, netlistUpdatedAt: n.updatedAt || null, netlistVerified: n.status === 'verified',
        structure, fingerprint: fp, sourceFile: st.fileName, req, review, deviations: {}, status: 'draft', preparedBy: S.me, createdAt: now(), updatedAt: now(),
        history: [{ at: now(), by: S.me, event: 'CREATED' }] });
      S.newProg = null; location.hash = 'program-' + id;
    } catch (e) { toast('שגיאה: ' + (e.code || e.message)); $('#pgo').disabled = false; }
  };
  if (st.netlistId) loadReq(); upd();
}

function vProgram(id) {
  const p = S.programs.find(x => x.id === id);
  if (!p) { view('<div class="panel empty">טוען…</div>'); return; }
  const n = S.netlists.find(x => x.id === p.netlistId);
  const stale = !n || n.updatedAt !== p.netlistUpdatedAt || n.status !== 'verified';
  const ds = P.decisionState(p.review, p.deviations);
  const mine = p.preparedBy === S.me, locked = p.status !== 'draft';
  const canDecide = p.status === 'submitted' && !mine && (S.mode !== 'folder' || ['approver', 'admin'].includes(S.role));
  const devs = p.deviations || {};
  const uids = [p.preparedBy, p.decision?.by, ...Object.values(devs).flatMap(d => [d.by, d.decidedBy])];
  names(uids).then(() => S.view === 'program' && document.querySelectorAll('[data-uid]').forEach(e => e.textContent = nameOf(e.dataset.uid)));
  const st = PST[p.status];
  view(`<h1>תוכנית <span class="mono">${esc(p.structure.program || '—')}</span> · <span class="mono">${esc(p.pn)}</span></h1>
  <div class="panel"><div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><p style="margin:0">מול נטליסט מהדורה <b>${esc(p.netlistRev)}</b> · טביעת אצבע <span class="mono">${esc(p.fingerprint)}</span> · מקור: ${esc(p.sourceFile)}</p>
    <p class="small muted" style="margin:4px 0 0">הוכן ע"י <span data-uid="${esc(p.preparedBy)}">${esc(nameOf(p.preparedBy))}</span> ${esc(fmtDate(p.createdAt))}${p.req?.source ? ' · דרישות לפי ' + esc(p.req.source) : ''}</p></div>
    <span class="stamp t-${st[1]}">${esc(st[0])}</span></div>
    <div class="kpis">${p.review.criteria.map(c => `<div class="kpi"><strong class="t-${IST[c.status][1]}" style="font-size:18px">${esc(IST[c.status][0])}</strong>${esc(c.title)}</div>`).join('')}</div>
    ${stale && !isApproved(p) ? '<div class="note err">הנטליסט השתנה או אינו מאומת מאז הבדיקה. יש לנתח מחדש לפני הגשה.</div>' : ''}
    ${stale && isApproved(p) ? '<div class="note err">הנטליסט השתנה מאז האישור — האישור עשוי שלא לשקף את השרטוט הנוכחי. מומלץ לבטל ולבדוק מחדש.</div>' : ''}
    ${p.decision ? `<div class="note">${esc(PST[p.decision.outcome]?.[0] || p.decision.outcome)} ע"י <span data-uid="${esc(p.decision.by)}">${esc(nameOf(p.decision.by))}</span> ב־${esc(fmtDate(p.decision.at))}${p.decision.note ? ' — ' + esc(p.decision.note) : ''}</div>` : ''}
  </div>
  ${p.review.criteria.map(c => `<div class="crit"><h3><span class="tag t-${IST[c.status][1]}">${esc(IST[c.status][0])}</span>${esc(c.title)}</h3><p class="why small muted">${esc(c.why)}${c.summary ? ' · <b>' + esc(c.summary) + '</b>' : ''}</p>
    ${c.items.filter(i => i.status !== 'pass').map(i => { const d = devs[P.devId(i.key)] || {}; return `<div class="item" data-key="${esc(i.key)}"><div><span class="tag t-${IST[i.status][1]}">${esc(IST[i.status][0])}</span> <b class="mono">${esc(i.subject)}</b> — ${esc(i.detail)}</div>
      <label>נימוק / התייחסות${d.by ? ` <span class="small muted">(<span data-uid="${esc(d.by)}">${esc(nameOf(d.by))}</span>)</span>` : ''}</label><textarea data-just ${locked ? 'disabled' : ''} placeholder="${i.status === 'fail' ? 'כשל: מה תוקן, או מדוע מתקבל כחריגה' : 'מדוע זה מקובל / איך מכוסה (למשל בדיקה ויזואלית לפי נוהל…)'}">${esc(d.justification || '')}</textarea>
      <div class="dec">${d.decision ? `<span class="tag t-${d.decision === 'accepted' ? 'ok' : 'bad'}">${d.decision === 'accepted' ? 'התקבל' : 'נדחה'}</span> <span class="small muted"><span data-uid="${esc(d.decidedBy)}">${esc(nameOf(d.decidedBy))}</span> ${esc(fmtDate(d.decidedAt))}</span>` : ''}
      ${canDecide && d.justification ? (d.decision ? `<button class="ghost" data-dec="${d.decision === 'accepted' ? 'rejected' : 'accepted'}" data-flip="1" style="min-height:36px;padding:4px 12px">${d.decision === 'accepted' ? 'שנה לדחייה' : 'שנה לקבלה'}</button>` : `<button class="ghost" data-dec="accepted" style="min-height:36px;padding:4px 12px">קבל</button><button class="ghost" data-dec="rejected" style="min-height:36px;padding:4px 12px">דחה</button>`) : ''}</div></div>`; }).join('')}
    ${c.items.filter(i => i.status === 'pass').length ? `<details><summary class="small">תקין (${c.items.filter(i => i.status === 'pass').length})</summary>${c.items.filter(i => i.status === 'pass').map(i => `<div class="small">${esc(i.subject)} — ${esc(i.detail)}</div>`).join('')}</details>` : ''}</div>`).join('')}
  <div class="panel"><h2>החלטה</h2>
    <p>${ds.nonPass ? `${ds.nonPass} פריטים דורשים התייחסות: ${ds.unjustified.length} ללא נימוק · ${ds.open.length} ממתינים להחלטה · ${ds.accepted.length} התקבלו · ${ds.rejected.length} נדחו` : 'כל הקריטריונים תקינים.'}</p>
    ${p.status === 'submitted' && mine ? '<p class="note">הגשתם את התוכנית — ההחלטה חייבת להתקבל ע"י בודק אחר.</p>' : ''}
    ${p.status === 'submitted' && !mine && !canDecide ? '<p class="note">רק חברי צוות בתפקיד "מאשר" יכולים להחליט על התוכנית.</p>' : ''}
    <div class="row">
      ${p.status === 'draft' ? `<button class="ghost" id="reanalyse">נתח מחדש</button><button class="acc" id="submit" ${ds.canSubmit && !stale && p.netlistVerified ? '' : 'disabled'}>הגש לאישור</button>` : ''}
      ${p.status === 'submitted' && mine ? '<button class="ghost" id="toDraft">החזר לטיוטה</button>' : ''}
      ${canDecide ? `<button class="acc" id="approve" ${ds.canApprove ? '' : 'disabled'}>${ds.nonPass ? 'אשר עם חריגות' : 'אשר תוכנית'}</button><button class="ghost" id="reject">דחה תוכנית</button>` : ''}
      ${isApproved(p) || p.status === 'rejected' ? '<button class="ghost" id="revoke">פתח מחדש</button>' : ''}
      <button class="ghost" id="pdl">הורד דוח אישור</button></div>
    ${p.status === 'draft' && !ds.canSubmit ? '<p class="small muted">להגשה נדרש נימוק לכל פריט שאינו תקין' + (p.netlistVerified ? '' : ', ונטליסט מאומת') + '.</p>' : ''}
    <details><summary class="small">היסטוריה (${(p.history || []).length})</summary>${(p.history || []).map(h => `<div class="small">${esc(fmtDate(h.at))} · <span data-uid="${esc(h.by)}">${esc(nameOf(h.by))}</span> · ${esc(h.event)}${h.key ? ' · ' + esc(h.key) : ''}</div>`).join('')}</details></div>`);
  const hist = (event, extra) => [...(p.history || []), { at: now(), by: S.me, event, ...(extra || {}) }].slice(-300);
  const save = async (data, event, extra) => { try { await patch('programs', id, { ...data, updatedAt: now(), history: hist(event, extra) }); } catch (e) { toast('שמירה נכשלה: ' + (e.code || e.message)); } };
  $('#view').querySelectorAll('.item').forEach(el => {
    const key = el.dataset.key, ta = el.querySelector('[data-just]');
    const k = P.devId(key);
    // write only this item's record (nested merge), so parallel edits by others are not overwritten
    ta && ta.addEventListener('change', () => {
      const cur = S.programs.find(x => x.id === id); const v = ta.value.trim();
      if (((cur.deviations || {})[k]?.justification || '') === v) return;
      save({ deviations: { [k]: { key, justification: v, by: S.me, at: now(), decision: null, decidedBy: null, decidedAt: null } } }, 'JUSTIFIED', { key });
    });
    el.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
      b.disabled = true;
      save({ deviations: { [k]: { decision: b.dataset.dec, decidedBy: S.me, decidedAt: now() } } }, b.dataset.dec === 'accepted' ? 'DEVIATION_ACCEPTED' : 'DEVIATION_REJECTED', { key });
    });
  });
  const on = (sel, fn) => { const b = $(sel); if (b) b.onclick = fn; };
  on('#reanalyse', async () => {
    const nn = S.netlists.find(x => x.id === p.netlistId); if (!nn) { toast('הנטליסט לא נמצא'); return; }
    const req = await getDoc('requirements', reqKey(p.pn)).catch(() => null) || p.req;
    const review = P.reviewProgram(H.parseNLF(nn.text), p.structure, req);
    const keys = new Set(review.criteria.flatMap(c => c.items.map(i => P.devId(i.key))));
    const d = Object.fromEntries(Object.entries(p.deviations || {}).filter(([k]) => keys.has(k)).map(([k, v]) => [k, { key: v.key, justification: v.justification, by: v.by, at: v.at, decision: null, decidedBy: null, decidedAt: null }]));
    try { await put('programs', id, { ...stripId(p), review, req, deviations: d, netlistRev: nn.rev, netlistUpdatedAt: nn.updatedAt || null, netlistVerified: nn.status === 'verified', updatedAt: now(), history: hist('REANALYSED') }); } catch (e) { toast('שמירה נכשלה: ' + (e.code || e.message)); }
  });
  on('#submit', async () => { if (await dialog('להגיש לאישור?', '<p>אחרי ההגשה הנימוקים ננעלים, ובודק אחר יחליט על כל חריגה ועל התוכנית.</p>', 'הגש')) save({ status: 'submitted', submittedAt: now() }, 'SUBMITTED'); });
  on('#toDraft', () => save({ status: 'draft' }, 'RETURNED_TO_DRAFT'));
  on('#approve', async () => {
    const outcome = ds.outcomeIfApproved;
    const d = await dialog(outcome === 'approved' ? 'אישור תוכנית' : 'אישור עם חריגות', `<p>אתם מאשרים שהתוכנית (טביעת אצבע ${esc(p.fingerprint)}) מכסה את נטליסט מהדורה ${esc(p.netlistRev)}${ds.accepted.length ? ', עם ' + ds.accepted.length + ' חריגות מאושרות' : ''}. ההחלטה תירשם על שמכם.</p><label for="dn">הערה (רשות)</label><textarea id="dn"></textarea>`, 'אשר');
    if (!d) return;
    save({ status: outcome, decision: { outcome, by: S.me, at: now(), note: d.querySelector('#dn').value.trim(), fingerprint: p.fingerprint } }, 'APPROVED');
  });
  on('#reject', async () => {
    const d = await dialog('דחיית התוכנית', '<label for="dn">סיבה</label><textarea id="dn"></textarea>', 'דחה'); if (!d) return;
    const note = d.querySelector('#dn').value.trim(); if (!note) { toast('נדרשת סיבה'); return; }
    save({ status: 'rejected', decision: { outcome: 'rejected', by: S.me, at: now(), note } }, 'REJECTED');
  });
  on('#revoke', async () => {
    if (S.user && S.user.canEdit && !(await S.user.canEdit())) { toast('נדרשת הרשאת עורך'); return; }
    const d = await dialog('לפתוח מחדש?', '<p>האישור יבוטל והתוכנית תחזור לטיוטה. בדיקות שכבר בוצעו יישארו עם הסטטוס שהיה בזמן ביצוען.</p><label for="dn">סיבה</label><textarea id="dn"></textarea>', 'פתח מחדש'); if (!d) return;
    save({ status: 'draft', decision: null }, 'REOPENED', { note: d.querySelector('#dn').value.trim() });
  });
  on('#pdl', () => downloadHtml(programReportHtml(p, ds), `program_approval_${p.pn}_${p.fingerprint.slice(0, 8)}.html`));
}

const stripId = o => { const { id, ...rest } = o; return rest; };
function programReportHtml(p, ds) {
  const devs = p.deviations || {};
  const st = PST[p.status][0];
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>אישור תוכנית ${esc(p.pn)}</title><style>body{font:14px/1.5 Arial,sans-serif;margin:24px;max-width:900px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #bbb;padding:5px;text-align:right;vertical-align:top}th{background:#eee}.mono{font-family:monospace;direction:ltr;unicode-bidi:isolate}.st{font-size:18px;font-weight:bold;border:2px solid #111;padding:8px;margin:10px 0}</style></head><body>
<h1>דוח בדיקה ואישור תוכנית בדיקה חשמלית</h1>
<table><tr><th>מק"ט</th><td class="mono">${esc(p.pn)}</td><th>תוכנית</th><td class="mono">${esc(p.structure.program)}</td></tr>
<tr><th>טביעת אצבע</th><td class="mono">${esc(p.fingerprint)}</td><th>מקור</th><td>${esc(p.sourceFile)}</td></tr>
<tr><th>נטליסט</th><td>מהדורה ${esc(p.netlistRev)} ${p.netlistVerified ? '(מאומת)' : '(טיוטה)'}</td><th>מהדורה בתוכנית</th><td>${esc(p.structure.schemaRev)}</td></tr>
<tr><th>דרישות</th><td colspan="3">בידוד ${esc(p.req?.isoVolt ?? '—')}V / ${esc(p.req?.isoMinMohm ?? '—')}MΩ · רציפות עד ${esc(p.req?.contMaxOhm ?? '—')}Ω · טולרנס נגדים ±${esc(p.req?.resTolPct ?? '—')}% · ${esc(p.req?.source || '')}</td></tr>
<tr><th>הוכן ע"י</th><td>${esc(nameOf(p.preparedBy))} ${esc(fmtDate(p.createdAt))}</td><th>החלטה</th><td>${p.decision ? esc(PST[p.decision.outcome]?.[0]) + ' · ' + esc(nameOf(p.decision.by)) + ' · ' + esc(fmtDate(p.decision.at)) + (p.decision.note ? ' · ' + esc(p.decision.note) : '') : '—'}</td></tr></table>
<div class="st">מצב: ${esc(st)}</div>
<h2>קריטריונים</h2><table><tr><th>קריטריון</th><th>מצב</th><th>סיכום</th></tr>${p.review.criteria.map(c => `<tr><td>${esc(c.title)}</td><td>${esc(IST[c.status][0])}</td><td>${esc(c.summary || '')}</td></tr>`).join('')}</table>
<h2>חריגות ונימוקים</h2><table><tr><th>פריט</th><th>ממצא</th><th>נימוק</th><th>החלטה</th></tr>${p.review.criteria.flatMap(c => c.items.filter(i => i.status !== 'pass').map(i => { const d = devs[P.devId(i.key)] || {}; return `<tr><td class="mono">${esc(i.subject)}<br><small>${esc(c.title)}</small></td><td>${esc(IST[i.status][0])}: ${esc(i.detail)}</td><td>${esc(d.justification || '—')}<br><small>${esc(nameOf(d.by))}</small></td><td>${d.decision ? (d.decision === 'accepted' ? 'התקבל' : 'נדחה') + '<br><small>' + esc(nameOf(d.decidedBy)) + ' ' + esc(fmtDate(d.decidedAt)) + '</small>' : '—'}</td></tr>`; })).join('') || '<tr><td colspan="4">אין</td></tr>'}</table>
<p>אישור התוכנית מתייחס לטביעת האצבע לעיל בלבד. כל שינוי בתוכנית מחייב בדיקה ואישור מחדש. אישור התוכנית אינו אישור שחרור של יחידה.</p></body></html>`;
}
async function downloadHtml(html, filename) {
  filename = filename.replace(/[^\w.\-]/g, '_');
  if (S.mode === 'folder' || S.mode === 'memory') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = filename; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return; }
  if (S.downloads) { try { await S.downloads.save({ filename, data: new Blob([html], { type: 'text/html' }) }); return; } catch (e) { if (e && e.code === 'cancelled') return; } }
  try { await navigator.clipboard.writeText(html); toast('ההורדה אינה זמינה כאן — קוד הדוח הועתק.', 6000); } catch (e) { toast('לא ניתן להוריד בתצוגה זו'); }
}

// ---------------- team & folder mode ----------------
const ROLES = { inspector: 'בודק', approver: 'מאשר', admin: 'מנהל' };
function setWho() {
  const m = (S.team?.members || []).find(x => x.id === S.me);
  $('#who').innerHTML = S.mode === 'folder' && m ? `<a href="#team" style="color:inherit">${esc(m.name)} · ${esc(ROLES[m.role])}</a>` : esc(S.names[S.me] || '');
}
function vConnect(state, handle, msg) {
  view(`<h1>חיבור לתיקייה המשותפת</h1><div class="panel" style="max-width:640px">
  ${!HQAFS.supported() ? `<div class="note err">הדפדפן הזה לא תומך בעבודה עם תיקייה משותפת. פתחו את הקובץ ב־<b>Chrome</b> או ב־<b>Edge</b> במחשב.</div>` : `
  <p>כל הנתונים של הצוות נשמרים בתיקייה ברשת. בחרו את התיקייה שבה נמצא הקובץ הזה (או תיקייה ייעודית). הדפדפן יבקש אישור לקרוא ולכתוב בה.</p>
  ${msg ? `<div class="note err">${esc(msg)}</div>` : ''}
  <div class="row">${state === 'prompt' ? `<button class="acc" id="reconn">התחבר שוב ל־${esc(handle.name)}</button><button class="ghost" id="pick">בחר תיקייה אחרת</button>` : '<button class="acc" id="pick">בחר תיקייה</button>'}</div>`}
  <details style="margin-top:14px"><summary class="small">רק לנסות, בלי לשמור</summary><p class="small muted">מצב ניסיון: הנתונים נמחקים כשסוגרים את הדף.</p><button class="ghost" id="memo">פתח במצב ניסיון</button></details></div>`);
  const go = async fn => { try { S.fs = await fn(); await afterFolder(); } catch (e) { if (e.name !== 'AbortError') vConnect(state, handle, e.message || String(e)); } };
  if ($('#pick')) $('#pick').onclick = () => go(HQAFS.pick);
  if ($('#reconn')) $('#reconn').onclick = () => go(() => HQAFS.reconnect(handle));
  $('#memo').onclick = () => { S.mode = 'memory'; S.local = true; S.me = 'local'; S.role = 'admin'; refreshLocal(); route(); };
}
async function afterFolder() {
  S.team = await S.fs.team();
  const saved = (() => { try { return localStorage.getItem('hqa-me:' + S.fs.name); } catch (e) { return null; } })();
  if (saved && S.team.members.some(m => m.id === saved)) return startFolder(saved);
  vLogin();
}
function vLogin() {
  const ms = S.team.members;
  view(`<h1>מי אתם?</h1><div class="panel" style="max-width:640px">
  <p class="small muted">תיקייה: <b>${esc(S.fs.name)}</b>. הבחירה נשמרת בדפדפן הזה. זיהוי לפי שם בלבד — אין סיסמה.</p>
  ${ms.length ? `<div class="row">${ms.map(m => `<button class="ghost" data-me="${esc(m.id)}">${esc(m.name)} <span class="small muted">· ${esc(ROLES[m.role])}</span></button>`).join('')}</div><h3>לא ברשימה?</h3>` : '<p>אתם הראשונים כאן — תוגדרו כמנהלי הצוות.</p>'}
  <label for="newName">שם מלא</label><input id="newName"><div class="row" style="margin-top:10px"><button class="acc" id="addMe">הוסף אותי</button></div></div>`);
  $('#view').querySelectorAll('[data-me]').forEach(b => b.onclick = () => startFolder(b.dataset.me));
  $('#addMe').onclick = async () => {
    const name = $('#newName').value.trim(); if (!name) return;
    const team = await S.fs.team();
    const m = { id: 'u_' + uid(), name, role: team.members.length ? 'inspector' : 'admin', addedAt: now() };
    team.members.push(m); await S.fs.saveTeam(team); S.team = team; startFolder(m.id);
  };
}
function startFolder(me) {
  S.me = me; try { localStorage.setItem('hqa-me:' + S.fs.name, me); } catch (e) { }
  const m = S.team.members.find(x => x.id === me); S.role = m ? m.role : 'inspector';
  for (const x of S.team.members) S.names[x.id] = x.name;
  S.user = { canEdit: async () => S.role === 'admin', profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: (S.team.members.find(x => x.id === i) || {}).name || '' }])) };
  setWho(); $('#teamLink').hidden = false; subscribeFolder(); route();
}
async function vTeam() {
  if (S.mode !== 'folder') { view('<div class="panel empty">ניהול צוות זמין במצב תיקייה משותפת.</div>'); return; }
  S.team = await S.fs.team(); for (const x of S.team.members) S.names[x.id] = x.name;
  const admin = S.role === 'admin';
  view(`<h1>צוות</h1><div class="panel"><p class="small muted">תיקייה משותפת: <b>${esc(S.fs.name)}</b>. התפקידים קובעים מי מאשר תוכניות ומי מנהל. הזיהוי לפי שם בלבד, ולכן הוא אמצעי נוחות ומעקב — לא אבטחה.</p>
  <table class="stack"><thead><tr><th>שם</th><th>תפקיד</th><th>נוסף</th></tr></thead><tbody>${S.team.members.map(m => `<tr><td>${esc(m.name)}${m.id === S.me ? ' (אתם)' : ''}</td><td>${admin && m.id !== S.me ? `<select data-role="${esc(m.id)}">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : esc(ROLES[m.role])}</td><td>${esc(fmtDate(m.addedAt))}</td></tr>`).join('')}</tbody></table>
  ${admin ? '<h3>הוספת חבר צוות</h3><div class="row"><input id="tmName" placeholder="שם מלא" style="max-width:280px"><button id="tmAdd">הוסף</button></div>' : ''}
  <div class="row" style="margin-top:14px"><button class="ghost" id="switchUser">החלף משתמש</button></div></div>`);
  $('#view').querySelectorAll('[data-role]').forEach(sel => sel.onchange = async () => { const t = await S.fs.team(); const m = t.members.find(x => x.id === sel.dataset.role); if (m) { m.role = sel.value; await S.fs.saveTeam(t); toast('עודכן'); } });
  if ($('#tmAdd')) $('#tmAdd').onclick = async () => { const name = $('#tmName').value.trim(); if (!name) return; const t = await S.fs.team(); t.members.push({ id: 'u_' + uid(), name, role: 'inspector', addedAt: now() }); await S.fs.saveTeam(t); vTeam(); };
  $('#switchUser').onclick = () => { try { localStorage.removeItem('hqa-me:' + S.fs.name); } catch (e) { } location.reload(); };
}

// ---------------- boot ----------------
route();
(async () => {
  if (window.claude && window.claude.use) {
    const use = n => window.claude.use(n).catch(() => null);
    const [db, user, sample, downloads] = await Promise.all([use('db'), use('user'), use('sample'), use('downloads')]);
    S.db = db; S.user = user; S.sample = sample; S.downloads = downloads; S.mode = db ? 'claude' : 'memory';
    if (user) { try { S.me = await user.id(); } catch (e) { } try { const me = await user.me(); if (me) { S.names[S.me] = me.name || 'אני'; $('#who').textContent = me.name || ''; } } catch (e) { } }
    if (!S.me) S.me = 'local';
    if (db) subscribe(); else { S.local = true; refreshLocal(); }
    route(); return;
  }
  S.mode = 'folder';
  try {
    if (new URLSearchParams(location.search).has('opfs')) { S.fs = await HQAFS.opfs(); return afterFolder(); }
    if (!HQAFS.supported()) return vConnect('none');
    const r = await HQAFS.restore();
    if (r.state === 'ok') { S.fs = new HQAFS.FolderStore(r.handle); return afterFolder(); }
    vConnect(r.state, r.handle);
  } catch (e) { vConnect('none', null, e.message || String(e)); }
})();
}
