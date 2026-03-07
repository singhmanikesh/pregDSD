require("dotenv").config();
const axios = require("axios");
const http = require("http");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");


const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";

if (!process.env.GOOGLE_CLIENT_EMAIL || !PRIVATE_KEY) {
  throw new Error("google-sheet-api.json is missing client_email or private_key");
}

if (!PRIVATE_KEY.includes("BEGIN PRIVATE KEY") || !PRIVATE_KEY.includes("END PRIVATE KEY")) {
  throw new Error("google-sheet-api.json private_key format is invalid (missing PEM markers)");
}

const PORT = 9000;
const HOST = "0.0.0.0";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const SHEET_ID =
  process.env.GOOGLE_SHEET_ID || "1FEB2SbX7AAPLhQxPE7IHmmBGBbYxnNj6iVRPBuavic0";

let sheet;

// Google Auth
const auth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const initSheet = async () => {
  const doc = new GoogleSpreadsheet(SHEET_ID, auth);
  await doc.loadInfo();
  sheet = doc.sheetsByIndex[0];
  console.log("Google Sheet initialized:", sheet.title);
};

const validateGoogleAuth = async () => {
  try {
    await auth.authorize();
    console.info("Google service account JWT verified");
  } catch (err) {
    console.error("Google service account auth failed", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });
    throw err;
  }
};

const MAIL_FROM = process.env.MAIL_FROM || "no-reply@example.com";

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const applyCors = (req, res) => {
  const origin = req.headers.origin;
  const allowAny = ALLOWED_ORIGINS.includes("*");
  const allowedOrigin = allowAny
    ? "*"
    : ALLOWED_ORIGINS.includes(origin)
      ? origin
      : undefined;

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
};

const parseBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });

    req.on("end", () => {
      try {
        const json = raw ? JSON.parse(raw) : {};
        resolve(json);
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });

// check if email exists
const isEmailRegistered = async (email) => {

  if (!sheet) throw new Error("Sheet not initialized");

  try {
    await sheet.loadHeaderRow();
  } catch {
    return false;
  }

  const rows = await sheet.getRows();

  const normalizedEmail = email.trim().toLowerCase();

  console.log("Checking rows:", rows.map(r => r.get("email")));

  const exists = rows.some((row) => {
    const sheetEmail = row.get("email");

    if (!sheetEmail) return false;

    return sheetEmail.trim().toLowerCase() === normalizedEmail;
  });

  return exists;
};

const appendRow = async ({ name, email, phone, gamertag, note }) => {

  if (!sheet) throw new Error("Sheet not initialized");

  const requiredHeaders = ["sl", "name", "email", "phone", "gamertag", "note", "created_at", "created_time"];

  try {
    await sheet.loadHeaderRow();
  } catch {
    await sheet.setHeaderRow(requiredHeaders);
  }

  const rows = await sheet.getRows();
  const sl = rows.length + 1;
  const now = new Date();
  const createdAt = now.toISOString();
  const createdTime = createdAt.replace("T", " ").slice(0, 19);

  await sheet.addRow({
    sl,
    name,
    email,
    phone,
    gamertag,
    note,
    created_at: createdAt,
    created_time: createdTime,
  });
};

const sendConfirmationEmail = async ({ name, email }) => {

  if (!BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not configured");
  }

  console.info("Sending confirmation email via Brevo", {
    to: email,
    sender: MAIL_FROM,
  });

  try {
                  //// mail payload structure based on Brevo API v3 documentation
    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { email: MAIL_FROM, name: "Pre-Registration" },
        to: [{ email, name }],
        subject: "Registration received",
        htmlContent: `<div style="background:#0b0b14;padding:40px;font-family:Arial,Helvetica,sans-serif;color:#ffffff">

  <div style="max-width:600px;margin:auto;background:#111122;border-radius:12px;overflow:hidden;border:1px solid #1f1f3a">

    <!-- Logo -->
    <div style="text-align:center;padding:30px;background:#0f0f1a;border-bottom:1px solid #1c1c35">
      <img src="https://res.cloudinary.com/dqkn02x53/image/upload/v1772852792/RED_600x-100.jpg_n9gymt.jpg" alt="DSD Gaming" style="height:60px;margin-bottom:10px">
      <h2 style="margin:0;color:#ff3c5f;letter-spacing:2px">DSD PREMIUM GAMING CAFE</h2>
    </div>

    <!-- Character -->
    <div style="text-align:center;padding:30px">
      <img 
        src="https://res.cloudinary.com/dqkn02x53/image/upload/v1772852822/elsa_vquveh.jpg"
        alt="Gaming Character"
        style="width:160px;border-radius:12px;margin-bottom:20px"
      >
    </div>

    <!-- Content -->
    <div style="padding:0 40px 30px 40px;text-align:center">

      <h2 style="color:#00ffe1;margin-bottom:10px">
        🎮 Welcome Gamer!
      </h2>

      <p style="font-size:16px;line-height:1.6;color:#d1d1e0">
        Hi <b>{{name}}</b>,
        <br><br>
        Your <span style="color:#ff3c5f">pre-registration</span> for  
        <b>DSD Premium Gaming Café</b> has been received successfully.
      </p>

      <div style="margin:25px 0;padding:15px;background:#15152a;border-radius:8px;border:1px solid #25254a">
        <h3 style="margin:0;color:#ffd93d">🚀 Grand Opening</h3>
        <p style="margin:5px 0 0 0;font-size:18px"><b>13 March</b></p>
      </div>

      <!-- CTA -->
      <a href="https://yourwebsite.com"
        style="display:inline-block;margin-top:10px;padding:12px 28px;background:#ff3c5f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">
        Join the Arena
      </a>

    </div>

    <!-- Footer -->
    <div style="background:#0f0f1a;padding:20px;text-align:center;font-size:12px;color:#8a8aa3">
      <p style="margin:0">
        © 2026 DSD Gaming Café
      </p>
      <p style="margin:4px 0 0 0">
        Power up your gaming experience ⚡
      </p>
    </div>

  </div>

</div>`
      },
      {
        headers: {
          "Content-Type": "application/json",
          "api-key": BREVO_API_KEY,
        },
      }
    );

    console.info("Confirmation email sent", {
      to: email,
      messageId: response?.data?.messageId,
    });

  } catch (err) {

    console.error("Confirmation email failed", {
      message: err?.response?.data || err?.message,
    });

    throw err;
  }
};

