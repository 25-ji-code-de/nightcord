# SEKAI 语法规范

**Structured Extensible Keyword for Advanced Interactions**

Nightcord 的可扩展富文本标记语言，提供统一、向后兼容的富媒体和文本格式化能力。

## 设计原则

1. **向后兼容** - 旧客户端看到的是可读文本
2. **统一格式** - `[Type:Data]` 模式易于解析和扩展
3. **纯客户端** - 无需修改服务端，消息存储为纯文本
4. **渐进增强** - 新客户端逐步渲染富文本
5. **防止误触发** - 明确的语法规则，避免日常文本意外格式化

## 语法规范

### 1. 基础富媒体

统一格式：`[Type:Data]` 或 `[Type:Data|Metadata]`

#### 1.1 图片 (Image)
```
[img:URL]
[img:URL|AltText]
```

**示例：**
```
[img:https://example.com/photo.jpg]
[img:https://example.com/photo.jpg|我的照片]
```

**渲染：**
- 内联显示图片，支持懒加载
- Alt 文本作为 img 的 alt 和 title 属性

#### 1.2 文件 (File)
```
[file:ID|FileName|Size]
```

**示例：**
```
[file:https://example.com/doc.pdf|项目文档.pdf|2.5MB]
[file:abc123|报告.docx|1.2MB]
```

**渲染：**
- 文件卡片 UI（图标 + 文件名 + 大小）
- 点击下载或打开

#### 1.3 音频 (Audio)
```
[audio:ID|Duration]
[audio:URL|Duration]
```

**示例：**
```
[audio:https://example.com/music.mp3|3:45]
[audio:abc123|2:30]
```

**渲染：**
- 音频播放器控件
- 显示时长

#### 1.4 Stamp/Sticker
```
[stamp:ID]
```

**语法糖（向后兼容）：**
```
[stamp0000]  → 解析为 [stamp:0000]
[xxx]        → 解析为 [stamp:xxx]（如果不是其他已知类型）
```

**示例：**
```
[stamp:0806]
[stamp0806]    ← 语法糖
[smile]        ← 语法糖（如果 smile 是已知 sticker）
```

**渲染：**
- 复用现有 StickerService
- 单独 stamp 显示大尺寸，行内显示小尺寸

### 2. 文本格式化

使用类 Markdown 语法，与现有格式不冲突。

#### 2.1 粗体
```
**加粗文本**
```

#### 2.2 斜体
```
*斜体文本*
```

#### 2.3 删除线
```
~~删除的文本~~
```

#### 2.4 黑幕/防剧透
```
||剧透内容点击显示||
```

**渲染：**
- 默认黑色背景遮挡
- 点击或 hover 显示内容
- 支持 `.revealed` 类持久显示

#### 2.5 引用
```
> 这是引用的文本
> 可以多行
```

#### 2.6 行内代码
```
`code here`
```

