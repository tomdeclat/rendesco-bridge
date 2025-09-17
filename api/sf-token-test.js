// /api/sf-token-test.js
export default async function handler(req, res) {
  try {
    const loginUrl = process.env.SF_LOGIN_URL;
    const id = process.env.SF_CLIENT_ID;
    const secret = process.env.SF_CLIENT_SECRET;

    if (!loginUrl || !id || !secret) {
      return res.status(400).json({ ok:false, error:'Missing SF env vars' });
    }
    const url = `${loginUrl.replace(/\/+$/,'')}/services/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret
    });

    const r = await fetch(url, { method: 'POST', body });
    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ ok:false, status:r.status, error:'token_failed', body:text });
    }
    const j = JSON.parse(text);
    return res.status(200).json({
      ok:true,
      instance_url: j.instance_url,
      token_type: j.token_type,
      scope: j.scope
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err.message || err) });
  }
}
