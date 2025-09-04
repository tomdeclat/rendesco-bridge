// /api/calendly-health.js
export default async function handler(req, res) {
  try {
    const r = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${process.env.CALENDLY_PAT}` }
    });
    const ok = r.ok;
    const j = await r.json().catch(()=>({}));
    res.status(ok ? 200 : 500).json({ ok, status: r.status, whoami: j?.resource?.slug || null });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
