const { Pool } = require("pg");

let pool;
let _tablesReady = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL .env da topilmadi");

    // channel_binding ni olib tashlaymiz — Neon bilan muammo chiqaradi
    const cleanUrl = url.replace(/[&?]channel_binding=[^&]*/g, "");

    pool = new Pool({
      connectionString: cleanUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Idle client-lardagi kutilmagan xatolar (masalan tarmoq uzilishi) "error"
    // hodisasi sifatida chiqadi — tinglovchi bo'lmasa Node butun jarayonni
    // qulatadi. Shu yerda ushlab, faqat log qilamiz.
    pool.on("error", (err) => {
      console.error("⚠️  PG pool xatosi (idle client):", err.message);
    });
  }
  return pool;
}

function ensureTables() {
  if (!_tablesReady) {
    _tablesReady = initTables(getPool()).catch((err) => {
      _tablesReady = null;
      throw err;
    });
  }
  return _tablesReady;
}

async function connect() {
  await ensureTables();
  return getPool();
}

async function query(text, params) {
  await ensureTables();
  return getPool().query(text, params);
}

// Eski sxemani tekshirish — alohida DROP querylarda (pg multi-statement ishlamaydi)
async function checkAndResetSchema(p) {
  try {
    await p.query("SELECT phone FROM users LIMIT 1");
  } catch (e) {
    if (e.code === "42703" || e.code === "42P01" || e.message.includes("does not exist")) {
      console.log("⚠️  Eski sxema. Yangidan yaratilmoqda...");
      // MUHIM: har birini ALOHIDA query qilish kerak — pg multi-statement bajarmaydi!
      const drops = [
        "DROP TABLE IF EXISTS payment_locks CASCADE",
        "DROP TABLE IF EXISTS tg_tokens     CASCADE",
        "DROP TABLE IF EXISTS payments      CASCADE",
        "DROP TABLE IF EXISTS offers        CASCADE",
        "DROP TABLE IF EXISTS products      CASCADE",
        "DROP TABLE IF EXISTS users         CASCADE",
      ];
      for (const sql of drops) {
        await p.query(sql).catch(() => {});
      }
      console.log("🗑  Eski jadvallar o'chirildi.");
    }
  }
}

