#!/usr/bin/env node
/**
 * ima_md_sync — AI 问答 md 文档定时同步到 ima 知识库「AI笔记一股脑」
 *
 * 功能：
 *   1. 扫描本地文件夹（桌面 / .workbuddy / Documents / Downloads / 会话归档），发现 AI 问答总结文档 md
 *   2. 自适应搜索：连续无命中的目录进入冷却期（默认 14 天不扫），提高搜索速度
 *   3. 对照 ima 知识库「AI笔记一股脑」已有文件名清单，跳过已上传（不重复上传）
 *   4. 未上传的文件走完整上传流水线（重名检查 → create_media → COS 上传 → add_knowledge）
 *   5. 生成文档目录 md + 运行报告 md + files_list.json（供 gen_excel.py 生成 Excel）
 *
 * 用法：
 *   node sync.cjs                # 正常运行（扫描 + 上传）
 *   node sync.cjs --dry-run      # 只扫描和比对，不上传
 *   node sync.cjs --local-only   # 强制本地模式：跳过知识库比对与上传
 *
 * 凭证：~/.config/ima/client_id 与 api_key（IMA OpenAPI）
 *   缺失时不再直接退出，而是自动降级为「本地模式」：只扫描 + 生成目录，不做比对与上传。
 *
 * 2026-09-18 迁移改造（原脚本硬编码 C:\Users\admin\*，换机器即失效）：
 *   - 所有扫描根 / 会话归档根 / 技能目录改为 os.homedir() 自动推导
 *   - 凭证缺失降级为本地模式（原来是 loadCreds 抛错直接炸）
 *   - COS 上传改为项目自带 cos-upload.cjs，不再依赖外部 skill 目录
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ────────────────────────── 配置 ──────────────────────────
const HOME = os.homedir();

const CONFIG = {
  kbName: "AI笔记一股脑",
  // 目标文件名规则分两层：
  //  - 严格（Documents / Downloads / .workbuddy）：AI 问答总结，YYYY-MM-DD_主题_ai问答.md
  //  - 宽松（桌面 + AI 会话归档目录）：文件名含日期或含中文的 md 即可
  //    ← 2026-09-18 放宽：桌面下大量项目文档（31-对抗性检查报告_2026-09-15.md、
  //      ADR-001_...md、M01-财务收入凭证自动化.md 等）既非 _ai问答 后缀、也不带日期，
  //      严格规则会整体漏掉 ai_hub 等项目的 44 个文档。
  filePattern: /^\d{4}-\d{2}-\d{2}_.+_ai问答\.md$/i,
  loosePattern: /^(?=.*(\d{4}-\d{2}-\d{2}|[\u4e00-\u9fff])).+\.md$/i,
  looseRoots: [
    path.join(HOME, "WorkBuddy").toLowerCase(),  // AI 会话归档
    path.join(HOME, "Desktop").toLowerCase(),    // 桌面（含子目录，最深 maxDepth 层）
  ],
  // 文件名排除：本工具自己产出的目录文件（否则会被自己收录，形成自引用）
  excludeFilePattern: /^AI问答文档目录(_更新)?\.md$/i,
  // 内容级去重（2026-09-18 新增）：
  //   只比文件名会把"同名但内容不同"的文件误判为已传。开启后按内容判定——
  //   取库内文件的 etag（实测＝内容 MD5）与本地 MD5 比对，取不到时退化为比字节数。
  //   同名 + 内容一致 → 视为同一文件，跳过；
  //   同名 + 内容不同 → 视为新版本，标题加后缀另存上传，库里旧版本保留。
  contentDedup: true,
  // 同名新版本的标题后缀风格：
  //   "timestamp" → 2026-07-03_20260918164512.md（默认，版本语义清晰）
  //   "project"   → 2026-07-03（ai_hub）.md（能看出文件来自哪个项目目录）
  dupTitleStyle: "timestamp",
  // 生成"项目后缀"时向上回溯要跳过的中间层目录（找到真正有意义的项目名）
  tagSkipDirNames: new Set([
    ".workbuddy", "memory", "docs", "doc", "content", "references", "assets",
    "src", "source", "scripts", "templates", "data", "logs", "static", "specs",
    "bin", "lib", "tests", "test", "public", "app", "pages", "components",
    "modules", "config", "deploy", "output", "out", "temp", "tmp", "backup",
  ]),
  // 内容比对的最大接口调用次数（限流保护；超出后本轮不再逐条校验，留待下次）
  maxVerifyPerRun: 400,
  maxFileBytes: 10 * 1024 * 1024, // ima 对 Markdown 限 10MB
  maxUploadsPerRun: 100,
  cooldownDays: 14,          // 无命中目录的冷却天数
  maxDepth: 7,
  scanRoots: [
    path.join(HOME, "Desktop"),
    path.join(HOME, ".workbuddy"),
    path.join(HOME, "WorkBuddy"),   // 若存在才扫
    path.join(HOME, "Documents"),
    path.join(HOME, "Downloads"),
  ],
  // 这些名字的目录直接跳过（性能/无关内容）
  skipDirNames: new Set([
    "node_modules", ".git", ".svn", ".venv", "venv", "__pycache__",
    ".history", "$RECYCLE.BIN", "System Volume Information",
    "AppData", "npm-cache", ".npm", ".cache", "binaries", "envs",
    "site-packages", "dist", "build", ".next", ".gradle", ".idea",
    ".vscode-test", "versions", ".claude", ".codex",
    ".trae", ".qoder", ".zcode", ".local",
    // 噪音目录（2026-09-18 新增）：编辑备份副本 / 会话原始数据 / 技能包参考文档 / 本工具旧产物
    // 不加这批会把上千个 <hash>.xxx.md 备份副本传进知识库
    ".modify_backup_meta", "modify_backup", "sessions",
    "connectors-marketplace", "plugins", "logs",
    "_旧目录备份", "__MACOSX",
  ]),
};

const SCRIPT_DIR = __dirname;

// 可选：同目录 config.json 覆盖以下可调项（见 config.example.json）
function applyConfigOverride() {
  try {
    const userCfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "config.json"), "utf8"));
    for (const k of ["kbName", "maxFileBytes", "maxUploadsPerRun", "cooldownDays", "maxDepth"]) {
      if (userCfg[k] !== undefined) CONFIG[k] = userCfg[k];
    }
    if (Array.isArray(userCfg.scanRoots)) CONFIG.scanRoots = userCfg.scanRoots;
    if (Array.isArray(userCfg.looseRoots)) CONFIG.looseRoots = userCfg.looseRoots.map((s) => String(s).toLowerCase());
    if (Array.isArray(userCfg.skipDirNames)) CONFIG.skipDirNames = new Set(userCfg.skipDirNames.map((s) => String(s).toLowerCase()));
  } catch { /* 无 config.json 时使用内置默认 */ }
}
applyConfigOverride();
const STATE_FILE = path.join(SCRIPT_DIR, "state.json");
const INDEX_FILE = path.join(SCRIPT_DIR, "..", "AI问答文档目录.md");
const REPORT_FILE = path.join(SCRIPT_DIR, "sync_report.md");
// COS 上传脚本：优先用官方 ima-skill 1.1.10 自带的，缺失时回退到项目自带的等价实现
const SKILL_COS_UPLOAD = path.join(HOME, ".workbuddy", "skills", "ima-skills", "knowledge-base", "scripts", "cos-upload.cjs");
const COS_UPLOAD = fs.existsSync(SKILL_COS_UPLOAD) ? SKILL_COS_UPLOAD : path.join(SCRIPT_DIR, "cos-upload.cjs");

