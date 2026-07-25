import { describe, expect, it } from "vitest";
import type { RuntimeParameterDefinition } from "../types";
import {
  runtimeValuesWithDerived,
  syncRuntimeParameters,
  validateRuntimeValues,
} from "./runtimeParameters";

describe("dynamic runtime parameters", () => {
  it("derives ordered definitions from template placeholders while preserving metadata", () => {
    const existing: RuntimeParameterDefinition[] = [
      {
        name: "quality",
        label: "画质",
        description: "选择导出画质",
        type: "choice",
        required: true,
        defaultValue: "1080p",
        options: ["720p", "1080p"],
        min: null,
        max: null,
      },
      {
        name: "removed",
        label: "旧参数",
        description: "",
        type: "text",
        required: true,
        defaultValue: "",
        options: [],
        min: null,
        max: null,
      },
    ];

    const result = syncRuntimeParameters(
      "--id {{book_id}} --quality {{quality}}/{{book_id}}",
      existing,
    );
    expect(result.map((parameter) => parameter.name)).toEqual(["book_id", "quality"]);
    expect(result[0]).toMatchObject({
      name: "book_id",
      label: "book_id",
      group: "常用参数",
      source: "template",
      enabled: true,
    });
    expect(result[1]).toMatchObject(existing[0]);
  });

  it("rejects numbers outside their range and values outside configured choices", () => {
    const parameters: RuntimeParameterDefinition[] = [
      {
        ...syncRuntimeParameters("{{source_mode}}", [])[0],
        type: "choice",
        defaultValue: "id",
        options: ["id", "html"],
      },
      {
        ...syncRuntimeParameters("{{workers}}", [])[0],
        type: "number",
        min: 1,
        max: 32,
      },
      {
        ...syncRuntimeParameters("{{quality}}", [])[0],
        type: "choice",
        options: ["720p", "1080p"],
      },
    ];

    expect(validateRuntimeValues(parameters, { workers: "64", quality: "4k" })).toEqual({
      workers: "不能大于 32",
      quality: "请选择有效选项",
    });
  });

  it("derives related fields and validates only the active conditional group", () => {
    const parameters: RuntimeParameterDefinition[] = [
      {
        ...syncRuntimeParameters("{{source_mode}}", [])[0],
        type: "choice",
        defaultValue: "id",
        options: ["id", "html"],
      },
      {
        ...syncRuntimeParameters("{{book_id}}", [])[0],
        defaultValue: "5101",
      },
      {
        ...syncRuntimeParameters("{{output}}", [])[0],
        type: "directory",
        derivedTemplate: "F:/comicbox_{{book_id}}_backup",
        allowOverride: true,
      },
      {
        ...syncRuntimeParameters("{{input_html}}", [])[0],
        required: true,
        condition: { field: "source_mode", operator: "equals", value: "html" },
      },
    ];

    expect(runtimeValuesWithDerived(parameters, {})).toMatchObject({
      output: "F:/comicbox_5101_backup",
    });
    expect(validateRuntimeValues(parameters, { source_mode: "id" })).toEqual({});
    expect(validateRuntimeValues(parameters, { source_mode: "html" })).toHaveProperty("input_html");
  });
});
