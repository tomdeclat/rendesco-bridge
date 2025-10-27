// /api/calendly-hook.js
// Fixed version for Vercel deployment at rendesco-bridge

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
}

// Helper to parse request body (Vercel requires explicit parsing)
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Calendly-Webhook-Signature');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 Calendly Webhook Received');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Parse request body - handle all Vercel body formats
    let webhookData;
    try {
      if (!req.body) {
        // No pre-parsed body, read from stream
        webhookData = await parseBody(req);
      } else if (Buffer.isBuffer(req.body)) {
        // Vercel provided a Buffer, parse it
        webhookData = JSON.parse(req.body.toString());
      } else if (typeof req.body === 'string') {
        // Vercel provided a string, parse it
        webhookData = JSON.parse(req.body);
      } else if (typeof req.body === 'object') {
        // Vercel already parsed to object, use directly
        webhookData = req.body;
      } else {
        throw new Error(`Unexpected body type: ${typeof req.body}`);
      }
    } catch (parseError) {
      console.error('❌ Failed to parse request body:', parseError);
      return json(res, 400, { ok: false, error: 'Invalid JSON in request body' });
    }

    // Parse Calendly webhook payload
    // Calendly sends: { event: "invitee.created", payload: { event: "...", invitee: "..." } }
    console.log('Raw webhook payload:', JSON.stringify(webhookData, null, 2));

    const eventType = webhookData.event;
    const payload = webhookData.payload || {};

    if (eventType !== 'invitee.created') {
      console.log(`⚠️  Ignoring event type: ${eventType}`);
      return json(res, 200, { ok: true, message: 'Event type not processed' });
    }

    // Extract URIs from Calendly payload
    const eventUri = payload.event;
    const inviteeUri = payload.invitee;

    if (!eventUri || !inviteeUri) {
      console.error('❌ Missing event or invitee URI in payload');
      return json(res, 400, { 
        ok: false, 
        error: 'Missing event or invitee URI',
        receivedPayload: webhookData
      });
    }

    console.log(`📅 Event URI: ${eventUri}`);
    console.log(`👤 Invitee URI: ${inviteeUri}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CALENDLY API - Fetch booking details
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const token = (process.env.CALENDLY_PAT || '').trim();
    if (!token) {
      console.error('❌ Missing CALENDLY_PAT environment variable');
      return json(res, 500, { ok: false, error: 'Missing CALENDLY_PAT env var' });
    }

    const CAL_AUTH = `Bearer ${token}`;

    console.log('\n🔄 Fetching invitee details from Calendly...');
    const invRes = await fetch(inviteeUri, { 
      headers: { Authorization: CAL_AUTH } 
    });
    
    if (!invRes.ok) {
      const errText = await invRes.text().catch(() => '');
      console.error(`❌ Calendly invitee API error ${invRes.status}:`, errText);
      throw new Error(`Calendly invitee error ${invRes.status}`);
    }
    
    const invData = await invRes.json();
    const invitee = invData.resource;
    const email = invitee.email;

    console.log(`✅ Invitee email: ${email}`);

    console.log('\n🔄 Fetching event details from Calendly...');
    const evtRes = await fetch(eventUri, { 
      headers: { Authorization: CAL_AUTH } 
    });
    
    if (!evtRes.ok) {
      const errText = await evtRes.text().catch(() => '');
      console.error(`❌ Calendly event API error ${evtRes.status}:`, errText);
      throw new Error(`Calendly event error ${evtRes.status}`);
    }
    
    const evtData = await evtRes.json();
    const event = evtData.resource;

    // Extract booking details
    const startISO = event.start_time || null;
    const tz = invitee.timezone || event.timezone || 'UTC';
    
    let startLocal = null;
    if (startISO) {
      try {
        startLocal = new Date(startISO).toLocaleString('en-GB', { timeZone: tz });
      } catch (e) {
        console.warn('⚠️  Could not format local time:', e.message);
      }
    }

    // Extract date in YYYY-MM-DD format for Salesforce
    const surveyDate = startISO ? String(startISO).slice(0, 10) : null;

    // Extract payment information
    const payment = invitee.payment || null;
    const paid = !!(payment && (payment.amount || payment.external_id || payment.provider));
    const amount = payment?.amount ?? null;
    const currency = payment?.currency ?? null;

    console.log('\n📊 Booking Details:');
    console.log(`  Start Time (ISO): ${startISO}`);
    console.log(`  Start Time (Local): ${startLocal}`);
    console.log(`  Survey Date: ${surveyDate}`);
    console.log(`  Payment Received: ${paid ? 'Yes' : 'No'}`);
    if (paid) {
      console.log(`  Amount: ${amount} ${currency}`);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // SALESFORCE AUTH
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n🔐 Authenticating with Salesforce...');
    
    const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
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
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`❌ SF token error ${r.status}:`, errText);
        throw new Error(`SF token (client_credentials) ${r.status}`);
      }
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
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`❌ SF token error ${r.status}:`, errText);
        throw new Error(`SF token (password) ${r.status}`);
      }
      return r.json();
    }

    const flow = (process.env.SF_AUTH_FLOW || 'client_credentials').toLowerCase();
    const tok = flow === 'password' ? await sfTokenPassword() : await sfTokenClientCredentials();

    const access_token = tok.access_token;
    const base = tok.instance_url || process.env.SF_INSTANCE_URL;

    if (!access_token) {
      console.error('❌ Missing Salesforce access_token from auth response');
      throw new Error('Missing Salesforce access_token');
    }
    if (!base) {
      console.error('❌ Missing Salesforce instance_url (set SF_INSTANCE_URL)');
      throw new Error('Missing Salesforce instance_url');
    }

    console.log(`✅ Salesforce authenticated: ${base}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // FIND LEAD BY EMAIL (WITH RETRY LOGIC)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log(`\n🔍 Searching for lead with email: ${email}`);
    
    const safeEmail = email.replace(/'/g, "\\'");
    const soql = `SELECT Id, FirstName, LastName FROM Lead WHERE Email = '${safeEmail}' ORDER BY CreatedDate DESC LIMIT 1`;
    const qUrl = `${base}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;

    let leadId = null;
    let leadName = null;
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${maxAttempts}...`);

      const qRes = await fetch(qUrl, { 
        headers: { Authorization: `Bearer ${access_token}` } 
      });
      
      if (!qRes.ok) {
        const errText = await qRes.text().catch(() => '');
        console.error(`❌ SF query error ${qRes.status}:`, errText);
        throw new Error(`SF query error ${qRes.status}`);
      }
      
      const q = await qRes.json();
      const lead = q?.records?.[0];
      
      if (lead) {
        leadId = lead.Id;
        leadName = `${lead.FirstName || ''} ${lead.LastName || ''}`.trim();
        console.log(`✅ Lead found: ${leadName} (${leadId})`);
        break;
      }

      // If not found and more attempts remain, wait before retry
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s
        console.log(`  ⏳ Lead not found, waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (!leadId) {
      console.error(`❌ Lead not found after ${maxAttempts} attempts`);
      return json(res, 404, {
        ok: false,
        error: `Lead not found by email after ${maxAttempts} attempts`,
        email,
        surveyDate,
        paid,
        amount,
        currency,
        startTime: startISO,
        eventTimezone: tz,
        startTimeLocal: startLocal
      });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // UPDATE LEAD WITH BOOKING DATA
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log(`\n📝 Updating lead ${leadId} with booking data...`);
    
    const patchUrl = `${base}/services/data/${apiVersion}/sobjects/Lead/${leadId}`;
    const patchBody = {
      Survey_scheduled__c: surveyDate || "",
      Survey_payment_complete__c: !!paid
    };

    console.log('  Update payload:', JSON.stringify(patchBody, null, 2));

    const pRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 
        Authorization: `Bearer ${access_token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(patchBody)
    });

    if (!pRes.ok) {
      const errText = await pRes.text().catch(() => '');
      console.error(`❌ SF update error ${pRes.status}:`, errText);
      return json(res, 500, {
        ok: false,
        error: `SF patch error ${pRes.status}`,
        details: errText.slice(0, 400),
        leadId,
        surveyDate,
        paid,
        amount,
        currency,
        startTime: startISO,
        eventTimezone: tz,
        startTimeLocal: startLocal
      });
    }

    console.log(`✅ Lead updated successfully!`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ Webhook processed successfully');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Return success with all details
    return json(res, 200, {
      ok: true,
      leadId,
      leadName,
      email,
      surveyDate,
      paid,
      amount,
      currency,
      startTime: startISO,
      eventTimezone: tz,
      startTimeLocal: startLocal,
      message: 'Lead updated successfully'
    });

  } catch (err) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ WEBHOOK ERROR');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(err);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    return json(res, 500, { 
      ok: false, 
      error: String(err.message || err),
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
