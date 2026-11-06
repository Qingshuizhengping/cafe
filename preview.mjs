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
for (const [title, fields] of Object.entries(groups)) {
  const section = document.createElement('fieldset');
  const heading = document.createElement('h2');
  heading.textContent = title;
  heading.id = 'group-' + title;
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading);
  for (const [name, label, type = 'text', hint = '可选', required = false] of fields) {
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
    section.append(row);
  }
  $('fields').append(section);
}

const key = 'doudang-preview-records';
let editing = null;
let objectUrl;
let busy = false;
let records = [];
let deducting = null;

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
  window.scrollTo(0, 0);
}

function openRecord(record) {
  editing = record?.id ?? null;
  form.reset();
  $('remaining').setCustomValidity('');
  $('save-status').textContent = '';
  $('scan-status').textContent = '让包装文字填满画面，避开反光。';
  $('raw').hidden = true;
  photo.hidden = true;
  photo.removeAttribute('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  for (const label of form.querySelectorAll('small')) label.hidden = true;
  for (const [name, value] of Object.entries(record?.values ?? {})) {
    if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
  }
  updatePrice();
  showLibrary(false);
}

function renderLibrary() {
  $('count').textContent = String(records.length);
  $('entries').replaceChildren();
  if (!records.length) $('entries').textContent = '还没有保存的咖啡豆。';
  for (const record of records) {
    const row = document.createElement('div');
    row.className = 'record-row';
    const button = document.createElement('button');
    button.className = 'record';
    button.type = 'button';
    button.textContent = record.values.name;
    const detail = document.createElement('span');
    detail.textContent = [record.values.roaster, record.values.origin, '剩余 ' + record.values.remaining + ' g'].filter(Boolean).join(' · ');
    button.append(detail);
    button.onclick = () => openRecord(record);
    const deduct = document.createElement('button');
    deduct.className = 'deduct-button';
    deduct.type = 'button';
    deduct.textContent = '减豆';
    deduct.setAttribute('aria-label', '减豆：' + record.values.name);
    deduct.disabled = !(Number(record.values.remaining) > 0);
    deduct.onclick = () => {
      deducting = record.id;
      $('deduct-form').reset();
      $('deduct-error').textContent = '';
      $('deduct-stock').textContent = record.values.name + ' · 剩余 ' + record.values.remaining + ' g';
      $('deduct').showModal();
    };
    row.append(button, deduct);
    $('entries').append(row);
  }
}

$('deduct-cancel').onclick = () => $('deduct').close();
$('deduct-grams').oninput = () => { $('deduct-error').textContent = ''; };
$('deduct-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit.disabled) return;
  submit.disabled = true;
  const id = deducting;
  const grams = $('deduct-grams').valueAsNumber;
  let updated;
  try {
    await updateRecords(current => {
      const record = current.find(item => item.id === id);
      if (!record) throw new Error('找不到这条记录，请刷新豆库后重试。');
      const available = Math.round(Number(record.values.remaining) * 100);
      const used = Math.round(grams * 100);
      if (!Number.isSafeInteger(available) || !Number.isSafeInteger(used) || used < 1 || used > available) {
        throw new Error('请输入大于 0 且不超过当前余量（' + record.values.remaining + ' g）的克数。');
      }
      updated = {...record, values: {...record.values, remaining: String((available - used) / 100)}};
      return current.map(item => item.id === id ? updated : item);
    });
    $('deduct').close();
    renderLibrary();
    $('library-status').textContent = updated.values.name + '已扣减 ' + grams + ' g，剩余 ' + updated.values.remaining + ' g。';
  } catch (error) {
    $('deduct-error').textContent = error instanceof DOMException ? '扣减保存失败，请重试。' : error.message;
  } finally {
    submit.disabled = false;
  }
});

form.addEventListener('input', event => {
  const source = $(event.target.name + '-source');
  if (source) source.hidden = true;
  $('remaining').setCustomValidity('');
  updatePrice();
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
  try {
    await updateRecords(current => [{id, values}, ...current.filter(record => record.id !== id)]);
    $('library-status').textContent = '';
    renderLibrary();
    showLibrary(true);
  } catch {
    $('save-status').textContent = '保存失败，请检查浏览器的储存权限。';
  } finally {
    submit.disabled = false;
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
    for (const id of ['camera-open', 'gallery-open', 'library-toggle']) $(id).disabled = true;
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
      for (const [name, value] of Object.entries(fields)) {
        const input = $(name);
        if (!input.value) {
          input.value = value;
          $(name + '-source').hidden = false;
          filled++;
        } else if (input.value !== value) {
          conflicts++;
        }
      }
      updatePrice();
      $('scan-status').textContent = filled || conflicts
        ? '已填入 ' + filled + ' 项。' + (conflicts ? '有 ' + conflicts + ' 项与现有内容不同，请查看原文核对。' : '保存前请核对。')
        : '未找到可自动填写的字段。可以查看原文、重拍或手动输入。';
    } catch {
      $('scan-status').textContent = '识别失败。请检查网络，重拍、选用 JPEG 或手动填写。';
    } finally {
      busy = false;
      for (const id of ['camera-open', 'gallery-open', 'library-toggle']) $(id).disabled = false;
      form.querySelector('[type=submit]').disabled = false;
    }
  });
}
$('library-toggle').onclick = () => showLibrary($('library').hidden);
$('new-entry').onclick = () => openRecord();
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

