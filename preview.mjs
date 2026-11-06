import {scanLabel} from './core/scan.mjs';
import {webClipProfile} from './core/webclip.mjs';

const $ = id => document.getElementById(id);
const form = $('entry');
const photo = document.createElement('img');
photo.alt = '待识别的豆袋标签';
photo.hidden = true;
document.querySelector('.viewfinder').append(photo);
const groups = {
  基本信息: [
    ['name', '名称', 'text', '咖啡豆名称', true],
    ['weight', '总重量（g）', 'number', '包装净含量', true],
    ['remaining', '剩余重量（g）', 'number', '输入当前剩余', true],
  ],
  购买信息: [
    ['price', '价格（CNY）', 'number', '可选'],
    ['unitPrice', '单克价（CNY/g）', 'output'],
  ],
  包装信息: [
    ['roaster', '烘焙商'], ['roastDate', '烘焙日期', 'date'],
    ['roast', '烘焙程度', ['极浅烘', '浅烘', '中浅烘', '中烘', '中深烘', '深烘', '极深烘']],
    ['origin', '产地'], ['farm', '庄园'], ['variety', '豆种'],
    ['altitude', '海拔（m）'], ['process', '处理法'], ['flavors', '风味', 'text', '用顿号分隔'],
  ],
  自用记录: [
    ['rest', '养豆期（天）', 'number'], ['storage', '储存方式', ['常温', '冷冻']],
    ['rating', '评级', ['1', '2', '3', '4', '5']], ['notes', '备注', 'textarea'],
  ],
};
const fieldLabels = new Map();
for (const [title, fields] of Object.entries(groups)) {
  const section = document.createElement('fieldset');
  const heading = document.createElement('h2');
  heading.textContent = title;
  heading.id = 'group-' + title;
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading);
  for (const [name, label, type = 'text', hint = '可选', required = false] of fields) {
    fieldLabels.set(name, label);
    const row = document.createElement('div');
    row.className = 'field';
    const caption = document.createElement('label');
    caption.htmlFor = name;
    caption.textContent = label + (required ? ' *' : '');
    const source = document.createElement('small');
    source.id = name + '-source';
    source.hidden = true;
    source.textContent = '来自标签';
    caption.append(source);
    const tag = Array.isArray(type) ? 'select' : ['output', 'textarea'].includes(type) ? type : 'input';
    const control = document.createElement(tag);
    control.id = control.name = name;
    control.required = required;
    if (tag === 'input') {
      control.type = type;
      if (type === 'number') {
        control.min = name === 'weight' ? '0.01' : '0';
        control.step = name === 'rest' ? '1' : '0.01';
      }
    }
    if (tag === 'select') control.append(new Option('请选择', ''), ...type.map(value => new Option(value, value)));
    if (['input', 'textarea'].includes(tag)) control.placeholder = hint;
    if (name === 'unitPrice') control.value = '—';
    row.append(caption, control);
    if (name === 'remaining') {
      const unopened = document.createElement('button');
      unopened.id = 'unopened';
      unopened.type = 'button';
      unopened.textContent = '未开封，使用总重量';
      row.append(unopened);
    }
    section.append(row);
  }
  if (title === '基本信息') {
    $('fields').append(section);
  } else {
    const group = document.createElement('details');
    group.className = 'optional-fields';
    const summary = document.createElement('summary');
    summary.textContent = title;
    heading.className = 'sr-only';
    group.append(summary, section);
    $('fields').append(group);
  }
}

const key = 'doudang-preview-records';
const draftKey = 'doudang-draft:';
let editing = null;
let originalValues = {};
let objectUrl;
let busy = false;
let records = [];
let deducting;
let lastDeduction;

function readRecords() {
  const stored = JSON.parse(localStorage.getItem(key));
  return Array.isArray(stored) ? stored : [];
}

function updateRecords(update) {
  const write = () => {
    const next = update(readRecords());
    localStorage.setItem(key, JSON.stringify(next));
    records = next;
  };
  return navigator.locks ? navigator.locks.request(key, write) : write();
}

try {
  records = readRecords();
} catch {
  $('save-status').textContent = '暂时无法读取豆库。';
}

function updatePrice() {
  const mass = $('weight').valueAsNumber;
  const price = $('price').valueAsNumber;
  $('unitPrice').value = mass > 0 && Number.isFinite(price) ? (price / mass).toFixed(2) : '—';
}

function showLibrary(visible) {
  $('editor').hidden = visible;
  $('library').hidden = !visible;
  if (visible) $('library-toggle').setAttribute('aria-current', 'page');
  else $('library-toggle').removeAttribute('aria-current');
  window.scrollTo(0, 0);
  $(visible ? 'library-title' : 'editor-title').focus({preventScroll: true});
}

