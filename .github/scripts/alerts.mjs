// Karat price alerts: run on a schedule by .github/workflows/price-alerts.yml.
// Reads the setup code from the KARAT_PUSH_CONFIG secret (made in the app under Notifications),
// checks gold-api.com spot prices, and sends Web Push notifications to the phone.
// State between runs (what was already sent) lives in KARAT_STATE_DIR, kept by actions/cache.
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OZ_G = 31.1035;
const API = process.env.KARAT_PRICE_API || 'https://api.gold-api.com/price/';
const STATE_DIR = process.env.KARAT_STATE_DIR || '.karat-state';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const NOW = process.env.KARAT_NOW ? new Date(process.env.KARAT_NOW) : new Date();
const TEST = process.env.KARAT_TEST === 'true';
const REARM = 0.005; // a target re-arms after the price moves 0.5% back past it
const METALS = { gold: { name: 'Gold', symbol: 'XAU' }, silver: { name: 'Silver', symbol: 'XAG' } };

function log(...a) { console.log(...a); }
function fail(msg) { console.error('::error::' + msg); process.exitCode = 1; }

function readConfig() {
  const raw = (process.env.KARAT_PUSH_CONFIG || '').trim();
  if (!raw) return null;
  const json = raw.startsWith('{') ? raw : Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const c = JSON.parse(json);
  if (c.v !== 1 || !c.sub || !c.sub.endpoint || !c.sub.keys || !c.vapid || !c.vapid.publicKey || !c.vapid.privateKey) {
    throw new Error('The setup code is incomplete. Copy it again from the app.');
  }
  return c;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function fetchPrice(symbol) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + symbol, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const price = Number(data && data.price);
      if (!(price > 0)) throw new Error('no price in response');
      return price;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`Could not get the ${symbol} price: ${lastErr && lastErr.message}`);
}

const usd = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v >= 0 ? '\u25B2 ' : '\u25BC ') + Math.abs(v).toFixed(2) + '%';

function localParts(tz) {
  const zone = tz || 'UTC';
  let date, time;
  try {
    date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);
    time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(NOW);
  } catch {
    return localParts('UTC');
  }
  return { date, time: time.replace(/^24/, '00') };
}

function targetValue(t, spot) {
  const perOz = spot * (Number(t.f) || 1);
  return t.u === 'g' ? perOz / OZ_G : perOz;
}
function targetLabel(t) {
  return `${METALS[t.m].name} ${t.k}`;
}

