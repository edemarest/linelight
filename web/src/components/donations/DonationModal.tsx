"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheckCircle, FiDollarSign, FiGift, FiHeart, FiMail, FiUser, FiX } from "react-icons/fi";
import { createDonationCheckout, fetchDonationConfig, type DonationConfig } from "@/lib/api";

const MIN_DONATION = 5;
const SUGGESTED_AMOUNTS = [5, 10, 25, 50, 100, 250, 1000];
const FIRST_NAME_STORAGE_KEY = "linelight-donation-first-name";
const LAST_NAME_STORAGE_KEY = "linelight-donation-last-name";
const EMAIL_STORAGE_KEY = "linelight-donation-email";
const NAME_PATTERN = /^[a-zA-Z.'\-\s]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type DonationModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

type FieldErrors = {
  firstName?: string;
  lastName?: string;
  email?: string;
  amount?: string;
};

const sanitizeInput = (value: string) => value.trim();
const getAmountAccent = (amount: number) => {
  if (amount >= 500) return "#f43f5e";
  if (amount >= 250) return "#a855f7";
  if (amount >= 100) return "#f59e0b";
  if (amount >= 50) return "#22c55e";
  if (amount >= 25) return "#38bdf8";
  return "#60a5fa";
};

export const DonationModal = ({ isOpen, onClose }: DonationModalProps) => {
  const [donationConfig, setDonationConfig] = useState<DonationConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [donorEmail, setDonorEmail] = useState("");
  const [donationAmount, setDonationAmount] = useState("10");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [donationStatus, setDonationStatus] = useState<"success" | "cancel" | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const lastNameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setConfigError(null);
    setStatusMessage(null);
    setDonationStatus(null);
    setErrors({});
    fetchDonationConfig()
      .then((config) => setDonationConfig(config))
      .catch((error) => {
        setDonationConfig(null);
        setConfigError(error instanceof Error ? error.message : "Donations unavailable right now.");
      });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const savedFirst = window.localStorage.getItem(FIRST_NAME_STORAGE_KEY);
    const savedLast = window.localStorage.getItem(LAST_NAME_STORAGE_KEY);
    const savedEmail = window.localStorage.getItem(EMAIL_STORAGE_KEY);
    if (savedFirst) setFirstName(savedFirst);
    if (savedLast) setLastName(savedLast);
    if (savedEmail) setDonorEmail(savedEmail);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("donation");
    if (status === "success") {
      setDonationStatus("success");
      setStatusMessage("Thank you for supporting LineLight.");
    } else if (status === "cancel") {
      setDonationStatus("cancel");
      setStatusMessage("Donation cancelled. You can try again anytime.");
    }
    if (status) {
      params.delete("donation");
      params.delete("session_id");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", next);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const showSuccessView = donationStatus === "success";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusMessage(null);
    setErrors({});

    const nextErrors: FieldErrors = {};
    const amount = Number(donationAmount);
    if (!Number.isFinite(amount) || amount < MIN_DONATION) {
      nextErrors.amount = `Minimum donation is $${MIN_DONATION}.`;
    }

    const email = sanitizeInput(donorEmail);
    if (!email) {
      nextErrors.email = "Email is required.";
    } else if (!EMAIL_PATTERN.test(email)) {
      nextErrors.email = "Enter a valid email address.";
    }

    const safeFirst = sanitizeInput(firstName);
    const safeLast = sanitizeInput(lastName);
    if (safeFirst && !NAME_PATTERN.test(safeFirst)) {
      nextErrors.firstName = "Use letters, spaces, hyphens, or apostrophes.";
    }
    if (safeLast && !NAME_PATTERN.test(safeLast)) {
      nextErrors.lastName = "Use letters, spaces, hyphens, or apostrophes.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    if (!donationConfig?.enabled) {
      setStatusMessage("Donations are unavailable right now.");
      return;
    }

    setIsSubmitting(true);
    try {
      const name = [safeFirst, safeLast].filter(Boolean).join(" ").trim();
      window.localStorage.setItem(FIRST_NAME_STORAGE_KEY, safeFirst);
      window.localStorage.setItem(LAST_NAME_STORAGE_KEY, safeLast);
      window.localStorage.setItem(EMAIL_STORAGE_KEY, email);

      const result = await createDonationCheckout({
        amount,
        name: name || undefined,
        email,
      });
      if (!result.checkoutUrl) {
        throw new Error("Checkout unavailable.");
      }
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Donation failed. Please try again.";
      const friendly = raw.toLowerCase().includes("failed to fetch")
        ? "Donation service unavailable right now."
        : raw;
      setDonationStatus("cancel");
      setStatusMessage(friendly);
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="donation-modal fixed inset-0 z-60 flex items-start justify-center overflow-y-auto px-4 pb-8 pt-6 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close donation modal"
        className="donation-modal__backdrop absolute inset-0 cursor-default bg-black/70"
        onClick={onClose}
      />
      <form
        className="donation-modal__panel relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/95 p-6 text-sm text-slate-100 shadow-2xl sm:p-7"
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white">
              {showSuccessView ? <FiGift /> : <FiHeart />}
            </span>
            <div>
              <h3 className="text-lg font-semibold text-white">
                {showSuccessView ? "Thanks for supporting." : "Support LineLight"}
              </h3>
              <p className="text-sm text-slate-300">
                {showSuccessView ? "Your support keeps LineLight running." : "Keep LineLight running."}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="icon-button text-slate-300"
            aria-label="Close"
            data-interactive="icon"
            onClick={onClose}
          >
            <FiX size={18} />
          </button>
        </div>

        {showSuccessView ? (
          <div className="mt-6 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-400/10 text-emerald-200">
              <FiCheckCircle size={28} />
            </div>
            <p className="mt-4 text-base text-emerald-100">Thank you for supporting LineLight.</p>
            <p className="mt-1 text-sm text-slate-300">Your support helps keep this project running.</p>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <a href="/donors" className="donation-action donation-action--secondary text-center">
                Donation board
              </a>
              <button
                type="button"
                className="donation-action donation-action--ember"
                onClick={() => {
                  setDonationStatus(null);
                  setStatusMessage(null);
                }}
              >
                Donate more
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-3">
              <label className="grid gap-1 text-xs text-slate-300">
                <span className="inline-flex items-center gap-2">
                  Name
                  <span className="text-[11px] font-normal text-slate-400">
                    Listed as Anonymous if left blank.
                  </span>
                </span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                    <FiUser className="text-slate-400" />
                    <input
                      className="w-full bg-transparent text-sm text-white focus:outline-none"
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          lastNameRef.current?.focus();
                        }
                      }}
                      placeholder="First name"
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                    <FiUser className="text-slate-400" />
                    <input
                      ref={lastNameRef}
                      className="w-full bg-transparent text-sm text-white focus:outline-none"
                      value={lastName}
                      onChange={(event) => setLastName(event.target.value)}
                      placeholder="Last name"
                      autoComplete="family-name"
                    />
                  </div>
                </div>
              </label>
              {(errors.firstName || errors.lastName) && (
                <p className="text-xs text-rose-300">{errors.firstName ?? errors.lastName}</p>
              )}
              <label className="grid gap-1 text-xs text-slate-300">
                <span className="inline-flex items-center gap-1">
                  Email <span className="text-rose-300">*</span>
                </span>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                  <FiMail className="text-slate-400" />
                  <input
                    type="email"
                    required
                    className="w-full bg-transparent text-sm text-white focus:outline-none"
                    value={donorEmail}
                    onChange={(event) => setDonorEmail(event.target.value)}
                    placeholder="you@email.com"
                    autoComplete="email"
                  />
                </div>
              </label>
              {errors.email && <p className="text-xs text-rose-300">{errors.email}</p>}
              <label className="grid gap-1 text-xs text-slate-300">
                <span className="inline-flex items-center gap-1">
                  Amount <span className="text-rose-300">*</span>
                </span>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                  <FiDollarSign className="text-slate-400" />
                  <input
                    type="number"
                    min={MIN_DONATION}
                    step="0.01"
                    inputMode="decimal"
                    className="w-full bg-transparent text-sm text-white focus:outline-none"
                    value={donationAmount}
                    onChange={(event) => setDonationAmount(event.target.value)}
                    placeholder="10.00"
                  />
                </div>
              </label>
              {errors.amount && <p className="text-xs text-rose-300">{errors.amount}</p>}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTED_AMOUNTS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`donation-suggested rounded-full border px-3 py-1 text-xs transition ${
                    Number(donationAmount) === amount
                      ? "donation-suggested--active border-transparent text-white"
                      : "border-white/10 text-slate-200"
                  }`}
                  onClick={() => setDonationAmount(String(amount))}
                  style={
                    Number(donationAmount) === amount
                      ? { backgroundColor: getAmountAccent(amount) }
                      : undefined
                  }
                >
                  ${amount}
                </button>
              ))}
            </div>

            {configError && <p className="mt-3 text-xs text-rose-300">Donations are unavailable right now.</p>}

            {statusMessage && (
              <div className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-500/30 px-3 py-2 text-xs text-rose-200">
                <span>{statusMessage}</span>
              </div>
            )}

            <div className="mt-6">
              <button
                type="submit"
                className="donation-action donation-action--primary w-full text-lg"
                style={{ background: "var(--gradient-brand)" }}
                disabled={isSubmitting || !donationConfig?.enabled}
              >
                {isSubmitting ? "Redirecting…" : "Donate"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
};
