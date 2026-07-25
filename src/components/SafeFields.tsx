import { memo, useEffect, useRef } from "react";

export type ChoiceOption = { value: string; label: string };

export const ChoiceField = memo(function ChoiceField({ value, options, onChange }: {
  value: string; options: ChoiceOption[]; onChange: (value: string) => void;
}) {
  return <div className="choice-grid">{options.map((option) => (
    <button key={option.value} type="button"
      className={`choice-chip ${value === option.value ? "active" : ""}`}
      onClick={() => onChange(option.value)}>{option.label}</button>
  ))}</div>;
});

export const SafeSingleLineInput = memo(function SafeSingleLineInput({ value, onChange, placeholder, ariaLabel, disabled = false }: {
  value: string; onChange: (value: string) => void; placeholder?: string; ariaLabel?: string; disabled?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (elementRef.current && elementRef.current.textContent !== value) elementRef.current.textContent = value;
  }, [value]);
  return <div ref={elementRef} className={`safe-single-line text-input ${disabled ? "disabled" : ""}`} contentEditable={!disabled}
    suppressContentEditableWarning role="textbox" aria-label={ariaLabel} aria-disabled={disabled} data-placeholder={placeholder ?? ""}
    title={value}
    onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
    onWheel={(event) => {
      const element = event.currentTarget;
      const maxScroll = element.scrollWidth - element.clientWidth;
      if (maxScroll <= 0) return;
      const delta = event.deltaX || event.deltaY;
      const nextScroll = Math.max(0, Math.min(maxScroll, element.scrollLeft + delta));
      if (nextScroll !== element.scrollLeft) {
        element.scrollLeft = nextScroll;
        event.preventDefault();
      }
    }}
    onPaste={(event) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " "));
    }}
    onInput={(event) => {
      if (!disabled) onChange((event.currentTarget.textContent ?? "").replace(/[\r\n]+/g, " "));
    }} />;
});

export const SafeToggle = memo(function SafeToggle({ checked, label, onChange }: {
  checked: boolean; label: string; onChange: (next: boolean) => void;
}) {
  return <button type="button" role="switch" aria-checked={checked}
    className={`toggle-chip ${checked ? "active" : ""}`} onClick={() => onChange(!checked)}>
    <span className="toggle-indicator" aria-hidden="true">{checked ? "●" : "○"}</span><span>{label}</span>
  </button>;
});

function multilineText(element: HTMLDivElement): string {
  const rendered = element.innerText;
  return (typeof rendered === "string" ? rendered : (element.textContent ?? ""))
    .replace(/\r\n?/g, "\n");
}

export const SafeMultilineInput = memo(function SafeMultilineInput({
  value, onChange, placeholder, ariaLabel, minHeight = 96,
}: {
  value: string; onChange: (value: string) => void; placeholder?: string; ariaLabel?: string; minHeight?: number;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = elementRef.current;
    if (!element || multilineText(element) === value) return;
    if (typeof element.innerText === "string") element.innerText = value;
    else element.textContent = value;
  }, [value]);
  return <div ref={elementRef} className="safe-multiline" contentEditable suppressContentEditableWarning
    role="textbox" aria-label={ariaLabel} aria-multiline="true"
    data-placeholder={placeholder ?? ""} style={{ minHeight }}
    onPaste={(event) => {
      event.preventDefault();
      document.execCommand(
        "insertText",
        false,
        event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"),
      );
    }}
    onInput={(event) => onChange(multilineText(event.currentTarget))} />;
});
