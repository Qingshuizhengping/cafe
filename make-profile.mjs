import {readFile, writeFile} from 'node:fs/promises';
import {webClipProfile} from './core/webclip.mjs';

const [address, iconPath] = process.argv.slice(2);
if (!address) {
  console.error('用法：node make-profile.mjs <部署后的 HTTPS 网址> [PNG 图标路径]');
  process.exitCode = 1;
} else {
  try {
    const icon = (await readFile(iconPath ?? new URL('./assets/app-icon.png', import.meta.url))).toString('base64');
    const file = new URL('./doudang.mobileconfig', import.meta.url);
    await writeFile(file, webClipProfile(address, icon));
    console.log('已生成 doudang.mobileconfig');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
