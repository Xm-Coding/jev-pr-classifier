import type { AnalysisResult } from "./contracts.ts";
import { parsePRUrl } from "./pr-source.ts";
import { requestSite, SiteRequestError } from "./client-api.ts";
import { CATEGORIES } from "./rubric.ts";

export const MAX_BATCH_SIZE = 50;
export const BATCH_CONCURRENCY = 2;
export type BatchStatus = "queued" | "running" | "success" | "error" | "cancelled";
export interface BatchTask { id: string; url: string }
export interface BatchEntry extends BatchTask {
  status: BatchStatus;
  result?: AnalysisResult;
  error?: { code: string; message: string; requestId?: string };
}
export function parseBatchInput(input: string) {
  const tasks: BatchTask[] = []; const issues: { line: number; message: string }[] = [];
  const seen = new Set<string>(); let duplicateCount = 0;
  if (input.length > 80_000) return { tasks, issues: [{ line: 0, message: "输入过长，请分成多个批次。" }], duplicateCount, overLimit: true };
  input.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const location = parsePRUrl(line.trim());
      const id = location.provider === "github" ? location.url.toLowerCase() : location.url;
      if (seen.has(id)) { duplicateCount++; return; }
      seen.add(id); tasks.push({ id, url: location.url });
    } catch (e) { issues.push({ line: index + 1, message: e instanceof Error ? e.message : "无法识别的 PR 链接。" }); }
  });
  return { tasks, issues, duplicateCount, overLimit: tasks.length > MAX_BATCH_SIZE };
}

export function reviewAdvice(result: AnalysisResult, threshold: number) {
  if (!result.inputComplete) return "建议人工复核：输入不完整";
  if (result.contextMode === "long") return "建议人工复核：长上下文";
  if (result.confidence < threshold) return "建议人工复核：低于门限";
  return "达到试验门限";
}

export async function classifyBatchItem(task: BatchTask, signal: AbortSignal): Promise<AnalysisResult> {
  const abort = new AbortController(); let timedOut = false;
  const cancel = () => abort.abort();
  if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 210_000);
  try {
    return await requestSite<AnalysisResult>("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: task.url }), signal: abort.signal });
  } catch (e) {
    if (timedOut) throw new SiteRequestError("PR_TIMEOUT", "等待此 PR 的结果超时，服务端可能仍在处理。重试可能再次调用模型。");
    throw e;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}

export async function runBatch(tasks: BatchTask[], options: {
  signal: AbortSignal;
  onUpdate: (entry: BatchEntry) => void;
  worker?: typeof classifyBatchItem;
  concurrency?: number;
}) {
  if (tasks.length > MAX_BATCH_SIZE) throw new Error(`每批最多 ${MAX_BATCH_SIZE} 个 PR。`);
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error("批次内存在重复 PR。");
  // Retried entries may carry a previous error/result. Only identities enter a new run.
  tasks = tasks.map(({ id, url }) => ({ id, url }));
  const concurrency = Math.max(1, Math.min(BATCH_CONCURRENCY, Math.floor(options.concurrency ?? BATCH_CONCURRENCY) || 1));
  const entries: BatchEntry[] = tasks.map(task => ({ ...task, status: "queued" }));
  let next = 0;
  const update = (index: number, entry: BatchEntry) => { entries[index] = entry; options.onUpdate(entry); };
  const work = async () => {
    while (!options.signal.aborted && next < tasks.length) {
      const index = next++; const task = tasks[index];
      update(index, { ...task, status: "running" });
      try {
        const result = await (options.worker ?? classifyBatchItem)(task, options.signal);
        update(index, options.signal.aborted ? { ...task, status: "cancelled" } : { ...task, status: "success", result });
      } catch (e) {
        if (options.signal.aborted) update(index, { ...task, status: "cancelled" });
        else update(index, { ...task, status: "error", error: { code: e instanceof SiteRequestError ? e.code : "BATCH_ITEM_FAILED", message: e instanceof Error ? e.message : "分析失败，请重试。", requestId: e instanceof SiteRequestError ? e.requestId : undefined } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, work));
  entries.forEach((entry, index) => { if (entry.status === "queued") update(index, { ...entry, status: "cancelled" }); });
  return entries;
}

// Spreadsheet apps must treat PR titles and other external strings as text, not formulas.
function csvCell(value: unknown) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
export function batchToCsv(entries: BatchEntry[], threshold: number) {
  const statusName: Record<BatchStatus, string> = { queued: "待处理", running: "处理中", success: "成功", error: "失败", cancelled: "已停止等待" };
  const headers = ["PR链接", "状态", "标题", "主要类别", "Confidence(0–1)", ...CATEGORIES.map(c => `${c.label}概率(0–1)`), "复核建议", "复核门限(0–1)", "模型", "上下文模式", "错误码", "错误说明", "请求编号", "分析提示"];
  const rows = entries.map(entry => {
    const r = entry.result;
    return [entry.url, statusName[entry.status], r?.pr.title, r ? CATEGORIES.find(c => c.id === r.choice)?.label : undefined, r?.confidence, ...CATEGORIES.map(c => r?.probabilities[c.id]), r ? reviewAdvice(r, threshold) : undefined, threshold, r?.model, r?.contextMode, entry.error?.code, entry.error?.message, entry.error?.requestId, r?.warnings.join("；")];
  });
  return "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}
