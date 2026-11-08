import {units, uid, localDate, roastAge, flavorState, unitCost, undoStock,
  saveTasting, deleteTasting, consumptionEvents, readBackup, mergeBackup} from './core/journal.mjs?v=6';
import {normalizeComponents} from './core/recognition.mjs';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const grams = value => number.format(value) + ' g';
const money = value => '¥' + number.format(value);
const dateTime = value => new Date(value).toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const DIMENSIONS = {acidity: '酸度', sweetness: '甜感', bitterness: '苦感', body: '醇厚度'};
const RECIPE_KEY = 'doudang-recipes-v1';
const SESSION_KEY = 'doudang-brew-session';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, handler, className = '') {
  const element = node('button', text, className);
  element.type = 'button';
  element.onclick = handler;
  return element;
}

function definition(list, label, value) {
  if (value == null || value === '') return;
  list.append(node('dt', label), node('dd', String(value)));
}

function readRecipes(stored = localStorage.getItem(RECIPE_KEY)) {
  return validateRecipes(JSON.parse(stored) ?? []);
}

function validateRecipes(recipes) {
  if (!Array.isArray(recipes)) throw new Error('冲煮方案格式无效。');
  return recipes.map(recipe => {
    if (typeof recipe.id !== 'string' || typeof recipe.name !== 'string' || !recipe.name.trim() ||
        !(Number(recipe.dose) > 0) || !(Number(recipe.water) > 0)) throw new Error('冲煮方案参数无效。');
    validateStages(recipe.stages, Number(recipe.water));
    return {id: recipe.id, name: recipe.name, dose: Number(recipe.dose), water: Number(recipe.water),
      temp: String(recipe.temp ?? ''), grind: String(recipe.grind ?? ''), equipment: String(recipe.equipment ?? ''),
      stages: recipe.stages.map(stage => ({end: Number(stage.end), water: Number(stage.water)}))};
  });
}

function mergeRecipes(current, incoming) {
  const content = ({id, ...recipe}) => JSON.stringify(recipe);
  const next = [...current];
  for (const recipe of incoming) {
    if (next.some(item => content(item) === content(recipe))) continue;
    next.push(next.some(item => item.id === recipe.id) ? {...recipe, id: uid()} : recipe);
  }
  return next;
}

function validateStages(stages, water) {
  if (!Array.isArray(stages) || !stages.length || stages.length > 12) throw new Error('请设置 1 到 12 个冲煮阶段。');
  let previousTime = 0;
  let previousWater = 0;
  for (const stage of stages) {
    if (!Number.isInteger(stage.end) || stage.end <= previousTime || stage.end > 3600 ||
        !Number.isFinite(stage.water) || stage.water < previousWater || stage.water > water) {
      throw new Error('各段结束时间须递增且不超过 3600 秒，累计水量须递增且不超过总水量。');
    }
    previousTime = stage.end;
    previousWater = stage.water;
  }
  if (previousWater !== water) throw new Error('最后一段的累计水量应等于总水量。');
}

