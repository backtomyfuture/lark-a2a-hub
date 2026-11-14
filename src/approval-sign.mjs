// 审批决定的签名与验签（标准 §8.3 第 5 条）。
// 总线不认证写入者：任何能写 Messages 的身份都能写出一行自称 From_Node=hub 的 auth_decision。
// 所以 hub 用本机私钥给决定签名，节点按 node.json 里固定的 hub 公钥验签，签名对不上的决定当作不存在。
// 私钥只在 hub 的配置目录（600），不进总线、不进仓库、不进日志。零依赖：node:crypto 自带 ed25519。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HUB_KEY_FILE = "approval_key.pem";

// 把决定绑在「哪个任务、哪条审批请求」上：换一个任务或换一条请求，签名就失效，抄来的决定用不了。
function payload({ taskId, requestId, decision }) {
  return Buffer.from(["lah-auth-decision-v1", String(taskId ?? ""), String(requestId ?? ""), String(decision ?? "")].join("\n"));
}

export function publicKeyOf(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
}

// 读不到就新建。返回 { privateKey, publicKey }，publicKey 是可以贴进各节点 node.json 的 base64 文本。
export function loadOrCreateHubKey(configDir) {
  const file = path.join(configDir, HUB_KEY_FILE);
  let privateKey;
  if (fs.existsSync(file)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  } else {
    privateKey = crypto.generateKeyPairSync("ed25519").privateKey;
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  fs.chmodSync(file, 0o600);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

// 只读：hub 还没生成过密钥时返回空串，不替它生成。
export function readHubPublicKey(configDir) {
  try {
    return publicKeyOf(crypto.createPrivateKey(fs.readFileSync(path.join(configDir, HUB_KEY_FILE), "utf8")));
  } catch {
    return "";
  }
}

export function signDecision(privateKey, fields) {
  return crypto.sign(null, payload(fields), privateKey).toString("base64");
}

// 候选按调用方排好的「最新优先」顺序。pinned 为空时不验签，与没配 hubPublicKey 的节点一致。
// 返回第一条幸存决定的字符串（空串也算有决定）；没有任何幸存候选才是 null。
// 未通过验签的行直接跳过，不能挡住后面真正签过的点击。
export function pickSignedDecision(publicKeyText, taskId, requestId, candidates) {
  const pinned = String(publicKeyText ?? "").trim();
  for (const c of candidates || []) {
    const decision = String(c?.decision ?? "");
    if (pinned && !verifyDecision(pinned, { taskId, requestId, decision }, c?.sig)) continue;
    return decision;
  }
  return null;
}

// 公钥文本坏了、签名缺失或对不上，一律 false。不抛错：调用方把它当作「没有有效决定」。
export function verifyDecision(publicKeyText, fields, sig) {
  try {
    if (typeof sig !== "string" || !sig) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(String(publicKeyText), "base64"), format: "der", type: "spki" });
    return crypto.verify(null, payload(fields), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

// 给 doctor 用：公钥文本能不能解析成一把 ed25519 公钥。
export function isHubPublicKey(text) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(text), "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}
