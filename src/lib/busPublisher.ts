export interface BusEvent {
  type: string;
  timestamp: string;
  source: string;
  payload: any;
  evidence_hash: string;
}

export async function publishToBus(event: BusEvent, env: any): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!env.BUS_WEBHOOK_URL) {
    return { success: false, error: 'BUS_WEBHOOK_URL not configured - local mode' };
  }

  try {
    const jwt = await generateJWT(env.PROXY_JWT_SECRET || 'dev-secret', {
      sub: 'rea-worker',
      aud: 'sahiixx-bus',
      exp: Math.floor(Date.now() / 1000) + 300
    });

    const res = await fetch(env.BUS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'X-REA-Event': event.type
      },
      body: JSON.stringify(event)
    });

    if (!res.ok) throw new Error(`Bus ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return { success: true, id: data.id || data.event_id };
  } catch (e: any) {
    if (env.REA_QUEUE) {
      try {
        await env.REA_QUEUE.send(event);
        return { success: true, id: 'queued' };
      } catch {
        // ignore queue fallback failure
      }
    }
    return { success: false, error: e?.message || 'unknown bus error' };
  }
}

async function generateJWT(secret: string, payload: any): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const hB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const pB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${hB64}.${pB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${sigB64}`;
}
