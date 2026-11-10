import test from 'node:test';
import assert from 'node:assert/strict';
import {crc16Modbus, buildFrame, readFrame, splitFrames, decodeFrame, decodeWeight,
  parseAdvertisement, resampleSamples, flowFromSamples, pourToWater, formatRatio, formatGrams, formatDuration} from './scale.mjs';

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');

test('CRC16/MODBUS 与原版 ble.c.d() 一致', () => {
  assert.equal(crc16Modbus(Uint8Array.from([0xa5, 0x5a, 0x03, 0x01, 0x00, 0x00])), 0x6711);
});

test('读请求帧等于逆向出的 a5 5a 02 op 00 00 crc（CRC 大端）', () => {
  const frame = readFrame(0x01);
  assert.equal(hex(frame), 'a5 5a 02 01 00 00 9b 10');
  assert.equal(hex(buildFrame(0x01)), 'a5 5a 03 01 00 00 67 11');
  assert.equal(frame[2], 2);
  assert.equal(splitFrames(frame).frames[0].crcOk, true);
});

test('写帧带 payload 且长度字段是大端', () => {
  const frame = buildFrame(0x10, [1, 0, 0, 0, 0]);
  assert.equal(frame[4], 0);
  assert.equal(frame[5], 5);
  assert.equal(frame.length, 6 + 5 + 2);
  assert.equal(splitFrames(frame).frames[0].op, 0x10);
});

test('拆包后剩余尾巴会保留，粘包能连续切出多帧', () => {
  const one = buildFrame(0x01, [0, 0, 0, 0x7b, 0, 0x0a, 0x00, 0x05, 0x00]);
  const glued = new Uint8Array([...one, ...one, ...one.slice(0, 4)]);
  const {frames, rest} = splitFrames(glued);
  assert.equal(frames.length, 2);
  assert.equal(rest.length, 4);
  assert.deepEqual(Array.from(rest), Array.from(one.slice(0, 4)));
});

test('噪声字节会被跳过而不是吞掉后面的真帧', () => {
  const one = buildFrame(0x01, [0, 0, 0, 0x7b, 0, 0x0a, 0x00, 0x05, 0x00]);
  const noisy = new Uint8Array([0x00, 0x11, 0xa5, 0x00, ...one]);
  assert.equal(splitFrames(noisy).frames.length, 1);
});

test('重量包按 0.1 g 与 0.1 g/s 解析，秒数小端', () => {
  const payload = Uint8Array.from([0x00, 0x00, 0x03, 0x4b, 0x00, 0x14, 0x10, 0x02, 0x00]);
  const weight = decodeWeight(payload);
  assert.equal(weight.grams, 84.3);
  assert.equal(weight.flow, 2);
  assert.equal(weight.seconds, 528);
  assert.equal(decodeWeight(Uint8Array.from([0, 0])), null);
});

test('流速为负（秤往回落）时保持负值', () => {
  const payload = Uint8Array.from([0x00, 0x00, 0x00, 0x0a, 0xff, 0xf6, 0x00, 0x00]);
  assert.equal(decodeWeight(payload).flow, -1);
});

test('帧解码按 opcode 分发，未知命令不抛错', () => {
  assert.deepEqual(decodeFrame({op: 0x12, payload: Uint8Array.from([0x54, 0x45, 0x53, 0x30, 0x31, 0x36])}),
    {kind: 'name', name: 'TES016'});
  assert.equal(decodeFrame({op: 0x13, payload: Uint8Array.from([0x54, 0x45, 0x53, 0x30, 0x31, 0x36])}).model, 'TES016');
  assert.equal(decodeFrame({op: 0x08, payload: Uint8Array.from([2, 3])}).stage, 3);
  assert.equal(decodeFrame({op: 0x99, payload: Uint8Array.from([1])}).kind, 'other');
});

test('广播识别：只认 0xFFFF 且剥离 FF FF 前缀，全局广播标记不可直连', () => {
  assert.equal(parseAdvertisement(Uint8Array.from([1, 2, 7])).model, 'BASIC3');
  assert.equal(parseAdvertisement(Uint8Array.from([0xff, 0xff, 1, 2, 7])).model, 'BASIC3');
  assert.equal(parseAdvertisement(Uint8Array.from([2, 1, 7])).connectable, false);
  assert.equal(parseAdvertisement(Uint8Array.from([1, 9, 7])), null);
  assert.equal(parseAdvertisement(Uint8Array.from([1])), null);
  assert.equal(parseAdvertisement(null), null);
});

test('重采样按秒对齐并在末点插值', () => {
  const samples = [{t: 0, g: 0}, {t: 500, g: 5}, {t: 1000, g: 10}, {t: 1500, g: 20}];
  const points = resampleSamples(samples, 1000);
  assert.deepEqual(points.map(point => point.t), [0, 1, 2]);
  assert.equal(points[0].g, 0);
  assert.equal(points[1].g, 10);
  assert.equal(points.at(-1).g, 20);
  assert.equal(resampleSamples([{t: 0, g: 0}], 1000).length, 0);
});

test('滑动窗口斜率给出稳定流速', () => {
  const samples = [0, 1, 2, 3, 4].map(i => ({t: i * 500, g: i * 2.4}));
  assert.equal(flowFromSamples(samples, 2000), 4.8);
  assert.equal(flowFromSamples([{t: 0, g: 0}]), 0);
});

test('注水量/粉水比换算：粉重从秤上扣回', () => {
  const stats = pourToWater(20, 340, 322.2);
  assert.equal(stats.pouredWater, 342.2);
  assert.equal(stats.ratio, 17);
  assert.equal(stats.liveRatio, 17.1);
  assert.ok(Math.abs(stats.progress - 342.2 / 340) < 0.01);
  assert.equal(pourToWater(0, 340, 300).ratio, null);
  assert.equal(pourToWater(20, 0).pouredWater, null);
});

test('展示格式', () => {
  assert.equal(formatRatio(17.06), '1:17.1');
  assert.equal(formatRatio(null), '—');
  assert.equal(formatGrams(342.24), '342.2');
  assert.equal(formatDuration(150.7), '02:30');
});
