import {scanLabel} from './core/scan.mjs?v=6';
import {recordStock, flavorState, unitCost, undoStock, readBackup} from './core/journal.mjs?v=6';
import {createWorkspace} from './workspace.mjs?v=6';
import {createCamera, createImporter, componentEditor, recognizeFile} from './importer.mjs?v=5';
import {normalizeComponents} from './core/recognition.mjs';

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
    ['roastDate', '烘焙日期', 'date'],
  ],
  购买信息: [
    ['price', '价格（CNY）', 'number', '可选'],
    ['unitPrice', '单克价（CNY/g）', 'output'],
  ],
  包装信息: [
    ['roaster', '烘焙商'],
    ['roast', '烘焙程度', ['极浅烘', '浅烘', '中浅烘', '中烘', '中深烘', '深烘', '极深烘']],
    ['origin', '产地'], ['country', '产国'], ['region', '产区'], ['farm', '庄园'], ['station', '处理站'], ['batch', '批次'], ['variety', '豆种'],
    ['altitude', '海拔（m）'], ['process', '处理法'], ['flavors', '风味', 'text', '用顿号分隔'],
  ],
  自用记录: [
    ['rest', '养豆期（天）', 'number', '默认 7，可自行调整'], ['storage', '储存方式', ['常温', '冷冻', '在途']],
    ['freshDays', '赏味结束日（烘焙后天数）', 'number', '默认 60，可自行调整'],
    ['category', '用途分类', ['手冲', '意式', '全能']], ['group', '分组', 'text', '例如 日常、分享、收藏'],
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

const componentGroup = document.createElement('details');
componentGroup.className = 'optional-fields';
componentGroup.append(document.createElement('summary'));
componentGroup.firstChild.textContent = '拼配成分';
const components = componentEditor(componentGroup);
$('fields').append(componentGroup);
fieldLabels.set('components', '拼配成分');

const key = 'doudang-preview-records';
const draftKey = 'doudang-draft:';
let editing = null;
let originalValues = {};
let objectUrl;
let pendingCover;
let pendingBackCover;
let originalBackCover;
let originalCover;
let busy = false;
let records = [];
let deducting;
let stockConflict;
let scanController;
let review = {};
let workspace;
let importer;
let pendingImportId;

function readRecords() {
  const stored = JSON.parse(localStorage.getItem(key));
  return Array.isArray(stored) ? stored : [];
}

function withDataLock(action) {
  return navigator.locks ? navigator.locks.request(key, action) : action();
}

function updateRecords(update, commit) {
  return withDataLock(() => {
    const next = update(readRecords());
    const serialized = JSON.stringify(next);
    const write = () => localStorage.setItem(key, serialized);
    if (commit) commit(write);
    else write();
    records = next;
  });
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

function showLibrary(visible, focus = true) {
  workspace?.hide();
  $('editor').hidden = visible;
  $('library').hidden = !visible;
  $('brand').hidden = !visible;
  $('library-toggle').hidden = visible;
  $('app-nav').hidden = !visible;
  for (const button of $('app-nav').querySelectorAll('button')) {
    if (button.id === 'nav-library') button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (focus) $(visible ? 'library-title' : 'editor-title').focus({preventScroll: true});
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
    const dirty = pendingCover !== undefined || pendingBackCover !== undefined || Object.keys(review).length ||
      Object.keys(values).some(name => values[name] !== (originalValues[name] ?? ''));
    if (dirty) {
      localStorage.setItem(draftId(), JSON.stringify({values, originalValues, review, cover: pendingCover, backCover: pendingBackCover, importId: pendingImportId}));
    } else {
      localStorage.removeItem(draftId());
    }
    $('discard-draft').hidden = !dirty;
  } catch {
    $('save-status').textContent = '草稿无法保存在此设备，请先保存豆档。';
  }
}

function openRecord(record) {
  editing = record?.id ?? null;
  const draft = readDraft(editing);
  pendingImportId = record ? undefined : draft?.importId;
  pendingCover = draft?.cover;
  pendingBackCover = draft?.backCover;
  originalBackCover = record?.backCover;
  originalValues = draft?.originalValues ?? record?.values ?? {};
  review = draft?.review ?? {};
  $('discard-draft').hidden = !draft;
  form.reset();
  $('editor-title').textContent = record ? '编辑咖啡豆' : '添加咖啡豆';
  $('editor-intro').textContent = record ? record.values.name : '拍下包装标签，核对识别结果后保存。';
  $('unopened').hidden = Boolean(record);
  setCapture(!record);
  $('remaining').setCustomValidity('');
  $('save-status').textContent = draft ? '已恢复上次未保存的草稿。' : '';
  $('scan-status').textContent = '';
  $('raw').hidden = true;
  clearConflicts();
  originalCover = record?.cover;
  const cover = pendingCover ?? originalCover;
  photo.hidden = !cover;
  if (cover) photo.src = cover;
  else photo.removeAttribute('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  for (const label of form.querySelectorAll('small')) label.hidden = true;
  for (const details of form.querySelectorAll('.optional-fields')) details.open = false;
  for (const [name, value] of Object.entries(draft?.values ?? record?.values ?? {})) {
    if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
  }
  components.render($('components').value);
  for (const [name, result] of Object.entries(review)) {
    if (result.pending) showConflict($(name), result.suggested);
    else if ($(name).value === result.suggested) $(name + '-source').hidden = false;
  }
  updatePrice();
  renderReview();
  showStockConflict(record?.values.remaining);
  showLibrary(false);
}

function showStockConflict(current) {
  const proposed = $('remaining').value;
  stockConflict = current != null && current !== originalValues.remaining &&
    proposed !== originalValues.remaining && proposed !== current ? current : undefined;
  $('stock-conflict').hidden = stockConflict === undefined;
  if (stockConflict !== undefined) {
    $('stock-conflict-message').textContent = '当前库存 ' + current + ' g，草稿余量 ' + (proposed ? proposed + ' g' : '未填写') + '。请选择要保留的余量。';
  }
}

$('use-stock').onclick = () => resolveStock(true);
$('confirm-stock').onclick = () => resolveStock(false);

function resolveStock(useCurrent) {
  if (stockConflict === undefined) return;
  const input = $('remaining');
  if (!useCurrent && !input.reportValidity()) return;
  originalValues = {...originalValues, remaining: stockConflict};
  if (useCurrent) input.value = stockConflict;
  showStockConflict();
  $('save-status').textContent = useCurrent ? '已采用当前库存。' : '已确认新余量，请保存豆档。';
  saveDraft();
  input.focus();
}

$('discard-draft').onclick = () => {
  if (!busy) $('discard-confirm').showModal();
};
$('keep-draft').onclick = () => $('discard-confirm').close();
$('confirm-discard').onclick = () => {
  $('discard-confirm').close();
  try {
    const current = readRecords().find(record => record.id === editing);
    localStorage.removeItem(draftId());
    openRecord(current);
    $('save-status').textContent = '已丢弃草稿。';
  } catch {
    $('save-status').textContent = '无法丢弃草稿，请重试。';
  }
};

const formatGrams = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2, useGrouping: false});

function beanAge(date, now) {
  if (!date) return null;
  const roastDay = Date.parse(date);
  if (!Number.isFinite(roastDay) || new Date(roastDay).toISOString().slice(0, 10) !== date) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = (today - roastDay) / 86400000;
  return days >= 0 ? days : null;
}

function beanMetric(label, value) {
  const metric = document.createElement('span');
  if (label) {
    const description = document.createElement('span');
    description.className = 'sr-only';
    description.textContent = label;
    metric.append(description);
  }
  metric.append(value);
  return metric;
}

function beanFieldAction(record, field, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bean-field-action';
  button.textContent = text;
  button.setAttribute('aria-label', text + ' · ' + record.values.name);
  button.onclick = () => {
    openRecord(record);
    const input = $(field);
    const group = input.closest('details');
    if (group) group.open = true;
    input.focus();
  };
  return button;
}

let closeBeanActions;
let beanToDelete;

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.bean-row, dialog')) closeBeanActions?.();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeBeanActions?.(true);
});

