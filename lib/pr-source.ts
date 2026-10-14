import { AppError } from "./contracts.ts";
import type { Fetcher, PRFile, PRLocation, PRRecord, RuntimeConfig } from "./contracts.ts";

const SOURCES: Record<string, PRLocation["provider"]> = { "github.com": "github", "gitee.com": "gitee", "gitcode.com": "gitcode", "atomgit.com": "atomgit" };
const MAX_RESPONSE_BYTES = 6_000_000;

export function parsePRUrl(value: unknown): PRLocation {
  if (typeof value !== "string" || value.length > 1600) throw new AppError("INVALID_URL", "请输入完整的公开 PR 链接。");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AppError("INVALID_URL", "链接格式不正确，请粘贴完整的 https:// PR 地址。"); }
  const provider = SOURCES[url.hostname];
  if (url.protocol !== "https:" || !provider || url.username || url.password || (url.port && url.port !== "443")) {
    throw new AppError("UNSUPPORTED_URL", "支持 GitHub、Gitee、GitCode 和 AtomGit 的 HTTPS PR 链接。");
  }
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(pull|pulls|merge_requests)\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/);
  if (!match || (provider === "github" && match[3] !== "pull") || (provider === "gitee" && match[3] !== "pulls")) {
    throw new AppError("INVALID_PR_PATH", "这不是可识别的 PR 链接。GitHub 使用 /pull/编号，Gitee 使用 /pulls/编号，GitCode 使用 /merge_requests/编号。");
  }
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) throw new AppError("INVALID_PR_NUMBER", "PR 编号超出了支持范围。");
  const canonical = provider === "github" ? "pull" : provider === "gitee" ? "pulls" : "merge_requests";
  return { provider, owner: match[1], repo: match[2], number, url: `${url.origin}/${match[1]}/${match[2]}/${canonical}/${number}` };
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AppError("PR_TOO_LARGE", "PR 响应过大，请先在平台中整理 diff 后接入分类。", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function sourceRequest(url: string, label: string, headers: Record<string, string>, fetcher: Fetcher, json = true): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(25_000) }); }
  catch { throw new AppError("SOURCE_UNAVAILABLE", `${label} 暂时无法连接，请稍后重试。`, 502); }
  if (!response.ok) {
    if (response.status === 404) throw new AppError("PR_NOT_FOUND", "没有找到这个 PR，或仓库并非公开可访问。", 404);
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new AppError("SOURCE_ACCESS_LIMIT", `${label} 拒绝了读取请求或已达到访问限制。私有仓库及高频访问需要在服务端配置对应平台的访问令牌。`, 502);
    }
    throw new AppError("SOURCE_ERROR", `${label} 返回 ${response.status}，暂时无法读取 PR。`, 502);
  }
  const text = await readBounded(response);
  if (!json) return text;
  try { return JSON.parse(text); } catch { throw new AppError("SOURCE_FORMAT", `${label} 返回了无法识别的数据。`, 502); }
}

function numeric(value: unknown): number | null { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; }
export function normalizeFile(raw: Record<string, any>): PRFile {
  const value = raw.patch ?? raw.diff ?? "";
  const patch = typeof value === "string" ? value : typeof value?.diff === "string" ? value.diff : "";
  return { path: String(raw.filename ?? raw.new_path ?? value?.new_path ?? raw.path ?? raw.old_path ?? value?.old_path ?? "unknown"), status: String(raw.status ?? (raw.new_file || value?.new_file ? "added" : raw.deleted_file || value?.deleted_file ? "removed" : raw.renamed_file || value?.renamed_file ? "renamed" : "modified")), additions: numeric(raw.additions), deletions: numeric(raw.deletions), patch };
}

export function parseUnifiedDiff(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of diff.split(/(?=^diff --git )/m)) {
    const name = block.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? block.match(/^--- a\/(.+)$/m)?.[1];
    if (name) result.set(name.trim(), block);
  }
  return result;
}

