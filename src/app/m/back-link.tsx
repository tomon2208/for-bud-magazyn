import Link from "next/link";

/** Duży przycisk powrotu (cel dotyku ≥ 48 px) w nagłówku ekranów terminala. */
export function BackLink({ href = "/m", children = "Menu" }: { href?: string; children?: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-12 items-center gap-2 rounded-xl px-3 text-lg font-medium underline-offset-4 active:bg-muted"
    >
      <span aria-hidden="true">←</span>
      {children}
    </Link>
  );
}
