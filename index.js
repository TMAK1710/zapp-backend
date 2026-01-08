const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
app.options("*", cors());

let credentialMode = "unknown";
let firebaseProjectId = null;

// ----------------------
// Firebase Admin init (robust, won't crash silently)
// ----------------------
function tryLoadServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  // Cloud Run 环境变量里经常会把换行搞乱，所以这里尽量“宽容”处理
  // 1) 先直接 parse
  try {
    const obj = JSON.parse(raw);
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  } catch (e1) {
    // 2) 有些人会粘贴成带多余引号的字符串：'"{...}"'
    try {
      const trimmed = raw.trim();
      const unquoted =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
          ? trimmed.slice(1, -1)
          : trimmed;

      const obj = JSON.parse(unquoted);
      if (obj.private_key && typeof obj.private_key === "string") {
        obj.private_key = obj.private_key.replace(/\\n/g, "\n");
      }
      return obj;
    } catch (e2) {
      console.error("[FIREBASE] JSON parse failed:", e1?.message || e1);
      console.error("[FIREBASE] JSON parse failed (retry):", e2?.message || e2);
      return null;
    }
  }
}

function tryLoadServiceAccountFromFile() {
  try {
    // eslint-disable-next-line import/no-dynamic-require
    const obj = require("./serviceAccountKey.json");
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  } catch (e) {
    console.error("[FIREBASE] serviceAccountKey.json not found or invalid:", e?.message || e);
    return null;
  }
}

try {
  const sa = tryLoadServiceAccountFromEnv() || tryLoadServiceAccountFromFile();

  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    credentialMode = sa ? "cert(serviceAccount)" : "unknown";
    firebaseProjectId = sa.project_id || null;
  } else {
    // 兜底：让服务先跑起来（/health 能打开），只是 auth 会失败
    admin.initializeApp();
    credentialMode = "default(application)";
    firebaseProjectId = process.env.GCLOUD_PROJECT || null;
  }
} catch (e) {
  console.error("[FIREBASE] initializeApp crashed:", e?.message || e);
  // 兜底让服务继续跑（不然 Cloud Run 起不来）
  try {
    admin.initializeApp();
    credentialMode = "default(application)-after-crash";
    firebaseProjectId = process.env.GCLOUD_PROJECT || null;
  } catch (e2) {
    console.error("[FIREBASE] fallback initializeApp crashed:", e2?.message || e2);
  }
}

const db = admin.firestore();

// ----------------------
// Routes
// ----------------------
app.get("/", (req, res) => {
  res.status(200).send(
    [
      "zapp-backend is running ✅",
      "",
      "Try:",
      "GET  /health",
      "GET  /me     (need Authorization: Bearer <Firebase ID token>)",
      "GET  /orders (need Authorization)",
      "POST /orders (need Authorization)",
    ].join("\n")
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    version: "ROOT-INDEX-2026-01-08-TEST2-AUD-FIX-ROBUST",
    credentialMode,
    firebaseProjectId,
    time: new Date().toISOString(),
  });
});

// ----------------------
// Auth middleware
// ----------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);

    if (!m) {
      return res.status(401).json({ success: false, message: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(m[1]);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: String(err?.message || err),
      credentialMode,
      firebaseProjectId,
    });
  }
}

app.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get("/orders", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("orders")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: String(err?.message || err),
    });
  }
});

app.post("/orders", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const body = req.body || {};

    const order = {
      ...body,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: body.status || "PLACED",
    };

    const ref = await db.collection("users").doc(uid).collection("orders").add(order);
    res.json({ success: true, orderId: ref.id });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: String(err?.message || err),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// ----------------------
// Cloud Run listen (MUST be 0.0.0.0)
// ----------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on ${PORT}`));

