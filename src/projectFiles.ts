import fs from "node:fs";
import path from "node:path";
import { IGNORED_DIRECTORIES } from "./discovery.js";
import { projectRootHint } from "./registry.js";
import { redactSecrets } from "./redact.js";

export interface ProjectFileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface ProjectTreeOptions {
  projectId: string;
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  includeSizes?: boolean;
}

export interface ProjectFileSearchOptions {
  projectId: string;
  query: string;
  maxResults?: number;
  maxDepth?: number;
  caseSensitive?: boolean;
}

export interface ProjectFileReadOptions {
  projectId: string;
  relativePath: string;
  maxChars?: number;
  startLine?: number;
  numLines?: number;
}

export interface ProjectTextSearchOptions {
  projectId: string;
  query: string;
  maxMatches?: number;
  maxFileSize?: number;
  maxDepth?: number;
  caseSensitive?: boolean;
}

export interface ProjectTreeResult {
  ok: true;
  project_id: string;
  root_hint: string;
  max_depth: number;
  max_entries: number;
  total_files: number;
  total_folders: number;
  returned_entries: number;
  truncated: boolean;
  ignored_dirs: string[];
  entries: ProjectFileEntry[];
}

export interface ProjectFileSearchResult {
  ok: true;
  project_id: string;
  query: string;
  matches: ProjectFileEntry[];
  truncated: boolean;
}

export interface ProjectFileReadResult {
  ok: true;
  project_id: string;
  path: string;
  size: number;
  encoding: "utf-8";
  truncated: boolean;
  redacted: boolean;
  content: string;
}

export interface ProjectTextMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface ProjectTextSearchResult {
  ok: true;
  project_id: string;
  query: string;
  matches: ProjectTextMatch[];
  truncated: boolean;
  redacted: boolean;
}

export class ProjectFileError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ProjectFileError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_TREE_DEPTH = 4;
const DEFAULT_TREE_ENTRIES = 500;
const DEFAULT_SEARCH_DEPTH = 8;
const DEFAULT_SEARCH_RESULTS = 50;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const HARD_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_GREP_FILE_SIZE = 200000;
const DEFAULT_MAX_GREP_MATCHES = 50;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bmp",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpg",
  ".jpeg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".webp",
  ".zip"
]);

export function getProjectTree(root: string, options: ProjectTreeOptions): ProjectTreeResult {
  const projectRoot = canonicalProjectRoot(root);
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_TREE_DEPTH, "max_depth", 0, 20);
  const maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_TREE_ENTRIES, "max_entries", 1, 5000);
  const includeHidden = options.includeHidden ?? false;
  const includeSizes = options.includeSizes ?? true;
  const entries: ProjectFileEntry[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [{ absolutePath: projectRoot, relativePath: "", depth: 0 }];
  let totalFiles = 0;
  let totalFolders = 0;
  let truncated = false;

  while (queue.length) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isSymbolicLink() || shouldIgnoreName(child.name, includeHidden)) {
        continue;
      }

      const childRelative = toPosixPath(path.join(current.relativePath, child.name));
      const childAbsolute = path.join(current.absolutePath, child.name);
      if (isSensitiveRelativePath(childRelative)) {
        continue;
      }

      if (child.isDirectory()) {
        totalFolders += 1;
        if (entries.length < maxEntries) {
          entries.push({ path: childRelative, type: "directory" });
        } else {
          truncated = true;
        }
        queue.push({ absolutePath: childAbsolute, relativePath: childRelative, depth: current.depth + 1 });
        continue;
      }

      if (child.isFile()) {
        totalFiles += 1;
        if (entries.length < maxEntries) {
          const entry: ProjectFileEntry = { path: childRelative, type: "file" };
          if (includeSizes) {
            entry.size = safeStatSize(childAbsolute);
          }
          entries.push(entry);
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    ok: true,
    project_id: options.projectId,
    root_hint: projectRootHint(projectRoot),
    max_depth: maxDepth,
    max_entries: maxEntries,
    total_files: totalFiles,
    total_folders: totalFolders,
    returned_entries: entries.length,
    truncated,
    ignored_dirs: [...IGNORED_DIRECTORIES].sort(),
    entries
  };
}

export function searchProjectFiles(root: string, options: ProjectFileSearchOptions): ProjectFileSearchResult {
  const query = requiredQuery(options.query);
  const maxResults = boundedInteger(options.maxResults ?? DEFAULT_SEARCH_RESULTS, "max_results", 1, 500);
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_SEARCH_DEPTH, "max_depth", 0, 20);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: ProjectFileEntry[] = [];
  let truncated = false;

  walkProject(root, { maxDepth, includeHidden: false }, (entry) => {
    const haystack = options.caseSensitive ? entry.path : entry.path.toLowerCase();
    if (!haystack.includes(needle)) {
      return true;
    }
    if (matches.length >= maxResults) {
      truncated = true;
      return false;
    }
    matches.push(entry);
    return true;
  });

  return {
    ok: true,
    project_id: options.projectId,
    query,
    matches,
    truncated
  };
}

