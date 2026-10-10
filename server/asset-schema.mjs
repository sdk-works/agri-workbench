import { digest, normalize, redact } from "./documents.mjs";

export const annotationSchema = {
  schema_version: 1,
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 200 },
    summary: { type: ["string", "null"], maxLength: 4000 },
    knowledge_type: {
      enum: ["种植知识", "操作规程", "设备说明", "销售知识", "案例记录", null],
    },
    crop: { type: ["string", "null"], maxLength: 120 },
    variety: { type: ["string", "null"], maxLength: 120 },
    growth_stage: { type: ["string", "null"], maxLength: 120 },
    cultivation_method: { type: ["string", "null"], maxLength: 200 },
    region: { type: ["string", "null"], maxLength: 200 },
    greenhouse: { type: ["string", "null"], maxLength: 120 },
    applicable_conditions: {
      type: "array",
      items: { type: "string", maxLength: 1000 },
      maxItems: 30,
    },
    exclusions: {
      type: "array",
      items: { type: "string", maxLength: 1000 },
      maxItems: 30,
    },
    keywords: {
      type: "array",
      items: { type: "string", maxLength: 100 },
      maxItems: 30,
    },
    evidence_locations: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 30,
    },
  },
  required: ["title"],
  unknown_value: null,
};
export function validateAnnotation(value) {
  const error = (message) => {
    throw Object.assign(Error(message), { status: 400 });
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    error("标注必须为对象");
  if (
    Object.keys(value).some(
      (k) => !Object.hasOwn(annotationSchema.properties, k),
    )
  )
    error("包含未定义的农业标注字段");
  const out = {};
  for (const [key, spec] of Object.entries(annotationSchema.properties)) {
    const v = value[key];
    if (key === "title" && (typeof v !== "string" || !v.trim()))
      error("标注标题不能为空");
    if (spec.type === "array") {
      if (v === undefined) {
        out[key] = [];
        continue;
      }
      if (
        !Array.isArray(v) ||
        v.length > spec.maxItems ||
        v.some(
          (s) =>
            typeof s !== "string" ||
            !s.trim() ||
            s.length > spec.items.maxLength,
        )
      )
        error(`标注 ${key} 数组格式无效`);
      out[key] = [...new Set(v.map((s) => redact(s.trim())))];
      continue;
    }
    if (v === undefined || v === null) {
      out[key] = null;
      continue;
    }
    if (spec.enum) {
      if (!spec.enum.includes(v)) error(`标注 ${key} 选项无效`);
      out[key] = v;
      continue;
    }
    if (typeof v !== "string" || v.length > spec.maxLength)
      error(`标注 ${key} 长度或类型无效`);
    out[key] = redact(v.trim()) || null;
  }
  return out;
}
export function cleaningReport(d) {
  return {
    schema_version: 1,
    document_id: d.id,
    document_revision: d.revision,
    status: d.status,
    source_sha256: d.hash,
    clean_sha256: d.clean_hash || null,
    parser_status:
      d.status === "failed"
        ? "failed"
        : d.cleaned_text
          ? "completed"
          : "pending",
    error: d.error || null,
    counts: {
      parts: d.parts?.length || 0,
      duplicate_parts: d.parts?.filter((p) => p.duplicate).length || 0,
      ...(d.cleaning_stats || {}),
    },
    warnings: d.warnings || [],
    rules: [
      "控制字符清理",
      "空片段清理",
      "常见手机号/邮箱/证件号脱敏",
      "重复片段标记，保留原值",
    ],
    limitations: [
      "非语义事实核验",
      "人名、商业机密需人工核实",
      "扫描 PDF 需要外部 OCR",
    ],
  };
}

export function validateDataset(dataset) {
  const errors = [],
    warnings = [],
    seen = new Map();
  const issue = (index, code) => errors.push({ index, code });
  if (
    !dataset ||
    !["sft", "dpo", "eval"].includes(dataset.kind) ||
    !Array.isArray(dataset.items)
  )
    return {
      valid: false,
      errors: [{ code: "INVALID_DATASET" }],
      warnings: [],
      count: 0,
      runtime_validated: false,
    };
  if (!dataset.items.length) issue(null, "EMPTY_DATASET");
  function messages(value, index, assistantOnly = false) {
    if (!Array.isArray(value) || !value.length) {
      issue(index, "INVALID_MESSAGES");
      return false;
    }
    let ok = true;
    for (const m of value) {
      if (
        !m ||
        !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        !m.content.trim() ||
        (assistantOnly && m.role !== "assistant")
      ) {
        issue(index, "INVALID_MESSAGE");
        ok = false;
        continue;
      }
      if (redact(m.content) !== m.content)
        issue(index, "UNREDACTED_IDENTIFIER");
      if (m.content.includes("\uFFFD"))
        warnings.push({ index, code: "POSSIBLE_ENCODING_DAMAGE" });
    }
    return ok;
  }
  dataset.items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      issue(index, "INVALID_ROW");
      return;
    }
    const prompt = dataset.kind === "dpo" ? item.prompt : item.messages;
    if (messages(prompt, index)) {
      if (!prompt.some((m) => m.role === "user"))
        issue(index, "MISSING_USER_MESSAGE");
      if (
        prompt.at(-1).role !== (dataset.kind === "dpo" ? "user" : "assistant")
      )
        issue(index, "INVALID_LAST_ROLE");
      const inputs = dataset.kind === "dpo" ? prompt : prompt.slice(0, -1),
        fingerprint = digest(JSON.stringify(inputs));
      if (seen.has(fingerprint)) issue(index, "DUPLICATE_PROMPT");
      seen.set(fingerprint, index);
    }
    if (dataset.kind === "dpo") {
      if (
        messages(item.chosen, index, true) &&
        messages(item.rejected, index, true) &&
        normalize(item.chosen.map((m) => m.content).join("\n")) ===
          normalize(item.rejected.map((m) => m.content).join("\n"))
      )
        issue(index, "IDENTICAL_PREFERENCE_PAIR");
      if (item.meta?.approval?.original_acceptable !== true)
        issue(index, "UNAPPROVED_PREFERENCE");
    }
    if (!item.meta?.approval?.actor || !item.meta?.revision)
      issue(index, "MISSING_EXPERT_APPROVAL");
    if (item.meta?.split !== (dataset.kind === "eval" ? "eval" : "train"))
      issue(index, "WRONG_SPLIT");
  });
  warnings.push({
    code: "MODEL_TEMPLATE_AND_TOKEN_LENGTH_NOT_CHECKED",
    message:
      "需在训练执行器中按目标分词器和对话模板校验，格式通过不等于已可启动训练",
  });
  return {
    schema_version: 1,
    export_id: dataset.id,
    kind: dataset.kind,
    count: dataset.items.length,
    valid: errors.length === 0,
    errors,
    warnings,
    runtime_validated: false,
  };
}
export function datasetOverlap(train, evaluation) {
  const groups = (dataset) => {
    const questions = new Set(),
      sources = new Set();
    for (const row of dataset.items || []) {
      const messages = row.prompt || row.messages || [];
      for (const m of messages)
        if (m.role === "user") questions.add(digest(normalize(m.content)));
      for (const s of row.meta?.sources || []) sources.add(s.document_id);
    }
    return { questions, sources };
  };
  const a = groups(train),
    b = groups(evaluation);
  return {
    questions: [...a.questions].filter((s) => b.questions.has(s)).length,
    sources: [...a.sources].filter((s) => b.sources.has(s)).length,
  };
}

export function knowledgeJson(d, annotation) {
  return {
    schema_version: 1,
    document_id: d.id,
    document_revision: d.revision,
    annotation_revision: annotation.revision,
    title: annotation.fields.title,
    domain: d.domain,
    annotations: annotation.fields,
    content: d.approved_text,
    source: {
      name: d.name,
      description: d.source,
      sha256: d.hash,
      locations: annotation.fields.evidence_locations,
    },
    approval: { document: d.review, annotation: annotation.approval },
  };
}
export function knowledgeMarkdown(record) {
  return (
    `# ${record.title.replace(/[\r\n]/g, " ")}\n\n` +
    `- 资料编号：${record.document_id}\n- 文本版本：${record.document_revision}\n- 标注版本：${record.annotation_revision}\n- 领域：${record.domain}\n\n` +
    `## 审核知识\n\n${record.content}\n\n## 农业标注\n\n\`\`\`json\n${JSON.stringify(record.annotations, null, 2)}\n\`\`\`\n\n## 来源\n\n\`\`\`json\n${JSON.stringify(record.source, null, 2)}\n\`\`\`\n`
  );
}
