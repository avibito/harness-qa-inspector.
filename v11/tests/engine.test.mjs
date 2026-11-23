// Run: node v11/tests/engine.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const here = new URL('..', import.meta.url);
const demo = JSON.parse(readFileSync(new URL('samples/demo.json', here), 'utf8'));
const csv = n => readFileSync(new URL('samples/' + n, here), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); }
}
const state = (r, id) => r.matrix.find(x => x.edge === id).state;
const has = (r, code, subject) => r.findings.some(f => f.code === code && (subject === undefined || f.subject === subject));

const r = E.audit(demo);

console.log('Demo audit');
test('never approves release', () => { assert.equal(r.approved, false); assert.equal(r.release_approved, false); });
test('demo is INCOMPLETE', () => assert.equal(r.verdict.status, 'INCOMPLETE'));
test('direct evidence on E01, E02, E03, E05', () => ['E01', 'E02', 'E03', 'E05'].forEach(id => assert.equal(state(r, id), 'DIRECT_EVIDENCE')));
test('E04 indirect via end-to-end T04 (necessary edge)', () => assert.equal(state(r, 'E04'), 'INDIRECT_COVERAGE'));
test('diode path tested as continuity is a gap + component blocked', () => {
  ['E06', 'E07', 'E08'].forEach(id => assert.equal(state(r, id), 'COVERAGE_GAP'));
  assert.ok(has(r, 'COMPONENT_DIODE_TEST_TYPE_MISMATCH', 'T06'));
  assert.ok(has(r, 'PATH_TEST_TYPE_RISK', 'T06'));
});
test('PASS recorded but out of limit is flagged (T07=110Ω vs 95–105)', () => {
  assert.ok(has(r, 'OUT_OF_LIMIT', 'T07'));
  ['E09', 'E10', 'E11'].forEach(id => assert.equal(state(r, id), 'ENGINEERING_REVIEW'));
});
test('parallel wires E13/E14 are NOT proven by end-to-end T09', () => {
  assert.equal(state(r, 'E12'), 'INDIRECT_COVERAGE');
  assert.equal(state(r, 'E13'), 'ENGINEERING_REVIEW');
  assert.equal(state(r, 'E14'), 'ENGINEERING_REVIEW');
  assert.ok(has(r, 'PARALLEL_PATH', 'T09'));
});
test('untested points J3:3 and J4:3 are listed', () => assert.deepEqual(r.verdict.untested_points, ['J3:3', 'J4:3']));
test('spare pins from mechanical drawing detected', () => {
  assert.deepEqual(r.points.filter(p => p.spare).map(p => p.point), ['J1:3', 'J2:3', 'J3:1']);
  assert.deepEqual(r.verdict.partially_tested_spares, ['J1:3', 'J2:3', 'J3:1']);
});
test('orphan ATP, result without test, unjustified duplicate', () => {
  assert.ok(has(r, 'ORPHAN_ATP', 'T99'));
  assert.ok(has(r, 'RESULT_WITHOUT_TEST', 'T50'));
  assert.ok(has(r, 'UNJUSTIFIED_DUPLICATE', 'T08'));
  assert.ok(has(r, 'JUSTIFIED_REPEAT_REVIEW', 'T03B'));
});
test('isolation: unit conversion (0.2 GΩ ≥ 100 MΩ) and one-to-all test', () => {
  const p = r.isolation.find(x => x.net_a === 'NET-D' && x.net_b === 'NET-R');
  assert.equal(p.state, 'ISOLATION_TESTED');
  assert.ok(r.isolation.filter(x => x.net_a === 'NET-A' || x.net_b === 'NET-A').every(x => x.state === 'ISOLATION_TESTED'));
});
test('finding ids are stable across runs', () => assert.deepEqual(E.audit(demo).findings.map(f => f.id), r.findings.map(f => f.id)));

console.log('CSV input');
test('CSV sources produce the same verdict and matrix as JSON', () => {
  const rc = E.audit({ drawing: csv('drawing.csv'), mechanical: csv('mechanical.csv'), atp: csv('atp.csv'), results: csv('results.csv') });
  assert.deepEqual(rc.verdict, r.verdict);
  assert.deepEqual(rc.matrix, r.matrix);
  assert.deepEqual(rc.findings.map(f => f.id), r.findings.map(f => f.id));
});
test('CSV quoted fields with commas', () => {
  const p = E.parseCSV('id,note\n1,"a, b ""c"""\n');
  assert.equal(p.rows[0].note, 'a, b "c"');
});

