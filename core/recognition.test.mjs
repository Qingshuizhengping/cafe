import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecognition, normalizeBean, normalizeComponents, gramsValue} from './recognition.mjs';

test('single object, multiple objects, model envelopes and fenced JSON share one parser', () => {
  for (const raw of [
    '{"name":"阿洛","weight":60}',
    '```json\n{"beans":[{"name":"阿洛","capacity":"60g"}]}\n```',
    '[{"name":"阿洛","weight":60}]',
    '识别结果如下： {"name":"阿洛","weight":60} 完成',
  ]) {
    const beans = parseRecognition(raw);
    assert.equal(beans.length, 1);
    assert.equal(beans[0].fields.name, '阿洛');
    assert.equal(beans[0].fields.weight, '60');
    assert.equal(beans[0].fields.remaining, '60');
  }
});

test('balanced extraction preserves braces and escaped quotes in names', () => {
  const beans = parseRecognition(
    '结果 ' + JSON.stringify({name: '批次 {A} "特别版"', weight: 250}) + ' 结束',
  );
  assert.equal(beans[0].fields.name, '批次 {A} "特别版"');
});

test('unit conversion handles kg and oz, rejects ambiguous quantities', () => {
  assert.equal(gramsValue('0.25 kg'), '250');
  assert.equal(gramsValue('8oz'), '226.8');
  assert.equal(gramsValue('海拔 2000m'), '');
  assert.equal(gramsValue('-1g'), '');
  assert.equal(gramsValue('Infinity'), '');
});

test('explicit remaining weight survives, invalid remaining does not silently become full stock', () => {
  assert.equal(normalizeBean({name: '豆', weight: 250, remaining: 45}).fields.remaining, '45');
  const invalid = normalizeBean({name: '豆', weight: 250, remaining: 300});
  assert.equal(invalid.fields.remaining, undefined);
  assert(invalid.warnings.some((value) => value.includes('余量')));
});

test('dates, prices, roast levels and flavor arrays are normalized independently', () => {
  const {fields} = normalizeBean({
    name: '豆',
    roastDate: '2026/2/3',
    price: '￥80.50',
    roastLevel: '中浅烘焙',
    flavor: ['花香', '蜂蜜'],
  });
  assert.equal(fields.roastDate, '2026-02-03');
  assert.equal(fields.price, '80.5');
  assert.equal(fields.roast, '中浅烘');
  assert.equal(fields.flavors, '花香、蜂蜜');
  assert.equal(normalizeBean({name: '豆', roastDate: '2026-02-30'}).fields.roastDate, undefined);
  assert.equal(normalizeBean({name: '豆', roastDate: '10/16'}).fields.roastDate, undefined);
});

test('multiple beans stay separate and blend components preserve their structured fields', () => {
  const beans = parseRecognition({
    beans: [
      {
        name: '拼配',
        weight: 500,
        blendComponents: [
          {
            percentage: 40,
            country: '巴西',
            estate: 'A庄园',
            process: '日晒',
            variety: ['波旁', '卡杜艾'],
          },
          {
            percentage: 60,
            origin: '埃塞俄比亚',
            estate: 'B Washing Station',
            process: '水洗',
            variety: 74158,
          },
        ],
      },
      {name: '单品', weight: 60},
    ],
  });
  assert.equal(beans.length, 2);
  const parts = JSON.parse(beans[0].fields.components);
  assert.equal(parts[0].farm, 'A庄园');
  assert.equal(parts[1].station, 'B Washing Station');
  assert.equal(parts[1].farm, undefined);
  assert.equal(parts[1].variety, '74158');
  assert.equal(beans[0].fields.country, '巴西');
  assert.equal(normalizeComponents(beans[0].fields.components).length, 2);
});

test('unreliable empty fields are not invented, malformed component structures are rejected', () => {
  assert.deepEqual(parseRecognition('{"beans":[]}'), []);
  assert.deepEqual(parseRecognition('{}'), []);
  assert.equal(normalizeBean({name: 'unknown', weight: 60}).fields.name, undefined);
  assert.throws(() => parseRecognition('invalid json'));
  assert.throws(() => normalizeComponents(['巴西', '水洗']));
  assert.throws(() =>
    normalizeComponents([
      {origin: 'A', percentage: 60},
      {origin: 'B', percentage: 60},
    ]),
  );
});
