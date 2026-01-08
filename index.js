const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ----------------------
// 0) Firebase Admin init
// Cloud Run 上推荐直接这样：使用默认服务账号
// ----------------------
admin.initializeApp();

const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ----------------------
// 1) CORS（Flutter Web）
// 先用宽松策略保证能跑；作业交完再收紧
// ----------------------
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// ----------------------
// 2) Health check
// ----------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "zapp-backend", time: new Date().toISOString() });
});

// ----------------------
// 3) Auth middleware (verify Firebase ID token)
// ----------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);
    if (!m) {
      return res.status(401).json({ success: false, message: "Missing Bearer token" });
    }

    const idToken = m[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    // 把用户信息挂到 req 上，后面接口用
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
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
// 4) Orders API (demo)
// Firestore 结构：users/{uid}/orders/{orderId}
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
    res.status(500).json({ success: false, message: "Failed to fetch orders", error: String(err) });
  }
});

app.post("/orders", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // 你 Flutter 端可以传：items, subtotal, tax, total, tableNo 等
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
    res.status(500).json({ success: false, message: "Failed to create order", error: String(err) });
  }
});

// ----------------------
// 5) Cloud Run listen
// ----------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
