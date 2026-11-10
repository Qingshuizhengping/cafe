import test from 'node:test';
import assert from 'node:assert/strict';
import {RATIO_PRESETS, waterForDose, doseForWater, rescaleStages, referenceTimeline,
  stageState, formatClock, pourRate} from './brewing.mjs';

test('粉水比换算在水和粉之间互为逆运算', () => {
  assert.equal(waterForDose(15, 16), 240);
  assert.equal(doseForWater(240, 16), 15);
  assert.equal(waterForDose(18, 15), 270);
  assert.equal(RATIO_PRESETS.length, 3);
});

test('粉水比换算拒绝无效输入', () => {
  assert.throws(() => waterForDose(0, 16), /粉量/);
  assert.throws(() => doseForWater(-1, 16), /总水量/);
  assert.throws(() => waterForDose(15, 0), /粉水比/);
  assert.throws(() => doseForWater(240, 31), /粉水比/);
});

test('等比缩放保持各段单调且末段等于总水量', () => {
  const stages = [{end: 30, water: 30}, {end: 90, water: 140}, {end: 150, water: 225}];
  const scaled = rescaleStages(stages, 225, 300);
  assert.equal(scaled.at(-1).water, 300);
  assert.deepEqual(scaled.map(stage => stage.end), [30, 90, 150]);
  for (let i = 1; i < scaled.length; i += 1) assert.ok(scaled[i].water >= scaled[i - 1].water);
  assert.equal(scaled[0].water, 40);
  assert.throws(() => rescaleStages(stages, 0, 300), /总水量/);
});

test('参考时间轴按累计水量占比分摊，末段取总时长', () => {
  const timeline = referenceTimeline([{end: 30, water: 30}, {end: 90, water: 150}, {end: 150, water: 300}], 150);
  assert.deepEqual(timeline.map(item => item.end), [15, 75, 150]);
  assert.equal(referenceTimeline([{end: 10, water: 100}], 0)[0].end, 10);
});

test('分段状态机在末段之后进入完成态', () => {
  const stages = [{end: 30, water: 30}, {end: 90, water: 140}];
  assert.deepEqual(stageState(stages, 0), {index: 0, remaining: 30, water: 30, done: false});
  assert.deepEqual(stageState(stages, 45), {index: 1, remaining: 45, water: 140, done: false});
  assert.deepEqual(stageState(stages, 200), {index: -1, remaining: 0, water: 140, done: true});
});

test('计时与注水速率格式化', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(95.8), '01:35');
  assert.equal(formatClock(-4), '00:00');
  assert.equal(pourRate([{end: 120, water: 240}]), 2);
  assert.equal(pourRate([]), 0);
});
