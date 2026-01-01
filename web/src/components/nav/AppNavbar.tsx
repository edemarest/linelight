"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  FiBarChart2,
  FiHome,
  FiMap,
  FiMapPin,
  FiMenu,
  FiMoon,
  FiSun,
  FiX,
} from "react-icons/fi";

import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useThemeMode } from "@/hooks/useThemeMode";

const NAV_BUTTON_CLASS = "btn btn-ghost focus-outline inline-flex items-center gap-1.5 text-sm font-semibold";

const PRIMARY_NAV_LINKS = [
  { href: "/", label: "Home", icon: <FiHome /> },
  { href: "/lines", label: "Lines", icon: <FiMap /> },
  { href: "/insights", label: "Insights", icon: <FiBarChart2 /> },
] as const;

export const AppNavbar = () => {
  const pathname = usePathname();
  const { mode: themeMode, toggleTheme } = useThemeMode();
  const { isDesktop } = useBreakpoint();
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);

  useEffect(() => {
    if (isDesktop) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsNavDrawerOpen(false);
    }
  }, [isDesktop]);

  const locationHref = useMemo(() => "/?openLocation=1", []);

  const linkIsActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname?.startsWith(href);
  };

  const desktopLinkClass = (href: string) =>
    `${NAV_BUTTON_CLASS} ${linkIsActive(href) ? "border border-[color:var(--accent)] bg-[color:var(--accent-soft)]" : "border border-transparent"}`;

  const drawerLinkClass = (href: string) =>
    `flex items-center gap-3 rounded-xl border px-2 py-1.5 text-base font-semibold ${
      linkIsActive(href) ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]" : "border-transparent"
    }`;

  return (
    <header
      className="sticky top-0 z-40 border-b bg-[color:var(--background)]/95 backdrop-blur"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6 sm:py-2.5">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-wide" style={{ color: "var(--foreground)" }}>
          <Image src="/logo.png" alt="LinesLight" width={160} height={48} priority className="h-7 w-auto" />
          <span className="sr-only">LinesLight</span>
        </Link>

        {isDesktop ? (
          <nav className="hidden items-center gap-2 lg:flex" aria-label="Primary navigation">
            {PRIMARY_NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={desktopLinkClass(link.href)}
                aria-current={linkIsActive(link.href) ? "page" : undefined}
              >
                {link.icon}
                <span>{link.label}</span>
              </Link>
            ))}

            <Link href={locationHref} className={NAV_BUTTON_CLASS} aria-label="Location settings">
              <FiMapPin />
              <span className="hidden sm:inline">Location</span>
            </Link>

            <button type="button" onClick={toggleTheme} className={NAV_BUTTON_CLASS} aria-label="Toggle theme">
              {themeMode === "dark" ? <FiSun /> : <FiMoon />}
              <span className="hidden sm:inline">{themeMode === "dark" ? "Light" : "Dark"}</span>
            </button>
          </nav>
        ) : (
          <div className="flex items-center gap-2 lg:hidden">
            <Link href={locationHref} className="icon-button" aria-label="Location settings">
              <FiMapPin />
            </Link>
            <button type="button" onClick={toggleTheme} className="icon-button" aria-label="Toggle theme">
              {themeMode === "dark" ? <FiSun /> : <FiMoon />}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setIsNavDrawerOpen((prev) => !prev)}
              aria-expanded={isNavDrawerOpen}
              aria-controls="primary-nav-panel"
              aria-label={isNavDrawerOpen ? "Close navigation" : "Open navigation"}
            >
              {isNavDrawerOpen ? <FiX /> : <FiMenu />}
            </button>
          </div>
        )}
      </div>

      {!isDesktop && (
        <div
          id="primary-nav-panel"
          className={`mx-auto w-full max-w-6xl px-4 transition-[max-height,opacity] duration-200 overflow-hidden sm:px-6 ${
            isNavDrawerOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{ maxHeight: isNavDrawerOpen ? "480px" : "0px" }}
        >
          <nav
            className="rounded-2xl border bg-[color:var(--card)] p-4 shadow-xl"
            style={{ borderColor: "var(--border)" }}
            aria-label="Primary navigation drawer"
          >
            <div className="flex flex-col gap-2">
              {PRIMARY_NAV_LINKS.map((link) => (
                <Link
                  key={`drawer-${link.href}`}
                  href={link.href}
                  className={drawerLinkClass(link.href)}
                  style={{ color: "var(--foreground)" }}
                  aria-current={linkIsActive(link.href) ? "page" : undefined}
                  onClick={() => setIsNavDrawerOpen(false)}
                >
                  {link.icon}
                  <span>{link.label}</span>
                </Link>
              ))}

              <Link
                href={locationHref}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
                style={{ color: "var(--foreground)" }}
                onClick={() => setIsNavDrawerOpen(false)}
              >
                <FiMapPin />
                <span>Location</span>
              </Link>

              <button
                type="button"
                onClick={() => {
                  toggleTheme();
                  setIsNavDrawerOpen(false);
                }}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
                style={{ color: "var(--foreground)" }}
              >
                {themeMode === "dark" ? <FiSun /> : <FiMoon />}
                <span>{themeMode === "dark" ? "Light mode" : "Dark mode"}</span>
              </button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
};