function setCapture(visible) {
  $('capture').hidden = !visible;
  $('show-capture').hidden = visible;
  $('capture').parentElement.classList.toggle('form-only', !visible);
}

function draftId(id = editing) {
  return draftKey + (id ?? 'new');
}

function readDraft(id) {
  try {
    return JSON.parse(localStorage.getItem(draftId(id)));
  } catch {
    return null;
  }
}

function formValues() {
  return Object.fromEntries(new FormData(form));
}

function saveDraft() {
  const values = formValues();
  try {
    if (Object.keys(values).some(name => values[name] !== (originalValues[name] ?? ''))) {
      localStorage.setItem(draftId(), JSON.stringify({values, originalValues}));
    } else {
      localStorage.removeItem(draftId());
    }
  } catch {
    $('save-status').textContent = '草稿无法保存在此设备，请先保存豆档。';
  }
}

function openRecord(record) {
  editing = record?.id ?? null;
  const draft = readDraft(editing);
  originalValues = draft?.originalValues ?? record?.values ?? {};
  form.reset();
  $('editor-title').textContent = record ? '编辑咖啡豆' : '添加咖啡豆';
  $('editor-intro').textContent = record ? record.values.name : '拍下包装标签，核对识别结果后保存。';
  $('unopened').hidden = Boolean(record);
  setCapture(!record);
  $('remaining').setCustomValidity('');
  $('save-status').textContent = draft ? '已恢复上次未保存的草稿。' : '';
  $('scan-status').textContent = '让包装文字填满画面，避开反光。';
  $('raw').hidden = true;
  clearConflicts();
  photo.hidden = true;
  photo.removeAttribute('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  for (const label of form.querySelectorAll('small')) label.hidden = true;
  for (const details of form.querySelectorAll('.optional-fields')) details.open = false;
  for (const [name, value] of Object.entries(draft?.values ?? record?.values ?? {})) {
    if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
  }
  updatePrice();
  showLibrary(false);
}

function renderLibrary() {
  $('count').textContent = String(records.length);
  $('new-entry').textContent = readDraft(null) ? '继续新增草稿' : '添加咖啡豆';
  $('library-tools').hidden = records.length === 0;
  $('entries').replaceChildren();
  const query = $('library-search').value.trim().toLowerCase();
  const filter = $('library-filter').value;
  const visibleRecords = records.filter(({values}) => {
    const available = Number(values.remaining) > 0;
    return (!filter || available === (filter === 'available')) &&
      [values.name, values.origin, values.roaster].some(value => (value ?? '').toLowerCase().includes(query));
  });
  if (!visibleRecords.length) $('entries').textContent = records.length ? '没有符合条件的咖啡豆。' : '还没有保存的咖啡豆。';
  for (const record of visibleRecords) {
    const row = document.createElement('div');
    row.className = 'record-row';
    const button = document.createElement('button');
    button.className = 'record';
    button.type = 'button';
    button.textContent = record.values.name;
    const detail = document.createElement('span');
    detail.textContent = [record.values.roaster, record.values.origin, readDraft(record.id) ? '有未保存草稿' : ''].filter(Boolean).join(' · ');
    if (detail.textContent) button.append(detail);
    button.onclick = () => openRecord(record);
    const stock = document.createElement('span');
    stock.className = 'record-stock';
    stock.textContent = Number(record.values.remaining) > 0 ? record.values.remaining + '\u00a0g' : '已用完';
    stock.setAttribute('aria-label', '剩余 ' + record.values.remaining + ' 克');
    const deduct = document.createElement('button');
    deduct.className = 'deduct-button';
    deduct.type = 'button';
    deduct.textContent = '减豆';
    deduct.setAttribute('aria-label', '减豆：' + record.values.name);
    deduct.disabled = !(Number(record.values.remaining) > 0);
    deduct.onclick = () => {
      deducting = record;
      $('deduct-form').reset();
      $('deduct-error').textContent = '';
      $('deduct-stock').textContent = record.values.name + ' · 剩余 ' + record.values.remaining + '\u00a0g';
      $('recent-dose').hidden = !(record.lastDose > 0 && record.lastDose <= Number(record.values.remaining));
      $('recent-dose').textContent = '沿用上次 ' + record.lastDose + '\u00a0g';
      updateDeductPreview();
      $('deduct').showModal();
    };
    row.append(button, stock, deduct);
    $('entries').append(row);
  }
}

$('deduct-cancel').onclick = () => $('deduct').close();
const hundredths = grams => Math.round(Number(grams) * 100);

function updateDeductPreview() {
  const input = $('deduct-grams');
  const available = hundredths(deducting.values.remaining);
  const used = hundredths(input.value);
  $('deduct-preview').textContent = input.value && input.validity.valid && used <= available
    ? '减豆后剩余 ' + (available - used) / 100 + '\u00a0g'
    : '';
  $('deduct-error').textContent = '';
}

$('deduct-grams').oninput = updateDeductPreview;
$('recent-dose').onclick = () => {
  $('deduct-grams').value = deducting.lastDose;
  updateDeductPreview();
  $('deduct-grams').focus();
};

$('deduct-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit.disabled) return;
  submit.disabled = true;
  const {id} = deducting;
  const grams = $('deduct-grams').valueAsNumber;
  let updated;
  let previous;
  const token = crypto.randomUUID?.() ?? Date.now() + ':' + Math.random();
  try {
    await updateRecords(current => {
      const record = current.find(item => item.id === id);
      if (!record) throw new Error('找不到这条记录，请刷新豆库后重试。');
      const available = hundredths(record.values.remaining);
      const used = hundredths(grams);
      if (!Number.isSafeInteger(available) || !Number.isSafeInteger(used) || used < 1 || used > available) {
        throw new Error('请输入大于 0 且不超过当前余量（' + record.values.remaining + ' g）的克数。');
      }
      previous = record.values.remaining;
      updated = {...record, lastDose: grams, deductionToken: token, values: {...record.values, remaining: String((available - used) / 100)}};
      return current.map(item => item.id === id ? updated : item);
    });
    $('deduct').close();
    renderLibrary();
    lastDeduction = {id, token, previous};
    $('undo-deduct').hidden = false;
    $('undo-deduct').focus();
    $('library-status').textContent = updated.values.name + '已减豆 ' + grams + '\u00a0g，剩余 ' + updated.values.remaining + '\u00a0g。';
  } catch (error) {
    $('deduct-error').textContent = error instanceof DOMException ? '扣减保存失败，请重试。' : error.message;
  } finally {
    submit.disabled = false;
  }
});

