import {parseRecognition, normalizeComponents} from './core/recognition.mjs';
import {prepareRecognitionImage, requestRecognition} from './core/images.mjs';

const $ = (id) => document.getElementById(id);
const COMPONENT_FIELDS = {
  percentage: '比例（%）',
  origin: '产地',
  country: '产国',
  region: '产区',
  farm: '庄园',
  station: '处理站',
  process: '处理法',
  variety: '品种',
  altitude: '海拔',
  batch: '批次',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(text, callback, className = '') {
  const button = element('button', text, className);
  button.type = 'button';
  button.onclick = callback;
  return button;
}

export function componentEditor(host) {
  const hidden = element('input');
  hidden.type = 'hidden';
  hidden.name = hidden.id = 'components';
  const list = element('div', null, 'component-list');
  const wrapper = element('div', null, 'field component-field');
  const label = element('label', '拼配成分');
  const source = element('small', '来自标签');
  source.id = 'components-source';
  source.hidden = true;
  label.append(source);
  wrapper.append(label, hidden, list);
  const add = action(
    '添加成分',
    () => {
      appendRow({});
      sync();
    },
    'text-action',
  );
  wrapper.append(add);
  host.append(wrapper);

  function sync() {
    const components = [...list.children].map((row) =>
      Object.fromEntries(
        [...row.querySelectorAll('input')]
          .filter((input) => input.value.trim())
          .map((input) => [input.dataset.key, input.value.trim()]),
      ),
    );
    hidden.value = components.length ? JSON.stringify(components) : '';
    hidden.dispatchEvent(new Event('input', {bubbles: true}));
    add.disabled = list.children.length >= 12;
  }

  function appendRow(component) {
    const row = element('details', null, 'component-row');
    row.open = true;
    row.append(element('summary', '成分 ' + (list.children.length + 1)));
    const fields = element('div', null, 'form-pair');
    for (const [key, caption] of Object.entries(COMPONENT_FIELDS)) {
      const label = element('label', caption);
      const input = element('input');
      input.dataset.key = key;
      input.value = component[key] ?? '';
      if (key === 'percentage') {
        input.type = 'number';
        input.min = '.01';
        input.max = '100';
        input.step = '.01';
      }
      input.addEventListener('input', event => {
        event.stopPropagation();
        sync();
      });
      label.append(input);
      fields.append(label);
    }
    row.append(
      fields,
      action(
        '移除成分',
        () => {
          row.remove();
          [...list.children].forEach((item, index) => {
            item.querySelector('summary').textContent = '成分 ' + (index + 1);
          });
          sync();
        },
        'text-action',
      ),
    );
    list.append(row);
  }

  function render(value) {
    list.replaceChildren();
    // Drafts may contain incomplete or invalid values while the user is editing.
    try {
      const stored = value ? JSON.parse(value) : [];
      if (Array.isArray(stored)) {
        for (const component of stored.slice(0, 12)) {
          if (component && typeof component === 'object' && !Array.isArray(component)) appendRow(component);
        }
      }
    } catch {
      // Keep the draft value so a later edit can repair it.
    }
    add.disabled = list.children.length >= 12;
  }
  return {input: hidden, render, focus: () => (list.querySelector('input') ?? add).focus()};
}

export function createCamera({nativeInput, onNative}) {
  let stream;
  let generation = 0;
  let onCapture;
  let torch = false;
  const video = $('camera-preview');
  function stop() {
    generation++;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
  }
  function close() {
    if ($('camera-dialog').open) $('camera-dialog').close();
    else stop();
  }
  $('camera-dialog').addEventListener('close', stop);
  $('camera-close').onclick = close;
  $('camera-native').onclick = () => {
    close();
    onNative?.(onCapture);
    nativeInput.click();
  };
  window.addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
  });

  async function open(callback) {
    stop();
    onCapture = callback;
    torch = false;
    $('camera-error').textContent = '正在打开相机…';
    $('camera-shutter').disabled = true;
    $('camera-zoom-label').hidden = $('camera-torch').hidden = true;
    $('camera-torch').setAttribute('aria-pressed', 'false');
    $('camera-dialog').showModal();
    const token = generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('当前浏览器无法使用实时相机，可使用系统相机拍照。');
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}},
        audio: false,
      });
      if (token !== generation) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      if (token !== generation) return;
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() ?? {};
      if (capabilities.zoom) {
        const input = $('camera-zoom');
        input.min = capabilities.zoom.min;
        input.max = capabilities.zoom.max;
        input.step = capabilities.zoom.step || 0.1;
        input.value = track.getSettings().zoom ?? capabilities.zoom.min;
        $('camera-zoom-label').hidden = false;
      }
      $('camera-torch').hidden = !capabilities.torch;
      $('camera-shutter').disabled = false;
      $('camera-error').textContent = '将包装文字放进取景框，保持光线均匀。';
    } catch (error) {
      if (token === generation)
        $('camera-error').textContent =
          error.name === 'NotAllowedError' ? '相机权限未开启，可以使用系统相机或相册。' : error.message;
    }
  }

  $('camera-zoom').oninput = async () => {
    try {
      await stream
        ?.getVideoTracks()[0]
        .applyConstraints({advanced: [{zoom: Number($('camera-zoom').value)}]});
    } catch {
      $('camera-error').textContent = '设备未能调整缩放，请移动手机改变取景。';
    }
  };
  $('camera-torch').onclick = async () => {
    try {
      await stream.getVideoTracks()[0].applyConstraints({advanced: [{torch: !torch}]});
      torch = !torch;
      $('camera-torch').setAttribute('aria-pressed', String(torch));
    } catch {
      $('camera-error').textContent = '设备未能切换闪光灯，请调整环境光线。';
    }
  };
  $('camera-shutter').onclick = async () => {
    if (!stream || $('camera-shutter').disabled) return;
    $('camera-shutter').disabled = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (!canvas.width || !canvas.height) throw new Error('相机画面尚未准备好，请稍后重试。');
      canvas.getContext('2d').drawImage(video, 0, 0);
      const image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!image) throw new Error('拍照未完成，请重试。');
      close();
      await onCapture(new File([image], '豆袋照片-' + Date.now() + '.jpg', {type: 'image/jpeg'}));
    } catch (error) {
      $('camera-error').textContent = error.message;
    } finally {
      $('camera-shutter').disabled = false;
    }
  };
  return {open, close};
}

