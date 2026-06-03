import { describe, expect, it } from "vitest";
import {
  buildCoverageWarning,
  buildInventory,
  classifyTopLevelEntries,
  detectSuspiciousRootFiles,
  estimateScale,
  findImportantCandidates,
  findRecommendedNextReads,
  type AwarenessTreeEntry
} from "../src/projectAwareness.js";

describe("project awareness helpers", () => {
  it("estimates small, medium, large, and extreme scales", () => {
    expect(estimateScale({ totalFiles: 1000, totalDirs: 10, totalEntries: 1010 })).toBe("small");
    expect(estimateScale({ totalFiles: 1001, totalDirs: 10, totalEntries: 1011 })).toBe("medium");
    expect(estimateScale({ totalFiles: 20001, totalDirs: 10, totalEntries: 20011 })).toBe("large");
    expect(estimateScale({ totalFiles: 200001, totalDirs: 10, totalEntries: 200011 })).toBe("extreme");
  });

  it("classifies top-level project roles including skipped noise directories", () => {
    const entries: AwarenessTreeEntry[] = [
      { path: "src", type: "directory" },
      { path: "test", type: "directory" },
      { path: "docs", type: "directory" },
      { path: "scripts", type: "directory" },
      { path: "README.md", type: "file" },
      { path: "package.json", type: "file" }
    ];

    const classification = classifyTopLevelEntries(entries, ["dist", "node_modules", ".agentbridge"]);

    expect(classification.source_dirs).toEqual(["src"]);
    expect(classification.test_dirs).toEqual(["test"]);
    expect(classification.docs_dirs).toEqual(["docs"]);
    expect(classification.script_dirs).toEqual(["scripts"]);
    expect(classification.config_files).toEqual(["package.json", "README.md"]);
    expect(classification.generated_dirs).toEqual(["dist"]);
    expect(classification.vendor_dirs).toEqual(["node_modules"]);
    expect(classification.tooling_dirs).toEqual([".agentbridge"]);
  });

  it("finds important candidates and recommended next reads", () => {
    const entries: AwarenessTreeEntry[] = [
      { path: "README.md", type: "file" },
      { path: "package.json", type: "file" },
      { path: "src/server.ts", type: "file" },
      { path: "src/projectFiles.ts", type: "file" },
      { path: "test/projectFiles.test.ts", type: "file" },
      { path: "dist/generated.js", type: "file" }
    ];
    const classification = classifyTopLevelEntries([{ path: "src", type: "directory" }, { path: "test", type: "directory" }]);

    const candidates = findImportantCandidates(entries, classification, ["src/projectFiles.ts"]);
    const paths = candidates.map((candidate) => candidate.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/server.ts");
    expect(paths).toContain("src/projectFiles.ts");
    expect(paths).toContain("test/projectFiles.test.ts");
    expect(paths).not.toContain("dist/generated.js");
    expect(findRecommendedNextReads(candidates).map((read) => read.path)).toContain("README.md");
  });

  it("detects suspicious root files and partial coverage warnings", () => {
    const suspicious = detectSuspiciousRootFiles([
      { path: "tatus --short", type: "file" },
      { path: "debug.log", type: "file" },
      { path: "src/git status", type: "file" }
    ]);
    expect(suspicious.map((file) => file.path)).toEqual(["tatus --short", "debug.log"]);

    const inventory = buildInventory({
      totalFiles: 10,
      totalDirs: 3,
      treeTruncated: true,
      maxDepth: 1,
      maxEntries: 5,
      bytesEstimate: 1234
    });
    const warning = buildCoverageWarning({
      inventoryComplete: inventory.complete,
      treeTruncated: inventory.tree_truncated,
      scaleHint: inventory.scale_hint
    });

    expect(inventory.complete).toBe(false);
    expect(warning?.level).toBe("partial");
    expect(warning?.message).toContain("Do not claim complete repository awareness");
  });
});