$('undo-deduct').onclick = async () => {
  const button = $('undo-deduct');
  if (!lastDeduction || button.disabled) return;
  button.disabled = true;
  const {id, token, previous} = lastDeduction;
  let restored = false;
  try {
    await updateRecords(current => current.map(record => {
      if (record.id !== id || record.deductionToken !== token) return record;
      restored = true;
      return {...record, deductionToken: null, values: {...record.values, remaining: previous}};
    }));
    lastDeduction = null;
    button.hidden = true;
    renderLibrary();
    $('library-title').focus({preventScroll: true});
    $('library-status').textContent = restored
      ? '已撤销减豆，余量恢复为 ' + previous + '\u00a0g。'
      : '这条豆档的余量已更新，无法撤销这次减豆。';
  } catch {
    $('library-status').textContent = '撤销失败，请重试。';
  } finally {
    button.disabled = false;
  }
};

function clearConflicts() {
  for (const conflict of form.querySelectorAll('.ocr-conflict')) conflict.remove();
}

function showConflict(input, suggested) {
  const conflict = document.createElement('div');
  conflict.className = 'ocr-conflict';
  const text = document.createElement('p');
  text.textContent = fieldLabels.get(input.name) + ' · 当前「' + input.value + '」，识别为「' + suggested + '」。';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.textContent = '保留当前值';
  keep.onclick = () => {
    conflict.remove();
    input.focus();
  };
  const use = document.createElement('button');
  use.type = 'button';
  use.textContent = '采用识别值';
  use.onclick = () => {
    input.value = suggested;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    $(input.name + '-source').hidden = false;
    input.focus();
  };
  conflict.append(text, keep, use);
  input.closest('.field').append(conflict);
}

$('manual-entry').onclick = () => {
  setCapture(false);
  $('name').focus();
};
$('show-capture').onclick = () => {
  setCapture(true);
  $('camera-open').focus();
};
$('unopened').onclick = () => {
  if (!$('weight').reportValidity()) return;
  $('remaining').value = $('weight').value;
  $('remaining').dispatchEvent(new Event('input', {bubbles: true}));
  $('remaining').focus();
};

