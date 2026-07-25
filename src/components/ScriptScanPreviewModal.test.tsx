import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeParameter } from "../lib/runtimeParameters";
import type { ScriptScanPreview } from "../types";
import { ScriptScanPreviewModal } from "./ScriptScanPreviewModal";

const preview: ScriptScanPreview = {
  taskName: "ComicBox",
  description: "fixture",
  framework: "argparse",
  source: "ast",
  confidence: "high",
  groups: [
    { id: "common", label: "常用参数", advanced: false },
    { id: "advanced", label: "高级设置", advanced: true },
  ],
  parameters: [
    { ...createDefaultRuntimeParameter("book_id"), label: "漫画 ID", source: "ast", confidence: "high" },
    { ...createDefaultRuntimeParameter("workers"), label: "并发数", type: "number", advanced: true, group: "高级设置", source: "ast", confidence: "high" },
  ],
  argumentRules: [{
    id: "book-url",
    inputName: "book_id",
    flag: "--book-url",
    emission: "always",
    valueTemplate: "https://example.test/{{book_id}}",
    condition: null,
    enabled: true,
  }],
  validationRules: [],
  relationshipCandidates: [{
    id: "book",
    label: "ID 派生 URL",
    description: "one input drives URL",
    confidence: "high",
    enabled: true,
    fromFields: ["book_id"],
    toFields: ["book_url"],
  }],
  diagnostics: ["AST only"],
  scriptHash: "sha256:test",
  generatedArguments: ["--book-url", "https://example.test/<book_id>"],
  helpRecommended: false,
};

describe("ScriptScanPreviewModal", () => {
  it("shows source, groups, relationships and lets the user disable a generated parameter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScriptScanPreviewModal
        preview={preview}
        busy={false}
        onChange={onChange}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onHelpScan={vi.fn()}
      />,
    );

    expect(screen.getByText("静态源码扫描")).toBeTruthy();
    expect(screen.getByText("结果可靠")).toBeTruthy();
    expect(screen.queryByText("来源：ast")).toBeNull();
    expect(screen.queryByText("{{book_id}}")).toBeNull();
    expect(screen.getByText("ID 派生 URL")).toBeTruthy();
    expect(screen.getByText(/--book-url/)).toBeTruthy();
    await user.click(screen.getAllByRole("switch", { name: "使用参数" })[0]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.arrayContaining([expect.objectContaining({ name: "book_id", enabled: false })]),
    }));
  });
});
