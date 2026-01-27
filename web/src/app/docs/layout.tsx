import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation - LinesLight",
  description: "Technical documentation for LinesLight: system architecture, MBTA integration, trip planning, and deployment.",
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
