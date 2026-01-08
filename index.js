"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ✅ 新增：JWT + 密码hash（纯JS，不会有 native build 坑）
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// ======================================================
// 0) Firebase Admin init (ENV Secret first, then default)
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
      "POST /signup  (email+password -> JWT token)",
      "POST /login   (email+password -> JWT token)",
      "GET  /me     (Authorization: Bearer <JWT or Firebase ID token>)",
      "GET  /orders (Authorization: Bearer <JWT or Firebase ID token>)",
      "POST /orders (Authorization: Bearer <JWT or Firebase ID token>)",
    ].join("\n")
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    version: "ROOT-INDEX-2026-01-08-JWT-LOGIN-ADDON",
    credentialMode: initInfo.mode,
    firebaseProjectIdFromCert: initInfo.projectId,
    hasFirebaseServiceAccountEnv: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    authProjectId: process.env.AUTH_PROJECT_ID || null,
    time: new Date().toISOString(),
  });
});

// ======================================================
// 3) Helper: pick Firestore projectId
// ======================================================
function pickProjectId(fallbackFromToken) {
  return (
    process.env.AUTH_PROJECT_ID ||
    fallbackFromToken ||
    initInfo.projectId ||
    process.env.GCLOUD_PROJECT ||
    null
  );
}

// ======================================================
// 4) Helper: get Firestore bound to a specific project
// ======================================================
function getDbForProject(projectId) {
  const appName = `app-${projectId}`;
  const existing = admin.apps.find((a) => a.name === appName);
  if (existing) return existing.firestore();

  const options = {
    credential: admin.app().options.credential,
    projectId,
  };

  const newApp = admin.initializeApp(options, appName);
  return newApp.firestore();
}

// ======================================================
// 5) JWT helpers
// ======================================================
function requireJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    // 不要把 secret 打印出来
    throw new Error("Missing JWT_SECRET (set it in Cloud Run env vars, length >= 16 recommended)");
  }
  return s;
}

function signJwt(payload) {
  const secret = requireJwtSecret();
  // 7天有效期，你也可以改短一点
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

function verifyJwt(token) {
  const secret = requireJwtSecret();
  return jwt.verify(token, secret);
}

// ======================================================
// 6) Auth middleware (ACCEPTS: JWT OR Firebase ID token)
// ======================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);
    if (!m) {
      return res.status(401).json({ success: false, message: "Missing Bearer token" });
    }

    const token = m[1];

    // ① 先尝试 JWT（你新加的 /login /signup 会发这个）
    try {
      const decodedJwt = verifyJwt(token);

      req.user = {
        uid: decodedJwt.uid,
        email: decodedJwt.email || null,
        name: decodedJwt.name || null,
      };

      req.firebaseProjectId = pickProjectId(null);
      req.authType = "jwt";
      return next();
    } catch (e) {
      // 不是 JWT 或 JWT 过期，就继续尝试 Firebase
    }

    // ② 再尝试 Firebase ID Token（保持兼容）
    const decoded = await admin.auth().verifyIdToken(token);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    // aud 通常是 firebase projectId
    req.firebaseProjectId = pickProjectId(decoded.aud || null);
    req.authType = "firebase";
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
// 7) Users store (Firestore)
//    - Collection: auth_users/{uid}
// ======================================================
async function findUserByEmail(db, email) {
  const snap = await db
    .collection("auth_users")
    .where("email", "==", email)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { uid: doc.id, ...doc.data() };
}

// ======================================================
// 8) POST /signup  (email+password -> JWT)
// ======================================================
app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "");

    if (!e || !e.includes("@")) {
      return res.status(400).json({ success: false, message: "Invalid email" });
    }
    if (!p || p.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 chars" });
    }

    const projectId = pickProjectId(null);
    if (!projectId) {
      return res.status(500).json({ success: false, message: "Cannot determine Firestore projectId" });
    }
    const db = getDbForProject(projectId);

    const existing = await findUserByEmail(db, e);
    if (existing) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const uid = crypto.randomUUID();
    const hash = await bcrypt.hash(p, 10);

    await db.collection("auth_users").doc(uid).set({
      email: e,
      passwordHash: hash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = signJwt({ uid, email: e });
    return res.json({ success: true, token, uid, email: e });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Signup failed",
      error: String(err?.message || err),
    });
  }
});

// ======================================================
// 9) POST /login  (email+password -> JWT)
// ======================================================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "");

    if (!e || !e.includes("@")) {
      return res.status(400).json({ success: false, message: "Invalid email" });
    }
    if (!p) {
      return res.status(400).json({ success: false, message: "Password required" });
    }

    const projectId = pickProjectId(null);
    if (!projectId) {
      return res.status(500).json({ success: false, message: "Cannot determine Firestore projectId" });
    }
    const db = getDbForProject(projectId);

    const user = await findUserByEmail(db, e);
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(p, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = signJwt({ uid: user.uid, email: e });
    return res.json({ success: true, token, uid: user.uid, email: e });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Login failed",
      error: String(err?.message || err),
    });
  }
});

// ======================================================
// 10) /me
// ======================================================
app.get("/me", requireAuth, (req, res) => {
  res.json({
    success: true,
    authType: req.authType,
    user: req.user,
    firebaseProjectId: req.firebaseProjectId,
  });
});

// ======================================================
// 11) Orders API: users/{uid}/orders/{orderId}
// ======================================================
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const projectId = req.firebaseProjectId;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: "Missing project id for Firestore",
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
        message: "Missing project id for Firestore",
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
// 12) 404 fallback
// ======================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
    hint: "Try GET /, GET /health, POST /signup, POST /login, GET /me (auth), GET/POST /orders (auth)",
  });
});

// ======================================================
// 13) Cloud Run listen
// ======================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
