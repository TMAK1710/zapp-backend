const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ======================
// 0) Firebase Admin init
// Cloud Run 使用服务账号权限即可
// ======================
admin.initializeApp();
const db = admin.firestore();

// ======================
// 1) App init
// ======================
const app = express();
app.use(express.json({ limit: "1mb" }));

// ======================
// 2) CORS（Flutter Web 友好）
// ======================
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// 预检请求
app.options("*", cors());

// ======================
// 3) Root page（避免 Cannot GET /）
// ======================
app.get("/", (req, res) => {
  res.status(200).send(
    "zapp-backend is running ✅\n\n" +
      "Available routes:\n" +
      "GET  /health\n" +
      "GET  /me        (auth)\n" +
      "GET  /orders    (auth)\n" +
      "POST /orders    (auth)\n"
  );
});

// ======================
// 4) Health check
// ======================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    time: new Date().toISOString(),
  });
});

// ======================
// 5) Auth middleware
// ======================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Missing Bearer token",
      });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    next();
  } catch (err) {
    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: String(err?.message || err),
    });
  }
}

// ======================
// 6) /me（测试登录是否成功）
// ======================
app.get("/me", requireAuth, (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

// ======================
// 7) Orders API
// Firestore: users/{uid}/orders/{orderId}
// ======================
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

    const orders = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

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
      status: body.status || "PLACED",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db
      .collection("users")
      .doc(uid)
      .collection("orders")
      .add(order);

    res.json({
      success: true,
      orderId: ref.id,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: String(err?.message || err),
    });
  }
});

// ======================
// 8) 404 fallback
// ======================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
    hint: "Try GET /, GET /health, GET /me (auth), GET/POST /orders (auth)",
  });
});

// ======================
// 9) Cloud Run listen
// ======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(` zapp-backend listening on port ${PORT}`);
});
