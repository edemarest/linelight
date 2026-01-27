"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { FiBookOpen, FiMap, FiServer, FiZap } from "react-icons/fi";

const DOC_SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    icon: <FiBookOpen />,
    summary: "LinesLight is a real-time MBTA map and trip planner.",
    bullets: [
      "Search stops, lines, or places from the top bar.",
      "See arrivals with live predictions or schedules.",
      "Follow trips to track vehicles on the map.",
    ],
    note: "Updates refresh automatically when live data is available.",
  },
  {
    id: "features",
    title: "Feature highlights",
    icon: <FiMap />,
    summary: "Short walkthroughs of the core experiences.",
    featureCards: [
      {
        title: "Stop sheet",
        description:
          "Open a stop to view the next departures, destination labels, and live status. Tap a trip to follow it on the map.",
        image: "/preview-images/Stop_Sheet_Preview.png",
        alt: "Stop sheet showing upcoming departures and a follow action",
      },
      {
        title: "Follow mode",
        description:
          "Track a vehicle in real time. The follow panel surfaces ETAs for the next stops and keeps the map centered on the trip.",
        image: "/preview-images/Follow_Mode_Preview.png",
        alt: "Follow mode with vehicle tracking and upcoming stop tiles",
      },
      {
        title: "Trip planning",
        description:
          "Enter a start and destination to compare options by time and transfers, then view the route on the map.",
        image: "/preview-images/Trip_Plan_Preview.png",
        alt: "Trip planning panel with route options and the map",
      },
      {
        title: "Saved locations",
        description:
          "Save places you return to often and optionally keep line filters. Tap “Use” to jump back quickly.",
        image: "/preview-images/Save_Location_Preview.png",
        alt: "Saved locations panel with save and use actions",
      },
    ],
  },
  {
    id: "using-lineslight",
    title: "Using LinesLight",
    icon: <FiMap />,
    summary: "Explore the system with the map, stop boards, and trip planner.",
    bullets: [
      "Toggle line layers to see routes and corridors.",
      "Tap a stop for arrivals and platform details.",
      "Plan a trip to compare time and transfers.",
    ],
    note: "The center target shows the map focus while panning.",
  },
  {
    id: "data",
    title: "Service & data",
    icon: <FiZap />,
    summary: "Alerts and data freshness keep you in the know.",
    bullets: [
      "Service alerts appear when available for lines or stops.",
      "Vehicle locations and predictions update frequently.",
      "If live data is missing, LinesLight shows a message instead of stale info.",
    ],
    note: "Connectivity or MBTA outages can affect real-time updates.",
  },
  {
    id: "how-its-built",
    title: "How LinesLight is built",
    icon: <FiServer />,
    summary: "A fast stack that keeps live transit data responsive.",
    stackCards: [
      {
        title: "Next.js",
        description: "Frontend UI and routing",
        icon: <FiMap />,
      },
      {
        title: "Node.js API",
        description: "Server that queries MBTA v3",
        icon: <FiServer />,
      },
      {
        title: "PostgreSQL",
        description: "Stops, routes, and trip planning data",
        icon: <FiBookOpen />,
      },
      {
        title: "Redis",
        description: "Hot cache for live updates",
        icon: <FiZap />,
      },
    ],
  },
];

