const aliases = {
  name: '名称|豆名|咖啡豆|coffee name|name',
  roaster: '烘焙商|烘焙品牌|roasted by|roaster',
  origin: '原产地|产区|产地|country|region|origin',
  farm: '庄园|农场|estate|farm',
  station: '处理站|水洗站|washing station',
  variety: '品种|豆种|varietal|variety|cultivar',
  process: '处理方式|处理法|process(?:ing)?',
  flavors: '风味描述|风味|tasting notes|flavou?r(?: notes)?',
};
const roastLevels = {
  极浅烘: /极浅|very light/i,
  中浅烘: /中浅|medium[ -]light/i,
  浅烘: /浅|light/i,
  中深烘: /中深|medium[ -]dark/i,
  极深烘: /极深|very dark/i,
  深烘: /深|dark/i,
  中烘: /中|medium/i,
};

const roastDate = /(?:烘[焙培](?:[日晶]期|日)|roast(?:ed)? (?:date|on))\s*:?\s*(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/i;
const roastDescriptor = /^(?:极浅|中浅|浅|中深|极深|深|中)(?:度)?烘(?:[焙培])?$/;
const originLine = /^(?:埃塞俄比亚|衣索比亚|哥伦比亚|巴西|肯尼亚|危地马拉|哥斯达黎加|巴拿马|卢旺达|秘鲁|洪都拉斯|萨尔瓦多|印度尼西亚|中国云南|云南)$/;

function readCompactLabel(lines, fields) {
  const index = lines.findIndex(line => originLine.test(line));
  if (index < 0) return;
  const name = lines[index + 1];
  const descriptors = lines[index + 2]?.split(/[|｜丨]/).map(part => part.trim());
  const process = descriptors?.[0];
  const roast = descriptors?.[1];
  if (!name || !/^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u.test(name) ||
      descriptors?.length !== 2 || !/(?:日晒|水洗|蜜处理|厌氧|湿刨)/.test(process) ||
      !roastDescriptor.test(roast)) return;
  fields.origin ??= lines[index];
  fields.name ??= name;
  fields.process ??= process;
  fields.roast ??= Object.entries(roastLevels).find(([, pattern]) => pattern.test(roast))?.[0];
  const flavorLine = lines[index + 3];
  if (flavorLine && !roastDate.test(flavorLine)) {
    const flavors = flavorLine.split(/[·・•、,]/).map(value => value.trim());
    if (flavors.length >= 2 && flavors.every(value => /^[\p{L}\p{N} ]{1,24}$/u.test(value))) {
      fields.flavors ??= flavors.join('、');
    }
  }
}

export function parseLabel(rawText) {
  const text = rawText.normalize('NFKC').replace(/[–—]/g, '-')
    .replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '$1');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const fields = {};
  const read = (key) => {
    const prefix = new RegExp('^(?:' + key + ')\\s*[:：]\\s*(.+)$', 'i');
    for (const line of lines) {
      const match = line.match(prefix);
      if (match) return match[1].trim();
    }
    return '';
  };

  for (const [field, key] of Object.entries(aliases)) {
    const value = read(key);
    if (value) fields[field] = value;
  }

  const mass = text.match(/(?:净含量|净重|总重量|net\s*(?:weight|wt\.?))\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|千克|g|克|oz)(?![a-z])/i)
    ?? text.match(/^(\d+(?:\.\d+)?)\s*(kg|千克|g|克|oz)\s*$/im)
    ?? lines.find(line => roastDate.test(line))?.match(/\s(\d+(?:\.\d+)?)\s*(kg|千克|g|克|oz)\s*$/i);
  if (mass) {
    const multiplier = /kg|千克/i.test(mass[2]) ? 1000 : /^oz$/i.test(mass[2]) ? 28.3495 : 1;
    if (Number(mass[1]) > 0) fields.weight = String(Math.round(Number(mass[1]) * multiplier * 100) / 100);
  }

  const altitude = text.match(/(?:海拔|altitude|elevation)\s*[:：]?\s*(\d{3,4}(?:\s*[-~至]\s*\d{3,4})?)\s*(?:m\b|米)/i);
  if (altitude) fields.altitude = altitude[1];

  const roast = read('烘焙程度|烘焙度|roast level|roast');
  const level = Object.entries(roastLevels).find(([, pattern]) => pattern.test(roast));
  if (level) fields.roast = level[0];

  const date = text.match(roastDate);
  if (date) {
    const iso = [date[1], date[2].padStart(2, '0'), date[3].padStart(2, '0')].join('-');
    const time = new Date(iso);
    if (Number.isFinite(time.getTime()) && time.toISOString().startsWith(iso + 'T')) fields.roastDate = iso;
  }
  readCompactLabel(lines, fields);
  return fields;
}
