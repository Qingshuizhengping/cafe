import {normalizeComponents} from './recognition.mjs';

export const units = value => Math.round(Number(value) * 100);
export const uid = () => crypto.randomUUID();

export function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function roastAge(value, now = new Date()) {
  if (!value) return null;
  const day = Date.parse(value);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) return null;
  return Math.round((Date.parse(localDate(now)) - day) / 86400000);
}

export function flavorState(values, now = new Date()) {
  if (values.storage === '冷冻') return {key: 'frozen', label: '冷冻保存'};
  if (values.storage === '在途') return {key: 'transit', label: '在途'};
  const age = roastAge(values.roastDate, now);
  if (age === null) return {key: 'unknown', label: '未设置烘焙日期'};
  if (age < 0) return {key: 'unknown', label: '烘焙日期在未来'};
  const start = values.rest === '' || values.rest == null ? 7 : Number(values.rest);
  const end = values.freshDays === '' || values.freshDays == null ? 60 : Number(values.freshDays);
  if (age < start) return {key: 'resting', label: '养豆中 · ' + (start - age) + ' 天后可饮'};
  if (age <= end) return {key: 'ready', label: '参考赏味期 · 余 ' + (end - age) + ' 天'};
  return {key: 'past', label: '已过参考赏味期'};
}

export function unitCost(values) {
  const price = Number(values.price);
  const weight = Number(values.weight);
  return values.price !== '' && values.price != null && Number.isFinite(price) && weight > 0 ? price / weight : null;
}

function checkStock(record, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > units(record.values.weight)) {
    throw new Error('操作后的余量须在 0 和总重量之间，请核对当前库存。');
  }
}

export function recordStock(record, remaining, type, options = {}) {
  const id = options.id ?? uid();
  if ((record.history ?? []).some(item => item.id === id)) return record;
  const after = units(remaining);
  const before = units(record.values.remaining);
  checkStock(record, after);
  if (!Number.isSafeInteger(before)) throw new Error('当前库存无效，请先核对豆档余量。');
  const event = {
    id, type, at: options.at ?? Date.now(), before: before / 100, after: after / 100,
    grams: (before - after) / 100, unitCost: unitCost(record.values), note: options.note ?? '',
  };
  return {
    ...record, values: {...record.values, remaining: String(after / 100)},
    history: [...(record.history ?? []), event], undoDeduction: null,
  };
}

export function undoStock(record, id) {
  const event = (record.history ?? []).find(item => item.id === id);
  if (!event || event.voidedAt) throw new Error('这条记录已撤销或不存在，请刷新后再试。');
  if (event.type === 'tasting') throw new Error('请在品鉴记录中删除或修改关联用量。');
  const remaining = units(record.values.remaining) + units(event.grams);
  checkStock(record, remaining);
  return {
    ...record, values: {...record.values, remaining: String(remaining / 100)}, undoDeduction: null,
    history: record.history.map(item => item.id === id ? {...item, voidedAt: Date.now()} : item),
  };
}

export function saveTasting(record, note, expected) {
  const old = (record.tastings ?? []).find(item => item.id === note.id);
  if ((old?.updatedAt ?? null) !== expected) throw new Error('品鉴记录已更新，请关闭后重新打开。');
  const dose = units(note.dose);
  if (!Number.isSafeInteger(dose) || dose < 0) throw new Error('请输入有效的用豆克数。');
  if (!Number.isFinite(note.at) || note.at > Date.now() + 60000) throw new Error('请填写有效的品鉴时间。');
  for (const rating of [note.rating, ...Object.values(note.taste)]) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('评分应为 0 到 5 的整数。');
  }
  const remaining = units(record.values.remaining) + units(old?.dose ?? 0) - dose;
  checkStock(record, remaining);
  const eventId = 'tasting:' + note.id;
  const previousEvent = (record.history ?? []).find(item => item.id === eventId);
  const saved = {...note, dose: dose / 100, updatedAt: Math.max(Date.now(), (old?.updatedAt ?? 0) + 1)};
  const event = {
    id: eventId, type: 'tasting', at: note.at, grams: saved.dose,
    // Restore the old dose before applying the revised record in full.
    before: (units(record.values.remaining) + units(old?.dose ?? 0)) / 100, after: remaining / 100,
    unitCost: previousEvent ? previousEvent.unitCost : unitCost(record.values), note: note.text,
  };
  return {
    ...record, values: {...record.values, remaining: String(remaining / 100)}, undoDeduction: null,
    history: [...(record.history ?? []).filter(item => item.id !== eventId), event],
    tastings: [...(record.tastings ?? []).filter(item => item.id !== note.id), saved],
  };
}

export function deleteTasting(record, id, expected) {
  const note = (record.tastings ?? []).find(item => item.id === id);
  if (!note || note.updatedAt !== expected) throw new Error('品鉴记录已更新，请重新打开。');
  const remaining = units(record.values.remaining) + units(note.dose);
  checkStock(record, remaining);
  return {
    ...record, values: {...record.values, remaining: String(remaining / 100)}, undoDeduction: null,
    tastings: record.tastings.filter(item => item.id !== id),
    history: (record.history ?? []).map(item => item.id === 'tasting:' + id ? {...item, voidedAt: Date.now()} : item),
  };
}

export function consumptionEvents(records) {
  return records.flatMap(record => (record.history ?? [])
    .filter(event => !event.voidedAt && ['deduction', 'tasting', 'brew'].includes(event.type) && event.grams > 0)
    .map(event => ({...event, beanId: record.id, beanName: record.values.name})));
}

