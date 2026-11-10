// Web Bluetooth 传输层：扫描 Basic3 秤、握手、订阅重量流。
// 只支持 Chromium 内核（Chrome / Edge / Android Chrome）；iOS Safari 没有 Web Bluetooth，
// 由 core/scale-bridge.mjs 走服务器中继，对上层暴露同一套接口。
import {BASIC3_SERVICE, BASIC3_NOTIFY, BASIC3_WRITE, OPCODE, buildFrame, readFrame,
  splitFrames, decodeFrame, parseAdvertisement} from './scale.mjs?v=1';

export function webBluetoothAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth?.requestDevice);
}

export async function requestBasic3Scale() {
  if (!webBluetoothAvailable()) throw new Error('这台设备或浏览器不支持网页直连蓝牙。');
  const filters = [{services: [BASIC3_SERVICE]}, {namePrefix: 'TES'}, {namePrefix: 'TIMEMORE'}, {namePrefix: 'Basic'}];
  const device = await navigator.bluetooth.requestDevice({filters, optionalServices: [BASIC3_SERVICE]});
  return connectBasic3Device(device);
}

export async function connectBasic3Device(device, {onReading, onEvent, onDisconnect} = {}) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BASIC3_SERVICE);
  const notify = await service.getCharacteristic(BASIC3_NOTIFY);
  const write = await service.getCharacteristic(BASIC3_WRITE);

  let buffer = new Uint8Array(0);
  let info = {model: 'UNKNOWN', mtu: 0};
  let sealed = false;

  const send = async op => {
    try { await write.writeValueWithoutResponse(readFrame(op)); }
    catch { await write.writeValue(readFrame(op)); }
  };

  const handle = event => {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const merged = new Uint8Array(buffer.length + bytes.length);
    merged.set(buffer); merged.set(bytes, buffer.length);
    const {frames, rest} = splitFrames(merged);
    buffer = rest;
    for (const frame of frames) {
      const decoded = decodeFrame(frame);
      if (!decoded) continue;
      if (decoded.kind === 'weight') onReading?.({...decoded, at: Date.now()});
      else if (decoded.kind === 'name' || decoded.kind === 'model') {
        info = {...info, model: decoded.name ?? decoded.model};
        onEvent?.({kind: 'model', model: info.model});
      } else onEvent?.(decoded);
    }
  };

  await notify.startNotifications();
  notify.addEventListener('characteristicvaluechanged', handle);
  info.mtu = (server.device?.gatt?.mtu) || 0;
  onEvent?.({kind: 'connected', name: device.name ?? '', id: device.id ?? ''});

  // 对齐 App 侧握手顺序：先读模式、计时、设备型号
  for (const op of [OPCODE.MODE, OPCODE.TIMER, OPCODE.NAME]) await send(op).catch(() => {});

  const disconnect = async () => {
    if (sealed) return;
    sealed = true;
    try { notify.removeEventListener('characteristicvaluechanged', handle); } catch {}
    try { await notify.stopNotifications(); } catch {}
    try { server.disconnect(); } catch {}
    onDisconnect?.();
  };
  device.addEventListener?.('gattserverdisconnected', () => { if (!sealed) { sealed = true; onDisconnect?.(); } });

  return {
    transport: 'web-bluetooth',
    name: device.name ?? 'TIMEMORE',
    info: () => info,
    write: async (op, payload) => {
      const frame = buildFrame(op, payload);
      try { await write.writeValueWithoutResponse(frame); } catch { await write.writeValue(frame); }
    },
    disconnect,
  };
}

export function advertisementToBytes(event) {
  return parseAdvertisement(event?.manufacturerData ?? null);
}
