// GameZone: sends an order receipt by Gmail after a purchase.
// POST /api/receipt  body: {no:"RL1A2B3C"}  header: Authorization: Bearer <user session token>
// Env vars (Vercel): SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, STORE_NAME (optional)
const nodemailer = require('nodemailer');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const GU = process.env.GMAIL_USER || '';
  const GP = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  const STORE = process.env.STORE_NAME || 'GameZone Hub';
  if (!URL_ || !KEY || !GU || !GP) return res.status(500).json({ error: 'Server not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (x) { body = {}; } }
  const no = String((body && body.no) || '');
  if (!/^RL[A-Z0-9]{6}$/.test(no)) return res.status(400).json({ error: 'Bad order number' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Log in first' });

  const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  try {
    // 1. Who is calling?
    const uRes = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
    if (!uRes.ok) return res.status(401).json({ error: 'Session expired' });
    const user = await uRes.json();

    // 2. Is this a real order that belongs to this user?
    const oRes = await fetch(URL_ + '/rest/v1/orders?no=eq.' + no + '&select=*', { headers: svc });
    const orders = await oRes.json();
    const o = Array.isArray(orders) ? orders[0] : null;
    if (!o || o.user_id !== user.id) return res.status(404).json({ error: 'Order not found' });

    // 3. Customer email from the auth account
    const cRes = await fetch(URL_ + '/auth/v1/admin/users/' + user.id, { headers: svc });
    const cust = await cRes.json();
    const to = cust && cust.email;
    if (!to) return res.status(400).json({ error: 'No email on account' });

    const paid = o.via === 'Wallet';
    const statusText = paid ? 'Paid' : 'Pending (we will confirm your payment shortly)';
    const when = new Date(o.created_at || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rows = [
      ['Order number', o.no],
      ['Package', o.name],
      ['Game', o.game],
      ['Player ID', o.gid + (o.sid && o.sid !== '-' ? ' (Server ' + o.sid + ')' : '')],
      ['Amount', 'Rs ' + o.price],
      ['Payment', o.via],
      ['Status', statusText],
      ['Date', when]
    ];
    const text = `Thank you for your order at ${STORE}.\n\n` + rows.map(r => r[0] + ': ' + r[1]).join('\n') + `\n\nKeep this receipt for reference. If anything looks wrong, reply to this email.`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111">
<h2 style="margin:0 0 8px">Thank you for your order</h2>
<p style="margin:0 0 16px;color:#555">${esc(STORE)} receipt</p>
<table style="width:100%;border-collapse:collapse">${rows.map(r => `<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#555">${esc(r[0])}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right"><b>${esc(r[1])}</b></td></tr>`).join('')}</table>
<p style="margin-top:16px;color:#555">Keep this receipt for reference. If anything looks wrong, reply to this email.</p></div>`;

    // 4. Send through Gmail
    const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GU, pass: GP } });
    await transporter.sendMail({ from: `"${STORE}" <${GU}>`, to, subject: `Your ${STORE} order ${o.no}`, text, html });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Could not send receipt' });
  }
};