// ────────────────────────── ima API ──────────────────────────
// 凭证缺失时返回 null（由主流程降级为本地模式），不再抛错中断
function loadCreds() {
  const read = (p) => {
    try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
  };
  const clientId = process.env.IMA_CLIENT_ID || process.env.IMA_OPENAPI_CLIENTID || read(path.join(HOME, ".config", "ima", "client_id"));
  const apiKey = process.env.IMA_API_KEY || process.env.IMA_OPENAPI_APIKEY || read(path.join(HOME, ".config", "ima", "api_key"));
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

async function imaApi(apiPath, body, creds) {
  const MAX_TRIES = 6;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let res;
    try {
      res = await fetch(`https://ima.qq.com/${apiPath}`, {
        method: "POST",
        headers: {
          "ima-openapi-clientid": creds.clientId,
          "ima-openapi-apikey": creds.apiKey,
          "ima-openapi-ctx": "skill_version=1.1.10",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === MAX_TRIES - 1) throw e;
      await sleep(700 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!text) throw new Error(`${apiPath} 返回空响应（HTTP ${res.status}）`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${apiPath} 响应非 JSON: ${text.slice(0, 200)}`); }
    // 200001 = 请求频率超限，退避重试（并发批量调用时必踩）
    if (json.code === 200001 && attempt < MAX_TRIES - 1) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (json.code !== 0) throw new Error(`${apiPath} 业务错误 code=${json.code} msg=${json.msg}`);
    return json.data;
  }
  throw new Error(`${apiPath} 重试 ${MAX_TRIES} 次仍失败（大概率是限流）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本地文件内容 MD5
function md5File(p) {
  return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
}

// 取库内某条 media 的真实内容指纹：get_media_info 拿签名地址 → HEAD 拿 content-length / etag
// etag 实测就是内容 MD5（与本地 md5sum 完全一致），所以能精确判断"是不是同一个文件"
async function remoteFingerprint(mediaId, creds) {
  const mi = await imaApi("openapi/wiki/v1/get_media_info", { media_id: mediaId }, creds);
  const ui = mi && mi.data && mi.data.url_info ? mi.data.url_info : (mi && mi.url_info);
  if (!ui || !ui.url) return null;
  const r = await fetch(ui.url, { method: "HEAD", headers: ui.headers || {} });
  if (!r.ok) return null;
  return {
    md5: (r.headers.get("etag") || "").replace(/"/g, "").toLowerCase(),
    size: Number(r.headers.get("content-length")) || null,
  };
}

// ── 标题工具：同名但内容不同的文件重传时，标题加后缀以便在知识库里区分 ──
function splitName(name) {
  const ext = path.extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}
function taggedName(name, tag, n) {
  const { stem, ext } = splitName(name);
  return `${stem}（${tag}${n > 1 ? "-" + n : ""}）${ext}`;
}
// 本地时间戳 YYYYMMDDHHmmss（用于新版本后缀）
function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function stampedName(name, stamp) {
  const { stem, ext } = splitName(name);
  return `${stem}_${stamp}${ext}`;
}
// 从路径向上回溯推导项目名（跳过 .workbuddy / memory / docs 等无意义层）
function projectTag(filePath) {
  const parts = path.resolve(filePath).split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    const seg = parts[i];
    if (!seg || /^[a-zA-Z]:$/.test(seg)) break;
    if (CONFIG.tagSkipDirNames.has(seg.toLowerCase())) continue;
    // 会话目录形如 2026-07-03-12-11-49，只取时间部分做后缀
    const m = seg.match(/^\d{4}-\d{2}-\d{2}-(\d{2}-\d{2}-\d{2})$/);
    const tag = m ? m[1] : seg;
    return tag.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 24) || "副本";
  }
  return "副本";
}
// 按配置的风格生成第 n 个候选标题：时间戳风格只变 n 的编号，项目风格变项目名
function candidateTitle(name, tag, stamp, n) {
  if (CONFIG.dupTitleStyle === "project") return taggedName(name, tag, n);
  const { stem, ext } = splitName(name);
  return `${stem}_${stamp}${n > 1 ? "-" + n : ""}${ext}`;
}
// 库中已存在的、用于比对的标题：优先原名，其次带后缀的变体
function existingTitleFor(name, tag, stamp, kbTitleMap) {
  if (kbTitleMap.has(name)) return { title: name, ids: kbTitleMap.get(name) };
  for (let n = 1; n <= 30; n++) {
    const t = candidateTitle(name, tag, stamp, n);
    if (kbTitleMap.has(t)) return { title: t, ids: kbTitleMap.get(t) };
  }
  return null;
}
// 本次运行中已分配出去的标题（防止同一轮里多个同名文件撞成同一个新标题）
const reservedTitles = new Set();

// 挑一个库里还没占用、且历史上没被重名拒绝过的标题（原名没被占就用原名）
function freeTitle(name, tag, stamp, kbTitleMap, maxN = 30) {
  const avoid = new Set((state && state.avoidTitles) || []);
  const taken = (t) => kbTitleMap.has(t) || avoid.has(t) || reservedTitles.has(t);
  if (!taken(name)) return name;
  for (let n = 1; n <= maxN; n++) {
    const t = candidateTitle(name, tag, stamp, n);
    if (!taken(t)) return t;
  }
  return `${splitName(name).stem}_${Date.now()}${splitName(name).ext}`;
}

// ────────────────────────── 状态 ──────────────────────────
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.dirStats) s.dirStats = {};
    if (!s.uploaded) s.uploaded = {};
    // media_id → 内容 MD5 缓存（同一条 media 内容不会变，缓存永久有效）
    if (!s.remoteMd5) s.remoteMd5 = {};
    return s;
  } catch { return { kbId: "", dirStats: {}, uploaded: {}, remoteMd5: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), "utf8");
}

// ────────────────────────── 扫描（自适应冷却） ──────────────────────────
function inCooldown(dir, now) {
  const st = state.dirStats[dir.toLowerCase()];
  return st && st.cooldownUntil && now < st.cooldownUntil;
}

function scanDir(dir, depth, now, out, pattern) {
  if (depth > CONFIG.maxDepth) return 0;
  if (inCooldown(dir, now)) { out.cooledDirs++; return 0; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; }

  let hits = 0;
  for (const e of entries) {
    if (e.name.startsWith("$") || e.name.startsWith("~$")) continue;
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      if (CONFIG.excludeFilePattern && CONFIG.excludeFilePattern.test(e.name)) continue;
      if (pattern.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size === 0) { out.zeroSize++; continue; } // 跳过 0 字节空文件
          out.files.push({
            path: full, name: e.name,
            size: st.size, mtimeMs: st.mtimeMs,
            mtime: fmtDate(st.mtime),
            birth: fmtDate(st.birthtimeMs),
          });
          hits++;
        } catch { /* stat 失败跳过 */ }
      }
    } else if (e.isDirectory()) {
      if (CONFIG.skipDirNames.has(e.name.toLowerCase())) continue;
      hits += scanDir(full, depth + 1, now, out, pattern);
    }
  }

  const key = dir.toLowerCase();
  if (hits === 0) {
    // 子树无命中 → 冷却，跳过一段时间
    state.dirStats[key] = { lastScan: fmtDate(now), hits: 0, cooldownUntil: now + CONFIG.cooldownDays * 86400000 };
  } else {
    state.dirStats[key] = { lastScan: fmtDate(now), hits, cooldownUntil: 0 };
  }
  return hits;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ────────────────────────── 上传流水线 ──────────────────────────
