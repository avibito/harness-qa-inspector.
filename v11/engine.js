/*
 * Harness QA Inspector — v11 coverage engine.
 * Pure logic, no DOM. Works in the browser (window.HarnessEngine) and in Node (module.exports).
 *
 * Inputs:
 *   drawing    { revision, approved_source, source_id, edges:[{id,a,b,kind,net,ohms?,forward?}] }
 *   mechanical { revision, approved_source, source_id, connectors:[{id, pins:[...]}], connector_pattern? }  (optional)
 *   atp        { revision, approved_source, source_id, defaults:{continuity_max?, isolation_min?, isolation_required?}, tests:[...] }
 *   results    { revision, approved_source, source_id, measurements:[{test_id,value,unit,status?,evidence_ref}] }
 *
 * The engine NEVER approves release. It classifies evidence and lists what was not tested.
 */
(function (root) {
  'use strict';

  const VERSION = '11.0';
  const CONDUCTIVE = new Set(['wire', 'shield', 'jumper']);
  const DEFAULT_CONNECTOR_PATTERN = '^(J|P|X|XS|XP|CN)\\d+[A-Z]?$';

  // ---------- helpers ----------
  const pairKey = (a, b) => [a, b].sort().join('|');
  const prefixOf = node => (String(node).includes(':') ? String(node).split(':')[0] : null);
  const pinOf = node => (String(node).includes(':') ? String(node).split(':').slice(1).join(':') : null);

  function fnv(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Normalize a resistance value to ohms. Returns null when the unit is unknown.
  // Case matters: "M" = mega, "m" = milli.
  function toOhms(value, unit) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (unit === undefined || unit === null || unit === '') return null;
    const u = String(unit).trim().replace(/Ω/g, 'ohm').replace(/\s+/g, '');
    const table = { ohm: 1, Ohm: 1, OHM: 1, ohms: 1, r: 1, R: 1,
      kohm: 1e3, kOhm: 1e3, KOhm: 1e3, Kohm: 1e3, KOHM: 1e3,
      Mohm: 1e6, MOhm: 1e6, MOHM: 1e6, Gohm: 1e9, GOhm: 1e9, GOHM: 1e9,
      mohm: 1e-3, mOhm: 1e-3 };
    return u in table ? value * table[u] : null;
  }

  // Compare measurement against test limits. Limits are in test.unit if given, otherwise in the measurement unit.
  function limitCheck(t, m, defaults) {
    let min = t.min, max = t.max;
    if (t.type === 'continuity' && max === undefined && defaults.continuity_max !== undefined) max = defaults.continuity_max;
    if (t.type === 'isolation' && min === undefined && defaults.isolation_min !== undefined) min = defaults.isolation_min;
    const limitUnit = t.unit || (t.type === 'continuity' && t.max === undefined ? defaults.continuity_unit : null)
      || (t.type === 'isolation' && t.min === undefined ? defaults.isolation_unit : null);
    const res = { min: min ?? null, max: max ?? null, unit: limitUnit || (m && m.unit) || null, defined: min !== undefined || max !== undefined, within: null, comparable: true };
    if (!m || typeof m.value !== 'number' || !Number.isFinite(m.value)) { res.within = null; return res; }
    let v = m.value, lo = min, hi = max;
    if (limitUnit && m.unit && limitUnit !== m.unit) {
      const vo = toOhms(m.value, m.unit), f = toOhms(1, limitUnit);
      if (vo === null || f === null) { res.comparable = false; res.within = null; return res; }
      v = vo; lo = min === undefined ? undefined : min * f; hi = max === undefined ? undefined : max * f;
    }
    res.within = (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
    return res;
  }

  // BFS path between two nodes over the allowed edges. Returns array of edges or null.
  function findPath(edges, start, end, skipId) {
    if (start === end) return [];
    const adj = new Map();
    for (const e of edges) {
      if (e.id === skipId) continue;
      if (!adj.has(e.a)) adj.set(e.a, []);
      if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a).push([e.b, e]); adj.get(e.b).push([e.a, e]);
    }
    const prev = new Map([[start, null]]), q = [start];
    while (q.length) {
      const n = q.shift();
      if (n === end) break;
      for (const [nx, e] of adj.get(n) || []) if (!prev.has(nx)) { prev.set(nx, [n, e]); q.push(nx); }
    }
    if (!prev.has(end)) return null;
    const path = []; let cur = end;
    while (prev.get(cur)) { const [p, e] = prev.get(cur); path.unshift(e); cur = p; }
    return path;
  }

  // Edges whose removal disconnects start from end — only these are proven by an end-to-end measurement.
  function necessaryEdges(edges, start, end) {
    const path = findPath(edges, start, end);
    if (!path) return { path: null, necessary: [], optional: [] };
    const necessary = [], optional = [];
    for (const e of path) (findPath(edges, start, end, e.id) ? optional : necessary).push(e);
    return { path, necessary, optional };
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const meta = {}, rows = [];
    let header = null;
    const lines = String(text).replace(/\r/g, '').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) {
        const m = line.slice(1).match(/^\s*([\w.]+)\s*=\s*(.*)$/);
        if (m) meta[m[1]] = m[2].trim();
        continue;
      }
      const cells = []; let cur = '', q = false;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (q) { if (c === '"' && raw[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === ',') { cells.push(cur.trim()); cur = ''; } else cur += c;
      }
      cells.push(cur.trim());
      if (!header) { header = cells.map(h => h.toLowerCase()); continue; }
      const o = {};
      header.forEach((h, i) => { if (cells[i] !== undefined && cells[i] !== '') o[h] = cells[i]; });
      rows.push(o);
    }
    return { meta, rows };
  }

  const num = v => (v === undefined || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : v));
  const bool = v => (v === undefined ? undefined : /^(true|yes|1|כן)$/i.test(String(v)));

  function metaToSource(meta) {
    const o = {};
    if (meta.revision !== undefined) o.revision = meta.revision;
    if (meta.source_id !== undefined) o.source_id = meta.source_id;
    if (meta.approved_source !== undefined) o.approved_source = bool(meta.approved_source);
    if (meta.connector_pattern !== undefined) o.connector_pattern = meta.connector_pattern;
    const d = {};
    for (const [k, v] of Object.entries(meta)) if (k.startsWith('defaults.')) d[k.slice(9)] = k.endsWith('required') ? bool(v) : num(v);
    if (Object.keys(d).length) o.defaults = d;
    return o;
  }

  // kind: drawing | mechanical | atp | results. Accepts JSON text, CSV text, or an object.
  function parseSource(kind, input) {
    if (input && typeof input === 'object') return input;
    const text = String(input || '').trim();
    if (!text) return null;
    if (text[0] === '{' || text[0] === '[') return JSON.parse(text);
    const { meta, rows } = parseCSV(text);
    const base = metaToSource(meta);
    if (kind === 'drawing') return { ...base, edges: rows.map(r => ({ id: r.id, a: r.a || r.from, b: r.b || r.to, kind: (r.kind || 'wire').toLowerCase(), net: r.net, ohms: num(r.ohms), forward: r.forward })) };
    if (kind === 'mechanical') {
      const by = new Map();
      for (const r of rows) { const c = r.connector || r.id; if (!by.has(c)) by.set(c, []); if (r.pin !== undefined) by.get(c).push(String(r.pin)); }
      return { ...base, connectors: [...by].map(([id, pins]) => ({ id, pins })) };
    }
    if (kind === 'atp') return { ...base, tests: rows.map(r => ({ id: r.id, a: r.a || r.from, b: r.b || r.to, type: (r.type || 'continuity').toLowerCase(), purpose: r.purpose, min: num(r.min), max: num(r.max), unit: r.unit, direction: r.direction, duplicate_reason: r.duplicate_reason })) };
    if (kind === 'results') return { ...base, measurements: rows.map(r => ({ test_id: r.test_id || r.id, value: num(r.value), unit: r.unit, status: r.status ? r.status.toUpperCase() : undefined, evidence_ref: r.evidence_ref || r.evidence })) };
    throw new Error('Unknown source kind: ' + kind);
  }

  // ---------- audit ----------
  const SEVERITY = {
    // blocker: a failure or contradiction; gap: something required was not tested; review: needs engineering judgement; info
    REVISION_MISMATCH: 'blocker', UNAPPROVED_SOURCES: 'review', OUT_OF_LIMIT: 'blocker', RECORDED_FAIL: 'blocker',
    STATUS_CONTRADICTS_VALUE: 'blocker', ORPHAN_ATP: 'blocker', NO_DRAWING_PATH: 'blocker', DUPLICATE_TEST_ID: 'blocker',
    DUPLICATE_RESULT: 'blocker', NODE_IN_MULTIPLE_NETS: 'blocker', PIN_NOT_IN_MECHANICAL: 'blocker', CONNECTOR_NOT_IN_MECHANICAL: 'blocker',
    COVERAGE_GAP: 'gap', UNTESTED_POINT: 'gap', MISSING_RESULT: 'gap', ISOLATION_GAP: 'gap', SPARE_PIN_UNTESTED: 'gap',
    ENGINEERING_REVIEW: 'review', END_TO_END_REVIEW: 'review', PATH_TEST_TYPE_RISK: 'review', PARALLEL_PATH: 'review',
    JUSTIFIED_REPEAT_REVIEW: 'info', UNJUSTIFIED_DUPLICATE: 'review', RESULT_WITHOUT_TEST: 'review', LIMITS_UNDEFINED: 'review',
    UNIT_NOT_COMPARABLE: 'review', MISSING_EVIDENCE: 'review', NO_MECHANICAL_SOURCE: 'info'
  };
  const sevOf = code => SEVERITY[code] || (code.startsWith('COMPONENT_') ? 'blocker' : 'review');

  function audit(input) {
    const drawing = parseSource('drawing', input.drawing);
    const atp = parseSource('atp', input.atp);
    const results = parseSource('results', input.results);
    const mechanical = input.mechanical ? parseSource('mechanical', input.mechanical) : null;
    if (!drawing || !Array.isArray(drawing.edges)) throw new Error('בשרטוט חסרה רשימת edges');
    if (!atp || !Array.isArray(atp.tests)) throw new Error('בתוכנית ATP חסרה רשימת tests');
    if (!results || !Array.isArray(results.measurements)) throw new Error('בתוצאות חסרה רשימת measurements');
    for (const e of drawing.edges) if (!e.id || !e.a || !e.b) throw new Error('מקטע ללא id/a/b בשרטוט');
    for (const t of atp.tests) if (!t.id || !t.a || !t.b) throw new Error('בדיקה ללא id/a/b בתוכנית ATP');

    const defaults = { isolation_required: true, ...(atp.defaults || {}) };
    const edges = drawing.edges.map(e => ({ ...e, kind: (e.kind || 'wire').toLowerCase() }));
    const findings = [];
    const add = (code, subject, detail, action) => findings.push({ code, severity: sevOf(code), subject, detail, action });

    // --- configuration ---
    if (drawing.revision !== atp.revision) add('REVISION_MISMATCH', 'CONFIG', `שרטוט ${drawing.revision ?? '?'} לעומת ATP ${atp.revision ?? '?'}`, 'לאמת מהדורות ושינויי תצורה');
    if (atp.revision !== results.revision) add('REVISION_MISMATCH', 'ATP↔RESULTS', `ATP ${atp.revision ?? '?'} לעומת תוצאות ${results.revision ?? '?'}`, 'לאמת מהדורות');
    if (mechanical && mechanical.revision !== undefined && drawing.revision !== undefined && mechanical.revision !== drawing.revision)
      add('REVISION_MISMATCH', 'MECH↔ELEC', `שרטוט מכני ${mechanical.revision} לעומת חשמלי ${drawing.revision}`, 'לאמת שהשרטוטים שייכים לאותה תצורה');
    const srcs = [drawing, atp, results, mechanical].filter(Boolean);
    if (srcs.some(s => s.approved_source !== true)) add('UNAPPROVED_SOURCES', 'CONFIG', 'לפחות מקור אחד אינו מסומן כמאושר', 'לצרף מסמכי מקור מאושרים');

    // --- nodes & nets ---
    const nodes = new Set(edges.flatMap(e => [e.a, e.b]));
    const nodeNet = new Map();
    for (const e of edges) for (const n of [e.a, e.b]) {
      const net = e.net || ('NET?' + e.id);
      if (nodeNet.has(n) && nodeNet.get(n) !== net) add('NODE_IN_MULTIPLE_NETS', n, `${n} משויך גם ל־${nodeNet.get(n)} וגם ל־${net}`, 'לתקן שיוך רשתות בשרטוט');
      else nodeNet.set(n, net);
    }

    // --- mechanical cross-check ---
    const pattern = new RegExp((mechanical && mechanical.connector_pattern) || drawing.connector_pattern || DEFAULT_CONNECTOR_PATTERN, 'i');
    const mechPins = new Map(); // connector -> Set(pins)
    if (mechanical && Array.isArray(mechanical.connectors)) for (const c of mechanical.connectors) mechPins.set(String(c.id), new Set((c.pins || []).map(String)));
    const isConnectorNode = n => { const p = prefixOf(n); return !!p && (mechPins.has(p) || pattern.test(p)); };
    const connectorNodes = [...nodes].filter(isConnectorNode);
    const sparePins = [];
    if (mechanical) {
      const reported = new Set();
      for (const n of connectorNodes) {
        const c = prefixOf(n), p = pinOf(n);
        if (!mechPins.has(c)) { if (!reported.has(c)) { reported.add(c); add('CONNECTOR_NOT_IN_MECHANICAL', c, `מחבר ${c} מופיע בשרטוט החשמלי ולא בשרטוט המכני`, 'לבדוק שם/קיום המחבר בשרטוט המכני'); } }
        else if (!mechPins.get(c).has(p)) add('PIN_NOT_IN_MECHANICAL', n, `פין ${p} לא קיים במחבר ${c} לפי השרטוט המכני`, 'לבדוק מספור פינים / סוג מחבר');
      }
      for (const [c, pins] of mechPins) for (const p of pins) { const n = c + ':' + p; if (!nodes.has(n)) { sparePins.push(n); nodeNet.set(n, 'SPARE:' + n); } }
    } else add('NO_MECHANICAL_SOURCE', 'CONFIG', 'לא סופק שרטוט מכני — פינים רזרביים לא נבדקים', 'לצרף רשימת מחברים ופינים מהשרטוט המכני');
    const allNodes = new Set([...nodes, ...sparePins]);

    // --- results index ---
    const testIds = new Set(atp.tests.map(t => t.id));
    const measById = new Map();
    for (const m of results.measurements) {
      if (measById.has(m.test_id)) add('DUPLICATE_RESULT', m.test_id, 'יותר מתוצאה אחת לאותה בדיקה — לא ברור איזו תקפה', 'לקבוע תוצאה מחייבת אחת');
      else measById.set(m.test_id, m);
      if (!testIds.has(m.test_id)) add('RESULT_WITHOUT_TEST', m.test_id, 'תוצאת מדידה שאינה משויכת לבדיקה בתוכנית ATP', 'לבדוק שיוך תוצאה / גרסת ATP');
    }

    // --- per test evaluation ---
    const testEval = new Map();
    const seen = new Map(), seenIds = new Set();
    for (const t of atp.tests) {
      const type = (t.type || 'continuity').toLowerCase();
      const tt = { ...t, type };
      if (seenIds.has(t.id)) add('DUPLICATE_TEST_ID', t.id, 'מזהה בדיקה כפול', 'לתקן מזהים');
      seenIds.add(t.id);
      const ev = { test: tt, valid: false, issues: [] };
      testEval.set(t.id, ev);

      const bAll = type === 'isolation' && (t.b === '*' || t.b === 'ALL');
      if (!allNodes.has(t.a) || (!bAll && !allNodes.has(t.b))) { add('ORPHAN_ATP', t.id, `${t.a} ↔ ${t.b} לא מופיע בשרטוט`, 'לבדוק שיוך בדיקה'); ev.orphan = true; continue; }
      if (!bAll) {
        const k = pairKey(t.a, t.b) + '|' + type, prev = seen.get(k);
        if (prev) add(t.duplicate_reason ? 'JUSTIFIED_REPEAT_REVIEW' : 'UNJUSTIFIED_DUPLICATE', t.id, t.duplicate_reason ? `חזרה על ${prev} עם נימוק: ${t.duplicate_reason}` : `חזרה על ${prev} ללא הצדקה`, 'לאמת כפילות ב־ATP');
        else seen.set(k, t.id);
      }

      const m = measById.get(t.id);
      if (!m) { add('MISSING_RESULT', t.id, 'אין תוצאת מדידה מקושרת', 'לצרף מדידה מזוהה'); ev.issues.push('MISSING_RESULT'); continue; }
      const numeric = typeof m.value === 'number' && Number.isFinite(m.value);
      const lc = limitCheck(tt, m, defaults);
      ev.limits = lc; ev.measurement = m;
      if (m.status === 'FAIL') { add('RECORDED_FAIL', t.id, 'המכשיר רשם FAIL', 'לעצור ולחקור'); ev.issues.push('RECORDED_FAIL'); }
      if (!numeric) ev.issues.push('NO_NUMERIC_RESULT');
      if (!m.unit) ev.issues.push('MISSING_UNIT');
      if (!m.evidence_ref) ev.issues.push('MISSING_EVIDENCE_REF');
      if (ev.issues.some(i => i.startsWith('NO_') || i.startsWith('MISSING_')) && !ev.issues.includes('RECORDED_FAIL'))
        add('MISSING_EVIDENCE', t.id, 'חסר: ' + ev.issues.join(', '), 'לצרף ערך מספרי, יחידה ומזהה ראיה');
      if (!lc.defined) { add('LIMITS_UNDEFINED', t.id, `לבדיקת ${type} לא הוגדרו גבולות (גם לא ברירת מחדל)`, 'להגדיר גבולות קבלה ב־ATP'); ev.issues.push('LIMITS_UNDEFINED'); }
      if (!lc.comparable) { add('UNIT_NOT_COMPARABLE', t.id, `יחידת מדידה ${m.unit} אינה ניתנת להשוואה ליחידת הגבול ${lc.unit}`, 'לאחד יחידות'); ev.issues.push('UNIT_NOT_COMPARABLE'); }
      if (lc.within === false) {
        add('OUT_OF_LIMIT', t.id, `מדידה ${m.value} ${m.unit || ''} מחוץ לגבולות ${lc.min ?? '—'}–${lc.max ?? '—'} ${lc.unit || ''}${m.status === 'PASS' ? ' (למרות PASS רשום)' : ''}`, 'לעצור ולחקור חריגה');
        ev.issues.push('OUT_OF_LIMIT');
      }
      ev.valid = numeric && !!m.unit && !!m.evidence_ref && lc.within === true && m.status !== 'FAIL';
    }

    // --- path analysis for continuity / resistance / diode tests ---
    const edgeById = new Map(edges.map(e => [e.id, e]));
    const sub = {
      continuity: edges.filter(e => CONDUCTIVE.has(e.kind)),
      resistance: edges.filter(e => e.kind !== 'diode'),
      diode: edges
    };
    const indirect = new Map(edges.map(e => [e.id, []]));   // proven (necessary) coverage candidates
    const parallel = new Map(edges.map(e => [e.id, []]));   // on the found path but not necessary
    const componentChecks = [];
    for (const ev of testEval.values()) {
      const t = ev.test;
      if (ev.orphan || t.type === 'isolation') continue;
      const directEdges = edges.filter(e => pairKey(e.a, e.b) === pairKey(t.a, t.b));
      if (directEdges.length) continue; // direct tests are handled in the matrix
      const full = findPath(edges, t.a, t.b);
      if (!full) { add('NO_DRAWING_PATH', t.id, 'אין מסלול בשרטוט בין נקודות הבדיקה', 'לבדוק טופולוגיה'); continue; }
      const allowed = sub[t.type] || sub.continuity;
      const na = necessaryEdges(allowed, t.a, t.b);
      if (!na.path) {
        add('PATH_TEST_TYPE_RISK', t.id, `המסלול ${full.map(e => e.id).join(' → ')} עובר דרך רכיב שאינו מתאים לבדיקת ${t.type}`, 'להתאים סוג בדיקה (התנגדות/דיודה) לרכיבים במסלול');
      } else {
        add('END_TO_END_REVIEW', t.id, `מסלול: ${na.path.map(e => e.id).join(' → ')}. מקטעים מוכחים: ${na.necessary.map(e => e.id).join(', ') || 'אין'}`, 'לבדוק התאמה, גבולות וראיות לכל דרישה');
        const diodeOk = t.type !== 'diode' || na.necessary.some(e => e.kind === 'diode' && t.direction && t.direction === e.forward);
        for (const e of na.necessary) indirect.get(e.id).push({ test: t.id, valid: ev.valid && diodeOk, path: na.path.map(x => x.id) });
        for (const e of na.optional) {
          parallel.get(e.id).push(t.id);
          for (const tw of edges) if (tw.id !== e.id && pairKey(tw.a, tw.b) === pairKey(e.a, e.b) && !parallel.get(tw.id).includes(t.id)) parallel.get(tw.id).push(t.id);
        }
        if (na.optional.length) add('PARALLEL_PATH', t.id, `מקטעים ${na.optional.map(e => e.id).join(', ')} במסלול מקביל — המדידה אינה מוכיחה אותם`, 'להוסיף בדיקה נפרדת לכל ענף מקביל');
      }
      // component evaluation along the full path
      const comps = full.filter(e => e.kind === 'resistor' || e.kind === 'diode');
      if (!comps.length) continue;
      const issues = ev.issues.filter(i => i !== 'LIMITS_UNDEFINED');
      if (comps.some(e => e.kind === 'diode')) {
        const d = comps.find(e => e.kind === 'diode');
        if (t.type !== 'diode') issues.push('DIODE_TEST_TYPE_MISMATCH');
        if (t.direction !== d.forward) issues.push('DIODE_DIRECTION_UNVERIFIED');
        if (t.min === undefined || t.max === undefined) issues.push('DIODE_LIMITS_MISSING');
      }
      if (comps.some(e => e.kind === 'resistor')) {
        if (t.type !== 'resistance') issues.push('RESISTANCE_TEST_REQUIRED');
        if (t.min === undefined || t.max === undefined) issues.push('RESISTANCE_LIMITS_MISSING');
      }
      const uniq = [...new Set(issues)];
      componentChecks.push({ test_id: t.id, components: comps.map(e => e.id), path: full.map(e => e.id), type: t.type, measurement: ev.measurement || null, limits: ev.limits || null, decision: uniq.length ? 'BLOCKED' : 'MEASUREMENT_CONSISTENT_REVIEW', issues: uniq, physical_assembly_verified: false });
      for (const i of uniq) if (['DIODE_TEST_TYPE_MISMATCH', 'DIODE_DIRECTION_UNVERIFIED', 'DIODE_LIMITS_MISSING', 'RESISTANCE_TEST_REQUIRED', 'RESISTANCE_LIMITS_MISSING'].includes(i))
        add('COMPONENT_' + i, t.id, `רכיבים ${comps.map(e => e.id).join(', ')}: ${i}`, 'לתקן בדיקת רכיב ולהשלים אימות הנדסי');
    }

    // --- edge coverage matrix ---
    const compatible = (e, t) => e.kind === 'resistor' ? t.type === 'resistance' : e.kind === 'diode' ? t.type === 'diode' && t.direction === e.forward : t.type === 'continuity' || t.type === 'resistance';
    const matrix = edges.map(e => {
      const direct = [...testEval.values()].filter(v => !v.orphan && v.test.type !== 'isolation' && pairKey(v.test.a, v.test.b) === pairKey(e.a, e.b));
      // a direct test between two points joined by parallel edges does not prove each one
      const parallelTwins = edges.filter(x => x.id !== e.id && pairKey(x.a, x.b) === pairKey(e.a, e.b));
      const comp = direct.filter(v => compatible(e, v.test));
      const valid = comp.filter(v => v.valid);
      const ind = indirect.get(e.id), indValid = ind.filter(x => x.valid);
      let state = 'COVERAGE_GAP', reason = 'אין בדיקה מתאימה עם ראיה מזוהה';
      if (valid.length && !parallelTwins.length) { state = 'DIRECT_EVIDENCE'; reason = 'בדיקה ישירה, ערך בתוך גבולות וייחוס ראיה (לא אישור שחרור)'; }
      else if (valid.length) { state = 'ENGINEERING_REVIEW'; reason = `קיים מקטע מקביל (${parallelTwins.map(x => x.id).join(', ')}) — בדיקה בין אותן נקודות אינה מוכיחה כל מקטע`; }
      else if (comp.length) { state = 'ENGINEERING_REVIEW'; reason = 'בדיקה ישירה קיימת אך ללא מדידה תקפה / מחוץ לגבולות / חסרה ראיה'; }
      else if (direct.length) { state = 'ENGINEERING_REVIEW'; reason = 'בדיקה ישירה מסוג או כיוון שאינם מתאימים לרכיב'; }
      else if (indValid.length) { state = 'INDIRECT_COVERAGE'; reason = 'המקטע הכרחי במסלול מדידה תקף — כיסוי עקיף, אינו מוכיח מיקום רכיב'; }
      else if (ind.length) { state = 'ENGINEERING_REVIEW'; reason = 'מסלול עקיף קיים, אך המדידה אינה תקפה'; }
      else if (parallel.get(e.id).length) { state = 'ENGINEERING_REVIEW'; reason = 'המקטע נמצא רק במסלול מקביל — לא הוכח'; }
      if (state === 'COVERAGE_GAP') add('COVERAGE_GAP', e.id, `${e.a} ↔ ${e.b} (${e.kind}) ללא ראיית כיסוי`, 'להוסיף בדיקה ל־ATP או ראיה חלופית');
      else if (state === 'ENGINEERING_REVIEW') add('ENGINEERING_REVIEW', e.id, reason, 'לבדוק דרישות, סוג בדיקה ותוצאות');
      return { edge: e.id, net: e.net, a: e.a, b: e.b, kind: e.kind, direct_tests: direct.map(v => v.test.id), indirect_tests: ind.map(x => x.test), parallel_tests: parallel.get(e.id), state, reason };
    });

    // --- point (pin) coverage: was each accessible point touched by a valid test? ---
    const touched = new Map(); // node -> [test ids]
    const touchedAny = new Map();
    for (const v of testEval.values()) {
      if (v.orphan) continue;
      for (const n of [v.test.a, v.test.b]) {
        if (!touchedAny.has(n)) touchedAny.set(n, []); touchedAny.get(n).push(v.test.id);
        if (v.valid) { if (!touched.has(n)) touched.set(n, []); touched.get(n).push(v.test.id); }
      }
    }
    const points = [...new Set([...connectorNodes, ...sparePins])].sort().map(n => {
      const spare = sparePins.includes(n);
      const valid = touched.get(n) || [], any = touchedAny.get(n) || [];
      const conductive = valid.filter(id => testEval.get(id).test.type !== 'isolation');
      let state = null; // spare pins are resolved after the isolation matrix
      if (!spare) state = conductive.length ? 'TESTED' : any.length ? 'TESTED_NO_VALID_EVIDENCE' : 'UNTESTED';
      if (state === 'UNTESTED') add('UNTESTED_POINT', n, `הנקודה ${n} (${nodeNet.get(n)}) לא נבדקה באף בדיקה`, 'להוסיף בדיקת רציפות לנקודה');
      return { point: n, net: nodeNet.get(n), spare, state, tests: any };
    });

    // --- isolation coverage between nets (only nets that contain an accessible point) ---
    const accessibleNets = [...new Set(points.map(p => p.net))].sort();
    const isolation = [];
    if (defaults.isolation_required) {
      const coveredPairs = new Map();
      const allCovered = new Map(); // net -> test id (one-to-all)
      for (const v of testEval.values()) {
        if (v.orphan || v.test.type !== 'isolation' || !v.valid) continue;
        const na = nodeNet.get(v.test.a);
        if (v.test.b === '*' || v.test.b === 'ALL') { allCovered.set(na, v.test.id); continue; }
        const nb = nodeNet.get(v.test.b);
        if (na === nb) continue;
        coveredPairs.set(pairKey(na, nb), v.test.id);
      }
      for (let i = 0; i < accessibleNets.length; i++) for (let j = i + 1; j < accessibleNets.length; j++) {
        const x = accessibleNets[i], y = accessibleNets[j];
        const by = coveredPairs.get(pairKey(x, y)) || allCovered.get(x) || allCovered.get(y) || null;
        isolation.push({ net_a: x, net_b: y, test: by, state: by ? 'ISOLATION_TESTED' : 'ISOLATION_GAP' });
      }
      // one finding per net (the pair is reported under its first net) to keep the list readable
      const missingBy = new Map();
      for (const p of isolation) if (p.state === 'ISOLATION_GAP') { if (!missingBy.has(p.net_a)) missingBy.set(p.net_a, []); missingBy.get(p.net_a).push(p.net_b); }
      for (const [net, others] of missingBy) add('ISOLATION_GAP', net, `לא נבדק בידוד בין ${net} לבין: ${others.join(', ')}`, 'להוסיף בדיקת בידוד (זוגית או מול כל הרשתות)');
    }
    // spare pins: tested only if every isolation pair of their net is covered
    for (const p of points) if (p.spare) {
      const rel = isolation.filter(x => x.net_a === p.net || x.net_b === p.net);
      const ok = rel.filter(x => x.state === 'ISOLATION_TESTED').length;
      p.state = !defaults.isolation_required ? 'SPARE_NOT_REQUIRED' : rel.length && ok === rel.length ? 'SPARE_ISOLATION_TESTED' : ok ? 'SPARE_ISOLATION_PARTIAL' : 'SPARE_UNTESTED';
      if (p.state === 'SPARE_UNTESTED') add('SPARE_PIN_UNTESTED', p.point, `פין רזרבי ${p.point} (לפי שרטוט מכני) ללא בדיקת בידוד`, 'להוסיף בדיקת בידוד לפין הרזרבי');
    }

    // --- stable finding ids ---
    const counts = new Map();
    for (const f of findings) {
      const base = f.code + '|' + f.subject;
      const n = counts.get(base) || 0; counts.set(base, n + 1);
      f.id = 'F-' + fnv(base + (n ? '#' + n : '')).slice(0, 6).toUpperCase();
      f.ambiguous = false;
    }
    for (const f of findings) if ((counts.get(f.code + '|' + f.subject) || 0) > 1) f.ambiguous = true;

    // --- summary & verdict ---
    const tally = (arr, key) => arr.reduce((o, x) => (o[x[key]] = (o[x[key]] || 0) + 1, o), {});
    const edgeStates = tally(matrix, 'state'), pointStates = tally(points, 'state'), sev = tally(findings, 'severity');
    const untestedPoints = points.filter(p => p.state === 'UNTESTED' || p.state === 'SPARE_UNTESTED').map(p => p.point);
    const missingResults = [...testEval.values()].filter(v => v.issues.includes('MISSING_RESULT')).map(v => v.test.id);
    const isolationGaps = isolation.filter(x => x.state === 'ISOLATION_GAP').length;
    const partialSpares = points.filter(p => p.state === 'SPARE_ISOLATION_PARTIAL').map(p => p.point);
    const coverageComplete = !edgeStates.COVERAGE_GAP && !untestedPoints.length && !missingResults.length && !isolationGaps;
    const status = !coverageComplete ? 'INCOMPLETE' : (sev.blocker ? 'BLOCKED' : 'COMPLETE_PENDING_ENGINEERING_REVIEW');

    return {
      version: VERSION, approved: false, release_approved: false,
      generated_at: new Date().toISOString(),
      sources: { drawing: pick(drawing), mechanical: mechanical ? pick(mechanical) : null, atp: pick(atp), results: pick(results) },
      verdict: {
        status, coverage_complete: coverageComplete,
        untested_points: untestedPoints, partially_tested_spares: partialSpares, missing_results: missingResults,
        coverage_gap_edges: matrix.filter(x => x.state === 'COVERAGE_GAP').map(x => x.edge),
        isolation_gaps: isolationGaps, blockers: sev.blocker || 0,
        note: 'אין בדוח זה אישור שחרור. השלמת כיסוי אינה מחליפה סקירה הנדסית.'
      },
      summary: {
        edges: matrix.length, direct_evidence: edgeStates.DIRECT_EVIDENCE || 0, indirect_coverage: edgeStates.INDIRECT_COVERAGE || 0,
        engineering_review: edgeStates.ENGINEERING_REVIEW || 0, coverage_gap: edgeStates.COVERAGE_GAP || 0,
        points: points.length, points_tested: pointStates.TESTED || 0, points_untested: untestedPoints.length,
        spare_pins: sparePins.length, net_pairs: isolation.length, isolation_gaps: isolationGaps,
        tests: atp.tests.length, findings: findings.length, by_severity: sev,
        component_checks: componentChecks.length, component_blocked: componentChecks.filter(c => c.decision === 'BLOCKED').length
      },
      matrix, points, isolation, component_checks: componentChecks, findings
    };
  }

  const pick = s => ({ revision: s.revision ?? null, source_id: s.source_id ?? null, approved_source: s.approved_source === true });

  // ---------- revalidation: compare a baseline audit with a re-audit ----------
  function compareAudits(baseline, current) {
    const key = f => f.code + '|' + f.subject;
    const rows = [];
    for (const f of baseline.findings) {
      const matches = current.findings.filter(g => key(g) === key(f));
      const dup = baseline.findings.filter(g => key(g) === key(f)).length > 1 || matches.length > 1;
      rows.push({ status: dup ? 'AMBIGUOUS_REVIEW' : matches.length ? 'PERSISTENT' : 'ABSENT_REVIEW_REQUIRED', before: f, after: matches });
    }
    for (const f of current.findings) if (!baseline.findings.some(g => key(g) === key(f))) rows.push({ status: 'NEW', before: null, after: [f] });
    const struct = r => JSON.stringify(r.matrix.map(x => [x.edge, x.a, x.b, x.kind]).sort());
    const ids = [...new Set([...baseline.matrix, ...current.matrix].map(x => x.edge))];
    const coverage = ids.map(id => ({ edge: id, before: baseline.matrix.find(x => x.edge === id)?.state || null, after: current.matrix.find(x => x.edge === id)?.state || null }))
      .filter(x => x.before !== x.after);
    return {
      version: VERSION, approved: false,
      structure_changed: struct(baseline) !== struct(current),
      verdict_before: baseline.verdict.status, verdict_after: current.verdict.status,
      counts: rows.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {}),
      rows, coverage_changes: coverage,
      note: 'היעלמות ממצא אינה סגירה — נדרש אימות ידני.'
    };
  }

  const api = { VERSION, audit, compareAudits, parseSource, parseCSV, findPath, necessaryEdges, toOhms };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HarnessEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
