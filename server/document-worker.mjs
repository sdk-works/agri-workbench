import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

async function extract() {
  const bytes = fs.readFileSync(workerData.file),
    ext = path.extname(workerData.name).toLowerCase();
  let parts = [];
  if (ext === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const doc = await task.promise;
    try {
      if (doc.numPages > 300) throw Error("PDF 不得超过 300 页");
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p),
          data = await page.getTextContent();
        parts.push({
          location: `第 ${p} 页`,
          text: data.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join(""),
        });
      }
    } finally {
      await task.destroy();
    }
  } else if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    const out = await mammoth.extractRawText({ buffer: bytes });
    parts = out.value
      .split(/\n\s*\n/)
      .map((text, i) => ({ location: `段落 ${i + 1}`, text }));
  } else if (ext === ".xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    wb.eachSheet((sheet) =>
      sheet.eachRow((row, index) => {
        parts.push({
          location: `${sheet.name} 第 ${index} 行`,
          text: row.values
            .slice(1)
            .map((v) =>
              typeof v === "object" && v !== null
                ? v.text ||
                  v.result ||
                  v.richText?.map((x) => x.text).join("") ||
                  ""
                : String(v ?? ""),
            )
            .join(" | "),
        });
      }),
    );
  } else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (ext === ".csv")
      parts = parse(text, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        max_record_size: 100000,
      }).map((r, i) => ({
        location: `CSV 记录 ${i + 1}`,
        text: r.join(" | "),
      }));
    else if (ext === ".jsonl")
      parts = text.split(/\r?\n/).flatMap((line, i) => {
        if (!line.trim()) return [];
        return [
          {
            location: `第 ${i + 1} 行`,
            text: JSON.stringify(JSON.parse(line)),
          },
        ];
      });
    else
      parts = text
        .split(/\r?\n/)
        .map((text, i) => ({ location: `第 ${i + 1} 行`, text }));
  }
  if (
    parts.length > 20000 ||
    parts.reduce((n, p) => n + p.text.length, 0) > 1500000
  )
    throw Error("解析文本过大，请拆分资料");
  if (!parts.some((p) => p.text.trim()))
    throw Error("未提取到文字；扫描 PDF 请先 OCR 后上传");
  return parts;
}
extract()
  .then((parts) => parentPort.postMessage({ parts }))
  .catch((e) => parentPort.postMessage({ error: e.message }));
