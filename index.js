"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ----------------------
// Firebase Admin init
// ----------------------
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ----------------------
// CORS (Flutter Web)
// ----------------------
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
app.options("*", cors());

// ----------------------
// Env
// ----------------------
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// ----------------------
// Helpers
// ----------------------
function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isStrongEnoughPassword(pw) {
  return typeof pw === "string" && pw.length >= 6;
}

function signJwt(payload) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not set on server");
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function parseBearer(req) {
  const authHeader = req.headers.authorization || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Dual auth:
// 1) Firebase ID token (keeps compatibility with older builds)
// 2) Server JWT (used by this Flutter http project)
async function requireAuth(req, res, next) {
  const token = parseBearer(req);
  if (!token) return res.status(401).json({ success: false, message: "Missing Bearer token" });

  // A) Try Firebase token first
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      authType: "firebase",
    };
    return next();
  } catch (_) {
    // continue
  }

  // B) Try JWT
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({
        success: false,
        message: "JWT_SECRET is missing on server (set it in Cloud Run env vars)",
      });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      authType: "jwt",
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: String(err?.message || err),
    });
  }
}

function normalizeItems(items) {
  // Accept either:
  // A) [{name, price, qty}]  (current frontend)
  // B) [{itemId, qty}]       (future)
  if (!Array.isArray(items) || items.length === 0) return { error: "items must be a non-empty array" };

  const normalized = [];
  for (const it of items) {
    if (!it || typeof it !== "object") return { error: "each item must be an object" };

    const name = String(it.name || it.itemId || "").trim();
    const qty = Number(it.qty);
    const price = Number(it.price);

    if (!name) return { error: "item name (or itemId) is required" };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) return { error: "qty must be 1..99" };

    // current frontend sends price; if missing, keep 0 (you can upgrade to server menu later)
    const safePrice = Number.isFinite(price) ? price : 0;

    normalized.push({
      name,
      price: safePrice,
      qty,
      lineTotal: safePrice * qty,
    });
  }

  return { items: normalized };
}

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
      "POST /signup",
      "POST /login",
      "GET  /me     (auth)",
      "GET  /orders (auth)",
      "POST /orders (auth)",
    ].join("\n")
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    firebaseProjectId: FIREBASE_PROJECT_ID || "(missing)",
    jwtEnabled: Boolean(JWT_SECRET),
    time: new Date().toISOString(),
  });
});

// ----------------------
// Auth (JWT)
// ----------------------
// POST /signup  { email, password }
app.post("/signup", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;

    if (!email) return res.status(400).json({ success: false, message: "email is required" });
    if (!isStrongEnoughPassword(password)) {
      return res.status(400).json({ success: false, message: "password must be at least 6 characters" });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ success: false, message: "Server missing JWT_SECRET" });
    }

    // Prevent duplicate email: userEmails/{email} -> {uid}
    const emailRef = db.collection("userEmails").doc(email);
    const existing = await emailRef.get();
    if (existing.exists) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const userRef = db.collection("users").doc();
    const uid = userRef.id;

    await db.runTransaction(async (t) => {
      const emailSnap = await t.get(emailRef);
      if (emailSnap.exists) throw new Error("Email already registered");

      t.set(emailRef, {
        uid,
        email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(userRef, {
        email,
        passwordHash,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const token = signJwt({ uid, email });
    return res.json({ success: true, token, user: { uid, email } });
  } catch (err) {
    const msg = String(err?.message || err);
    const code = msg.includes("already registered") ? 409 : 500;
    return res.status(code).json({ success: false, message: "Signup failed", error: msg });
  }
});

// POST /login  { email, password }
app.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "email and password are required" });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ success: false, message: "Server missing JWT_SECRET" });
    }

    const emailDoc = await db.collection("userEmails").doc(email).get();
    if (!emailDoc.exists) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const uid = emailDoc.data().uid;
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const user = userSnap.data() || {};
    const ok = await bcrypt.compare(password, String(user.passwordHash || ""));
    if (!ok) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const token = signJwt({ uid, email });
    return res.json({ success: true, token, user: { uid, email } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Login failed", error: String(err?.message || err) });
  }
});

app.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ----------------------
// Orders: users/{uid}/orders
// ----------------------
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

    const normalized = normalizeItems(body.items);
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error });
    }

    const items = normalized.items;
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);

    // same as frontend taxRate = 0.06
    const taxRate = 0.06;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    const order = {
      uid,
      items,
      subtotal,
      tax,
      total,
      status: body.status || "PLACED",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// Cloud Run listen
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

