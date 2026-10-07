# PDF AI Translate — Zotero 插件

在 Zotero 里翻译整篇 PDF，导出**左右对照的双语 PDF**。右侧保持原文版式：单栏论文仍是单栏，双栏论文仍是双栏，**图片、公式、图表原位保留**，只把正文替换成译文。

- 支持 **Zotero 10**（在 10.0.3 / 10.0.5 上实测通过）
- **纯 JavaScript，不需要 Python 环境**：装上 `.xpi` 就能用
- 通过 **baseURL + API Key** 接入任意 OpenAI 兼容服务（DeepSeek / OpenAI / 硅基流动 / 智谱 / Kimi / 通义 / 火山方舟 / OpenRouter / Ollama / LM Studio / 自建）
- 导出路径可选：**与论文同级文件夹** / 指定文件夹 / Zotero 数据目录
- 许可：MIT（依赖仅 pdf-lib、fontkit、pdfjs-dist、zotero-plugin-toolkit，字体为 OFL）

---

## 效果

左：原始页面（未改动）。右：同一页面，正文替换为中文，**双栏结构、Figure、公式全部原位保留**。

```
┌──────────────────────┬──────────────────────┐
│                      │                      │
│   original page      │   translated page    │
│   (untouched)        │   (same layout)      │
│                      │                      │
│   ▓ Figure 3         │   ▓ Figure 3         │
│   ▓ formula (1)      │   ▓ formula (1)      │
│                      │                      │
└──────────────────────┴──────────────────────┘
```

## 工作原理

```
Zotero 条目
   │
   ├─ 1. 提取   pdfjs-dist 取每页文字 + 坐标 + 真实字体名
   │            · 按真实基线分行，上下标附着到同栏文字；竖排边注不参与正文翻译
   │            · 根据栏间隙和重复左边缘识别双栏，稀疏页面参考整篇文档的栏位
   │            · 段落 = 同栏、行距正常、无缩进的连续行
   │            · 公式 = 数学字体名（CMMI/CMSY/…）+ Unicode 区间
   │
   ├─ 2. 翻译   OpenAI 兼容 /chat/completions
   │            · 带索引的 JSON 数组，便于检出漏译并只重发漏掉的那几段
   │            · 图形位置、嵌套图形裁剪范围、表格线框与重复单元格列用于排除图表内文字
   │            · 公式替换为 ⟦M1⟧ 占位符，要求模型原样保留
   │            · 并发 + 指数退避 + 结果缓存
   │
   ├─ 3. 排版   pdf-lib
   │            · 左半：原页矢量嵌入
   │            · 右半：原页矢量嵌入 → 用白色矩形盖住原文行框 →
   │                    在段落自己的框内绘制译文（按原段落字号、宽高自动适配）
   │            · 整行公式、图片所在区域不覆盖，因此原样保留
   │
   └─ 4. 导出   写文件 → 可选挂为 Zotero 附件 → 可选自动打开
```

**为什么"保持版式"比"重排单栏"更简单**：段落本来就落在某一栏内，把译文画回它自己的框里，栏结构自然就继承了；图片和公式是页面内容的一部分，只要不覆盖它们就自动保留。

## 安装

### 直接下载（推荐）