async function uploadOne(filePath, uploadTitle, fileSize, kbId, creds) {
  const fileName = uploadTitle;
  // Gate: 重名检查（对"实际要写入的标题"检查，作为最后一道保险）
  const check = await imaApi("openapi/wiki/v1/check_repeated_names", {
    params: [{ name: fileName, media_type: 7 }],
    knowledge_base_id: kbId,
  }, creds);
  if (JSON.stringify(check).includes('"is_repeated":true')) {
    return { ok: false, reason: "知识库已存在同名文件" };
  }
  // create_media
  const cm = await imaApi("openapi/wiki/v1/create_media", {
    file_name: fileName, file_size: fileSize,
    content_type: "text/markdown", knowledge_base_id: kbId, file_ext: "md",
  }, creds);
  const mediaId = cm.media_id || (cm.data && cm.data.media_id);
  const cred = cm.cos_credential || (cm.data && cm.data.cos_credential);
  if (!mediaId || !cred) throw new Error("create_media 响应缺少 media_id/cos_credential");

  // COS 上传（成功返回 exit 0；非 0 立即终止）
  if (!fs.existsSync(COS_UPLOAD)) throw new Error(`缺少 COS 上传脚本：${COS_UPLOAD}`);
  const args = [
    "--file", filePath,
    "--secret-id", cred.secret_id,
    "--secret-key", cred.secret_key,
    "--token", cred.token,
    "--bucket", cred.bucket_name,
    "--region", cred.region,
    "--cos-key", cred.cos_key,
    "--content-type", "text/markdown",
    "--start-time", String(cred.start_time),
    "--expired-time", String(cred.expired_time),
    "--timeout", "180000",
  ];
  await new Promise((res, rej) => {
    const p = execFile(process.execPath, [COS_UPLOAD, ...args], { timeout: 200000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error(`COS 上传失败: ${(err.message || "").slice(0, 200)} ${(stderr || "").slice(0, 200)}`));
      else res();
    });
    p.on("error", () => {});
  });

  // add_knowledge（title 必须等于 file_name）
  const ak = await imaApi("openapi/wiki/v1/add_knowledge", {
    media_type: 7, media_id: mediaId, title: fileName,
    knowledge_base_id: kbId,
    file_info: { cos_key: cred.cos_key, file_size: fileSize, file_name: fileName },
  }, creds);
  return { ok: true, media_id: (ak && ak.media_id) || mediaId };
}