export function readProjectFile(root: string, options: ProjectFileReadOptions): ProjectFileReadResult {
  const projectRoot = canonicalProjectRoot(root);
  const safePath = resolveSafeRelativePath(projectRoot, options.relativePath);
  const stat = fs.statSync(safePath.absolutePath);
  if (!stat.isFile()) {
    throw new ProjectFileError("not_a_file", "Requested path is not a file.");
  }
  if (isBinaryFile(safePath.absolutePath)) {
    throw new ProjectFileError("binary_file", "Binary files cannot be read.");
  }

  const maxChars = options.maxChars === undefined ? undefined : boundedInteger(options.maxChars, "max_chars", 1, HARD_MAX_READ_BYTES);
  let content = readUtf8Prefix(safePath.absolutePath, Math.min(stat.size, DEFAULT_MAX_READ_BYTES));
  if (options.startLine !== undefined || options.numLines !== undefined) {
    content = lineWindow(content, options.startLine, options.numLines);
  }
  const redactedContent = redactSecrets(content);
  const charTruncated = maxChars !== undefined && redactedContent.length > maxChars;
  const truncated = stat.size > DEFAULT_MAX_READ_BYTES || charTruncated;
  return {
    ok: true,
    project_id: options.projectId,
    path: safePath.relativePath,
    size: stat.size,
    encoding: "utf-8",
    truncated,
    redacted: redactedContent !== content,
    content: charTruncated ? redactedContent.slice(0, maxChars ?? redactedContent.length) : redactedContent
  };
}

export function searchProjectText(root: string, options: ProjectTextSearchOptions): ProjectTextSearchResult {
  const query = requiredQuery(options.query);
  const maxMatches = boundedInteger(options.maxMatches ?? DEFAULT_MAX_GREP_MATCHES, "max_matches", 1, 500);
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_SEARCH_DEPTH, "max_depth", 0, 20);
  const maxFileSize = boundedInteger(options.maxFileSize ?? DEFAULT_MAX_GREP_FILE_SIZE, "max_file_size", 1, 1000000);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: ProjectTextMatch[] = [];
  let truncated = false;
  let redacted = false;

  walkProject(root, { maxDepth, includeHidden: false }, (entry, absolutePath) => {
    if (entry.type !== "file" || isSensitiveRelativePath(entry.path)) {
      return true;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size > maxFileSize || isBinaryFile(absolutePath)) {
      return true;
    }
    let content: string;
    try {
      content = decodeUtf8(fs.readFileSync(absolutePath));
    } catch {
      return true;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = options.caseSensitive ? lines[index] : lines[index].toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
      if (matches.length >= maxMatches) {
        truncated = true;
        return false;
      }
      const snippet = redactSearchSnippet(lines[index].slice(0, 500), query, options.caseSensitive ?? false);
      redacted = redacted || snippet !== lines[index].slice(0, 500);
      matches.push({
        path: entry.path,
        line: index + 1,
        snippet
      });
    }
    return true;
  });

  return {
    ok: true,
    project_id: options.projectId,
    query,
    matches,
    truncated,
    redacted
  };
}

export function formatProjectTree(result: ProjectTreeResult): string {
  return [
    `Project tree: ${result.project_id}`,
    `Root: ${result.root_hint}`,
    `Files: ${result.total_files}`,
    `Folders: ${result.total_folders}`,
    `Returned: ${result.returned_entries}`,
    `Truncated: ${result.truncated ? "yes" : "no"}`,
    "",
    ...result.entries.map((entry) => `${entry.type === "directory" ? "dir " : "file"} ${entry.path}${entry.size !== undefined ? ` (${entry.size} bytes)` : ""}`)
  ].join("\n");
}

export function formatProjectFileSearch(result: ProjectFileSearchResult): string {
  return [`File search: ${result.query}`, `Matches: ${result.matches.length}`, `Truncated: ${result.truncated ? "yes" : "no"}`, "", ...result.matches.map((entry) => `${entry.type} ${entry.path}${entry.size !== undefined ? ` (${entry.size} bytes)` : ""}`)].join("\n");
}

export function formatProjectFileRead(result: ProjectFileReadResult): string {
  return [`File: ${result.path}`, `Size: ${result.size}`, `Truncated: ${result.truncated ? "yes" : "no"}`, `Redacted: ${result.redacted ? "yes" : "no"}`, "", result.content].join("\n");
}

export function formatProjectTextSearch(result: ProjectTextSearchResult): string {
  return [`Text search: ${result.query}`, `Matches: ${result.matches.length}`, `Truncated: ${result.truncated ? "yes" : "no"}`, "", ...result.matches.map((match) => `${match.path}:${match.line}: ${match.snippet}`)].join("\n");
}