function beanActionRow(card, controls, record) {
  const wrapper = document.createElement('div');
  wrapper.className = 'bean-row';
  const actions = document.createElement('div');
  actions.className = 'bean-actions';
  actions.inert = true;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'bean-more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', '更多操作 · ' + record.values.name);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.textContent = record.pinnedAt ? '取消置顶' : '置顶';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-button';
  remove.textContent = '删除';
  const actionName = document.createElement('div');
  actionName.className = 'bean-action-name';
  actionName.textContent = card.querySelector('.record').textContent;
  pin.setAttribute('aria-label', pin.textContent + ' · ' + record.values.name);
  remove.setAttribute('aria-label', '删除 · ' + record.values.name);
  const actionButtons = document.createElement('div');
  actionButtons.className = 'bean-action-buttons';
  actionButtons.append(pin, remove);
  actions.append(actionName, actionButtons);
  controls.append(more);
  wrapper.append(actions, card);

  function setOpen(open) {
    if (open && closeBeanActions !== close) closeBeanActions?.();
    wrapper.classList.toggle('is-open', open);
    actions.inert = !open;
    more.setAttribute('aria-expanded', String(open));
    closeBeanActions = open ? close : closeBeanActions === close ? undefined : closeBeanActions;
  }
  function close(returnFocus = false) {
    if (returnFocus || actions.contains(document.activeElement)) more.focus();
    setOpen(false);
  }
  setOpen(false);
  more.onclick = () => {
    if (actions.inert) {
      setOpen(true);
      pin.focus();
    } else close();
  };
  pin.onclick = async () => {
    pin.disabled = true;
    const pinnedAt = record.pinnedAt ? null : Date.now();
    try {
      await updateRecords(current => current.map(bean => bean.id === record.id ? {...bean, pinnedAt} : bean));
      renderLibrary();
      $('library-title').focus({preventScroll: true});
      $('library-status').textContent = (pinnedAt ? '已置顶 ' : '已取消置顶 ') + record.values.name;
    } catch {
      pin.disabled = false;
      $('library-status').textContent = '置顶状态未保存，请重试。';
    }
  };
  remove.onclick = () => {
    beanToDelete = record;
    $('delete-bean-message').textContent = '删除「' + record.values.name + '」及其照片、品鉴、库存历史和未保存草稿？';
    $('delete-bean-error').textContent = '';
    $('delete-bean').showModal();
  };

  let gesture;
  let suppressClickUntil = 0;
  card.addEventListener('pointerdown', event => {
    suppressClickUntil = 0;
    if (!event.isPrimary || event.button !== 0 || event.pointerType === 'mouse') return;
    if (closeBeanActions !== close) closeBeanActions?.();
    gesture = {id: event.pointerId, x: event.clientX, y: event.clientY, start: actions.inert ? 0 : actions.offsetWidth};
  });
  card.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    const x = event.clientX - gesture.x;
    const y = event.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.abs(y) > 9 && Math.abs(y) > Math.abs(x)) {
        gesture = undefined;
        return;
      }
      if (Math.abs(x) < 10 || Math.abs(x) <= Math.abs(y)) return;
      gesture.dragging = true;
      card.setPointerCapture(event.pointerId);
      wrapper.classList.add('is-dragging');
    }
    gesture.offset = Math.min(actions.offsetWidth, Math.max(0, gesture.start - x));
    card.style.setProperty('--drag-offset', -gesture.offset + 'px');
  });
  function endSwipe(event) {
    if (gesture?.id !== event.pointerId) return;
    if (gesture.dragging) {
      suppressClickUntil = Date.now() + 400;
      const threshold = actions.offsetWidth * (gesture.start > 0 ? 0.65 : 0.35);
      setOpen(event.type === 'pointerup' ? gesture.offset >= threshold : gesture.start > 0);
      wrapper.classList.remove('is-dragging');
      card.style.removeProperty('--drag-offset');
    }
    gesture = undefined;
  }
  card.addEventListener('pointerup', endSwipe);
  card.addEventListener('pointercancel', endSwipe);
  card.addEventListener('click', event => {
    if (event.detail && Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  return wrapper;
}

$('cancel-delete-bean').onclick = () => $('delete-bean').close();
$('confirm-delete-bean').onclick = async () => {
  const submit = $('confirm-delete-bean');
  if (submit.disabled || !beanToDelete) return;
  submit.disabled = true;
  const record = beanToDelete;
  try {
    await updateRecords(current => current.filter(bean => bean.id !== record.id));
    try { localStorage.removeItem(draftId(record.id)); } catch {}
    $('delete-bean').close();
    renderLibrary();
    $('library-title').focus({preventScroll: true});
    $('library-status').textContent = '已删除 ' + record.values.name;
  } catch {
    $('delete-bean-error').textContent = '删除失败，请重试。';
  } finally {
    submit.disabled = false;
  }
};

function renderLibrary() {
  closeBeanActions = undefined;
  const undo = records.find(record => record.undoDeduction);
  $('undo-deduct').hidden = !undo;
  if (undo) $('undo-deduct').textContent = '撤销减豆 · ' + undo.values.name;
  $('count').textContent = String(records.length);
  const stockTotal = records.reduce((total, {values}) => {
    const remaining = hundredths(values.remaining);
    return Number.isFinite(remaining) && remaining > 0 ? total + remaining : total;
  }, 0);
  $('stock-total').textContent = formatGrams.format(stockTotal / 100);
  $('new-entry').textContent = readDraft(null) ? '继续新增草稿' : '添加咖啡豆';
  $('library-tools').hidden = records.length === 0;
  $('library-filters').hidden = records.length === 0;
  const selectedGroup = $('group-filter').value;
  $('group-filter').replaceChildren(new Option('全部分组', ''), ...[...new Set(records.map(record => record.values.group).filter(Boolean))].sort().map(value => new Option(value, value)));
  $('group-filter').value = selectedGroup;
  $('entries').replaceChildren();
  const query = $('library-search').value.trim().toLowerCase();
  const filter = $('library-filter').value;
  const phase = $('phase-filter').value;
  const category = $('category-filter').value;
  const group = $('group-filter').value;
  const extraFilters = [phase, category, group].filter(Boolean).length;
  $('library-filters').querySelector('summary').textContent = '更多筛选' + (extraFilters ? ' · 已选 ' + extraFilters + ' 项' : '');
  const sort = $('library-sort').value;
  const visibleRecords = records.filter(({values}) => {
    const available = Number(values.remaining) > 0;
    return (!filter || available === (filter === 'available')) &&
      (!phase || flavorState(values).key === phase) && (!category || values.category === category) &&
      (!group || values.group === group) &&
      [values.name, values.origin, values.roaster].some(value => (value ?? '').toLowerCase().includes(query));
  }).sort((a, b) => {
    const pinned = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    if (pinned) return pinned;
    if (sort === 'remaining') return Number(b.values.remaining) - Number(a.values.remaining);
    if (sort === 'age') return (a.values.roastDate || '9999').localeCompare(b.values.roastDate || '9999');
    if (sort === 'price') return (unitCost(a.values) ?? Infinity) - (unitCost(b.values) ?? Infinity);
    if (sort === 'rating') return Number(b.values.rating || 0) - Number(a.values.rating || 0);
    if (sort === 'name') return a.values.name.localeCompare(b.values.name, 'zh-CN');
    return 0;
  });
  $('entries').classList.toggle('bean-grid', visibleRecords.length > 0);
  if (!visibleRecords.length) $('entries').textContent = records.length ? '没有符合条件的咖啡豆。' : '还没有保存的咖啡豆。';
  const now = new Date();
  for (const record of visibleRecords) {
    const {values} = record;
    const row = document.createElement('article');
    row.className = 'bean-card';
    const button = document.createElement('button');
    button.className = 'record';
    button.type = 'button';
    const media = document.createElement('span');
    media.className = 'bean-cover';
    if (record.cover) {
      const image = document.createElement('img');
      image.src = record.cover;
      image.alt = '';
      image.loading = 'lazy';
      media.append(image);
    } else {
      media.setAttribute('aria-hidden', 'true');
      media.textContent = Array.from(values.name.trim())[0] ?? '豆';
    }
    const brand = values.roaster?.trim();
    const name = values.name.trim();
    button.textContent = brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? brand + ' ' + name : name;
    button.onclick = () => workspace.openDetail(record);
    const remaining = Number(values.remaining);
    const weight = Number(values.weight);
    const stock = document.createElement('span');
    const stockAmount = document.createElement('strong');
    stockAmount.className = 'bean-remaining';
    stockAmount.textContent = formatGrams.format(remaining);
    stock.append(stockAmount, '/' + formatGrams.format(weight) + ' 克');
    const metrics = document.createElement('div');
    metrics.className = 'bean-metrics';
    const price = values.price != null && values.price !== '' && weight > 0
      ? (Number(values.price) / weight).toFixed(2) + ' 元/克'
      : beanFieldAction(record, 'price', '补填价格');
    const age = beanAge(values.roastDate, now);
    const ageValue = age === null
      ? beanFieldAction(record, 'roastDate', values.roastDate ? '核对烘焙日期' : '补填烘焙日期')
      : '养豆 ' + age + ' 天';
    metrics.append(beanMetric('', ageValue), beanMetric('剩余及总重量 ', stock), beanMetric('单克价 ', price));
    const context = [record.pinnedAt ? '已置顶' : '', values.origin, remaining === 0 ? '已用完' : '', readDraft(record.id) ? '有草稿' : ''].filter(Boolean);
    if (context.length) {
      const detail = document.createElement('small');
      detail.textContent = context.join(' · ');
      button.append(detail);
    }
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
    const controls = document.createElement('div');
    controls.className = 'bean-controls';
    controls.append(deduct);
    row.append(media, button, metrics, controls);
    if (remaining > 0) {
      const phase = document.createElement('small');
      phase.className = 'bean-phase';
      phase.textContent = flavorState(values).label;
      row.append(phase);
    }
    $('entries').append(beanActionRow(row, controls, record));
  }
  workspace?.refresh();
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
      const remaining = String((available - used) / 100);
      updated = {...recordStock(record, remaining, 'deduction', {id: token}), lastDose: grams, undoDeduction: {
        token, previous: record.values.remaining, remaining, previousDose: record.lastDose,
      }, values: {...record.values, remaining}};
      return current.map(item => item.id === id ? updated : item.undoDeduction ? {...item, undoDeduction: null} : item);
    });
    $('deduct').close();
    renderLibrary();
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
  const target = records.find(record => record.undoDeduction);
  if (!target || button.disabled) return;
  button.disabled = true;
  const {id, undoDeduction: {token, previous, remaining, previousDose}} = target;
  let restored = false;
  try {
    await updateRecords(current => current.map(record => {
      if (record.id !== id || record.undoDeduction?.token !== token) return record;
      restored = record.values.remaining === remaining && Number(previous) <= Number(record.values.weight);
      return restored
        ? {...((record.history ?? []).some(item => item.id === token)
          ? undoStock(record, token) : {...record, values: {...record.values, remaining: previous}}), undoDeduction: null, lastDose: previousDose}
        : {...record, undoDeduction: null};
    }));
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

function renderReview() {
  const entries = Object.entries(review);
  const pending = entries.filter(([, result]) => result.pending).length;
  $('ocr-review').hidden = !entries.length;
  $('ocr-progress').textContent = pending ? '还有 ' + pending + ' 项差异待核对。' : '没有待核对的差异，点击字段可查看。';
  const links = $('ocr-fields');
  links.replaceChildren();
  for (const [name, result] of entries) {
    const input = $(name);
    const group = input.closest('details');
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = fieldLabels.get(name) + (result.pending ? ' · 待核对' : '');
    link.onclick = () => {
      if (group) group.open = true;
      if (input.id === 'components') components.focus(); else input.focus();
    };
    links.append(link);
  }
  for (const [title, fields] of Object.entries(groups)) {
    const summary = $('group-' + title).closest('details')?.querySelector('summary');
    if (!summary) continue;
    const count = fields.filter(([name]) => review[name]).length;
    summary.textContent = title + (count ? ' · ' + count + ' 项识别结果' : '');
  }
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
    review[input.name].pending = false;
    conflict.remove();
    renderReview();
    saveDraft();
    input.focus();
  };
  const use = document.createElement('button');
  use.type = 'button';
  use.textContent = '采用识别值';
  use.onclick = () => {
    review[input.name].pending = false;
    conflict.remove();
    input.value = suggested;
    if (input.id === 'components') components.render(input.value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    $(input.name + '-source').hidden = false;
    review[input.name] = {suggested, pending: false};
    renderReview();
    saveDraft();
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
  for (let group = event.target.closest('details'); group; group = group.parentElement?.closest('details')) {
    group.open = true;
  }
}, true);
form.addEventListener('input', event => {
  const source = $(event.target.name + '-source');
  if (source) source.hidden = true;
  if (review[event.target.name]?.pending) {
    event.target.closest('.field').querySelector('.ocr-conflict').firstChild.textContent =
      fieldLabels.get(event.target.name) + ' · 当前「' + event.target.value + '」，识别为「' + review[event.target.name].suggested + '」。';
  }
  if (event.target.id === 'remaining' && stockConflict !== undefined) showStockConflict(stockConflict);
  $('remaining').setCustomValidity('');
  updatePrice();
  saveDraft();
});
$('deleted-editor-back').onclick = () => {
  try {
    records = readRecords();
  } catch {
    $('deleted-editor').close();
    $('save-status').textContent = '暂时无法读取豆库，请重试。';
    return;
  }
  $('deleted-editor').close();
  renderLibrary();
  showLibrary(true);
};

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const pending = Object.keys(review).find(name => review[name].pending);
  if (pending) {
    $('save-status').textContent = '请先处理识别差异，再保存豆档。';
    const input = $(pending);
    const group = input.closest('details');
    if (group) group.open = true;
    input.closest('.field').querySelector('.ocr-conflict button').focus();
    return;
  }
  if ($('remaining').valueAsNumber > $('weight').valueAsNumber) {
    $('remaining').setCustomValidity('剩余重量不能超过总重量。');
    $('remaining').reportValidity();
    return;
  }
  const values = Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]));
  try {
    const blend = normalizeComponents(values.components);
    values.components = blend.length ? JSON.stringify(blend) : '';
  } catch (error) { $('save-status').textContent = error.message; componentGroup.open = true; components.focus(); return; }
  const rest = values.rest === '' ? 7 : Number(values.rest);
  const end = values.freshDays === '' ? 60 : Number(values.freshDays);
  if (end < rest) { $('save-status').textContent = '赏味结束日须不早于养豆结束日。'; return; }
  if (!values.name) {
    $('save-status').textContent = '请输入咖啡豆名称。';
    $('name').focus();
    return;
  }
  const submit = event.submitter;
  const saveButton = form.querySelector('[type=submit]');
  if (saveButton.disabled || submit.disabled) return;
  const asNew = submit.id === 'save-as-new';
  const sourceId = editing;
  const id = (asNew ? null : sourceId ?? pendingImportId) ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
  const deleted = new Error('Bean was deleted');
  submit.disabled = true;
  saveButton.disabled = true;
  $('library-toggle').disabled = true;
  try {
    await updateRecords(current => {
      const existing = current.find(record => record.id === id);
      if (asNew || !sourceId) {
        if (existing && pendingImportId === id) {
          if (Object.entries(values).every(([key,value]) => value === (existing.values[key] ?? ''))) return current;
          throw new Error('这颗豆已从其他页面入库，请返回豆库打开它继续编辑。当前草稿已保留。');
        }
        return [{id, values, cover: pendingCover ?? originalCover, backCover: pendingBackCover ?? originalBackCover}, ...current];
      }
      if (!existing) throw deleted;
      const changes = Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== (originalValues[name] ?? '')));
      if ('remaining' in changes && existing.values.remaining !== originalValues.remaining && changes.remaining !== existing.values.remaining) {
        showStockConflict(existing.values.remaining);
        $('stock-conflict-title').focus();
        throw new Error('这包豆的余量已更新。当前为 ' + existing.values.remaining + ' g，请核对后再保存。');
      }
      const merged = {...existing.values, ...changes};
      if (Number(merged.remaining) > Number(merged.weight)) {
        throw new Error('当前余量超过你填写的总重量，请核对后再保存。');
      }
      const adjusted = merged.remaining === existing.values.remaining ? existing : recordStock({...existing, values: {...existing.values, weight: merged.weight}}, merged.remaining, 'adjustment');
      return current.map(record => record.id === id ? {
        ...adjusted, values: merged, cover: pendingCover ?? existing.cover, backCover: pendingBackCover ?? existing.backCover,
        undoDeduction: merged.remaining === existing.values.remaining && Number(merged.weight) >= Number(existing.undoDeduction?.previous)
          ? existing.undoDeduction : null,
      } : record);
    });
    try { localStorage.removeItem(draftId(sourceId)); } catch {}
    if ($('deleted-editor').open) $('deleted-editor').close();
    importer?.markSaved(records.find(record => record.id === id));
    $('library-status').textContent = '已保存豆档。';
    renderLibrary();
    showLibrary(true);
  } catch (error) {
    if (error === deleted) $('deleted-editor').showModal();
    else {
      if ($('deleted-editor').open) $('deleted-editor').close();
      $('save-status').textContent = error instanceof DOMException ? '保存失败，请检查浏览器的储存权限。' : error.message;
    }
  } finally {
    submit.disabled = false;
    saveButton.disabled = false;
    $('library-toggle').disabled = false;
  }
});