function downloadFile(fileName, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const link = node('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function createWorkspace({getRecords, mutate, withDataLock, openEditor, openLibrary, fieldLabels}) {
  let active = '';
  let selectedId;
  let tastingContext;
  let pendingImport;
  let backupRead = 0;
  let confirmAction;
  let recipes = [];
  try { recipes = readRecipes(); } catch {}
  let session;
  let lastAnnouncement;
  const sections = ['bean-detail', 'statistics', 'brewing', 'data-page'];

  async function changeBean(id, transform) {
    await mutate(records => {
      if (!records.some(record => record.id === id)) throw new Error('这包豆已被删除，请返回豆库。');
      return records.map(record => record.id === id ? transform(record) : record);
    });
  }

  async function perform(element, errorId, callback) {
    if (element.disabled) return;
    element.disabled = true;
    $(errorId).textContent = '';
    try { await callback(); }
    catch (error) { if (error.name !== 'AbortError') $(errorId).textContent = error instanceof DOMException ? '未能保存，请检查储存空间后重试。' : error.message; }
    finally { element.disabled = false; }
  }

  function hide() {
    for (const id of sections) $(id).hidden = true;
    active = '';
    $('nav-context').textContent = '';
  }

  function show(id) {
    hide();
    active = id;
    $('editor').hidden = $('library').hidden = true;
    $(id).hidden = false;
    $('app-nav').hidden = false;
    $('brand').hidden = true;
    $('library-toggle').hidden = false;
    $('nav-context').textContent = id === 'bean-detail' ? '豆档详情' : '';
    for (const item of $('app-nav').querySelectorAll('button')) {
      if (item.id === 'nav-' + id || (id === 'bean-detail' && item.id === 'nav-library')) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    refresh();
    window.scrollTo(0, 0);
    $(id).querySelector('h1').focus({preventScroll: true});
  }

  function openDetail(record) {
    selectedId = record.id;
    $('detail-feedback').textContent = '';
    show('bean-detail');
  }

  function selectedBean() {
    const bean = getRecords().find(record => record.id === selectedId);
    if (!bean) throw new Error('这包豆已被删除，请返回豆库。');
    return bean;
  }

  function confirmation(title, text, action) {
    confirmAction = action;
    $('action-confirm-title').textContent = title;
    $('action-confirm-text').textContent = text;
    $('action-confirm-ok').classList.toggle('danger-button', title.startsWith('删除'));
    $('action-confirm-error').textContent = '';
    $('action-confirm').showModal();
  }

  $('action-confirm-cancel').onclick = () => $('action-confirm').close();
  $('action-confirm-ok').onclick = event => perform(event.currentTarget, 'action-confirm-error', async () => {
    $('action-confirm-cancel').disabled = true;
    try { await confirmAction(); $('action-confirm').close(); }
    finally { $('action-confirm-cancel').disabled = false; }
  });
  $('action-confirm').addEventListener('cancel', event => {
    if ($('action-confirm-ok').disabled) event.preventDefault();
  });

  function renderDetail() {
    let record;
    try { record = selectedBean(); } catch { openLibrary(); return; }
    const values = record.values;
    $('detail-title').textContent = values.name;
    $('detail-state').textContent = [values.roaster, flavorState(values).label].filter(Boolean).join(' · ');
    const overview = $('detail-overview');
    overview.replaceChildren();
    const images = node('div', null, 'detail-images');
    for (const [image, label] of [[record.cover, '豆袋正面'], [record.backCover, '豆袋背面']]) {
      if (!image) continue;
      const img = node('img');
      img.src = image;
      img.alt = label;
      images.append(img);
    }
    if (images.children.length) overview.append(images);
    const stock = node('dl', null, 'detail-numbers');
    definition(stock, '剩余 / 总量', number.format(values.remaining) + ' / ' + grams(values.weight));
    const age = roastAge(values.roastDate);
    definition(stock, '烘焙至今', age == null || age < 0 ? '待核对日期' : age + ' 天');
    const cost = unitCost(values);
    definition(stock, '单克价', cost == null ? '未填写价格' : money(cost) + '/g');
    overview.append(stock);
    const fields = $('detail-fields');
    fields.replaceChildren();
    for (const [key, label] of fieldLabels) {
      if (['remaining','weight','unitPrice'].includes(key)) continue;
      if (key === 'components') {
        for (const [index, component] of normalizeComponents(values.components).entries()) {
          definition(fields, '成分 ' + (index + 1), Object.entries(component).map(([key,value]) => ({percentage:'比例',origin:'产地',country:'产国',region:'产区',farm:'庄园',station:'处理站',process:'处理法',variety:'品种',altitude:'海拔',batch:'批次'}[key] ?? key) + ' ' + value + (key === 'percentage' ? '%' : '')).join(' · '));
        }
        continue;
      }
      definition(fields, label, values[key]);
    }
    definition(fields, '参考赏味窗口', '烘焙后 ' + (values.rest || '7') + '–' + (values.freshDays || '60') + ' 天，可在编辑资料中调整');
    if (!fields.children.length) fields.append(node('p', '暂无更多资料。'));
    renderTastings(record);
    renderHistory(record);
  }

  function renderTastings(record) {
    const list = $('tasting-list');
    list.replaceChildren();
    const notes = [...(record.tastings ?? [])].sort((a, b) => b.at - a.at);
    if (!notes.length) list.append(node('p', '还没有品鉴记录。记下每一杯的参数与感受，之后可以回看对比。', 'supporting'));
    for (const note of notes) {
      const item = node('article', null, 'journal-item');
      item.append(node('h3', dateTime(note.at) + (note.rating ? ' · ' + note.rating + '/5 分' : '')));
      const params = note.params ?? {};
      item.append(node('p', [grams(note.dose) + ' 用豆', params.equipment, params.water ? params.water + ' g 水' : '',
        params.temp ? params.temp + '°C' : '', params.grind, params.recipe].filter(Boolean).join(' · '), 'supporting'));
      if (note.text) item.append(node('p', note.text));
      const dimensions = node('dl', null, 'taste-comparison');
      for (const [key, label] of Object.entries(DIMENSIONS)) {
        const value = note.taste?.[key] ?? 0;
        definition(dimensions, label, value ? value + '/5' : '未评');
      }
      item.append(dimensions, button('编辑品鉴', () => openTasting(record, note), 'text-action'),
        button('删除品鉴', () => confirmation('删除这次品鉴？', '同时退回这次记录的 ' + grams(note.dose) + ' 用豆。', async () => {
          await changeBean(record.id, current => deleteTasting(current, note.id, note.updatedAt));
        }), 'text-action'));
      list.append(item);
    }
  }

  function renderHistory(record) {
    const list = $('stock-history');
    list.replaceChildren();
    const history = [...(record.history ?? [])].sort((a, b) => b.at - a.at);
    if (!history.length) list.append(node('p', '还没有库存变动记录。原有余量已保留，后续消耗会显示在这里。', 'supporting'));
    const names = {deduction: '减豆', adjustment: '库存调整', tasting: '品鉴用豆', brew: '冲煮用豆'};
    for (const event of history) {
      const item = node('article', null, 'journal-item');
      const change = event.grams >= 0 ? '−' + grams(event.grams) : '+' + grams(-event.grams);
      item.append(node('h3', names[event.type] + ' · ' + change + (event.voidedAt ? ' · 已撤销' : '')),
        node('p', dateTime(event.at) + (event.unitCost != null && event.type !== 'adjustment' ? ' · ' + money(event.grams * event.unitCost) : ''), 'supporting'));
      if (event.note) item.append(node('p', event.note));
      if (!event.voidedAt && event.type !== 'tasting') item.append(button('撤销这次变动', () => {
        confirmation('撤销这次变动？', '会在当前余量上恢复这次变动的克数，并重新计算统计。',
          () => changeBean(record.id, current => undoStock(current, event.id)));
      }, 'text-action'));
      list.append(item);
    }
  }

  $('detail-edit').onclick = () => openEditor(selectedBean());
  $('detail-taste').onclick = () => openTasting(selectedBean());
  $('detail-repurchase').onclick = () => confirmation('续购一包？', '复制包装资料，建立一包满余量的新豆档。烘焙日期、评分和历史由新批次重新记录。', async () => {
    const bean = selectedBean();
    const newBean = {id: uid(), values: {...bean.values, remaining: bean.values.weight, roastDate: '', rating: '', notes: ''},
      cover: bean.cover, backCover: bean.backCover};
    await mutate(current => [newBean, ...current]);
    openEditor(newBean);
  });
  $('detail-share').onclick = event => perform(event.currentTarget, 'detail-feedback', async () => {
    const bean = selectedBean();
    const text = [bean.values.name, bean.values.roaster, bean.values.origin, bean.values.flavors,
      '烘焙日期 ' + (bean.values.roastDate || '未填写'), '剩余 ' + grams(bean.values.remaining)].filter(Boolean).join('\n');
    if (navigator.share) await navigator.share({title: bean.values.name, text});
    else { await navigator.clipboard.writeText(text); $('detail-feedback').textContent = '豆档文字已复制。'; }
  });

  for (const [key, label] of Object.entries(DIMENSIONS)) {
    const caption = node('label', label);
    const input = node('select');
    input.id = 'taste-' + key;
    input.append(new Option('未评', '0'), ...[1,2,3,4,5].map(value => new Option(String(value), String(value))));
    caption.append(input);
    $('taste-dimensions').append(caption);
  }

  function openTasting(record, note, brew) {
    tastingContext = {beanId: record.id, id: note?.id ?? brew?.noteId ?? uid(), expected: note?.updatedAt ?? null, params: note?.params ?? {}, brew};
    $('tasting-form').reset();
    $('tasting-title').textContent = note ? '编辑品鉴' : '记录品鉴';
    $('tasting-bean').textContent = record.values.name + ' · 当前剩余 ' + grams(record.values.remaining);
    const time = new Date(note?.at ?? Date.now());
    $('tasting-date').value = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('tasting-dose').value = note?.dose ?? brew?.dose ?? 0;
    $('tasting-rating').value = note?.rating ?? '0';
    $('tasting-text').value = note?.text ?? '';
    for (const key of Object.keys(DIMENSIONS)) $('taste-' + key).value = note?.taste?.[key] ?? '0';
    for (const key of ['equipment','water','temp','grind']) $('tasting-' + key).value = note?.params?.[key] ?? brew?.[key] ?? '';
    $('tasting-error').textContent = '';
    $('tasting-dialog').showModal();
  }

  $('tasting-cancel').onclick = () => $('tasting-dialog').close();
  $('tasting-dialog').addEventListener('cancel', event => {
    if ($('tasting-form').querySelector('[type=submit]').disabled) event.preventDefault();
  });
  $('tasting-form').onsubmit = event => {
    event.preventDefault();
    const context = tastingContext;
    const note = {
      id: context.id, at: Date.parse($('tasting-date').value), dose: $('tasting-dose').valueAsNumber,
      rating: Number($('tasting-rating').value), text: $('tasting-text').value.trim(),
      taste: Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, Number($('taste-' + key).value)])),
      params: {...context.params, ...Object.fromEntries(['equipment','water','temp','grind'].map(key => [key, $('tasting-' + key).value.trim()]))},
    };
    if (context.brew) Object.assign(note.params, {duration: String(context.brew.duration), recipe: context.brew.recipe});
    return perform(event.submitter, 'tasting-error', async () => {
      $('tasting-cancel').disabled = true;
      try {
        await changeBean(context.beanId, record => saveTasting(record, note, context.expected));
        $('tasting-dialog').close();
        if (context.brew) {
          session = undefined;
          try { saveSession(); } catch {}
          renderTimer();
        }
        openDetail(getRecords().find(record => record.id === context.beanId));
        $('detail-feedback').textContent = '品鉴已保存，库存已同步。';
      } finally { $('tasting-cancel').disabled = false; }
    });
  };

  function renderStats() {
    const records = getRecords();
    const days = $('stats-range').value;
    const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 86400000;
    const all = consumptionEvents(records);
    const events = all.filter(event => event.at >= cutoff && event.at <= Date.now());
    const total = events.reduce((sum, event) => sum + units(event.grams), 0) / 100;
    const priced = events.filter(event => event.unitCost != null);
    const cost = priced.reduce((sum, event) => sum + event.grams * event.unitCost, 0);
    const stock = records.reduce((sum, record) => sum + units(record.values.remaining), 0) / 100;
    const stockValue = records.reduce((sum, record) => sum + Number(record.values.remaining) * (unitCost(record.values) ?? 0), 0);
    const recent = all.filter(event => event.at >= Date.now() - 30 * 86400000 && event.at <= Date.now());
    const observedDays = recent.length ? Math.max(1, Math.min(30, Math.ceil((Date.now() - Math.min(...recent.map(event => event.at))) / 86400000))) : 0;
    const daily = observedDays ? recent.reduce((sum, event) => sum + event.grams, 0) / observedDays : 0;
    const overview = $('stats-overview');
    overview.replaceChildren();
    for (const [label, value] of [['记录消耗', grams(total)], ['记录花费', money(cost)],
      ['当前库存', grams(stock)], ['有价格的库存价值', money(stockValue)], ['日均消耗', daily ? grams(daily) : '暂无记录'],
      ['库存预计可用', daily ? Math.ceil(stock / daily) + ' 天' : '待积累消耗记录']]) {
      const metric = node('div', null, 'stat');
      metric.append(node('span', label), node('strong', value));
      overview.append(metric);
    }
    const unknown = events.length - priced.length;
    $('stats-coverage').textContent = '统计以本次更新后记录的实际用量为准。' + (unknown ? unknown + ' 次消耗缺价格，未计入花费。' : '') +
      '库存预测按近 30 天内已记录时段估算，未记录的用量无法纳入。';
    const chart = $('consumption-chart');
    chart.replaceChildren();
    const buckets = new Map();
    for (const event of events) {
      const date = localDate(new Date(event.at));
      buckets.set(date, (buckets.get(date) ?? 0) + event.grams);
    }
    const points = [...buckets].sort((a,b) => a[0].localeCompare(b[0])).slice(-14);
    const max = Math.max(1, ...points.map(([,value]) => value));
    if (!points.length) chart.append(node('p', '记录减豆或品鉴后，这里会显示每天的消耗。', 'supporting'));
    for (const [date, value] of points) {
      const item = node('div', null, 'chart-row');
      const meter = node('progress');
      meter.max = max; meter.value = value; meter.setAttribute('aria-label', date + ' 消耗 ' + grams(value));
      item.append(node('span', date.slice(5)), meter, node('span', grams(value)));
      chart.append(item);
    }
    const ranking = $('bean-ranking');
    ranking.replaceChildren();
    const rated = records.map(record => {
      const scores = (record.tastings ?? []).filter(note => note.rating > 0);
      const rating = scores.length ? scores.reduce((sum, note) => sum + note.rating, 0) / scores.length : Number(record.values.rating || 0);
      return {record, rating, count: scores.length};
    }).filter(item => item.rating > 0).sort((a,b) => b.rating - a.rating);
    if (!rated.length) ranking.append(node('p', '为豆档或品鉴评分后，这里会显示个人榜单。', 'supporting'));
    for (const {record, rating, count} of rated) ranking.append(button(record.values.name + ' · ' + number.format(rating) + '/5' + (count ? ' · ' + count + ' 次品鉴' : ' · 豆档评级'), () => openDetail(record), 'ranking-row'));
    const recentList = $('recent-consumption');
    recentList.replaceChildren();
    for (const event of [...events].sort((a,b)=>b.at-a.at).slice(0,20)) {
      const record = records.find(item => item.id === event.beanId);
      recentList.append(button(event.beanName + ' · ' + grams(event.grams) + ' · ' + dateTime(event.at), () => openDetail(record), 'ranking-row'));
    }
    if (!events.length) recentList.append(node('p', '当前范围内暂无消耗记录。', 'supporting'));
  }

  $('stats-range').onchange = renderStats;

  $('backup-export').onclick = event => perform(event.currentTarget, 'data-feedback', async () => {
    downloadFile('豆档备份-' + localDate() + '.json', {format: 'doudang', version: 1, exportedAt: new Date().toISOString(), records: getRecords(), recipes: readRecipes()});
    $('data-feedback').textContent = '备份文件已生成，请保存下载的 JSON 文件。';
  });
  $('backup-file').onchange = async event => {
    const read = ++backupRead;
    pendingImport = undefined;
    $('import-preview').hidden = true;
    $('data-feedback').textContent = '';
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error('请选择小于 40 MB 的备份文件。');
      const text = await file.text();
      if (read !== backupRead) return;
      const incoming = readBackup(text);
      const importedRecipes = validateRecipes(JSON.parse(text).recipes ?? []);
      pendingImport = {records: incoming, recipes: importedRecipes};
      $('import-summary').textContent = '已校验 ' + incoming.length + ' 份豆档、' + incoming.reduce((sum, record) => sum + record.tastings.length, 0) + ' 次品鉴和 ' + importedRecipes.length + ' 个方案。';
      $('import-preview').hidden = false;
    } catch (error) {
      if (read === backupRead) $('data-feedback').textContent = error.message;
    }
  };
  $('backup-cancel').onclick = () => {
    backupRead++;
    pendingImport = undefined;
    $('import-preview').hidden = true;
    $('backup-file').value = '';
  };
  $('backup-confirm').onclick = event => perform(event.currentTarget, 'data-feedback', async () => {
    if (!pendingImport) return;
    const imported = pendingImport;
    $('backup-file').disabled = $('backup-cancel').disabled = true;
    try {
      await mutate(current => mergeBackup(current, imported.records), writeRecords => {
        const previous = localStorage.getItem(RECIPE_KEY);
        const current = readRecipes(previous);
        const merged = mergeRecipes(current, imported.recipes);
        const changed = merged.length !== current.length;
        if (changed) localStorage.setItem(RECIPE_KEY, JSON.stringify(merged));
        try {
          writeRecords();
        } catch (error) {
          if (changed) {
            try {
              if (previous === null) localStorage.removeItem(RECIPE_KEY);
              else localStorage.setItem(RECIPE_KEY, previous);
            } catch {
              recipes = merged;
              updateRecipeOptions();
              throw new Error('豆档未恢复，冲煮方案已写入。请保留备份，检查浏览器储存后重试。');
            }
          }
          throw error;
        }
        recipes = merged;
      });
    } finally {
      $('backup-file').disabled = $('backup-cancel').disabled = false;
    }
    pendingImport = undefined;
    $('import-preview').hidden = true;
    $('backup-file').value = '';
    $('data-feedback').textContent = '备份已合并导入，豆档与品鉴可在豆库中查看。';
    updateRecipeOptions();
  });

  // Brewing uses elapsed wall-clock time so background tabs do not slow the timer.
  function stageInputs(stages) {
    $('brew-stages').replaceChildren();
    for (const stage of stages) addStage(stage);
  }

  function addStage(stage = {end: 180, water: Number($('brew-water').value)}) {
    const row = node('div', null, 'stage-row');
    const label = node('span', '', 'stage-label');
    const seconds = node('input');
    seconds.type = 'number'; seconds.min = '1'; seconds.max = '3600'; seconds.step = '1'; seconds.value = stage.end; seconds.required = true;
    const water = node('input');
    water.type = 'number'; water.min = '0'; water.step = '.01'; water.value = stage.water; water.required = true;
    const timeLabel = node('label', '结束秒数'); timeLabel.append(seconds);
    const waterLabel = node('label', '累计水量（g）'); waterLabel.append(water);
    const remove = button('移除', () => {row.remove(); numberStages();}, 'text-action');
    row.append(label, timeLabel, waterLabel, remove);
    $('brew-stages').append(row);
    numberStages();
  }

  function numberStages() {
    [...$('brew-stages').children].forEach((row,index) => {row.querySelector('.stage-label').textContent = '第 ' + (index + 1) + ' 段';});
    $('stage-add').disabled = Boolean(session) || $('brew-stages').children.length >= 12;
  }

  function preset(id) {
    const saved = recipes.find(recipe => recipe.id === id);
    if (saved) return saved;
    const dose = Number($('brew-dose').value) || 15;
    const water = Number($('brew-water').value) || 225;
    const targets = id === 'four-six' ? [45,90,135,180,225] : [30,140,225];
    return {dose, water, temp: '92', equipment: 'V60', grind: '', stages: targets.map((target,index) => ({end: id === 'four-six' ? 45 * (index + 1) : [30,90,150][index], water: Math.round(water * target / 225)}))};
  }

  function updateRecipeOptions() {
    const value = $('brew-recipe').value;
    for (const option of [...$('brew-recipe').options]) if (option.dataset.saved) option.remove();
    const names = new Map();
    for (const recipe of recipes) {
      const count = (names.get(recipe.name) ?? 0) + 1;
      names.set(recipe.name, count);
      const option = new Option(recipe.name + (count > 1 ? '（' + count + '）' : ''), recipe.id);
      option.dataset.saved = 'true';
      $('brew-recipe').append(option);
    }
    if ([...$('brew-recipe').options].some(option => option.value === value)) $('brew-recipe').value = value;
  }

  function loadRecipe(id) {
    if (id === 'custom') return;
    const recipe = preset(id);
    for (const key of ['dose','water','temp','equipment','grind']) $('brew-' + key).value = recipe[key];
    stageInputs(recipe.stages);
  }

  function brewParams() {
    if (!$('brew-form').reportValidity()) throw new Error('请补全有效的冲煮参数。');
    const data = Object.fromEntries(['dose','water','temp','equipment','grind'].map(key => [key, $('brew-' + key).value]));
    data.dose = Number(data.dose); data.water = Number(data.water);
    data.stages = [...$('brew-stages').children].map(row => {
      const [seconds, water] = row.querySelectorAll('input');
      return {end: Number(seconds.value), water: Number(water.value)};
    });
    validateStages(data.stages, data.water);
    data.beanId = $('brew-bean').value;
    data.recipe = $('brew-recipe').selectedOptions[0].textContent;
    return data;
  }

  function updateBrewingBeans() {
    const value = session?.beanId ?? $('brew-bean').value;
    $('brew-bean').replaceChildren(new Option('请选择咖啡豆', ''));
    for (const record of getRecords()) {
      if (Number(record.values.remaining) > 0 || record.id === value) $('brew-bean').append(new Option(record.values.name + ' · ' + grams(record.values.remaining), record.id));
    }
    if ([...$('brew-bean').options].some(option => option.value === value)) $('brew-bean').value = value;
  }

  function elapsed() {
    return session ? session.elapsed + (session.startedAt ? Math.max(0, (Date.now() - session.startedAt) / 1000) : 0) : 0;
  }

  function saveSession() {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  function renderTimer() {
    const seconds = Math.floor(elapsed());
    const end = session?.stages.at(-1).end ?? 0;
    $('brew-clock').textContent = String(Math.floor(seconds / 60)).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0');
    const stage = session?.stages.findIndex(item => seconds < item.end);
    $('brew-stage-status').textContent = !session ? '准备好后开始计时' : stage < 0 ? '分段计划已完成，可记录这一杯' :
      '第 ' + (stage + 1) + ' 段 · 累计注水至 ' + grams(session.stages[stage].water) + ' · ' + (session.stages[stage].end - seconds) + ' 秒后结束本段';
    const announcement = (session?.noteId ?? 'idle') + ':' + stage;
    if (announcement !== lastAnnouncement) {
      $('brew-announcement').textContent = !session ? '' : stage < 0 ? '分段计划已完成' : '进入第 ' + (stage + 1) + ' 段，累计注水至 ' + grams(session.stages[stage].water);
      if (session?.startedAt && stage !== 0) navigator.vibrate?.(80);
      lastAnnouncement = announcement;
    }
    $('brew-progress').max = end || 1;
    $('brew-progress').value = Math.min(seconds, end);
    $('brew-start').textContent = session?.startedAt ? '暂停计时' : session ? '继续计时' : '开始计时';
    $('brew-nav-label').textContent = session?.startedAt ? '冲煮中' : session ? '已暂停' : '冲煮';
    const panel = $('brew-timer');
    const form = $('brew-form');
    if (session && panel.nextElementSibling !== form) form.before(panel);
    if (!session && form.nextElementSibling !== panel) form.after(panel);
    panel.classList.toggle('is-active', Boolean(session));
    $('brew-finish').disabled = !session;
    for (const control of $('brew-form').querySelectorAll('input,select,button')) control.disabled = Boolean(session);
    if (!session) numberStages();
  }

  function resetTimer() {
    const previous = session;
    session = undefined;
    try { saveSession(); } catch { session = previous; throw new Error('无法重置计时，请检查储存权限。'); }
    renderTimer();
  }

  $('brew-form').onsubmit = event => {
    event.preventDefault();
    return perform($('brew-start'), 'brew-feedback', async () => {
      const previous = session;
      if (session) session = {...session, elapsed: elapsed(), startedAt: session.startedAt ? null : Date.now()};
      else {
        const data = brewParams();
        const bean = getRecords().find(record => record.id === data.beanId);
        if (!bean || units(data.dose) > units(bean.values.remaining)) throw new Error('请选择余量足够的咖啡豆。');
        session = {...data, noteId: uid(), elapsed: 0, startedAt: Date.now()};
      }
      try { saveSession(); } catch (error) { session = previous; throw error; }
      renderTimer();
    });
  };
  $('brew-reset').onclick = () => {
    if (session) confirmation('重置这次冲煮？', '计时和本次参数会结束。可以重新开始冲煮。', resetTimer);
  };
  $('brew-finish').onclick = event => perform(event.currentTarget, 'brew-feedback', async () => {
    if (!session) return;
    const bean = getRecords().find(record => record.id === session.beanId);
    if (!bean) throw new Error('这包豆已被删除，请先重置计时。');
    session = {...session, elapsed: elapsed(), startedAt: null};
    saveSession();
    renderTimer();
    openTasting(bean, undefined, {...session, duration: Math.round(session.elapsed)});
  });
  $('detail-brew').onclick = () => {
    const bean = selectedBean();
    if (session && session.beanId !== bean.id) {
      $('detail-feedback').textContent = '有一杯冲煮正在计时，请到冲煮页完成或重置后再换豆。';
      return;
    }
    show('brewing');
    $('brew-bean').value = bean.id;
  };
  $('brew-recipe').onchange = () => loadRecipe($('brew-recipe').value);
  $('brew-water').onchange = () => {
    if (['three','four-six'].includes($('brew-recipe').value)) stageInputs(preset($('brew-recipe').value).stages);
  };
  $('stage-add').onclick = () => { if ($('brew-stages').children.length < 12) addStage(); };
  $('recipe-save').onclick = event => perform(event.currentTarget, 'brew-feedback', async () => {
    const name = $('recipe-name').value.trim();
    if (!name) throw new Error('请先填写方案名称。');
    const data = brewParams();
    const recipe = {...data, id: uid(), name};
    await withDataLock(() => {
      const next = validateRecipes([...readRecipes(), recipe]);
      localStorage.setItem(RECIPE_KEY, JSON.stringify(next));
      recipes = next;
    });
    updateRecipeOptions();
    $('brew-recipe').value = recipe.id;
    $('brew-feedback').textContent = '方案已保存。';
  });

  function refresh() {
    if (active === 'bean-detail') renderDetail();
    if (active === 'statistics') renderStats();
    if (active === 'brewing') updateBrewingBeans();
  }

  $('nav-library').onclick = openLibrary;
  window.addEventListener('storage', event => {
    if (event.key !== RECIPE_KEY) return;
    try {
      recipes = readRecipes();
      updateRecipeOptions();
    } catch {}
  });
  for (const id of ['brewing','statistics','data-page']) $('nav-' + id).onclick = () => show(id);
  updateRecipeOptions();
  loadRecipe('three');
  try {
    const restored = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (restored && getRecords().some(record => record.id === restored.beanId && !(record.tastings ?? []).some(note => note.id === restored.noteId)) && Number.isFinite(restored.elapsed) && restored.elapsed >= 0 &&
        (restored.startedAt === null || (Number.isFinite(restored.startedAt) && restored.startedAt <= Date.now()))) {
      validateStages(restored.stages, restored.water);
      session = restored;
      for (const key of ['dose','water','temp','equipment','grind']) $('brew-' + key).value = restored[key] ?? '';
      $('brew-recipe').value = 'custom';
      stageInputs(restored.stages);
    }
  } catch { $('brew-feedback').textContent = '上次计时未能恢复，可以重新开始。'; }
  renderTimer();
  setInterval(() => {if (session?.startedAt) renderTimer();}, 500);
  return {hide, show, openDetail, refresh};
}
