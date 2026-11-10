// TIMEMORE 电子秤（Basic3 / DOT / ESPRO，以及 AES 加解密都在这里做纯函数）
// 逆向依据：TIMEMORE 2.6.1 反编译
//   ble/c.java          → A5 5A 帧构造、CRC16/MODBUS
//   BleService$15.java  → 分帧与各 opcode 解析
//   ScaleModel.java     → 广播识别 TES016/TES017/TES015
// 这里不碰蓝牙 API，方便单测与在不同传输层（Web Bluetooth / WebSocket 中继）复用。

export const BASIC3_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
export const BASIC3_NOTIFY = '0000fff1-0000-1000-8000-00805f9b34fb';
export const BASIC3_WRITE = '0000fff2-0000-1000-8000-00805f9b34fb';
export const MANUFACTURER_ID = 0xffff;

export const SCALE_MODEL = {
  TES08: {name: 'OLD_DOUBLE', label: '老双秤', scaleType: 0, protocol: 'legacy'},
  TES017: {name: 'DOT', label: 'Dot', scaleType: 1, protocol: 'basic3'},
  TES015: {name: 'ESPRO', label: 'ESPpro', scaleType: 2, protocol: 'basic3'},
  TES016: {name: 'BASIC3', label: 'Basic3', scaleType: 3, protocol: 'basic3'},
};
const ADV_CODE = {1: 'DOT', 3: 'ESPRO', 2: 'BASIC3'};

export const OPCODE = {
  WEIGHT: 0x01, TIMER: 0x02, RATIO: 0x03, RATIO_CONTROL: 0x04, TEMP: 0x05,
  MODE: 0x08, PAUSE: 0x09, POWER: 0x0b, SHUTDOWN: 0x0c, SOUND: 0x0d,
  NAME: 0x12, MODEL: 0x13, RESET: 0x18, LOST: 0x19, FIRMWARE: 0x1a,
};

export function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc & 0xffff;
}

// A5 5A | type | opcode | len_hi len_lo | payload | crc_hi crc_lo（CRC 大端）
export function buildFrame(op, payload = [], type = 3) {
  const body = Array.from(payload);
  const head = [0xa5, 0x5a, type, op, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const crc = crc16Modbus(head);
  return Uint8Array.from([...head, (crc >> 8) & 0xff, crc & 0xff]);
}

export function readFrame(op) {
  return buildFrame(op, [], 2);
}

// 流式分帧：返回 {frames, rest}，rest 是还没收全的尾巴（BLE 通知会拆包）
export function splitFrames(buffer) {
  const frames = [];
  let index = 0;
  const bytes = buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer);
  while (index < bytes.length - 1) {
    if (bytes[index] !== 0xa5 || bytes[index + 1] !== 0x5a) {
      index += 1;
      continue;
    }
    if (index + 6 > bytes.length) break;
    const length = (bytes[index + 4] << 8) | bytes[index + 5];
    if (length > 1024) {
      index += 1;
      continue;
    }
    const end = index + length + 8;
    if (end > bytes.length) break;
    const frame = bytes.slice(index, end);
    frames.push({type: frame[2], op: frame[3], payload: frame.slice(6, 6 + length), crcOk: crc16Modbus(frame.slice(0, -2)) === ((frame.at(-2) << 8) | frame.at(-1))});
    index = end;
  }
  return {frames, rest: bytes.slice(index)};
}

const int32 = (payload, at = 0) => ((payload[at] << 24) | (payload[at + 1] << 16) | (payload[at + 2] << 8) | payload[at + 3]) | 0;
const int16 = (payload, at = 0) => {const value = (payload[at] << 8) | payload[at + 1]; return value > 0x7fff ? value - 0x10000 : value;};
const ascii = payload => String.fromCharCode(...payload).replace(/\u0000/g, '').trim();

// 0x01 重量：int32 累计重量(0.1g) + int16 流速(0.1g/s) + [6..7] 秒数(LE) + [8] 超重位
export function decodeWeight(payload, unit = 'g') {
  if (!payload || payload.length < 8) return null;
  const scale = unit === 'oz' ? 100 : 10;
  const grams = int32(payload, 0) / scale;
  const flow = int16(payload, 4) / scale;
  return {
    grams: Math.round(grams * 10) / 10,
    flow: Math.round(flow * 10) / 10,
    seconds: payload[6] | (payload[7] << 8),
    overweight: payload.length > 8 ? payload[8] : 0,
  };
}

