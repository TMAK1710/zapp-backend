"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ======================================================
// 0) Firebase Admin init (ENV Secret first, then default)
//    - Reads service account JSON from env: FIREBASE_SERVICE_ACCOUNT
// ======================================================
function initFirebaseAdmin() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (sa) {
    try {
      const serviceAccountObj = JSON.parse(sa);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountObj),
      });

      console.log("✅ Firebase Admin initialized with cert from ENV (FIREBASE_SERVICE_ACCOUNT)");
      return { mode: "cert(serviceAccount)", projectId: serviceAccountObj.project_id || null };
    } catch (e) {
      console.error("❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON, fallback to default:", e);
      // fallback below
    }
  }

  admin.initializeApp();
  console.log("⚠️ Firebase Admin initialized with default application credentials");
  return { mode: "default(application)", projectId: null };
}

const initInfo = initFirebaseAdmin();

// ======================================================
// 1) Express + CORS
// ======================================================
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

// ======================================================
// 2) Root + Health
// ======================================================
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
    version: "ROOT-INDEX-2026-01-08-FIRESTORE-AUD-AUTO3",
    credentialMode: initInfo.mode,
    firebaseProjectIdFromCert: initInfo.projectId,
    hasFirebaseServiceAccountEnv: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    time: new Date().toISOString(),
  });
});

// ======================================================
// 3) Helper: get Firestore bound to a specific project
//    - If the service account is from project A but Firestore is in project B,
//      you MUST point Firestore to the right projectId.
// ======================================================
function getDbForProject(projectId) {
  // admin.firestore() uses the app default.
  // To force project, we can create an App instance per project if needed.
  // But simplest & robust: use Firestore client options via initializeApp with projectId.
  //
  // Since we already initialized default app, we create/reuse a named app
  // bound to projectId when project mismatch happens.
  const appName = `app-${projectId}`;

  // Reuse if exists
  const existing = admin.apps.find((a) => a.name === appName);
  if (existing) return existing.firestore();

  // Create a new app with same credential but forced projectId
  // If we used ENV cert => we can reuse the same credential object.
  // If default creds => still can set projectId; GCP will use ADC.
  const options = {
    credential: admin.app().options.credential,
    projectId,
  };

  const newApp = admin.initializeApp(options, appName);
  return newApp.firestore();
}

// ======================================================
// 4) Auth middleware
//    - Verify Firebase ID token
//    - Extract aud as firebaseProjectId
// ======================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);

    if (!m) {
      return res.status(401).json({ success: false, message: "Missing Bearer token" });
    }

    const idToken = m[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    // aud usually equals Firebase project id (e.g. test2-authentication-b81c3)
    req.firebaseProjectId = decoded.aud || null;

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: String(err?.message || err),
    });
  }
}

// ======================================================
// 5) /me
// ======================================================
app.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user, firebaseProjectId: req.firebaseProjectId });
});

// ======================================================
// 6) Orders API: users/{uid}/orders/{orderId}
//    - Use Firestore bound to token's aud projectId (most robust)
// ======================================================
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const projectId = req.firebaseProjectId;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: "Missing firebase project id (aud) in token",
      });
    }

    const db = getDbForProject(projectId);

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
    const projectId = req.firebaseProjectId;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: "Missing firebase project id (aud) in token",
      });
    }

    const db = getDbForProject(projectId);

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

// ======================================================
// 7) 404 fallback
// ======================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
    hint: "Try GET /, GET /health, GET /me (auth), GET/POST /orders (auth)",
  });
});

// ======================================================
// 8) Cloud Run listen
// ======================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