form.addEventListener('invalid', event => {
  const group = event.target.closest('details');
  if (group) group.open = true;
}, true);
form.addEventListener('input', event => {
  const source = $(event.target.name + '-source');
  if (source) source.hidden = true;
  event.target.closest('.field')?.querySelector('.ocr-conflict')?.remove();
  $('remaining').setCustomValidity('');
  updatePrice();
  saveDraft();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if ($('remaining').valueAsNumber > $('weight').valueAsNumber) {
    $('remaining').setCustomValidity('剩余重量不能超过总重量。');
    $('remaining').reportValidity();
    return;
  }
  const values = Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]));
  if (!values.name) {
    $('save-status').textContent = '请输入咖啡豆名称。';
    $('name').focus();
    return;
  }
  const id = editing ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
  const submit = event.submitter;
  if (submit.disabled) return;
  submit.disabled = true;
  $('library-toggle').disabled = true;
  try {
    await updateRecords(current => {
      const existing = current.find(record => record.id === id);
      if (!existing) return [{id, values}, ...current];
      const changes = Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== (originalValues[name] ?? '')));
      if ('remaining' in changes && existing.values.remaining !== originalValues.remaining && changes.remaining !== existing.values.remaining) {
        throw new Error('这包豆的余量已更新。当前为 ' + existing.values.remaining + ' g，请核对后再保存。');
      }
      const merged = {...existing.values, ...changes};
      if (Number(merged.remaining) > Number(merged.weight)) {
        throw new Error('当前余量超过你填写的总重量，请核对后再保存。');
      }
      return current.map(record => record.id === id ? {
        ...existing, values: merged,
        deductionToken: merged.remaining === existing.values.remaining ? existing.deductionToken : null,
      } : record);
    });
    try { localStorage.removeItem(draftId()); } catch {}
    $('library-status').textContent = '已保存豆档。';
    renderLibrary();
    showLibrary(true);
  } catch (error) {
    $('save-status').textContent = error instanceof DOMException ? '保存失败，请检查浏览器的储存权限。' : error.message;
  } finally {
    submit.disabled = false;
    $('library-toggle').disabled = false;
  }
});

$('camera-open').onclick = () => $('camera').click();
$('gallery-open').onclick = () => $('gallery').click();
for (const id of ['camera', 'gallery']) {
  $(id).addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || busy) return;
    busy = true;
    for (const id of ['camera-open', 'gallery-open', 'manual-entry', 'library-toggle']) $(id).disabled = true;
    form.querySelector('[type=submit]').disabled = true;
    $('raw').hidden = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    photo.src = objectUrl;
    photo.hidden = false;
    $('scan-status').textContent = '正在加载中英文识别组件…';
    try {
      const {default: {createWorker}} = await import('https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js');
      const {text, fields} = await scanLabel(file, createWorker, progress => {
        $('scan-status').textContent = '正在识别 ' + Math.round(progress * 100) + '%';
      });
      $('raw-text').textContent = text;
      $('raw').hidden = !text.trim();
      let filled = 0;
      let conflicts = 0;
      clearConflicts();
      for (const [name, value] of Object.entries(fields)) {
        const input = $(name);
        if (!input.value) {
          input.value = value;
          $(name + '-source').hidden = false;
          filled++;
        } else if (input.value !== value) {
          showConflict(input, value);
          const group = input.closest('details');
          if (group) group.open = true;
          conflicts++;
        }
      }
      updatePrice();
      saveDraft();
      $('scan-status').textContent = filled || conflicts
        ? '已填入 ' + filled + ' 项。' + (conflicts ? '请在表单中核对 ' + conflicts + ' 项差异。' : '保存前请展开相关分组核对。')
        : '未找到可自动填写的字段。可以查看原文、重拍或手动输入。';
    } catch {
      $('scan-status').textContent = '识别失败。请检查网络，重拍、选用 JPEG 或手动填写。';
    } finally {
      busy = false;
      for (const id of ['camera-open', 'gallery-open', 'manual-entry', 'library-toggle']) $(id).disabled = false;
      form.querySelector('[type=submit]').disabled = false;
    }
  });
}
$('library-toggle').onclick = () => {
  renderLibrary();
  showLibrary(true);
};
$('new-entry').onclick = () => openRecord();
$('library-search').oninput = renderLibrary;
$('library-filter').onchange = renderLibrary;
$('install-open').onclick = () => {
  if (location.protocol === 'https:') $('address').value = location.href;
  $('install').showModal();
};
$('install-close').onclick = () => $('install').close();
$('profile').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const xml = webClipProfile($('address').value);
    const url = URL.createObjectURL(new Blob([xml], {type: 'application/x-apple-aspen-config'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'doudang.mobileconfig';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('profile-error').textContent = '';
  } catch {
    $('profile-error').textContent = '请输入 iPhone 可以打开的 HTTPS 网址。';
  }
});
renderLibrary();
if (records.length) showLibrary(true);
else if (readDraft(null)) openRecord();

