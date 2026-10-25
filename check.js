// Runs on GitHub Actions. Checks prices (PHP), confirms saved alerts, and sends Discord messages.
const fs = require('fs');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const php = n => '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
const target = a => a.type === 'pct' ? a.ref * (1 + (a.dir === 'above' ? 1 : -1) * a.value / 100) : a.ref * (1 - a.value / 100);
const desc = a => a.type === 'price' ? `${a.coin} ${a.dir} ${php(a.value)}`
  : a.type === 'pct' ? `${a.coin} ${a.dir === 'above' ? '+' : '−'}${a.value}% from ${php(a.ref)} (${php(target(a))})`
  : `${a.coin} trailing stop ${a.value}% (starts at ${php(target(a))})`;

async function getPrices() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=php');
    if (!r.ok) throw new Error('CoinGecko ' + r.status);
    const p = await r.json();
    return { BTC: p.bitcoin.php, ETH: p.ethereum.php };
  } catch (e) {
    console.log('CoinGecko failed (' + e.message + '), trying Coinbase');
    const out = {};
    for (const c of ['BTC', 'ETH']) {
      const r = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=' + c);
      out[c] = +(await r.json()).data.rates.PHP;
    }
    return out;
  }
}

(async () => {
  const alerts = read('alerts.json', []);
  const state = read('state.json', {});
  const event = process.env.GITHUB_EVENT_NAME || '';
  const hook = process.env.DISCORD_WEBHOOK;
  const price = await getPrices();
  const msgs = [];

  // 1. Confirmations: new and removed alerts
  const known = state.__known || {}, nowKnown = {};
  for (const a of alerts) {
    nowKnown[a.id] = desc(a);
    if (!known[a.id]) msgs.push(`✅ Alert saved: ${desc(a)}${a.note ? ' — ' + a.note : ''}`);
  }
  for (const id in known) if (!nowKnown[id]) msgs.push(`🗑️ Alert removed: ${known[id]}`);
  state.__known = nowKnown;

  // 2. Check each active alert
  for (const a of alerts) {
    if (!a.active) continue;
    const s = state[a.id] || (state[a.id] = { high: a.ref || price[a.coin] });
    if (s.fired) continue;
    const now = price[a.coin];
    s.high = Math.max(s.high, now); // trailing peak keeps rising
    let hit = false, text = '';
    if (a.type === 'price') {
      hit = a.dir === 'above' ? now >= a.value : now <= a.value;
      text = `${a.coin} is ${a.dir} your price ${php(a.value)}`;
    } else if (a.type === 'pct') {
      const t = target(a);
      hit = a.dir === 'above' ? now >= t : now <= t;
      text = `${a.coin} moved ${a.value}% ${a.dir === 'above' ? 'up' : 'down'} from ${php(a.ref)} (target ${php(t)})`;
    } else if (a.type === 'trail') {
      const line = s.high * (1 - a.value / 100);
      hit = now <= line;
      text = `${a.coin} fell ${a.value}% from its peak ${php(s.high)} (stop line ${php(line)})`;
    }
    if (hit) { s.fired = true; msgs.push(`🔔 ${text}. Now: ${php(now)}${a.note ? ' — ' + a.note : ''}`); }
  }

  // 3. Status message when you save alerts or press "Run workflow"
  if (event === 'workflow_dispatch' || event === 'push') {
    const active = alerts.filter(a => a.active && !(state[a.id] && state[a.id].fired)).length;
    msgs.unshift(`👍 Alert checker is working. BTC ${php(price.BTC)}, ETH ${php(price.ETH)}. ${active} active alert(s).`);
  }

  fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
  console.log(msgs.length ? msgs.join('\n') : 'No alerts triggered.', price);

  if (msgs.length) {
    if (!hook) { console.error('DISCORD_WEBHOOK secret is not set, so nothing was sent to Discord.'); process.exitCode = 1; return; }
    const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msgs.join('\n').slice(0, 1900) }) });
    if (!res.ok) { console.error('Discord rejected the message: ' + res.status + ' ' + await res.text()); process.exitCode = 1; }
  }
})().catch(e => { console.error(e); process.exit(1); });
