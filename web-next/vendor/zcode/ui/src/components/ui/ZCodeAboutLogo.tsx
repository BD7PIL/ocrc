// @ts-nocheck
import { cn } from "@/components/lib/utils.js";

// ocrc fork (PATCHES #12)：Z 字标换 enso mark（组件名保留，调用点零改动）。
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 64 56"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M46 8 A24 24 0 1 0 54 25"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <circle cx="49" cy="13" r="5.5" fill="#e4580f" />
    </svg>
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      width="244"
      height="54"
      viewBox="0 0 244 54"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M38 12 A22 22 0 1 0 45 27"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="41" cy="17" r="5" fill="#e4580f" />
      <text
        x="76"
        y="38"
        fill="currentColor"
        style={{ font: '600 34px ui-sans-serif, system-ui, sans-serif', letterSpacing: '0.02em' }}
      >
        ocrc
      </text>
    </svg>
  );
}