export async function fetchPR(location: PRLocation, config: RuntimeConfig, fetcher: Fetcher = fetch): Promise<PRRecord> {
  const { provider, owner, repo, number } = location;
  const label = { github: "GitHub", gitee: "Gitee", gitcode: "GitCode", atomgit: "AtomGit" }[provider];
  const base = provider === "github" ? "https://api.github.com" : provider === "gitee" ? "https://gitee.com/api/v5" : `https://api.${provider}.com/api/v5`;
  const endpoint = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const token = provider === "github" ? config.githubToken : provider === "gitee" ? config.giteeToken : provider === "gitcode" ? config.gitcodeToken : config.atomgitToken;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Jev-PR-Classifier/1.0" };
  if (provider === "github") { headers.Accept = "application/vnd.github+json"; headers["X-GitHub-Api-Version"] = "2022-11-28"; }
  // Each token is sent only to its own fixed provider API, never to the submitted URL.
  if (token && provider !== "gitee") headers.Authorization = `Bearer ${token}`;
  const authenticated = (url: string) => { if (token && provider === "gitee") { const target = new URL(url); target.searchParams.set("access_token", token); return target.toString(); } return url; };
  const meta = await sourceRequest(authenticated(endpoint), label, headers, fetcher);
  const warnings: string[] = []; let rawFiles: any[] = [];
  if (provider === "github") {
    for (let page = 1; page <= 3; page++) {
      const pageFiles = await sourceRequest(`${endpoint}/files?per_page=100&page=${page}`, label, headers, fetcher);
      if (!Array.isArray(pageFiles)) throw new AppError("SOURCE_FORMAT", "GitHub 文件列表格式不正确。", 502);
      rawFiles.push(...pageFiles);
      if (pageFiles.length < 100) break;
    }
  } else {
    // Gitee's endpoint returns up to 300 diffs and ignores pagination parameters.
    const data = await sourceRequest(authenticated(`${endpoint}/files`), label, headers, fetcher);
    rawFiles = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : Array.isArray(data?.data) ? data.data : [];
    if (!Array.isArray(data) && !rawFiles.length) throw new AppError("SOURCE_FORMAT", `${label} 文件列表格式不正确。`, 502);
  }
  const files = rawFiles.slice(0, 300).map(normalizeFile);
  const changedFiles = numeric(meta.changed_files) ?? numeric(meta.changes_count) ?? rawFiles.length;
  if (changedFiles > files.length || rawFiles.length > 300 || (provider !== "github" && files.length === 300)) warnings.push("文件列表可能未完整返回（原型最多读取 300 个文件）。");
  if (files.some(f => !f.patch)) {
    // Try a bounded unified diff. Build the URL ourselves; do not follow URLs supplied in PR content.
    const diffUrl = provider === "github" ? `${endpoint}` : `${location.url}.diff`;
    try {
      const diffHeaders: Record<string, string> = provider === "github" ? { ...headers, Accept: "application/vnd.github.diff" } : { Accept: "text/plain", "User-Agent": headers["User-Agent"] };
      const full = parseUnifiedDiff(await sourceRequest(diffUrl, label, diffHeaders, fetcher, false));
      for (const file of files) if (!file.patch) file.patch = full.get(file.path) ?? "";
    } catch { warnings.push("完整 diff 读取失败，结果基于已取得的文件内容。"); }
  }
  const missing = files.filter(f => !f.patch).length;
  if (missing) warnings.push(`${missing} 个文件没有可用的文本 diff（可能是二进制或平台省略了内容）。`);
  if (!files.length) warnings.push("平台没有返回可用的改动文件，分类证据有限。");
  return {
    location, title: String(meta.title ?? "未命名 PR"), description: String(meta.body ?? meta.description ?? ""),
    state: String(meta.state ?? "unknown"), headSha: meta.head?.sha ?? meta.head_sha ?? null, baseSha: meta.base?.sha ?? meta.base_sha ?? null,
    files, changedFiles, additions: numeric(meta.additions), deletions: numeric(meta.deletions), warnings,
    diffComplete: warnings.length === 0 && files.length > 0,
  };
}
