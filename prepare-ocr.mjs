import {copyFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

const require = createRequire(import.meta.url);
const target = new URL('./vendor/ocr/', import.meta.url);
await mkdir(target, {recursive: true});

const assets = [
  ['tesseract.js', 'dist/tesseract.esm.min.js'],
  ['tesseract.js', 'dist/worker.min.js'],
  ['tesseract.js', 'LICENSE.md', 'LICENSE-tesseract.js.md'],
  ['tesseract.js-core', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core', 'LICENSE', 'LICENSE-tesseract.js-core.txt'],
  ['@tesseract.js-data/chi_sim', '4.0.0_best_int/chi_sim.traineddata.gz'],
  ['@tesseract.js-data/eng', '4.0.0_best_int/eng.traineddata.gz'],
];

for (const [pkg, file, name = file.split('/').at(-1)] of assets) {
  const root = dirname(require.resolve(pkg + '/package.json'));
  await copyFile(join(root, file), new URL(name, target));
}