let preparationQueue = Promise.resolve();
export async function recognizeFile(file, signal) {
  // Decode full-resolution images one at a time; the five model requests can overlap.
  const preparation = preparationQueue.then(() => prepareRecognitionImage(file, signal));
  preparationQueue = preparation.catch(() => {});
  const prepared = await preparation;
  signal?.throwIfAborted();
  const response = await requestRecognition(prepared.image, signal);
  const beans = Array.isArray(response.beans) ? response.beans : parseRecognition(response.fields ?? {});
  return {...prepared, beans, raw: response.raw ?? ''};
}

export function createImporter({camera, importRecords, onImported, onReview}) {
  let jobs = [];
  let active = 0;
  let jsonBeans = [];
  let importing = false;
  const statuses = {
    waiting: '等待识别',
    running: '正在处理与识别',
    success: '识别完成',
    error: '识别失败',
    cancelled: '已停止',
  };

  function candidate(bean, cover) {
    return {
      id: crypto.randomUUID(),
      fields: {...bean.fields},
      warnings: bean.warnings ?? [],
      cover,
      selected: true,
      imported: false,
    };
  }

  function allCandidates() {
    return [...jobs.flatMap((job) => job.beans ?? []), ...jsonBeans];
  }

  function setStatus(message) {
    $('import-feedback').textContent = message;
  }

  function render() {
    const list = $('import-jobs');
    list.replaceChildren();
    for (const job of jobs) {
      const item = element('article', null, 'import-job');
      const header = element('div', null, 'import-job-header');
      const title = element('div');
      title.append(
        element('strong', job.name),
        element(
          'p',
          statuses[job.status] + (job.beans?.length ? ' · ' + job.beans.length + ' 颗豆' : ''),
          'supporting',
        ),
      );
      header.append(title);
      if (job.status === 'error' || job.status === 'cancelled')
        header.append(
          action(
            '重试',
            () => {
              job.status = 'waiting';
              job.error = '';
              render();
              pump();
            },
            'secondary',
          ),
        );
      item.append(header);
      if (job.error) item.append(element('p', job.error, 'feedback'));
      if (job.status === 'success' && job.preparedInfo)
        item.append(element('p', job.preparedInfo, 'supporting'));
      if (job.raw) {
        const raw = element('details');
        raw.append(element('summary', '查看识别原文'), element('pre', job.raw));
        item.append(raw);
      }
      list.append(item);
    }
    const candidates = $('import-candidates');
    candidates.replaceChildren();
    for (const bean of allCandidates()) candidates.append(candidateView(bean));
    updateSelection();
    $('batch-choose').disabled = $('batch-camera').disabled = jobs.length >= 5;
    $('import-stop').hidden = !jobs.some((job) => ['waiting', 'running'].includes(job.status));
    $('import-close').textContent = active ? '停止并关闭' : '关闭';
  }

  function updateSelection() {
    const candidates = allCandidates();
    const selected = candidates.filter((bean) => bean.selected && !bean.imported);
    $('import-save').textContent = selected.length
      ? '导入已选 ' + selected.length + ' 颗豆'
      : '选择要导入的豆';
    $('import-save').disabled =
      !selected.length || Boolean(active) || jobs.some((job) => job.status === 'waiting') || importing;
  }

  function candidateView(bean) {
    const item = element('section', null, 'import-candidate');
    const heading = element('label', null, 'candidate-selection');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = bean.selected;
    check.disabled = bean.imported;
    check.onchange = () => {
      bean.selected = check.checked;
      updateSelection();
    };
    heading.append(
      check,
      element(
        'span',
        bean.imported ? '已导入 · ' + (bean.fields.name || '咖啡豆') : bean.fields.name || '核对豆名',
      ),
    );
    item.append(heading);
    if (bean.cover) {
      const image = element('img');
      image.src = bean.cover;
      image.alt = '豆袋封面';
      image.className = 'import-cover';
      item.append(image);
    }
    if (bean.warnings.length) item.append(element('p', bean.warnings.join(' '), 'supporting'));
    const fields = element('div', null, 'form-pair');
    for (const [key, label, type] of [
      ['name', '名称', 'text'],
      ['roaster', '烘焙商', 'text'],
      ['weight', '净含量（g）', 'number'],
      ['remaining', '初始余量（g）', 'number'],
      ['roastDate', '烘焙日期', 'date'],
      ['price', '整包价格（元）', 'number'],
    ]) {
      const caption = element('label', label);
      const input = element('input');
      input.type = type;
      input.value = bean.fields[key] ?? '';
      input.dataset.field = key;
      input.disabled = bean.imported || active > 0 || jobs.some((job) => job.status === 'waiting');
      if (type === 'number') {
        input.min = key === 'weight' ? '.01' : '0';
        input.step = '.01';
      }
      if (['name', 'weight', 'remaining'].includes(key)) input.required = true;
      input.oninput = () => {
        const previous = bean.fields.weight;
        bean.fields[key] = input.value;
        if (key === 'weight' && (!bean.fields.remaining || bean.fields.remaining === previous)) {
          bean.fields.remaining = input.value;
          fields.querySelector('[data-field="remaining"]').value = input.value;
        }
      };
      caption.append(input);
      fields.append(caption);
    }
    item.append(fields);
    const more = element('details');
    const details = element('dl', null, 'definition-list');
    for (const [key, value] of Object.entries(bean.fields)) {
      if (['name', 'roaster', 'weight', 'remaining', 'roastDate', 'price'].includes(key)) continue;
      const labels = {
        roast: '烘焙度',
        origin: '产地',
        country: '产国',
        region: '产区',
        farm: '庄园',
        station: '处理站',
        process: '处理法',
        variety: '品种',
        altitude: '海拔',
        flavors: '风味',
        batch: '批次',
        rest: '养豆期',
        freshDays: '赏味结束日',
        category: '分类',
        notes: '备注',
        components: '拼配成分',
      };
      if (!labels[key]) continue;
      const content =
        key === 'components'
          ? normalizeComponents(value)
              .map((part) =>
                Object.entries(part)
                  .map(([key, value]) => (COMPONENT_FIELDS[key] ?? key) + ' ' + value)
                  .join(' · '),
              )
              .join('\n')
          : value;
      details.append(element('dt', labels[key]), element('dd', content));
    }
    more.append(element('summary', '查看其他识别字段'), details);
    item.append(more);
    if (!bean.imported)
      item.append(
        action(
          '在完整表单中核对',
          () => {
            $('import-dialog').close();
            onReview(bean);
          },
          'text-action',
        ),
      );
    return item;
  }

  async function run(job) {
    active++;
    job.status = 'running';
    job.controller = new AbortController();
    render();
    try {
      const result = await recognizeFile(job.file, job.controller.signal);
      job.controller.signal.throwIfAborted();
      job.raw = result.raw;
      if (!result.beans.length) throw new Error('未找到可填写的豆袋信息，可以重拍或粘贴 JSON。');
      job.beans = result.beans.map((bean, index) =>
        candidate(bean, index === 0 ? result.cover : undefined),
      );
      job.preparedInfo = result.original
        ? '小图保留原图送识别。'
        : '已压缩后送识别，大小约 ' + Math.round(result.image.size / 1024) + ' KB。';
      job.status = 'success';
      delete job.file;
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
      job.error = job.status === 'error' ? error.message : '';
      if (error.raw) job.raw = error.raw;
    } finally {
      active--;
      render();
      pump();
    }
  }

  function pump() {
    for (const job of jobs) {
      if (active >= 5) break;
      if (job.status === 'waiting') void run(job);
    }
  }
  function stop() {
    for (const job of jobs) {
      if (job.status === 'waiting') job.status = 'cancelled';
      job.controller?.abort();
    }
    render();
  }
  function open() {
    if (!$('import-dialog').open) $('import-dialog').showModal();
    render();
  }
  function addFiles(files) {
    const available = 5 - jobs.length;
    if (files.length > available) {
      setStatus('本次最多 5 张图片，请减少选择，或清空本批后继续。');
      return;
    }
    for (const file of files) jobs.push({name: file.name, file, status: 'waiting'});
    setStatus('识别后请核对豆名、净含量、日期及价格。');
    render();
    pump();
  }

  $('batch-open').onclick = open;
  $('batch-choose').onclick = () => $('batch-files').click();
  $('batch-files').onchange = (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    addFiles(files);
  };
  $('batch-camera').onclick = () =>
    camera.open((file) => {
      addFiles([file]);
    });
  $('import-stop').onclick = stop;
  $('import-close').onclick = () => $('import-dialog').close();
  $('import-dialog').addEventListener('close', stop);
  $('import-reset').onclick = () => {
    stop();
    jobs = [];
    jsonBeans = [];
    $('import-json').value = '';
    setStatus('已清空本批，可以添加图片。');
    render();
  };
  $('import-clipboard').onclick = async () => {
    try {
      $('import-json').value = await navigator.clipboard.readText();
      setStatus('已读取剪贴板，点击解析 JSON 核对。');
    } catch {
      setStatus('未能读取剪贴板，请在下方手动粘贴 JSON。');
      $('import-json').focus();
    }
  };
  $('import-json-parse').onclick = () => {
    jsonBeans = [];
    render();
    try {
      const raw = $('import-json').value;
      if (raw.length > 1000000) throw new Error('JSON 内容过大，请分批导入。');
      const beans = parseRecognition(raw);
      if (!beans.length) throw new Error('没有找到有效的豆档字段。');
      jsonBeans = beans.map((bean) => candidate(bean));
      render();
      setStatus('JSON 已解析，请核对后导入。');
    } catch (error) {
      setStatus(error.message);
    }
  };
  $('import-save').onclick = async () => {
    if ($('import-save').disabled) return;
    const selected = allCandidates().filter((bean) => bean.selected && !bean.imported);
    const visible = [...$('import-candidates').children];
    for (const item of visible) {
      if (!item.querySelector('input[type=checkbox]').checked) continue;
      for (const input of item.querySelectorAll('input[data-field]')) {
        if (!input.reportValidity()) return;
      }
    }
    importing = true;
    updateSelection();
    $('import-close').disabled = $('import-reset').disabled = true;
    try {
      const imported = await importRecords(
        selected.map((bean) => ({id: bean.id, values: bean.fields, cover: bean.cover})),
      );
      selected.forEach((bean) => {
        bean.imported = true;
        bean.selected = false;
      });
      render();
      setStatus('已导入 ' + imported.length + ' 颗豆，可在豆库继续核对完整资料。');
      if (imported.length === 1) {
        $('import-dialog').close();
        onImported(imported[0]);
      }
    } catch (error) {
      setStatus(error instanceof DOMException ? '未能保存，请检查储存空间后重试。' : error.message);
    } finally {
      importing = false;
      $('import-close').disabled = $('import-reset').disabled = false;
      updateSelection();
    }
  };
  $('import-dialog').addEventListener('cancel', (event) => {
    if (importing) event.preventDefault();
  });

  function openResults(result, file) {
    if (jobs.length >= 5) {
      setStatus('请先清空本批，再添加这次识别结果。');
      open();
      return;
    }
    jobs.push({
      name: file.name,
      status: 'success',
      raw: result.raw,
      beans: result.beans.map((bean, index) => candidate(bean, index === 0 ? result.cover : undefined)),
    });
    open();
  }
  function markSaved(record) {
    const bean = allCandidates().find((bean) => bean.id === record?.id);
    if (bean) {
      bean.imported = true;
      bean.selected = false;
      bean.fields = {...record.values};
      bean.cover = record.cover;
      render();
    }
  }
  return {open, openResults, markSaved};
}