到 [Releases](https://github.com/111112200/zotero-pdf-ai-translate/releases/latest) 下载 `pdf-ai-translate.xpi`，然后：

Zotero → **工具 → 插件** → 右上角齿轮 → **Install Plugin from File…** → 选该 `.xpi` → 重启 Zotero。

不需要 Python、不需要 Node、不需要任何服务。整个插件就是这一个文件。

### 从源码构建

```powershell
npm install
npm run build:xpi
# 产物：.scaffold/build/pdf-ai-translate.xpi
```

## 配置

**工具 → PDF AI 翻译 → PDF AI 翻译设置…**（也可以从库列表右键菜单进入，或直接走 Zotero 的 **编辑 → 设置 → PDF AI Translate**）

| 项 | 说明 |
|---|---|
| Provider / Base URL / API Key / Model | 任意 OpenAI 兼容端点。选服务商后 Base URL 与模型会自动填好，**通常只需粘一个 API Key**。填好点「测试连接」验证。 |
| 源语言 / 目标语言 | 默认 `auto` → `zh-CN`。 |
| 译文排版 | 无需设置字号。标题、正文按各自原段落的宽高和字号自动适配，行距受原文区域约束。 |
| 导出位置 | **与源 PDF 同级文件夹**（默认）/ 指定文件夹 / Zotero 数据目录 |
| 加入附件 | 导出的 PDF 是否挂到该条目下 |
| 并发请求数 | 默认 4；免费额度服务建议降到 1–2 |
| 图片、表格和公式 | 图表和算法框内部文字不参与翻译；独立公式保持原位，行内公式及上下标以原始矢量字形嵌入译文。 |

> **关于 API Key 存储**：Key 以明文存在 Zotero 首选项里（Zotero 未提供面向插件的凭据存储 API）。请勿在共享配置文件的机器上填写。

> **关于"同级文件夹"**：若 PDF 是**链接附件**，同级目录就是你自己的论文文件夹，最干净。若 PDF 由 Zotero 托管，同级目录是 `<数据目录>/storage/<KEY>/`，属于 Zotero 内部目录；插件会提示，并默认把它挂为正式附件。

## 开发

```powershell
npm install
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = "D:\Zotero\zotero.exe"
$env:ZOTERO_PLUGIN_PROFILE_PATH   = "$env:USERPROFILE\zotero-dev-profile"
npm start          # 启动 Zotero 并热重载插件
npm run typecheck
node --import tsx --test tools/regression.test.mts
npm run build:xpi
```

### 离线版式验证台

改排版逻辑时不必每次都重启 Zotero：

```powershell
# 用真实论文跑一遍提取 + 渲染，输出双语 PDF（译文用参考译文按比例分配）
node --import tsx tools/harness.mts "paper.pdf" tools/_out/out.pdf --pages=1-3 --zh=tools/_out/zh.json

# 逐段渲染决策（框、字号、截断）
node --import tsx tools/harness.mts "paper.pdf" tools/_out/out.pdf --pages=1-3 --dump

# 行级分栏结果
node --import tsx tools/harness.mts "paper.pdf" x --pages=2-2 --lines

# 量化检查：未遮盖的原文比例、译文重叠对数
python tools/diag-fit.py tools/_out/out.pdf

# 图表与公式保护区域的左右像素对比（默认原文在左、栏间距 12pt）
python tools/diag-preserved.py tools/_out/out.pdf tools/_out/structure.json
```

验证台的 `--zh` 支持逐页字符串数组（按长度分配，仅用于压力测试），也支持以 `pageIndex:paragraphIndex` 为键的真实逐段译文对象。`--structure` 导出段落及图表保护坐标，便于准备逐段输入。

### 自检

设置里打开「输出调试日志」，重启 Zotero。报告写到 `<Zotero 数据目录>/pdf-ai-translate-log.txt`，覆盖 pdf.js 加载、字体读取、提取、渲染，以及（若本地 mock 服务在跑）翻译链路：

```powershell
node tools/mock-openai.mjs 8765      # 另开一个终端
```

## 使用

1. **安装**：Zotero → 工具 → 插件 → 齿轮 → Install Plugin from File → 选 `.xpi` → 重启。
2. **配置**：工具 → PDF AI 翻译 → PDF AI 翻译设置…，选服务商、粘 API Key、点「测试连接」。
3. **翻译**：在库列表里右键点论文条目（或它的 PDF 附件）→ **翻译 PDF 并生成双语对照…**
4. **结果**：生成 `<原名>.bilingual.zh-CN.pdf`，左半页是未改动的原文，右半页是保持原版式的译文，默认挂为该条目的附件。

内置字体包含 `ˇ` 及组合重音符号。导出文件成功加入 Zotero 附件后，不显示未跟踪文件提示；关闭附件导入或导入失败时，提示文件尚未加入附件。

正文先使用各自原段落的字号，完整译文放不下时才缩小；居中标题与粗体层级随原文保留。中文标点不单独落在行首。重复页眉、页脚和无需翻译的作者信息或参考文献保留原始字形。译文邻近公式时，缩减可用高度，遮盖矩形避开受保护区域。

翻译期间，主窗口右下角显示无原生窗口边框的实时状态浮层。成功、失败或取消后移除。导出位置下拉框通过本地化的 `label` 属性显示当前选项。

右键菜单里还有「取消当前翻译」「运行自检…」；「运行自检…」在出问题时最先用。

## 已实测的结论（避免重复踩坑）

这些都是在本机 Zotero 10.0.5 + 真实论文上验证过的：

| 结论 | 说明 |
|---|---|
| **不能用 Zotero 自带的 pdf.js** | `resource://zotero/reader/pdf/build/pdf.mjs` 会给 `Map.prototype` 打补丁，而 `ChromeUtils.importESModule` 在另一个 realm 求值，那个 realm 的内建原型不可扩展 → `TypeError: Map.prototype is not extensible`。因此自带 `pdfjs-dist`。 |
| **pdf.js 的 worker 必须自己建** | pdf.js 内部读 `window.location` 判断同源，沙箱没有 `window`，会退回"fake worker"，而它又需要 ScriptLoader → 全部解析失败。改为 `new Worker(chrome://…/pdf.worker.min.mjs, {type:"module"})` 并通过 `GlobalWorkerOptions.workerPort` 交给 pdf.js。 |
| **沙箱缺一批 Web 全局** | 缺 `console`、`AbortController`、`Event`、`structuredClone` 等。`console`/`performance` 自己实现；其余从 `Zotero.getMainWindow()` 借。 |
| **pdf.js 页号是 1-based，pdf-lib 是 0-based** | 混用会让左右两栏贴错一页，且症状极具迷惑性（文字对不上、遮盖看着没生效）。 |
| **pdf-lib 自带的 fontkit 1.x 会丢字形** | 对 `head.indexToLocFormat === 1`（长 loca）的 TrueType 子集，它会产出**空轮廓**：PDF 里文字可搜可复制，但页面上大片不显示。任何字形数超过约 1000 的中文字体都必然触发。换成 `fontkit@2` + 一层 `encodeStream()` 适配器后，51/51 字形正常，输出仍是 ~11 KB（不子集化是 ~1.5 MB）。 |
| **公式识别只靠字体名** | 实测：正文里数学 Unicode 占比几乎全为 0（LaTeX 的 `x`/`w`/`R` 用 CMMI 但码位是普通拉丁字母）。行级阈值 0.5 是最佳工作点。 |
| **分栏必须先找栏位再分行** | 只按 y 分行会把左右栏同高度的行并成"一行"，段落框横跨两栏，渲染时译文就铺满整页。用"各行最大内部间隙的众数"投票找栏位，再用"是否有字形跨过栏位"区分真跨栏标题与两栏同行。 |
| **`main/library/item` 不允许顶层分隔符** | 它是 `GROUPED_TARGETS`，Zotero 会校验并拒绝。`main/menubar/tools` 不是分组目标，可以带分隔符。 |
| **设置面板里写 `&my-label;` 会让面板整体空白** | Zotero 用 `MozXULElement.parseXULToFragment(markup, dtdFiles)` 解析面板，`dtdFiles` 只有 Zotero 自己的两个 DTD。自定义实体引用属于**未定义实体 → 整段 XML 解析失败**，侧栏里能看到条目名，点开却是空的，UI 上没有任何报错。自检里的 `probePreferencesPane()` 会复现这一步并报出来。 |
| **`onload` 属性不会被转成监听器** | Zotero 只对 `oncommand` 做 `elem.oncommand = elem.getElementAttribute('oncommand')`。面板打开时要跑的逻辑必须走 `Zotero.PreferencePanes.register({ scripts })`，用脚本监听 `load`（该事件不冒泡，需在 document 上以捕获阶段监听）。 |
| **菜单项会显示成空白** | `Zotero.MenuManager` 只把 `data-l10n-id` 写到它创建的菜单元素上，**从不触发翻译**；它自己那段加载插件 FTL 的代码在 Zotero 10 里是被注释掉的。而且窗口加载后动态创建的元素不会被自动翻译。所以要两步：启动时用 `document.l10n.addResourceIds([...])` 把 `<addonRef>-mainWindow.ftl` 注册进主窗口，再用菜单的 `onShowing` 钩子对元素调用 `document.l10n.translateFragment(element)`。只做前者、只做后者都不行。 |
| **`onMainWindowLoad` 只为之后打开的窗口触发** | 启动时主窗口早就存在了，所以启动阶段必须自己遍历 `Services.wm.getEnumerator("navigator:browser")` 补一遍。 |
| **`openPreferences()` 收的是面板 id** | 不是首选项前缀。传错只会打开设置窗口而不跳转。 |
| **`preference=` 属性可以写裸键** | 脚手架会自动展开成 `extensions.zotero.<addonRef>.<key>` 完整键；Zotero 要求完整键，否则只会警告并绑定到一个不存在的全局首选项。 |
| **`Zotero.HTTP.request` 默认值有两个坑** | 默认 `Content-Type` 是 form-urlencoded（LLM 端点会拒）；默认对 5xx 重试上限 **1 小时**，批量翻译必须设 `errorDelayMax: 0`。 |

## 已知限制

- **扫描版 PDF 未被支持**：没有文字层就没法翻译，需要先 OCR。插件会提示"未找到可翻译文本"。
- **图表识别属于几何检测**：覆盖栅格图、嵌套矢量图、线框表格及具有至少三列、三行重复对齐单元格的无框表格。无边框两列表格、不规则单元格或正文与图形交错的页面可能无法完整识别。图注和表注仍可翻译。
- **译文过长**：字号在原段落字号的 50%–100% 范围内自动适配。完整译文仍无法放入原区域时，保留该段原文并报告，不截断译文。
- **公式检测依赖字体和符号**：独立公式保持原位；识别到的行内数学文字从原字体提取矢量轮廓，仅绘制对应字形。无法解码原数学字体时保留整段原文并报告。使用正文同字体的普通拉丁字母公式可能无法识别。
- **`/Rotate` 非 0 的页面**：坐标归一化已实现，但未在旋转页上实测。
- **仅针对 OpenAI 兼容协议**：Anthropic / Gemini 需要各自的请求格式，当前不支持（可用 OpenRouter 等中转）。

## 目录结构

```
addon/                       打包进 XPI 的资源
  bootstrap.js               生命周期（含启动期错误落盘）
  manifest.json              strict_max_version = 10.*
  prefs.js                   默认首选项
  content/
    preferences.xhtml        设置面板
    scripts/pdf.worker.min.mjs   pdf.js worker（由 tools/sync-pdfjs.mjs 同步）
    fonts/NotoSansSC-Regular.subset.ttf   GB2312 子集，8080 字形，2.3 MB，OFL
  locale/{en-US,zh-CN}/*.ftl
src/
  index.ts                   入口（先装全局垫片）
  hooks.ts                   生命周期
  modules/
    extract/                 pdf.js 提取：坐标归一化、分栏、段落、公式识别
    translate/               多服务商预设、OpenAI 兼容客户端、批处理、缓存
    render/                  字体、fontkit 适配、断行、原位覆盖式双语 PDF
    output/                  导出路径与附件回挂
    ui/                      右键菜单、设置面板
    task.ts                  编排
    selftest.ts              自检
    probe.ts                 日志与诊断报告
tools/
  build-font-subset.py       生成内置中文字体子集
  sync-pdfjs.mjs             同步 pdf.js worker
  harness.mts                离线版式验证台
  mock-openai.mjs            翻译链路测试用 mock 服务
  diag-fit.py                遮盖率与重叠量化
  regression.test.mts         提取、自动字号、图表保护、溢出保留、缺字和公式绘制回归测试
  pdf-open-benchmark.mjs      比较 pdf.js 全文页面处理时间和绘制操作数量
  ui-regression.mjs           状态浮层 DOM 与导出选项标签检查（需要 Playwright）
```

## 许可

插件代码 MIT。内置字体 Noto Sans SC 子集为 SIL OFL 1.1，可自由再分发。
