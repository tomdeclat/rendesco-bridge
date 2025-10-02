// /api/calendly-hook.js
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

    // ---- Calendly API ----
    const token = (process.env.CALENDLY_PAT || '').trim();
    if (!token) return json(res, 500, { ok:false, error:'Missing CALENDLY_PAT env var' });
    const CAL_AUTH = `Bearer ${token}`;

    const invRes = await fetch(inviteeUri, { headers: { Authorization: CAL_AUTH } });
    if (!invRes.ok) throw new Error(`Calendly invitee error ${invRes.status}`);
    const inv = await invRes.json();

    const evtRes = await fetch(eventUri, { headers: { Authorization: CAL_AUTH } });
    if (!evtRes.ok) throw new Error(`Calendly event error ${evtRes.status}`);
    const evt = await evtRes.json();

    // Extract date/time + payment
    const startISO = evt?.resource?.start_time || null;
    const tz       = inv?.resource?.timezone || evt?.resource?.timezone || 'UTC';
    let startLocal = null;
    if (startISO) {
      try { startLocal = new Date(startISO).toLocaleString('en-GB', { timeZone: tz }); } catch {}
    }
    const surveyDate = startISO ? String(startISO).slice(0, 10) : null;
    const payment    = inv?.resource?.payment || null;
    const paid       = !!(payment && (payment.amount || payment.external_id || payment.provider));
    const amount     = payment?.amount ?? null;
    const currency   = payment?.currency ?? null;

    // ---- Salesforce auth ----
    const loginUrl   = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
    const apiVersion = process.env.SF_API_VERSION || 'v61.0';

    async function sfTokenClientCredentials() {
      const url = `${loginUrl}/services/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        ...(process.env.SF_AUDIENCE ? { audience: process.env.SF_AUDIENCE } : {})
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

    const access_token = tok.access_token;
    const base = tok.instance_url || process.env.SF_INSTANCE_URL;
    if (!access_token) throw new Error('Missing Salesforce access_token');
    if (!base) throw new Error('Missing Salesforce instance_url (set SF_INSTANCE_URL)');

    // ---- Find Lead by email WITH RETRY LOGIC ----
    const safeEmail = email.replace(/'/g, "\\'");
    const soql = `SELECT Id FROM Lead WHERE Email = '${safeEmail}' ORDER BY CreatedDate DESC LIMIT 1`;
    const qUrl = `${base}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;
    
    let leadId = null;
    const maxAttempts = 5;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`Searching for lead (attempt ${attempt}/${maxAttempts})...`);
      
      const qRes = await fetch(qUrl, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!qRes.ok) throw new Error(`SF query error ${qRes.status}`);
      const q = await qRes.json();
      leadId = q?.records?.[0]?.Id || null;
      
      if (leadId) {
        console.log(`Lead found on attempt ${attempt}: ${leadId}`);
        break;
      }
      
      // If not found and more attempts remain, wait before retry
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s, 32s
        console.log(`Lead not found, waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    if (!leadId) {
      return json(res, 404, { 
        ok: false, 
        error: `Lead not found by email after ${maxAttempts} attempts`, 
        startTime: startISO, 
        eventTimezone: tz, 
        startTimeLocal: startLocal, 
        surveyDate, 
        paid, 
        amount, 
        currency 
      });
    }

    // ---- Update Lead ----
    const patchUrl  = `${base}/services/data/${apiVersion}/sobjects/Lead/${leadId}`;
    const patchBody = {
      Survey_scheduled__c: surveyDate || "",
      Survey_payment_complete__c: !!paid
    };
    const pRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody)
    });
    if (!pRes.ok) {
      const body = await pRes.text().catch(()=> '');
      return json(res, 500, { 
        ok: false, 
        error: `SF patch error ${pRes.status}`, 
        details: body.slice(0,400), 
        startTime: startISO, 
        eventTimezone: tz, 
        startTimeLocal: startLocal, 
        surveyDate, 
        paid, 
        amount, 
        currency 
      });
    }

    // Return rich details for console visibility
    return json(res, 200, { 
      ok: true, 
      startTime: startISO, 
      eventTimezone: tz, 
      startTimeLocal: startLocal, 
      surveyDate, 
      paid, 
      amount, 
      currency,
      leadId 
    });
  } catch (err) {
    console.error('calendly-hook error:', err);
    return json(res, 500, { ok: false, error: String(err.message || err) });
  }
}
