/**
 * Preflight check for CallMe.
 *
 * Validates every credential against the live upstream service BEFORE you burn a
 * phone call debugging a typo. Run from the `server/` directory:
 *
 *   bun run scripts/preflight.ts
 *
 * Exits 0 if everything needed to place a call is working, 1 otherwise.
 */
import WebSocket from 'ws';
import ngrok from '@ngrok/ngrok';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

const env = (k: string) => process.env[k]?.trim() || '';

// ---------------------------------------------------------------- required vars
const REQUIRED = [
  'CALLME_PHONE_PROVIDER',
  'CALLME_PHONE_ACCOUNT_SID',
  'CALLME_PHONE_AUTH_TOKEN',
  'CALLME_PHONE_NUMBER',
  'CALLME_USER_PHONE_NUMBER',
  'CALLME_OPENAI_API_KEY',
  'CALLME_NGROK_AUTHTOKEN',
];

const missing = REQUIRED.filter((k) => !env(k));
add('Required variables present', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `all ${REQUIRED.length} set`);

// CALLME_PHONE_PROVIDER defaults to 'telnyx' in code, which silently breaks a
// Twilio setup, so treat an unset/incorrect value as a hard failure.
const provider = env('CALLME_PHONE_PROVIDER').toLowerCase();
add('Phone provider explicitly set', provider === 'twilio' || provider === 'telnyx',
  provider ? `provider=${provider}` : "unset -> code defaults to 'telnyx', which is probably not what you want");

for (const k of ['CALLME_PHONE_NUMBER', 'CALLME_USER_PHONE_NUMBER']) {
  const v = env(k);
  if (v) add(`${k} is E.164`, /^\+[1-9]\d{6,14}$/.test(v), v ? `value=${v}` : 'unset');
}

// ---------------------------------------------------------------------- Twilio
if (provider === 'twilio' && env('CALLME_PHONE_ACCOUNT_SID') && env('CALLME_PHONE_AUTH_TOKEN')) {
  const sid = env('CALLME_PHONE_ACCOUNT_SID');
  const auth = Buffer.from(`${sid}:${env('CALLME_PHONE_AUTH_TOKEN')}`).toString('base64');
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const body: any = await r.json().catch(() => ({}));
    add('Twilio credentials valid', r.ok,
      r.ok ? `account "${body.friendly_name}", status=${body.status}, type=${body.type}` : `HTTP ${r.status}`);
    if (r.ok && String(body.type).toLowerCase() === 'trial') {
      add('Twilio account is full (not trial)', false,
        'TRIAL: the destination number must be verified, and every call plays a "press any key" gate first');
    }

    // Is the from-number actually owned and voice capable?
    const num = env('CALLME_PHONE_NUMBER');
    if (r.ok && num) {
      const nr = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(num)}`,
        { headers: { Authorization: `Basic ${auth}` } });
      const nb: any = await nr.json().catch(() => ({}));
      const found = nb?.incoming_phone_numbers?.[0];
      add('Twilio from-number owned + voice capable', Boolean(found?.capabilities?.voice),
        found ? `${found.phone_number} voice=${found.capabilities?.voice}` : `${num} not found on this account`);
    }
  } catch (e) {
    add('Twilio credentials valid', false, String(e).slice(0, 120));
  }
}

// ---------------------------------------------------------------------- Telnyx
// Telnyx reuses the generic variable names for different values:
// CALLME_PHONE_AUTH_TOKEN is an API key, CALLME_PHONE_ACCOUNT_SID is a Connection ID.
if (provider === 'telnyx' && env('CALLME_PHONE_AUTH_TOKEN')) {
  const headers = { Authorization: `Bearer ${env('CALLME_PHONE_AUTH_TOKEN')}` };
  try {
    const r = await fetch('https://api.telnyx.com/v2/phone_numbers?page[size]=1', { headers });
    add('Telnyx API key valid', r.ok,
      r.ok ? 'authenticated' : `HTTP ${r.status} — is CALLME_PHONE_AUTH_TOKEN a KEY... API key?`);

    const connectionId = env('CALLME_PHONE_ACCOUNT_SID');
    if (r.ok && connectionId) {
      const cr = await fetch(
        `https://api.telnyx.com/v2/call_control_applications/${encodeURIComponent(connectionId)}`, { headers });
      const cb: any = await cr.json().catch(() => ({}));
      add('Telnyx Call Control connection', cr.ok,
        cr.ok ? `application "${cb?.data?.application_name}"`
              : `HTTP ${cr.status} — CALLME_PHONE_ACCOUNT_SID must be the Connection ID of a Call Control App`);
    }

    const num = env('CALLME_PHONE_NUMBER');
    if (r.ok && num) {
      const nr = await fetch(
        `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(num)}`, { headers });
      const nb: any = await nr.json().catch(() => ({}));
      const found = nb?.data?.[0];
      add('Telnyx from-number owned + assigned', Boolean(found?.connection_id),
        found ? `${found.phone_number} connection_id=${found.connection_id || 'UNASSIGNED'}`
              : `${num} not found on this account`);
    }
  } catch (e) {
    add('Telnyx API key valid', false, String(e).slice(0, 120));
  }

  if (!env('CALLME_TELNYX_PUBLIC_KEY')) {
    add('Telnyx webhook signature verification', false,
      'CALLME_TELNYX_PUBLIC_KEY unset — server will skip verification (recommended, not blocking)');
  }
}