export default function DocsPage() {
  const sectionIds = useMemo(() => DOC_SECTIONS.map((section) => section.id), []);
  const [activeSectionId, setActiveSectionId] = useState(sectionIds[0] ?? "overview");
  const [observedSections, setObservedSections] = useState<Set<string>>(new Set());
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const visibleSections = prefersReducedMotion ? new Set(sectionIds) : observedSections;

  useEffect(() => {
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = "smooth";
    
    // Detect reduced motion preference
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener("change", handleChange);
    
    return () => {
      html.style.scrollBehavior = previous;
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));

    if (elements.length === 0) return;

    const updateActiveSection = () => {
      const offset = 140;
      let currentId = elements[0]?.id ?? sectionIds[0] ?? "overview";
      const { scrollY, innerHeight } = window;
      const docHeight = document.documentElement.scrollHeight;

      if (scrollY + innerHeight >= docHeight - 4) {
        setActiveSectionId(elements[elements.length - 1]?.id ?? currentId);
        return;
      }

      for (const el of elements) {
        if (el.getBoundingClientRect().top - offset <= 0) {
          currentId = el.id;
        } else {
          break;
        }
      }

      setActiveSectionId(currentId);
    };

    updateActiveSection();

    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [sectionIds]);

  // Scroll animation observer
  useEffect(() => {
    if (prefersReducedMotion) {
      return;
    }

    const animatableElements = document.querySelectorAll('[data-animate]');
    if (animatableElements.length === 0) return;

    const animationObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const sectionId = entry.target.getAttribute('data-section-id');
            if (sectionId) {
              setObservedSections((prev) => new Set(prev).add(sectionId));
            }
          }
        });
      },
      { rootMargin: '50px', threshold: 0.15 },
    );

    animatableElements.forEach((el) => animationObserver.observe(el));
    return () => animationObserver.disconnect();
  }, [sectionIds, prefersReducedMotion]);

  // Handle hash navigation on page load and browser back/forward
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (hash && sectionIds.includes(hash)) {
        const element = document.getElementById(hash);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setActiveSectionId(hash);
        }
      }
    };

    // Handle initial hash on page load
    const hash = window.location.hash.slice(1);
    if (hash && sectionIds.includes(hash)) {
      const timeoutId = setTimeout(() => {
        const element = document.getElementById(hash);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setActiveSectionId(hash);
        }
      }, 100);
      
      // Listen for hash changes (browser back/forward)
      window.addEventListener('hashchange', handleHashChange);
      
      return () => {
        clearTimeout(timeoutId);
        window.removeEventListener('hashchange', handleHashChange);
      };
    }

    // Listen for hash changes even if no initial hash
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [sectionIds]);

  return (
    <main className="min-h-screen bg-[color:var(--background)]">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-[-20%] top-[-10%] h-[420px] w-[420px] rounded-full opacity-25 blur-[130px]" style={{ background: "rgba(0, 61, 165, 0.35)" }} />
        <div className="absolute right-[-15%] top-[10%] h-[480px] w-[480px] rounded-full opacity-25 blur-[150px]" style={{ background: "rgba(128, 39, 108, 0.35)" }} />
      </div>
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6">
        <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted">Contents</p>
              <nav className="flex flex-col gap-1" aria-label="Documentation sections">
                {DOC_SECTIONS.map((section, idx) => {
                  const isActive = activeSectionId === section.id;
                  return (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        const element = document.getElementById(section.id);
                        if (element) {
                          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          window.history.pushState(null, '', `#${section.id}`);
                        }
                      }}
                      className="group relative py-2.5 text-sm font-medium transition-all duration-300 cursor-pointer"
                      style={{
                        color: isActive ? 'var(--foreground)' : 'var(--foreground)',
                        opacity: isActive ? 1 : 0.65,
                      }}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-all duration-300"
                          style={{
                            background: isActive
                              ? 'linear-gradient(135deg, #DC2626, #F59E0B, #10B981)'
                              : 'rgba(0, 61, 165, 0.15)',
                            color: isActive ? 'white' : 'var(--foreground)',
                            transform: isActive ? 'scale(1.1)' : 'scale(1)',
                          }}
                        >
                          {(idx + 1).toString().padStart(2, '0')}
                        </span>
                        <span className="transition-all duration-300 group-hover:translate-x-0.5">
                          {section.title}
                        </span>
                      </div>
                      <div
                        className="absolute bottom-0 left-0 h-[2px] transition-all duration-500 ease-out"
                        style={{
                          width: isActive ? '100%' : '0%',
                          background: 'linear-gradient(90deg, #DC2626, #F59E0B, #10B981)',
                          boxShadow: isActive ? '0 0 8px rgba(220, 38, 38, 0.4)' : 'none',
                          opacity: isActive ? 1 : 0,
                        }}
                      />
                      <div
                        className="absolute bottom-0 left-0 h-[1px] w-full transition-all duration-300"
                        style={{
                          background: 'rgba(0, 61, 165, 0.15)',
                          opacity: isActive ? 0 : 1,
                        }}
                      />
                    </a>
                  );
                })}
              </nav>
            </div>
          </aside>

          <div className="space-y-10">
            {DOC_SECTIONS.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-24 border-b pb-10"
                style={{ borderColor: "color-mix(in srgb, var(--border) 55%, transparent)" }}
              >
                <div className="flex flex-col gap-6">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-2xl"
                      style={{
                        background: "linear-gradient(135deg, rgba(0, 61, 165, 0.25), rgba(0, 61, 165, 0.05))",
                        color: "var(--foreground)",
                      }}
                    >
                      {section.icon}
                    </div>
                    <div>
                      <h2 className="text-2xl font-semibold" style={{ color: "var(--foreground)" }}>
                        {section.title}
                      </h2>
                      <p className="mt-1 text-sm text-muted">{section.summary}</p>
                    </div>
                  </div>

                  <div
                    data-animate
                    data-section-id={section.id}
                    className="rounded-3xl p-5 transition-all duration-500"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(220, 38, 38, 0.06), rgba(245, 158, 11, 0.05), rgba(16, 185, 129, 0.04), transparent 70%), linear-gradient(135deg, color-mix(in srgb, var(--surface) 90%, transparent), color-mix(in srgb, var(--card) 90%, transparent))",
                      border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                      opacity: visibleSections.has(section.id) || prefersReducedMotion ? 1 : 0,
                      transform: visibleSections.has(section.id) || prefersReducedMotion ? "translateY(0)" : "translateY(16px)",
                      transitionDelay: visibleSections.has(section.id) && !prefersReducedMotion ? "80ms" : "0ms",
                    }}
                  >
                    {section.featureCards ? (
                      <div className="grid gap-5 lg:grid-cols-2">
                        {section.featureCards.map((card) => (
                          <div
                            key={card.title}
                            className="overflow-hidden rounded-3xl border"
                            style={{ borderColor: "color-mix(in srgb, var(--border) 55%, transparent)" }}
                          >
                            <div className="relative aspect-[16/9] w-full overflow-hidden bg-[color:var(--surface-soft)]">
                              <Image
                                src={card.image}
                                alt={card.alt}
                                fill
                                sizes="(min-width: 1024px) 45vw, 100vw"
                                className="object-contain"
                              />
                            </div>
                            <div className="space-y-2 p-4">
                              <h3 className="text-base font-semibold" style={{ color: "var(--foreground)" }}>
                                {card.title}
                              </h3>
                              <p className="text-sm text-muted">{card.description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : section.stackCards ? (
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        {section.stackCards.map((card) => (
                          <div
                            key={card.title}
                            className="rounded-3xl border p-4"
                            style={{
                              borderColor: "color-mix(in srgb, var(--border) 55%, transparent)",
                              background: "color-mix(in srgb, var(--surface) 75%, transparent)",
                            }}
                          >
                            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: "rgba(0, 61, 165, 0.18)", color: "var(--foreground)" }}>
                              {card.icon}
                            </div>
                            <h3 className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                              {card.title}
                            </h3>
                            <p className="mt-1 text-xs text-muted">{card.description}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-2 text-sm text-muted">
                        {section.bullets.map((bullet) => (
                          <li key={bullet} className="flex items-start gap-2">
                            <span
                              className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                              style={{ background: "var(--line-blue)" }}
                            />
                            <span>{bullet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {section.note ? <p className="mt-4 text-xs text-muted">{section.note}</p> : null}
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
