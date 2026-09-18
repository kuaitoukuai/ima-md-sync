# ima-md-sync

把本地散落的「AI 问答总结 md 文档」自动同步到腾讯 ima 知识库的命令行工具。

适用场景：你习惯在和 AI 聊完后让它把对话总结成一份 md 存档（命名如 `2026-09-18_主题_ai问答.md`），时间久了文档散落在桌面、下载、会话归档等各个角落——本工具每天定时把**新出现的文档**自动上传到指定的 ima 知识库，已传过的绝不重传，并生成一份可点击跳转的 Excel 总目录。

## 功能特性

- 🔍 **多目录扫描**：桌面 / Documents / Downloads / 会话归档等根目录递归查找目标文档
- 🧊 **自适应冷却**：连续无命中的目录自动进入冷却期（默认 14 天不扫），二次扫描近乎秒级
- 🚫 **两层去重**：远端知识库文件名清单 + 本地上传记录，双重保证不重复上传；上传前还会过一次服务端重名检查
- 📤 **完整上传流水线**：重名检查 → create_media → 腾讯云 COS 直传 → add_knowledge，全程走 ima 官方 OpenAPI
- 📊 **Excel 目录**：自动生成带 `HYPERLINK` 的总目录（名称/大小/原位置/生成时间/上传时间/状态），点击文件名直接打开本地 md
- 🔁 **知识闭环**：文档入库后，AI 工作台（如 WorkBuddy）可连接同一个 ima 知识库搜索、检索、引用，让存档变成"活知识"
- 🔒 **零硬编码凭据**：凭证从 `~/.config/ima/` 读取，不写入代码和日志

## 为什么要做：知识的汇聚与再利用

本工具的终点不是"备份"，而是**让知识重新进入使用循环**：

```
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  ▼                                                     │
AI 对话 ──► 总结成 md 存档 ──► 本工具自动上传 ima 知识库 │
                                            │          │
                                            ▼          │
                              AI 工作台连接 ima 知识库  │
                              随时搜索 / 检索 / 引用 ───┘
```

- **散落 → 汇聚**：散落在桌面、下载、会话归档的文档汇入同一个知识库，可检索、可问答
- **存档 → 再用**：和 AI 的新对话可以直接引用历史结论（RAG 检索），不用重复提问、不用翻文件夹
- **循环 → 增值**：每多一篇入库文档，AI 能调用的知识就多一分——用得越多，库越值钱

## 工作原理

```
扫描本地目录 ──► 匹配目标文件名 ──► 拉取知识库已有文件清单 ──► 差集（未上传的）
     │                                                            │
     └─ 无命中目录进入冷却期                                       ▼
                                              逐个上传（重名检查→COS直传→入库）
                                                                   │
                                                    更新本机状态 state.json
                                                                   ▼
                                              生成 md 目录 + Excel 目录
```

**文件名匹配规则分两层**（可在 `config.json` 调整）：

| 目录类型 | 规则 | 示例 |
|---|---|---|
| 默认（桌面等） | `YYYY-MM-DD_主题_ai问答.md` | `2026-09-18_浏览器自动化_ai问答.md` |
| 宽松（AI 会话归档目录） | 文件名含日期**或**含中文的 md | `2026-09-08.md`、`项目复盘总结.md` |

0 字节空文件、超过 10MB（ima 对 md 的上限）的文件自动跳过。

## 快速开始

### 1. 安装 ima 技能并获取凭证

**① 安装 ima 技能**（供 WorkBuddy 等 AI 工作台/编码工具调用 ima 能力，非本工具必需但推荐）：

- 下载地址：<https://app-dl.ima.qq.com/skills/ima-skills-1.1.10.zip>
- 下载后解压，将技能目录放入你所用 AI 工具的技能目录（WorkBuddy 为 `~/.workbuddy/skills/`），版本号以 [agent-interface 页面](https://ima.qq.com/agent-interface) 最新提示为准

**② 获取 API Key**：

- 打开 <https://ima.qq.com/agent-interface>，按页面提示 **第 2 步：获取 API Key**
- 拿到 Client ID 和 API Key 后，可直接发给你的 AI 助手（如小龙虾）完成配置，或手动存放：

```bash
mkdir -p ~/.config/ima
echo "你的ClientID" > ~/.config/ima/client_id
echo "你的APIKey"  > ~/.config/ima/api_key
```

### 2. 环境要求

- Node.js ≥ 18（用到内置 fetch）
- Python 3.x + openpyxl（仅生成 Excel 目录需要）：`pip install openpyxl`

### 3. 配置（可选）

复制 `config.example.json` 为 `config.json`，按需修改：

```json
{
  "kbName": "AI笔记一股脑",
  "scanRoots": ["C:\\Users\\你\\Desktop", "C:\\Users\\你\\Documents"],
  "looseRoots": ["c:\\users\\你\\workbuddy"],
  "cooldownDays": 14,
  "maxUploadsPerRun": 100
}
```

不创建 `config.json` 则使用脚本内置默认值（默认值偏Windows个人机，务必改成自己的目录）。

### 4. 运行

```bash
# 先演练：只扫描和比对，不上传
node sync.cjs --dry-run

# 正式运行：扫描 + 上传 + 生成目录
node sync.cjs

# 生成/刷新 Excel 目录（依赖 sync.cjs 导出的 files_list.json）
python gen_excel.py
```

产物：

| 文件 | 说明 |
|---|---|
| `sync_report.md` | 本次运行报告（上传/跳过/失败明细） |
| `../AI问答文档目录.md` | md 版总目录 |
| `../AI问答文档目录.xlsx` | Excel 版总目录，文件名可点击打开原文 |
| `state.json` | 本机状态（目录冷却时间、上传记录），勿删勿手改 |

### 5. 定时运行

- **Linux / macOS**：`crontab -e` 加一行 `0 8 * * * cd /path/to/ima-md-sync && node sync.cjs`
- **Windows**：任务计划程序，或配合 AI 工作台（如 WorkBuddy automation）每天定点执行并汇总播报

## 注意事项

- 目标知识库按**名称**动态解析（默认「AI笔记一股脑」），改 `config.json` 的 `kbName` 即可指向自己的库
- 上传失败会逐条记录在报告里，单个文件失败不影响后续；每传完一个立即落盘进度，中断不丢
- Excel 超链接指向扫描当刻的文件位置，文件移动/删除后链接会失效，次日刷新自动更新
- 凭证只通过 HTTP 头发送到 `ima.qq.com`，不写日志、不进仓库

## 目录结构

```
ima-md-sync/
├── sync.cjs            # 主程序：扫描/去重/上传/导出清单（Node）
├── gen_excel.py        # 生成 Excel 目录（Python + openpyxl）
├── config.example.json # 配置模板（复制为 config.json 使用）
├── .gitignore
├── LICENSE
└── README.md
```

## License

[MIT](LICENSE)
