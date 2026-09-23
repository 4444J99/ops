import { Env } from './src/types';
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await env.UCC_PRODUCTION.fetch("http://localhost/internal/test-run-scheduled-step", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({ scheduledTime: Date.now() })
    });
    const text = await res.text();
    return new Response(text, { status: res.status });
  }
}
