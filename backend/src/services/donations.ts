import Stripe from "stripe";
import { upsertDonation } from "../db";
import { logger } from "../utils/logger";

const STRIPE_MODE = (process.env.STRIPE_MODE ??
  (process.env.NODE_ENV === "production" ? "live" : "test")) as "test" | "live";

const STRIPE_LIVE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_TEST_SECRET = process.env.STRIPE_TEST_SECRET_KEY;
const STRIPE_LIVE_PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_TEST_PUBLISHABLE = process.env.STRIPE_TEST_PUBLISHABLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_CHECKOUT_WEBHOOK_SIGNING_SECRET;

const getStripeSecretKey = (): string | null => {
  if (STRIPE_MODE === "live") return STRIPE_LIVE_SECRET ?? null;
  return STRIPE_TEST_SECRET ?? null;
};

const getStripePublishableKey = (): string | null => {
  if (STRIPE_MODE === "live") return STRIPE_LIVE_PUBLISHABLE ?? null;
  return STRIPE_TEST_PUBLISHABLE ?? null;
};

let stripeClient: Stripe | null = null;
const getStripeClient = (): Stripe => {
  if (stripeClient) return stripeClient;
  const secret = getStripeSecretKey();
  if (!secret) {
    throw new Error("Stripe secret key not configured");
  }
  stripeClient = new Stripe(secret, { apiVersion: "2023-10-16" });
  return stripeClient;
};

const sanitizeString = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeStatus = (value?: string | null): string => {
  if (!value) return "unknown";
  return value.toLowerCase();
};

const normalizeAmountCents = (amount: number): number => {
  if (!Number.isFinite(amount)) {
    throw new Error("Invalid donation amount");
  }
  const normalized = Math.round(amount * 100);
  if (normalized < 500) {
    throw new Error("Minimum donation is $5");
  }
  return normalized;
};

export const getDonationConfig = () => {
  const publishableKey = getStripePublishableKey();
  if (!publishableKey) {
    return { enabled: false, mode: STRIPE_MODE };
  }
  return { enabled: true, mode: STRIPE_MODE, publishableKey };
};

export const createDonationCheckout = async (params: {
  amount: number;
  name?: string | null;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
  requestId?: string;
}) => {
  const stripe = getStripeClient();
  const amountCents = normalizeAmountCents(params.amount);
  const name = sanitizeString(params.name);
  const email = sanitizeString(params.email);
  if (!email) {
    throw new Error("Email is required");
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      submit_type: "donate",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: "LineLight donation",
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${params.successUrl}?donation=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${params.cancelUrl}?donation=cancel`,
      customer_email: email,
      ...(params.requestId ? { client_reference_id: params.requestId } : {}),
      metadata: {
        donor_name: name ?? "",
        donor_email: email ?? "",
        amount_cents: String(amountCents),
      },
    },
    params.requestId ? { idempotencyKey: params.requestId } : undefined,
  );

  try {
    await upsertDonation({
      sessionId: session.id,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      status: normalizeStatus(session.status ?? "open"),
      amountCents,
      currency: session.currency ?? "usd",
      donorName: name,
      donorEmail: email,
      livemode: Boolean(session.livemode),
      metadata: session.metadata ?? null,
    });
  } catch (error) {
    logger.warn("Failed to store donation session", { message: String(error), sessionId: session.id });
  }

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
    amountCents,
  };
};

export const constructStripeEvent = (rawBody: Buffer, signature?: string | null): Stripe.Event => {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("Stripe webhook signing secret not configured");
  }
  if (!signature) {
    throw new Error("Stripe signature missing");
  }
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
};

const extractDonationFromSession = (session: Stripe.Checkout.Session) => {
  const amount = session.amount_total ?? 0;
  const currency = session.currency ?? "usd";
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const donorName =
    sanitizeString(session.metadata?.donor_name as string | undefined) ??
    sanitizeString(session.customer_details?.name);
  const donorEmail =
    sanitizeString(session.metadata?.donor_email as string | undefined) ??
    sanitizeString(session.customer_details?.email);

  return {
    sessionId: session.id,
    paymentIntentId,
    status: normalizeStatus(session.status ?? session.payment_status ?? "unknown"),
    amountCents: amount,
    currency,
    donorName,
    donorEmail,
    livemode: Boolean(session.livemode),
    metadata: session.metadata ?? null,
  };
};

export const handleStripeWebhookEvent = async (event: Stripe.Event): Promise<void> => {
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const donation = extractDonationFromSession(session);
    await upsertDonation(donation);
    logger.info("Stripe donation recorded", {
      sessionId: donation.sessionId,
      status: donation.status,
      amountCents: donation.amountCents,
    });
    return;
  }
  logger.debug("Stripe webhook ignored", { type: event.type });
};
