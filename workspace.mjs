import {units, uid, localDate, roastAge, flavorState, unitCost, undoStock,
  saveTasting, deleteTasting, consumptionEvents, readBackup, mergeBackup, validateRecords} from './core/journal.mjs?v=8';
import {validateRecipes, validateStages} from './core/recipes.mjs?v=8';
import {waterForDose, rescaleStages, referenceTimeline, pourRate} from './core/brewing.mjs?v=1';
import {OPCODE, buildFrame, decodeFrame, resampleSamples, flowFromSamples, pourToWater,
  formatRatio, formatGrams, formatDuration} from './core/scale.mjs?v=2';
import {webBluetoothAvailable, requestBasic3Scale} from './core/scale-ble.mjs?v=2';
import {connectBridge, bridgeAvailable} from './core/scale-bridge.mjs?v=3';
import {normalizeComponents} from './core/recognition.mjs';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const grams = value => number.format(value) + ' g';
const money = value => '¥' + number.format(value);
const dateTime = value => new Date(value).toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const DIMENSIONS = {acidity: '酸度', sweetness: '甜感', bitterness: '苦感', body: '醇厚度'};

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

function mergeRecipes(current, incoming) {
  const content = ({id, ...recipe}) => JSON.stringify(recipe);
  const next = [...current];
  for (const recipe of incoming) {
    if (next.some(item => content(item) === content(recipe))) continue;
    next.push(next.some(item => item.id === recipe.id) ? {...recipe, id: uid()} : recipe);
  }
  return next;
}

