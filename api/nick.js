Reloadr: game nickname lookup (Vercel serverless function).
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
    return res.status(200).json({ error: 'lookup unavailable' });
  } catch (e) {
    return res.status(200).json({ error: 'lookup unavailable' });
  } finally {
    clearTimeout(tm);
  }
};
