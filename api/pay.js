create table if not exists payments(
 id bigint generated always as identity primary key,
 rp_order text unique not null,
 r,p_payment text unique,
 user_id uuid references profiles(id) on delete set null,
 kind text not null,
 amount int not null,
 pkg_id bigint,
 gid text,
 sid text,
 status text not null default 'created',
 created_at timestamptz not null default now());
alter table payments enable row level security;

create or replace function prepare_payment(p_user uuid,p_kind text,p_amt int,p_pkg bigint,p_gid text,p_sid text) returns jsonb language plpgsql security definer set search_path=public as $$
declare u profiles;pk jsonb;pr int;rd numeric;mn int;mx int;
begin
select * into u from profiles where id=p_user;
if u.id is null then raise exception 'Please log in first';end if;
if u.is_blocked then raise exception 'Your account is blocked. Contact support.';end if;
if p_kind='wallet' then
 select coalesce((data->'s'->>'min')::int,10),coalesce((data->'s'->>'max')::int,10000) into mn,mx from cfg where id=1;
 if p_amt<mn or p_amt>mx then raise exception 'Amount must be between % and %',mn,mx;end if;
 return jsonb_build_object('amount',p_amt,'desc','Wallet top-up');
end if;
select e into pk from cfg,jsonb_array_elements(cfg.data->'p') e where (e->>'i')::bigint=p_pkg limit 1;
if pk is null then raise exception 'Package not found';end if;
if coalesce((pk->>'oos')::boolean,false) then raise exception 'This package is out of stock';end if;
if exists(select 1 from cfg,jsonb_array_elements(cfg.data->'g') e where e->>'id'=pk->>'g' and coalesce((e->>'oos')::boolean,false)) then raise exception 'This game is out of stock';end if;
pr:=(pk->>'pr')::int;
if u.is_reseller then
 select coalesce((data->'s'->>'rd')::numeric,0) into rd from cfg where id=1;
 if coalesce((pk->>'rp')::numeric,0)>0 then pr:=((pk->>'rp')::numeric)::int; else pr:=round(pr*(100-rd)/100)::int; end if;
end if;
if coalesce(trim(p_gid),'')='' then raise exception 'Enter your Game ID';end if;
return jsonb_build_object('amount',pr,'desc',pk->>'n');
end$$;

create or replace function record_payment(p_order text,p_user uuid,p_kind text,p_amt int,p_pkg bigint,p_gid text,p_sid text) returns void language plpgsql security definer set search_path=public as $$
begin
insert into payments(rp_order,user_id,kind,amount,pkg_id,gid,sid) values(p_order,p_user,p_kind,p_amt,p_pkg,left(p_gid,40),left(p_sid,40));
end$$;

create or replace function finish_payment(p_order text,p_payment text,p_user uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare p payments;u profiles;pk jsonb;o orders;
begin
select * into p from payments where rp_order=p_order for update;
if p.id is null then raise exception 'Unknown payment';end if;
if p_user is not null and p.user_id is distinct from p_user then raise exception 'Payment belongs to another account';end if;
if p.status='paid' then
 select * into o from orders where utr=p.rp_payment limit 1;
 return jsonb_build_object('kind',p.kind,'already',true,'order',to_jsonb(o));
end if;
select * into u from profiles where id=p.user_id;
update payments set status='paid',rp_payment=p_payment where id=p.id;
if p.kind='wallet' then
 if u.id is not null then update profiles set balance=balance+p.amount where id=u.id;end if;
 insert into deposits(user_id,username,amount,utr,status,verified) values(u.id,coalesce(u.username,'deleted'),p.amount,p_payment,'approved',true);
 return jsonb_build_object('kind','wallet');
end if;
select e into pk from cfg,jsonb_array_elements(cfg.data->'p') e where (e->>'i')::bigint=p.pkg_id limit 1;
insert into orders(no,user_id,username,game,pkg_id,name,price,gid,sid,via,utr,verified) values('RL'||upper(substr(md5(random()::text),1,6)),u.id,coalesce(u.username,'deleted'),pk->>'g',p.pkg_id,coalesce(pk->>'n','Package'),p.amount,p.gid,p.sid,'Razorpay',p_payment,true) returning * into o;
return jsonb_build_object('kind','order','order',to_jsonb(o));
end$$;

revoke all on function prepare_payment(uuid,text,int,bigint,text,text) from public,anon,authenticated;
revoke all on function record_payment(text,uuid,text,int,bigint,text,text) from public,anon,authenticated;
revoke all on function finish_payment(text,text,uuid) from public,anon,authenticated;
grant execute on function prepare_payment(uuid,text,int,bigint,text,text) to service_role;
grant execute on function record_payment(text,uuid,text,int,bigint,text,text) to service_role;
grant execute on function finish_payment(text,text,uuid) to service_role;// Reloadr Razorpay server function (Vercel). One file, three jobs:
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
