export type Fetcher = typeof fetch;
export type Provider = "github" | "gitee" | "gitcode" | "atomgit";
interface RepositoryLocation { provider: Provider; owner: string; repo: string; url: string }
export interface PRLocation extends RepositoryLocation { kind: "pr"; number: number }
export interface CommitLocation extends RepositoryLocation { kind: "commit"; sha: string }
export type ContributionLocation = PRLocation | CommitLocation;
export interface PRFile { path: string; status: string; additions: number | null; deletions: number | null; patch: string }
export interface PRRecord {
  location: ContributionLocation; title: string; description: string; state: string;
  headSha: string | null; baseSha: string | null; files: PRFile[];
  parentShas?: string[]; comparison?: "first-parent" | "empty-tree" | "unknown";
  changedFiles: number; additions: number | null; deletions: number | null;
  warnings: string[]; diffComplete: boolean;
}
export interface RuntimeConfig { apiKey?: string; model?: string; githubToken?: string; giteeToken?: string; gitcodeToken?: string; atomgitToken?: string }
export interface AnalysisResult {
  model: string; rubricVersion: string; choice: string; confidence: number;
  probabilities: Record<string, number>; usage: { input_tokens?: number; output_tokens?: number };
  pr: Omit<PRRecord, "files" | "description" | "warnings" | "diffComplete"> & { files: Omit<PRFile, "patch">[] };
  warnings: string[]; inputComplete: boolean; contextMode: "standard" | "long"; requestBytes: number; elapsedMs: number; fetchMs: number; inferenceMs: number;
}
export class AppError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
