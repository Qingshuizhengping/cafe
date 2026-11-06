# 豆档

拍摄咖啡豆包装或从相册选图，核对识别结果后保存到本机豆库。默认在浏览器内处理照片，识别组件和中英文模型需要联网加载。

## 本地预览

在本目录运行 `python -m http.server 8765`，打开 `http://localhost:8765/`。

## 部署

使用静态站点服务，将本目录的 `index.html`、`preview.css`、`preview.mjs` 和 `core/` 放到站点根目录。服务器需将 `.mjs` 作为 JavaScript 提供。目标地址为 `8.134.141.217:1633`，需配置手机可访问的有效 HTTPS。

## iPhone 安装

确认 iPhone 可以在 Safari 中打开部署后的 HTTPS 页面。点击页面上的「安装到 iPhone」，核对网址并下载描述文件，然后进入「设置 → 已下载描述文件」安装。

也可以运行 `node make-profile.mjs <实际 HTTPS 网址>` 生成 `doudang.mobileconfig`。通过站点分发时，为描述文件设置 MIME 类型 `application/x-apple-aspen-config`。描述文件只包含可移除的全屏 Web Clip。

## 可选的 AI 辅助识别

用 Node.js 20.20 或更新版本运行 `vision-server.mjs`。在服务端环境中配置：

- `CAFE_VISION_BASE_URL` 为兼容接口的 HTTPS Base URL，包含接口的版本路径。
- `CAFE_VISION_MODEL` 为可读取图片的模型名。
- `CAFE_VISION_API_KEY` 为供应商密钥。
- `CAFE_VISION_ACCESS_CODE` 为至少 24 字符的独立随机访问码，私下交给需要使用该功能的人。
- `CAFE_VISION_PORT` 默认为 1634，服务只监听本机。

通过站点的 HTTPS 反向代理将 `/api/vision` 转给该进程，允许最多 2 MiB 的请求体。站点根目录继续只提供静态文件。接口启用后，拍照或选图的用户可主动发送当前豆袋照片给模型服务。接口用访问码验证请求，模型密钥从服务端读取。无需配置 AI 服务即可使用本地 OCR。
