import { AppError } from "./contracts.ts";
import type { CommitLocation, ContributionLocation, Fetcher, PRFile, PRLocation, PRRecord, RuntimeConfig } from "./contracts.ts";

const SOURCES: Record<string, PRLocation["provider"]> = { "github.com": "github", "gitee.com": "gitee", "gitcode.com": "gitcode", "atomgit.com": "atomgit" };
const MAX_RESPONSE_BYTES = 6_000_000;

export function parseContributionUrl(value: unknown): ContributionLocation {
  if (typeof value !== "string" || value.length > 1600) throw new AppError("INVALID_URL", "请输入完整的公开 PR 或 Commit 链接。");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AppError("INVALID_URL", "链接格式不正确，请粘贴完整的 HTTPS 贡献地址。"); }
  const provider = SOURCES[url.hostname];
  if (url.protocol !== "https:" || !provider || url.username || url.password || (url.port && url.port !== "443")) {
    throw new AppError("UNSUPPORTED_URL", "支持 GitHub、Gitee、GitCode 和 AtomGit 的 HTTPS PR 或 Commit 链接。");
  }
  // Historical contribution exports can contain an accidental // before commit.
  const pathname = url.pathname.replace(/\/{2,}/g, "/");
  const commit = pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/commit\/([a-f\d]{7,40})\/?$/i);
  if (commit) {
    const sha = commit[3].toLowerCase();
    return { kind: "commit", provider, owner: commit[1], repo: commit[2], sha, url: `${url.origin}/${commit[1]}/${commit[2]}/commit/${sha}` };
  }
  const match = pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(pull|pulls|merge_requests)\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/);
  if (!match || (provider === "github" && match[3] !== "pull") || (provider === "gitee" && match[3] !== "pulls")) {
    throw new AppError("INVALID_PR_PATH", "无法识别贡献地址。支持 /commit/7至40位十六进制SHA，以及 GitHub /pull/编号、Gitee /pulls/编号、GitCode /merge_requests/编号。");
  }
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) throw new AppError("INVALID_PR_NUMBER", "PR 编号超出了支持范围。");
  const canonical = provider === "github" ? "pull" : provider === "gitee" ? "pulls" : "merge_requests";
  return { kind: "pr", provider, owner: match[1], repo: match[2], number, url: `${url.origin}/${match[1]}/${match[2]}/${canonical}/${number}` };
}

// Retain the PR-only entry point for existing integrations.
export function parsePRUrl(value: unknown): PRLocation {
  const location = parseContributionUrl(value);
  if (location.kind !== "pr") throw new AppError("INVALID_PR_PATH", "此入口只接受 PR；Commit 请使用贡献链接入口。");
  return location;
}

export function contributionLabel(location: ContributionLocation): string {
  return location.kind === "commit" ? `Commit ${location.sha.slice(0, 12)}` : `PR #${location.number}`;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AppError("PR_TOO_LARGE", "贡献响应过大，请先在平台中整理 diff 后接入分类。", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function sourceRequest(url: string, label: string, headers: Record<string, string>, fetcher: Fetcher, json = true): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(25_000) }); }
  catch { throw new AppError("SOURCE_UNAVAILABLE", `${label} 暂时无法连接，请稍后重试。`, 502); }
  if (!response.ok) {
    if (response.status === 404) throw new AppError("PR_NOT_FOUND", "没有找到这个 PR 或 Commit，或仓库并非公开可访问。", 404);
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
  try { return await fetchPRFromApi(location, config, fetcher); }
  catch (error) {
    // Public pages are a separate public data source. Never send credentials to them.
    if (location.provider !== "github" || config.githubToken || !(error instanceof AppError) || error.code !== "SOURCE_ACCESS_LIMIT") throw error;
    try { return await fetchGitHubPublic(location, fetcher); } catch { throw error; }
  }
}

export async function fetchContribution(location: ContributionLocation, config: RuntimeConfig, fetcher: Fetcher = fetch): Promise<PRRecord> {
  if (location.kind === "pr") return fetchPR(location, config, fetcher);
  try { return await fetchCommitFromApi(location, config, fetcher); }
  catch (error) {
    if (location.provider !== "github" || config.githubToken || !(error instanceof AppError) || error.code !== "SOURCE_ACCESS_LIMIT") throw error;
    try { return await fetchGitHubCommitPatch(location, fetcher); } catch { throw error; }
  }
}

