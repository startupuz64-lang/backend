const express = require("express");
const Order = require("../models/Order");
const authMiddleware = require("../middleware/auth");
const { generateQrDataUrl } = require("../utils/qr");

const router = express.Router();

async function annotate(order) {
  return { ...order, qrDataUrl: await generateQrDataUrl(order.qr_token) };
}

// POST /api/orders — savatni buyurtmaga aylantirish
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { items, pickupTime, note } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Savat bo'sh" });
    }
    for (const it of items) {
      if (!it.productId || !Number.isInteger(it.qty) || it.qty <= 0) {
        return res.status(400).json({ message: "Buyurtma tarkibi noto'g'ri" });
      }
    }

    const order = await Order.create({
      customerId: req.user.id,
      items,
      pickupTime: pickupTime || null,
      note: note || "",
    });

    const result = await annotate(order);

    const { notifyOperator, notifyUser } = require("../bot");
    const itemsList = order.items.map((it) => `• ${it.product_name} x${it.qty}`).join("\n");
    notifyOperator(
      `🛍 *Yangi buyurtma!*\n\n${itemsList}\n\n` +
      `💰 Jami: ${Number(order.total_price).toLocaleString()} so'm\n` +
      `⏰ Olib ketish: ${order.pickup_time ? new Date(order.pickup_time).toLocaleString("uz-UZ") : "belgilanmagan"}\n` +
      `👤 Mijoz: ${req.user.name} (${req.user.phone})`
    ).catch(() => {});

    if (req.user.tg_chat_id) {
      notifyUser(req.user.tg_chat_id,
        `✅ *Buyurtmangiz qabul qilindi!*\n\n${itemsList}\n\n` +
        `💰 Jami: ${Number(order.total_price).toLocaleString()} so'm\n\n` +
        `Olib ketishda QR kodingizni operatorga ko'rsating.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/orders/my — o'z buyurtmalarim
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const orders = await Order.findByCustomer(req.user.id);
    const result = await Promise.all(orders.map(annotate));
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/:id — bitta buyurtma
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Buyurtma topilmadi" });
    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ message: "Ruxsat yo'q" });
    }
    res.json(await annotate(order));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/orders/:id — buyurtmani bekor qilish (faqat kutilayotgan)
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Buyurtma topilmadi" });
    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ message: "Ruxsat yo'q" });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: "Bu buyurtmani bekor qilib bo'lmaydi" });
    }
    const cancelled = await Order.cancel(req.params.id);
    res.json({ message: "Bekor qilindi", order: cancelled });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
