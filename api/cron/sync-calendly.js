// /api/cron/sync-calendly.js
// Vercel Cron Job: Runs every 10 minutes to sync Calendly bookings with Salesforce leads
// Handles cases where the immediate webhook failed due to Salesforce indexing delays

export const config = {
  maxDuration: 300, // 5 minutes max (Pro plan allows up to 300s, Free allows 10s per invocation)
};

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⏰ Calendly-Salesforce Sync Cron Job Started');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Triggered at: ${new Date().toISOString()}`);

  try {
    // Verify cron secret (prevent unauthorized access)
    const cronSecret = req.headers['authorization'];
    const expectedSecret = process.env.CRON_SECRET;
    
    if (expectedSecret && cronSecret !== `Bearer ${expectedSecret}`) {
      console.error('❌ Unauthorized cron request');
      return json(res, 401, { ok: false, error: 'Unauthorized' });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CALENDLY API - Fetch recent bookings (last 24 hours)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const calendlyToken = (process.env.CALENDLY_PAT || '').trim();
    if (!calendlyToken) {
      console.error('❌ Missing CALENDLY_PAT environment variable');
      return json(res, 500, { ok: false, error: 'Missing CALENDLY_PAT' });
    }

    const organizationUri = process.env.CALENDLY_ORGANIZATION_URI;
    if (!organizationUri) {
      console.error('❌ Missing CALENDLY_ORGANIZATION_URI');
      return json(res, 500, { ok: false, error: 'Missing CALENDLY_ORGANIZATION_URI' });
    }

    // Get bookings from last 24 hours
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    const minStartTime = twentyFourHoursAgo.toISOString();

    console.log(`\n🔍 Fetching Calendly bookings since: ${minStartTime}`);

    const eventsUrl = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(organizationUri)}&min_start_time=${encodeURIComponent(minStartTime)}&status=active&count=100`;
    
    const eventsRes = await fetch(eventsUrl, {
      headers: { Authorization: `Bearer ${calendlyToken}` }
    });

    if (!eventsRes.ok) {
      const errText = await eventsRes.text().catch(() => '');
      console.error(`❌ Calendly API error ${eventsRes.status}:`, errText);
      return json(res, 500, { ok: false, error: `Calendly API error ${eventsRes.status}` });
    }

    const eventsData = await eventsRes.json();
    const events = eventsData.collection || [];
    
    console.log(`📅 Found ${events.length} scheduled events`);

    if (events.length === 0) {
      console.log('✅ No events to process');
      return json(res, 200, { ok: true, message: 'No events to process', processed: 0 });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // SALESFORCE AUTHENTICATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n🔐 Authenticating with Salesforce...');

    const {
      SF_INSTANCE_URL,
      SF_CLIENT_ID,
      SF_CLIENT_SECRET,
      SF_USERNAME,
      SF_PASSWORD,
      SF_AUTH_FLOW
    } = process.env;

    if (!SF_INSTANCE_URL || !SF_CLIENT_ID || !SF_CLIENT_SECRET) {
      console.error('❌ Missing Salesforce credentials');
      return json(res, 500, { ok: false, error: 'Missing Salesforce credentials' });
    }

    const apiVersion = 'v62.0';

    async function sfTokenClientCredentials() {
      const url = `${SF_INSTANCE_URL}/services/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET
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
      if (!SF_USERNAME || !SF_PASSWORD) {
        throw new Error('Missing SF_USERNAME or SF_PASSWORD');
      }
      const url = `${SF_INSTANCE_URL}/services/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        username: SF_USERNAME,
        password: SF_PASSWORD
      });
      const r = await fetch(url, { method: 'POST', body });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`❌ SF token error ${r.status}:`, errText);
        throw new Error(`SF token (password) ${r.status}`);
      }
      return r.json();
    }

    const flow = (SF_AUTH_FLOW || 'client_credentials').toLowerCase();
    const tok = flow === 'password' ? await sfTokenPassword() : await sfTokenClientCredentials();

    const access_token = tok.access_token;
    const base = tok.instance_url || SF_INSTANCE_URL;

    if (!access_token || !base) {
      console.error('❌ Missing Salesforce access_token or instance_url');
      throw new Error('Failed to authenticate with Salesforce');
    }

    console.log(`✅ Salesforce authenticated: ${base}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PROCESS EACH EVENT
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const event of events) {
      const eventUri = event.uri;
      
      console.log(`\n📅 Processing event: ${eventUri}`);
      
      // Fetch invitees for this event
      const inviteesUrl = `${eventUri}/invitees`;
      const inviteesRes = await fetch(inviteesUrl, {
        headers: { Authorization: `Bearer ${calendlyToken}` }
      });

      if (!inviteesRes.ok) {
        console.error(`❌ Failed to fetch invitees for event`);
        errorCount++;
        continue;
      }

      const inviteesData = await inviteesRes.json();
      const invitees = inviteesData.collection || [];

      for (const invitee of invitees) {
        const email = invitee.email;
        const payment = invitee.payment;
        const startTime = event.start_time;

        if (!email) {
          console.log('  ⚠️  Skipping invitee without email');
          skippedCount++;
          continue;
        }

        console.log(`  📧 Processing invitee: ${email}`);

        // Extract payment status
        const paid = payment?.successful === true;
        
        // Extract survey date from event start_time (ISO format)
        const surveyDate = startTime ? startTime.split('T')[0] : '';

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // FIND LEAD BY EMAIL
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const safeEmail = email.replace(/'/g, "\\'");
        const soql = `SELECT Id, FirstName, LastName, Survey_scheduled__c, Survey_payment_complete__c FROM Lead WHERE Email = '${safeEmail}' ORDER BY CreatedDate DESC LIMIT 1`;
        const qUrl = `${base}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;

        const qRes = await fetch(qUrl, {
          headers: { Authorization: `Bearer ${access_token}` }
        });

        if (!qRes.ok) {
          console.error(`  ❌ SF query error ${qRes.status}`);
          errorCount++;
          continue;
        }

        const q = await qRes.json();
        const lead = q?.records?.[0];

        if (!lead) {
          console.log(`  ⚠️  Lead not found for email: ${email}`);
          skippedCount++;
          continue;
        }

        const leadId = lead.Id;
        const leadName = `${lead.FirstName || ''} ${lead.LastName || ''}`.trim();

        // Check if lead already has survey data
        if (lead.Survey_scheduled__c && lead.Survey_payment_complete__c) {
          console.log(`  ✓ Lead ${leadName} (${leadId}) already has survey data - skipping`);
          skippedCount++;
          continue;
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // UPDATE LEAD WITH BOOKING DATA
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        console.log(`  📝 Updating lead ${leadName} (${leadId})...`);

        const patchUrl = `${base}/services/data/${apiVersion}/sobjects/Lead/${leadId}`;
        const patchBody = {
          Survey_scheduled__c: surveyDate || "",
          Survey_payment_complete__c: !!paid
        };

        console.log(`  Update payload:`, patchBody);

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
          console.error(`  ❌ SF update error ${pRes.status}:`, errText);
          errorCount++;
          continue;
        }

        console.log(`  ✅ Lead updated successfully!`);
        processedCount++;
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Cron Job Complete');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total Events: ${events.length}`);
    console.log(`Processed: ${processedCount}`);
    console.log(`Skipped: ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return json(res, 200, {
      ok: true,
      message: 'Sync complete',
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      totalEvents: events.length
    });

  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ CRON JOB FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return json(res, 500, {
      ok: false,
      error: error.message
    });
  }
}