export function decodeFrame({op, payload}) {
  switch (op) {
    case OPCODE.WEIGHT: return {kind: 'weight', ...decodeWeight(payload)};
    case OPCODE.TIMER: return payload.length >= 3 ? {kind: 'timer', state: payload[0], seconds: payload[1] | (payload[2] << 8)} : null;
    case OPCODE.MODE: return payload.length >= 2 ? {kind: 'mode', mode: payload[0], stage: payload[1]} : null;
    case OPCODE.RATIO: return payload.length === 2 ? {kind: 'ratio', ratio: (payload[0] << 8) | payload[1]} : null;
    case OPCODE.MODEL: return {kind: 'model', model: ascii(payload)};
    case OPCODE.NAME: return {kind: 'name', name: payload.length >= 1 ? ascii(payload) : ''};
    default: return {kind: 'other', op, payload: Array.from(payload)};
  }
}

// 广播里的 0xFFFF 制造商数据（nRF 等抓包会带 FF FF 前缀，自动剥掉）
export function parseAdvertisement(manufacturerData) {
  if (!manufacturerData) return null;
  let bytes = manufacturerData instanceof Uint8Array ? manufacturerData : Uint8Array.from(manufacturerData);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xff) bytes = bytes.slice(2);
  if (bytes.length < 2 || (bytes[0] !== 1 && bytes[0] !== 2)) return null;
  const model = ADV_CODE[bytes[1]];
  if (!model) return null;
  return {model, broadcastType: bytes[0], deviceCode: bytes.at(-1), connectable: bytes[0] === 1};
}

// ---------- 图表数据：把重量流按固定间隔取样，算出每段注水斜率 ----------

export function resampleSamples(samples, stepMs = 1000, now = null) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const first = samples[0].t;
  const last = now ?? samples.at(-1).t;
  const at = t => {
    let cursor = 0;
    while (cursor < samples.length - 1 && samples[cursor + 1].t <= t) cursor += 1;
    const before = samples[cursor];
    const after = samples[Math.min(cursor + 1, samples.length - 1)];
    const span = after.t - before.t;
    const ratio = span > 0 ? Math.min(1, Math.max(0, (t - before.t) / span)) : 0;
    return Math.round((before.g + (after.g - before.g) * ratio) * 10) / 10;
  };
  const out = [];
  for (let t = first; t <= last; t += stepMs) out.push({t: Math.round((t - first) / 1000), g: at(t)});
  const endSeconds = Math.round((last - first) / 1000);
  if (!out.length || out.at(-1).t < endSeconds) out.push({t: endSeconds, g: at(last)});
  return out;
}

// 窗口内最小二乘斜率（g/s），比瞬时读数稳定，贴近参考图的绿色曲线
export function flowFromSamples(samples, windowMs = 1200) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const end = samples.at(-1);
  const window = samples.filter(sample => sample.t >= end.t - windowMs);
  if (window.length < 2) return 0;
  const n = window.length;
  const meanX = window.reduce((sum, sample) => sum + sample.t, 0) / n;
  const meanY = window.reduce((sum, sample) => sum + sample.g, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const sample of window) {
    numerator += (sample.t - meanX) * (sample.g - meanY);
    denominator += (sample.t - meanX) ** 2;
  }
  return denominator > 0 ? Math.round((numerator / denominator) * 1000 * 100) / 100 : 0;
}

export function pourToWater(dose, water, net = 0) {
  const powder = Number(dose);
  const total = Number(water);
  const ratio = powder > 0 && total > 0 ? total / powder : null;
  const pouredWater = powder > 0 && Number(net) > 0 ? Number(net) + powder : null;
  const liveRatio = pouredWater ? pouredWater / powder : null;
  const progress = total > 0 && pouredWater != null ? Math.min(1, pouredWater / total) : 0;
  return {
    dose: powder > 0 ? powder : null,
    ratio: ratio ? Math.round(ratio * 10) / 10 : null,
    pouredWater: pouredWater == null ? null : Math.round(pouredWater * 100) / 100,
    liveRatio: liveRatio ? Math.round(liveRatio * 10) / 10 : null,
    progress,
  };
}

export function formatRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? '1:' + ratio.toFixed(1) : '—';
}

export function formatGrams(value, digits = 1) {
  const gram = Number(value);
  return Number.isFinite(gram) ? gram.toFixed(digits) : '—';
}

export function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}
