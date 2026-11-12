import Link from "next/link";

const NAV = [
  { href: "/roadmap", label: "學習路線" },
  { href: "/certs", label: "證照備考" },
  { href: "/services", label: "服務對照" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm text-surface">
            雲
          </span>
          <span className="max-sm:sr-only">雲端工程師學院</span>
        </Link>
        <nav aria-label="主要導覽" className="flex items-center text-sm font-medium">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2.5 py-1.5 text-muted hover:bg-surface-2 hover:text-text sm:px-3"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
