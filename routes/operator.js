const express = require("express");
const { query } = require("../db");
const Product = require("../models/Product");
const Order = require("../models/Order");
const OfflineSale = require("../models/OfflineSale");
const operatorAuth = require("../middleware/operatorAuth");

const router = express.Router();
router.use(operatorAuth);

const MAIN_OPERATOR_PHONE = "331350206";

function isMainOp(user) {
  return (user.phone || "").replace(/\D/g, "").slice(-9) === MAIN_OPERATOR_PHONE;
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ══════════════════════════ Mahsulotlar ══════════════════════════

// ── Barcha mahsulotlar (operator panel) ──────────────────────────
router.get("/products", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const VALID_STATUSES = ["active", "hidden", "deleted"];
    const statusFilter = req.query.status || "all";
    const useStatus = statusFilter !== "all" && VALID_STATUSES.includes(statusFilter);

    let rows;
    if (!q && !useStatus) {
      ({ rows } = await query(
        `SELECT id, name, price, unit, qty, category, status, view_count, like_count, created_at
         FROM products WHERE status != 'deleted'
         ORDER BY created_at DESC LIMIT 100`
      ));
    } else if (!q && useStatus) {
      ({ rows } = await query(
        `SELECT id, name, price, unit, qty, category, status, view_count, like_count, created_at
         FROM products WHERE status = $1
         ORDER BY created_at DESC LIMIT 100`,
        [statusFilter]
      ));
    } else if (q && !useStatus) {
      ({ rows } = await query(
        `SELECT id, name, price, unit, qty, category, status, view_count, like_count, created_at
         FROM products WHERE status != 'deleted' AND name ILIKE $1
         ORDER BY created_at DESC LIMIT 50`,
        [`%${q}%`]
      ));
    } else {
      ({ rows } = await query(
        `SELECT id, name, price, unit, qty, category, status, view_count, like_count, created_at
         FROM products WHERE status = $1 AND name ILIKE $2
         ORDER BY created_at DESC LIMIT 50`,
        [statusFilter, `%${q}%`]
      ));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Yangi mahsulot yaratish ───────────────────────────────────────
router.post("/products", async (req, res) => {
  try {
    const { name, category, price, unit, qty, photo, photos } = req.body;
    if (!name || !price || qty === undefined || qty === null) {
      return res.status(400).json({ message: "Nomi, narxi va soni majburiy" });
    }

    const photosJson = Array.isArray(photos) && photos.length
      ? JSON.stringify(photos)
      : (photo ? JSON.stringify([photo]) : null);

    const product = await Product.create({
      name,
      category: category || "Tortlar",
      price: Number(price),
      unit: unit || "dona",
      qty: Number(qty) || 0,
      photo: photo || (Array.isArray(photos) ? photos[0] : null) || null,
      photos: photosJson,
      owner_id: req.user.id,
      status: "active",
    });

    res.status(201).json({
      ...product,
      photos: product.photos ? JSON.parse(product.photos) : (product.photo ? [product.photo] : []),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Mahsulotni tahrirlash (operator) ─────────────────────────────
router.put("/posts/:id/edit", async (req, res) => {
  try {
    const allowed = ["name", "category", "price", "unit", "qty"];
    const fields = []; const vals = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { fields.push(`${f} = $${vals.length + 1}`); vals.push(req.body[f]); }
    }
    if (!fields.length) return res.status(400).json({ message: "O'zgartiriladigan maydon yo'q" });
    vals.push(req.params.id);
    const { rows } = await query(
      `UPDATE products SET ${fields.join(", ")}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ message: "Mahsulot topilmadi" });
    res.json({ message: "Yangilandi", product: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Mahsulotni yashirish/ko'rsatish/o'chirish ────────────────────
router.put("/posts/:id/hide", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "hidden");
    if (!updated) return res.status(404).json({ message: "Mahsulot topilmadi" });
    res.json({ message: "Yashirildi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/posts/:id/show", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "active");
    if (!updated) return res.status(404).json({ message: "Mahsulot topilmadi" });
    res.json({ message: "Ko'rsatildi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/posts/:id", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "deleted");
    if (!updated) return res.status(404).json({ message: "Mahsulot topilmadi" });
    res.json({ message: "O'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════ Buyurtmalar ══════════════════════════

router.get("/orders", async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const orders = await Order.findByOperatorQueue(status);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/orders/qr/:qrToken", async (req, res) => {
  try {
    const order = await Order.findByQrToken(req.params.qrToken);
    if (!order) return res.status(404).json({ message: "Buyurtma topilmadi" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/orders/code/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").replace(/\D/g, "");
    if (code.length !== 5) return res.status(400).json({ message: "Kod 5 xonali bo'lishi kerak" });
    const order = await Order.findByCode(code);
    if (!order) return res.status(404).json({ message: "Bunday kodli kutilayotgan buyurtma topilmadi" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/orders/:id/complete", async (req, res) => {
  try {
    const { isPaid } = req.body || {};
    const order = await Order.complete(req.params.id, req.user.id, { isPaid });
    if (!order) return res.status(400).json({ message: "Buyurtma allaqachon yakunlangan yoki bekor qilingan" });

    if (order.customer_id) {
      const { rows } = await query("SELECT tg_chat_id FROM users WHERE id = $1", [order.customer_id]);
      if (rows[0]?.tg_chat_id) {
        const { notifyUser } = require("../bot");
        notifyUser(rows[0].tg_chat_id,
          `🎉 *Buyurtmangiz topshirildi!*\n\nRahmat, Dadajon Tort'ni tanlaganingiz uchun!`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }

    res.json({ message: "Buyurtma topshirildi", order });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/orders/:id/cancel", async (req, res) => {
  try {
    const order = await Order.cancel(req.params.id);
    if (!order) return res.status(400).json({ message: "Buyurtmani bekor qilib bo'lmadi" });
    res.json({ message: "Bekor qilindi", order });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════ Oflayn sotuvlar ══════════════════════

router.post("/offline-sales", async (req, res) => {
  try {
    const { productId, qty, note } = req.body;
    if (!productId || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ message: "Mahsulot va son majburiy" });
    }
    const sale = await OfflineSale.create({ productId, qty, operatorId: req.user.id, note });
    res.status(201).json(sale);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/offline-sales", async (req, res) => {
  try {
    const scope = req.query.scope === "all" ? "all" : "mine";
    if (scope === "all" && !isMainOp(req.user)) {
      return res.status(403).json({ message: "Faqat bosh operator barcha oflayn sotuvlarni ko'ra oladi" });
    }
    const sales = scope === "all"
      ? await OfflineSale.findAll()
      : await OfflineSale.findByOperator(req.user.id);
    res.json(sales);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════ Statistika ═══════════════════════════

router.get("/stats/daily", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    let operatorId = null;
    if (!isMainOp(req.user)) {
      operatorId = req.user.id;
    } else if (req.query.operatorId) {
      operatorId = req.query.operatorId;
    }

    const orderStats = await Order.statsDaily(date, operatorId);
    const offlineStats = await OfflineSale.statsDaily(date, operatorId);
    res.json({
      orders: orderStats,
      offline: offlineStats,
      combined: {
        count: orderStats.count + offlineStats.count,
        revenue: orderStats.revenue + offlineStats.revenue,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/stats/by-operator", async (req, res) => {
  if (!isMainOp(req.user)) {
    return res.status(403).json({ message: "Faqat bosh operator uchun" });
  }
  try {
    const { start, end } = todayRange();
    const from = req.query.from ? new Date(req.query.from) : start;
    const to = req.query.to ? new Date(req.query.to) : end;

    const [orderRows, offlineRows, operators] = await Promise.all([
      Order.statsByOperator(from, to),
      OfflineSale.statsByOperator(from, to),
      query(`SELECT id, name, phone FROM users WHERE role = 'operator' OR phone = $1`, [MAIN_OPERATOR_PHONE]),
    ]);

    const byId = {};
    for (const op of operators.rows) {
      byId[op.id] = { operatorId: op.id, name: op.name, appOrders: 0, appRevenue: 0, offlineSales: 0, offlineRevenue: 0 };
    }
    for (const r of orderRows) {
      if (!r.operatorId) continue;
      if (!byId[r.operatorId]) byId[r.operatorId] = { operatorId: r.operatorId, name: "?", appOrders: 0, appRevenue: 0, offlineSales: 0, offlineRevenue: 0 };
      byId[r.operatorId].appOrders = r.orderCount;
      byId[r.operatorId].appRevenue = r.revenue;
    }
    for (const r of offlineRows) {
      if (!byId[r.operatorId]) byId[r.operatorId] = { operatorId: r.operatorId, name: "?", appOrders: 0, appRevenue: 0, offlineSales: 0, offlineRevenue: 0 };
      byId[r.operatorId].offlineSales = r.saleCount;
      byId[r.operatorId].offlineRevenue = r.revenue;
    }

    const result = Object.values(byId).map((o) => ({
      ...o,
      totalRevenue: o.appRevenue + o.offlineRevenue,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/stats/by-product", async (req, res) => {
  try {
    const { start, end } = todayRange();
    const from = req.query.from ? new Date(req.query.from) : start;
    const to = req.query.to ? new Date(req.query.to) : end;

    const [orderRows, offlineRows] = await Promise.all([
      Order.statsByProduct(from, to),
      OfflineSale.statsByProduct(from, to),
    ]);

    const byId = {};
    for (const r of orderRows) {
      const key = r.productId || r.productName;
      byId[key] = { productId: r.productId, productName: r.productName, qty: r.qty, revenue: r.revenue };
    }
    for (const r of offlineRows) {
      const key = r.productId || r.productName;
      if (!byId[key]) byId[key] = { productId: r.productId, productName: r.productName, qty: 0, revenue: 0 };
      byId[key].qty += r.qty;
      byId[key].revenue += r.revenue;
    }
    res.json(Object.values(byId).sort((a, b) => b.revenue - a.revenue));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM products WHERE status = 'active') AS active_products,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
        (SELECT COALESCE(SUM(total_price),0) FROM orders
           WHERE status = 'completed' AND completed_at::date = CURRENT_DATE) AS today_revenue
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════ Foydalanuvchilar ═════════════════════

router.get("/users", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    let rows;
    if (!q) {
      ({ rows } = await query(
        "SELECT id, name, phone, telegram, balance, tg_chat_id, is_blocked, role, joined FROM users ORDER BY joined DESC LIMIT 50"
      ));
    } else {
      ({ rows } = await query(
        `SELECT id, name, phone, telegram, balance, tg_chat_id, is_blocked, role, joined FROM users
         WHERE phone ILIKE $1 OR name ILIKE $1 OR id::text ILIKE $1
         ORDER BY joined DESC LIMIT 30`,
        [`%${q}%`]
      ));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/users/:id/block", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT phone FROM users WHERE id = $1 LIMIT 1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni bloklab bo'lmaydi" });
    }
    await query(
      "UPDATE users SET is_blocked = TRUE WHERE id = $1",
      [req.params.id]
    );
    res.json({ message: "Bloklandi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/users/:id/unblock", async (req, res) => {
  try {
    await query("UPDATE users SET is_blocked = FALSE WHERE id = $1", [req.params.id]);
    res.json({ message: "Blok ochildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const { rows } = await query("SELECT phone FROM users WHERE id = $1 LIMIT 1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni o'chirib bo'lmaydi" });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ message: "O'zingizni o'chira olmaysiz" });
    }
    await Product.setOwnerNull(req.params.id);
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ message: "O'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════ Operatorlar (faqat bosh operator) ═══

router.get("/operators", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, phone, telegram, role, joined FROM users
       WHERE role = 'operator' OR phone = $1 ORDER BY joined ASC`,
      [MAIN_OPERATOR_PHONE]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/operators", async (req, res) => {
  if (!isMainOp(req.user)) {
    return res.status(403).json({ message: "Faqat bosh operator operator qo'sha oladi" });
  }
  try {
    const { identifier, phone } = req.body;
    const search = (identifier || phone || "").trim();
    if (!search) return res.status(400).json({ message: "Telefon yoki ism majburiy" });

    const phoneKey = search.replace(/\D/g, "").slice(-9);
    if (phoneKey === MAIN_OPERATOR_PHONE) {
      return res.status(400).json({ message: "Bosh operator allaqachon operator" });
    }
    let targetUser = null;
    if (phoneKey.length === 9) {
      const { rows: byPhone } = await query(
        "SELECT * FROM users WHERE phone = $1 LIMIT 1", [phoneKey]
      );
      targetUser = byPhone[0] || null;
    }
    if (!targetUser) {
      const { rows: byName } = await query(
        "SELECT * FROM users WHERE name ILIKE $1 ORDER BY joined DESC LIMIT 1",
        [`%${search}%`]
      );
      targetUser = byName[0] || null;
    }
    if (!targetUser) return res.status(404).json({ message: "Foydalanuvchi topilmadi" });

    const { rows: updated } = await query(
      "UPDATE users SET role = 'operator' WHERE id = $1 RETURNING id, name, phone, role",
      [targetUser.id]
    );
    res.json({ message: "Operator qo'shildi", user: updated[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/operators/:id", async (req, res) => {
  if (!isMainOp(req.user)) {
    return res.status(403).json({ message: "Faqat bosh operator operatorni o'chira oladi" });
  }
  try {
    const { rows } = await query("SELECT phone FROM users WHERE id = $1 LIMIT 1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni o'chirib bo'lmaydi" });
    }
    await query("UPDATE users SET role = 'user' WHERE id = $1", [req.params.id]);
    res.json({ message: "Operator o'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
