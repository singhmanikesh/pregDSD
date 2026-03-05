require("dotenv").config();
const http = require("http");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const nodemailer = require("nodemailer");

const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!process.env.GOOGLE_CLIENT_EMAIL || !PRIVATE_KEY) {
  throw new Error("google-sheet-api.json is missing client_email or private_key");
}

if (!PRIVATE_KEY.includes("BEGIN PRIVATE KEY") || !PRIVATE_KEY.includes("END PRIVATE KEY")) {
  throw new Error("google-sheet-api.json private_key format is invalid (missing PEM markers)");
}

const PORT = 5000;
const HOST = "0.0.0.0";

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

const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || process.env.MAIL_FROM;
const SMTP_PASS = process.env.SMTP_PASS || process.env.BREVO_API_KEY;

const mailTransport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  logger: true,
  debug: true,
});

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
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

const appendRow = async ({ name, email, note }) => {

  if (!sheet) throw new Error("Sheet not initialized");

  const requiredHeaders = ["name", "email", "note", "created_at"];

  try {
    await sheet.loadHeaderRow();
  } catch {
    await sheet.setHeaderRow(requiredHeaders);
  }

  await sheet.addRow({
    name,
    email,
    note,
    created_at: new Date().toISOString(),
  });
};

const sendConfirmationEmail = async ({ name, email }) => {

  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP credentials are not configured");
  }

  const senderEmail = process.env.MAIL_FROM || SMTP_USER || "no-reply@example.com";

  console.info("Sending confirmation email", {
    to: email,
    sender: senderEmail,
    transport: SMTP_HOST,
    port: SMTP_PORT,
  });

  try {
    const info = await mailTransport.sendMail({
      from: { address: senderEmail, name: "Pre-Registration" },
      sender: senderEmail,
      to: [{ address: email, name }],
      subject: "Registration received",
      html: `<div style="background:#0f0f17;padding:30px;font-family:Arial;">
        <h2 style="color:#ff3c5f">🎮 DSD Premium Gaming Café</h2>
        <p>Hi <b>${name || "Gamer"}</b>,</p>
        <p>Your pre-registration has been received successfully.</p>
        <p><b>Grand Opening: 13 March</b></p>
      </div>`
    });

    console.info("Confirmation email sent", {
      to: email,
      messageId: info?.messageId,
    });

  } catch (err) {

    console.error("Confirmation email failed", {
      message: err?.message,
      code: err?.code
    });

    throw err;
  }
};

const server = http.createServer(async (req, res) => {

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

      const { name, email, note = "" } = body;

      if (!name || !email) {
        return sendJson(res, 400, {
          error: "name and email are required",
        });
      }

      const alreadyRegistered = await isEmailRegistered(email);

      if (alreadyRegistered) {
        return sendJson(res, 409, {
          error: "This email is already registered",
        });
      }

      await appendRow({ name, email, note });

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

server.listen(PORT, HOST, async () => {

  try {
    await validateGoogleAuth();
    await initSheet();
  } catch (err) {
    console.error("Startup failed", err);
    process.exit(1);
  }

  mailTransport.verify((err, success) => {
    if (err) {
      console.error("SMTP verify failed", err);
    } else {
      console.info("SMTP connection verified", success);
    }
  });

  console.log(`Server running on http://${HOST}:${PORT}`);
});