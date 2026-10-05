// Reloadr Razorpay server function (Vercel). One file, three jobs:
//   POST /api/pay?a=create  -> make a Razorpay order for the logged-in customer
//   POST /api/pay?a=verify  -> confirm a finished payment (browser)
//   POST /api/pay?a=hook    -> Razorpay webhook (server to server)
const crypto = require('crypto');
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const RK = process.env.RAZORPAY_KEY_ID;
const RS = process.env.RAZORPAY_KEY_SECRET;
const WS = process.env.RAZORPAY_WEBHOOK_SECRET;

async function rpc(fn, args) {
  const r = await fetch(SU + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SK, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  let j = t;
  try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) throw new Error((j && j.message) || t || 'Database error');
  return j;
}

async function userFrom(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  return r.json();
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  const a = (req.query && req.query.a) || '';
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!SU || !SK || !RK || !RS) throw new Error('Server is not configured yet');

    if (a === 'hook') {
      let body = await rawBody(req);
      if (!body.length && req.body) body = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const exp = crypto.createHmac('sha256', WS || '').update(body).digest('hex');
      if (!WS || !same(req.headers['x-razorpay-signature'] || '', exp)) return res.status(400).json({ error: 'bad signature' });
      const ev = JSON.parse(body.toString());
      if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
        const p = ((ev.payload || {}).payment || {}).entity || {};
        if (p.order_id && p.id) await rpc('finish_payment', { p_order: p.order_id, p_payment: p.id, p_user: null });
      }
      return res.status(200).json({ ok: true });
    }

    const u = await userFrom(req);
    if (!u || !u.id) return res.status(401).json({ error: 'Please log in again' });
    const b = req.body || {};

    if (a === 'create') {
      const kind = b.kind === 'order' ? 'order' : 'wallet';
      const args = {
        p_user: u.id,
        p_kind: kind,
        p_amt: parseInt(b.amount, 10) || 0,
        p_pkg: kind === 'order' ? Number(b.pkg) || null : null,
        p_gid: String(b.gid || '').slice(0, 40),
        p_sid: String(b.sid || '').slice(0, 40),
      };
      const q = await rpc('prepare_payment', args);
      const rr = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(RK + ':' + RS).toString('base64'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: q.amount * 100, currency: 'INR', receipt: 'rl_' + Date.now(), notes: { user: u.id, kind } }),
      });
      const o = await rr.json();
      if (!rr.ok) throw new Error((o.error && o.error.description) || 'Razorpay error');
      await rpc('record_payment', { p_order: o.id, p_user: u.id, p_kind: kind, p_amt: q.amount, p_pkg: args.p_pkg, p_gid: args.p_gid, p_sid: args.p_sid });
      return res.status(200).json({ key: RK, order_id: o.id, amount: o.amount, desc: q.desc });
    }

    if (a === 'verify') {
      const sig = crypto.createHmac('sha256', RS).update(b.razorpay_order_id + '|' + b.razorpay_payment_id).digest('hex');
      if (!same(sig, b.razorpay_signature || '')) return res.status(400).json({ error: 'Payment signature did not match' });
      const r = await rpc('finish_payment', { p_order: b.razorpay_order_id, p_payment: b.razorpay_payment_id, p_user: u.id });
      return res.status(200).json(Object.assign({ ok: true }, r));
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(400).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
