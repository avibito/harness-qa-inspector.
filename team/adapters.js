/*
 * Harness QA Team — adapters.
 *  - pdfToLines(pdfjsLib, bytes): PDF text -> lines (rebuilt by y/x position)
 *  - testers: registry of tester-report parsers -> common "TesterRun"
 *  - netlist text format (NLF) <-> engine drawing
 *  - compareNets(netlist, run): pin-membership comparison drawing vs tester groups
 *  - runToEngine(run): TesterRun -> engine ATP + results
 * Pure functions (no DOM). Works in browser (window.HQA) and Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- pin naming ----------
  // Accept "J3-5", "J3:5", "pb1 - 5". Connector ids may contain "_" (J_AUX). Last "-" or ":" splits.
  function normPin(s) {
    const t = String(s || '').trim().replace(/\s*[-:]\s*(?=[^-:]*$)/, '-');
    const m = t.match(/^(.+)-([^-]+)$/);
    if (!m) return null;
    return m[1].toUpperCase() + '-' + m[2].toUpperCase();
  }
  const toNode = p => p.replace(/-(?=[^-]*$)/, ':');   // J3-5 -> J3:5
  const fromNode = n => n.replace(/:(?=[^:]*$)/, '-');
  const connOf = p => p.replace(/-[^-]*$/, '');
  const pinNum = p => p.replace(/^.*-/, '');

  // natural sort for pins: J3-2 < J3-10 < J3-BK
  function pinCmp(a, b) {
    const ca = connOf(a), cb = connOf(b);
    if (ca !== cb) return ca < cb ? -1 : 1;
    const na = pinNum(a), nb = pinNum(b), ia = parseInt(na, 10), ib = parseInt(nb, 10);
    if (!isNaN(ia) && !isNaN(ib) && ia !== ib) return ia - ib;
    if (isNaN(ia) !== isNaN(ib)) return isNaN(ia) ? 1 : -1;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  // ---------- PDF -> lines ----------
  async function pdfToLines(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) out.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s.trim()).join(' '));
      out.push('');
    }
    return { lines: out, pages: doc.numPages };
  }

  // ---------- tester report parsers ----------
  const UNIT = { 'Ω': 'ohm', 'ohm': 'ohm', 'kΩ': 'kohm', 'MΩ': 'Mohm', 'GΩ': 'Gohm', 'mΩ': 'mohm' };
  const clean = s => String(s).replace(/^[-•\s]+/, '').replace(/\s+/g, ' ').trim();

  // French tester log: "Programme de tests porté le", groups "Continuité + Test d'Isolement / inférieurs B(x) ... (y) - BON"
  const frenchLog = {
    id: 'fr-continuite-isolement',
    name: 'דוח בודק בצרפתית (Programme de tests / Continuité + Isolement)',
    detect: lines => {
      const t = lines.slice(0, 80).join('\n');
      return /Programme de tests/i.test(t) || /Continuit[ée] \+ Test/i.test(lines.join('\n').slice(0, 20000));
    },
    parse(lines) {
      const run = { format: this.id, meta: {}, params: {}, groups: [], nonContinuity: [], fourWire: [], overall: null, warnings: [] };
      let section = 1, cur = null, comment = null, paramCtx = null, paramCount = { cont: 0 };
      for (const raw of lines) {
        const s = clean(raw);
        if (!s || /^\d\d\/\d\d\/\d\d \[[\d:]+\]\s+Page \d+$/.test(s)) continue;
        let m;
        if ((m = s.match(/R[ée]f[ée]rence programme\s*:\s*(\S+)/i))) run.meta.program = m[1];
        if ((m = s.match(/Indice sch[ée]ma [ée]l[ée]ctrique\s*:\s*(\S+)/i))) run.meta.schemaRev = m[1];
        if ((m = s.match(/Indice dossier toron\s*:\s*(\S+)/i))) run.meta.harnessRev = m[1];
        if ((m = s.match(/Programme de tests port[ée] le\s*:\s*(\S+)/i))) run.meta.programDate = m[1];
        if ((m = s.match(/^(\d\d\/\d\d\/\d\d) \[([\d:]+)\]/))) run.meta.runDate = m[1] + ' ' + m[2];
        if (/^Param[èe]tres d'Isolement/i.test(s)) { paramCtx = 'iso'; continue; }
        if (/^Param[èe]tres de Continuit[ée]/i.test(s)) { paramCtx = 'cont' + (paramCount.cont++ ? '2' : ''); continue; }
        if (/^Param[èe]tres de R[ée]sistance 4 fils/i.test(s)) { paramCtx = 'r4'; continue; }
        if (paramCtx && (m = s.match(/^(R[ée]sistance minimum|R[ée]sistance maximum|Tension d'isolement|Courant de test)\s*=\s*([\d.]+)\s*(\S*)/i))) {
          const key = { 'résistance minimum': 'min', 'resistance minimum': 'min', 'résistance maximum': 'max', 'resistance maximum': 'max', "tension d'isolement": 'volt', 'courant de test': 'amp' }[m[1].toLowerCase()];
          run.params[paramCtx] = run.params[paramCtx] || {};
          run.params[paramCtx][key] = { v: parseFloat(m[2]), u: m[3] };
          continue;
        }
        if (/^Non-continuit[ée] entre groupes/i.test(s)) section = 2;
        if ((m = s.match(/^test (E.*)$/i))) { comment = m[1]; continue; }
        if (section === 1 && (m = s.match(/^Continuit[ée] \+ Test (d'Isolement|de Non-Continuit[ée]) \/ inf[ée]rieurs [AB]\(([^)]+)\)(?: \.\.\. \(([^)]+)\))? - (\S+)/i))) {
          cur = { first: normPin(m[2]), last: m[3] ? normPin(m[3]) : null, isoKind: /Isolement/i.test(m[1]) ? 'isolation' : 'non-continuity', result: m[4].toUpperCase(), pins: [normPin(m[2])], cont: [], iso: null, comment };
          run.groups.push(cur); comment = null; continue;
        }
        if ((m = s.match(/^(Isolement|Non-continuit[ée])\s+A\(([^)]+)\)\s+B\[\.\.\.\]\s+R\s*([=<>])\s*([\d.]+)\s*(\S+)/i)) && section === 1 && cur) {
          cur.iso = { kind: /Isolement/i.test(m[1]) ? 'isolation' : 'non-continuity', op: m[3], v: parseFloat(m[4]), u: UNIT[m[5]] || m[5] };
          continue;
        }
        if ((m = s.match(/^Continuit[ée]\s+A\(([^)]+)\)\s+B\(([^)]+)\)\s+R\s*([=<>])\s*([\d.]+)\s*(\S+)/i)) && cur && section === 1) {
          const a = normPin(m[1]), b = normPin(m[2]);
          cur.cont.push({ a, b, op: m[3], v: parseFloat(m[4]), u: UNIT[m[5]] || m[5] });
          if (!cur.pins.includes(b)) cur.pins.push(b);
          continue;
        }
        if ((m = s.match(/^Non-continuit[ée] entre groupes [AB]\(([^)]+)\)(?: \.\.\. \(([^)]+)\))? - (\S+)/i))) {
          run.nonContinuity.push({ first: normPin(m[1]), last: m[2] ? normPin(m[2]) : null, result: m[3].toUpperCase() }); continue;
        }
        if ((m = s.match(/^Mesure de R[ée]sistance 4 fils A\(([^)]+)\) B\(([^)]+)\) - R\s*=\s*([\d.]+)\s*(\S+)/i))) {
          const lim = run.params.r4 || {};
          run.fourWire.push({ a: normPin(m[1]), b: normPin(m[2]), v: parseFloat(m[3]), u: UNIT[m[4]] || m[4], min: lim.min?.v, max: lim.max?.v }); continue;
        }
        if (/^TEST (BON|MAUVAIS|KO|ECHEC)/i.test(s)) run.overall = s.toUpperCase();
        if (/MAUVAIS|D[ÉE]FAUT|ECHEC/i.test(s) && !/^TEST/i.test(s)) run.warnings.push(s);
      }
      // consistency checks inside the report itself
      const byFirst = new Map(run.groups.map(g => [g.first, g]));
      for (const nc of run.nonContinuity) {
        const g = byFirst.get(nc.first);
        if (!g) run.warnings.push(`קבוצה ${nc.first} מופיעה בבדיקת אי-רציפות אך לא בבדיקת רציפות`);
        else if ((nc.last || null) !== (g.last || null)) run.warnings.push(`קבוצה ${nc.first}: סיום שונה בין רציפות (${g.last}) לאי-רציפות (${nc.last})`);
      }
      for (const g of run.groups) {
        if (!g.iso) run.warnings.push(`קבוצה ${g.first}: לא נמצאה שורת בידוד`);
        else if (g.iso.kind !== 'isolation') run.warnings.push(`קבוצה ${g.first}: נבדקה באי-רציפות (${g.iso.op}${g.iso.v} ${g.iso.u}) במקום בידוד במתח גבוה`);
        if (g.result !== 'BON') run.warnings.push(`קבוצה ${g.first}: תוצאה ${g.result}`);
      }
      return run;
    }
  };

  // Generic CSV: one row per measurement. Columns: group,a,b,type(continuity|isolation|resistance),value,unit,status,min,max
  const genericCsv = {
    id: 'generic-csv',
    name: 'CSV כללי (group,a,b,type,value,unit,status,min,max)',
    detect: lines => /^\s*group\s*,\s*a\s*,\s*b\s*,\s*type/i.test(lines[0] || ''),
    parse(lines) {
      const run = { format: this.id, meta: {}, params: {}, groups: [], nonContinuity: [], fourWire: [], overall: null, warnings: [] };
      const head = lines[0].split(',').map(h => h.trim().toLowerCase());
      const byName = new Map();
      for (const ln of lines.slice(1)) {
        if (!ln.trim() || ln.startsWith('#')) { const m = ln.match(/^#\s*(\w+)\s*=\s*(.*)$/); if (m) run.meta[m[1]] = m[2].trim(); continue; }
        const c = ln.split(',').map(x => x.trim()); const r = {}; head.forEach((h, i) => r[h] = c[i]);
        const type = (r.type || '').toLowerCase(), a = normPin(r.a), b = r.b === '*' ? '*' : normPin(r.b);
        const st = (r.status || 'PASS').toUpperCase();
        if (type === 'resistance') { run.fourWire.push({ a, b, v: parseFloat(r.value), u: r.unit || 'ohm', min: r.min ? +r.min : undefined, max: r.max ? +r.max : undefined, status: st }); continue; }
        let g = byName.get(r.group);
        if (!g) { g = { first: a, last: null, isoKind: 'isolation', result: 'BON', pins: [a], cont: [], iso: null, comment: r.group }; byName.set(r.group, g); run.groups.push(g); }
        if (st !== 'PASS' && st !== 'BON') g.result = st;
        if (type === 'continuity') { g.cont.push({ a, b, op: '=', v: parseFloat(r.value), u: r.unit || 'ohm' }); if (!g.pins.includes(b)) g.pins.push(b); }
        if (type === 'isolation') g.iso = { kind: 'isolation', op: '=', v: parseFloat(r.value), u: r.unit || 'Mohm' };
      }
      return run;
    }
  };

  const testers = [frenchLog, genericCsv];
  function parseTester(lines, formatId) {
    const t = formatId ? testers.find(x => x.id === formatId) : testers.find(x => x.detect(lines));
    if (!t) return null;
    return t.parse(lines);
  }

  // Prompt for unknown formats: Claude converts the text into the generic CSV above.
  function aiTesterPrompt(text) {
    return `You convert an electrical harness tester report into CSV. Output ONLY CSV, no commentary.
Header: group,a,b,type,value,unit,status,min,max
Rules:
- A "group" is a set of points the tester treats as one connected net. Use the group's first point as the group name.
- For every continuity measurement between two points write one row type=continuity (a = reference point, b = other point).
- For the group's insulation/isolation measurement write one row type=isolation with b=* and the measured value.
- For 4-wire / resistance measurements write type=resistance with min and max limits if stated.
- Points are written CONNECTOR-PIN (e.g. J3-5). value is the number only; unit one of ohm,kohm,Mohm,Gohm. status PASS or FAIL as reported.
- Do not invent rows. If a value is shown as ">5 GΩ" write 5 and Gohm.
Report text:
"""
${text.slice(0, 200000)}
"""`;
  }

  // ---------- netlist text format (NLF) ----------
  // Lines:
  //   # comment         |  PN: HX-1000   |  REV: C   |  TITLE: Main harness
  //   CONN J3: 1-78, BK            connector pin list (optional; enables unused-pin checks)
  //   S1: J1-1, J1-2, J2-1   a net (splice or signal name), pins joined together
  //   R R1 3.48: J1-9, J1-10     resistor between two pins (ohms)
  //   D D1: X1-1, X2-3              diode, anode first
  //   SH DATA_SHIELD: J3-12        single-ended shield (other end not on a pin)
  function parseNLF(text) {
    const nl = { pn: '', rev: '', title: '', connectors: {}, nets: [], resistors: [], diodes: [], shields: [], errors: [] };
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      let m;
      if ((m = line.match(/^(PN|P\/N|REV|TITLE)\s*:\s*(.*)$/i))) { nl[{ pn: 'pn', 'p/n': 'pn', rev: 'rev', title: 'title' }[m[1].toLowerCase()]] = m[2].trim(); return; }
      if ((m = line.match(/^CONN\s+(\S+)\s*:\s*(.*)$/i))) {
        const id = m[1].toUpperCase(), pins = [];
        for (const tok of m[2].split(/[,\s]+/).filter(Boolean)) {
          const r = tok.match(/^(\d+)-(\d+)$/);
          if (r) for (let k = +r[1]; k <= +r[2]; k++) pins.push(String(k)); else pins.push(tok.toUpperCase());
        }
        nl.connectors[id] = [...new Set([...(nl.connectors[id] || []), ...pins])];
        return;
      }
      const head = line.split(':')[0], body = line.slice(head.length + 1);
      if (!line.includes(':')) { nl.errors.push(`שורה ${i + 1}: חסר ':'`); return; }
      const pins = body.split(/[,;]+/).map(s => s.trim()).filter(Boolean).map(s => ({ raw: s, pin: normPin(s) }));
      const bad = pins.filter(p => !p.pin);
      if (bad.length) { nl.errors.push(`שורה ${i + 1}: נקודה לא תקינה ${bad.map(b => b.raw).join(', ')}`); return; }
      const P = pins.map(p => p.pin);
      if ((m = head.match(/^R\s+(\S+)\s+([\d.]+)\s*$/i))) { if (P.length !== 2) nl.errors.push(`שורה ${i + 1}: נגד צריך 2 נקודות`); else nl.resistors.push({ name: m[1], ohms: +m[2], a: P[0], b: P[1] }); return; }
      if ((m = head.match(/^D\s+(\S+)\s*$/i))) { if (P.length !== 2) nl.errors.push(`שורה ${i + 1}: דיודה צריכה 2 נקודות`); else nl.diodes.push({ name: m[1], a: P[0], k: P[1] }); return; }
      if ((m = head.match(/^SH\s+(\S+)\s*$/i))) { for (const p of P) nl.shields.push({ name: m[1], pin: p }); return; }
      const name = head.trim();
      if (!name) { nl.errors.push(`שורה ${i + 1}: חסר שם רשת`); return; }
      const ex = nl.nets.find(n => n.name === name);
      if (ex) ex.pins = [...new Set([...ex.pins, ...P])]; else nl.nets.push({ name, pins: [...new Set(P)], line: i + 1 });
    });
    // merge nets that share a pin (a pin belongs to exactly one net)
    const seen = new Map();
    for (const n of nl.nets) for (const p of n.pins) {
      if (seen.has(p) && seen.get(p) !== n) {
        const o = seen.get(p);
        nl.errors.push(`הנקודה ${p} מופיעה גם ב־${o.name} וגם ב־${n.name} — אוחדו לרשת אחת`);
        o.pins = [...new Set([...o.pins, ...n.pins])]; o.name = o.name + '+' + n.name; n.pins.forEach(x => seen.set(x, o)); n.pins = [];
      } else seen.set(p, n);
    }
    nl.nets = nl.nets.filter(n => n.pins.length);
    return nl;
  }

  function formatNLF(nl) {
    const out = [];
    if (nl.pn) out.push('PN: ' + nl.pn);
    if (nl.rev) out.push('REV: ' + nl.rev);
    if (nl.title) out.push('TITLE: ' + nl.title);
    out.push('');
    for (const [c, pins] of Object.entries(nl.connectors || {})) out.push(`CONN ${c}: ${compressPins(pins)}`);
    if (Object.keys(nl.connectors || {}).length) out.push('');
    for (const n of nl.nets) out.push(`${n.name}: ${n.pins.slice().sort(pinCmp).join(', ')}`);
    for (const r of nl.resistors || []) out.push(`R ${r.name} ${r.ohms}: ${r.a}, ${r.b}`);
    for (const d of nl.diodes || []) out.push(`D ${d.name}: ${d.a}, ${d.k}`);
    for (const s of nl.shields || []) out.push(`SH ${s.name}: ${s.pin}`);
    return out.join('\n') + '\n';
  }
  function compressPins(pins) {
    const nums = pins.filter(p => /^\d+$/.test(p)).map(Number).sort((a, b) => a - b), other = pins.filter(p => !/^\d+$/.test(p));
    const parts = []; let i = 0;
    while (i < nums.length) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`); i = j + 1; }
    return [...parts, ...other].join(', ');
  }

  // netlist -> engine drawing (+ mechanical when connectors are listed or derivable)
  function netlistToEngine(nl, extraPins) {
    const edges = []; let i = 0;
    const E = (a, b, kind, extra) => edges.push({ id: 'W' + String(++i).padStart(3, '0'), a, b, kind, ...extra });
    for (const n of nl.nets) {
      const pins = n.pins.map(toNode);
      if (pins.length === 2) E(pins[0], pins[1], 'wire', { net: n.name });
      else if (pins.length > 2) for (const p of pins) E(p, '@' + n.name, 'wire', { net: n.name });
      else E(pins[0], '@' + n.name + '~open', 'shield', { net: n.name });
    }
    const netOf = p => (nl.nets.find(n => n.pins.includes(p)) || {}).name;
    for (const r of nl.resistors || []) E(toNode(r.a), toNode(r.b), 'resistor', { ohms: r.ohms, net: netOf(r.a) || netOf(r.b) || ('NET_' + r.a) });
    for (const d of nl.diodes || []) E(toNode(d.a), toNode(d.k), 'diode', { forward: toNode(d.a) + '>' + toNode(d.k), net: netOf(d.a) || ('NET_' + d.a) });
    for (const s of nl.shields || []) E(toNode(s.pin), '@' + s.name + '~open', 'shield', { net: netOf(s.pin) || s.name });
    // nets for resistor/diode-only pins
    for (const e of edges) if (!e.net) e.net = 'NET_' + e.a;
    const drawing = { revision: nl.rev || null, approved_source: !!nl.verified, source_id: `${nl.pn || '?'} REV ${nl.rev || '?'}`, edges };
    // connectors: declared, else derived from drawing pins + tester points
    let connectors = nl.connectors && Object.keys(nl.connectors).length ? nl.connectors : null, derived = false;
    if (!connectors) {
      derived = true; connectors = {};
      const all = new Set([...edges.flatMap(e => [e.a, e.b]).filter(x => x.includes(':') && !x.startsWith('@')).map(fromNode), ...(extraPins || [])]);
      for (const p of all) (connectors[connOf(p)] = connectors[connOf(p)] || []).push(pinNum(p));
    }
    const mechanical = { revision: nl.rev || null, approved_source: !derived && !!nl.verified, source_id: derived ? 'DERIVED (drawing pins + tester points)' : 'netlist CONN lines', connectors: Object.entries(connectors).map(([id, pins]) => ({ id, pins })) };
    return { drawing, mechanical, derivedConnectors: derived };
  }

  // TesterRun -> engine ATP + results. Isolation "inférieurs": group i is tested against all groups after it.
  function runToEngine(run, opts) {
    opts = opts || {};
    const isoMin = run.params.iso?.min?.v ?? 100, isoUnit = UNIT[run.params.iso?.min?.u] || 'Mohm';
    const contMax = run.params.cont?.max?.v ?? opts.contMax ?? 3;
    const tests = [], meas = [];
    const G = run.groups;
    G.forEach((g, gi) => {
      const st = g.result === 'BON' || g.result === 'PASS' ? 'PASS' : 'FAIL';
      g.cont.forEach((c, j) => {
        const id = `C${gi}.${j}`;
        tests.push({ id, a: toNode(c.a), b: toNode(c.b), type: 'continuity', purpose: 'segment' });
        meas.push({ test_id: id, value: c.v, unit: c.u, status: st, evidence_ref: `group ${g.first}` });
      });
    });
    const reps = G.map(g => toNode(g.first));
    G.forEach((g, gi) => {
      const hv = g.iso && g.iso.kind === 'isolation';
      const st = g.result === 'BON' || g.result === 'PASS' ? 'PASS' : 'FAIL';
      const targets = opts.isolationAll ? G.map((_, j) => j).filter(j => j !== gi) : G.map((_, j) => j).filter(j => j > gi);
      for (const gj of targets) {
        const id = `I${gi}.${gj}`;
        tests.push({ id, a: reps[gi], b: reps[gj], type: 'isolation' });
        if (hv) meas.push({ test_id: id, value: g.iso.v, unit: g.iso.u, status: st, evidence_ref: `iso ${g.first}` });
        else if (g.iso) meas.push({ test_id: id, status: st, evidence_ref: `non-continuity ${g.iso.op}${g.iso.v}${g.iso.u} ${g.first} (not HV isolation)` });
      }
    });
    run.fourWire.forEach((r, k) => {
      const id = `R${k}`;
      tests.push({ id, a: toNode(r.a), b: toNode(r.b), type: 'resistance', purpose: 'end_to_end', min: r.min, max: r.max, unit: 'ohm' });
      meas.push({ test_id: id, value: r.v, unit: r.u, status: r.status || 'PASS', evidence_ref: '4-wire' });
    });
    const atp = { revision: run.meta.schemaRev || null, approved_source: false, source_id: run.meta.program || run.format,
      defaults: { continuity_max: contMax, continuity_unit: 'ohm', isolation_min: isoMin, isolation_unit: isoUnit, isolation_required: true }, tests };
    const results = { revision: run.meta.schemaRev || null, approved_source: false, source_id: (run.meta.program || '') + ' ' + (run.meta.runDate || ''), measurements: meas };
    return { atp, results };
  }

  // Pin-membership comparison: each drawing net vs the tester group holding its pins.
  function compareNets(nl, run) {
    const drawNets = nl.nets.map(n => ({ name: n.name, pins: new Set(n.pins) }));
    // resistors join two nets electrically for the tester only if it grouped them — keep separate here
    const grpOf = new Map();
    run.groups.forEach((g, i) => g.pins.forEach(p => grpOf.set(p, i)));
    const rows = [];
    const usedGroups = new Set();
    for (const n of drawNets) {
      const gs = [...new Set([...n.pins].map(p => grpOf.get(p)).filter(x => x !== undefined))];
      const missing = [...n.pins].filter(p => !grpOf.has(p));
      gs.forEach(g => usedGroups.add(g));
      let status, detail = '';
      if (!gs.length) { status = 'NOT_TESTED'; detail = 'אף נקודה ברשת לא נבדקה'; }
      else if (gs.length > 1) { status = 'SPLIT'; detail = 'הרשת מפוצלת בין ' + gs.length + ' קבוצות בבודק: ' + gs.map(g => run.groups[g].pins.join(' ')).join(' | '); }
      else {
        const gp = new Set(run.groups[gs[0]].pins);
        const extra = [...gp].filter(p => !n.pins.has(p));
        if (missing.length) { status = 'PARTIAL'; detail = 'נקודות שלא נבדקו: ' + missing.join(', '); }
        else if (extra.length) { status = 'EXTRA'; detail = 'בקבוצת הבודק נקודות שאינן ברשת בשרטוט: ' + extra.join(', '); }
        else status = 'MATCH';
      }
      if (gs.length && missing.length && status !== 'PARTIAL') detail += (detail ? ' · ' : '') + 'לא נבדקו: ' + missing.join(', ');
      rows.push({ net: n.name, pins: [...n.pins].sort(pinCmp), groups: gs.map(g => run.groups[g].first), status, detail });
    }
    // tester groups with >1 pin that map to no drawing net
    const drawPins = new Set(drawNets.flatMap(n => [...n.pins]));
    run.groups.forEach((g, i) => {
      if (usedGroups.has(i)) return;
      if (g.pins.length > 1) rows.push({ net: '—', pins: g.pins.slice().sort(pinCmp), groups: [g.first], status: 'NOT_IN_DRAWING', detail: 'קבוצה מחוברת בבודק שאינה קיימת בשרטוט' });
    });
    const singles = run.groups.filter(g => g.pins.length === 1 && !drawPins.has(g.pins[0])).map(g => g.pins[0]);
    const count = rows.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {});
    return { rows, singles, count };
  }

  // ---------- AI netlist extraction prompt (per sheet, image tiles) ----------
  function aiNetlistPrompt(sheetNo, tileCount, hint) {
    return `These ${tileCount} images are overlapping tiles (left-to-right, top-to-bottom) of ONE sheet (sheet ${sheetNo}) of an electrical wiring diagram of a cable harness.
Your job: transcribe its connectivity exactly. Accuracy matters more than completeness — if you cannot read something, list it under "uncertain" instead of guessing.
Conventions: connectors are boxes with an id above (e.g. J1, P2, J_AUX) and numbered pin cells. Splices are small circles labelled E<number>. Twisted pairs are drawn with dashed ovals (they do NOT connect wires). A shield that ends in a short open pigtail is single-ended.
${hint ? 'Context from the user: ' + hint + '\n' : ''}Reply with ONLY one JSON object:
{"title_block":{"pn":"","rev":"","sheet":""},
 "nets":[{"name":"S1 or signal name","pins":["J1-1","J2-1"]}],
 "resistors":[{"name":"R1","ohms":3.48,"a":"J1-9","b":"J1-10"}],
 "diodes":[{"name":"D1","anode":"X-1","cathode":"Y-2"}],
 "single_end_shields":[{"name":"DATA_SHIELD","pin":"J3-12"}],
 "uncertain":["short description of anything unreadable or ambiguous"]}
Every net lists ALL connector pins that are electrically joined (through wires and splices), written CONNECTOR-PIN. Name a net after its splice if it has one, else after its signal name.`;
  }
  function aiNetlistToNLF(results, meta) {
    const nl = { pn: meta.pn || '', rev: meta.rev || '', title: meta.title || '', connectors: {}, nets: [], resistors: [], diodes: [], shields: [], errors: [] };
    const notes = [];
    for (const r of results) {
      if (!r) continue;
      if (!nl.pn && r.title_block?.pn) nl.pn = String(r.title_block.pn);
      if (!nl.rev && r.title_block?.rev) nl.rev = String(r.title_block.rev);
      for (const n of r.nets || []) {
        const pins = (n.pins || []).map(normPin).filter(Boolean);
        if (pins.length) nl.nets.push({ name: String(n.name || pins[0]).replace(/[:#,]/g, '_'), pins });
      }
      for (const x of r.resistors || []) { const a = normPin(x.a), b = normPin(x.b); if (a && b) nl.resistors.push({ name: String(x.name || 'R'), ohms: +x.ohms || 0, a, b }); }
      for (const x of r.diodes || []) { const a = normPin(x.anode), k = normPin(x.cathode); if (a && k) nl.diodes.push({ name: String(x.name || 'D'), a, k }); }
      for (const x of r.single_end_shields || []) { const p = normPin(x.pin); if (p) nl.shields.push({ name: String(x.name || 'SH').replace(/[:#,]/g, '_'), pin: p }); }
      for (const u of r.uncertain || []) notes.push(String(u));
    }
    // merge nets sharing pins
    const text = formatNLF(nl);
    const merged = parseNLF(text);
    return { text: (notes.length ? notes.map(n => '# לא ודאי: ' + n.replace(/\n/g, ' ')).join('\n') + '\n' : '') + formatNLF(merged), notes, mergeNotes: merged.errors };
  }

  const api = { normPin, toNode, fromNode, pinCmp, pdfToLines, testers, parseTester, aiTesterPrompt, parseNLF, formatNLF, netlistToEngine, runToEngine, compareNets, aiNetlistPrompt, aiNetlistToNLF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HQA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
