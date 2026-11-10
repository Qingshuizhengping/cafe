// 冲煮方案的纯计算层：粉水比、按比例换算、参考时间轴。
// 计时、保存与 UI 都在 workspace.mjs，这里只放可单测的数学。

export const RATIO_PRESETS = [
  {id: '1:15', ratio: 15, name: '1:15 浓郁'},
  {id: '1:16', ratio: 16, name: '1:16 标准'},
  {id: '1:17', ratio: 17, name: '1:17 清爽'},
];

export function waterForDose(dose, ratio) {
  const grams = Number(dose);
  const value = Number(ratio);
  if (!Number.isFinite(grams) || grams <= 0) throw new Error('请输入有效的粉量。');
  if (!Number.isFinite(value) || value < 1 || value > 30) throw new Error('粉水比应在 1:1 到 1:30 之间。');
  return Math.round(grams * value * 10) / 10;
}

export function doseForWater(water, ratio) {
  const amount = Number(water);
  const value = Number(ratio);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('请输入有效的总水量。');
  if (!Number.isFinite(value) || value < 1 || value > 30) throw new Error('粉水比应在 1:1 到 1:30 之间。');
  return Math.round((amount / value) * 100) / 100;
}

// 以当前方案为母版，按新的总水量等比缩放各段累计水量，末段严格对齐总水量。
export function rescaleStages(stages, fromWater, toWater) {
  const from = Number(fromWater);
  const to = Number(toWater);
  if (!Array.isArray(stages) || !stages.length) throw new Error('请先设置分段。');
  if (!(from > 0) || !(to > 0)) throw new Error('总水量必须大于 0。');
  const scaled = stages.map((stage, index) => {
    const last = index === stages.length - 1;
    const water = last ? to : Math.round((stage.water / from) * to * 10) / 10;
    return {end: stage.end, water: Math.min(water, to)};
  });
  let previous = 0;
  for (const stage of scaled) {
    if (stage.water < previous) stage.water = previous;
    previous = stage.water;
  }
  scaled[scaled.length - 1].water = to;
  return scaled;
}

// 参考时间轴：总时长按 4:6 的手感给一个上限，各段按累计水量占比推算结束秒数。
export function referenceTimeline(stages, totalSeconds) {
  if (!Array.isArray(stages) || !stages.length) return [];
  const total = Number(totalSeconds);
  const lastWater = Number(stages.at(-1)?.water) || 0;
  return stages.map((stage, index) => {
    const end = index === stages.length - 1 && total > 0 ? total
      : total > 0 && lastWater > 0 ? Math.round((stage.water / lastWater) * total) : stage.end;
    return {end, water: stage.water};
  });
}

export function stageState(stages, seconds) {
  const index = stages.findIndex(item => seconds < item.end);
  if (index < 0) return {index: -1, remaining: 0, water: stages.at(-1)?.water ?? 0, done: true};
  return {index, remaining: stages[index].end - seconds, water: stages[index].water, done: false};
}

export function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

// 预计注水速率（g/s），用于提示“这一杯注水是否偏快”。
export function pourRate(stages) {
  if (!Array.isArray(stages) || !stages.length) return 0;
  const total = Number(stages.at(-1)?.water) || 0;
  const seconds = Number(stages.at(-1)?.end) || 0;
  return seconds > 0 ? Math.round((total / seconds) * 100) / 100 : 0;
}
