import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeSingleLineInput } from "./SafeFields";

describe("SafeSingleLineInput", () => {
  it("allows a long URL to scroll horizontally and exposes the full value", () => {
    const url = "https://example.test/photos-slide-aid-370138.html?chapter=long-value";
    render(<SafeSingleLineInput value={url} ariaLabel="Url" onChange={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Url" });
    Object.defineProperty(input, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(input, "scrollWidth", { configurable: true, value: 600 });
    Object.defineProperty(input, "scrollLeft", { configurable: true, writable: true, value: 0 });

    fireEvent.wheel(input, { deltaY: 80 });

    expect(input.scrollLeft).toBe(80);
    expect(input.getAttribute("title")).toBe(url);
  });
});
