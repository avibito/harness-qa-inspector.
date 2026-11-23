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
  netlists: [], runs: [], cases: [], names: {}, local: false, draft: {}, newRun: null };
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
const mem = { netlists: new Map(), runs: new Map(), runData: new Map(), cases: new Map() };
async function put(col, id, data) {
  if (S.db) { await S.db.doc(col + '/' + id).set(data); }
  else { mem[col].set(id, data); refreshLocal(); }
}
async function patch(col, id, data) {
  if (S.db) await S.db.doc(col + '/' + id).update(data);
  else { mem[col].set(id, { ...mem[col].get(id), ...data }); refreshLocal(); }
}
async function getDoc(col, id) {
  if (S.db) { const s = await S.db.doc(col + '/' + id).get(); return s.exists ? s.data() : null; }
  return mem[col].get(id) || null;
}
function refreshLocal() {
  S.netlists = [...mem.netlists].map(([id, d]) => ({ id, ...d }));
  S.runs = [...mem.runs].map(([id, d]) => ({ id, ...d })).sort((a, b) => b.createdAt < a.createdAt ? -1 : 1);
  S.cases = [...mem.cases].map(([id, d]) => ({ id, ...d }));
  liveRender();
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
  watch(S.db.collection('cases'), 'cases', (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---------------- routing ----------------
const liveViews = new Set(['home', 'netlists', 'findings', 'history']);
function route() {
  const h = (location.hash || '#home').slice(1);
  const [v, ...rest] = h.split('-'); const arg = rest.join('-');
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.getAttribute('href') === '#' + v);
  S.view = v; S.arg = arg;
  ({ home: vHome, run: arg ? vRunResult : vRunNew, netlists: vNetlists, netlist: vNetlistEdit, findings: vFindings, history: vHistory }[v] || vHome)(arg);
  window.scrollTo(0, 0);
}
function liveRender() {
  if (!(liveViews.has(S.view) || (S.view === 'run' && (S.arg || !(S.newRun && S.newRun.run))))) return;
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
  ${S.local ? '<div class="note err">אין חיבור למאגר המשותף בתצוגה זו — הנתונים יישמרו רק עד סגירת הדף.</div>' : ''}
  <h1>בדיקת שלמות כיסוי לרתמות</h1>
  <div class="panel"><div class="row" style="justify-content:space-between">
    <p style="margin:0;max-width:62ch">משווים דוח של מכשיר הבדיקה מול נטליסט מאומת של השרטוט, ומקבלים מה נבדק, מה לא נבדק כלל, ואילו רשתות אינן תואמות.</p>
    <a class="btn" href="#run" style="text-decoration:none;background:var(--acc);color:#fff">בדיקה חדשה</a></div>
    <div class="kpis">
      <div class="kpi"><strong>${last30}</strong>בדיקות ב־30 יום</div>
      <div class="kpi"><strong class="${open ? 't-bad' : 't-ok'}">${open}</strong>ממצאים פתוחים</div>
      <div class="kpi"><strong>${ver}/${S.netlists.length}</strong>נטליסטים מאומתים</div>
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
PN: C6AH0000C
REV: C
CONN PB1: 1-78, BK        # רשימת פינים במחבר (רשות — מאפשר בדיקת פינים פנויים)
E28: JU1-27, JU1-12, PG1-21   # רשת דרך פיצול
W1: PB1-5, PB1-43             # חוט בין שתי נקודות
R R1 3.48: JU1-49, JU1-50     # נגד
D D1: X1-1, X2-3              # דיודה (אנודה ראשונה)
SH DATA_SHIELD: PB1-31        # שילוד בקצה אחד`;

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
  <div class="panel" id="aiPanel"><h2>חילוץ מהשרטוט בעזרת Claude</h2>
    <p class="small muted">מעלים PDF או צילום של השרטוט. כל גיליון נחתך לאריחים ו־Claude מתמלל את החיבורים. התוצאה היא טיוטה — חובה לאשר כל רשת מול השרטוט.</p>
    <div class="grid">
      <div><label for="drawFile">קובץ שרטוט (PDF / PNG / JPG)</label><input type="file" id="drawFile" accept=".pdf,image/png,image/jpeg"></div>
      <div><label for="rot">סיבוב</label><select id="rot"><option value="0">ללא</option><option value="90">90° עם כיוון השעון</option><option value="270">90° נגד כיוון השעון</option><option value="180">180°</option></select></div>
      <div><label for="hint">הערה ל־Claude (רשות)</label><input id="hint" placeholder="למשל: E = פיצול, BK = גוף המחבר"></div>
    </div>
    <div class="thumbs" id="thumbs"></div>
    <div class="row"><button id="aiGo" class="acc" disabled>חלץ נטליסט</button><button id="aiStop" class="ghost" hidden>עצור</button><span id="aiStatus" class="small muted"></span></div>
  </div>
  <div class="panel"><h2>נטליסט</h2>
    <details><summary>פורמט</summary><pre class="mono small" style="white-space:pre-wrap">${esc(NLF_HELP)}</pre></details>
    <textarea id="nlf" class="code" spellcheck="false">${esc(n.text)}</textarea>
    <div id="parseInfo" class="small"></div></div>
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
    try { await put('netlists', docId, data); $('#saveMsg').textContent = 'נשמר ' + fmtDate(now()); S.draft.netlist = null; if (isNew) location.hash = 'netlist-' + docId; }
    catch (e) { toast(e.code === 'quota_exceeded' ? 'המאגר מלא — יש למחוק נתונים ישנים' : 'השמירה נכשלה: ' + (e.code || e.message)); }
  };
  $('#saveDraft').onclick = () => save(false);
  $('#saveVerified').onclick = async () => { if (await dialog('לשמור כמאומת?', `<p>אתם מאשרים שכל ${ed.items.length} הרשתות נבדקו מול השרטוט. האישור יירשם על שמכם.</p>`, 'שמור כמאומת')) save(true); };
  if ($('#dup')) $('#dup').onclick = () => { S.draft.netlist = { pn: n.pn, rev: '', title: n.title, text: n.text.replace(/^REV:.*$/m, 'REV: '), status: 'draft' }; location.hash = 'netlist-new'; };
  setupAI(ed);
  reparse();
}

// ----- AI extraction from drawing -----
async function setupAI(ed) {
  const box = $('#aiPanel');
  if (!S.sample) { box.innerHTML = '<h2>חילוץ מהשרטוט</h2><p class="muted small">חילוץ בעזרת Claude אינו זמין בתצוגה זו. אפשר להקליד את הנטליסט ידנית.</p>'; return; }
  let lim = null; try { lim = await S.sample.limits(); } catch (e) { }
  if (!lim || !lim.images) { box.innerHTML = '<h2>חילוץ מהשרטוט</h2><p class="muted small">שליחת תמונות ל־Claude אינה זמינה בתצוגה זו. אפשר להקליד את הנטליסט ידנית.</p>'; return; }
  let sheets = [];
  const render = async () => {
    const f = $('#drawFile').files[0]; if (!f) return;
    $('#aiStatus').textContent = 'מעבד קובץ…'; sheets = [];
    const rot = +$('#rot').value;
    try {
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
      $('#thumbs').innerHTML = ''; sheets.forEach((c, i) => { const im = document.createElement('img'); im.alt = 'גיליון ' + (i + 1); im.src = c.toDataURL('image/jpeg', .5); $('#thumbs').append(im); });
      $('#aiStatus').textContent = `${sheets.length} גיליונות. בדקו בתמונות שהכיתוב קריא ולא הפוך — אם לא, שנו סיבוב.`;
      $('#aiGo').disabled = false;
    } catch (e) { $('#aiStatus').textContent = 'לא ניתן לקרוא את הקובץ: ' + (e.message || e); }
  };
  $('#drawFile').onchange = render; $('#rot').onchange = render;
  let ctl = null;
  $('#aiStop').onclick = () => ctl && ctl.abort();
  $('#aiGo').onclick = async () => {
    if ($('#nlf').value.trim() && !(await dialog('להחליף את הנטליסט הקיים?', '<p>הטקסט הנוכחי יוחלף בתוצאת החילוץ.</p>', 'החלף'))) return;
    $('#aiGo').disabled = true; $('#aiStop').hidden = false; const results = [];
    try {
      for (let i = 0; i < sheets.length; i++) {
        const tiles = await tile(sheets[i], Math.min(lim.images.maxCount || 6, 12));
        $('#aiStatus').textContent = `גיליון ${i + 1}/${sheets.length}: Claude קורא ${tiles.length} אריחים… (עשוי לקחת דקה-שתיים)`;
        ctl = new AbortController();
        const r = await S.sample.json(H.aiNetlistPrompt(i + 1, tiles.length, $('#hint').value.trim()), { images: tiles, modelTier: 'complex', signal: ctl.signal });
        results.push(r);
      }
      const out = H.aiNetlistToNLF(results, { pn: $('#pn').value.trim(), rev: $('#rev').value.trim(), title: $('#title').value.trim() });
      $('#nlf').value = out.text;
      if (!$('#pn').value && /PN: (.+)/.test(out.text)) $('#pn').value = out.text.match(/PN: (.+)/)[1].trim();
      if (!$('#rev').value && /REV: (.+)/.test(out.text)) $('#rev').value = out.text.match(/REV: (.+)/)[1].trim();
      $('#nlf').dispatchEvent(new Event('input'));
      $('#aiStatus').textContent = `החילוץ הסתיים. ${out.notes.length ? out.notes.length + ' קטעים לא ודאיים סומנו. ' : ''}עברו על כל רשת מול השרטוט לפני אימות.`;
    } catch (e) {
      $('#aiStatus').textContent = e.code === 'cancelled' ? 'נעצר.' : e.code === 'not_granted' ? 'לא ניתן אישור להשתמש ב־Claude.' : e.code === 'rate_limited' ? 'הגעתם למגבלת שימוש — נסו שוב מאוחר יותר.' : e.code === 'invalid_json' ? 'התשובה לא התקבלה בפורמט תקין — נסו שוב או גיליון אחד בכל פעם.' : 'החילוץ נכשל: ' + (e.code || e.message);
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
// engine ids -> the names inspectors use (PB1:31 -> PB1-31, @E28 -> פיצול E28, W181 -> its two ends)
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
<tr><th>הופק</th><td>${esc(fmtDate(r.createdAt))}</td><th>הערה</th><td>${esc(r.note)}</td></tr></table>
<div class="v">הכרעה: ${esc(v[0])}</div>
<p>${r.compareCount?.MATCH || 0}/${total} רשתות תואמות · נקודות שלא נבדקו: ${r.verdict.untested_points.length} · זוגות ללא בידוד: ${r.verdict.isolation_gaps} · חסמים: ${r.verdict.blockers}</p>
${r.compareRows.length ? `<h2>רשתות שאינן תואמות</h2><table><tr><th>רשת</th><th>מצב</th><th>פירוט</th></tr>${r.compareRows.map(x => `<tr><td class="mono">${esc(x.net)}</td><td>${esc(CMP[x.status]?.[0] || x.status)}</td><td>${esc(x.detail)}</td></tr>`).join('')}</table>` : '<p>כל הרשתות תואמות.</p>'}
${r.reportWarnings?.length ? `<h2>הערות מתוך דוח הבודק</h2><ul>${r.reportWarnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<h2>ממצאים</h2><table><tr><th>חומרה</th><th>נושא</th><th>פירוט</th><th>פעולה</th></tr>${rows.map(f => `<tr><td>${esc(SEV[f.severity])}<br><small>${esc(codeHe(f.code))}</small></td><td class="mono">${esc(f.subject)}</td><td>${esc(f.detail)}</td><td>${esc(f.action)}</td></tr>`).join('')}</table>
<p><b>אין בדוח זה אישור שחרור.</b> כיסוי שלם הוא תנאי לסקירה הנדסית ואינו מחליף אותה.</p>
<div class="sig"><div>בודק: ____________ תאריך: ______</div><div>מאשר: ____________ תאריך: ______</div></div></body></html>`;
}
async function downloadReport(r) {
  const html = reportHtml(r), filename = `harness_report_${r.pn}_${r.serial}.html`.replace(/[^\w.\-]/g, '_');
  if (S.downloads) { try { await S.downloads.save({ filename, data: new Blob([html], { type: 'text/html' }) }); return; } catch (e) { if (e && e.code === 'cancelled') return; } }
  try { await navigator.clipboard.writeText(html); toast('ההורדה אינה זמינה כאן — קוד הדוח הועתק. הדביקו לקובץ ‎.html ופתחו בדפדפן להדפסה.', 6000); }
  catch (e) { toast('לא ניתן להוריד בתצוגה זו'); }
}

// ---------------- boot ----------------
route();
(async () => {
  const use = n => (window.claude && window.claude.use) ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
  const [db, user, sample, downloads] = await Promise.all([use('db'), use('user'), use('sample'), use('downloads')]);
  S.db = db; S.user = user; S.sample = sample; S.downloads = downloads;
  if (user) { try { S.me = await user.id(); } catch (e) { } try { const me = await user.me(); if (me) { S.names[S.me] = me.name || 'אני'; $('#who').textContent = me.name || ''; } } catch (e) { } }
  if (!S.me) S.me = 'local';
  if (db) subscribe(); else { S.local = true; refreshLocal(); }
  route();
})();
}
