"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ----------------------
// Firebase Admin init
// ----------------------
admin.initializeApp();
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

// ----------------------
// Helpers
// ----------------------
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";

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

    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: String(err?.message || err),
    });
  }
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
    time: new Date().toISOString(),
  });
});

app.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ✅ Orders: users/{uid}/orders
app.get("/orders", requireAuth, async (req, res) => {
  try {
    if (!FIREBASE_PROJECT_ID) {
      return res.status(500).json({
        success: false,
        message: "Cannot determine Firestore projectId (set FIREBASE_PROJECT_ID in Cloud Run env vars)",
      });
    }

    const db = admin.firestore();
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
    if (!FIREBASE_PROJECT_ID) {
      return res.status(500).json({
        success: false,
        message: "Cannot determine Firestore projectId (set FIREBASE_PROJECT_ID in Cloud Run env vars)",
      });
    }

    const db = admin.firestore();
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

