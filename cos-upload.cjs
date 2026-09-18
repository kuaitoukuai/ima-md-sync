#!/usr/bin/env node
/**
 * cos-upload.cjs — 腾讯云 COS 单文件直传（ima 知识库上传流水线专用）
 *
 * 背景：原 sync.cjs 依赖外部 skill 里的 cos-upload.cjs
 *       （~/.workbuddy/skills/ima-skills/knowledge-base/scripts/cos-upload.cjs），
 *       但 ima-skill 1.1.9 安装包并未提供该文件。为保证工具自包含、换机器可用，
 *       在本项目内自带一份等价实现：用 create_media 返回的临时密钥对 cos_key 做签名 PUT。
 *
 * 用法（参数由 sync.cjs 从 create_media 的 cos_credential 透传）：
 *   node cos-upload.cjs --file <本地文件> --secret-id <> --secret-key <> --token <> \
 *     --bucket <> --region <> --cos-key </xxx/a.md> --content-type text/markdown \
 *     --start-time <unix> --expired-time <unix> [--timeout <ms>]
 *
 * 成功：exit 0，stdout 打印 OK <cos_key> <bytes>
 * 失败：exit 1，stderr 打印错误详情（HTTP 状态 + 响应体）
 */

const fs = require("fs");
const https = require("https");
const crypto = require("crypto");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const sha1hex = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const hmacSha1hex = (key, s) => crypto.createHmac("sha1", key).update(s, "utf8").digest("hex");

function fail(msg) {
  process.stderr.write(String(msg));
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const required = ["file", "secret-id", "secret-key", "bucket", "region", "cos-key", "start-time", "expired-time"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length) fail(`缺少参数：${missing.map((m) => "--" + m).join(", ")}`);

  const filePath = String(args.file);
  if (!fs.existsSync(filePath)) fail(`文件不存在：${filePath}`);
  const body = fs.readFileSync(filePath);

  const secretId = String(args["secret-id"]);
  const secretKey = String(args["secret-key"]);
  const token = args.token && args.token !== true ? String(args.token) : "";
  const bucket = String(args.bucket);
  const region = String(args.region);
  const contentType = String(args["content-type"] || "application/octet-stream");
  const startTime = String(args["start-time"]);
  const expiredTime = String(args["expired-time"]);

  // cos_key 统一成以 / 开头的路径
  let cosKey = String(args["cos-key"]);
  if (!cosKey.startsWith("/")) cosKey = "/" + cosKey;
  const pathname = cosKey
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const signTime = `${startTime};${expiredTime}`;

  // 参与签名的请求头：content-type、host、x-cos-security-token（临时密钥必须带上）
  const signHeaders = {
    "content-type": contentType,
    host,
  };
  if (token) signHeaders["x-cos-security-token"] = token;

  const sortedKeys = Object.keys(signHeaders).sort();
  const httpHeaders = sortedKeys.map((k) => `${k}=${encodeURIComponent(signHeaders[k])}`).join("&");
  const headerList = sortedKeys.join(";");

  // COS v5 签名
  const signKey = hmacSha1hex(secretKey, signTime);
  const stringToSign = [sha1hex("put"), sha1hex(pathname), sha1hex(""), sha1hex(httpHeaders)].join("\n") + "\n";
  const signature = hmacSha1hex(signKey, stringToSign);
  const authorization =
    `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${signTime}` +
    `&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;

  const headers = {
    Authorization: authorization,
    "Content-Type": contentType,
    "Content-Length": body.length,
  };
  if (token) headers["x-cos-security-token"] = token;

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "PUT",
        hostname: host,
        path: pathname,
        headers,
        timeout: Number(args.timeout) || 180000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`COS PUT 失败 HTTP ${res.statusCode}：${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("COS PUT 超时")));
    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });

  process.stdout.write(`OK ${cosKey} ${body.length}`);
}

main().catch((e) => fail(`COS 上传失败：${(e && e.message) || e}`));
