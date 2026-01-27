"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiBook,
  FiHome,
  FiHeart,
  FiMenu,
  FiMoon,
  FiSun,
  FiUsers,
  FiX,
} from "react-icons/fi";

import { useThemeMode } from "@/hooks/useThemeMode";
import { DonationModal } from "@/components/donations/DonationModal";

const NAV_LINK_CLASS = "focus-outline inline-flex items-center gap-2 px-1.5 pb-2 text-base font-semibold nav-link";

const PRIMARY_NAV_LINKS = [
  { href: "/", label: "Home", icon: <FiHome /> },
  { href: "/docs/", label: "Docs", icon: <FiBook /> },
  { href: "/donors", label: "Donors", icon: <FiUsers /> },
] as const;

export const AppNavbar = () => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { mode: themeMode, toggleTheme } = useThemeMode();
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const [isDonationOpen, setIsDonationOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!isMounted) return;
    if (searchParams.get("donation")) {
      requestAnimationFrame(() => setIsDonationOpen(true));
    }
  }, [isMounted, searchParams]);

  const linkIsActive = (href: string) => {
    if (!isMounted) return false;
    if (href === "/") return pathname === "/";
    return pathname?.startsWith(href);
  };

  if (!isMounted) {
    return null;
  }

  const desktopLinkClass = (href: string) =>
    `${NAV_LINK_CLASS} ${linkIsActive(href) ? "nav-link--active" : ""}`;

  const drawerLinkClass = (href: string) =>
    `flex items-center gap-3 rounded-xl border px-2 py-1.5 text-base font-semibold ${
      linkIsActive(href) ? "nav-drawer-link--active" : "border-transparent"
    }`;

  return (
    <header
      className="sticky top-0 z-40 border-b bg-[color:var(--background)]/95 backdrop-blur"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-3 sm:px-6 sm:py-3.5">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-wide" style={{ color: "var(--foreground)" }}>
            <Image
              src="/logos/logo.png"
              alt="LinesLight"
              width={160}
              height={48}
              priority
              className="h-7 w-auto"
            />
            <span className="sr-only">LinesLight</span>
          </Link>
        </div>

        <div className="hidden items-center gap-6 lg:flex">
          <nav className="relative flex items-center gap-6" aria-label="Primary navigation">
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
          </nav>
          <button type="button" onClick={toggleTheme} className="icon-button" aria-label="Toggle theme" data-interactive="icon">
            {isMounted ? (themeMode === "dark" ? <FiSun /> : <FiMoon />) : <FiMoon />}
          </button>
        </div>
        <div className="flex items-center gap-2 lg:hidden">
          <Link href="/" className="icon-button" aria-label="Home" data-interactive="icon">
            <FiHome />
          </Link>
          <button type="button" onClick={toggleTheme} className="icon-button" aria-label="Toggle theme" data-interactive="icon">
            {isMounted ? (themeMode === "dark" ? <FiSun /> : <FiMoon />) : <FiMoon />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setIsNavDrawerOpen((prev) => !prev)}
            aria-expanded={isNavDrawerOpen}
            aria-controls="primary-nav-panel"
            aria-label={isNavDrawerOpen ? "Close navigation" : "Open navigation"}
            data-interactive="icon"
          >
            {isNavDrawerOpen ? <FiX /> : <FiMenu />}
          </button>
        </div>
      </div>

      <div
        id="primary-nav-panel"
        className={`mx-auto w-full max-w-6xl px-4 transition-[max-height,opacity] duration-200 overflow-hidden sm:px-6 lg:hidden ${
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
                data-interactive="ghost"
              >
                {link.icon}
                <span>{link.label}</span>
              </Link>
            ))}

            <button
              type="button"
              onClick={() => {
                setIsDonationOpen(true);
                setIsNavDrawerOpen(false);
              }}
              className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
              style={{ color: "var(--foreground)" }}
              data-interactive="ghost"
            >
              <FiHeart />
              <span>Support LineLight</span>
            </button>
            <button
              type="button"
              onClick={() => {
                toggleTheme();
                setIsNavDrawerOpen(false);
              }}
              className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
              style={{ color: "var(--foreground)" }}
              data-interactive="ghost"
            >
              {isMounted ? (themeMode === "dark" ? <FiSun /> : <FiMoon />) : <FiMoon />}
              <span>{isMounted ? (themeMode === "dark" ? "Light mode" : "Dark mode") : "Theme"}</span>
            </button>
          </div>
        </nav>
      </div>
      <div className="app-header-accent" aria-hidden="true" />
      {typeof document !== "undefined" &&
        createPortal(
          <button
            type="button"
            onClick={() => setIsDonationOpen(true)}
            className={`donation-float-button ${isDonationOpen ? "donation-float-button--hidden" : ""}`}
            aria-label="Support LineLight"
          >
            <span className="donation-float-label">Support LineLight</span>
            <FiHeart className="donation-float-icon" />
          </button>,
          document.body,
        )}
      <DonationModal isOpen={isDonationOpen} onClose={() => setIsDonationOpen(false)} />
    </header>
  );
};