async function main() {
  let config;
  try { config = readConfig(); } catch {
    // Don't echo parser messages: they can quote part of the secret into the public log.
    fail('KARAT_PUSH_CONFIG could not be read. Copy the setup code again from the app and paste the whole code into the secret.');
    return;
  }
  if (!config) {
    log('KARAT_PUSH_CONFIG is not set yet. Turn on notifications in the app and add the setup code as a repository secret.');
    writeState(readState());
    return;
  }

  const state = readState();
  state.targets = state.targets || {};
  state.moves = state.moves || {};
  state.ref = state.ref || {};
  state.last = state.last || {};

  const prices = {};
  for (const m of Object.keys(METALS)) prices[m] = await fetchPrice(METALS[m].symbol);

  const { date, time } = localParts(config.tz);
  const messages = [];

  // Reference price for the day = the last price seen before local midnight (≈ previous close).
  for (const m of Object.keys(METALS)) {
    if (!state.ref[m] || state.ref[m].date !== date) {
      state.ref[m] = { date, price: state.last[m] ? state.last[m].price : prices[m] };
    }
  }
  const change = (m) => (prices[m] - state.ref[m].price) / state.ref[m].price * 100;

  const targets = Array.isArray(config.targets) ? config.targets.filter((t) => METALS[t.m] && Number(t.p) > 0) : [];
  const hash = createHash('sha256').update(JSON.stringify([config.sub.endpoint, targets, config.moves, config.summary, config.tz])).digest('hex');
  if (state.configHash !== hash) {
    state.configHash = hash;
    state.targets = {};
    const parts = [];
    if (targets.length) parts.push(`${targets.length} price target${targets.length > 1 ? 's' : ''}`);
    if (config.moves && config.moves.on) parts.push(`moves over ${config.moves.pct}%`);
    if (config.summary && config.summary.on) parts.push(`a daily summary at ${config.summary.time}`);
    messages.push({
      title: 'Karat alerts are on',
      body: parts.length ? `Watching ${parts.join(', ')}.` : 'Notifications are set up. Add alerts in the app.',
      tag: 'karat-setup'
    });
  }

  if (TEST) {
    messages.push({
      title: 'Karat test notification',
      body: `Gold ${usd(prices.gold)} \u00b7 Silver ${usd(prices.silver)} per ounce`,
      tag: 'karat-test'
    });
  }

  // Price targets: fire on crossing, re-arm once the price moves back past the target.
  for (const t of targets) {
    const id = t.id || `${t.m}-${t.k}-${t.d}-${t.p}-${t.u}`;
    const s = state.targets[id] || { armed: true };
    const value = targetValue(t, prices[t.m]);
    const target = Number(t.p);
    const hit = t.d === 'below' ? value <= target : value >= target;
    if (s.armed && hit) {
      messages.push({
        title: `${targetLabel(t)} is ${t.d} ${usd(target)}/${t.u}`,
        body: `Now ${usd(value)} per ${t.u === 'g' ? 'gram' : 'ounce'} (spot ${usd(prices[t.m])}/oz).`,
        tag: 'karat-target-' + id
      });
      s.armed = false;
    } else if (!s.armed) {
      const back = t.d === 'below' ? value > target * (1 + REARM) : value < target * (1 - REARM);
      if (back) s.armed = true;
    }
    state.targets[id] = s;
  }

  // Big moves: once per metal per direction per local day.
  if (config.moves && config.moves.on && Number(config.moves.pct) > 0) {
    for (const m of Object.keys(METALS)) {
      const c = change(m);
      const dir = c >= 0 ? 'up' : 'down';
      const key = `${m}-${dir}`;
      if (Math.abs(c) >= Number(config.moves.pct) && state.moves[key] !== date) {
        state.moves[key] = date;
        messages.push({
          title: `${METALS[m].name} ${c >= 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(1)}% today`,
          body: `${METALS[m].name} is ${usd(prices[m])}/oz, ${pct(c)} since yesterday's close.`,
          tag: 'karat-move-' + key
        });
      }
    }
  }

  // Daily summary at the chosen local time (sent on the first run at or after it).
  if (config.summary && config.summary.on && /^\d\d:\d\d$/.test(config.summary.time || '')) {
    if (time >= config.summary.time && state.summaryDate !== date) {
      state.summaryDate = date;
      messages.push({
        title: 'Karat daily summary',
        body: `Gold ${usd(prices.gold)} ${pct(change('gold'))} \u00b7 Silver ${usd(prices.silver)} ${pct(change('silver'))}`,
        tag: 'karat-summary'
      });
    }
  }

  for (const m of Object.keys(METALS)) state.last[m] = { price: prices[m], at: NOW.toISOString() };

  // Logs of public repositories are public: never log alert contents, only counts.
  const subject = process.env.KARAT_VAPID_SUBJECT || config.subject || 'https://github.com/';
  let sent = 0;
  for (const msg of messages.slice(0, 6)) {
    try {
      await webpush.sendNotification(config.sub, JSON.stringify({ ...msg, url: './' }), {
        vapidDetails: { subject, publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey },
        TTL: 6 * 3600,
        urgency: 'high'
      });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        fail('The phone\u2019s push subscription has expired. Open Karat, turn notifications off and on, and update the KARAT_PUSH_CONFIG secret with the new setup code.');
        break;
      }
      fail(`Sending a notification failed: HTTP ${e.statusCode || '?'}`);
    }
  }
  log(`Sent ${sent} notification${sent === 1 ? '' : 's'}.`);
  writeState(state);
}

main().catch((e) => fail(e.message));
