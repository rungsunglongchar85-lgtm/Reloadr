// GameZone: automatic top-up through the Topzy partner API (Vercel serverless function).
// POST /api/topup  { no: "RLXXXXXX", action: "create" | "status" }
//   Authorization: Bearer <Supabase session token>
// create: sends the order to Topzy. Allowed for admins, or for the customer on their own paid Wallet order.
// status: asks Topzy for the order status and updates it (admins only).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, TOPZY_API_KEY, TOPZY_EMAIL, TOPZY_MOBILE
const API = 'https://topzy.in/api/partner';

async function topzy(key, path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'x-api-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, j };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, KEY = process.env.TOPZY_API_KEY;
  if (!SU || !SK || !KEY) return res.status(500).json({ error: 'Server not configured' });

  const body = req.body || {};
  const no = String(body.no || '').trim();
  const action = body.action === 'status' ? 'status' : 'create';
  if (!/^RL[A-Z0-9]{6}$/.test(no)) return res.status(400).json({ error: 'Bad order number' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in first' });

  const sb = { apikey: SK, Authorization: 'Bearer ' + SK };
  try {
    const user = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + token } })
      .then(r => (r.ok ? r.json() : null));
    if (!user || !user.id) return res.status(401).json({ error: 'Sign in first' });

    const prof = await fetch(SU + '/rest/v1/profiles?id=eq.' + user.id + '&select=is_admin', { headers: sb }).then(r => r.json());
    const isAdmin = !!(prof[0] && prof[0].is_admin);
    const ord = (await fetch(SU + '/rest/v1/orders?no=eq.' + no + '&select=*', { headers: sb }).then(r => r.json()))[0];
    if (!ord) return res.status(404).json({ error: 'Order not found' });

    const mine = ord.user_id === user.id;
    if (action === 'status' && !isAdmin) return res.status(403).json({ error: 'Admins only' });
    if (action === 'create' && !isAdmin && !(mine && ord.via === 'Wallet')) return res.status(403).json({ error: 'Not allowed' });

    const patch = p => fetch(SU + '/rest/v1/orders?id=eq.' + ord.id, {
      method: 'PATCH',
      headers: Object.assign({}, sb, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(p),
    });

    // Check the status of an order already sent to Topzy
    if (action === 'status') {
      if (!ord.prov_id) return res.status(400).json({ error: 'Not sent to Topzy yet' });
      const s = await topzy(KEY, '/order/' + encodeURIComponent(ord.prov_id));
      if (!s.ok) return res.status(200).json({ ok: false, error: s.j.message || 'Topzy error' });
      const st = String((s.j.order && s.j.order.status) || s.j.status || '').toLowerCase();
      const p = { prov_st: st || ord.prov_st };
      // Success completes the order. Failures are not auto-refunded here: use the admin Failed button, which refunds the wallet.
      if (st === 'success' && ord.status !== 'complete') p.status = 'complete';
      await patch(p);
      return res.status(200).json({ ok: true, prov_st: p.prov_st });
    }

    // Send the order to Topzy
    if (ord.prov_id) return res.status(200).json({ ok: true, already: true, prov_st: ord.prov_st });
    if (['complete', 'failed', 'refunded'].includes(ord.status)) return res.status(400).json({ error: 'Order is ' + ord.status });

    const cfg = (await fetch(SU + '/rest/v1/cfg?id=eq.1&select=data', { headers: sb }).then(r => r.json()))[0];
    const pkg = ((cfg && cfg.data && cfg.data.p) || []).find(x => x.i == ord.pkg_id);
    const packId = pkg && pkg.pid;
    if (!packId) return res.status(400).json({ error: 'No Topzy pack ID set for this package (Admin > Packages)' });
    if (!process.env.TOPZY_EMAIL || !process.env.TOPZY_MOBILE) return res.status(500).json({ error: 'TOPZY_EMAIL or TOPZY_MOBILE not set' });

    const zone = ord.sid && ord.sid !== '-' ? String(ord.sid) : undefined;
    const r = await topzy(KEY, '/createorder', {
      partnerOrderId: ord.no,
      packId: String(packId),
      userId: String(ord.gid),
      zoneId: zone,
      email: process.env.TOPZY_EMAIL,
      mobile: process.env.TOPZY_MOBILE,
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: r.j.message || r.j.error || ('Topzy error ' + r.status) });

    const prov_id = String(r.j.orderId || '');
    const prov_st = String(r.j.status || 'processing').toLowerCase();
    await patch({ prov_id, prov_st });
    return res.status(200).json({ ok: true, prov_id, prov_st });
  } catch (e) {
    return res.status(500).json({ error: 'Top-up failed: ' + String((e && e.message) || e).slice(0, 120) });
  }
};
