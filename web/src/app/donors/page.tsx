import Link from "next/link";
import { FiArrowUpRight, FiAward, FiHeart, FiStar, FiTrendingUp } from "react-icons/fi";

import { fetchDonationBoard, type DonationBoardEntry } from "@/lib/api";

const formatCurrency = (amount: number, currency: string) => {
  const normalized = currency?.toUpperCase() === "USD" ? "USD" : currency?.toUpperCase() ?? "USD";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: normalized }).format(amount);
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const getDisplayName = (name: string) => (name?.trim() ? name.trim() : "Anon");

const getAccentColor = (amount: number) => {
  if (amount >= 500) return "#f43f5e";
  if (amount >= 250) return "#a855f7";
  if (amount >= 100) return "#f59e0b";
  if (amount >= 50) return "#22c55e";
  if (amount >= 25) return "#38bdf8";
  return "#60a5fa";
};

const renderEntry = (entry: DonationBoardEntry, index: number, showRank = true) => {
  const accent = getAccentColor(entry.amount);
  const zebra = index % 2 === 0 ? "color-mix(in srgb, var(--card) 92%, transparent)" : "color-mix(in srgb, var(--card) 84%, transparent)";
  return (
    <div
      key={`${entry.createdAt}-${index}`}
      className="flex items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-sm"
      style={{ borderColor: "var(--border)", background: zebra, boxShadow: `inset 3px 0 0 ${accent}` }}
    >
      <div className="flex items-center gap-3">
        {showRank ? (
          <span
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-xs font-semibold text-slate-200"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            {index < 3 ? <FiAward size={14} style={{ color: accent }} /> : index + 1}
          </span>
        ) : null}
        <div>
          <p className="text-base font-semibold text-white">{getDisplayName(entry.name)}</p>
          <p className="text-xs text-slate-400">{formatDate(entry.createdAt)}</p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-base font-semibold" style={{ color: accent }}>
          {formatCurrency(entry.amount, entry.currency)}
        </p>
      </div>
    </div>
  );
};

export default async function DonorsPage() {
  let board: { top: DonationBoardEntry[]; recent: DonationBoardEntry[]; updatedAt: string; summary?: { supporterCount: number; totalAmountCents: number } } | null = null;
  let hasError = false;

  try {
    board = await fetchDonationBoard(18);
  } catch {
    hasError = true;
  }

  const top = board?.top ?? [];
  const recent = board?.recent ?? [];
  const supporterCount = board?.summary?.supporterCount ?? 0;
  const totalAmount = board?.summary?.totalAmountCents ? board.summary.totalAmountCents / 100 : 0;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="rounded-3xl border bg-[color:var(--card)] p-6 shadow-2xl sm:p-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white">
              <FiHeart size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-semibold text-white">Donation board</h1>
              <p className="text-sm text-slate-300">
                A small thank-you wall for everyone keeping LineLight running.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 text-sm text-slate-300">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Why this exists</p>
              <div className="mt-3 h-px w-full bg-white/10" />
              <p className="mt-3 text-sm text-slate-300">
                LineLight is built and maintained by a solo developer. Your support helps cover the
                tools, data, and hosting that keep it fast and available.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">How donations help</p>
              <div className="mt-3 h-px w-full bg-white/10" />
              <p className="mt-3 text-sm text-slate-300">
                Donations keep the APIs responsive, fund new features, and help deliver reliable
                service updates for Boston riders.
              </p>
            </div>
          </div>

          <Link
            href="/donors?donation=open"
            className="donation-action donation-action--primary mt-6 w-full text-center"
            style={{ background: "var(--gradient-brand)" }}
          >
            <span className="flex items-center justify-center gap-2">
              Support LineLight
              <FiArrowUpRight />
            </span>
          </Link>
        </section>

        <section className="rounded-3xl border bg-[color:var(--card)] p-6 shadow-2xl sm:p-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-white">
                <FiStar />
                <h2 className="text-lg font-semibold">Top supporters</h2>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                Highest contributions so far.
              </p>
            </div>
            {board?.updatedAt && (
              <span className="text-xs text-slate-500">Updated {formatDate(board.updatedAt)}</span>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-3">
            {top.length > 0 ? (
              top.slice(0, 8).map((entry, index) => renderEntry(entry, index, true))
            ) : (
              <div className="rounded-2xl border border-white/10 px-4 py-6 text-sm text-slate-300">
                {hasError ? "Donation board is unavailable right now." : "Be the first supporter."}
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Supporters</p>
              <p className="mt-2 text-2xl font-semibold text-white">{supporterCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Total raised</p>
              <p className="mt-2 text-2xl font-semibold text-emerald-200">
                {formatCurrency(totalAmount, "usd")}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-center gap-2 text-white">
              <FiTrendingUp />
              <h3 className="text-lg font-semibold">Recent supporters</h3>
            </div>
            <p className="mt-1 text-sm text-slate-400">Most recent donations and shout-outs.</p>
            <div className="mt-4 flex flex-col gap-3">
              {recent.length > 0 ? (
                recent.slice(0, 8).map((entry, index) => renderEntry(entry, index, false))
              ) : (
                <div className="rounded-2xl border border-white/10 px-4 py-6 text-sm text-slate-300">
                  {hasError ? "Donation board is unavailable right now." : "No recent donations yet."}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
