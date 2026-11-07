import test from 'node:test';
import assert from 'node:assert/strict';
import {recordStock, undoStock, saveTasting, deleteTasting, consumptionEvents,
  flavorState, readBackup, mergeBackup, units} from './journal.mjs';

const bean = () => ({id: 'old-bean', values: {name: '旧豆档', weight: '250', remaining: '200.03', price: '100'}});
const note = () => ({id: 'cup-1', at: Date.now(), dose: 18.02, rating: 4,
  text: '柑橘与蜂蜜', taste: {acidity: 3, sweetness: 4, bitterness: 1, body: 2}, params: {equipment: 'V60'}});

test('legacy stock supports fractional consumption and idempotent event retries', () => {
  const old = bean();
  const updated = recordStock(old, 182.01, 'deduction', {id: 'event-1'});
  assert.equal(updated.values.remaining, '182.01');
  assert.equal(updated.history[0].grams, 18.02);
  assert.equal(old.values.remaining, '200.03');
  assert.equal(recordStock(updated, 182.01, 'deduction', {id: 'event-1'}), updated);
});

test('undo restores a delta against current stock and excludes voided consumption', () => {
  const first = recordStock(bean(), 182.01, 'deduction', {id: 'event-1'});
  const second = recordStock(first, 162.01, 'deduction', {id: 'event-2'});
  const undone = undoStock(second, 'event-1');
  assert.equal(undone.values.remaining, '180.03');
  assert.equal(consumptionEvents([undone]).length, 1);
  assert.throws(() => undoStock(undone, 'event-1'));
});

test('inventory correction does not contribute to consumption', () => {
  const corrected = recordStock(bean(), 190, 'adjustment');
  assert.equal(corrected.history.length, 1);
  assert.equal(consumptionEvents([corrected]).length, 0);
  assert.throws(() => recordStock(bean(), -1, 'adjustment'));
  assert.throws(() => recordStock(bean(), 251, 'adjustment'));
});

test('tasting create, edit and delete each reconcile the exact stock delta', () => {
  const draft = note();
  const saved = saveTasting(bean(), draft, null);
  assert.equal(saved.values.remaining, '182.01');
  assert.equal(consumptionEvents([saved])[0].unitCost, .4);
  const edited = saveTasting(saved, {...draft, dose: 20.01}, saved.tastings[0].updatedAt);
  assert.equal(edited.values.remaining, '180.02');
  assert.equal(edited.tastings.length, 1);
  assert.equal(edited.history.length, 1);
  assert.equal(units(edited.history[0].before) - units(edited.history[0].after), units(edited.history[0].grams));
  const removed = deleteTasting(edited, draft.id, edited.tastings[0].updatedAt);
  assert.equal(removed.values.remaining, '200.03');
  assert.equal(removed.tastings.length, 0);
  assert.equal(consumptionEvents([removed]).length, 0);
});

test('stale edits, duplicate saves and excessive use are rejected without modifying source', () => {
  const saved = saveTasting(bean(), note(), null);
  assert.throws(() => saveTasting(saved, note(), null));
  assert.throws(() => saveTasting(saved, {...note(), dose: 400}, saved.tastings[0].updatedAt));
  assert.throws(() => deleteTasting(saved, 'cup-1', 1));
  assert.equal(saved.values.remaining, '182.01');
});

test('zero-dose tasting leaves stock unchanged and does not invent consumption', () => {
  const saved = saveTasting(bean(), {...note(), dose: 0}, null);
  assert.equal(saved.values.remaining, '200.03');
  assert.equal(consumptionEvents([saved]).length, 0);
});

test('undo and tasting removal cannot restore stock above the current capacity', () => {
  const saved = saveTasting(bean(), note(), null);
  const changed = {...saved, values: {...saved.values, weight: '185'}};
  assert.throws(() => deleteTasting(changed, 'cup-1', saved.tastings[0].updatedAt));
});

test('missing prices remain unknown instead of becoming zero-cost consumption', () => {
  const old = bean(); delete old.values.price;
  const saved = saveTasting(old, note(), null);
  assert.equal(consumptionEvents([saved])[0].unitCost, null);
});

test('flavor phases respect explicit zero resting days, frozen and transit states', () => {
  const now = new Date('2026-11-07T12:00:00+08:00');
  assert.equal(flavorState({roastDate:'2026-11-06'}, now).key, 'resting');
  assert.equal(flavorState({roastDate:'2026-11-06',rest:'0'}, now).key, 'ready');
  assert.equal(flavorState({roastDate:'2026-01-01'}, now).key, 'past');
  assert.equal(flavorState({storage:'冷冻'}, now).key, 'frozen');
  assert.equal(flavorState({storage:'在途'}, now).key, 'transit');
  assert.equal(flavorState({roastDate:'2026-02-30'}, now).key, 'unknown');
});

test('full backups round trip records and merge twice without duplication', () => {
  const saved = saveTasting(bean(), note(), null);
  const restored = readBackup(JSON.stringify({format:'doudang',version:1,records:[saved]}));
  assert.equal(restored[0].tastings[0].text, '柑橘与蜂蜜');
  const first = mergeBackup([], restored);
  assert.equal(mergeBackup(first, restored).length, 1);
  assert.equal(units(first[0].values.remaining), 18201);
});

test('backup conflicts preserve both records, repeated import does not multiply copies', () => {
  const incoming = readBackup(JSON.stringify([bean()]));
  const changed = {...bean(), values:{...bean().values, remaining:'50'}};
  const merged = mergeBackup([changed], incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].values.remaining, '50');
  assert.equal(merged[1].values.remaining, '200.03');
  assert.equal(mergeBackup(merged, incoming).length, 2);
});

test('invalid backup versions, inventory, unsafe images and broken note links are rejected', () => {
  assert.throws(() => readBackup('{'));
  assert.throws(() => readBackup(JSON.stringify({format:'doudang',version:2,records:[]})));
  assert.throws(() => readBackup(JSON.stringify([{...bean(), values:{...bean().values,remaining:'999'}}])));
  assert.throws(() => readBackup(JSON.stringify([{...bean(),cover:'javascript:alert(1)'}])));
  const saved = saveTasting(bean(), note(), null);
  saved.history[0].grams = 19;
  assert.throws(() => readBackup(JSON.stringify([saved])));
});
