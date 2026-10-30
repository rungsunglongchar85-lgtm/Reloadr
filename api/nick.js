// Reloadr: game nickname lookup (Vercel serverless function).
// GET /api/nick?g=ml&id=123456789&zone=1234  ->  {ok:true,name:"..."} | {notfound:true} | {error:"..."}
// Providers: set Vercel env vars NICK_URL_<KEY> (e.g. NICK_URL_ML, NICK_URL_BGMI) to a lookup URL
// that contains {id} and {zone}. If NICK_URL_ML is not set, a public default is tried for "ml".
const DEFAULTS = { ml: 'https://api.isan.eu.org/nickname/ml?id={id}&zone={zone}' };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=60');
  const g = String(req.query.g || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const id = String(req.query.id || '').trim();
  const zone = String(req.query.zone || '').trim();
  if (!/^\d{4,15}$/.test(id) || (zone && !/^\d{1,8}$/.test(zone))) return res.status(200).json({ notfound: true });
  if (g === 'ml' && process.env.TOPZY_API_KEY) {
    // Mobile Legends name check through Topzy
    const ac2 = new AbortController();
    const tm2 = setTimeout(() => ac2.abort(), 6000);
    try {
      const r = await fetch('https://topzy.in/api/partner/validation', {
        method: 'POST', signal: ac2.signal,
        headers: { 'x-api-key': process.env.TOPZY_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: 'mlbb', userId: id, zoneId: zone }),
      });
      const j = await r.json().catch(() => ({}));
      const nm = j.data && j.data.username;
      // Log Topzy's reply for debugging (status and message only, never the API key)
      console.log('TOPZY validation', JSON.stringify({ id, zone, status: r.status, success: j.success, message: j.message || j.error || null, found: !!nm }));
      if (r.ok && j.success !== false && nm) return res.status(200).json({ ok: true, name: String(nm).slice(0, 40) });
      if (r.status === 404 || /not.?found|invalid/i.test(String(j.message || j.error || ''))) return res.status(200).json({ notfound: true });
      return res.status(200).json({ error: 'lookup unavailable', why: 'HTTP ' + r.status + ' ' + String(j.message || j.error || '').slice(0, 80) });
    } catch (e) {
      console.log('TOPZY validation error', String((e && e.message) || e).slice(0, 200));
      return res.status(200).json({ error: 'lookup unavailable', why: String((e && e.message) || e).slice(0, 80) });
    } finally {
      clearTimeout(tm2);
    }
  }
  const tpl = process.env['NICK_URL_' + g.toUpperCase()] || DEFAULTS[g];
  if (!tpl) return res.status(200).json({ error: 'not configured' });
  const url = tpl.replace('{id}', encodeURIComponent(id)).replace('{zone}', encodeURIComponent(zone));
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    const d = j && (j.data || j);
    const name = d && (d.name || d.nickname || d.username || d.userName || d.nick);
    if (r.ok && name && j.success !== false) return res.status(200).json({ ok: true, name: String(name).slice(0, 40) });
    const msg = String((j && (j.message || j.error || j.msg)) || '');
    if (r.status === 404 || (r.status < 500 && /not.?found|invalid|no player|tidak/i.test(msg))) return res.status(200).json({ notfound: true });
    return res.status(200).json({ error: 'lookup unavailable', why: 'HTTP ' + r.status + ' ' + msg.slice(0, 80) });
  } catch (e) {
    return res.status(200).json({ error: 'lookup unavailable', why: String(e && e.message || e).slice(0, 80) });
  } finally {
    clearTimeout(tm);
  }
};
 