const VALUE_FIELDS = ['name','weight','remaining','roastDate','price','roaster','roast','origin','farm','variety',
  'altitude','process','flavors','rest','freshDays','storage','rating','notes','category','group','country','region','station','batch','components'];

function validImage(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    throw new Error('备份中有不支持的图片，请使用 JPEG、PNG 或 WebP 内嵌图片。');
  }
  return value;
}

function numeric(value, {min = 0, max = Number.MAX_SAFE_INTEGER / 100} = {}) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error('备份中的数值无效。');
  }
  return Number(value);
}

function validateRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || !raw.values) {
    throw new Error('备份中的豆档格式无效。');
  }
  const values = Object.fromEntries(Object.entries(raw.values).filter(([key, value]) => !VALUE_FIELDS.includes(key) || value != null)
    .map(([key, value]) => [key, VALUE_FIELDS.includes(key) ? String(value) : value]));
  if (!values.name?.trim()) throw new Error('备份中存在未命名豆档。');
  numeric(values.weight, {min: .01});
  numeric(values.remaining, {max: Number(values.weight)});
  if (values.price) numeric(values.price);
  if (values.components) values.components = JSON.stringify(normalizeComponents(values.components));
  for (const key of ['rest','freshDays','rating']) if (values[key] !== '' && values[key] != null) numeric(values[key], {max: key === 'rating' ? 5 : Number.MAX_VALUE});
  const history = (raw.history ?? []).map(event => {
    if (!event || !['deduction','adjustment','tasting','brew'].includes(event.type) || typeof event.id !== 'string') {
      throw new Error('备份中的库存历史无效。');
    }
    return {
      id: event.id, type: event.type, at: numeric(event.at), grams: numeric(event.grams, {min: -Number.MAX_SAFE_INTEGER / 100}),
      before: numeric(event.before), after: numeric(event.after),
      unitCost: event.unitCost == null ? null : numeric(event.unitCost), note: String(event.note ?? ''),
      ...(event.voidedAt ? {voidedAt: numeric(event.voidedAt)} : {}),
    };
  });
  const tastings = (raw.tastings ?? []).map(note => {
    if (!note || typeof note.id !== 'string') throw new Error('备份中的品鉴记录无效。');
    const taste = Object.fromEntries(['acidity','sweetness','bitterness','body'].map(key => [key, numeric(note.taste?.[key] ?? 0, {max: 5})]));
    return {
      id: note.id, at: numeric(note.at), updatedAt: numeric(note.updatedAt), dose: numeric(note.dose),
      rating: numeric(note.rating, {max: 5}), taste, text: String(note.text ?? ''),
      params: Object.fromEntries(['equipment','water','temp','grind','duration','recipe'].map(key => [key, String(note.params?.[key] ?? '')])),
    };
  });
  if (new Set(history.map(item => item.id)).size !== history.length || new Set(tastings.map(item => item.id)).size !== tastings.length) {
    throw new Error('备份中存在重复记录编号。');
  }
  if (history.some(event => units(event.before) - units(event.after) !== units(event.grams))) {
    throw new Error('库存历史中的变动量与余额不一致。');
  }
  for (const note of tastings) {
    const event = history.find(item => item.id === 'tasting:' + note.id && !item.voidedAt && item.type === 'tasting');
    if (!event || units(note.dose) !== units(event.grams)) throw new Error('品鉴用量与库存历史不一致。');
  }
  return {
    id: raw.id, values, cover: validImage(raw.cover), backCover: validImage(raw.backCover),
    history, tastings, ...(raw.pinnedAt ? {pinnedAt: numeric(raw.pinnedAt)} : {}),
    ...(raw.lastDose ? {lastDose: numeric(raw.lastDose)} : {}),
  };
}

export function readBackup(text) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('无法读取 JSON 文件，请选择豆档备份。'); }
  const list = Array.isArray(file) ? file : file?.records;
  if ((!Array.isArray(file) && (file?.format !== 'doudang' || file?.version !== 1)) || !Array.isArray(list)) {
    throw new Error('文件不是支持的豆档备份。');
  }
  return validateRecords(list);
}

export function validateRecords(list) {
  if (!Array.isArray(list)) throw new Error('豆库格式无效。');
  const records = list.map(validateRecord);
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('备份中存在重复豆档编号。');
  return records;
}

export function mergeBackup(current, incoming) {
  const fingerprint = record => {
    const {id, undoDeduction, ...data} = record;
    return JSON.stringify(data, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  };
  const normalizedFingerprint = record => {
    try { return fingerprint(validateRecord(record)); }
    catch { return null; } // Retain older local records even when they fail current import rules.
  };
  const next = [...current];
  const byId = new Map(next.map(record => [record.id, record]));
  let fingerprints;
  for (const record of incoming) {
    const existing = byId.get(record.id);
    const incomingFingerprint = fingerprint(record);
    let added = record;
    if (existing) {
      if (normalizedFingerprint(existing) === incomingFingerprint) continue;
      fingerprints ??= new Set(next.map(normalizedFingerprint));
      if (fingerprints.has(incomingFingerprint)) continue;
      added = {...record, id: uid()};
    }
    next.push(added);
    byId.set(added.id, added);
    fingerprints?.add(incomingFingerprint);
  }
  return next;
}
