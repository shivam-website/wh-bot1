const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'orders.json');
const MENU_FILE = path.join(__dirname, 'menu-config.json'); // Added menu config file

app.use(cors());
app.use(express.json());
// Serve static files from the 'public' directory (e.g., admin.html)
app.use(express.static(path.join(__dirname, 'templates')));

let baileysClient = null; // WhatsApp client

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

/**
 * Load menu configuration from file
 * @returns {Object} menu configuration
 */
function loadMenuConfig() {
  try {
    if (fs.existsSync(MENU_FILE)) {
      const menuData = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
      return {
        menu: menuData.menu,
        hours: menuData.hours
      };
    }
  } catch (error) {
    console.error('Error loading menu config:', error);
  }
  
  // Fallback to default menu if config file doesn't exist
  return {
    menu: {
      breakfast: ["Continental Breakfast - ₹500", "Full English Breakfast - ₹750", "Pancakes with Maple Syrup - ₹450"],
      lunch: ["Grilled Chicken Sandwich - ₹650", "Margherita Pizza - ₹800", "Vegetable Pasta - ₹550"],
      dinner: ["Grilled Salmon - ₹1200", "Beef Steak - ₹1500", "Vegetable Curry - ₹600"],
      roomService: ["Club Sandwich - ₹450", "Chicken Burger - ₹550", "Chocolate Lava Cake - ₹350"]
    },
    hours: {
      breakfast: "7:00 AM - 10:30 AM",
      lunch: "12:00 PM - 3:00 PM", 
      dinner: "6:30 PM - 11:00 PM",
      roomService: "24/7"
    }
  };
}

// API Endpoint: Create a new order
app.post('/api/orders', async (req, res) => {
  const { room, items, guestNumber } = req.body;

  if (!room || typeof room !== 'string' || !room.trim()) {
    return res.status(400).json({ error: 'Room is required and must be a non-empty string.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items must be a non-empty array.' });
  }

  const newOrder = {
    id: Date.now(),
    room: room.trim(),
    items: items.map(i => {
      if (typeof i === 'string') {
        return { name: i.trim(), quantity: 1 };
      }
      if (typeof i === 'object' && i !== null) {
        return {
          name: (i.name || '').trim(),
          quantity: i.quantity || 1
        };
      }
      return { name: String(i), quantity: 1 };
    }),
    guestNumber: typeof guestNumber === 'string' && guestNumber.trim() ? guestNumber.trim() : null,
    status: 'Pending',
    timestamp: new Date().toISOString(),
  };

  const orders = loadOrders();
  orders.push(newOrder);
  saveOrders(orders);

  // Notify manager/admin on WhatsApp using the Baileys client
  if (baileysClient) {
    const adminJid = '9779819809195@s.whatsapp.net'; // Change to your admin number
    const itemSummary = newOrder.items.map(i => `${i.quantity} x ${i.name}`).join('\n');

    const summary = `📢 *NEW ORDER*\n🆔 #${newOrder.id}\n🏨 Room: ${newOrder.room}\n🍽 Items:\n${itemSummary}`;

    try {
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

// API Endpoint: Update order status
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
  const guestNumber = order.guestNumber;

  // Notify guest via WhatsApp
  if (baileysClient && guestNumber && guestNumber.endsWith('@s.whatsapp.net')) {
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
      default:
        msg = '';
    }

    if (msg) {
      try {
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

// API Endpoint: Cleanup orders by statuses
app.delete('/api/orders/cleanup', async (req, res) => {
  try {
    const { statuses } = req.body; // e.g., ['Done', 'Rejected']
    let orders = loadOrders();

    orders = orders.filter(order => !statuses.includes(order.status));

    saveOrders(orders);
    res.json({ message: `Removed all orders with status: ${statuses.join(', ')}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API Endpoint: Get current menu
app.get('/api/menu', (req, res) => {
  try {
    const menuData = loadMenuConfig();
    res.json(menuData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load menu' });
  }
});

// API Endpoint: Update menu
app.post('/api/menu', (req, res) => {
  try {
    const { menu, hours } = req.body;
    
    // Validate the request
    if (!menu || typeof menu !== 'object' || !hours || typeof hours !== 'object') {
      return res.status(400).json({ error: 'Invalid menu data' });
    }

    // Save to file
    fs.writeFileSync(MENU_FILE, JSON.stringify({ menu, hours }, null, 2));
    
    res.json({ success: true, message: 'Menu updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update menu' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app and client setter
module.exports = { app, setClient };

// NOTE: app.listen() should only be called in index.js