const server = http.createServer(async (req, res) => {

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === "/health" && req.method === "GET") {
    return sendJson(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

  if (req.url === "/records" && req.method === "POST") {

    if (!req.headers["content-type"]?.includes("application/json")) {
      return sendJson(res, 415, {
        error: "Content-Type must be application/json",
      });
    }

    try {

      const body = await parseBody(req);

      const { name, email, phone, gamertag, note = "" } = body;

      if (!name || !email || !phone || !gamertag) {
        return sendJson(res, 400, {
          error: "name, email, phone, and gamertag are required",
        });
      }

      const alreadyRegistered = await isEmailRegistered(email);

      if (alreadyRegistered) {
        return sendJson(res, 409, {
          error: "This email is already registered",
        });
      }

      await appendRow({ name, email, phone, gamertag, note });

      try {
        await sendConfirmationEmail({ name, email });
      } catch (emailErr) {

        return sendJson(res, 502, {
          error: "Record saved but email could not be sent",
          detail: emailErr?.message || "Email delivery failed",
        });
      }

      return sendJson(res, 201, { status: "created" });

    } catch (err) {

      const status = err?.message?.includes("Payload too large") ? 413 : 500;

      return sendJson(res, status, {
        error: "Unable to create record",
        detail: err?.message || "Unknown error",
      });
    }
  }

  return sendJson(res, 404, { error: "Not found" });

});

// Guard against unhandled server and promise errors so the process dies with context instead of crashing with an "Unhandled 'error' event" message.
server.on("error", (err) => {
  console.error("HTTP server error", {
    message: err?.message,
    code: err?.code,
    stack: err?.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception", {
    message: err?.message,
    code: err?.code,
    stack: err?.stack,
  });
  process.exit(1);
});

server.listen(PORT, HOST, async () => {

  try {
    await validateGoogleAuth();
    await initSheet();
  } catch (err) {
    console.error("Startup failed", err);
    process.exit(1);
  }

  console.log(`Server running on http://${HOST}:${PORT}`);
});