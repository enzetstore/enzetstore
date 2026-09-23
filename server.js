import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, '[]');
}

function readOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
}

function writeOrders(data) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
}

function makeOrderId() {
  return 'ENZET-' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    crypto.randomBytes(3).toString('hex').toUpperCase();
}

function skuMap() {
  try {
    return JSON.parse(process.env.DIGIFLAZZ_SKU_MAP || '{}');
  } catch {
    return {};
  }
}

function digiflazzSign(refId) {
  return crypto
    .createHash('md5')
    .update(
      (process.env.DIGIFLAZZ_USERNAME || '') +
      (process.env.DIGIFLAZZ_API_KEY || '') +
      refId
    )
    .digest('hex');
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ENZET STORE',
    production:
      String(process.env.MIDTRANS_PRODUCTION).toLowerCase() === 'true'
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    midtransClientKey: process.env.MIDTRANS_CLIENT_KEY || '',
    production:
      String(process.env.MIDTRANS_PRODUCTION).toLowerCase() === 'true'
  });
});

app.post('/api/orders', async (req, res) => {
  try {
    const {
      game,
      playerId,
      serverId,
      nominal,
      price,
      paymentMethod
    } = req.body || {};

    if (
      !game ||
      !playerId ||
      !nominal ||
      !Number.isInteger(price) ||
      price <= 0
    ) {
      return res.status(400).json({
        error: 'Data pesanan belum lengkap.'
      });
    }

    if (!process.env.MIDTRANS_SERVER_KEY) {
      return res.status(500).json({
        error: 'MIDTRANS_SERVER_KEY belum diisi di Render.'
      });
    }

    const orderId = makeOrderId();

    const order = {
      orderId,
      game,
      playerId,
      serverId: serverId || '',
      nominal,
      price,
      paymentMethod: paymentMethod || '',
      status: 'pending',
      topupStatus: 'waiting_payment',
      createdAt: new Date().toISOString()
    };

    const orders = readOrders();
    orders.push(order);
    writeOrders(orders);

    const auth = Buffer
      .from(process.env.MIDTRANS_SERVER_KEY + ':')
      .toString('base64');

    const url =
      String(process.env.MIDTRANS_PRODUCTION).toLowerCase() === 'true'
        ? 'https://app.midtrans.com/snap/v1/transactions'
        : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + auth
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: orderId,
          gross_amount: price
        },
        item_details: [
          {
            id: game + '-' + nominal,
            price,
            quantity: 1,
            name: game + ' ' + nominal
          }
        ],
        custom_field1: playerId,
        custom_field2: serverId || '',
        custom_field3: game + '|' + nominal
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error:
          data.error_messages?.join(', ') ||
          data.status_message ||
          'Midtrans gagal membuat transaksi.'
      });
    }

    const updated = readOrders().map((item) =>
      item.orderId === orderId
        ? {
            ...item,
            snapToken: data.token,
            snapRedirectUrl: data.redirect_url
          }
        : item
    );

    writeOrders(updated);

    res.json({
      ok: true,
      orderId,
      token: data.token,
      redirectUrl: data.redirect_url
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Server error saat membuat pesanan.'
    });
  }
});

app.post('/api/midtrans/notification', async (req, res) => {
  try {
    const notification = req.body || {};

    const expected = crypto
      .createHash('sha512')
      .update(
        String(notification.order_id || '') +
        String(notification.status_code || '') +
        String(notification.gross_amount || '') +
        String(process.env.MIDTRANS_SERVER_KEY || '')
      )
      .digest('hex');

    if (
      !notification.signature_key ||
      expected !== notification.signature_key
    ) {
      return res.status(403).json({
        error: 'Invalid signature'
      });
    }

    const orders = readOrders();

    const index = orders.findIndex(
      (item) => item.orderId === notification.order_id
    );

    if (index < 0) {
      return res.status(200).json({
        ok: true,
        ignored: true
      });
    }

    const order = orders[index];

    const success =
      ['settlement', 'capture'].includes(
        notification.transaction_status
      ) &&
      (!notification.fraud_status ||
        notification.fraud_status === 'accept');

    orders[index] = {
      ...order,
      paymentStatus: notification.transaction_status,
      paymentType: notification.payment_type || '',
      updatedAt: new Date().toISOString()
    };

    if (success && order.topupStatus !== 'success') {
      orders[index].topupStatus = 'processing';

      writeOrders(orders);

      const result = await doDigiflazzTopup(order);

      const fresh = readOrders();

      const index2 = fresh.findIndex(
        (item) => item.orderId === order.orderId
      );

      if (index2 >= 0) {
        fresh[index2].topupStatus = result.status;
        fresh[index2].topupResponse =
          result.data || result.error || null;
        fresh[index2].updatedAt = new Date().toISOString();

        writeOrders(fresh);
      }
    } else {
      writeOrders(orders);
    }

    res.json({
      ok: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Notification error'
    });
  }
});

async function doDigiflazzTopup(order) {
  if (
    !process.env.DIGIFLAZZ_USERNAME ||
    !process.env.DIGIFLAZZ_API_KEY
  ) {
    return {
      status: 'needs_digiflazz_credentials',
      error: 'Isi kredensial Digiflazz.'
    };
  }

  const sku =
    skuMap()[order.game + '|' + order.nominal];

  if (!sku || sku.startsWith('REPLACE_')) {
    return {
      status: 'needs_sku_mapping',
      error:
        'SKU Digiflazz belum dipetakan untuk ' +
        order.game +
        ' | ' +
        order.nominal
    };
  }

  const refId = order.orderId;

  const body = {
    username: process.env.DIGIFLAZZ_USERNAME,
    buyer_sku_code: sku,
    customer_no: order.playerId,
    ref_id: refId,
    sign: digiflazzSign(refId),
    testing:
      String(process.env.DIGIFLAZZ_TESTING).toLowerCase() === 'true'
  };

  const response = await fetch(
    'https://api.digiflazz.com/v1/transaction',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  const status =
    String(data?.data?.status || '').toLowerCase();

  return {
    status:
      status === 'sukses'
        ? 'success'
        : status === 'gagal'
        ? 'failed'
        : status === 'pending'
        ? 'pending'
        : 'unknown',
    data
  };
}

app.get('/api/digiflazz/pricelist', async (req, res) => {
  try {
    if (
      !process.env.DIGIFLAZZ_USERNAME ||
      !process.env.DIGIFLAZZ_API_KEY
    ) {
      return res.status(400).json({
        error: 'Kredensial Digiflazz belum diisi.'
      });
    }

    const sign = crypto
      .createHash('md5')
      .update(
        process.env.DIGIFLAZZ_USERNAME +
        process.env.DIGIFLAZZ_API_KEY +
        'pricelist'
      )
      .digest('hex');

    const response = await fetch(
      'https://api.digiflazz.com/v1/price-list',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cmd: 'prepaid',
          username: process.env.DIGIFLAZZ_USERNAME,
          sign
        })
      }
    );

    const data = await response.json();

    res.status(response.ok ? 200 : 502).json(data);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = readOrders().find(
    (item) => item.orderId === req.params.id
  );

  if (!order) {
    return res.status(404).json({
      error: 'Order tidak ditemukan'
    });
  }

  res.json(order);
});

app.get('*', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(
    `ENZET STORE running at http://localhost:${port}`
  );
});
