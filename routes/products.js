const express = require("express");
const authMiddleware = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const { query } = require("../db");

const router = express.Router();

function formatProduct(p, loggedIn = false) {
  return {
    id:           p.id,
    name:         p.name,
    category:     p.category,
    price:        Number(p.price),
    unit:         p.unit,
    qty:          p.qty,
    photo:        p.photo,
    photos:       p.photos ? JSON.parse(p.photos) : (p.photo ? [p.photo] : []),
    status:       p.status || "active",
    createdAt:    p.created_at,
    viewCount:    Number(p.view_count || 0),
    likeCount:    Number(p.like_count || 0),
    isLiked:      p.is_liked || false,
  };
}

// GET /api/products — faqat active mahsulotlar (mehmon + foydalanuvchi)
router.get("/", optionalAuth, async (req, res) => {
  try {
    const { category, search } = req.query;
    const userId = req.user?.id || null;
    const conditions = [`p.status = 'active'`];
    const values = [];
    let i = 1;

    if (category && category !== "Barchasi") {
      conditions.push(`p.category = $${i++}`);
      values.push(category);
    }
    if (search) {
      conditions.push(`p.name ILIKE $${i++}`);
      values.push(`%${search}%`);
    }

    let likeIdx = null;
    if (userId) { likeIdx = i++; values.push(userId); }

    const { rows } = await query(
      `SELECT p.*,
              ${userId ? `EXISTS(SELECT 1 FROM product_likes WHERE user_id=$${likeIdx} AND product_id=p.id) AS is_liked` : `false AS is_liked`}
       FROM products p WHERE ${conditions.join(" AND ")} ORDER BY p.created_at DESC`,
      values
    );
    res.json(rows.map((p) => formatProduct(p, !!req.user?.id)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/liked — foydalanuvchi like bosgan mahsulotlar
router.get("/liked", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.*, true AS is_liked
       FROM products p
       JOIN product_likes pl ON pl.product_id = p.id
       WHERE pl.user_id = $1 AND p.status = 'active'
       ORDER BY pl.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map((p) => formatProduct(p, true)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/:id — bitta mahsulot
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { rows } = await query(
      `SELECT p.*,
              ${userId ? `EXISTS(SELECT 1 FROM product_likes WHERE user_id=$2 AND product_id=p.id) AS is_liked` : `false AS is_liked`}
       FROM products p
       WHERE p.id=$1 LIMIT 1`,
      userId ? [req.params.id, userId] : [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    res.json(formatProduct(rows[0], !!req.user));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/products/:id/view — ko'rishlar sonini oshirish
router.post("/:id/view", async (req, res) => {
  try {
    await query(`UPDATE products SET view_count = view_count + 1 WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/products/:id/like — like toggle
router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT 1 FROM product_likes WHERE user_id=$1 AND product_id=$2`,
      [req.user.id, req.params.id]
    );
    if (rows.length > 0) {
      await query(`DELETE FROM product_likes WHERE user_id=$1 AND product_id=$2`, [req.user.id, req.params.id]);
      await query(`UPDATE products SET like_count = GREATEST(0, like_count - 1) WHERE id=$1`, [req.params.id]);
      res.json({ liked: false });
    } else {
      await query(`INSERT INTO product_likes (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, req.params.id]);
      await query(`UPDATE products SET like_count = like_count + 1 WHERE id=$1`, [req.params.id]);
      res.json({ liked: true });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
