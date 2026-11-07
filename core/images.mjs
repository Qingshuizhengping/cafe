function canvasFor(image, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理照片，请换一张图片。');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encode(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片压缩失败。'))),
      'image/jpeg',
      quality,
    ),
  );
}

export async function prepareRecognitionImage(file, signal) {
  signal?.throwIfAborted();
  if (!file || file.size > 30 * 1024 * 1024) throw new Error('请选择不超过 30 MB 的豆袋照片。');
  if (file.type && !file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  const source = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = source;
    await image.decode();
    signal?.throwIfAborted();
    let cover;
    for (let size = 320; size >= 80; size = Math.floor(size * 0.7)) {
      const encoded = canvasFor(image, size).toDataURL('image/jpeg', 0.8);
      if (encoded.length <= 28000) {
        cover = encoded;
        break;
      }
    }
    const supportedOriginal = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    if (supportedOriginal && file.size <= 300 * 1024) return {image: file, cover, original: true};
    const canvas = canvasFor(image, 1600);
    let blob = await encode(canvas, 0.82);
    for (const quality of [0.72, 0.62, 0.52, 0.42, 0.32, 0.22, 0.12]) {
      signal?.throwIfAborted();
      if (blob.size <= 0.6 * 1024 * 1024) break;
      blob = await encode(canvas, quality);
    }
    if (blob.size > 2 * 1024 * 1024) throw new Error('图片仍然过大，请裁剪到标签区域后重试。');
    return {image: blob, cover, original: false};
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(error.message || '图片无法解码，请改用 JPEG、PNG 或 WebP。');
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(source);
  }
}

export async function requestRecognition(image, signal) {
  const response = await fetch('./api/vision', {
    method: 'POST',
    body: image,
    signal,
    headers: {'Content-Type': image.type},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.message ||
        (response.status === 429 ? '识别服务繁忙或已达限额，请稍后重试。' : 'GLM 识别未完成，请重试。'),
    );
    error.raw = typeof data.raw === 'string' ? data.raw : '';
    throw error;
  }
  return data;
}
