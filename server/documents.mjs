import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
export const digest = (s) => createHash("sha256").update(s).digest("hex");
export const normalize = (s) =>
  String(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function redact(text) {
  return String(text)
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b\d{17}[\dXx]\b/g, "[证件号已脱敏]");
}
export function cleanParts(parts) {
  const seen = new Set(),
    warnings = [],
    output = [];
  let redactions = 0,
    duplicates = 0;
  for (const p of parts) {
    const text = p.text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\u200B\uFEFF]/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (!text) continue;
    const safe = redact(text);
    if (text !== safe) redactions++;
    const hash = digest(normalize(safe));
    const duplicate = seen.has(hash);
    if (duplicate) duplicates++;
    seen.add(hash);
    output.push({ ...p, text: safe, duplicate });
  }
  if (redactions)
    warnings.push(
      `${redactions} 个片段检测到并遮蔽手机号、邮箱或证件号；人名及商业敏感信息仍需人工核实`,
    );
  if (duplicates)
    warnings.push(
      `${duplicates} 个重复片段已标记；预览中保留，避免误删表格数据`,
    );
  if (parts.some((p) => p.text.includes("\uFFFD")))
    warnings.push("存在疑似乱码，请核对原文件");
  return {
    parts: output,
    text: output.map((p) => `[${p.location}] ${p.text}`).join("\n"),
    warnings,
    redactions,
    duplicates,
  };
}
export function parseDocument(file, name) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./document-worker.mjs", import.meta.url),
      {
        workerData: { file, name },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Error("资料解析超时，请拆分文件"));
    }, 30000);
    worker.once("message", (m) => {
      clearTimeout(timer);
      worker.terminate();
      m.error ? reject(Error(m.error)) : resolve(cleanParts(m.parts));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error("解析任务中断或超过资源限制"));
    });
  });
}
export function similarity(a, b) {
  const grams = (s) => new Set(normalize(s).match(/.{1,3}/g) || []);
  const A = grams(a),
    B = grams(b);
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return A.size + B.size - n ? n / (A.size + B.size - n) : 0;
}
export function retrieve(question, docs) {
  const tokens = new Set(
    normalize(question).match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g) || [],
  );
  return docs
    .filter((d) => d.status === "published")
    .flatMap((d) => {
      const text = d.approved_text || "";
      const chunks = text.match(/[\s\S]{1,1200}/g) || [];
      return chunks.map((content, i) => ({
        document_id: d.id,
        version: d.revision,
        name: d.name,
        location: `审核文本片段 ${i + 1}`,
        content,
        score: [...tokens].filter((t) => content.toLowerCase().includes(t))
          .length,
      }));
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
