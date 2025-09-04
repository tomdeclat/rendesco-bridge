// /api/calendly-hook.js (Vercel serverless; Node 18+)
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204; return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { ok:false, error:'Method not allowed' });

  try {
    const { inviteeUri, eventUri, email } = req.body || {};
    if (!inviteeUri || !eventUri || !email) {
      return json(res, 400, { ok:false, error:'inviteeUri, eventUri, email are required' });
    }

    // ---- Calendly API (follow URIs received from embed message) ----
    const CAL_AUTH = `Bearer ${process.env.CALENDLY_PAT}`;

    const invRes = await fetch(inviteeUri, { headers: { Authorization: CAL_AUTH } });
    if (!invRes.ok) throw new Error(`Calendly invitee error ${invRes.status}`);
    const inv = await invRes.json();

    const evtRes = await fetch(eventUri, { headers: { Authorization: CAL_AUTH } });
    if (!evtRes.ok) throw new Error(`Calendly event error ${evtRes.status}`);
    const evt = await evtRes.json();

    const startISO   = evt?.resource?.start_time || null;
    const surveyDate = startISO ? String(startISO).slice(0, 10) : null;

    const payment = inv?.resource?.payment || null; // present if Calendly Payments (Stripe) is on for that event type
    const paid    = !!(payment && (payment.amount || payment.external_id || payment.provider));

    // ---- Salesforce auth ----
    const loginUrl   = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
    const apiVersion = process.env.SF_API_VERSION || 'v61.0';

    async function sfTokenClientCredentials() {
      const url = `${loginUrl}/services/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET
      });
      const r = await fetch(url, { method: 'POST', body });
      if (!r.ok) throw new Error(`SF token (client_credentials) ${r.status}`);
      return r.json();
    }

    async function sfTokenPassword() {
      const url = `${loginUrl}/services/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        username: process.env.SF_USERNAME,
        password: (process.env.SF_PASSWORD || '') + (process.env.SF_SECURITY_TOKEN || '')
      });
      const r = await fetch(url, { method: 'POST', body });
      if (!r.ok) throw new Error(`SF token (password) ${r.status}`);
      return r.json();
    }

    const flow = (process.env.SF_AUTH_FLOW || 'client_credentials').toLowerCase();
    const tok  = flow === 'password' ? await sfTokenPassword() : await sfTokenClientCredentials();
    const { access_token, instance_url } = tok;
    if (!access_token || !instance_url) throw new Error('Missing Salesforce token/instance');

    // ---- Find latest Lead by email ----
    const safeEmail = email.replace(/'/g, "\\'");
    const soql = `SELECT Id FROM Lead WHERE Email = '${safeEmail}' ORDER BY CreatedDate DESC LIMIT 1`;
    const qUrl = `${instance_url}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;
    const qRes = await fetch(qUrl, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!qRes.ok) throw new Error(`SF query error ${qRes.status}`);
    const q = await qRes.json();
    const leadId = q?.records?.[0]?.Id || null;
    if (!leadId) return json(res, 404, { ok:false, error:'Lead not found by email' });

    // ---- Update Lead custom fields (client's API names) ----
    const patchUrl  = `${instance_url}/services/data/${apiVersion}/sobjects/Lead/${leadId}`;
    const patchBody = {
      "Survey_scheduled__c": surveyDate || "",
      "Survey_payment_complete__c": !!paid
    };
    const pRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody)
    });
    if (!pRes.ok) throw new Error(`SF patch error ${pRes.status} ${await pRes.text()}`);

    return json(res, 200, { ok:true, surveyDate, paid });
  } catch (err) {
    console.error('calendly-hook error:', err);
    return json(res, 500, { ok:false, error:String(err.message || err) });
  }
}
