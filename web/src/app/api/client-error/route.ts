import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const payload = await req.json().catch(() => null);
    // Log the payload to server logs so it's persisted by the hosting platform
    // and visible in monitoring/CloudWatch / App Runner logs.
    // Keep logs concise to avoid leaking sensitive data.
    console.error('[client-error-received]', typeof payload === 'object' ? JSON.stringify(payload) : String(payload));
  } catch (err) {
    console.error('[client-error-receive-failed]', String(err));
  }

  return new NextResponse(null, { status: 204 });
}