console.log('Engine rules');
test('units: M = mega, m = milli', () => { assert.equal(E.toOhms(1, 'MΩ'), 1e6); assert.equal(E.toOhms(1, 'mohm'), 1e-3); assert.equal(E.toOhms(1, 'xyz'), null); });
test('duplicate result for the same test is a blocker', () => {
  const d = clone(demo); d.results.measurements.push({ test_id: 'T01', value: 5, unit: 'ohm', evidence_ref: 'X' });
  const x = E.audit(d); assert.ok(has(x, 'DUPLICATE_RESULT', 'T01'));
});
test('recorded FAIL is a blocker and not evidence', () => {
  const d = clone(demo); d.results.measurements.find(m => m.test_id === 'T01').status = 'FAIL';
  d.atp.tests = d.atp.tests.filter(t => t.id !== 'T08');
  const x = E.audit(d); assert.ok(has(x, 'RECORDED_FAIL', 'T01')); assert.equal(state(x, 'E01'), 'ENGINEERING_REVIEW');
});
test('continuity without any limit -> LIMITS_UNDEFINED', () => {
  const d = clone(demo); delete d.atp.defaults.continuity_max;
  assert.ok(has(E.audit(d), 'LIMITS_UNDEFINED', 'T01'));
});
test('pin not in mechanical drawing', () => {
  const d = clone(demo); d.mechanical.connectors.find(c => c.id === 'J5').pins = ['1'];
  assert.ok(has(E.audit(d), 'PIN_NOT_IN_MECHANICAL', 'J5:2'));
});
test('without mechanical source: info finding, no spare pins', () => {
  const d = clone(demo); delete d.mechanical;
  const x = E.audit(d); assert.ok(has(x, 'NO_MECHANICAL_SOURCE')); assert.equal(x.summary.spare_pins, 0);
});
test('full coverage scenario reaches COMPLETE_PENDING_ENGINEERING_REVIEW (never approved)', () => {
  const d = {
    mechanical: { revision: 'A', approved_source: true, connectors: [{ id: 'J1', pins: ['1', '2'] }, { id: 'J2', pins: ['1', '2'] }] },
    drawing: { revision: 'A', approved_source: true, edges: [{ id: 'E1', a: 'J1:1', b: 'J2:1', kind: 'wire', net: 'N1' }, { id: 'E2', a: 'J1:2', b: 'J2:2', kind: 'wire', net: 'N2' }] },
    atp: { revision: 'A', approved_source: true, defaults: { continuity_max: 1, isolation_min: 100, isolation_unit: 'Mohm' }, tests: [
      { id: 'T1', a: 'J1:1', b: 'J2:1', type: 'continuity' }, { id: 'T2', a: 'J1:2', b: 'J2:2', type: 'continuity' }, { id: 'T3', a: 'J1:1', b: 'J1:2', type: 'isolation' }] },
    results: { revision: 'A', approved_source: true, measurements: [
      { test_id: 'T1', value: 0.1, unit: 'ohm', evidence_ref: 'M1' }, { test_id: 'T2', value: 0.1, unit: 'ohm', evidence_ref: 'M2' }, { test_id: 'T3', value: 1, unit: 'Gohm', evidence_ref: 'M3' }] }
  };
  const x = E.audit(d);
  assert.equal(x.verdict.status, 'COMPLETE_PENDING_ENGINEERING_REVIEW');
  assert.equal(x.verdict.coverage_complete, true);
  assert.equal(x.approved, false);
});

console.log('Revalidation');
test('repair T07 -> OUT_OF_LIMIT absent (review required), structure unchanged', () => {
  const d = clone(demo); const m = d.results.measurements.find(x => x.test_id === 'T07'); m.value = 100; m.evidence_ref = 'SYNTH-RETEST-T07';
  const c = E.compareAudits(r, E.audit(d));
  const row = c.rows.find(x => x.before && x.before.code === 'OUT_OF_LIMIT');
  assert.equal(row.status, 'ABSENT_REVIEW_REQUIRED');
  assert.equal(c.structure_changed, false);
  assert.ok(c.coverage_changes.some(x => x.edge === 'E10' && x.after === 'INDIRECT_COVERAGE'));
});
test('structure change is detected', () => {
  const d = clone(demo); d.drawing.edges.push({ id: 'E99', a: 'J1:3', b: 'J2:3', kind: 'wire', net: 'NET-Z' });
  assert.equal(E.compareAudits(r, E.audit(d)).structure_changed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