function walkProject(
  root: string,
  options: { maxDepth: number; includeHidden: boolean },
  onEntry: (entry: ProjectFileEntry, absolutePath: string) => boolean
): void {
  const projectRoot = canonicalProjectRoot(root);
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [{ absolutePath: projectRoot, relativePath: "", depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (!current || current.depth >= options.maxDepth) {
      continue;
    }

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isSymbolicLink() || shouldIgnoreName(child.name, options.includeHidden)) {
        continue;
      }

      const childRelative = toPosixPath(path.join(current.relativePath, child.name));
      if (isSensitiveRelativePath(childRelative)) {
        continue;
      }
      const childAbsolute = path.join(current.absolutePath, child.name);
      const stat = fs.statSync(childAbsolute);
      const entry: ProjectFileEntry = {
        path: childRelative,
        type: child.isDirectory() ? "directory" : "file",
        ...(child.isFile() ? { size: stat.size } : {})
      };
      if (!onEntry(entry, childAbsolute)) {
        return;
      }
      if (child.isDirectory()) {
        queue.push({ absolutePath: childAbsolute, relativePath: childRelative, depth: current.depth + 1 });
      }
    }
  }
}

function canonicalProjectRoot(root: string): string {
  return fs.realpathSync(root);
}

function resolveSafeRelativePath(projectRoot: string, relativePathInput: string): { absolutePath: string; relativePath: string } {
  const relativePath = normalizeProjectRelativePath(relativePathInput);
  if (isSensitiveRelativePath(relativePath)) {
    throw new ProjectFileError("blocked_sensitive_file", "Requested file is blocked as sensitive.");
  }
  const candidate = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(candidate)) {
    throw new ProjectFileError("not_found", "Requested file was not found.", 404);
  }
  const realCandidate = fs.realpathSync(candidate);
  if (!isPathInside(projectRoot, realCandidate)) {
    throw new ProjectFileError("path_outside_project", "Requested path is outside the project root.");
  }
  return { absolutePath: realCandidate, relativePath };
}

function normalizeProjectRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ProjectFileError("invalid_path", "Project-relative path is required.");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.includes(":")) {
    throw new ProjectFileError("invalid_path", "Path must be project-relative and cannot be absolute, a URL, or a drive path.");
  }
  const parts = trimmed.split(/[\\/]+/);
  if (parts.some((part) => part === ".." || part === "")) {
    throw new ProjectFileError("invalid_path", "Path must not contain traversal or empty segments.");
  }
  return toPosixPath(path.normalize(parts.join(path.sep)));
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldIgnoreName(name: string, includeHidden: boolean): boolean {
  if (IGNORED_DIRECTORIES.has(name)) {
    return true;
  }
  return !includeHidden && name.startsWith(".");
}

function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (normalized === ".agentbridge/local_token" || basename === "local_token" || basename === "id_rsa" || basename === "id_ed25519") {
    return true;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  return [".pem", ".key", ".p12", ".pfx", ".sqlite", ".db"].some((extension) => basename.endsWith(extension));
}

function isBinaryFile(filePath: string): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }
  const chunk = fs.readFileSync(filePath).subarray(0, 8192);
  if (chunk.includes(0)) {
    return true;
  }
  try {
    TEXT_DECODER.decode(chunk);
    return false;
  } catch {
    return true;
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return TEXT_DECODER.decode(buffer);
  } catch {
    throw new ProjectFileError("binary_file", "File is not valid UTF-8 text.");
  }
}

function readUtf8Prefix(filePath: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytesToRead = Math.min(maxBytes + 4, HARD_MAX_READ_BYTES + 4);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return decodeUtf8Prefix(buffer.subarray(0, bytesRead), Math.min(maxBytes, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

function decodeUtf8Prefix(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buffer.length);
  for (let trims = 0; trims <= 4 && end >= 0; trims += 1) {
    try {
      return TEXT_DECODER.decode(buffer.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  throw new ProjectFileError("binary_file", "File is not valid UTF-8 text.");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksSensitiveSearchQuery(query: string): boolean {
  const value = query.trim();
  return (
    value.length >= 20 &&
    (/(?:token|secret|key|password|auth|jwt|bearer|credential|manual_grep|gamma_grep)/i.test(value) ||
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value) ||
      (/[A-Z]/.test(value) && /[0-9]/.test(value) && /[_-]/.test(value)))
  );
}

function redactSearchSnippet(input: string, query: string, caseSensitive: boolean): string {
  let output = redactSecrets(input);
  if (looksSensitiveSearchQuery(query)) {
    output = output.replace(new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi"), "[REDACTED]");
  }
  return output;
}

function lineWindow(content: string, startLineInput?: number, numLinesInput?: number): string {
  const startLine = startLineInput === undefined ? 1 : boundedInteger(startLineInput, "start_line", 1, 1000000);
  const numLines = numLinesInput === undefined ? undefined : boundedInteger(numLinesInput, "num_lines", 1, 100000);
  const lines = content.split(/\r?\n/);
  const startIndex = startLine - 1;
  return lines.slice(startIndex, numLines === undefined ? undefined : startIndex + numLines).join("\n");
}

function requiredQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new ProjectFileError("invalid_query", "Search query is required.");
  }
  return trimmed;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProjectFileError("invalid_query", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function safeStatSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
