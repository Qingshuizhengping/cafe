const TEXT_ALIASES = {
  name: ['name', '名称', '豆名'],
  roaster: ['roaster', '烘焙商'],
  origin: ['origin', '产地'],
  country: ['country', '产国'],
  region: ['region', '产区'],
  farm: ['farm', 'estate', '庄园'],
  station: ['station', 'processingStation', '处理站'],
  variety: ['variety', '品种', '豆种'],
  process: ['process', '处理法'],
  altitude: ['altitude', '海拔'],
  batch: ['batch', '批次'],
  flavors: ['flavors', 'flavor', '风味'],
  notes: ['notes', '备注'],
};
const ROASTS = ['极浅烘', '浅烘', '中浅烘', '中烘', '中深烘', '深烘', '极深烘'];

function text(value, limit = 300) {
  if (Array.isArray(value))
    return value
      .slice(0, 16)
      .map((item) => text(item, 80))
      .filter(Boolean)
      .join('、')
      .slice(0, limit);
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? String(value).normalize('NFKC').trim().slice(0, limit)
    : '';
}

function first(data, names) {
  for (const name of names) if (data[name] != null && data[name] !== '') return data[name];
}

export function gramsValue(value) {
  const match = text(value)
    .replace(/\s/g, '')
    .match(/^(\d+(?:\.\d+)?)(kg|千克|公斤|g|克|oz)?$/i);
  if (!match) return '';
  const multiplier = /kg|千克|公斤/i.test(match[2] ?? '')
    ? 1000
    : /^oz$/i.test(match[2] ?? '')
      ? 28.3495
      : 1;
  const grams = Math.round(Number(match[1]) * multiplier * 100) / 100;
  return Number.isFinite(grams) && grams >= 0 && grams <= 100000 ? String(grams) : '';
}

function decimal(value, max) {
  const match = text(value)
    .replace(/[¥￥,，]/g, '')
    .match(/^(\d+(?:\.\d+)?)\s*(?:元|CNY|天)?$/i);
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= max
    ? String(Math.round(number * 100) / 100)
    : '';
}

export function normalizeComponents(value) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('拼配成分须为对象数组，请核对 JSON。');
    }
  }
  if (!Array.isArray(value) || value.length > 12) throw new Error('拼配成分须为最多 12 项的对象数组。');
  const components = value
    .map((component) => {
      if (!component || typeof component !== 'object' || Array.isArray(component))
        throw new Error('每个拼配成分都应包含独立字段。');
      const normalized = {};
      for (const [key, aliases] of Object.entries(TEXT_ALIASES)) {
        if (['name', 'roaster', 'flavors', 'notes'].includes(key)) continue;
        const value = text(first(component, aliases));
        if (value) normalized[key] = value;
      }
      if (component.percentage != null && component.percentage !== '') {
        const percentage = decimal(text(component.percentage).replace(/%$/, ''), 100);
        if (!percentage || Number(percentage) <= 0) throw new Error('拼配比例须大于 0 且不超过 100%。');
        normalized.percentage = Number(percentage);
      }
      if (
        normalized.farm &&
        /处理站|水洗站|\b(?:washing\s+)?station\b/i.test(normalized.farm) &&
        !normalized.station
      ) {
        normalized.station = normalized.farm;
        delete normalized.farm;
      }
      return normalized;
    })
    .filter((component) => Object.keys(component).some((key) => key !== 'percentage'));
  if (components.reduce((sum, component) => sum + (component.percentage ?? 0), 0) > 100.01)
    throw new Error('拼配比例合计超过 100%，请核对。');
  return components;
}

