// iOS 路线：iPhone 上的浏览器没有 Web Bluetooth，改成「一台设备当秤桥」。
// 桥页面（bridge.html）在同一站点里用 Web Bluetooth 连秤，把解析后的重量发到账号服务
// （scale-bridge-server.mjs 挂在 /api/scale/relay），其它已登录的页面订阅同一条连接即可。
// 房间就是登录账号本身，不传房间码；没登录或不在 HTTPS 下直接报错，让上层退化成手动计时。
// 与 scale-ble.mjs 暴露同一套接口，上层不用区分传输方式。

export function bridgeUrl(location = globalThis.location) {
  const origin = location?.origin ?? '';
  if (!origin || origin === 'null' || origin.startsWith('file:')) throw new Error('请用 HTTPS 打开这个站点后再连秤。');
  if (!/^https:/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    throw new Error('中继需要安全上下文：用 HTTPS 或 localhost 打开。');
  }
  return origin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/api/scale/relay';
}

export function bridgeAvailable(location = globalThis.location) {
  try { bridgeUrl(location); return true; } catch { return false; }
}

function openSocket(role, {url, onMessage, onReady, onClose} = {}) {
  const endpoint = url ?? bridgeUrl();
  const socket = new WebSocket(`${endpoint}?role=${role}`, {withCredentials: true});
  let closed = false;
  const fail = () => { if (!closed) { closed = true; onClose?.(new Error(role === 'pusher' ? '中继连接失败。' : '中继连接失败，请确认已登录并且服务端开了中继。')); } };
  socket.addEventListener('open', () => onReady?.(socket));
  socket.addEventListener('error', fail);
  socket.addEventListener('close', fail);
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    onMessage?.(message);
  });
  return {socket, close: () => { closed = true; try { socket.close(); } catch {} }};
}

export function connectBridge({url, onReading, onEvent, onDisconnect} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { handle.close(); } catch {}
      reject(new Error('中继没有响应，请确认账号服务已开启中继。'));
    }, 8000);
    const handle = openSocket('viewer', {
      url,
      onReady: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onEvent?.({kind: 'linked'});
        resolve({
          transport: 'bridge',
          name: '中继',
          info: () => ({model: 'UNKNOWN'}),
          write: async () => {},
          disconnect: async () => handle.close(),
        });
      },
      onMessage: message => {
        if (message.kind === 'weight') onReading?.({grams: message.grams, flow: message.flow, at: Date.now(), relay: true});
        else if (message.kind === 'bridge-ready') onEvent?.({kind: 'bridge-ready'});
        else if (message.kind === 'model') onEvent?.({kind: 'model', model: message.model});
        else if (message.kind === 'bye') onDisconnect?.();
      },
      onClose: error => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); return; }
        onDisconnect?.();
      },
    });
  });
}

// 桥页面用：连本机蓝牙上的秤，把重量推给登录账号的中继
export async function startBridge({onReading, onStatus} = {}) {
  const {requestBasic3Scale} = await import('./scale-ble.mjs?v=2');
  if (!bridgeAvailable()) throw new Error('桥页面必须用 HTTPS 打开才能调用蓝牙。');
  const scale = await requestBasic3Scale({
    onReading: reading => {
      onReading?.(reading);
      push({kind: 'weight', grams: reading.grams, flow: reading.flow});
    },
    onEvent: event => {
      onStatus?.(event);
      if (event.kind === 'model') push({kind: 'model', model: event.model});
    },
  });
  let link;
  let queue = [];
  const push = message => {
    if (link?.socket.readyState === WebSocket.OPEN) link.socket.send(JSON.stringify(message));
    else queue = [...queue.slice(-40), message];
  };
  const connect = () => {
    link = openSocket('pusher', {
      onReady: socket => {
        const pending = queue;
        queue = [];
        for (const message of pending) socket.send(JSON.stringify(message));
        onStatus?.({kind: 'relay-up'});
      },
      onClose: () => {
        onStatus?.({kind: 'relay-down'});
        setTimeout(connect, 1500);
      },
    });
  };
  connect();
  window.addEventListener('pagehide', () => {
    try { link?.socket.send(JSON.stringify({kind: 'bye'})); } catch {}
    try { link?.close(); } catch {}
    try { scale.disconnect(); } catch {}
  });
  return {scale, stop: () => scale.disconnect()};
}