let nativeCameraCallback;
const liveCamera = createCamera({nativeInput: $('camera'), onNative: callback => { nativeCameraCallback = callback; }});
$('camera').addEventListener('cancel', () => { nativeCameraCallback = undefined; });
$('camera-open').onclick = () => liveCamera.open(file => handlePhoto(file, 'camera'));
$('gallery-open').onclick = () => $('gallery').click();
$('cover-open').onclick = () => $('cover-file').click();
$('back-open').onclick = () => $('back-file').click();
$('cancel-scan').onclick = () => {
  scanController.abort();
  scanController = undefined;
  setScanBusy(false);
  $('scan-status').textContent = '已停止识别。';
  $('manual-entry').click();
};

function setScanBusy(value) {
  busy = value;
  for (const id of ['camera-open', 'gallery-open', 'cover-open', 'back-open', 'manual-entry', 'library-toggle']) $(id).disabled = value;
  form.querySelector('[type=submit]').disabled = value;
  $('cancel-scan').hidden = !value;
}

function applyRecognition(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!fieldLabels.has(name) || typeof value !== 'string' || !value) continue;
    const input = $(name);
    if (name === 'remaining' && (editing || input.value)) continue;
    input.closest('.field').querySelector('.ocr-conflict')?.remove();
    review[name] = {suggested: value, pending: Boolean(input.value && input.value !== value)};
    if (!input.value) {
      input.value = value;
      if (name === 'components') components.render(value);
      $(name + '-source').hidden = false;
    } else if (review[name].pending) {
      showConflict(input, value);
      const group = input.closest('details');
      if (group) group.open = true;
    }
  }
  updatePrice();
  renderReview();
  saveDraft();
}