export function normalizeBean(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('每颗豆的资料应为一个 JSON 对象。');
  const fields = {};
  const warnings = [];
  for (const [key, aliases] of Object.entries(TEXT_ALIASES)) {
    const value = text(first(data, aliases), key === 'name' ? 160 : 300);
    if (value) fields[key] = value;
  }
  if (fields.name && /^(?:未知|未识别|unknown|null|undefined|n\/?a)$/i.test(fields.name))
    delete fields.name;
  const weight = first(data, ['weight', 'capacity', '净含量', '总重量']);
  const remaining = first(data, ['remaining', '剩余重量']);
  const parsedWeight = gramsValue(weight);
  if (Number(parsedWeight) > 0) fields.weight = parsedWeight;
  else if (weight != null) warnings.push('净含量无效，请手动填写。');
  if (remaining != null) {
    const parsed = gramsValue(remaining);
    if (parsed !== '' && (!fields.weight || Number(parsed) <= Number(fields.weight)))
      fields.remaining = parsed;
    else warnings.push('余量无效或超过净含量，请核对。');
  } else if (fields.weight) fields.remaining = fields.weight;
  const price = first(data, ['price', '价格']);
  if (price != null) {
    const parsed = decimal(price, 1000000);
    if (parsed !== '') fields.price = parsed;
    else warnings.push('价格未能识别，请核对。');
  }
  for (const [key, aliases] of [
    ['rest', ['rest', 'startDay']],
    ['freshDays', ['freshDays', 'endDay']],
  ]) {
    const value = first(data, aliases);
    if (value != null) {
      const parsed = decimal(value, 36500);
      if (parsed !== '') fields[key] = parsed;
    }
  }
  const date = text(first(data, ['roastDate', '烘焙日期'])).match(
    /^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/,
  );
  if (date) {
    const iso = date[1] + '-' + date[2].padStart(2, '0') + '-' + date[3].padStart(2, '0');
    const time = Date.parse(iso);
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso)
      fields.roastDate = iso;
    else warnings.push('烘焙日期无效，请核对。');
  } else if (data.roastDate) warnings.push('烘焙日期不完整，请核对。');
  const roast = text(first(data, ['roast', 'roastLevel', '烘焙度']))
    .replace(/极浅(?:度)?烘焙/g, '极浅烘')
    .replace(/极深(?:度)?烘焙/g, '极深烘')
    .replace(/度?烘焙/g, '烘');
  if (ROASTS.includes(roast)) fields.roast = roast;
  const category = {filter: '手冲', espresso: '意式', omni: '全能'}[data.beanType] ?? data.category;
  if (['手冲', '意式', '全能'].includes(category)) fields.category = category;
  if (['常温', '冷冻', '在途'].includes(data.storage)) fields.storage = data.storage;
  const components = normalizeComponents(data.components ?? data.blendComponents);
  if (components.length) {
    fields.components = JSON.stringify(components);
    for (const key of [
      'origin',
      'country',
      'region',
      'farm',
      'station',
      'process',
      'variety',
      'altitude',
      'batch',
    ]) {
      if (!fields[key]) {
        const values = [...new Set(components.map((component) => component[key]).filter(Boolean))];
        if (values.length) fields[key] = values.join('、');
      }
    }
  }
  if (fields.farm && /处理站|水洗站|\b(?:washing\s+)?station\b/i.test(fields.farm) && !fields.station) {
    fields.station = fields.farm;
    delete fields.farm;
  }
  if (!fields.name) warnings.push('未识别到豆名，请填写后导入。');
  return {fields, warnings};
}

export function parseRecognition(content) {
  let data = content;
  if (typeof data === 'string') {
    const cleaned = data
      .replace(/^\uFEFF/, '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      data = JSON.parse(cleaned);
    } catch {
      // A balanced scan tolerates surrounding prose while respecting quoted braces.
      const start = cleaned.search(/[\[{]/);
      let depth = 0,
        quoted = false,
        escaped = false,
        end = -1;
      for (let index = start; index >= 0 && index < cleaned.length; index++) {
        const char = cleaned[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quoted && char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          quoted = !quoted;
          continue;
        }
        if (quoted) continue;
        if (char === '{' || char === '[') depth++;
        if (char === '}' || char === ']') depth--;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
      if (start < 0 || end < 0) throw new Error('没有找到有效 JSON，请核对识别原文。');
      try {
        data = JSON.parse(cleaned.slice(start, end));
      } catch {
        throw new Error('JSON 格式无效，请检查括号和引号。');
      }
    }
  }
  if (data && !Array.isArray(data) && (data.beans || data.coffeeBeans))
    data = data.beans ?? data.coffeeBeans;
  const list = Array.isArray(data) ? data : [data];
  if (list.length > 50) throw new Error('一次最多处理 50 颗咖啡豆。');
  return list.map(normalizeBean).filter((bean) => Object.keys(bean.fields).length);
}
