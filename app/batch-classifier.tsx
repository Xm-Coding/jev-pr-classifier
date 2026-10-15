"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, Check, ChevronDown, Download, ListChecks, LoaderCircle, RotateCcw, ShieldCheck, Square } from "lucide-react";
import { BATCH_CONCURRENCY, MAX_BATCH_SIZE, batchToCsv, parseBatchInput, reviewAdvice, runBatch } from "../lib/batch.ts";
import type { BatchEntry, BatchTask } from "../lib/batch.ts";
import { CATEGORIES } from "../lib/rubric.ts";

const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
const category = (id: string) => CATEGORIES.find(c => c.id === id)?.label ?? id;
const statusLabels = { queued: "待处理", running: "处理中", success: "成功", error: "失败", cancelled: "已停止等待" };

export default function BatchClassifier({ threshold, onThresholdChange, onBusyChange, onModel }: {
  threshold: number;
  onThresholdChange: (value: number) => void;
  onBusyChange: (busy: boolean) => void;
  onModel: (model: string) => void;
}) {
  const [input, setInput] = useState(""); const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null); const serial = useRef(0);
  const parsed = useMemo(() => parseBatchInput(input), [input]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { ++serial.current; controller.current?.abort(); onBusyChange(false); }, [onBusyChange]);
  const counts = {
    success: entries.filter(e => e.status === "success").length,
    error: entries.filter(e => e.status === "error").length,
    cancelled: entries.filter(e => e.status === "cancelled").length,
    running: entries.filter(e => e.status === "running").length,
    review: entries.filter(e => e.result && reviewAdvice(e.result, threshold) !== "达到试验门限").length,
  };
  const finished = counts.success + counts.error + counts.cancelled;
  const unfinished = entries.filter(e => e.status === "error" || e.status === "cancelled");

  async function execute(tasks: BatchTask[], fresh: boolean) {
    if (busy || !tasks.length) return;
    const run = ++serial.current; const abort = new AbortController(); controller.current = abort;
    const ids = new Set(tasks.map(t => t.id));
    setEntries(previous => fresh ? tasks.map(task => ({ ...task, status: "queued" })) : previous.map(entry => ids.has(entry.id) ? { id: entry.id, url: entry.url, status: "queued" } : entry));
    setBusy(true); setNote(""); setError(""); setExpanded(null);
    try {
      await runBatch(tasks, { signal: abort.signal, onUpdate: entry => {
        if (serial.current !== run) return;
        setEntries(previous => previous.map(old => old.id === entry.id ? entry : old));
        if (entry.result) onModel(entry.result.model);
      } });
    } catch (e) { if (serial.current === run) setError(e instanceof Error ? e.message : "批次未能完成。"); }
    finally { if (serial.current === run) setBusy(false); }
  }
  function stop() {
    controller.current?.abort();
    setNote("已停止启动新任务并取消等待。已发出的服务端请求可能仍会完成；重试未完成项可能再次调用模型。");
  }
  function download() {
    const blob = new Blob([batchToCsv(entries, threshold)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = "pr-classification.csv"; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  return <div className="batch-workspace">
    <aside className="panel batch-input-panel">
      <div className="panel-label"><span className="step-number">01</span><h2>批量输入 PR 链接</h2></div>
      <p className="panel-description">每行一个链接，可混合不同代码平台。</p>
      <form onSubmit={event => { event.preventDefault(); if (!parsed.overLimit) void execute(parsed.tasks, true); }}>
        <label htmlFor="batch-pr-urls" className="field-label">PR 链接列表</label>
        <textarea id="batch-pr-urls" value={input} onChange={event => setInput(event.target.value)} disabled={busy} maxLength={80_000} spellCheck={false} placeholder={"https://github.com/owner/repo/pull/123\nhttps://gitee.com/owner/repo/pulls/456\nhttps://gitcode.com/owner/repo/merge_requests/789"} aria-describedby="batch-input-help" />
        <p id="batch-input-help" className="field-help">每批最多 {MAX_BATCH_SIZE} 个不同 PR，本批次最多同时处理 {BATCH_CONCURRENCY} 个。</p>
        <div className="batch-input-summary"><span>{parsed.tasks.length} 个有效链接</span>{parsed.duplicateCount > 0 && <span>已去重 {parsed.duplicateCount} 个</span>}{parsed.issues.length > 0 && <span className="batch-text-error">{parsed.issues.length} 行无效</span>}</div>
        {parsed.overLimit && <p className="batch-validation-error" role="alert">输入超过每批 {MAX_BATCH_SIZE} 个 PR 的上限，请分批提交。</p>}
        {parsed.issues.length > 0 && <details className="batch-input-issues"><summary>查看无效行（不会提交）<ChevronDown size={13} /></summary><ul>{parsed.issues.map((issue, index) => <li key={`${issue.line}-${index}`}>{issue.line > 0 ? `第 ${issue.line} 行：` : ""}{issue.message}</li>)}</ul></details>}
        <button className="analyze-button" type="submit" disabled={busy || !parsed.tasks.length || parsed.overLimit}>{busy ? <LoaderCircle size={17} className="spin" /> : <ListChecks size={17} />}{busy ? "批量分析进行中" : `分析 ${parsed.tasks.length} 个有效 PR`}</button>
      </form>
      <div className="batch-secondary-actions">
        {busy ? <button type="button" onClick={stop}><Square size={13} />停止批次</button> : unfinished.length > 0 && <button type="button" onClick={() => void execute(unfinished, false)}><RotateCcw size={14} />重试未完成项（{unfinished.length}）</button>}
        <button type="button" onClick={download} disabled={!entries.length || busy}><Download size={14} />导出 CSV</button>
      </div>
      <label className="batch-threshold" htmlFor="batch-threshold">试验复核门限 <strong>{Math.round(threshold * 100)}%</strong></label>
      <input id="batch-threshold" type="range" min="0.5" max="0.99" step="0.01" value={threshold} onChange={event => onThresholdChange(Number(event.target.value))} />
      <p className="batch-help">门限尚未用平台数据校准。输入不完整或使用长上下文时始终建议复核。</p>
      <p className="batch-help">分析期间请保持此页面打开；刷新或切换模式会清除批次结果。开始新批次前，请先导出需要保留的结果。</p>
      {note && <p className="batch-notice" role="status">{note}</p>}
      {error && <p className="batch-validation-error" role="alert">{error}</p>}
      <div className="server-note"><ShieldCheck size={15} /><span>每个 PR 独立调用，API key 仅在服务端使用</span></div>
    </aside>
    <section className="batch-results" aria-label="批量分析结果">
      <div className="panel batch-progress-panel">
        <div className="batch-progress-heading"><div><span className="small-label">BATCH ANALYSIS</span><h2>批次进度</h2></div><span className="batch-progress-count" role="status">{finished}<small> / {entries.length}</small></span></div>
        <div className="batch-progress-track" role="progressbar" aria-label="批次完成进度" aria-valuenow={finished} aria-valuemin={0} aria-valuemax={Math.max(entries.length, 1)}><span style={{ width: entries.length ? `${finished / entries.length * 100}%` : "0%" }} /></div>
        <div className="batch-stats"><span><i className="stat-success" />成功 {counts.success}</span><span><i className="stat-error" />失败 {counts.error}</span><span><i className="stat-running" />处理中 {counts.running}</span><span>已停止 {counts.cancelled}</span><span>建议复核 {counts.review}</span></div>
      </div>
      {!entries.length ? <div className="panel batch-empty"><div className="empty-symbol"><ListChecks size={33} strokeWidth={1.5} /></div><h2>一次提交，逐条查看</h2><p>粘贴多个 PR 链接，完成后查看分类与 confidence。<br />展开任意成功项可查看完整七类概率。</p><span>失败项独立保留，支持单独重试与 CSV 汇总。</span></div> : <div className="panel batch-table-panel">
        <div className="batch-table-heading"><h2>PR 分析结果</h2>{busy && <span><LoaderCircle size={13} className="spin" />正在处理队列</span>}</div>
        <div className="batch-table-scroll"><table className="batch-table"><thead><tr><th scope="col">PR / 状态</th><th scope="col">主要类别</th><th scope="col">Confidence</th><th scope="col">结果</th></tr></thead><tbody>
          {entries.map((entry, index) => <BatchRow key={entry.id} entry={entry} index={index} threshold={threshold} expanded={expanded === entry.id} onExpand={() => setExpanded(expanded === entry.id ? null : entry.id)} />)}
        </tbody></table></div>
      </div>}
    </section>
  </div>;
}

function BatchRow({ entry, index, threshold, expanded, onExpand }: { entry: BatchEntry; index: number; threshold: number; expanded: boolean; onExpand: () => void }) {
  const r = entry.result; const advice = r ? reviewAdvice(r, threshold) : "";
  return <>
    <tr className={`batch-row batch-row-${entry.status}`}>
      <td><div className="batch-pr-line"><span className="batch-row-number">{String(index + 1).padStart(2, "0")}</span><span className={`batch-status batch-status-${entry.status}`}>{entry.status === "running" && <LoaderCircle size={11} className="spin" />}{entry.status === "success" && <Check size={11} />}{statusLabels[entry.status]}</span></div><div className="batch-pr-title">{r?.pr.title || (entry.status === "error" || entry.status === "cancelled" ? "未取得 PR 信息" : "等待 PR 分析结果")}</div><a className="batch-pr-link" href={entry.url} target="_blank" rel="noreferrer" aria-label={`打开第 ${index + 1} 个 PR`}>{entry.url}<ArrowUpRight size={11} /></a>{entry.error && <div className="batch-row-error"><p>{entry.error.message}</p><span>{entry.error.code}{entry.error.requestId && ` · 请求编号：${entry.error.requestId}`}</span>{entry.error.code.startsWith("SITE_") && <a href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录工作台</a>}</div>}</td>
      <td><strong className="batch-category">{r ? category(r.choice) : "—"}</strong></td>
      <td><strong className="batch-confidence">{r ? percent(r.confidence) : "—"}</strong>{r && <small className="batch-top-probability">类别概率 {percent(r.probabilities[r.choice])}</small>}</td>
      <td>{r ? <><span className={`batch-review ${advice === "达到试验门限" ? "batch-review-clear" : ""}`}>{advice}</span><button className="batch-detail-button" type="button" onClick={onExpand} aria-expanded={expanded} aria-label={`查看第 ${index + 1} 个 PR 的七类概率`}>{expanded ? "收起详情" : "查看七类概率"}<ChevronDown size={12} /></button></> : <span className="batch-muted">{entry.status === "error" ? "可重试" : entry.status === "cancelled" ? "未取得结果" : "—"}</span>}</td>
    </tr>
    {expanded && r && <tr className="batch-detail-row"><td colSpan={4}><div className="batch-detail-grid">{CATEGORIES.map(c => <div key={c.id}><span>{c.label}</span><strong>{percent(r.probabilities[c.id])}</strong><div className="bar-track"><div className="bar-fill" style={{width:`${r.probabilities[c.id] * 100}%`}} /></div></div>)}</div><div className="batch-detail-meta"><span>{r.model}</span><span>{r.contextMode === "long" ? "长上下文" : "标准上下文"}</span><span>{r.pr.changedFiles} 个文件</span><span>{(r.elapsedMs / 1000).toFixed(2)} 秒</span></div>{r.warnings.map((warning, i) => <p className="batch-detail-warning" key={i}><AlertCircle size={12} />{warning}</p>)}</td></tr>}
  </>;
}
