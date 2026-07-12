// /api/status.js
// Serverless function backed by Upstash Redis (connected via Vercel Storage tab).
// Uses the plain REST API directly, so no extra npm packages are required.
//
// Env vars expected (auto-injected by Vercel when you connect the Upstash
// integration to this project): KV_REST_API_URL and KV_REST_API_TOKEN
//
// Data model: a single Redis key "call-register:progress" holding a JSON
// object of { [customerId]: { status, note, timestamp } }.

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const PROGRESS_KEY = "call-register:progress";

async function redisCommand(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error (${res.status}): ${text}`);
  }
  return res.json();
}

async function getProgress() {
  const result = await redisCommand(["GET", PROGRESS_KEY]);
  if (!result || result.result == null) return {};
  try {
    return JSON.parse(result.result);
  } catch (e) {
    return {};
  }
}

async function setProgress(progress) {
  await redisCommand(["SET", PROGRESS_KEY, JSON.stringify(progress)]);
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(500).json({
      error: "Storage not configured. Connect Upstash Redis in the Vercel Storage tab and redeploy.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const progress = await getProgress();
      res.status(200).json({ progress });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { customerId, status, note } = body || {};

      if (!customerId || !status) {
        res.status(400).json({ error: "customerId and status are required" });
        return;
      }
      if (status !== "connected" && status !== "not_connected") {
        res.status(400).json({ error: "status must be 'connected' or 'not_connected'" });
        return;
      }

      const progress = await getProgress();
      progress[customerId] = {
        status,
        note: typeof note === "string" ? note.trim() : "",
        timestamp: new Date().toISOString(),
      };
      await setProgress(progress);

      res.status(200).json({ ok: true, progress });
      return;
    }

    if (req.method === "DELETE") {
      // Used to un-skip / clear a single entry if ever needed
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { customerId } = body || {};
      if (!customerId) {
        res.status(400).json({ error: "customerId is required" });
        return;
      }
      const progress = await getProgress();
      delete progress[customerId];
      await setProgress(progress);
      res.status(200).json({ ok: true, progress });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown server error" });
  }
}
