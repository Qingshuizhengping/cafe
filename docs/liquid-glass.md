# 豆档的 Web 玻璃预览

遵循 Apple 的材质分层原则：透镜效果用于底部导航、主题切换、录入入口和减豆按钮；豆档内容卡片保留安静的常规材质，数据条保留连续圆角胶囊。没有新增绿色或石墨色主按钮填充。

`core/liquid-glass.mjs` 改编自本工作区 AI七嫂的光学渲染器。单个 WebGL context 将已知卡片表面、同源或本机豆袋图片绘成场景纹理，再按控件曲面法线执行折射、反射、边缘高光和轻微分通道采样。结果通过局部 2D canvas 呈现；文字、按钮及可访问名称保持原生 DOM。照片采样只在本机处理。

这不是 Apple 原生 Liquid Glass API，也不读取操作系统窗口或任意网页的合成像素。采样场景重绘已知卡片与图片，不包含正文文字、表单值或所有页面元素。纯色区域的折射位移通常不可见；不要把这描述成对整个网页内容的精确折射。

按需重绘，隐藏页面停止渲染，分辨率预算不超过 140 万像素。减少透明度、强制色、缺少 WebGL 或 context 丢失时降级为 CSS 材质；context 恢复后重建资源。减少动态效果时停止指针驱动的光源变化。

本地验证：Chromium、Firefox、WebKit 覆盖深浅主题、320/390/768/1280px、文字对比、控件尺寸、长文本、减豆撤销、右键和键盘操作。Chromium 与 WebKit 另验证固定光照条件下的纹理位移、画布非空及无障碍降级；Chromium 检查 context 丢失和恢复。本机浏览器引擎验证不等同于 iPhone 真机验收。测试和截图位于忽略目录 `.hallmark/`。

参考：[Apple 材质指南](https://developer.apple.com/design/human-interface-guidelines/materials)、[Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)、[自定义视图使用 Liquid Glass](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views)。
