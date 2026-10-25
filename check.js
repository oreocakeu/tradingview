// Runs on GitHub Actions. Checks prices (PHP) and sends Discord messages.
const fs = require('fs');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const php = n => '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });

(async () => {
  const alerts = read('alerts.json', []);
  const state = read('state.json', {});
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=php');
  if (!r.ok) throw new Error('Price fetch failed: ' + r.status);
  const p = await r.json();
  const price = { BTC: p.bitcoin.php, ETH: p.ethereum.php };
  const msgs = [];

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
      const target = a.ref * (1 + (a.dir === 'above' ? 1 : -1) * a.value / 100);
      hit = a.dir === 'above' ? now >= target : now <= target;
      text = `${a.coin} moved ${a.value}% ${a.dir === 'above' ? 'up' : 'down'} from ${php(a.ref)} (target ${php(target)})`;
    } else if (a.type === 'trail') {
      const line = s.high * (1 - a.value / 100);
      hit = now <= line;
      text = `${a.coin} fell ${a.value}% from its peak ${php(s.high)} (stop line ${php(line)})`;
    }
    if (hit) { s.fired = true; msgs.push(`🔔 ${text}. Now: ${php(now)}${a.note ? ' — ' + a.note : ''}`); }
  }

  fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
  const hook = process.env.DISCORD_WEBHOOK;
  if (msgs.length && hook) {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msgs.join('\n') }) });
  }
  console.log(msgs.length ? msgs.join('\n') : 'No alerts triggered.', price);
})().catch(e => { console.error(e); process.exit(1); });
