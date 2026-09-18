#!/usr/bin/env node
/**
 * ima_md_sync — AI 问答 md 文档定时同步到 ima 知识库「AI笔记一股脑」
 *
 * 功能：
 *   1. 扫描本地文件夹（桌面 / .workbuddy / Documents / Downloads 等），发现 AI 问答总结文档 md
 *   2. 自适应搜索：连续无命中的目录进入冷却期（默认 14 天不扫），提高搜索速度
 *   3. 对照 ima 知识库「AI笔记一股脑」已有文件名清单，跳过已上传（不重复上传）
 *   4. 未上传的文件走完整上传流水线（重名检查 → create_media → COS 上传 → add_knowledge）
 *   5. 生成文档目录 md + 运行报告 md，供人工核对
 *
 * 用法：
 *   node sync.cjs            # 正常运行（扫描 + 上传）
 *   node sync.cjs --dry-run  # 只扫描和比对，不上传
 *
 * 凭证：~/.config/ima/client_id 与 api_key（IMA OpenAPI）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// ────────────────────────── 配置 ──────────────────────────
const CONFIG = {
  kbName: "AI笔记一股脑",
  // 目标文件名规则分两层：
  //  - 默认（桌面/Documents/Downloads/.workbuddy）：AI 问答总结，YYYY-MM-DD_主题_ai问答.md
  //  - 宽松（C:\Users\admin\WorkBuddy 会话归档目录）：文件名含日期或含中文的 md 即可
  filePattern: /^\d{4}-\d{2}-\d{2}_.+_ai问答\.md$/i,
  loosePattern: /^(?=.*(\d{4}-\d{2}-\d{2}|[\u4e00-\u9fff])).+\.md$/i,
  looseRoots: ["c:\\users\\admin\\workbuddy"],
  maxFileBytes: 10 * 1024 * 1024, // ima 对 Markdown 限 10MB
  maxUploadsPerRun: 100,
  cooldownDays: 14,          // 无命中目录的冷却天数
  maxDepth: 7,
  scanRoots: [
    "C:\\Users\\admin\\Desktop",
    "C:\\Users\\admin\\.workbuddy",
    "C:\\Users\\admin\\WorkBuddy",   // 若存在才扫
    "C:\\Users\\admin\\Documents",
    "C:\\Users\\admin\\Downloads",
  ],
  // 这些名字的目录直接跳过（性能/无关内容）
  skipDirNames: new Set([
    "node_modules", ".git", ".svn", ".venv", "venv", "__pycache__",
    ".history", "$RECYCLE.BIN", "System Volume Information",
    "AppData", "npm-cache", ".npm", ".cache", "binaries", "envs",
    "site-packages", "dist", "build", ".next", ".gradle", ".idea",
    ".vscode-test", "versions", ".claude", ".codex",
    ".trae", ".qoder", ".zcode", ".config", ".local",
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
const SKILL_DIR = "C:\\Users\\admin\\.workbuddy\\skills\\ima-skills";
const COS_UPLOAD = path.join(SKILL_DIR, "knowledge-base", "scripts", "cos-upload.cjs");

// ────────────────────────── ima API ──────────────────────────
function loadCreds() {
  const home = os.homedir();
  const clientId = (fs.readFileSync(path.join(home, ".config", "ima", "client_id"), "utf8") || "").trim();
  const apiKey = (fs.readFileSync(path.join(home, ".config", "ima", "api_key"), "utf8") || "").trim();
  if (!clientId || !apiKey) throw new Error("缺少 ima 凭证（~/.config/ima/）");
  return { clientId, apiKey };
}

async function imaApi(apiPath, body, creds) {
  const res = await fetch(`https://ima.qq.com/${apiPath}`, {
    method: "POST",
    headers: {
      "ima-openapi-clientid": creds.clientId,
      "ima-openapi-apikey": creds.apiKey,
      "ima-openapi-ctx": "skill_version=1.1.10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) throw new Error(`${apiPath} 返回空响应（HTTP ${res.status}）`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${apiPath} 响应非 JSON: ${text.slice(0, 200)}`); }
  if (json.code !== 0) throw new Error(`${apiPath} 业务错误 code=${json.code} msg=${json.msg}`);
  return json.data;
}

// ────────────────────────── 状态 ──────────────────────────
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.dirStats) s.dirStats = {};
    if (!s.uploaded) s.uploaded = {};
    return s;
  } catch { return { kbId: "", dirStats: {}, uploaded: {} }; }
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
async function uploadOne(filePath, fileName, fileSize, kbId, creds) {
  // Gate: 重名检查
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

// 同名冲突时取远端文件大小：get_media_info 不含大小，改走其文件下载 URL 的 content-length
async function getRemoteSize(mediaId, creds) {
  try {
    const m = await imaApi("openapi/wiki/v1/get_media_info", { media_id: mediaId }, creds);
    const url = m && m.url_info && m.url_info.url;
    if (!url) return null;
    const headers = Object.assign({}, (m.url_info && m.url_info.headers) || {});
    // 先 HEAD 拿 content-length；不支持再整包 GET
    let head = await fetch(url, { method: "HEAD", headers });
    if (!head.ok) head = await fetch(url, { headers });
    if (!head.ok) return null;
    let len = head.headers.get("content-length");
    if (len == null) {
      const buf = await head.arrayBuffer();
      len = String(buf.byteLength);
    }
    return Number(len);
  } catch { return null; }
}

// ────────────────────────── 主流程 ──────────────────────────
let state = loadState();

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const now = Date.now();
  const creds = loadCreds();
  const report = [];
  const log = (s) => { report.push(s); };

  // 1. 解析知识库 ID（按名称，缓存 + 每次校验）
  let kbId = state.kbId;
  const sb = await imaApi("openapi/wiki/v1/search_knowledge_base", { query: CONFIG.kbName, cursor: "", limit: 20 }, creds);
  const kbMatch = ((sb && sb.info_list) || []).find((k) => k.kb_name === CONFIG.kbName);
  if (kbMatch) {
    if (kbId && kbId !== kbMatch.kb_id) kbId = kbMatch.kb_id;
    kbId = kbMatch.kb_id;
  }
  if (!kbId) throw new Error(`未找到知识库「${CONFIG.kbName}」`);
  state.kbId = kbId;

  // 2. 拉取知识库已有文件清单（分页全量），记录 名称→media_id 供同名大小比对
  const kbFiles = new Map(); // title -> media_id
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const d = await imaApi("openapi/wiki/v1/get_knowledge_list", { knowledge_base_id: kbId, cursor, limit: 50 }, creds);
    for (const it of (d.knowledge_list || [])) kbFiles.set(it.title, it.media_id);
    if (d.is_end) break;
    cursor = d.next_cursor || "";
    if (!cursor) break;
  }
  const kbNames = new Set(kbFiles.keys());
  log(`## 运行概况`);
  log(`- 运行时间：${fmtDate(now)}${dryRun ? "（dry-run 演练，未上传）" : ""}`);
  log(`- 知识库「${CONFIG.kbName}」现有文件：${kbNames.size} 个`);

  // 3. 扫描本地
  const out = { files: [], cooledDirs: 0, zeroSize: 0 };
  let scannedRoots = 0;
  for (const root of CONFIG.scanRoots) {
    if (!fs.existsSync(root)) continue;
    scannedRoots++;
    const loose = CONFIG.looseRoots.includes(root.toLowerCase());
    scanDir(root, 0, now, out, loose ? CONFIG.loosePattern : CONFIG.filePattern);
  }
  log(`- 扫描根目录：${scannedRoots} 个；命中目标文档：${out.files.length} 个；冷却跳过目录：${out.cooledDirs} 个；0字节空文件跳过：${out.zeroSize} 个`);

  // 4. 比对：新文件 = 不在知识库 && 未在本机上传统计中；同名文件要比对大小
  const uploadedMap = state.uploaded || {};
  const pending = [];
  const tooLarge = [];
  const collisions = [];
  for (const f of out.files) {
    if (uploadedMap[f.path.toLowerCase()]) { f.status = "本机已上传"; continue; }
    if (f.size > CONFIG.maxFileBytes) { f.status = "超10MB限制"; tooLarge.push(f); continue; }
    if (kbFiles.has(f.name)) { collisions.push(f); continue; }
    f.status = "待上传";
    pending.push(f);
  }
  // 同名比对：远端取不到大小→视为同一文件跳过；大小不同→说明不是同一文件，改名另存上传
  for (const f of collisions) {
    const remoteSize = await getRemoteSize(kbFiles.get(f.name), creds);
    if (remoteSize === null || remoteSize === f.size) { f.status = "已在知识库"; continue; }
    f.status = "待上传";
    f.renameOnUpload = true;
    f.remoteSize = remoteSize;
    pending.push(f);
    log(`- 🔄 同名不同大小：${f.name}（本地 ${f.size}B ≠ 远端 ${remoteSize}B）→ 将以时间戳后缀另存上传`);
  }
  out.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  log(`- 待上传：${pending.length} 个（本次最多传 ${CONFIG.maxUploadsPerRun} 个）`);

  // 5. 上传（串行）
  const results = { success: [], failed: [], skipped: [] };
  if (!dryRun) {
    const batch = pending.slice(0, CONFIG.maxUploadsPerRun);
    for (const f of batch) {
      try {
        // 同名不同大小的文件：加时间戳后缀另存上传，保留知识库里的旧版本
        let uploadName = f.name;
        if (f.renameOnUpload) {
          const p = (n) => String(n).padStart(2, "0");
          const d = new Date();
          const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
          uploadName = f.name.replace(/\.md$/i, "") + "_" + ts + ".md";
        }
        const r = await uploadOne(f.path, uploadName, f.size, kbId, creds);
        if (r.ok) {
          results.success.push(f);
          uploadedMap[f.path.toLowerCase()] = { name: uploadName, size: f.size, mtimeMs: f.mtimeMs, uploadedAt: fmtDate(Date.now()), media_id: r.media_id };
          kbNames.add(uploadName);
          console.log(`[OK] ${f.name}${uploadName !== f.name ? " → " + uploadName : ""}`);
        } else {
          results.skipped.push({ f, reason: r.reason });
          uploadedMap[f.path.toLowerCase()] = { name: uploadName, size: f.size, mtimeMs: f.mtimeMs, uploadedAt: fmtDate(Date.now()), skipped: r.reason };
          console.log(`[SKIP] ${f.name}: ${r.reason}`);
        }
      } catch (e) {
        results.failed.push({ f, reason: String(e.message || e).slice(0, 300) });
        console.log(`[FAIL] ${f.name}: ${e.message || e}`);
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
    log(`- （dry-run：未实际上传）`);
    for (const f of pending.slice(0, 30)) log(`  - 🆕 ${f.name}`);
  }

  // 6. 生成文档目录 md
  const lines = [
    `# AI 问答文档目录（自动生成）`,
    ``,
    `> 生成时间：${fmtDate(now)} ｜ 扫描根：${CONFIG.scanRoots.filter((r) => fs.existsSync(r)).join("、")} ｜ 知识库：${CONFIG.kbName}`,
    ``,
    `| 序号 | 文件名 | 修改时间 | 大小KB | 状态 |`,
    `|---|---|---|---|---|`,
  ];
  out.files.forEach((f, i) => {
    const icon = f.status === "已在知识库" ? "✅" : f.status === "本机已上传" ? "✅" : f.status === "超10MB限制" ? "🚫" : dryRun ? "🆕" : "🆕";
    lines.push(`| ${i + 1} | ${f.name} | ${f.mtime} | ${(f.size / 1024).toFixed(0)} | ${icon}${f.status} |`);
  });
  lines.push(``, `共 ${out.files.length} 个文档。✅=已上传  🆕=待/新上传  🚫=超限`);

  // 7. 导出结构化清单（供生成 Excel 目录）
  const exportList = out.files.map((f) => {
    const rec = uploadedMap[f.path.toLowerCase()];
    let status = f.status;
    if (rec) status = rec.skipped ? "同名跳过" : "本机已上传";
    return {
      name: f.name, path: f.path, size: f.size,
      birth: f.birth, mtime: f.mtime,
      status,
      uploadedAt: (rec && rec.uploadedAt) || "",
    };
  });
  fs.writeFileSync(path.join(SCRIPT_DIR, "files_list.json"), JSON.stringify(exportList, null, 1), "utf8");
  fs.writeFileSync(INDEX_FILE, lines.join("\n"), "utf8");
  fs.writeFileSync(REPORT_FILE, report.join("\n"), "utf8");
  saveState(state);

  console.log(`DONE scanned=${out.files.length} kbTotal=${kbNames.size} uploaded=${results.success.length} failed=${results.failed.length}`);
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
