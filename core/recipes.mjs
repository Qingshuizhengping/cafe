export function validateStages(stages, water) {
  if (!Array.isArray(stages) || !stages.length || stages.length > 12) throw new Error('请设置 1 到 12 个冲煮阶段。');
  let previousTime = 0;
  let previousWater = 0;
  for (const stage of stages) {
    if (!stage || !Number.isInteger(stage.end) || stage.end <= previousTime || stage.end > 3600 ||
        !Number.isFinite(stage.water) || stage.water < previousWater || stage.water > water) {
      throw new Error('各段结束时间须递增且不超过 3600 秒，累计水量须递增且不超过总水量。');
    }
    previousTime = stage.end;
    previousWater = stage.water;
  }
  if (previousWater !== water) throw new Error('最后一段的累计水量应等于总水量。');
}

export function validateRecipes(recipes) {
  if (!Array.isArray(recipes)) throw new Error('冲煮方案格式无效。');
  return recipes.map(recipe => {
    if (!recipe || typeof recipe.id !== 'string' || typeof recipe.name !== 'string' || !recipe.name.trim() ||
        !Number.isFinite(Number(recipe.dose)) || !Number.isFinite(Number(recipe.water)) ||
        !(Number(recipe.dose) > 0) || !(Number(recipe.water) > 0)) throw new Error('冲煮方案参数无效。');
    validateStages(recipe.stages, Number(recipe.water));
    return {id: recipe.id, name: recipe.name, dose: Number(recipe.dose), water: Number(recipe.water),
      temp: String(recipe.temp ?? ''), grind: String(recipe.grind ?? ''), equipment: String(recipe.equipment ?? ''),
      stages: recipe.stages.map(stage => ({end: stage.end, water: stage.water}))};
  });
}