function photoCanvas(maxSide) {
  const scale = Math.min(1, maxSide / Math.max(photo.naturalWidth, photo.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(photo, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function saveCover(back = false) {
  let maxSide = 320;
  while (maxSide >= 80) {
    const cover = photoCanvas(maxSide).toDataURL('image/jpeg', 0.8);
    if (cover.startsWith('data:image/jpeg;base64,') && cover.length <= 28000) {
      if (back) pendingBackCover = cover;
      else pendingCover = cover;
      saveDraft();
      return true;
    }
    maxSide = Math.floor(maxSide * 0.7);
  }
}

async function handlePhoto(file, id) {
    if (!file || busy) return;
    const controller = new AbortController();
    scanController = controller;
    setScanBusy(true);
    $('raw').hidden = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    photo.src = objectUrl;
    photo.hidden = false;
    const coverOnly = id === 'cover-file' || id === 'back-file';
    $('scan-status').textContent = coverOnly ? '正在处理豆袋照片…' : 'GLM 正在识别豆袋…';
    try {
      await photo.decode();
      if (controller.signal.aborted) return;
      const coverSaved = saveCover(id === 'back-file');
      if (coverOnly) {
        $('scan-status').textContent = coverSaved ? (id === 'back-file' ? '已添加背面照片，保存后可在详情查看。' : '已添加豆袋图，保存后会显示在磁贴上。') : '无法生成豆袋缩略图，请换一张照片。';
        return;
      }
      let result;
      try {
        result = await recognizeFile(file, controller.signal);
      } catch {
        // Local OCR also works when the model endpoint is unavailable.
      }
      if (controller.signal.aborted) return;
      if (result?.raw) { $('raw-text').textContent = result.raw; $('raw').hidden = false; }
      if (result?.beans.length > 1) {
        importer.openResults(result,file);
        $('scan-status').textContent = '图片中识别到多颗豆，请在导入窗口分别核对。';
        return;
      }
      if (result?.beans.length === 1 && Object.keys(result.beans[0].fields).length) {
        applyRecognition(result.beans[0].fields);
        $('scan-status').textContent = 'GLM 已识别并填写字段，请核对后保存。';
        return;
      }
      $('scan-status').textContent = 'GLM 未返回可用结果，正在转用本地 OCR…';
      const {default: {createWorker}} = await import('./vendor/ocr/tesseract.esm.min.js');
      if (controller.signal.aborted) return;
      const {text, fields} = await scanLabel(file, createWorker, progress => {
        if (!controller.signal.aborted) $('scan-status').textContent = '正在识别 ' + Math.round(progress * 100) + '%';
      }, controller.signal);
      if (controller.signal.aborted) return;
      $('raw-text').textContent = text;
      $('raw').hidden = !text.trim();
      applyRecognition(fields);
      $('scan-status').textContent = Object.keys(fields).length
        ? '识别完成。可在「核对识别结果」中查看字段。'
        : '未找到可自动填写的字段。可以查看原文、重拍或手动输入。';
    } catch {
      if (!controller.signal.aborted) $('scan-status').textContent = '识别失败。请检查网络，重拍、选用 JPEG 或手动填写。';
    } finally {
      if (scanController === controller) {
        scanController = undefined;
        setScanBusy(false);
      }
    }
}
for (const id of ['camera', 'gallery', 'cover-file', 'back-file']) {
  $(id).addEventListener('change', event => {
    const file = event.target.files[0]; event.target.value = '';
    if (id === 'camera' && nativeCameraCallback) {
      const callback = nativeCameraCallback; nativeCameraCallback = undefined;
      if (file) void callback(file);
      return;
    }
    void handlePhoto(file,id);
  });
}
$('library-toggle').onclick = () => {
  renderLibrary();
  showLibrary(true);
};
$('new-entry').onclick = () => openRecord();
$('library-search').oninput = renderLibrary;
$('library-filter').onchange = renderLibrary;
for (const id of ['library-sort','phase-filter','category-filter','group-filter']) $(id).onchange = renderLibrary;
workspace = createWorkspace({
  getRecords: () => records,
  mutate: async (update, commit) => { await updateRecords(update, commit); renderLibrary(); },
  withDataLock,
  openEditor: openRecord,
  openLibrary: () => { records = readRecords(); renderLibrary(); showLibrary(true); },
  fieldLabels,
});
importer = createImporter({
  camera: liveCamera,
  importRecords: async incoming => {
    const validated = readBackup(JSON.stringify(incoming));
    for (const record of validated) {
      const start = record.values.rest === '' || record.values.rest == null ? 7 : Number(record.values.rest);
      const end = record.values.freshDays === '' || record.values.freshDays == null ? 60 : Number(record.values.freshDays);
      if (end < start) throw new Error('「' + record.values.name + '」的赏味结束日早于养豆期，请在完整表单中核对。');
    }
    await updateRecords(current => [...validated.filter(record => !current.some(existing => existing.id === record.id)), ...current]);
    renderLibrary(); showLibrary(true);
    return validated;
  },
  onImported: openRecord,
  onReview: bean => {
    openRecord();
    pendingImportId = bean.id;
    if (bean.cover) { pendingCover = bean.cover; photo.src = bean.cover; photo.hidden = false; }
    applyRecognition(bean.fields);
  },
});
window.addEventListener('storage', event => {
  if (event.key === key) {
    try { records = readRecords(); renderLibrary(); }
    catch { $('library-status').textContent = '读取更新失败，请重新打开应用。'; }
  }
});
renderLibrary();
if (records.length) showLibrary(true, false);
else if (readDraft(null)) openRecord();