// ------------------------------------------------------- OpenAI Realtime (GA)
if (env('CALLME_OPENAI_API_KEY')) {
  const key = env('CALLME_OPENAI_API_KEY');
  const model = env('CALLME_STT_MODEL') || 'gpt-4o-transcribe';
  const result = await new Promise<Check>((resolve) => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const done = (ok: boolean, detail: string) => { try { ws.close(); } catch {} resolve({ name: 'OpenAI Realtime transcription session', ok, detail }); };
    const timer = setTimeout(() => done(false, 'timed out after 15s'), 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { format: { type: 'audio/pcmu' }, transcription: { model },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1500 } } },
        },
      }));
    });
    ws.on('message', (d: Buffer) => {
      const e = JSON.parse(d.toString());
      if (e.type === 'session.updated') { clearTimeout(timer); done(true, `GA session accepted, model=${model}`); }
      if (e.type === 'error') { clearTimeout(timer); done(false, e.error?.message || JSON.stringify(e.error)); }
    });
    ws.on('error', (e) => { clearTimeout(timer); done(false, String(e).slice(0, 120)); });
    ws.on('close', (code) => { if (code === 4000) { clearTimeout(timer); done(false, 'closed 4000 — stale beta API shape'); } });
  });
  checks.push(result);
}

// ------------------------------------------------------------------------ ngrok
if (env('CALLME_NGROK_AUTHTOKEN')) {
  try {
    const listener = await ngrok.forward({ addr: 8099, authtoken: env('CALLME_NGROK_AUTHTOKEN') });
    add('ngrok tunnel', true, `established ${listener.url()}`);
    await listener.close();
  } catch (e) {
    const msg = String(e);
    add('ngrok tunnel', false, msg.includes('ERR_NGROK_108')
      ? 'ERR_NGROK_108: free plan allows 3 simultaneous tunnels — close other Claude Code sessions'
      : msg.slice(0, 160));
  }
}

// ----------------------------------------------------------------------- report
const pad = Math.max(...checks.map((c) => c.name.length));
console.log('\nCallMe preflight\n' + '='.repeat(pad + 12));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(pad)}  ${c.detail}`);

// Advisories are reported but do not block a call from working.
const ADVISORY = ['Twilio account is full', 'Telnyx webhook signature verification'];
const hard = checks.filter((c) => !c.ok && !ADVISORY.some((a) => c.name.startsWith(a)));
console.log('='.repeat(pad + 12));
if (hard.length === 0) {
  console.log('Ready. Restart Claude Code if you just edited settings.json, then ask it to call you.\n');
  process.exit(0);
}
console.log(`${hard.length} blocking issue(s). Fix these before placing a call.\n`);
process.exit(1);
