# 豆档

![豆档 · 咖啡豆库与冲煮记录，右侧展示豆档深色界面](./assets/github-cover.jpg)

豆档是一款个人咖啡豆库。拍下豆袋标签，核对识别结果后入库，再记录余量、养豆天数、冲煮与品鉴。支持浅色和深色界面，也可添加到 iPhone 主屏幕。

在「批量 / JSON 导入」中可选最多 5 张照片，逐张查看识别状态、原文并重试。单图的多豆结果会分别列出，照片附给第一颗豆。可粘贴单个豆档或对象数组，核对必填字段后再入库。未提供余量时按净含量初始化。相机预览会在设备支持时显示缩放和闪光灯，系统相机可作为备用入口。

## 日常使用

- 点击豆库卡片查看完整资料、正反面照片、逐次品鉴和库存历史。在详情页编辑资料、续购、分享或开始冲煮。
- 减豆和品鉴用量会留下消耗记录。编辑、删除品鉴会按用量差额回算当前库存，库存校正单独记录。
- 赏味状态参考烘焙日期和自用记录中的起止天数。未填写时按烘焙后 7–60 天展示，可以调整，并可设置冷冻或在途状态。
- 冲煮页支持三段式、4:6 和自定义分段方案，计时可暂停、继续并在刷新后恢复。完成后保存品鉴时扣除用豆。
- 统计页显示已记录的消耗、花费、库存价值、库存预测和个人评分榜单。历史消费从记录功能启用后累计。
- 数据页可以导出、校验并合并恢复 JSON 备份，包含豆档、图片、库存历史、品鉴和已保存的冲煮方案。同编号但内容不同的数据另存为副本，重复导入相同内容会跳过。

## 识别与数据

启用 GLM 后，选中的豆袋照片会由服务器转发给配置的模型供应商。单张照片在 GLM 不可用或未识别到可用字段时，可以回退到浏览器内的 OCR。

本机模式将资料保存在当前浏览器。登录后，豆档、照片、库存历史、品鉴和冲煮方案会同步到部署者的服务器。草稿和正在进行的冲煮计时保留在当前设备。可在账号面板选择「合并本机资料」，也可随时导出 JSON 备份。

## 本地预览

在本目录运行 `npm ci`、`npm run prepare:ocr`，然后运行 `python -m http.server 8765`，打开 `http://localhost:8765/`。这会在 `vendor/ocr/` 生成 OCR 脚本、识别引擎和中英语言包。

## 部署

将 `index.html`、`preview.css`、`preview.mjs`、`workspace.mjs`、`importer.mjs`、`account.mjs`、`assets/app-icon.png`、`core/` 和生成的 `vendor/ocr/` 放到静态站点根目录。站点需使用有效的 HTTPS，并以 JavaScript 类型提供 `.mjs` 文件。

## 账号服务

在服务器安装生产依赖后运行 `node account-server.mjs`。将 `CAFE_ACCOUNT_ORIGIN` 设为自己的 HTTPS 站点来源，例如 `https://coffee.example.com`，将 `CAFE_ACCOUNT_DB` 设为静态站点目录之外的持久化 SQLite 文件路径。通过同源代理转发 `/api/account/`，并允许 16 MiB 请求体。使用 SQLite 在线备份机制备份账号数据。

## iPhone 安装

用自己的站点地址运行 `node make-profile.mjs https://coffee.example.com/`，生成带豆档图标的 `doudang.mobileconfig`。将描述文件放到自己的站点上，并设置 MIME 类型为 `application/x-apple-aspen-config`。在 iPhone 的 Safari 中下载后，前往「设置 → 已下载描述文件」安装。

## GLM 识别

在服务器安装生产依赖后，用 Node.js 20.20 或更新版本运行 `vision-server.mjs`，并将站点的 `/api/vision` 转发到识别服务。使用服务端环境变量配置供应商的 HTTPS 接口、视觉模型和 API 密钥，变量名可查看 [服务端配置入口](./vision-server.mjs)。实际密钥和服务端配置应保存在部署环境中。

## 致谢

感谢 Brew Guide 的作者 chuthree 和项目贡献者分享他们的实现。豆档在豆仓管理、冲煮与品鉴记录，以及拍照识别后核对入库的流程设计中参考了这个项目。 [Brew Guide](https://github.com/chuthree/brew-guide)
