// Vercel serverless function — acts as a same-origin proxy to the Punjab
// e-Stamping API. This is what makes CORS a non-issue for the browser.

const UPSTREAM = "https://es.punjab-zameen.gov.pk";

module.exports = async (req, res) => {
  // Allow the browser to call this from anywhere (your Vercel domain, local dev, etc.)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST on this proxy." });
  }

  // Vercel auto-parses JSON bodies for API routes when Content-Type is set.
  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { /* ignore */ }
  }

  const { endpoint, params = {}, method = "POST" } = payload || {};

  if (!endpoint || typeof endpoint !== "string" || !endpoint.startsWith("/")) {
    return res.status(400).json({
      error: "Missing or invalid 'endpoint'. Example: " +
             "\"/eStampCitizenPortal/api/Proxy/Reporting/GetStampRetrievalwithCNIC\""
    });
  }

  const qs = new URLSearchParams(params).toString();
  const target = UPSTREAM + endpoint + (qs ? `?${qs}` : "");

  try {
    const upstream = await fetch(target, {
      method,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        ...(method === "POST"
          ? { "Content-Type": "application/json;charset=utf-8" }
          : {})
      },
      // Empty body on POST matches the working capture (Content-Length: 0)
      body: method === "POST" ? "" : undefined
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json; charset=utf-8"
    );
    return res.send(text);
  } catch (err) {
    console.error("Upstream error:", err);
    return res.status(502).json({
      error: "Upstream request failed",
      detail: err.message
    });
  }
};
