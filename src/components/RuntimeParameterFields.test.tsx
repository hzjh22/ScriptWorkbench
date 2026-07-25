import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeParameterDefinition } from "../types";
import { RuntimeParameterFields } from "./RuntimeParameterFields";

const baseParameter: RuntimeParameterDefinition = {
  name: "value",
  label: "参数",
  description: "",
  type: "text",
  required: true,
  defaultValue: "",
  options: [],
  min: null,
  max: null,
};

describe("RuntimeParameterFields", () => {
  it("maps number, boolean and choice definitions to native accessible controls", () => {
    render(
      <RuntimeParameterFields
        parameters={[
          { ...baseParameter, name: "workers", label: "线程数", type: "number", min: 1, max: 32 },
          { ...baseParameter, name: "quiet", label: "静默模式", type: "boolean" },
          {
            ...baseParameter,
            name: "quality",
            label: "画质",
            type: "choice",
            options: ["720p", "1080p"],
          },
        ]}
        values={{ workers: "12", quiet: "false", quality: "1080p" }}
        errors={{}}
        onChange={vi.fn()}
        onPickPath={vi.fn()}
      />,
    );

    const number = screen.getByRole("spinbutton", { name: "线程数" });
    expect(number.getAttribute("min")).toBe("1");
    expect(number.getAttribute("max")).toBe("32");
    expect(screen.getByRole("switch", { name: "静默模式" }).getAttribute("aria-checked"))
      .toBe("false");
    expect((screen.getByRole("combobox", { name: "画质" }) as HTMLSelectElement).value)
      .toBe("1080p");
  });

  it("renders the ComicBox target form with generated URL, overridable output and empty semantics", () => {
    const parameters: RuntimeParameterDefinition[] = [
      { ...baseParameter, name: "book_id", label: "漫画 ID", type: "text" },
      {
        ...baseParameter,
        name: "book_url",
        label: "漫画地址",
        type: "text",
        derivedTemplate: "https://www.comicbox.xyz/book/{{book_id}}",
        allowOverride: false,
      },
      {
        ...baseParameter,
        name: "output",
        label: "输出目录",
        type: "directory",
        derivedTemplate: "F:\\CIL\\conmic\\comicbox_{{book_id}}_backup",
        allowOverride: true,
      },
      {
        ...baseParameter,
        name: "chapters",
        label: "章节范围",
        required: false,
        defaultValue: "77-117",
      },
      {
        ...baseParameter,
        name: "limit",
        label: "最多处理章节数",
        type: "number",
        required: false,
      },
    ];

    const { container } = render(
      <RuntimeParameterFields
        parameters={parameters}
        values={{ book_id: "5336", chapters: "77-117" }}
        errors={{}}
        onChange={vi.fn()}
        onPickPath={vi.fn()}
      />,
    );

    expect(container.querySelector(".comicbox-runtime-fields")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "漫画 ID" }).textContent).toBe("5336");
    expect(screen.getByRole("textbox", { name: "漫画地址" }).textContent)
      .toBe("https://www.comicbox.xyz/book/5336");
    expect(screen.getByRole("textbox", { name: "输出目录" }).textContent)
      .toBe("F:\\CIL\\conmic\\comicbox_5336_backup");
    expect(screen.getByRole("button", { name: "选择目录" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "章节范围" }).getAttribute("data-placeholder"))
      .toContain("留空表示全部下载");
    expect(screen.getByRole("spinbutton", { name: "最多处理章节数" }).getAttribute("placeholder"))
      .toBe("留空表示不限制");
    expect(screen.getByText("自动生成")).toBeTruthy();
    expect(screen.getByText("自动生成，可修改")).toBeTruthy();
  });

  it("renders the video source modes with business labels and generated watch URL", () => {
    const parameters: RuntimeParameterDefinition[] = [
      {
        ...baseParameter,
        name: "source_mode",
        label: "来源模式",
        type: "choice",
        options: ["id", "url", "html"],
        defaultValue: "id",
      },
      { ...baseParameter, name: "video_id", label: "视频 ID", type: "text" },
      {
        ...baseParameter,
        name: "generated_watch_url",
        label: "自动生成的播放页地址",
        derivedTemplate: "https://hanime1.me/watch?v={{video_id}}",
        allowOverride: false,
        required: false,
        condition: { field: "source_mode", operator: "equals", value: "id" },
      },
    ];

    const { container } = render(
      <RuntimeParameterFields
        parameters={parameters}
        values={{ source_mode: "id", video_id: "abc123" }}
        errors={{}}
        onChange={vi.fn()}
        onPickPath={vi.fn()}
      />,
    );

    expect(container.querySelector(".video-runtime-fields")).toBeTruthy();
    expect(screen.getByRole("option", { name: "视频 ID" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "播放页地址" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "本地 HTML 文件" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "自动生成的播放页地址" }).textContent)
      .toBe("https://hanime1.me/watch?v=abc123");
  });

  it("preserves line breaks from repeat-value contenteditable controls", () => {
    const onChange = vi.fn();
    render(
      <RuntimeParameterFields
        parameters={[{ ...baseParameter, name: "url", label: "图集 URL（每行一个）" }]}
        values={{ url: "" }}
        errors={{}}
        onChange={onChange}
        onPickPath={vi.fn()}
        repeatParameterNames={["url"]}
      />,
    );

    const input = screen.getByRole("textbox", { name: "图集 URL（每行一个）" });
    Object.defineProperty(input, "innerText", {
      configurable: true,
      value: "https://example/1\nhttps://example/2",
    });
    fireEvent.input(input);
    expect(onChange).toHaveBeenCalledWith(
      "url",
      "https://example/1\nhttps://example/2",
    );
  });

  it("renders Telegram target modes and action choices with business labels", () => {
    const parameters: RuntimeParameterDefinition[] = [
      {
        ...baseParameter,
        name: "target_mode",
        label: "目标模式",
        type: "choice",
        options: ["link", "entity"],
        defaultValue: "link",
      },
      {
        ...baseParameter,
        name: "links",
        label: "Telegram 链接",
        condition: { field: "target_mode", operator: "equals", value: "link" },
      },
      {
        ...baseParameter,
        name: "entity",
        label: "Telegram 实体",
        condition: { field: "target_mode", operator: "equals", value: "entity" },
      },
      {
        ...baseParameter,
        name: "action",
        label: "执行动作",
        type: "choice",
        options: ["inspect", "download"],
        defaultValue: "inspect",
      },
    ];

    render(
      <RuntimeParameterFields
        parameters={parameters}
        values={{ target_mode: "link", action: "inspect" }}
        errors={{}}
        onChange={vi.fn()}
        onPickPath={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "消息链接" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "实体 / 对话" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "仅检查" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "下载媒体" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Telegram 链接" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Telegram 实体" })).toBeNull();
  });
});

