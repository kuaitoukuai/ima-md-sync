# 更新日志（Changelog）

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.1.0] - 2026-09-18

### 新增
- **同名文件大小比对**：与知识库同名的文件会通过 `get_media_info` 的下载地址取远端大小（`content-length`）比对——大小相同视为同一文件跳过；大小不同视为新版本，自动加 `_YYYYMMDDHHmmss` 时间戳后缀**另存上传**，知识库中的旧版本保留
- **知识闭环说明**：文档入库后，AI 工作台（如 WorkBuddy）可连接同一 ima 知识库搜索、检索、引用，形成「AI 问答 → 总结 md → 自动入库 → AI 再使用」的循环
- **可点击 Excel 目录**：文件名列写入 `HYPERLINK` 公式，单击即用默认程序打开本地 md 原文件；含 0 字节文件跳过、10MB 上限拦截

### 修复
- 远端文件大小获取：ima 接口不返回 size 字段，改经 `get_media_info` 返回的下载 URL 用 HTTP `content-length` 获取（HEAD 失败自动回退整包 GET）
- 从目录跳过名单中移除 `.workbuddy`，修复会话归档目录下纯日期日志 md（如 `2026-09-08.md`）漏扫问题

### 变更
- 目标文件名规则分两层：默认目录要求 `YYYY-MM-DD_主题_ai问答.md`；会话归档目录放宽为「文件名含日期或含中文」的 md
- 单次上传上限 40 → 100；每传完一个文件立即落盘进度，中断不丢

## [1.0.0] - 2026-09-18

首个开源版本。

- 多根目录递归扫描（桌面 / Documents / Downloads / AI 会话归档），无命中目录自动进入 14 天冷却期，二次扫描近乎秒级
- 双层去重：远端知识库文件名清单 + 本机 `state.json` 上传记录，上传前再过服务端重名检查
- 完整上传流水线：重名检查 → `create_media` → 腾讯云 COS 直传 → `add_knowledge`，全程 ima 官方 OpenAPI
- 自动生成 md 版总目录 + Excel 版总目录（名称/大小/原位置/文件生成时间/上传时间/状态 + KPI 汇总 Sheet）
- 凭证从 `~/.config/ima/` 读取，零硬编码；支持可选 `config.json` 覆盖扫描根、冷却期、单次上传上限等
