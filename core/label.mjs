const aliases = {
  name: '名称|豆名|咖啡豆|coffee name|name',
  roaster: '烘焙商|烘焙品牌|roasted by|roaster',
  origin: '原产地|产区|产地|country|region|origin',
  farm: '庄园|农场|处理站|estate|farm|washing station',
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

export function parseLabel(rawText) {
  const text = rawText.normalize('NFKC').replace(/[–—]/g, '-');
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
    ?? text.match(/^(\d+(?:\.\d+)?)\s*(kg|千克|g|克|oz)\s*$/im);
  if (mass) {
    const multiplier = /kg|千克/i.test(mass[2]) ? 1000 : /^oz$/i.test(mass[2]) ? 28.3495 : 1;
    if (Number(mass[1]) > 0) fields.weight = String(Math.round(Number(mass[1]) * multiplier * 100) / 100);
  }

  const altitude = text.match(/(?:海拔|altitude|elevation)\s*[:：]?\s*(\d{3,4}(?:\s*[-~至]\s*\d{3,4})?)\s*(?:m\b|米)/i);
  if (altitude) fields.altitude = altitude[1];

  const roast = read('烘焙程度|烘焙度|roast level|roast');
  const level = Object.entries(roastLevels).find(([, pattern]) => pattern.test(roast));
  if (level) fields.roast = level[0];

  const date = text.match(/(?:烘焙日期|烘焙日|roast(?:ed)? (?:date|on))\s*[:：]?\s*(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/i);
  if (date) {
    const iso = [date[1], date[2].padStart(2, '0'), date[3].padStart(2, '0')].join('-');
    const time = new Date(iso);
    if (Number.isFinite(time.getTime()) && time.toISOString().startsWith(iso + 'T')) fields.roastDate = iso;
  }
  return fields;
}
