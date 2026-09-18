# ima-md-sync

把本地散落的「AI 问答总结 md 文档」自动同步到腾讯 ima 知识库的命令行工具。

适用场景：你习惯在和 AI 聊完后让它把对话总结成一份 md 存档（命名如 `2026-09-18_主题_ai问答.md`），时间久了文档散落在桌面、下载、会话归档等各个角落——本工具每天定时把**新出现的文档**自动上传到指定的 ima 知识库，已传过的绝不重传，并生成一份可点击跳转的 Excel 总目录。

## 功能特性

- 🔍 **多目录扫描**：桌面 / Documents / Downloads / `.workbuddy` / AI 会话归档等根目录递归查找目标文档
- 📁 **路径自适应**：所有扫描根、归档根、技能目录都由 `os.homedir()` 推导，换机器 / 换用户名不用改代码
- 🧊 **自适应冷却**：连续无命中的目录自动进入冷却期（默认 14 天不扫），二次扫描近乎秒级
- 🚫 **三层次去重**：远端文件名清单 → **内容级指纹比对（MD5）** → 本地上传记录，同名但内容不同不会被误判为已传
- 📤 **完整上传流水线**：可选重名检查 → create_media → 腾讯云 COS 直传 → add_knowledge，全程走 ima 官方 OpenAPI
- 🛟 **本地模式**：没有凭证 / 知识库连不上时自动降级为「只扫描 + 生成目录」，不会整个任务挂掉，配好凭证重跑即可自动补传
- 📊 **Excel 目录**：自动生成带 `HYPERLINK` 的总目录（名称 / 库内标题 / 大小 / 原位置 / 生成时间 / 上传时间 / 状态），点击文件名直接打开本地 md
- 🔒 **零硬编码凭据**：凭证从 `~/.config/ima/` 读取，不写入代码和日志

## 内容级去重（同名文件到底是不是同一个）

只比文件名会误判：`2026-07-03.md` 在 6 个项目目录里内容各不相同，但知识库里只存了其中一份，剩下 5 份会被当成"已传过"永久漏掉。

ima 的 `get_knowledge_list` **不返回文件大小**，但绕一步就能拿到真实内容指纹：

```
get_media_info(media_id)  →  data.url_info.url（带签名的原文地址）
        ↓ HEAD 该地址
content-length = 库内文件真实字节数
etag           = 内容 MD5（实测与本地 md5sum 完全一致）
```

判定规则：

| 情况 | 处理 |
|---|---|
| 同名 + 内容一致（MD5 相同） | 视为同一文件，跳过 |
| 同名 + 大小相同（etag 取不到时退化） | 视为同一文件，跳过 |
| 同名 + 内容不同 | 视为**新版本**，标题加后缀另存上传，库里旧版本保留 |
| 无同名 | 原名直接上传 |

后缀风格由 `dupTitleStyle` 决定：`"timestamp"`（默认）→ `2026-07-03_20260918172241.md`；`"project"` → `2026-07-03（ai_hub）.md`。同一轮运行内会保证标题互不重复（重名则追加 `-2`、`-3`）。

**性能**：`state.json` 会记录每个已传文件的 MD5 和每条 media 的远端 MD5。本地文件 MD5 没变 → 直接跳过，**零接口调用**；只有本地内容变过或首次遇到才去查库比对。首轮升级会全量比对一次（151 个文件约 2.5 分钟），之后日常几乎无额外开销。比对次数受 `maxVerifyPerRun` 保护（默认 400），超额的部分标为"待下轮校验"，不会漏。

> ⚠️ ima 接口有频率限制，并发调用会被 `code=200001 请求频率超限` 打回。代码里对 200001 做了指数退避重试；手工写探测脚本时并发不要超过 2。


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
| 严格（Documents / Downloads / `.workbuddy`） | `YYYY-MM-DD_主题_ai问答.md` | `2026-09-18_浏览器自动化_ai问答.md` |
| 宽松（**桌面** `~/Desktop`、AI 会话归档 `~/WorkBuddy`） | 文件名含日期**或**含中文的 md 均可 | `2026-09-08.md`、`政采云验证码识别复盘.md`、`31-对抗性检查报告_2026-09-15.md` |

> 桌面于 2026-09-18 起改走宽松规则。此前桌面走严格规则，导致 `ai_hub` 等项目的 44 个文档
> （`31-对抗性检查报告_2026-09-15.md`、`ADR-001_...md`、`M01-财务收入凭证自动化.md` 等
> 不带 `_ai问答` 后缀、也不含日期的项目文档）整体被漏掉；放宽后桌面收录量 3 → 126。

> 宽松规则只认**文件名**：`deepagents/content/ch01-*.md`、`README.md` 这类纯英文名不会被收录，
> 这是有意为之（避免把资料库、代码文档一并搬进知识库）。

**目录/文件排除**（`skipDirNames`，随宽松规则同步加固）：

- 构建与依赖：`node_modules`、`.git`、`dist`、`build`、`.venv`、`site-packages`、`binaries` 等
- **编辑备份副本**：`.modify_backup_meta`、`modify_backup`、`sessions` —— 每个 session 下有上千个
  `<hash>.<原名>.md` 副本，不排除会全部被当成新文档
- 技能包与缓存：`connectors-marketplace`、`plugins`、`.cache`
- 本工具自身产物：文件名 `AI问答文档目录.md`（`excludeFilePattern`），否则会被自己收录形成自引用

0 字节空文件、超过 10MB（ima 对 md 的上限）的文件自动跳过。

## 环境准备

### 1. Node.js ≥ 18

用到内置 `fetch`，Node 18 以上即可。本项目在 Node 22 上验证通过。

