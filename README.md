# 豆档

拍摄咖啡豆包装或从相册选图，照片默认交给 GLM 识别，结果自动填入豆档。核对后保存到本机豆库。GLM 不可用或没有读到字段时，改用浏览器内的 OCR。

## 日常使用

- 点击豆库卡片查看完整资料、正反面照片、逐次品鉴和库存历史。在详情页编辑资料、续购、分享或开始冲煮。
- 减豆和品鉴用量会留下消耗记录。编辑、删除品鉴会按用量差额回算当前库存，库存校正单独记录。
- 赏味状态参考烘焙日期和自用记录中的起止天数。未填写时按烘焙后 7–60 天展示，可以调整，并可设置冷冻或在途状态。
- 冲煮页支持三段式、4:6 和自定义分段方案，计时可暂停、继续并在刷新后恢复。完成后保存品鉴时扣除用豆。
- 统计页显示已记录的消耗、花费、库存价值、库存预测和个人评分榜单。历史消费从记录功能启用后累计。
- 数据页可以导出、校验并合并恢复 JSON 备份，包含豆档、图片、库存历史、品鉴和已保存的冲煮方案。同编号但内容不同的数据另存为副本，重复导入相同内容会跳过。

资料保存在当前浏览器的 localStorage，跨设备迁移通过导出与导入备份完成。

## 本地预览

在本目录运行 `python -m http.server 8765`，打开 `http://localhost:8765/`。

## 部署

使用静态站点服务，将本目录的 `index.html`、`preview.css`、`preview.mjs`、`workspace.mjs` 和 `core/` 放到站点根目录。服务器需将 `.mjs` 作为 JavaScript 提供。目标地址为 `coffee.example.com`，需配置手机可访问的有效 HTTPS。

## iPhone 安装

在 iPhone 的 Safari 中下载[豆档描述文件](https://coffee.example.com/doudang.mobileconfig)，然后进入「设置 → 已下载描述文件」安装。

也可以运行 `node make-profile.mjs <实际 HTTPS 网址>` 生成 `doudang.mobileconfig`。通过站点分发时，为描述文件设置 MIME 类型 `application/x-apple-aspen-config`。描述文件只包含可移除的全屏 Web Clip。

## GLM 识别

用 Node.js 20.20 或更新版本运行 `vision-server.mjs`。在服务端环境中配置：

- `CAFE_VISION_BASE_URL` 为兼容接口的 HTTPS Base URL，包含接口的版本路径。
- `CAFE_VISION_MODEL` 为可读取图片的模型名。
- `CAFE_VISION_API_KEY` 为供应商密钥。
- `CAFE_VISION_PORT` 默认为 1634，服务只监听本机。

通过站点的 HTTPS 反向代理将 `/api/vision` 转给该进程，允许最多 2 MiB 的请求体。站点根目录继续只提供静态文件。模型密钥从服务端读取。服务最多并发处理两张照片，每小时最多向模型发起 120 次请求。
