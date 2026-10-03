// Vercel serverless function: /api/sms
// The SMS Gateway cloud API sends no CORS headers, so a browser cannot call it directly.
// smssender.html calls this function instead, and this function forwards the request.
// Username and password are used for the single request and are never stored or logged.

const BASE = 'https://api.sms-gate.app/3rdparty/v1';

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 405, 'POST only');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const { action, user, pass, payload } = body;
  if (typeof user !== 'string' || typeof pass !== 'string' || !user || !pass) {
    return bad(res, 400, 'Username and password are required');
  }

  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
  };
  const init = { headers, signal: AbortSignal.timeout(30000) };
  let url;

  if (action === 'devices') {
    url = `${BASE}/devices`;
  } else if (action === 'send') {
    // Only forward a single Pakistani mobile number and a plain text message.
    const p = payload || {};
    const text = p.textMessage && p.textMessage.text;
    const phone = Array.isArray(p.phoneNumbers) && p.phoneNumbers.length === 1 ? p.phoneNumbers[0] : null;
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) return bad(res, 400, 'Invalid message text');
    if (typeof phone !== 'string' || !/^\+923\d{9}$/.test(phone)) return bad(res, 400, 'Invalid phone number');
    const clean = {
      textMessage: { text },
      phoneNumbers: [phone],
      simNumber: Number.isInteger(p.simNumber) && p.simNumber >= 1 && p.simNumber <= 4 ? p.simNumber : 1,
      ttl: Number.isInteger(p.ttl) && p.ttl > 0 && p.ttl <= 86400 ? p.ttl : 3600,
      priority: Number.isInteger(p.priority) ? p.priority : 0,
    };
    if (typeof p.deviceId === 'string' && /^[\w-]{1,64}$/.test(p.deviceId)) clean.deviceId = p.deviceId;
    url = `${BASE}/messages?skipPhoneValidation=true&deviceActiveWithin=12`;
    init.method = 'POST';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(clean);
  } else {
    return bad(res, 400, 'Unknown action');
  }

  try {
    const up = await fetch(url, init);
    const text = await up.text();
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    return bad(res, 502, 'Could not reach the SMS gateway: ' + (e && e.message ? e.message : 'network error'));
  }
};