### 2. ima 技能包（提供官方 COS 上传脚本）

从官方地址下载 **1.1.10**（注意：**1.1.9 的安装包里 `knowledge-base/scripts/` 是空的，没有上传脚本**）：

```
https://app-dl.ima.qq.com/skills/ima-skills-1.1.10.zip
```

解压后把 `ima-skill/` 下的 `SKILL.md`、`ima_api.cjs`、`meta.json`、`notes/`、`knowledge-base/` 覆盖到技能目录：

```
C:\Users\<你的用户名>\.workbuddy\skills\ima-skills\
```

装好后应存在：`.workbuddy\skills\ima-skills\knowledge-base\scripts\cos-upload.cjs`

> 不装也能用：项目自带一份等价的 `cos-upload.cjs`（COS 签名 PUT），脚本会优先用官方的，找不到时自动回退到自带的那个。

### 3. ima 凭证（最关键的一步）

1. 打开 **https://ima.qq.com/agent-interface**
2. 在页面**第 2 步**获取 **Client ID** 和 **API Key**
3. 写入配置文件（推荐）：

```bash
mkdir -p ~/.config/ima
echo "你的ClientID" > ~/.config/ima/client_id
echo "你的APIKey"  > ~/.config/ima/api_key
```

Windows 下即 `C:\Users\<你的用户名>\.config\ima\client_id` 与 `api_key`（文件内容只有那一行，不要带引号、不要带多余换行）。

也可以用环境变量：`IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`（优先级高于配置文件）。

> 凭证只作为 HTTP 头发送到 `ima.qq.com`，不写日志、不进仓库。
> 若凭证无效，接口会返回 `code=200002 skill auth failed`，此时脚本自动降级为本地模式。

### 4. openpyxl（仅生成 Excel 目录需要）

建议装在隔离环境里，不要污染全局 Python：

```bash
python -m venv C:\Users\<你的用户名>\.workbuddy\binaries\python\envs\default
C:\Users\<你的用户名>\.workbuddy\binaries\python\envs\default\Scripts\pip install openpyxl
```

## 运行

```bash
# 演练：只扫描 + 比对，不上传
node sync.cjs --dry-run

# 正式运行：扫描 + 上传 + 生成目录
node sync.cjs

# 强制本地模式：跳过知识库比对与上传，只出目录
node sync.cjs --local-only

# 生成 / 刷新 Excel 目录（依赖 sync.cjs 导出的 files_list.json）
<venv>\Scripts\python.exe gen_excel.py
```

三种模式对照：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `upload` | 有凭证且未加 `--dry-run` | 全流程：扫描 → 比对 → 上传 → 出目录 |
| `dry-run` | 加 `--dry-run` | 只扫描比对，列出待上传清单，不上传 |
| `local` | 加 `--local-only`，**或**没有凭证，**或**知识库连接失败 | 只扫描 + 出目录，不做比对与上传 |

## 定时运行

- **Windows**：任务计划程序，或配合 AI 工作台（如 WorkBuddy automation）每天定点执行并汇总播报
- **Linux / macOS**：`crontab -e` 加一行 `0 8 * * * cd /path/to/ima-md-sync && node sync.cjs`

## 产物

| 文件 | 说明 |
|---|---|
| `sync_report.md` | 本次运行报告（模式、扫描统计、上传 / 跳过 / 失败明细） |
| `files_list.json` | 结构化清单，供 `gen_excel.py` 消费 |
| `../AI问答文档目录.md` | md 版总目录 |
| `../AI问答文档目录.xlsx` | Excel 版总目录，文件名可点击打开原文 |
| `state.json` | 本机状态（目录冷却时间、上传记录），勿删勿手改 |

## 配置（可选）

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

不创建 `config.json` 则使用脚本内置默认值（默认值已按 `os.homedir()` 自适应，通常无需改）。

## 迁移记录（2026-09-18）

本工程原先在另一台机器（Windows 用户 `admin`）上开发运行，路径写死为 `C:\Users\admin\*`，拷到本机后完全跑不起来。本次改造：

| 问题 | 处理 |
|---|---|
| `scanRoots` / `looseRoots` / `SKILL_DIR` 硬编码 `C:\Users\admin\*` | 全部改为 `os.homedir()` 推导 |
| 缺凭证时 `loadCreds()` 直接抛错，整个任务中断 | 降级为本地模式；知识库连接失败同样降级 |
| 依赖外部 skill 的 `cos-upload.cjs`（1.1.9 包里没有） | 优先用官方 1.1.10 的，缺失时回退到项目自带实现 |
| `state.json` 里 37372 条目录冷却 + 171 条上传记录全是 `admin` 机器路径 | 备份为 `state.json.bak-20260918-from-admin-machine`，保留 `kbId` 后重置 |
| `looseRoots` 未转小写，导致归档目录宽松规则失效（一批文档全漏） | 默认值统一转小写后再比较 |

## 目录结构

```
ima-md-sync/            # 发布包（README / LICENSE / config.example.json）
ima_md_sync/            # 实际运行目录
├── sync.cjs            # 主程序：扫描 / 去重 / 上传 / 导出清单（Node）
├── cos-upload.cjs      # 自带 COS 直传（官方脚本缺失时的回退）
├── gen_excel.py        # 生成 Excel 目录（Python + openpyxl）
├── state.json          # 运行状态
└── sync_report.md      # 运行报告
```

> 两个目录里的 `sync.cjs` / `gen_excel.py` 内容一致，是「发布包 + 运行目录」的关系；如无发布需求，可只保留 `ima_md_sync/`。

## License

[MIT](LICENSE)
