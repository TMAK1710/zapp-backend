const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ----------------------
// 0) Firebase Admin init
// 在 Cloud Run（配了服务账号权限）可以直接 admin.initializeApp()
// ----------------------
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ----------------------
// 1) CORS（Flutter Web）
// 作业先用宽松策略，之后再收紧 origin
// ----------------------
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// 让预检请求更稳
app.options("*", cors());

// ----------------------
// 2) Root page (避免 Cannot GET /)
// ----------------------
app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "zapp-backend is running ✅ Try /health, /me (auth), /orders (auth)."
    );
});

// ----------------------
// 3) Health check
// ----------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    time: new Date().toISOString(),
  });
});

// ----------------------
// 4) Auth middleware (verify Firebase ID token)
// ----------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);

    if (!m) {
      return res
        .status(401)
        .json({ success: false, message: "Missing Bearer token" });
    }

    const idToken = m[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
      error: String(err?.message || err),
    });
  }
}

// ----------------------
// 5) /me (你刚才测的接口：需要 token)
// ----------------------
app.get("/me", requireAuth, async (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

// ----------------------
// 6) Orders API (demo)
// Firestore: users/{uid}/orders/{orderId}
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

    const order = {
      ...body,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: body.status || "PLACED",
    };

    const ref = await db
      .collection("users")
      .doc(uid)
      .collection("orders")
      .add(order);

    res.json({ success: true, orderId: ref.id });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: String(err?.message || err),
    });
  }
});

// ----------------------
// 7) 404 fallback (更好看一点)
// ----------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
    hint: "Try GET /, GET /health, GET /me (auth), GET/POST /orders (auth)",
  });
});

// ----------------------
// 8) Cloud Run listen
// ----------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
