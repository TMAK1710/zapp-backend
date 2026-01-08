const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ======================
// 0) Firebase Admin init (IMPORTANT)
// ======================
// 推荐方式：用环境变量 FIREBASE_SERVICE_ACCOUNT_JSON（更适合 Cloud Run）
// 备选方式：本地或构建镜像时放一个 serviceAccountKey.json 在同目录
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const obj = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    // Cloud Run 环境变量里常见 "\n" 被转义，需要还原
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  }

  // ⚠️ 如果你不用环境变量，就把你的 key 文件放到项目根目录并命名为 serviceAccountKey.json
  // （注意：不要提交到 GitHub）
  // eslint-disable-next-line import/no-dynamic-require
  return require("./serviceAccountKey.json");
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ======================
// 1) CORS（Flutter Web）
// ======================
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
app.options("*", cors());

// ======================
// 2) Root page
// ======================
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

// ======================
// 3) Health check
// ======================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "zapp-backend",
    version: "ROOT-INDEX-2026-01-08-AUD-FIX1",
    project: serviceAccount.project_id || null,
    time: new Date().toISOString(),
  });
});

// ======================
// 4) Auth middleware
// ======================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);

    if (!m) {
      return res
        .status(401)
        .json({ success: false, message: "Missing Bearer token" });
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
    });
  }
}

// ======================
// 5) /me（需要 token）
// ======================
app.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ======================
// 6) Orders API（users/{uid}/orders/{orderId}）
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

// ======================
// 7) 404 fallback
// ======================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
    hint: "Try GET /, GET /health, GET /me (auth), GET/POST /orders (auth)",
  });
});

// ======================
// 8) Cloud Run listen
// ======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

