import { describe, expect, it } from "vitest";
import { extractTransferProgress, removeTransferProgressLines } from "./TaskRunModal";

describe("TaskRunModal transfer progress", () => {
  it("extracts the latest curl percentage from noisy progress output", () => {
    const output = [
      "  0 309.9M    0  543.4k    0     0  135.1k      0  39:07  0  00:04  0  39:03  0  00:00  0  00:00  0  00:00",
      " 23 309.9M   23 71.96M    0     0  5.53M      0  00:55  0  00:12  0  00:43  0  00:08  0  00:35",
      "100 309.9M  100 309.9M    0     0  6.20M      0  00:49  0  00:49  0  00:00  0  00:49  0  00:00",
    ].join("\n");

    expect(extractTransferProgress(output)).toBe(100);
  });

  it("removes curl meter lines while preserving useful logs", () => {
    const output = "开始下载视频\n 23 309.9M   23 71.96M    0     0  5.53M      0  00:55\n视频摘要处理中";

    expect(removeTransferProgressLines(output)).toBe("开始下载视频\n视频摘要处理中");
  });
});
