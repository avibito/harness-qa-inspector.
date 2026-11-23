/*
 * Harness QA Team — test-program review.
 * A "program" is the tester's test definition (groups, isolation kind, parameters, 4-wire limits),
 * taken from a report or program printout WITHOUT the measured values.
 * reviewProgram() checks it against a verified netlist and the P/N requirements, criterion by criterion.
 * Pure functions. Browser: window.HQAP. Node: module.exports.
 */
(function (root) {
  'use strict';
  const H = root.HQA || (typeof require !== 'undefined' ? require('./adapters.js') : null);

  const toOhm = (v, u) => v * ({ 'Ω': 1, ohm: 1, 'kΩ': 1e3, kohm: 1e3, 'MΩ': 1e6, Mohm: 1e6, 'GΩ': 1e9, Gohm: 1e9 }[u] ?? NaN);

  function programStructure(run) {
    const p = run.params || {};
    return {
      program: run.meta.program || '', schemaRev: run.meta.schemaRev || '', harnessRev: run.meta.harnessRev || '', format: run.format,
      params: {
        isoVolt: p.iso?.volt?.v ?? null, isoMinOhm: p.iso?.min ? toOhm(p.iso.min.v, p.iso.min.u) : null,
        contMaxOhm: p.cont?.max ? toOhm(p.cont.max.v, p.cont.max.u) : null, contAmp: p.cont?.amp?.v ?? null
      },
      groups: run.groups.map(g => ({ first: g.first, pins: g.pins.slice(), iso: g.iso ? g.iso.kind : 'none' })),
      fourWire: run.fourWire.map(r => ({ a: r.a, b: r.b, min: r.min ?? null, max: r.max ?? null }))
    };
  }

  // Order-independent fingerprint of the program definition (not of measured values).
  function fingerprint(st) {
    const canon = JSON.stringify({
      program: st.program, schemaRev: st.schemaRev, params: st.params,
      groups: st.groups.map(g => g.iso + ':' + g.pins.slice().sort().join(',')).sort(),
      fourWire: st.fourWire.map(r => [r.a, r.b].sort().join('~') + ':' + r.min + ':' + r.max).sort()
    });
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < canon.length; i++) { const c = canon.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2654435761); }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).toUpperCase();
  }

  const CRITERIA = [
    ['REV', 'התאמת מהדורות', 'התוכנית נבנתה לאותה מהדורת שרטוט כמו הנטליסט המאומת.'],
    ['NETS', 'כל רשת בשרטוט היא קבוצה אחת בבודק', 'בדיקת רציפות מוכיחה חיבור רק בין נקודות שבאותה קבוצה; פיצול או חוסר משמעו חיבור שלא נבדק.'],
    ['POINTS', 'כל נקודה מחווטת כלולה בתוכנית', 'נקודה שאינה בתוכנית לא נבדקת כלל.'],
    ['EXTRA', 'אין בתוכנית נקודות שאינן בשרטוט', 'נקודות עודפות הן נקודות מתקן או טעות שיוך — חייבות הצהרה.'],
    ['ISO', 'בידוד במתח גבוה לכל רשת', 'בדיקת אי־רציפות במתח נמוך אינה מחליפה בדיקת בידוד.'],
    ['SPARE', 'כל פין פנוי נבדק לבידוד', 'פין פנוי עם קצר או שאריות חוט יתגלה רק בבדיקת בידוד.'],
    ['COMP', 'רכיבים: נגדים ודיודות נבדקים עם גבולות נכונים', 'גבולות הבדיקה חייבים לכלול את הערך הנומינלי ולא להיות רחבים מהטולרנס הנדרש.'],
    ['PARAMS', 'פרמטרי הבדיקה עומדים בדרישות', 'מתח בידוד, מינימום בידוד ומקסימום רציפות לפי מסמך הדרישות.'],
    ['VISUAL', 'פריטים שאינם ניתנים לבדיקה חשמלית', 'מכוסים בבדיקה ויזואלית מתועדת.']
  ];

  function reviewProgram(nl, st, req) {
    req = req || {};
    const out = CRITERIA.map(([id, title, why]) => ({ id, title, why, items: [] }));
    const C = id => out.find(c => c.id === id);
    const item = (cid, subject, detail, status) => C(cid).items.push({ key: cid + '|' + subject, subject, detail, status });

    // REV
    if (!st.schemaRev) item('REV', 'מהדורה', 'מהדורת השרטוט אינה מופיעה בתוכנית', 'justify');
    else if (String(st.schemaRev).trim().toUpperCase() !== String(nl.rev || '').trim().toUpperCase())
      item('REV', 'מהדורה', `התוכנית: ${st.schemaRev} · הנטליסט: ${nl.rev}`, 'fail');
    else item('REV', 'מהדורה', `${st.schemaRev} = ${nl.rev}`, 'pass');

    // NETS / EXTRA via the same comparison used on runs
    const pseudoRun = { groups: st.groups.map(g => ({ first: g.first, pins: g.pins })) };
    const cmp = H.compareNets(nl, pseudoRun);
    let matched = 0;
    for (const r of cmp.rows) {
      if (r.status === 'MATCH') { matched++; continue; }
      if (r.status === 'EXTRA') item('EXTRA', r.net, r.detail, 'justify');
      else if (r.status === 'NOT_IN_DRAWING') item('EXTRA', r.pins.join(' '), r.detail, 'fail');
      else item('NETS', r.net, r.detail + ' · ' + r.pins.join(' '), 'fail');
    }
    C('NETS').summary = `${matched}/${nl.nets.length} רשתות תואמות פין־אחר־פין`;

    // POINTS: every drawing point is in a group or in a 4-wire test
    const inGroup = new Set(st.groups.flatMap(g => g.pins));
    const in4w = new Set(st.fourWire.flatMap(r => [r.a, r.b]));
    const drawPins = new Set([...nl.nets.flatMap(n => n.pins), ...(nl.resistors || []).flatMap(r => [r.a, r.b]), ...(nl.diodes || []).flatMap(d => [d.a, d.k]), ...(nl.shields || []).map(s => s.pin)]);
    let pinsOk = 0;
    for (const p of drawPins) {
      if (inGroup.has(p)) { pinsOk++; continue; }
      if (in4w.has(p)) { item('POINTS', p, 'הנקודה נבדקת רק במדידת 4 חוטים ואינה בשום קבוצה', 'justify'); continue; }
      item('POINTS', p, 'הנקודה אינה מופיעה בתוכנית', 'fail');
    }
    C('POINTS').summary = `${pinsOk}/${drawPins.size} נקודות בקבוצות`;

    // ISO
    const hvPins = new Set(st.groups.filter(g => g.iso === 'isolation').flatMap(g => g.pins));
    for (const g of st.groups) if (g.iso !== 'isolation' && g.pins.some(p => drawPins.has(p)))
      item('ISO', g.first, `הקבוצה (${g.pins.length} נקודות) נבדקת ב${g.iso === 'non-continuity' ? 'אי־רציפות' : 'ללא בדיקת בידוד'} ולא בבידוד במתח גבוה`, 'justify');
    for (const p of drawPins) if (!hvPins.has(p) && !st.groups.some(g => g.iso !== 'isolation' && g.pins.includes(p)))
      item('ISO', p, 'הנקודה אינה בשום קבוצת בידוד במתח גבוה', 'justify');
    C('ISO').summary = `${st.groups.filter(g => g.iso === 'isolation').length}/${st.groups.length} קבוצות בבידוד מתח גבוה`;

    // SPARE
    const conns = nl.connectors || {};
    if (!Object.keys(conns).length) {
      const singles = st.groups.filter(g => g.pins.length === 1 && !drawPins.has(g.pins[0])).length;
      item('SPARE', 'רשימת פינים', `לנטליסט אין שורות CONN — לא ניתן לוודא שכל הפינים הפנויים נבדקו (בתוכנית ${singles} נקודות בודדות)`, 'justify');
    } else {
      let ok = 0, total = 0;
      for (const [c, pins] of Object.entries(conns)) for (const p of pins) {
        const pin = c + '-' + p; if (drawPins.has(pin)) continue; total++;
        const g = st.groups.find(x => x.pins.includes(pin));
        if (!g) item('SPARE', pin, 'פין פנוי שאינו בתוכנית', 'fail');
        else if (g.iso !== 'isolation') item('SPARE', pin, 'פין פנוי ללא בידוד במתח גבוה', 'justify');
        else ok++;
      }
      C('SPARE').summary = `${ok}/${total} פינים פנויים בבידוד`;
    }

    // COMP
    const tol = req.resTolPct ? +req.resTolPct : null;
    for (const r of nl.resistors || []) {
      const t = st.fourWire.find(x => (x.a === r.a && x.b === r.b) || (x.a === r.b && x.b === r.a));
      const name = `${r.name} ${r.ohms}Ω`;
      if (!t) {
        const same = st.groups.find(g => g.pins.includes(r.a) && g.pins.includes(r.b));
        item('COMP', name, same ? `שני קצות הנגד באותה קבוצת רציפות (${same.first}) ואין מדידת התנגדות` : `אין מדידת התנגדות בין ${r.a} ל־${r.b}`, 'fail');
        continue;
      }
      if (t.min == null || t.max == null) { item('COMP', name, 'למדידה אין גבולות', 'fail'); continue; }
      if (!(t.min <= r.ohms && r.ohms <= t.max)) { item('COMP', name, `הערך הנומינלי ${r.ohms}Ω מחוץ לגבולות ${t.min}–${t.max}Ω`, 'fail'); continue; }
      const band = Math.max(r.ohms - t.min, t.max - r.ohms) / r.ohms * 100;
      if (tol != null && band > tol + 1e-9) item('COMP', name, `הגבולות ${t.min}–${t.max}Ω הם ±${band.toFixed(1)}% — רחבים מהטולרנס הנדרש ±${tol}%`, 'justify');
      else item('COMP', name, `גבולות ${t.min}–${t.max}Ω (±${band.toFixed(1)}%)${tol == null ? ' · לא הוגדר טולרנס נדרש' : ''}`, tol == null ? 'justify' : 'pass');
    }
    for (const d of nl.diodes || []) item('COMP', `${d.name} ${d.a}→${d.k}`, 'אין בדיקת דיודה בתוכנית (סוג וכיוון)', 'fail');
    if (!(nl.resistors || []).length && !(nl.diodes || []).length) C('COMP').summary = 'אין רכיבים בשרטוט';

    // PARAMS
    const P = st.params;
    const chk = (label, have, need, cmp, unit) => {
      if (need == null || need === '') return;
      if (have == null) item('PARAMS', label, `לא נמצא בתוכנית (נדרש ${need}${unit})`, 'fail');
      else if (!cmp(have, +need)) item('PARAMS', label, `בתוכנית ${have}${unit}, נדרש ${need}${unit}`, 'fail');
      else item('PARAMS', label, `בתוכנית ${have}${unit} · נדרש ${need}${unit}`, 'pass');
    };
    const anyReq = ['isoVolt', 'isoMinMohm', 'contMaxOhm'].some(k => req[k] != null && req[k] !== '');
    if (!anyReq) item('PARAMS', 'דרישות', `לא הוגדרו דרישות למק"ט. בתוכנית: בידוד ${P.isoVolt ?? '?'}V / ${P.isoMinOhm != null ? P.isoMinOhm / 1e6 : '?'}MΩ, רציפות עד ${P.contMaxOhm ?? '?'}Ω`, 'justify');
    chk('מתח בידוד', P.isoVolt, req.isoVolt, (a, b) => a >= b, 'V');
    chk('מינימום בידוד', P.isoMinOhm != null ? P.isoMinOhm / 1e6 : null, req.isoMinMohm, (a, b) => a >= b, 'MΩ');
    chk('מקסימום רציפות', P.contMaxOhm, req.contMaxOhm, (a, b) => a <= b, 'Ω');

    // VISUAL
    for (const s of nl.shields || []) item('VISUAL', s.pin, `שילוד ${s.name} מחובר בקצה אחד בלבד — רציפות השילוד אינה ניתנת לבדיקה חשמלית`, 'justify');
    if (!C('VISUAL').items.length) C('VISUAL').summary = 'אין פריטים';

    for (const c of out) {
      c.status = c.items.some(i => i.status === 'fail') ? 'fail' : c.items.some(i => i.status === 'justify') ? 'justify' : 'pass';
      if (!c.items.length && !c.summary) c.summary = 'תקין';
    }
    return { criteria: out, compareCount: cmp.count };
  }

  // Safe, stable id for a review item, used as the field name of its deviation record.
  function devId(key) { let h = 0x811c9dc5; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619); return 'd' + (h >>> 0).toString(36); }

  // Decision state: every non-pass item needs a justification and an approver decision.
  function decisionState(review, deviations) {
    const open = [], accepted = [], rejected = [], unjustified = [];
    for (const c of review.criteria) for (const it of c.items) {
      if (it.status === 'pass') continue;
      const d = (deviations || {})[devId(it.key)];
      if (!d || !d.justification) unjustified.push(it);
      else if (d.decision === 'accepted') accepted.push(it);
      else if (d.decision === 'rejected') rejected.push(it);
      else open.push(it);
    }
    const nonPass = open.length + accepted.length + rejected.length + unjustified.length;
    return { nonPass, open, accepted, rejected, unjustified,
      canSubmit: unjustified.length === 0,
      canApprove: unjustified.length === 0 && open.length === 0 && rejected.length === 0,
      outcomeIfApproved: nonPass ? 'approved_with_deviations' : 'approved' };
  }

  const api = { programStructure, fingerprint, reviewProgram, decisionState, devId, CRITERIA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HQAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
