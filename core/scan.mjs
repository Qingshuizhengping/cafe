import {parseLabel} from './label.mjs';

export async function scanLabel(file, createWorker, onProgress = () => {}, signal) {
  if (!file.type.startsWith('image/') && file.type !== '') {
    throw new Error('请选择一张豆袋照片。');
  }
  const image = document.createElement('img');
  const source = URL.createObjectURL(file);
  let worker;
  let abort;
  try {
    image.src = source;
    await image.decode();
    signal?.throwIfAborted();
    const scale = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理照片，请重拍或选用 JPEG 图片。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    worker = await createWorker(['chi_sim', 'eng'], 1, {
      logger: event => {
        if (event.status === 'recognizing text') onProgress(event.progress);
      },
    });
    signal?.throwIfAborted();
    const recognition = worker.recognize(canvas);
    const {data} = signal ? await Promise.race([recognition, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
    })]) : await recognition;
    return {text: data.text, fields: parseLabel(data.text)};
  } finally {
    URL.revokeObjectURL(source);
    if (abort) signal.removeEventListener('abort', abort);
    if (worker) await worker.terminate();
  }
}