// Har bir jadvalni alohida query da yaratamiz — xato bo'lsa qolganlar ishlaydi
async function initTables(p) {
  const run = (sql) => p.query(sql);

  // 0. Sxema versiyasini tekshirish va kerak bo'lsa reset
  await checkAndResetSchema(p);

  // 1. uuid-ossp extension (gen_random_uuid uchun kerak emas, lekin qoldiramiz)
  await run(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(() => {});

  // 2. Users
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(255) NOT NULL DEFAULT '',
      phone       VARCHAR(50)  UNIQUE NOT NULL DEFAULT '',
      telegram    VARCHAR(255) DEFAULT '',
      avatar      TEXT,
      balance     NUMERIC      NOT NULL DEFAULT 0,
      tg_chat_id  BIGINT,
      is_blocked  BOOLEAN      DEFAULT FALSE,
      role        VARCHAR(50)  DEFAULT 'user',
      joined      TIMESTAMPTZ  DEFAULT NOW(),
      created_at  TIMESTAMPTZ  DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // Users — ustunlarni qo'shish (eski DB uchun)
  const userCols = [
    [`tg_chat_id`,  `BIGINT`],
    [`is_blocked`,  `BOOLEAN DEFAULT FALSE`],
    [`role`,        `VARCHAR(50) DEFAULT 'user'`],
    [`balance`,     `NUMERIC NOT NULL DEFAULT 0`],
    [`updated_at`,  `TIMESTAMPTZ DEFAULT NOW()`],
    [`avatar`,      `TEXT`],
    [`telegram`,    `VARCHAR(255) DEFAULT ''`],
  ];
  for (const [col, def] of userCols) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='users' AND column_name='${col}'
        ) THEN ALTER TABLE users ADD COLUMN ${col} ${def}; END IF;
      END $$;
    `).catch(() => {});
  }

  // 3. Products — FK OLMADAN yaratamiz
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name            VARCHAR(255) NOT NULL DEFAULT '',
      category        VARCHAR(50)  NOT NULL DEFAULT 'boshqa',
      price           NUMERIC      NOT NULL DEFAULT 0,
      unit            VARCHAR(50)  NOT NULL DEFAULT 'dona',
      qty             INTEGER      NOT NULL DEFAULT 1,
      condition       VARCHAR(50)  DEFAULT 'Yaxshi',
      viloyat         VARCHAR(255) NOT NULL DEFAULT '',
      tuman           VARCHAR(255) DEFAULT '',
      photo           TEXT,
      photos          TEXT,
      owner_id        UUID,
      status          VARCHAR(30)  DEFAULT 'active',
      approved_by     UUID,
      rejected_reason TEXT,
      is_active       BOOLEAN      DEFAULT TRUE,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // Products FK ni alohida qo'shamiz — agar xato bo'lsa o'tkazib yuboramiz
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='products' AND constraint_name='products_owner_id_fkey'
      ) THEN
        ALTER TABLE products
          ADD CONSTRAINT products_owner_id_fkey
          FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `).catch(() => {});

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='products' AND constraint_name='products_approved_by_fkey'
      ) THEN
        ALTER TABLE products
          ADD CONSTRAINT products_approved_by_fkey
          FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `).catch(() => {});

  // Products ustunlarini qo'shish
  const prodCols = [
    [`photos`,          `TEXT`],
    [`status`,          `VARCHAR(30) DEFAULT 'active'`],
    [`approved_by`,     `UUID`],
    [`rejected_reason`, `TEXT`],
    [`updated_at`,      `TIMESTAMPTZ DEFAULT NOW()`],
    [`view_count`,      `INTEGER NOT NULL DEFAULT 0`],
    [`like_count`,      `INTEGER NOT NULL DEFAULT 0`],
  ];
  for (const [col, def] of prodCols) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='products' AND column_name='${col}'
        ) THEN ALTER TABLE products ADD COLUMN ${col} ${def}; END IF;
      END $$;
    `).catch(() => {});
  }

  // owner_id NOT NULL bo'lsa — drop qilamiz
  await run(`
    DO $$ BEGIN
      ALTER TABLE products ALTER COLUMN owner_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `).catch(() => {});

  // product_likes — kim qaysi postni layk bosgan
  await run(`
    CREATE TABLE IF NOT EXISTS product_likes (
      user_id    UUID        NOT NULL,
      product_id UUID        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, product_id)
    );
  `);

  // 4. Offers
  await run(`
    CREATE TABLE IF NOT EXISTS offers (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id  UUID,
      buyer_id    UUID        NOT NULL,
      seller_id   UUID,
      status      VARCHAR(50) DEFAULT 'pending',
      message     TEXT        DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Offers FK
  const offerFKs = [
    [`offers_product_id_fkey`,  `product_id`,  `products(id)`, `ON DELETE SET NULL`],
    [`offers_buyer_id_fkey`,    `buyer_id`,    `users(id)`,    ``],
    [`offers_seller_id_fkey`,   `seller_id`,   `users(id)`,    `ON DELETE SET NULL`],
  ];
  for (const [name, col, ref, extra] of offerFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='offers' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE offers ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  // 5. Payments
  await run(`
    CREATE TABLE IF NOT EXISTS payments (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      offer_id     UUID        NOT NULL UNIQUE,
      buyer_id     UUID        NOT NULL,
      seller_id    UUID,
      product_id   UUID,
      amount       NUMERIC     NOT NULL DEFAULT 0,
      status       VARCHAR(50) DEFAULT 'pending',
      card_from    VARCHAR(50),
      card_to      VARCHAR(50) NOT NULL DEFAULT '',
      note         TEXT,
      confirmed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Payments FK
  const payFKs = [
    [`payments_offer_id_fkey`,   `offer_id`,   `offers(id)`,   ``],
    [`payments_buyer_id_fkey`,   `buyer_id`,   `users(id)`,    ``],
    [`payments_seller_id_fkey`,  `seller_id`,  `users(id)`,    `ON DELETE SET NULL`],
    [`payments_product_id_fkey`, `product_id`, `products(id)`, `ON DELETE SET NULL`],
  ];
  for (const [name, col, ref, extra] of payFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='payments' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE payments ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  // 6. Payment locks
  await run(`
    CREATE TABLE IF NOT EXISTS payment_locks (
      offer_id  VARCHAR(100) PRIMARY KEY,
      locked_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // 7. Telegram tokens
  await run(`
    CREATE TABLE IF NOT EXISTS tg_tokens (
      token      VARCHAR(20)  PRIMARY KEY,
      user_id    UUID         NOT NULL,
      expires_at TIMESTAMPTZ  NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='tg_tokens' AND constraint_name='tg_tokens_user_id_fkey'
      ) THEN
        ALTER TABLE tg_tokens ADD CONSTRAINT tg_tokens_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `).catch(() => {});

  // 8. Rentals (arenda e'lonlari)
  await run(`
    CREATE TABLE IF NOT EXISTS rentals (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name            VARCHAR(255) NOT NULL DEFAULT '',
      category        VARCHAR(50)  NOT NULL DEFAULT 'boshqa',
      price_per_day   NUMERIC      NOT NULL DEFAULT 0,
      price_per_hour  NUMERIC      NOT NULL DEFAULT 0,
      viloyat         VARCHAR(255) NOT NULL DEFAULT '',
      tuman           VARCHAR(255) DEFAULT '',
      description     TEXT         DEFAULT '',
      photo           TEXT,
      photos          TEXT,
      owner_id        UUID,
      status          VARCHAR(30)  DEFAULT 'pending_approval',
      view_count      INTEGER      NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='rentals' AND constraint_name='rentals_owner_id_fkey'
      ) THEN
        ALTER TABLE rentals ADD CONSTRAINT rentals_owner_id_fkey
          FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `).catch(() => {});

  // 9. Rental bookings
  await run(`
    CREATE TABLE IF NOT EXISTS rental_bookings (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      rental_id    UUID        NOT NULL,
      renter_id    UUID        NOT NULL,
      start_date   DATE        NOT NULL,
      end_date     DATE        NOT NULL,
      total_days   INTEGER     NOT NULL DEFAULT 1,
      total_price  NUMERIC     NOT NULL DEFAULT 0,
      fee          NUMERIC     NOT NULL DEFAULT 0,
      status       VARCHAR(30) DEFAULT 'confirmed',
      note         TEXT        DEFAULT '',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='rental_bookings' AND constraint_name='rental_bookings_rental_id_fkey'
      ) THEN
        ALTER TABLE rental_bookings ADD CONSTRAINT rental_bookings_rental_id_fkey
          FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `).catch(() => {});

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='rental_bookings' AND constraint_name='rental_bookings_renter_id_fkey'
      ) THEN
        ALTER TABLE rental_bookings ADD CONSTRAINT rental_bookings_renter_id_fkey
          FOREIGN KEY (renter_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `).catch(() => {});

  // 10. Settings (feature flags)
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key        VARCHAR(100) PRIMARY KEY,
      value      TEXT         NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  // Default: arenda o'chirilgan (MVP uchun)
  await run(`
    INSERT INTO settings (key, value) VALUES ('arenda_enabled', 'false')
    ON CONFLICT (key) DO NOTHING;
  `).catch(() => {});

  // 11. Orders (mijoz buyurtmalari)
  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID         NOT NULL,
      qr_token      UUID         NOT NULL DEFAULT gen_random_uuid(),
      status        VARCHAR(30)  NOT NULL DEFAULT 'pending',
      total_price   NUMERIC      NOT NULL DEFAULT 0,
      pickup_time   TIMESTAMPTZ,
      note          TEXT         DEFAULT '',
      is_paid       BOOLEAN      DEFAULT FALSE,
      completed_by  UUID,
      completed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  const orderFKs = [
    [`orders_customer_id_fkey`,  `customer_id`,  `users(id)`, ``],
    [`orders_completed_by_fkey`, `completed_by`, `users(id)`, `ON DELETE SET NULL`],
  ];
  for (const [name, col, ref, extra] of orderFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='orders' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE orders ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_qr_token_key'
      ) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_qr_token_key UNIQUE (qr_token);
      END IF;
    END $$;
  `).catch(() => {});

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='orders' AND column_name='pickup_code'
      ) THEN ALTER TABLE orders ADD COLUMN pickup_code VARCHAR(5); END IF;
    END $$;
  `).catch(() => {});

  // 12. Order items
  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id      UUID         NOT NULL,
      product_id    UUID,
      product_name  VARCHAR(255) NOT NULL DEFAULT '',
      unit_price    NUMERIC      NOT NULL DEFAULT 0,
      qty           INTEGER      NOT NULL DEFAULT 1,
      line_total    NUMERIC      NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  const orderItemFKs = [
    [`order_items_order_id_fkey`,   `order_id`,   `orders(id)`,   `ON DELETE CASCADE`],
    [`order_items_product_id_fkey`, `product_id`, `products(id)`, `ON DELETE SET NULL`],
  ];
  for (const [name, col, ref, extra] of orderItemFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='order_items' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE order_items ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  // 13. Offline sales (ilovadan tashqari sotuvlar)
  await run(`
    CREATE TABLE IF NOT EXISTS offline_sales (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id    UUID,
      product_name  VARCHAR(255) NOT NULL DEFAULT '',
      unit_price    NUMERIC      NOT NULL DEFAULT 0,
      qty           INTEGER      NOT NULL DEFAULT 1,
      total_price   NUMERIC      NOT NULL DEFAULT 0,
      operator_id   UUID         NOT NULL,
      note          TEXT         DEFAULT '',
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  const offlineSaleFKs = [
    [`offline_sales_product_id_fkey`,  `product_id`,  `products(id)`, `ON DELETE SET NULL`],
    [`offline_sales_operator_id_fkey`, `operator_id`, `users(id)`,    ``],
  ];
  for (const [name, col, ref, extra] of offlineSaleFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='offline_sales' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE offline_sales ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  // 14. Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_products_status   ON products (status, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_products_owner    ON products (owner_id);`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);`,
    `CREATE INDEX IF NOT EXISTS idx_offers_buyer      ON offers (buyer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_offers_seller     ON offers (seller_id);`,
    `CREATE INDEX IF NOT EXISTS idx_users_tg          ON users (tg_chat_id);`,
    `CREATE INDEX IF NOT EXISTS idx_users_phone       ON users (phone);`,
    `CREATE INDEX IF NOT EXISTS idx_rentals_status    ON rentals (status, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_rentals_owner     ON rentals (owner_id);`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_rental   ON rental_bookings (rental_id);`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_renter   ON rental_bookings (renter_id);`,
    `CREATE INDEX IF NOT EXISTS idx_orders_customer   ON orders (customer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_orders_qr_token   ON orders (qr_token);`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);`,
    `CREATE INDEX IF NOT EXISTS idx_offline_sales_op  ON offline_sales (operator_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_offline_sales_prod ON offline_sales (product_id);`,
  ];
  for (const idx of indexes) {
    await run(idx).catch(() => {});
  }

  console.log("✅ Database jadvallari tayyor");
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { connect, query, withTransaction };
