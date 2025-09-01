const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize PostgreSQL client
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Connect to the database
async function getDbClient() {
  try {
    await pgClient.connect();
    console.log('Connected to PostgreSQL database from server');
    // Create orders table if it doesn't exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        room VARCHAR(255) NOT NULL,
        items JSONB NOT NULL,
        guestNumber VARCHAR(255),
        status VARCHAR(50) NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pgClient.query(createTableQuery);
    console.log('Orders table ensured');
    return pgClient;
  } catch (err) {
    console.error('Database connection error:', err.stack);
    return null;
  }
}

// Call the connection function on startup
getDbClient();

app.use(cors());
app.use(express.json());
// Serve static files from the 'templates' directory
app.use(express.static(path.join(__dirname, 'templates')));

let baileysClient = null;
let qrCode = null;

/**
 * Set the Baileys client instance for WhatsApp notifications
 * @param {object} client - Baileys socket client instance
 */
function setClient(client) {
  baileysClient = client;
}

/**
 * Set the QR code URL for display in the web interface
 * @param {string} url - The QR code data URL
 */
function setQrCode(url) {
  qrCode = url;
}

/**
 * Get the current QR code URL
 * @returns {string|null} The QR code data URL or null if not available
 */
function getQrCode() {
  return qrCode;
}

// API Endpoint: Get the QR code
app.get('/qr', (req, res) => {
  if (qrCode) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>QR Code</title>
        <style>
          body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; }
          h1 { color: #333; }
          img { max-width: 300px; border: 1px solid #ddd; padding: 10px; border-radius: 8px; }
        </style>
      </head>
      <body>
        <h1>Scan to Connect</h1>
        <img src="${qrCode}" alt="QR Code">
        <p>This page will automatically refresh once the bot is connected.</p>
      </body>
      </html>
    `;
    res.send(html);
  } else {
    res.send('Bot is already connected or QR code is not available yet.');
  }
});

// API Endpoint: Create a new order
app.post('/api/orders', async (req, res) => {
  const { room, items, guestNumber } = req.body;
  if (!room || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Room and items are required.' });
  }

  try {
    const query = 'INSERT INTO orders(room, items, guestNumber, status) VALUES($1, $2, $3, $4) RETURNING *';
    const values = [room, JSON.stringify(items), guestNumber, 'Pending'];
    const result = await pgClient.query(query, values);
    const newOrder = result.rows[0];

    // Notify manager/admin on WhatsApp
    if (baileysClient) {
      const adminJid = '9779819809195@s.whatsapp.net'; // Change to your admin number
      const itemSummary = items.map(i => `${i.quantity} x ${i.name}`).join('\n');
      const summary = `📢 *NEW ORDER*\n🆔 #${newOrder.id}\n🏨 Room: ${newOrder.room}\n🍽 Items:\n${itemSummary}`;
      try {
        await baileysClient.sendMessage(adminJid, { text: summary });
        console.log(`📤 Notified manager of new order #${newOrder.id}`);
      } catch (err) {
        console.error('⚠️ Failed to notify manager via WhatsApp:', err.message);
      }
    }

    res.status(201).json({ success: true, order: newOrder });
  } catch (err) {
    console.error('Error creating order:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Endpoint: Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pgClient.query('SELECT * FROM orders ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Endpoint: Update order status
app.post('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['Pending', 'Confirmed', 'Done', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  try {
    const updateQuery = 'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *';
    const result = await pgClient.query(updateQuery, [status, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = result.rows[0];

    // Notify guest via WhatsApp
    if (baileysClient && order.guestNumber) {
      const itemSummary = order.items.map(i => `${i.quantity} x ${i.name}`).join(', ');
      let msg = '';
      switch (status) {
        case 'Confirmed':
          msg = `✅ Your order #${order.id} for ${itemSummary} has been *confirmed* and is being prepared.`;
          break;
        case 'Done':
          msg = `✅ Your order #${order.id} for ${itemSummary} has been *completed*. Thank you for staying with us!`;
          break;
        case 'Rejected':
          msg = `❌ Your order #${order.id} for ${itemSummary} was *rejected* by the manager. Please contact reception for help.`;
          break;
      }
      if (msg) {
        try {
          await baileysClient.sendMessage(order.guestNumber, { text: msg });
          console.log(`📩 WhatsApp update sent to guest ${order.guestNumber} → ${status}`);
        } catch (err) {
          console.error('⚠️ Failed to notify guest via WhatsApp:', err.message);
        }
      }
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('Error updating order status:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Endpoint: Delete an order
app.delete('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pgClient.query('DELETE FROM orders WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json({ success: true, message: `Order ${id} deleted.` });
  } catch (err) {
    console.error('Error deleting order:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Endpoint: Cleanup orders by statuses
app.delete('/api/orders/cleanup', async (req, res) => {
  try {
    const { statuses } = req.body;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      return res.status(400).json({ error: 'Statuses must be a non-empty array.' });
    }
    const query = `DELETE FROM orders WHERE status = ANY($1::text[])`;
    await pgClient.query(query, [statuses]);
    res.json({ message: `Removed all orders with status: ${statuses.join(', ')}` });
  } catch (error) {
    console.error('Error cleaning up orders:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app and client setters
module.exports = { app, setClient, setQrCode };
