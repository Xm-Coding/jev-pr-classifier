"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowRight, GitPullRequest, Link2, LoaderCircle, AlertCircle, Check, ChevronDown, Copy, FileCode2, GitBranch, ShieldCheck, Sparkles, X, SlidersHorizontal } from "lucide-react";
import { CATEGORIES } from "../lib/rubric.ts";
import type { AnalysisResult } from "../lib/contracts.ts";
import { requestSite, SiteRequestError } from "../lib/client-api.ts";
import type { ServiceStatus } from "../lib/service-status.ts";

const examples = [{ name: "GitHub", url: "https://github.com/psf/requests/pull/7628" }, { name: "Gitee", url: "https://gitee.com/dromara/sa-token/pulls/378" }, { name: "GitCode", url: "https://gitcode.com/openeuler/docs/merge_requests/635" }];
const percent = (p: number) => `${(p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const name = (id: string) => CATEGORIES.find(c => c.id === id)?.label ?? id;

export default function ClassifierUI() {
  const [url, setUrl] = useState(""); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null); const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0); const [copied, setCopied] = useState(false);
  const [threshold, setThreshold] = useState(0.85); const [model, setModel] = useState("jev-1.13.0");
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [errorCode, setErrorCode] = useState(""); const [requestId, setRequestId] = useState("");
  const controller = useRef<AbortController | null>(null); const serial = useRef(0);
  useEffect(() => { const abort = new AbortController(); requestSite<ServiceStatus>("/api/status", { signal: abort.signal }).then(data => { setService(data); setModel(data.model); }).catch(e => { if (!abort.signal.aborted) setConnectionError(e instanceof Error ? e.message : "工作台连接检查失败。"); }); return () => abort.abort(); }, []);
  useEffect(() => { if (!busy) return; const start = Date.now(); const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 100); return () => clearInterval(timer); }, [busy]);
  useEffect(() => () => controller.current?.abort(), []);
  async function analyze(event: React.FormEvent) {
    event.preventDefault(); if (!url.trim() || busy) return;
    const id = ++serial.current; const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort("timeout"), 150_000);
    setBusy(true); setElapsed(0); setError(""); setErrorCode(""); setRequestId(""); setResult(null);
    try {
      const data = await requestSite<AnalysisResult>("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }), signal: abort.signal });
      if (serial.current === id) { setResult(data); setModel(data.model); }
    } catch (e) {
      if (serial.current === id) { setError(abort.signal.aborted ? "等待超时，请稍后重试。" : e instanceof Error ? e.message : "分析暂时失败，请重试。"); if (e instanceof SiteRequestError) { setErrorCode(e.code); setRequestId(e.requestId || ""); } }
    } finally { clearTimeout(timeout); if (serial.current === id) setBusy(false); }
  }
  function cancel() { ++serial.current; controller.current?.abort(); setBusy(false); setError(""); }
  async function copyResult() {
    if (!result) return;
    const text = [`PR：${result.pr.location.url}`, `分类：${name(result.choice)}`, `Confidence：${percent(result.confidence)}`, ...CATEGORIES.map(c => `${c.label}：${percent(result.probabilities[c.id])}`), `模型：${result.model}`].join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError("浏览器未允许复制，请直接选择页面中的结果。"); }
  }
  const ranked = result ? [...CATEGORIES].sort((a, b) => result.probabilities[b.id] - result.probabilities[a.id]) : [];
  const meetsThreshold = result && result.inputComplete && result.confidence >= threshold;
  const connectionLabel = result ? "分类调用成功" : connectionError ? "工作台连接失败" : !service ? "正在检查连接" : service.availability === "reachable" ? "API 可达" : "连接不可用";
  return (
    <div className="app-shell">
      <header className="topbar"><a href="/" className="brand" aria-label="PR 分类工作台首页"><span className="brand-mark"><GitPullRequest size={20} strokeWidth={2.2} /></span><span>PR Lens<span className="brand-divider">/</span><span className="brand-caption">分类工作台</span></span></a><div className="topbar-right"><span className="prototype-tag">PROTOTYPE</span><a href="https://docs.typesafe.ai/introduction" target="_blank" rel="noreferrer">TypeSafe 文档 <ArrowUpRight size={14} /></a></div></header>
      <main className="main-wrap">
        <div className="heading-row"><div><div className="eyebrow"><span className="tiny-dot" /> POWERED BY JEV</div><h1>每次改动，都有清晰归类。</h1><p className="intro">提交一个 PR 链接，查看它的主要类别、完整概率分布与模型置信度。</p></div><div className="model-badge"><Sparkles size={15} /><span>{model}</span><span className={`connection-dot ${result || service?.availability === "reachable" ? "" : "not-ready"}`} title={service?.message || connectionError || "正在验证服务连接"} /><span className="connection-label">{connectionLabel}</span></div></div>
        <div className="workspace-grid">
          <aside className="input-column">
            <section className="panel input-panel">
              <div className="panel-label"><span className="step-number">01</span><h2>输入 PR 链接</h2></div><p className="panel-description">从公开仓库读取标题、描述与代码 diff。</p>
              <form onSubmit={analyze}><label htmlFor="pr-url" className="field-label">Pull Request URL</label><div className="url-input-wrap"><Link2 size={17} /><input id="pr-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" autoComplete="off" spellCheck={false} required disabled={busy} aria-describedby="url-help" />{url && !busy && <button type="button" className="clear-button" onClick={() => { setUrl(""); setError(""); }} aria-label="清空链接"><X size={14} /></button>}</div><p id="url-help" className="field-help"><GitBranch size={13} /> GitHub <span>·</span> Gitee <span>·</span> GitCode / AtomGit</p><button type="submit" className="analyze-button" disabled={busy || !url.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={17} />}{busy ? "正在分析" : "分析这个 PR"}{!busy && <ArrowRight size={17} className="button-arrow" />}</button></form>
              <div className="examples-row"><span>试一个公开 PR</span>{examples.map(example => <button key={example.name} disabled={busy} onClick={() => { setUrl(example.url); setError(""); }}>{example.name} <ArrowUpRight size={12} /></button>)}</div>
              {!error && !result && (connectionError || (service && service.availability !== "reachable")) && <div role="status" className="inline-error"><AlertCircle size={16} /><span>{connectionError || service?.message}</span></div>}{error && <div role="alert" className="inline-error"><AlertCircle size={17} /><div><span>{error}</span>{errorCode && <div className="error-reference">错误码：{errorCode}</div>}{requestId && <div className="error-reference">请求编号：{requestId}</div>}{errorCode.startsWith("SITE_") && <a className="error-login" href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录工作台 <ArrowUpRight size={12} /></a>}</div></div>}<div className="server-note"><ShieldCheck size={15} /><span>API key 仅在服务端使用</span></div>
            </section>
            <section className="panel workflow-panel"><span className="small-label">HOW IT WORKS</span><div className="flow-item"><span className="flow-icon"><Link2 size={15} /></span><div><strong>读取改动</strong><p>提取 PR 描述与文件 diff</p></div></div><div className="flow-item"><span className="flow-icon"><Sparkles size={15} /></span><div><strong>交给 Jev 判断</strong><p>按固定七类规则选择主类别</p></div></div><div className="flow-item"><span className="flow-icon"><GitPullRequest size={15} /></span><div><strong>查看概率与置信度</strong><p>保留模型原始返回数值</p></div></div></section>
          </aside>
          <section className="result-column" aria-live="polite" aria-busy={busy}>
            {!result && !busy && <div className="panel empty-panel"><div className="empty-art"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><div className="empty-symbol"><GitPullRequest size={35} strokeWidth={1.6} /></div><span className="art-point art-point-one" /><span className="art-point art-point-two" /><span className="art-point art-point-three" /></div><span className="empty-kicker">READY WHEN YOU ARE</span><h2>从一个 PR 开始</h2><p>左侧粘贴链接，分类结果将在这里呈现。<br />一次判断，七种可能，完整可见。</p><div className="category-chips">{CATEGORIES.map(c => <span key={c.id}>{c.label}</span>)}</div></div>}
            {busy && <div className="panel loading-panel"><div className="loading-symbol"><LoaderCircle size={31} className="spin" /></div><h2>正在读取改动并请求 Jev</h2><p>较大的 PR 或平台响应较慢时，需要多等一会儿。</p><span className="elapsed-time">已等待 {elapsed.toFixed(1)} 秒</span><button className="text-button" onClick={cancel}>取消等待</button></div>}
            {result && <>
              <div className="panel outcome-panel"><div className="outcome-top"><span className="small-label">主要类别 · PRIMARY CATEGORY</span><button className="copy-button" onClick={copyResult}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制结果"}</button></div><div className="outcome-main"><div><div className="chosen-label">{name(result.choice)}<span className="choice-check"><Check size={15} /></span></div><p>根据本次 PR 的主要改动目的归类</p></div><div className="top-probability"><strong>{percent(result.probabilities[result.choice])}</strong><span>该类别概率</span></div></div><div className="confidence-strip"><div><span className="confidence-label">Confidence <span className="help-dot" title="由类别概率分布计算的集中程度，不等于分类正确率。">?</span></span><strong>{percent(result.confidence)}</strong></div><span className={`review-status ${meetsThreshold ? "status-clear" : ""}`}>{meetsThreshold ? <Check size={13} /> : <AlertCircle size={13} />}{meetsThreshold ? "达到试验门限" : "建议人工复核"}</span></div></div>
              {result.warnings.length > 0 && <div className="warning-panel"><AlertCircle size={17} /><div><strong>分类依据存在缺口</strong>{result.warnings.map(w => <p key={w}>{w}</p>)}</div></div>}
              <div className="panel distribution-panel"><div className="distribution-heading"><h2>七类概率分布</h2><span>Jev 原始返回</span></div><div className="probability-list">{ranked.map((c, index) => <div className={`probability-row ${c.id === result.choice ? "winner" : ""}`} key={c.id}><span className="rank-number">{String(index + 1).padStart(2, "0")}</span><span className="probability-name">{c.label}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${result.probabilities[c.id] * 100}%` }} /></div><strong>{percent(result.probabilities[c.id])}</strong></div>)}</div><p className="probability-note">概率总和约为 100%。confidence 衡量分布集中程度，不代表分类正确率。</p></div>
              <div className="panel source-panel"><div className="source-heading"><span className="source-platform">{result.pr.location.provider.toUpperCase()}</span><a href={result.pr.location.url} target="_blank" rel="noreferrer">打开 PR <ArrowUpRight size={13} /></a></div><h3>{result.pr.title}</h3><div className="source-details"><span><GitPullRequest size={14} />{result.pr.location.owner}/{result.pr.location.repo} #{result.pr.location.number}</span><span><FileCode2 size={14} />{result.pr.changedFiles} 个文件</span>{result.pr.additions !== null && <span className="additions">+{result.pr.additions}</span>}{result.pr.deletions !== null && <span className="deletions">−{result.pr.deletions}</span>}</div><details className="file-details"><summary>查看改动文件 <ChevronDown size={14} /></summary><ul>{result.pr.files.slice(0, 50).map((f, i) => <li key={`${f.path}-${i}`}><FileCode2 size={13} /><span>{f.path}</span><small>{f.status}</small></li>)}</ul>{result.pr.files.length > 50 && <p className="field-help">还有 {result.pr.files.length - 50} 个文件。</p>}</details><div className="result-meta"><span>{result.model}</span><span>读取 {seconds(result.fetchMs)}</span><span>推理 {seconds(result.inferenceMs)}</span>{typeof result.usage.input_tokens === "number" && <span>{result.usage.input_tokens.toLocaleString()} 输入 tokens</span>}</div></div>
              <details className="panel threshold-panel"><summary><span><SlidersHorizontal size={15} />试验复核门限</span><ChevronDown size={15} /></summary><div className="threshold-content"><label htmlFor="threshold">Confidence 门限<strong>{Math.round(threshold * 100)}%</strong></label><input id="threshold" type="range" min="0.5" max="0.99" step="0.01" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /><p>仅用于观察复核建议，不改变 API 结果。门限尚未用平台数据校准；输入不完整时始终建议复核。</p></div></details>
            </>}
          </section>
        </div>
        <details className="rubric-section"><summary><span>本次使用的七类分类口径<span className="rubric-version">v1 · 初始定义</span></span><ChevronDown size={16} /></summary><div className="rubric-grid">{CATEGORIES.map(c => <div key={c.id}><strong>{c.label}</strong><p>{c.description}</p></div>)}</div></details>
        <footer className="footer"><span><ShieldCheck size={13} />仅用于分类试验，复核建议不等于平台审核通过。</span><a href="https://docs.typesafe.ai/confidence" target="_blank" rel="noreferrer">如何理解 confidence <ArrowUpRight size={12} /></a></footer>
      </main>
    </div>
  );
}