**注意：**
- 不支持代码块（多行 ```），避免复杂性
- 行内代码足够满足日常使用

### 3. 高级交互

#### 3.1 回复引用
```
[re:Timestamp]
[re:Timestamp|预览文本]
```

**示例：**
```
[re:1234567890]
[re:1234567890|原消息：你好吗？]
```

**渲染：**
- 显示回复引用卡片
- 点击跳转到原消息（如果可见）
- 如果有预览文本，显示原消息片段

#### 3.2 链接卡片
```
[link:URL|Title]
[link:URL|Title|Description]
```

**示例：**
```
[link:https://example.com|Example 网站]
[link:https://github.com|GitHub|代码托管平台]
```

**渲染：**
- 带标题的链接卡片
- 可选描述文本
- 区别于普通自动链接

#### 3.3 彩色文字
```
[color:hex|文本]
[color:#hex|文本]
```

**示例：**
```
[color:ff0000|红色文字]
[color:#00ff00|绿色文字]
```

**渲染：**
- 应用指定颜色
- 支持 3/6 位 hex 颜色
- 可选 `#` 前缀

### 4. 特殊规则

#### 4.1 AI 人设前缀（已有系统）
```
[Nako]消息内容
[Asagi]消息内容
[Miku]消息内容
[汤川唯]消息内容
```

**处理：**
- 在 SEKAI 解析前已被 nightcord-mgr.js 移除
- 不参与 SEKAI 令牌解析

#### 4.2 @mention（已有系统）
```
@用户名
```

**处理：**
- 自动补全已支持
- 未来可扩展为高亮显示

#### 4.3 自动链接
```
https://example.com
http://example.com
```

**渲染：**
- 自动检测 URL 并转为可点击链接
- 使用 markdown-it linkify 功能

## 解析流程

### 当前流程（旧版）
```
1. 检测 AI 前缀 → 移除并改变发送者
2. Pangu 处理 → 保护 [sticker]
3. Sticker 渲染 → [name] 转为 <img>
4. 显示 → textContent 或 DocumentFragment
```

### 新流程（SEKAI）
```
1. AI 前缀检测（nightcord-mgr.js，保持不变）
   ↓
2. SEKAI 解析（新增 sekai-renderer.js）
   a. 标准化语法糖
      [stamp0000] → [stamp:0000]
      [xxx] → [stamp:xxx]（排除 type:data 和 AI 名称）
   b. 令牌化（tokenize）
      分离 SEKAI 令牌 [type:data] 和纯文本块
   c. 文本格式化
      处理 ** * ~~ || > ` 等 Markdown 语法
   ↓
3. 渲染（render）
   a. SEKAI 令牌 → DOM 元素（img/file card/audio player）
   b. 纯文本 → Markdown 处理 → Pangu → TextNode
   ↓
4. 组装 DocumentFragment
```

## 安全性

### XSS 防护
- 使用 DOMPurify 清理所有 HTML
- URL 白名单（可选）
- 禁止 `javascript:` 协议

### 标签白名单
```javascript
const ALLOWED_TAGS = [
  'strong', 'em', 'del', 'code',    // 文本格式
  'blockquote', 'br',                // 引用、换行
  'span',                             // 彩色文字、黑幕
  'img', 'audio',                     // 富媒体
  'a'                                 // 链接
];

const ALLOWED_ATTR = {
  'img': ['src', 'alt', 'title', 'class', 'loading'],
  'a': ['href', 'target', 'rel', 'class'],
  'span': ['class', 'style', 'data-*'],
  'audio': ['src', 'controls', 'class'],
  '*': ['class']
};
```

## 实现计划

### Phase 1: 核心解析器 ✅ TODO
- [ ] 创建 `sekai-renderer.js`
- [ ] 实现 `SekaiRenderer` 类
  - [ ] `normalizeSyntaxSugar()` - 语法糖标准化
  - [ ] `tokenize()` - 令牌化解析
  - [ ] `render()` - 渲染为 DocumentFragment
- [ ] 编写单元测试（可选）

### Phase 2: 基础富媒体 ⏳ TODO
- [ ] `[stamp:ID]` 渲染
  - [ ] 复用现有 StickerService
  - [ ] 语法糖兼容 `[stamp0000]` → `[stamp:0000]`
  - [ ] 语法糖兼容 `[xxx]` → `[stamp:xxx]`
- [ ] `[img:URL]` / `[img:URL|Alt]`
  - [ ] 内联图片显示
  - [ ] 懒加载支持
  - [ ] 错误处理（加载失败显示 alt）
- [ ] `[file:ID|Name|Size]`
  - [ ] 文件卡片 UI 组件
  - [ ] 文件图标（根据扩展名）
  - [ ] 点击下载功能
- [ ] `[audio:ID|Duration]`
  - [ ] HTML5 audio 控件
  - [ ] 自定义播放器样式（可选）

### Phase 3: 文本格式化 ✅ DONE
- [x] 集成 markdown-it（轻量 Markdown 解析器）
- [x] 配置 markdown-it
  - [x] 禁用不需要的功能（heading, image, table 等）
  - [x] 启用 linkify（自动链接）
  - [x] 启用 breaks（换行转 `<br>`）
- [x] 实现基础格式
  - [x] `**粗体**` → `<strong>`
  - [x] `*斜体*` → `<em>`
  - [x] `~~删除线~~` → `<del>`
  - [x] `` `代码` `` → `<code>`
  - [x] `> 引用` → `<blockquote>`
- [x] 实现黑幕 `||spoiler||`
  - [x] 自定义解析规则
  - [x] CSS 样式（黑色遮挡）
  - [x] 点击/hover 交互
- [x] 与 Sticker 集成
  - [x] Markdown 处理后递归查找文本节点
  - [x] 替换 [xxx] 为 sticker 图片

### Phase 4: 高级交互 ✅ DONE
- [x] `[re:timestamp]` 回复引用
  - [x] 消息索引维护（timestamp → message）
  - [x] 回复卡片 UI
  - [x] 点击跳转功能
  - [x] 预览文本支持 `[re:ts|preview]`
- [x] `[link:URL|Title]` 链接卡片
  - [x] 链接卡片 UI 组件
  - [x] 描述文本支持
  - ⏸️ Open Graph 预览（可选，需要服务端）
- [x] `[color:hex|text]` 彩色文字
  - [x] hex 颜色解析（支持 3/6 位，带/不带 `#`）
  - [x] 应用内联样式或 CSS 变量
  - [x] 颜色对比度检查（确保可读性）
- [x] `[truecolor:hex|text]` 真彩色文字（保持原始颜色）

### Phase 5: 集成与优化 ⏳ TODO
- [ ] 替换 ui-manager.js 中的 StickerService 调用
  - [ ] `createMessageElement()` 使用 SekaiRenderer
  - [ ] `appendStreamingContent()` 支持 SEKAI 语法
  - [ ] `finishStreamingMessage()` 支持 SEKAI 语法
- [ ] 添加 DOMPurify
  - [ ] 加载 DOMPurify 库
  - [ ] 配置白名单
  - [ ] XSS 过滤
- [ ] 性能优化
  - [ ] 缓存解析结果（可选）
  - [ ] 懒加载图片/音频
  - [ ] 虚拟滚动（大量消息时）
- [ ] CSS 样式
  - [ ] 富媒体元素样式
  - [ ] 文本格式样式
  - [ ] 响应式设计（移动端）
- [ ] 测试
  - [ ] 兼容性测试（旧客户端）
  - [ ] 边界情况测试
  - [ ] 性能测试

## 示例

### 完整消息示例
```
大家好！

这是**粗体**和*斜体*文字，还有~~删除线~~。

我发现了一个有趣的链接：https://github.com

这是行内代码：`const x = 42;`

> 引用的文字
> 可以多行

分享一张图片：[img:https://example.com/photo.jpg|我的照片]

发送一个表情：[stamp:0806]

||这是剧透内容，点击查看||

文件分享：[file:https://example.com/doc.pdf|文档.pdf|2.5MB]

[color:ff0000|红色的重点文字]

回复楼上：[re:1234567890|原消息内容]
```

### 旧客户端显示（向后兼容）
```
大家好！

这是**粗体**和*斜体*文字，还有~~删除线~~。

我发现了一个有趣的链接：https://github.com

这是行内代码：`const x = 42;`

> 引用的文字
> 可以多行

分享一张图片：[img:https://example.com/photo.jpg|我的照片]

发送一个表情：[stamp:0806]

||这是剧透内容，点击查看||

文件分享：[file:https://example.com/doc.pdf|文档.pdf|2.5MB]

[color:ff0000|红色的重点文字]

回复楼上：[re:1234567890|原消息内容]
```

### 新客户端显示（富文本渲染）
- **粗体**、*斜体*、~~删除线~~ 正常渲染
- 链接自动可点击
- 图片内联显示
- Stamp 渲染为表情图片
- 黑幕需要点击显示
- 文件显示为卡片
- 彩色文字应用颜色
- 回复引用显示卡片

## 技术栈

- **markdown-it** - Markdown 解析器（~20KB gzipped）
- **DOMPurify** - XSS 过滤器（~23KB gzipped）
- **现有 StickerService** - 复用 stamp 渲染逻辑
- **Pangu.js** - 中英文空格（已有）

## 兼容性

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ 移动浏览器（iOS Safari, Chrome Mobile）

## 参考

- [Markdown 规范](https://commonmark.org/)
- [BBCode 参考](https://www.bbcode.org/reference.php)
- [Discord Markdown](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline-)
- [Telegram Bot API](https://core.telegram.org/bots/api#formatting-options)

---

**Status**: 🚧 In Progress
**Last Updated**: 2026-02-15
**Version**: 0.1.0