// ────────────────────────── 主流程 ──────────────────────────
let state = loadState();

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const forceLocal = process.argv.includes("--local-only");
  const now = Date.now();
  let creds = loadCreds();
  if (forceLocal) creds = null;
  // 本地模式：没有凭证也不中断，只做扫描 + 生成目录
  let localMode = !creds;
  const report = [];
  const log = (s) => { report.push(s); };

  log(`## 运行概况`);
  log(`- 运行时间：${fmtDate(now)}${dryRun ? "（dry-run 演练，未上传）" : ""}`);
  log(`- 本机用户目录：${HOME}`);
  if (localMode) {
    log(`- ⚠️ 本地模式：未找到可用的 ima 凭证（~/.config/ima/），本次**未比对知识库、未上传**，仅扫描并生成目录`);
  }

  // 1. 解析知识库 ID（按名称，缓存 + 每次校验）+ 2. 拉取已有文件清单
  const kbNames = new Set();              // 仅用于统计/展示
  const kbTitleMap = new Map();           // title → [media_id]（同名多份时保留全部）
  let kbId = state.kbId;
  if (!localMode) {
    // 网络异常 / 凭证失效 → 降级为本地模式，而不是整个任务失败
    try {
      const sb = await imaApi("openapi/wiki/v1/search_knowledge_base", { query: CONFIG.kbName, cursor: "", limit: 20 }, creds);
      const kbMatch = ((sb && sb.info_list) || []).find((k) => k.kb_name === CONFIG.kbName);
      if (kbMatch) kbId = kbMatch.kb_id;
      if (!kbId) throw new Error(`未找到知识库「${CONFIG.kbName}」`);
      state.kbId = kbId;

      let cursor = "";
      for (let page = 0; page < 200; page++) {
        const d = await imaApi("openapi/wiki/v1/get_knowledge_list", { knowledge_base_id: kbId, cursor, limit: 50 }, creds);
        for (const it of (d.knowledge_list || [])) {
          kbNames.add(it.title);
          if (!kbTitleMap.has(it.title)) kbTitleMap.set(it.title, []);
          kbTitleMap.get(it.title).push(it.media_id);
        }
        if (d.is_end) break;
        cursor = d.next_cursor || "";
        if (!cursor) break;
      }
      log(`- 知识库「${CONFIG.kbName}」现有文件：${kbNames.size} 个`);
    } catch (e) {
      localMode = true;
      log(`- ⚠️ 知识库连接失败，本次降级为本地模式（未比对、未上传）：${String(e.message || e).slice(0, 200)}`);
    }
  }

  // 3. 扫描本地
  const out = { files: [], cooledDirs: 0, zeroSize: 0 };
  let scannedRoots = 0;
  for (const root of CONFIG.scanRoots) {
    if (!fs.existsSync(root)) continue;
    scannedRoots++;
    const loose = CONFIG.looseRoots.includes(root.toLowerCase());
    scanDir(root, 0, now, out, loose ? CONFIG.loosePattern : CONFIG.filePattern);
  }
  log(`- 扫描根目录：${scannedRoots}/${CONFIG.scanRoots.length} 个（配置中的根目录存在情况见上）；命中目标文档：${out.files.length} 个；冷却跳过目录：${out.cooledDirs} 个；0字节空文件跳过：${out.zeroSize} 个`);

  // 4. 比对：先判定"库里那份到底是不是同一个文件"，再决定跳过还是补传
  //    同名 + 内容一致 → 同一文件，跳过
  //    同名 + 内容不同 → 新版本，标题加后缀另存上传（库里旧版本保留）
  const uploadedMap = state.uploaded || {};
  state.remoteMd5 = state.remoteMd5 || {};
  const pending = [];
  const tooLarge = [];
  const identical = [];        // 同名且内容一致，已确认无需重传
  const deferNext = [];        // 本轮校验额度用尽，留到下次
  let verifyCount = 0, verifyHits = 0;
  const stamp = nowStamp();
  // 分配标题并立刻登记，避免同一轮里多个同名文件分到同一个新标题
  const pickTitle = (name, tag) => {
    const t = freeTitle(name, tag, stamp, kbTitleMap);
    reservedTitles.add(t);
    return t;
  };

  for (const f of out.files) {
    const key = f.path.toLowerCase();
    const rec = uploadedMap[key];

    // 4.1 超限文件直接标注
    if (f.size > CONFIG.maxFileBytes) { f.status = "超10MB限制"; f.title = f.name; tooLarge.push(f); continue; }

    // 4.2 本地内容指纹（用来判断"本机传过之后本地有没有被改过"）
    try { f.md5 = md5File(f.path); } catch { f.md5 = ""; }

    // 4.3 快路径：本机传过、且本地内容没变 → 不调任何接口
    if (rec && rec.md5 && f.md5 && rec.md5 === f.md5) {
      f.status = "本机已上传"; f.title = rec.title || f.name; continue;
    }

    const tag = projectTag(f.path);

    if (localMode) {
      f.title = f.name;
      if (rec) f.status = "本机已上传";
      else { f.status = "待上传"; pending.push(f); }
      continue;
    }

    // 4.4 库里有同名（或历史带后缀的变体）→ 取库内指纹做内容比对
    const ex = existingTitleFor(f.name, tag, stamp, kbTitleMap);
    if (ex) {
      if (verifyCount >= CONFIG.maxVerifyPerRun) { f.status = "待校验(下轮)"; f.title = ex.title; deferNext.push(f); continue; }
      const mid = ex.ids[0];
      let rf = state.remoteMd5[mid] ? { md5: state.remoteMd5[mid], size: null } : null;
      if (!rf) {
        try { rf = await remoteFingerprint(mid, creds); } catch { rf = null; }
        verifyCount++;
        if (rf && rf.md5) state.remoteMd5[mid] = rf.md5;
      }
      const sameByMd5 = !!(rf && rf.md5 && f.md5 && rf.md5 === f.md5);
      const sameBySize = !sameByMd5 && !!(rf && !rf.md5 && rf.size != null && rf.size === f.size);
      if (sameByMd5 || sameBySize) {
        verifyHits++;
        f.status = sameByMd5 ? "内容一致" : "大小一致";
        f.title = ex.title;
        uploadedMap[key] = {
          name: f.name, title: ex.title, size: f.size, mtimeMs: f.mtimeMs,
          md5: f.md5, uploadedAt: (rec && rec.uploadedAt) || "", media_id: mid,
        };
        identical.push(f);
        continue;
      }
      // 内容不同 → 视为新版本，换个没被占用的标题
      f.title = pickTitle(f.name, tag);
      f.status = "内容不同待补传";
      pending.push(f);
      continue;
    }

    // 4.5 库里完全没有这个名字 → 原名直传
    f.title = pickTitle(f.name, tag);
    f.status = "待上传";
    pending.push(f);
  }
  out.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  log(`- 内容级比对：确认与库内一致 ${identical.length} 个（实际发起比对 ${verifyCount} 次，上限 ${CONFIG.maxVerifyPerRun}）；待下轮校验 ${deferNext.length} 个`);
  log(`- 待上传：${pending.length} 个（本次最多传 ${CONFIG.maxUploadsPerRun} 个）`);

  // 5. 上传（串行）
  const results = { success: [], failed: [], skipped: [] };
  if (!dryRun && !localMode) {
    const batch = pending.slice(0, CONFIG.maxUploadsPerRun);
    for (const f of batch) {
      try {
        const r = await uploadOne(f.path, f.title || f.name, f.size, kbId, creds);
        if (r.ok) {
          results.success.push(f);
          // 上传成功后刷新状态，避免目录/Excel 里仍显示成"待补传"
          if (f.status === "内容不同待补传") f.status = "内容不同·已补传";
          else if (f.status === "待上传") f.status = "已上传";
          uploadedMap[f.path.toLowerCase()] = {
            name: f.name, title: f.title || f.name, size: f.size, mtimeMs: f.mtimeMs,
            md5: f.md5, uploadedAt: fmtDate(Date.now()), media_id: r.media_id,
          };
          kbNames.add(f.title || f.name);
          if (!kbTitleMap.has(f.title)) kbTitleMap.set(f.title, []);
          kbTitleMap.get(f.title).push(r.media_id);
          console.log(`[OK] ${f.title || f.name}`);
        } else {
          results.skipped.push({ f, reason: r.reason });
          // 重名被拒 → 把这个标题记进避免名单，下次换一个标题重试（不写 md5，保证会被重试）
          if (/同名/.test(r.reason)) {
            state.avoidTitles = state.avoidTitles || [];
            if (!state.avoidTitles.includes(f.title)) state.avoidTitles.push(f.title);
            if (state.avoidTitles.length > 2000) state.avoidTitles = state.avoidTitles.slice(-1000);
          } else {
            uploadedMap[f.path.toLowerCase()] = {
              name: f.name, title: f.title || f.name, size: f.size, mtimeMs: f.mtimeMs,
              md5: f.md5, uploadedAt: fmtDate(Date.now()), skipped: r.reason,
            };
          }
          console.log(`[SKIP] ${f.title || f.name}: ${r.reason}`);
        }
      } catch (e) {
        results.failed.push({ f, reason: String(e.message || e).slice(0, 300) });
        console.log(`[FAIL] ${f.title || f.name}: ${e.message || e}`);
      }
      saveState(state); // 每个文件后落盘，中断不丢进度
    }
    log(``);
    log(`## 本次上传结果`);
    log(`- ✅ 成功：${results.success.length}`);
    log(`- ⏭️ 跳过（重名等）：${results.skipped.length}`);
    log(`- ❌ 失败：${results.failed.length}`);
    for (const s of results.skipped) log(`  - ⏭️ ${s.f.name}：${s.reason}`);
    for (const s of results.failed) log(`  - ❌ ${s.f.name}：${s.reason}`);
    if (pending.length > batch.length) log(`- 余量：剩余 ${pending.length - batch.length} 个待下次运行`);
  } else {
    log(localMode ? `- （本地模式：未上传；配好 ima 凭证后重跑即可自动补传）` : `- （dry-run：未实际上传）`);
    for (const f of pending.slice(0, 30)) log(`  - 🆕 ${f.name}`);
    if (pending.length > 30) log(`  - … 其余 ${pending.length - 30} 个见 AI问答文档目录.md`);
  }

  // 6. 生成文档目录 md
  const lines = [
    `# AI 问答文档目录（自动生成）`,
    ``,
    `> 生成时间：${fmtDate(now)} ｜ 扫描根：${CONFIG.scanRoots.filter((r) => fs.existsSync(r)).join("、")} ｜ 知识库：${CONFIG.kbName}${localMode ? "（本地模式：未比对知识库）" : ""}`,
    ``,
    `| 序号 | 文件名 | 修改时间 | 大小KB | 状态 |`,
    `|---|---|---|---|---|`,
  ];
  out.files.forEach((f, i) => {
    const icon = /一致|已上传|已在知识库/.test(f.status) ? "✅"
      : /待补传|待上传/.test(f.status) ? "🆕"
      : /超10MB/.test(f.status) ? "🚫" : "⏸️";
    const titleNote = f.title && f.title !== f.name ? ` ｜ 库内标题：${f.title}` : "";
    lines.push(`| ${i + 1} | ${f.name}${titleNote} | ${f.mtime} | ${(f.size / 1024).toFixed(0)} | ${icon}${f.status} |`);
  });
  lines.push(``, `共 ${out.files.length} 个文档。✅=已上传/内容一致  🆕=待上传  ⏸️=待下轮校验  🚫=超限`);
  lines.push(``, `> 内容级去重：同名文件按内容 MD5（ima 侧 etag）判定。内容不同视为新版本，标题自动加后缀 ${CONFIG.dupTitleStyle === "project" ? "（项目名）" : "_YYYYMMDDHHmmss"} 另存，库里旧版本保留。`);

  // 7. 导出结构化清单（供生成 Excel 目录）
  const exportList = out.files.map((f) => {
    const rec = uploadedMap[f.path.toLowerCase()];
    return {
      name: f.name,
      title: f.title || f.name,
      path: f.path, size: f.size,
      birth: f.birth, mtime: f.mtime,
      status: f.status,
      uploadedAt: (rec && rec.uploadedAt) || "",
    };
  });
  fs.writeFileSync(path.join(SCRIPT_DIR, "files_list.json"), JSON.stringify(exportList, null, 1), "utf8");
  fs.writeFileSync(INDEX_FILE, lines.join("\n"), "utf8");
  fs.writeFileSync(REPORT_FILE, report.join("\n"), "utf8");
  saveState(state);

  console.log(`DONE mode=${localMode ? "local" : dryRun ? "dry-run" : "upload"} scanned=${out.files.length} kbTotal=${kbNames.size} uploaded=${results.success.length} failed=${results.failed.length}`);
  console.log(`REPORT=${REPORT_FILE}`);
  console.log(`INDEX=${INDEX_FILE}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message || e}`);
  try {
    fs.writeFileSync(REPORT_FILE, `# 同步失败\n\n${fmtDate(Date.now())}\n\n${e.message || e}\n`, "utf8");
  } catch { /* ignore */ }
  process.exit(1);
});