function downloadFile(fileName, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const link = node('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function createWorkspace({getRecords, getRecipes, mutate, changeData, sessionKey, setDockPage, openEditor, openLibrary, fieldLabels}) {
  let active = '';
  let selectedId;
  let tastingContext;
  let pendingImport;
  let backupRead = 0;
  let confirmAction;
  let recipes = [];
  const readRecipes = () => validateRecipes(getRecipes());
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
    $('brand').hidden = true;
    $('library-toggle').hidden = false;
    $('nav-context').textContent = id === 'bean-detail' ? '豆档详情' : '';
    setDockPage(id === 'bean-detail' ? 'library' : id);
    refresh();
    if (active !== id) return;
    const heading = $(id).querySelector('h1');
    document.title = '豆档 · ' + heading.textContent;
    window.scrollTo(0, 0);
    heading.focus({preventScroll: true});
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
    if (!note && brew?.measuredWater) $('tasting-water').value = Math.round(brew.measuredWater * 10) / 10;
    if (!note && brew?.measuredDose) $('tasting-dose').value = Math.round(brew.measuredDose * 10) / 10;
    $('tasting-ratio').textContent = note?.params?.ratio ?? brew?.ratio ?? '';
    $('tasting-duration').textContent = note?.params?.duration ? '计时 ' + note.params.duration + ' 秒' : brew?.duration ? '计时 ' + brew.duration + ' 秒' : '';
    $('tasting-brew-facts').hidden = !($('tasting-ratio').textContent || $('tasting-duration').textContent);
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
    if (context.brew) Object.assign(note.params, {duration: String(context.brew.duration), recipe: context.brew.recipe, ratio: context.brew.ratio});
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
      await importLocal(imported);
    } finally {
      $('backup-file').disabled = $('backup-cancel').disabled = false;
    }
    pendingImport = undefined;
    $('import-preview').hidden = true;
    $('backup-file').value = '';
    $('data-feedback').textContent = '备份已合并导入，豆档与品鉴可在豆库中查看。';
    updateRecipeOptions();
  });

  async function importLocal(imported) {
    const incomingRecords = validateRecords(imported.records);
    const incomingRecipes = validateRecipes(imported.recipes);
    await changeData(current => {
      const existingRecipes = validateRecipes(current.recipes);
      const merged = mergeRecipes(existingRecipes, incomingRecipes);
      return {
        records: mergeBackup(current.records, incomingRecords),
        recipes: merged.length === existingRecipes.length ? current.recipes : merged,
      };
    });
    refreshRecipes();
  }

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
    renderBrewRatio();
  }

  // 粉水比、预计注水速率与参考时间轴：改任一参数都能立刻看到结论。
  function readStages() {
    return [...$('brew-stages').children].map(row => {
      const [seconds, water] = row.querySelectorAll('input');
      return {end: Number(seconds.value), water: Number(water.value)};
    }).filter(stage => Number.isFinite(stage.end) && Number.isFinite(stage.water));
  }

  function ratioLabel(dose, water) {
    const ratio = Number(dose) > 0 && Number(water) > 0 ? Number(water) / Number(dose) : 0;
    return ratio ? '粉水比 1:' + ratio.toFixed(1) : '粉水比 —';
  }

  function syncRatioPreset(dose, water) {
    const ratio = Number(dose) > 0 ? Math.round(Number(water) / Number(dose)) : 0;
    const option = [...$('brew-ratio').options].find(item => Number(item.value) === ratio);
    if (option) $('brew-ratio').value = option.value;
  }

  function renderBrewRatio() {
    if (session) {
      $('brew-live-metrics').textContent = ratioLabel(session.dose, session.water) + ' · 预计 ' + pourRate(session.stages) + ' g/s';
      return;
    }
    const dose = $('brew-dose').value;
    const water = $('brew-water').value;
    const stages = readStages();
    const readout = ratioLabel(dose, water);
    $('brew-ratio-readout').textContent = readout;
    $('brew-live-metrics').textContent = readout + ' · 预计 ' + pourRate(stages) + ' g/s';
    const total = Number($('brew-duration').value);
    const timeline = stages.length && total > 0 ? referenceTimeline(stages, total) : [];
    $('brew-timeline-hint').textContent = timeline.length ? '参考排段：' + timeline.map(stage => stage.end + ' 秒至 ' + stage.water + ' g').join('，') : '';
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
    $('brew-duration').value = recipe.stages.at(-1)?.end ?? 150;
    stageInputs(recipe.stages);
    syncRatioPreset(recipe.dose, recipe.water);
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
    if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
    else localStorage.removeItem(sessionKey);
  }

  // ---------- 电子秤：Basic3/ESPpro/Dot 走同一套 A5 5A 协议 ----------
  const scale = {
    link: null, status: '无秤', grams: null, flow: 0, connected: false,
    t0: null, base: null, zeroed: false, dose: null, samples: [], lastStage: -1,
    series: {water: true, flow: true}, expanded: false,
  };

  function scaleStatus(text) { scale.status = text; $('brew-scale-status').textContent = text; }

  function scaleReading(reading) {
    if (!Number.isFinite(reading?.grams)) return;
    if (!scale.connected) { scale.connected = true; $('brew-scale-zero').disabled = false; }
    scale.grams = reading.grams;
    scale.flow = Number(reading.flow) || 0;
    scale.at = reading.at ?? Date.now();
    if (scale.base === null || !scale.zeroed) { scale.base = reading.grams; scale.zeroed = true; }
    const net = Math.max(0, reading.grams - scale.base);
    if (!session && scale.dose === null && net >= 1) scale.dose = net;
    const started = Boolean(session?.startedAt) || Boolean(scale.demo);
    if (started && scale.t0 == null) { scale.t0 = scale.at; scale.dose = scale.dose ?? net; }
    const t = started && scale.t0 != null ? scale.at - scale.t0 : 0;
    if (started) {
      const last = scale.samples.at(-1);
      if (!last || t - last.t >= 80) scale.samples.push({t, g: Math.max(0, net - (scale.dose ?? 0))});
      if (scale.samples.length > 3600) scale.samples.splice(0, scale.samples.length - 3600);
      advanceStages();
    }
    renderScale();
  }

  // 实测注水量够了就自动推进分段，不用再盯秒表
  function advanceStages() {
    if (!session) return;
    const water = pourToWater(scale.dose ?? Number(session.dose), session.water, scale.samples.at(-1)?.g ?? 0);
    if (!water || water.pouredWater == null) return;
    const index = session.stages.findIndex(stage => water.pouredWater < stage.water);
    const reached = index < 0 ? session.stages.length - 1 : index;
    if (reached > scale.lastStage) {
      scale.lastStage = reached;
      $('brew-announcement').textContent = '实测注水已到第 ' + (reached + 1) + ' 段目标 ' + grams(session.stages[reached].water);
      navigator.vibrate?.(index < 0 ? 160 : 80);
    }
  }

  function scaleStats() {
    const net = scale.grams != null && scale.base != null ? Math.max(0, scale.grams - scale.base) : 0;
    const poured = scale.samples.at(-1)?.g ?? (session && scale.dose != null ? Math.max(0, net - scale.dose) : null);
    const dose = scale.dose ?? (session ? Number(session.dose) : null);
    return {...pourToWater(dose, session?.water ?? Number($('brew-water').value), poured ?? 0), net, actualDose: scale.dose};
  }

  function renderScale() {
    const stats = scaleStats();
    const live = flowFromSamples(scale.samples) || scale.flow;
    $('brew-stat-time').textContent = formatDuration(session ? elapsed() : (scale.samples.at(-1)?.t ?? 0) / 1000);
    $('brew-stat-dose').innerHTML = (stats.actualDose ?? scale.dose) != null ? formatGrams(stats.actualDose) + '<em>g</em>' : '—<em>g</em>';
    $('brew-stat-water').innerHTML = stats.pouredWater != null ? formatGrams(stats.pouredWater) + '<em>g</em>' : '—<em>g</em>';
    $('brew-stat-ratio').textContent = stats.liveRatio ? formatRatio(stats.liveRatio) : (stats.ratio ? formatRatio(stats.ratio) + ' 目标' : '—');
    $('brew-live-metrics').textContent = (stats.ratio ? formatRatio(stats.ratio) + ' 目标' : '粉水比 —') +
      (scale.grams != null ? ' · 秤上 ' + formatGrams(scale.grams) + ' g' : ' · 预计 ' + pourRate(session?.stages ?? readStages()) + ' g/s');
    drawChart(live);
  }

  function targetTicks(max) {
    const target = Math.max(1, max);
    const raw = target / 4;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].find(candidate => candidate * magnitude >= raw) * magnitude;
    return {max: Math.ceil(target / step) * step, step};
  }

  function drawChart(liveFlow = 0) {
    const svg = $('brew-chart-svg');
    if (!svg) return;
    const demo = scale.samples.length < 2 ? demoSeries : null;
    const samples = demo ?? scale.samples;
    const empty = samples.length < 2;
    $('brew-chart-empty').hidden = !empty;
    $('brew-chart').classList.toggle('is-expanded', scale.expanded);
    $('brew-chart-expand').textContent = scale.expanded ? '收起' : '放大';
    $('brew-chart-expand').setAttribute('aria-pressed', String(scale.expanded));
    const W = 640, H = 320, left = 46, right = 62, top = 30, bottom = 34;
    const innerW = W - left - right, innerH = H - top - bottom;
    const points = resampleSamples(samples, 1000);
    const endSec = Math.max(30, points.at(-1)?.t ?? 0);
    const duration = session?.stages.at(-1)?.end ?? 0;
    const domain = Math.max(endSec, Math.min(duration, 3600)) + 5;
    const waterMax = targetTicks(Math.max(session?.water ?? 0, points.at(-1)?.g ?? 0, 10));
    const flows = [];
    let lo = 0;
    for (const point of points) {
      const from = point.t * 1000 - 1600;
      while (lo < samples.length - 2 && samples[lo].t < from) lo += 1;
      let hi = lo;
      while (hi < samples.length && samples[hi].t <= point.t * 1000) hi += 1;
      flows.push(flowFromSamples(samples.slice(lo, Math.max(hi, lo + 2)), 2000));
    }
    const flowMax = targetTicks(Math.max(4, ...points.map((_, index) => Math.abs(flows[index])), Number(liveFlow) || 0));
    const x = t => left + (t / domain) * innerW;
    const yWater = g => top + innerH - (g / waterMax.max) * innerH;
    const yFlow = f => top + innerH - (f / flowMax.max) * innerH;
    const parts = [];
    for (let i = 0; i <= 4; i += 1) {
      const gy = top + (innerH * i) / 4;
      parts.push(`<line class="grid" x1="${left}" y1="${gy.toFixed(1)}" x2="${W - right}" y2="${gy.toFixed(1)}"/>`);
    }
    parts.push(`<text class="axis-unit" x="${left - 10}" y="14" text-anchor="end">g</text>`);
    parts.push(`<text class="axis-unit" x="${W - right + 10}" y="14">g/s</text>`);
    for (let i = 0; i <= 4; i += 1) {
      const gy = top + (innerH * i) / 4;
      const waterValue = waterMax.max - (waterMax.max * i) / 4;
      const flowValue = flowMax.max - (flowMax.max * i) / 4;
      parts.push(`<text class="axis-label" x="${left - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end">${Math.round(waterValue)}</text>`);
      parts.push(`<text class="axis-label" x="${W - right + 10}" y="${(gy + 4).toFixed(1)}">${flowValue % 1 ? flowValue.toFixed(1) : Math.round(flowValue)}</text>`);
    }
    const stepX = domain > 300 ? 60 : domain > 60 ? 30 : 15;
    for (let t = 0; t <= domain; t += stepX) {
      parts.push(`<text class="axis-label" x="${x(t).toFixed(1)}" y="${H - 12}" text-anchor="middle">${formatDuration(t)}</text>`);
    }
    if (session) {
      for (const stage of session.stages) {
        if (stage.end > 0 && stage.end < domain) parts.push(`<line class="stage-mark" x1="${x(stage.end).toFixed(1)}" y1="${top}" x2="${x(stage.end).toFixed(1)}" y2="${top + innerH}"/>`);
      }
    }
    const path = (values, scaleY, cls) => {
      if (values.length < 2) return '';
      const d = values.map((value, index) => `${index ? 'L' : 'M'}${x(points[index].t).toFixed(1)} ${scaleY(value).toFixed(1)}`).join(' ');
      return `<path class="line ${cls}" d="${d}"/>`;
    };
    // samples 里的 g 已经是扣掉粉重的净注水量
    if (scale.series.flow) parts.push(path(flows.map(value => Math.max(0, value)), yFlow, 'flow'));
    if (scale.series.water) {
      parts.push(path(points.map(point => point.g), yWater, 'water'));
      const last = points.at(-1);
      parts.push(`<circle class="dot dot-water" cx="${x(last.t).toFixed(1)}" cy="${yWater(last.g).toFixed(1)}" r="3.5"/>`);
    }
    if (scale.series.flow) {
      const lastIndex = points.length - 1;
      parts.push(`<circle class="dot dot-flow" cx="${x(points[lastIndex].t).toFixed(1)}" cy="${yFlow(Math.max(0, flows[lastIndex] ?? 0)).toFixed(1)}" r="3.5"/>`);
    }
    svg.innerHTML = parts.join('');
    for (const [key, buttonId] of [['water', 'brew-legend-water'], ['flow', 'brew-legend-flow']]) {
      const element = $(buttonId);
      element.setAttribute('aria-pressed', String(scale.series[key]));
      element.classList.toggle('is-off', !scale.series[key]);
    }
  }

  async function connectScale(kind) {
    disconnectScale();
    scale.samples = [];
    scale.lastStage = -1;
    scale.connected = false;
    scaleStatus(kind === 'bridge' ? '正在连接中继…' : '选择这台秤…');
    try {
      if (kind === 'bridge') {
        scale.link = await connectBridge({
          onReading: scaleReading,
          onEvent: event => {
            if (event.kind === 'bridge-ready') scaleStatus('中继已连上，等待秤的数据');
          },
          onDisconnect: () => { scaleStatus('中继断开'); scale.connected = false; },
        });
        scaleStatus('已连上中继，等待秤的数据');
      } else {
        scale.link = await requestBasic3Scale({
          onReading: scaleReading,
          onEvent: event => { if (event.kind === 'model') scaleStatus('已连接 · 型号 ' + event.model); },
          onDisconnect: () => { scaleStatus('秤已断开'); scale.connected = false; $('brew-scale-zero').disabled = true; },
        });
        scaleStatus('已连接 · ' + (scale.link.name || '电子秤'));
      }
      scale.zeroed = false;
      $('brew-scale-zero').disabled = false;
    } catch (error) {
      scaleStatus(error.name === 'NotFoundError' ? '没有选择设备' : error.message);
    }
  }

  function disconnectScale() {
    try { scale.link?.disconnect?.(); } catch {}
    scale.link = null;
    scale.connected = false;
    $('brew-scale-zero').disabled = true;
  }

  // 还没有秤时给一条演示曲线，方便先看看图表长什么样
  const demoSeries = (() => {
    const out = [];
    const pours = [[0, 6.5, 12], [32, 4.2, 30], [78, 5.6, 40], [126, 4.0, 48], [180, 3.2, 40]];
    for (const [start, rate, amount] of pours) {
      for (let t = start * 1000; t < (start + amount / rate) * 1000; t += 250) out.push({t, g: (out.at(-1)?.g ?? 0) + rate * 0.25});
      for (let t = (start + amount / rate) * 1000; t < (start + amount / rate + 6) * 1000; t += 250) out.push({t, g: out.at(-1)?.g ?? 0});
    }
    return out;
  })();

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
    if (session) $('brew-live-metrics').textContent = ratioLabel(session.dose, session.water) + ' · 预计 ' + pourRate(session.stages) + ' g/s';
    else renderBrewRatio();
    const panel = $('brew-timer');
    const form = $('brew-form');
    if (session && panel.nextElementSibling !== form) form.before(panel);
    if (!session && form.nextElementSibling !== panel) form.after(panel);
    panel.classList.toggle('is-active', Boolean(session));
    $('brew-finish').disabled = !session;
    for (const control of $('brew-form').querySelectorAll('input,select,button')) control.disabled = Boolean(session);
    if (!session) numberStages();
    renderScale();
  }

  function resetTimer() {
    const previous = session;
    session = undefined;
    scale.samples = [];
    scale.t0 = null;
    scale.lastStage = -1;
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
        // 秤上已经倒了粉的话，用实测粉重当作这一杯的基准
        const net = scale.grams != null && scale.base != null ? Math.max(0, scale.grams - scale.base) : 0;
        const measured = net >= 1 ? Math.round(net * 10) / 10 : null;
        if (measured) { data.dose = measured; scale.dose = measured; scale.base = scale.grams - measured; }
        session = {...data, noteId: uid(), elapsed: 0, startedAt: Date.now()};
        scale.samples = [];
        scale.t0 = null;
        scale.lastStage = -1;
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
    // 完成时把实际耗时、实测水量与粉水比一起带进品鉴，方便回看“这一杯实际怎么冲的”。
    const stats = scaleStats();
    openTasting(bean, undefined, {...session, duration: Math.round(session.elapsed), water: session.water,
      ratio: stats.liveRatio ? formatRatio(stats.liveRatio) : ratioLabel(session.dose, session.water),
      measuredDose: stats.actualDose ?? null, measuredWater: stats.pouredWater ?? null});
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
    else syncRatioPreset($('brew-dose').value, $('brew-water').value);
    renderBrewRatio();
  };
  $('brew-dose').oninput = () => {
    if (['three','four-six'].includes($('brew-recipe').value)) syncRatioPreset($('brew-dose').value, $('brew-water').value);
    renderBrewRatio();
  };
  $('brew-duration').oninput = () => renderBrewRatio();
  $('brew-ratio').onchange = () => {
    syncRatioPreset($('brew-dose').value, waterForDose($('brew-dose').value, $('brew-ratio').value));
    renderBrewRatio();
  };
  $('brew-fit').onclick = () => {
    try {
      const dose = $('brew-dose').value;
      const ratio = Number($('brew-ratio').value);
      const water = waterForDose(dose, ratio);
      const previous = Number($('brew-water').value);
      const stages = readStages();
      $('brew-water').value = water;
      if (previous > 0 && stages.length && previous !== water) stageInputs(rescaleStages(stages, previous, water));
      $('brew-feedback').textContent = '已按 1:' + ratio + ' 把总水量调为 ' + water + ' g' + (stages.length && previous !== water ? '，各段累计水量等比缩放。' : '。');
    } catch (error) {
      $('brew-feedback').textContent = error.message;
    }
    renderBrewRatio();
  };
  $('brew-retime').onclick = () => {
    try {
      const stages = readStages();
      if (!stages.length) throw new Error('请先添加分段。');
      const total = Number($('brew-duration').value);
      if (!(total >= 30)) throw new Error('预计时长至少 30 秒。');
      stageInputs(referenceTimeline(stages, total));
      $('brew-feedback').textContent = '已按 ' + total + ' 秒重排各段结束时间，累计注水量不变。';
    } catch (error) {
      $('brew-feedback').textContent = error.message;
    }
    renderBrewRatio();
  };
  $('stage-add').onclick = () => { if ($('brew-stages').children.length < 12) addStage(); };

  // ---- 冲煮数据面板的交互 ----
  $('brew-legend-water').onclick = () => { scale.series.water = !scale.series.water; drawChart(); };
  $('brew-legend-flow').onclick = () => { scale.series.flow = !scale.series.flow; drawChart(); };
  $('brew-chart-expand').onclick = () => { scale.expanded = !scale.expanded; drawChart(); };
  $('brew-chart-demo').onclick = () => {
    // 示例曲线：按 0.2 s 节拍喂一遍，跟真秤的路径完全一样
    scale.demo = true;
    scale.samples = [];
    scale.t0 = null;
    scale.base = 0;
    scale.zeroed = true;
    scale.dose = Number($('brew-dose').value) || 15;
    let index = 0;
    const tick = () => {
      if (!scale.demo || index >= demoSeries.length) { scale.demo = false; return; }
      const point = demoSeries[index];
      index += 1;
      scaleReading({grams: scale.dose + point.g, flow: 4, at: Date.now() - (demoSeries.at(-1).t - point.t)});
      setTimeout(tick, 12);
    };
    scaleStatus('这是示例曲线，连上秤后会自动换成实测数据');
    tick();
  };
  $('brew-scale-toggle').onclick = () => {
    const body = $('brew-scale-body');
    const open = body.hidden;
    body.hidden = !open;
    $('brew-scale-toggle').textContent = open ? '收起' : '展开';
    $('brew-scale-toggle').setAttribute('aria-expanded', String(open));
  };
  $('brew-scale-zero').onclick = () => {
    if (scale.grams == null) return;
    scale.base = scale.grams;
    scale.dose = null;
    scale.samples = [];
    scale.lastStage = -1;
    scale.zeroed = true;
    scale.link?.write?.(0x00, []).catch?.(() => {});
    scaleStatus('已清零，倒粉后开始计时');
    renderScale();
  };
  $('brew-scale-connect').onclick = () => connectScale('bluetooth');
  $('brew-scale-bridge').onclick = () => {
    if (!bridgeAvailable()) {
      scaleStatus('中继需要 HTTPS：点开桥页面在新窗口里连，或在线上站点使用');
      window.open('./bridge.html', '_blank', 'noopener');
      return;
    }
    connectScale('bridge');
  };

  const canBluetooth = webBluetoothAvailable();
  const canBridge = bridgeAvailable();
  $('brew-scale-connect').disabled = !canBluetooth;
  $('brew-scale-connect').textContent = canBluetooth ? '连接电子秤' : '本机不支持蓝牙';
  $('brew-scale-bridge').disabled = !canBridge;
  $('brew-scale-bridge').title = canBridge ? '' : '中继需要 HTTPS';
  $('brew-scale-hint').textContent = canBluetooth
    ? (canBridge ? '可以直接连秤，数据不出本机；也可以用另一台能连蓝牙的设备当桥。' : '可以直接连秤，数据不出本机。')
    : (canBridge
      ? '这台设备的浏览器没有网页蓝牙（iOS 常见）：用「用手机当桥」——在能连蓝牙的设备上打开 bridge.html 连秤，登录同一账号。'
      : '这台设备的浏览器没有网页蓝牙，而且当前不是 HTTPS：去线上站点用「用手机当桥」，或在安卓 / 桌面 Chrome 上直接连。');
  scaleStatus(canBluetooth ? '可以连接电子秤' : canBridge ? '未连接秤' : '未连接秤（需要 HTTPS 才能用中继）');
  drawChart();
  $('recipe-save').onclick = event => perform(event.currentTarget, 'brew-feedback', async () => {
    const name = $('recipe-name').value.trim();
    if (!name) throw new Error('请先填写方案名称。');
    const data = brewParams();
    const recipe = {...data, id: uid(), name};
    await changeData(current => ({...current, recipes: validateRecipes([...current.recipes, recipe])}));
    refreshRecipes();
    $('brew-recipe').value = recipe.id;
    $('brew-feedback').textContent = '方案已保存。';
  });

  function refresh() {
    if (active === 'bean-detail') renderDetail();
    if (active === 'statistics') renderStats();
    if (active === 'brewing') { updateBrewingBeans(); renderScale(); }
  }

  $('nav-library').onclick = openLibrary;
  function refreshRecipes() {
    try {
      recipes = readRecipes();
      updateRecipeOptions();
    } catch {}
  }
  for (const id of ['brewing','statistics','data-page']) $('nav-' + id).onclick = () => show(id);
  updateRecipeOptions();
  loadRecipe('three');
  try {
    const restored = JSON.parse(localStorage.getItem(sessionKey));
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
  return {hide, show, openDetail, refresh, refreshRecipes, importLocal};
}
