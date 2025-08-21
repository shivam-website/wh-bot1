const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
// The PORT here is for documentation. The actual listening port is set in index.js.
const PORT = 3000; 
const DB_FILE = path.join(__dirname, 'orders.json');

app.use(cors());
app.use(express.json());
// Serve static files from the 'public' directory (e.g., admin.html)
app.use(express.static(path.join(__dirname, 'templates')));

let baileysClient = null; // Renamed from venomClient for clarity

/**
 * Set the Baileys client instance for WhatsApp notifications
 * @param {object} client - Baileys socket client instance
 */
function setClient(client) {
  baileysClient = client;
}

/**
 * Load orders from JSON file
 * @returns {Array} list of orders
 */
function loadOrders() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '[]', 'utf-8');
  }
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(rawData);
  } catch (err) {
    console.error('Failed to parse orders.json:', err);
    return [];
  }
}

/**
 * Save orders to JSON file
 * @param {Array} orders
 */
function saveOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

// API Endpoint: Create a new order (Typically called by the dashboard, not the bot itself)
app.post('/api/orders', async (req, res) => {
  const { room, items, guestNumber } = req.body;

  if (!room || typeof room !== 'string' || !room.trim()) {
    return res.status(400).json({ error: 'Room is required and must be a non-empty string.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items must be a non-empty array.' });
  }

  const newOrder = {
    id: Date.now(),    // timestamp-based ID
    room: room.trim(),
    items: items.map(i => i.trim()),
    // Ensure guestNumber is in Baileys JID format (e.g., '1234567890@s.whatsapp.net')
    guestNumber: typeof guestNumber === 'string' && guestNumber.trim() ? guestNumber.trim() : null,
    status: 'Pending',
    timestamp: new Date().toISOString(),
  };

  const orders = loadOrders();
  orders.push(newOrder);
  saveOrders(orders);

  // Notify manager/admin on WhatsApp using the Baileys client
  if (baileysClient) {
    const adminJid = '9779819809195@s.whatsapp.net'; // Admin number in Baileys JID format
    const summary = `� *NEW ORDER*\n🆔 #${newOrder.id}\n🏨 Room: ${newOrder.room}\n🍽 Items:\n${newOrder.items.join('\n')}`;
    try {
      // Use baileysClient.sendMessage
      await baileysClient.sendMessage(adminJid, { text: summary }); 
      console.log(`📤 Notified manager of new order #${newOrder.id}`);
    } catch (err) {
      console.error('⚠️ Failed to notify manager via WhatsApp:', err.message);
    }
  }

  res.status(201).json({ success: true, order: newOrder });
});

// API Endpoint: Get all orders
app.get('/api/orders', (req, res) => {
  const orders = loadOrders();
  res.json(orders);
});

// API Endpoint: Update order status (Pending, Confirmed, Done, Rejected)
app.post('/api/orders/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;

  const validStatuses = ['Pending', 'Confirmed', 'Done', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  const orders = loadOrders();
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[index].status = status;
  saveOrders(orders);

  const order = orders[index];
  const guestNumber = order.guestNumber; // This will already be in JID format from index.js

  // Notify guest via WhatsApp using the Baileys client if number exists and is valid JID
  if (baileysClient && guestNumber && guestNumber.endsWith('@s.whatsapp.net')) {
    let msg = '';
    switch (status) {
      case 'Confirmed':
        msg = `✅ Your order #${order.id} for ${order.items.join(', ')} has been *confirmed* and is now being prepared. Please wait.`;
        break;
      case 'Done':
        msg = `✅ Your order #${order.id} for ${order.items.join(', ')} has been *completed*. Thank you for staying with us!`;
        break;
      case 'Rejected':
        msg = `❌ Your order #${order.id} for ${order.items.join(', ')} was *rejected* by the manager. Please contact reception for help.`;
        break;
      default:
        msg = '';
    }
    if (msg) {
      try {
        // Use baileysClient.sendMessage
        await baileysClient.sendMessage(guestNumber, { text: msg });
        console.log(`📩 WhatsApp update sent to guest ${guestNumber} → ${status}`);
      } catch (err) {
        console.error('⚠️ Failed to notify guest via WhatsApp:', err.message);
      }
    }
  }

  res.json({ success: true });
});

// API Endpoint: Delete an order
app.delete('/api/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const orders = loadOrders();

  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders.splice(index, 1);
  saveOrders(orders);

  res.json({ success: true, message: `Order ${id} deleted.` });
});

// API Endpoint: Delete all orders with status 'Done'
app.delete('/api/orders/done', (req, res) => {
  let orders = loadOrders();
  const beforeCount = orders.length;
  orders = orders.filter(order => order.status !== 'Done');
  const removedCount = beforeCount - orders.length;
  saveOrders(orders);

  res.json({ success: true, message: `Removed ${removedCount} done orders.` });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app and client setter
module.exports = { app, setClient };

// IMPORTANT: Removed the app.listen() block here.
// The server should only be started once in index.js.
