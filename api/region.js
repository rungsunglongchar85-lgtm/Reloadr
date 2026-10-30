// Reloadr / GameZone: Mobile Legends region check by Zone ID.
// GET /api/region?id=109774957&zone=2569 -> {ok:true,region:"..."} | {notfound:true} | {error:"..."}
// The zone-to-region map is set in Vercel as the env var ZONE_REGIONS, as JSON, for example:
// {"2569":"Indonesia","2570":"Philippines"}
// Only add zones you have confirmed yourself.

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300');
  const id = String(req.query.id || '').trim();
  const zone = String(req.query.zone || '').trim();
  if (!/^\d{4,15}$/.test(id) || !/^\d{1,8}$/.test(zone)) return res.status(200).json({ notfound: true });

  let map = {};
  try {
    map = JSON.parse(process.env.ZONE_REGIONS || '{}');
  } catch (e) {
    return res.status(200).json({ error: 'ZONE_REGIONS is not valid JSON' });
  }

  const region = map && map[zone];
  if (!region) return res.status(200).json({ notfound: true });
  return res.status(200).json({ ok: true, region: String(region).slice(0, 40) });
};
