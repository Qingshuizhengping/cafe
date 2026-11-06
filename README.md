# 豆档

拍摄咖啡豆包装或从相册选图，核对识别结果后保存到本机豆库。照片在浏览器内处理，识别组件和中英文模型需要联网加载。

## 本地预览

在本目录运行 `python -m http.server 8765`，打开 `http://localhost:8765/`。

## 部署

使用静态站点服务，将本目录的 `index.html`、`preview.css`、`preview.mjs` 和 `core/` 放到站点根目录。服务器需将 `.mjs` 作为 JavaScript 提供。目标地址为 `8.134.141.217:1633`，需配置手机可访问的有效 HTTPS。

## iPhone 安装

确认 iPhone 可以在 Safari 中打开部署后的 HTTPS 页面。点击页面上的「安装到 iPhone」，核对网址并下载描述文件，然后进入「设置 → 已下载描述文件」安装。

也可以运行 `node make-profile.mjs <实际 HTTPS 网址>` 生成 `doudang.mobileconfig`。通过站点分发时，为描述文件设置 MIME 类型 `application/x-apple-aspen-config`。描述文件只包含可移除的全屏 Web Clip。
