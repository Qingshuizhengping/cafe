const escapeXml = value => value.replace(/[<>&"']/g, char => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[char]);

export function webClipProfile(address, iconBase64 = '') {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('请输入 iPhone 可以打开的 HTTPS 网址。');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(iconBase64)) throw new Error('图标格式无效。');
  const icon = iconBase64 ? '<key>Icon</key><data>' + iconBase64 + '</data>\n<key>Precomposed</key><true/>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>app.doudang.profile</string>
<key>PayloadUUID</key><string>36F99D39-98C2-4F35-A61D-8376A3FA3DFB</string>
<key>PayloadDisplayName</key><string>豆档</string>
<key>PayloadDescription</key><string>在 iPhone 主屏幕添加豆档入口。</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.webClip.managed</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>app.doudang.profile.webclip</string>
<key>PayloadUUID</key><string>5CB4205A-D377-44DE-A3E5-92F004E7B6F1</string>
<key>PayloadDisplayName</key><string>豆档</string>
<key>Label</key><string>豆档</string>
<key>URL</key><string>${escapeXml(url.href)}</string>
<key>FullScreen</key><true/>
<key>IsRemovable</key><true/>
${icon}
</dict></array></dict></plist>`;
}
