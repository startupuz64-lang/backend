const { query, withTransaction } = require("../db");

function attachItems(order, items) {
  return { ...order, items };
}

function randomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

async function generateUniquePickupCode(client) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const { rows } = await client.query(
      `SELECT 1 FROM orders WHERE pickup_code = $1 AND status = 'pending'`,
      [code]
    );
    if (!rows[0]) return code;
  }
  return randomCode();
}

const Order = {
  async create({ customerId, items, pickupTime, note }) {
    return withTransaction(async (client) => {
      const lineItems = [];
      let totalPrice = 0;

      for (const item of items) {
        const { rows } = await client.query(
          `SELECT id, name, price, qty, status FROM products WHERE id = $1 FOR UPDATE`,
          [item.productId]
        );
        const product = rows[0];
        if (!product) throw new Error("Mahsulot topilmadi");
        if (product.status !== "active") throw new Error(`"${product.name}" hozir mavjud emas`);
        if (product.qty < item.qty) {
          throw new Error(`"${product.name}" dan omborda faqat ${product.qty} ta qoldi`);
        }

        await client.query(
          `UPDATE products SET qty = qty - $1, updated_at = NOW() WHERE id = $2`,
          [item.qty, product.id]
        );

        const lineTotal = Number(product.price) * item.qty;
        totalPrice += lineTotal;
        lineItems.push({
          productId: product.id,
          productName: product.name,
          unitPrice: product.price,
          qty: item.qty,
          lineTotal,
        });
      }

      const pickupCode = await generateUniquePickupCode(client);
      const { rows: orderRows } = await client.query(
        `INSERT INTO orders (customer_id, pickup_time, total_price, note, pickup_code)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [customerId, pickupTime || null, totalPrice, note || "", pickupCode]
      );
      const order = orderRows[0];

      const savedItems = [];
      for (const li of lineItems) {
        const { rows } = await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, qty, line_total)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [order.id, li.productId, li.productName, li.unitPrice, li.qty, li.lineTotal]
        );
        savedItems.push(rows[0]);
      }

      return attachItems(order, savedItems);
    });
  },

  async _itemsFor(orderId) {
    const { rows } = await query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       WHERE o.id = $1 LIMIT 1`,
      [id]
    );
    const order = rows[0];
    if (!order) return null;
    return attachItems(order, await this._itemsFor(order.id));
  },

  async findByQrToken(token) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       WHERE o.qr_token = $1 LIMIT 1`,
      [token]
    );
    const order = rows[0];
    if (!order) return null;
    return attachItems(order, await this._itemsFor(order.id));
  },

  async findByCode(code) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       WHERE o.pickup_code = $1 AND o.status = 'pending' LIMIT 1`,
      [code]
    );
    const order = rows[0];
    if (!order) return null;
    return attachItems(order, await this._itemsFor(order.id));
  },

  async findByCustomer(customerId) {
    const { rows } = await query(
      `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId]
    );
    const out = [];
    for (const order of rows) {
      out.push(attachItems(order, await this._itemsFor(order.id)));
    }
    return out;
  },

  async findByOperatorQueue(status = "pending") {
    const where = status === "all" ? "" : "WHERE o.status = $1";
    const values = status === "all" ? [] : [status];
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       ${where}
       ORDER BY o.created_at ASC`,
      values
    );
    const out = [];
    for (const order of rows) {
      out.push(attachItems(order, await this._itemsFor(order.id)));
    }
    return out;
  },

  async complete(id, operatorId, { isPaid } = {}) {
    const { rows } = await query(
      `UPDATE orders
       SET status = 'completed', completed_by = $1, completed_at = NOW(),
           is_paid = COALESCE($2, is_paid), updated_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [operatorId, isPaid === undefined ? null : isPaid, id]
    );
    const order = rows[0];
    if (!order) return null;
    return attachItems(order, await this._itemsFor(order.id));
  },

  async cancel(id) {
    return withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(
        `SELECT * FROM orders WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [id]
      );
      const order = orderRows[0];
      if (!order) return null;

      const { rows: items } = await client.query(
        `SELECT * FROM order_items WHERE order_id = $1`,
        [id]
      );
      for (const item of items) {
        if (item.product_id) {
          await client.query(
            `UPDATE products SET qty = qty + $1, updated_at = NOW() WHERE id = $2`,
            [item.qty, item.product_id]
          );
        }
      }

      const { rows: updated } = await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );
      return attachItems(updated[0], items);
    });
  },

  async statsDaily(date, operatorId) {
    const conditions = [`status = 'completed'`, `completed_at::date = $1`];
    const values = [date];
    if (operatorId) {
      conditions.push(`completed_by = $2`);
      values.push(operatorId);
    }
    const { rows } = await query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_price),0) AS revenue
       FROM orders WHERE ${conditions.join(" AND ")}`,
      values
    );
    return { count: Number(rows[0].count), revenue: Number(rows[0].revenue) };
  },

  async statsByOperator(from, to) {
    const { rows } = await query(
      `SELECT completed_by AS operator_id, COUNT(*) AS order_count,
              COALESCE(SUM(total_price),0) AS revenue
       FROM orders
       WHERE status = 'completed' AND completed_at BETWEEN $1 AND $2
       GROUP BY completed_by`,
      [from, to]
    );
    return rows.map((r) => ({
      operatorId: r.operator_id,
      orderCount: Number(r.order_count),
      revenue: Number(r.revenue),
    }));
  },

  async statsByProduct(from, to) {
    const { rows } = await query(
      `SELECT oi.product_id, oi.product_name,
              SUM(oi.qty) AS qty, COALESCE(SUM(oi.line_total),0) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'completed' AND o.completed_at BETWEEN $1 AND $2
       GROUP BY oi.product_id, oi.product_name
       ORDER BY revenue DESC`,
      [from, to]
    );
    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      qty: Number(r.qty),
      revenue: Number(r.revenue),
    }));
  },
};

module.exports = Order;
