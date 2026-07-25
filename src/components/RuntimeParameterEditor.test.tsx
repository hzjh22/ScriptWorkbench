import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeParameter } from "../lib/runtimeParameters";
import { RuntimeParameterEditor } from "./RuntimeParameterEditor";

describe("RuntimeParameterEditor", () => {
  it("shows a compact business field instead of internal schema metadata", () => {
    render(
      <RuntimeParameterEditor
        parameters={[{
          ...createDefaultRuntimeParameter("book_id"),
          label: "漫画 ID",
          source: "template",
          confidence: "low",
        }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText("漫画 ID")).toHaveLength(2);
    expect(screen.getAllByText("文本").length).toBeGreaterThan(0);
    expect(screen.getByText("高级规则")).toBeTruthy();
    expect(screen.queryByText("{{book_id}}")).toBeNull();
    expect(screen.queryByText("template · low")).toBeNull();
    expect(screen.queryByText("人工锁定")).toBeNull();
  });
});