function decodeHtml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    const names: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
    if (entity[0] !== "#") return names[entity.toLowerCase()] ?? whole;
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}

export function parseGitHubPublicPage(html: string, location: PRLocation) {
  const embedded = html.match(/<script\b[^>]*data-target=["']react-app\.embeddedData["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let payload: any;
  try { payload = JSON.parse(embedded || "").payload?.pullRequestsLayoutRoute; } catch { /* fail closed if GitHub changes its page format */ }
  const pr = payload?.pullRequest; const repo = payload?.repository;
  if (pr?.number !== location.number || typeof pr?.title !== "string" || String(repo?.ownerLogin).toLowerCase() !== location.owner.toLowerCase() || String(repo?.name).toLowerCase() !== location.repo.toLowerCase()) throw new AppError("SOURCE_FORMAT", "GitHub 公开页面的 PR 元数据无法确认。", 502);
  const opening = /<div\b[^>]*class=["'][^"']*\bcomment-body\b[^"']*["'][^>]*>/i.exec(html);
  let description = "";
  if (opening) {
    const start = opening.index + opening[0].length;
    const tags = /<!--[\s\S]*?-->|<(\/?)div\b[^>]*>/gi; tags.lastIndex = start;
    let depth = 1; let match: RegExpExecArray | null;
    while ((match = tags.exec(html))) {
      if (match[0].startsWith("<!--")) continue;
      depth += match[1] ? -1 : 1;
      if (!depth) { description = html.slice(start,match.index); break; }
    }
    description = decodeHtml(description.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\/(?:p|h[1-6]|li|pre|div)>|<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "")).trim();
  }
  return { title: pr.title, description, state: String(pr.state || "unknown"), headSha: typeof pr.headSha === "string" ? pr.headSha : null };
}

async function fetchGitHubPublic(location: PRLocation, fetcher: Fetcher): Promise<PRRecord> {
  const headers = { Accept: "text/html", "User-Agent": "Jev-PR-Classifier/1.0" };
  const html = await sourceRequest(location.url, "GitHub 公开网页", headers, fetcher, false);
  const meta = parseGitHubPublicPage(html, location);
  const diffUrl = `https://patch-diff.githubusercontent.com/raw/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/pull/${location.number}.diff`;
  const diff = await sourceRequest(diffUrl, "GitHub 公开 diff", { ...headers, Accept: "text/plain" }, fetcher, false);
  const patches = parseUnifiedDiff(diff);
  if (!patches.size) throw new AppError("SOURCE_FORMAT", "GitHub 未返回可用于分类的公开 diff。", 502);
  const files = [...patches].slice(0,300).map(([path,patch]): PRFile => ({path,patch,status:/^new file mode /m.test(patch)?"added":/^deleted file mode /m.test(patch)?"removed":/^rename from /m.test(patch)?"renamed":"modified",additions:(patch.match(/^\+(?!\+\+)/gm)||[]).length,deletions:(patch.match(/^-(?!--)/gm)||[]).length}));
  return {location,...meta,baseSha:null,files,changedFiles:(diff.match(/^diff --git /gm)||[]).length,additions:null,deletions:null,diffComplete:false,warnings:["GitHub API 读取受限，已改用公开 PR 网页与净 diff。描述来自网页渲染文本，部分 API 元数据未验证，请人工复核。"]};
}

async function fetchPRFromApi(location: PRLocation, config: RuntimeConfig, fetcher: Fetcher): Promise<PRRecord> {
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

function filesFromDiff(diff: string): PRFile[] {
  return [...parseUnifiedDiff(diff)].map(([path, patch]) => ({
    path, patch,
    status: /^new file mode /m.test(patch) ? "added" : /^deleted file mode /m.test(patch) ? "removed" : /^rename from /m.test(patch) ? "renamed" : "modified",
    additions: (patch.match(/^\+(?!\+\+)/gm) || []).length,
    deletions: (patch.match(/^-(?!--)/gm) || []).length,
  }));
}

async function fetchCommitFromApi(location: CommitLocation, config: RuntimeConfig, fetcher: Fetcher): Promise<PRRecord> {
  const { provider, owner, repo, sha } = location;
  const label = { github: "GitHub", gitee: "Gitee", gitcode: "GitCode", atomgit: "AtomGit" }[provider];
  const base = provider === "github" ? "https://api.github.com" : provider === "gitee" ? "https://gitee.com/api/v5" : `https://api.${provider}.com/api/v5`;
  const repository = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const endpoint = `${repository}/commits/${sha}`;
  const token = provider === "github" ? config.githubToken : provider === "gitee" ? config.giteeToken : provider === "gitcode" ? config.gitcodeToken : config.atomgitToken;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Jev-PR-Classifier/1.0" };
  if (provider === "github") { headers.Accept = "application/vnd.github+json"; headers["X-GitHub-Api-Version"] = "2022-11-28"; }
  if (token && provider !== "gitee") headers.Authorization = `Bearer ${token}`;
  const authenticated = (url: string) => {
    if (token && provider === "gitee") { const target = new URL(url); target.searchParams.set("access_token", token); return target.toString(); }
    return url;
  };
  const query = provider === "github" ? "?per_page=100&page=1" : provider === "gitee" ? "" : "?show_diff=true";
  const meta = await sourceRequest(authenticated(endpoint + query), label, headers, fetcher);
  const resolved = String(meta.sha ?? "").toLowerCase();
  if (!/^[a-f\d]{40}$/.test(resolved) || !resolved.startsWith(sha)) throw new AppError("SOURCE_FORMAT", "平台返回的提交 SHA 与请求不一致，未执行分类。", 502);
  const warnings: string[] = [];
  let rawFiles: any[] = Array.isArray(meta.files) ? [...meta.files] : [];
  let filesLimited = meta.truncated === true;
  if (provider === "github") {
    if (!Array.isArray(meta.files)) throw new AppError("SOURCE_FORMAT", "GitHub 没有返回提交的文件列表。", 502);
    let pageSize = meta.files.length;
    for (let page = 2; pageSize === 100 && rawFiles.length < 300; page++) {
      const next = await sourceRequest(`${repository}/commits/${resolved}?per_page=100&page=${page}`, label, headers, fetcher);
      if (next.sha !== resolved || !Array.isArray(next.files)) throw new AppError("SOURCE_FORMAT", "提交文件分页的版本或格式不一致。", 502);
      rawFiles.push(...next.files); pageSize = next.files.length;
    }
    if (rawFiles.length >= 300) filesLimited = true;
  }
  let files = rawFiles.slice(0, 300).map(normalizeFile);
  let changedFiles = numeric(meta.changed_files) ?? numeric(meta.files_count) ?? rawFiles.length;
  const omittedPatch = rawFiles.some(f => f.truncated === true || f.patch?.truncated === true);
  // GitCode omits files unless show_diff=true, and even then omits their patches.
  // Its documented full-diff route uses singular /commit/, unlike /commits/ metadata.
  if (!files.length || files.some(f => !f.patch) || omittedPatch || ((provider === "gitcode" || provider === "atomgit") && files.length >= 100)) {
    try {
      const diffUrl = provider === "gitcode" || provider === "atomgit" ? `${repository}/commit/${resolved}/diff` : provider === "github" ? `${repository}/commits/${resolved}` : `https://gitee.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${resolved}.diff`;
      const diffHeaders: Record<string, string> = provider === "github" ? { ...headers, Accept: "application/vnd.github.diff" } : provider === "gitee" ? { Accept: "text/plain", "User-Agent": headers["User-Agent"] } : { ...headers, Accept: "text/plain" };
      const fullDiff = await sourceRequest(authenticated(diffUrl), label, diffHeaders, fetcher, false);
      const complete = filesFromDiff(fullDiff);
      if ((fullDiff.match(/^diff --git /gm) || []).length > complete.length) warnings.push("部分提交文件只有二进制或重命名信息，文本 diff 未完整解析。");
      if (complete.length) {
        const patches = new Map(complete.map(f => [f.path, f]));
        files = files.map(file => ({ ...file, patch: patches.get(file.path)?.patch ?? file.patch }));
        const known = new Set(files.map(f => f.path));
        files.push(...complete.filter(f => !known.has(f.path)));
        changedFiles = Math.max(changedFiles, files.length);
        // A full diff recovers the provider's 100-file metadata cap.
        if (provider === "gitcode" || provider === "atomgit") filesLimited = false;
      }
    } catch { warnings.push("提交的完整 diff 读取失败，结果仅基于已取得的文件证据。"); }
  }
  const reportedFiles = files.length;
  files = files.slice(0, 300);
  if (filesLimited || reportedFiles > files.length || changedFiles > files.length) warnings.push("提交文件列表可能不完整（最多读取 300 个文件），请人工复核。");
  if (omittedPatch && (provider === "gitee" || provider === "github")) warnings.push("平台标记部分提交 diff 已截断，完整性未能保证。");
  const missing = files.filter(f => !f.patch).length;
  if (missing) warnings.push(`${missing} 个提交文件没有文本 diff（可能是二进制或平台省略了内容）。`);
  if (!files.length) throw new AppError("SOURCE_NO_CHANGES", "该提交没有返回可分类的文件改动；不会仅凭标题生成分类。", 422);
  const message = String(meta.commit?.message ?? meta.message ?? "");
  if (!message.trim()) warnings.push("平台未返回提交说明，分类仅依据文件改动。");
  const parentShas: string[] = Array.isArray(meta.parents) ? meta.parents.map((p: any) => p.sha).filter((s: unknown) => typeof s === "string" && /^[a-f\d]{40}$/i.test(s)) : [];
  if (Array.isArray(meta.parents) && parentShas.length !== meta.parents.length) throw new AppError("SOURCE_FORMAT", "父提交信息不完整，无法确认比较基准。", 502);
  if (!Array.isArray(meta.parents)) warnings.push("平台未返回父提交信息，无法确认 diff 的比较基准。");
  return {
    location: { ...location, sha: resolved, url: `https://${provider}.com/${owner}/${repo}/commit/${resolved}` },
    title: message.split(/\r?\n/)[0] || `Commit ${resolved.slice(0, 12)}`, description: message,
    state: "committed", headSha: resolved, baseSha: parentShas[0] ?? null, parentShas,
    comparison: !Array.isArray(meta.parents) ? "unknown" : parentShas.length ? "first-parent" : "empty-tree",
    files, changedFiles: Math.max(changedFiles, reportedFiles), additions: numeric(meta.stats?.additions), deletions: numeric(meta.stats?.deletions),
    warnings, diffComplete: warnings.length === 0,
  };
}

async function fetchGitHubCommitPatch(location: CommitLocation, fetcher: Fetcher): Promise<PRRecord> {
  const text = await sourceRequest(location.url + ".patch", "GitHub 公开提交 patch", { Accept: "text/plain", "User-Agent": "Jev-PR-Classifier/1.0" }, fetcher, false);
  const sha = text.match(/^From ([a-f\d]{40}) Mon Sep 17 00:00:00 2001\r?$/im)?.[1].toLowerCase();
  if (!sha || !sha.startsWith(location.sha)) throw new AppError("SOURCE_FORMAT", "公开 patch 的提交 SHA 无法确认。", 502);
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = text.slice(0, headerEnd).replace(/\r?\n[ \t]+/g, " ");
  const subject = headers.match(/^Subject: (.+)$/m)?.[1].replace(/^\[PATCH[^\]]*\]\s*/, "").trim();
  const start = text.search(/^diff --git /m);
  if (headerEnd < 0 || !subject || start < 0) throw new AppError("SOURCE_FORMAT", "公开提交 patch 缺少说明或文件改动。", 502);
  const files = filesFromDiff(text.slice(start));
  if (!files.length) throw new AppError("SOURCE_FORMAT", "公开提交 patch 中没有可读取的文件。", 502);
  return {
    location: { ...location, sha, url: `https://github.com/${location.owner}/${location.repo}/commit/${sha}` },
    title: subject, description: `${subject}\n${text.slice(headerEnd, start).split(/\r?\n---\r?\n/)[0].trim()}`,
    state: "committed", headSha: sha, baseSha: null, comparison: "unknown",
    files: files.slice(0, 300), changedFiles: files.length, additions: null, deletions: null,
    diffComplete: false, warnings: ["GitHub API 读取受限，使用公开提交 patch；父提交和 API 元数据未验证，请人工复核。", ...(files.length > 300 ? ["提交超过 300 个文件，文件列表已截取。"] : [])],
  };
}
