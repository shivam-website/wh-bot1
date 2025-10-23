const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Management System",
  superAdmin: {
    username: "superadmin",
    password: "admin123" // In production, use environment variables
  },
  databaseDir: path.join(__dirname, 'data'),
  checkInTime: "2:00 PM",
  checkOutTime: "11:00 AM"
};

// Ensure data directory exists
if (!fs.existsSync(hotelConfig.databaseDir)) {
  fs.mkdirSync(hotelConfig.databaseDir, { recursive: true });
}

// Global maps to store active clients and user states
const activeClients = new Map(); // phone -> client
const clientStates = new Map(); // phone -> { isConnected, isDestroying }
const userStates = new Map(); // phone -> user state
const processedMessageIds = new Set();
const hotelQRs = new Map(); // phone -> QR data

/**
 * Hotel data management functions
 */
function getHotelsFilePath() {
  return path.join(hotelConfig.databaseDir, 'hotels.json');
}

function getOrdersFilePath(phone) {
  return path.join(hotelConfig.databaseDir, `orders_${phone}.json`);
}

function getMenuFilePath(phone) {
  return path.join(hotelConfig.databaseDir, `menu_${phone}.json`);
}

function loadHotels() {
  const filePath = getHotelsFilePath();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([]));
    return [];
  }
  try {
    const rawData = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(rawData);
  } catch (err) {
    console.error('Failed to parse hotels.json:', err);
    return [];
  }
}

function saveHotels(hotels) {
  const filePath = getHotelsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(hotels, null, 2), 'utf-8');
}

function loadOrders(phone) {
  const filePath = getOrdersFilePath(phone);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }
  try {
    const rawData = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(rawData);
  } catch (err) {
    console.error(`Failed to parse orders for ${phone}:`, err);
    return [];
  }
}

function saveOrders(phone, orders) {
  const filePath = getOrdersFilePath(phone);
  fs.writeFileSync(filePath, JSON.stringify(orders, null, 2), 'utf-8');
}

function loadMenuConfig(phone) {
  const filePath = getMenuFilePath(phone);
  try {
    if (fs.existsSync(filePath)) {
      const menuData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        menu: menuData.menu,
        hours: menuData.hours,
        categories: menuData.categories || Object.keys(menuData.menu)
      };
    }
  } catch (error) {
    console.error(`Error loading menu config for ${phone}:`, error);
  }

  // Fallback to default menu
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
    },
    categories: ["breakfast", "lunch", "dinner", "roomService"]
  };
}

function saveMenuConfig(phone, menuData) {
  const filePath = getMenuFilePath(phone);
  fs.writeFileSync(filePath, JSON.stringify(menuData, null, 2));
}

/**
 * Get fresh menu items for a specific hotel
 */
function getAllMenuItems(phone) {
  const currentMenuConfig = loadMenuConfig(phone);

  return Object.values(currentMenuConfig.menu)
    .flat()
    .map(item => {
      const parts = item.split(' - ');
      const name = parts[0] ? parts[0].trim() : 'Unknown Item';
      let price = 0;

      if (parts[1]) {
        const priceMatch = parts[1].match(/\d+/);
        if (priceMatch) {
          price = parseInt(priceMatch[0]);
        }
      }

      return {
        name: name.toLowerCase(),
        full_name: name,
        price: price,
        category: Object.keys(currentMenuConfig.menu).find(
          category => currentMenuConfig.menu[category].includes(item)
        )
      };
    })
    .filter(item => item.name !== 'unknown item');
}

// Express app setup
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Authentication middleware
function authenticateHotel(req, res, next) {
  // Allow login endpoints without authentication
  if (req.path === '/api/superadmin/login' || req.path === '/api/hotel/login') {
    return next();
  }

  // For other endpoints, check authentication
  let authData = {};
  
  if (req.method === 'GET') {
    // For GET requests, check query parameters
    authData = {
      phone: req.query.phone,
      username: req.query.username,
      password: req.query.password
    };
  } else {
    // For POST/PUT/DELETE requests, check body
    authData = req.body;
  }

  const { phone, username, password } = authData;

  if (phone && username && password) {
    const hotels = loadHotels();
    const hotel = hotels.find(h => 
      h.phone === phone && 
      h.username === username && 
      bcrypt.compareSync(password, h.password)
    );
    
    if (hotel) {
      req.hotel = hotel;
      return next();
    }
  }
  
  res.status(401).json({ error: 'Authentication failed' });
}

// Super Admin Routes
app.post('/api/superadmin/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === hotelConfig.superAdmin.username && password === hotelConfig.superAdmin.password) {
    res.json({ success: true, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/superadmin/hotels', (req, res) => {
  const hotels = loadHotels().map(hotel => {
    const clientState = clientStates.get(hotel.phone);
    const isConnected = clientState ? clientState.isConnected : false;
    return {
      ...hotel,
      botStatus: isConnected ? 'connected' : 'disconnected',
      password: undefined // Remove password from response
    };
  });
  res.json(hotels);
});

app.post('/api/superadmin/hotels', (req, res) => {
  const { hotelName, username, password, phone } = req.body;
  
  if (!hotelName || !username || !password || !phone) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  const hotels = loadHotels();
  
  // Check if username or phone already exists
  if (hotels.find(h => h.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  if (hotels.find(h => h.phone === phone)) {
    return res.status(400).json({ error: 'Phone number already registered' });
  }
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  const newHotel = {
    id: Date.now(),
    hotelName,
    username,
    password: hashedPassword,
    phone,
    createdAt: new Date().toISOString(),
    botConnected: true // Auto-connect on creation
  };
  
  hotels.push(newHotel);
  saveHotels(hotels);
  
  // Auto-start bot for new hotel
  startBotForHotel(phone, hotelName);
  
  res.json({ success: true, hotel: { ...newHotel, password: undefined } });
});

app.put('/api/superadmin/hotels/:id', (req, res) => {
  const { id } = req.params;
  const { hotelName, username, password, phone } = req.body;
  
  const hotels = loadHotels();
  const hotelIndex = hotels.findIndex(h => h.id === parseInt(id));
  
  if (hotelIndex === -1) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  // Check if username or phone already exists (excluding current hotel)
  if (hotels.find((h, index) => index !== hotelIndex && h.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  if (hotels.find((h, index) => index !== hotelIndex && h.phone === phone)) {
    return res.status(400).json({ error: 'Phone number already registered' });
  }
  
  hotels[hotelIndex].hotelName = hotelName;
  hotels[hotelIndex].username = username;
  hotels[hotelIndex].phone = phone;
  
  if (password) {
    hotels[hotelIndex].password = bcrypt.hashSync(password, 10);
  }
  
  saveHotels(hotels);
  res.json({ success: true, hotel: { ...hotels[hotelIndex], password: undefined } });
});

app.delete('/api/superadmin/hotels/:id', (req, res) => {
  const { id } = req.params;
  
  const hotels = loadHotels();
  const hotelIndex = hotels.findIndex(h => h.id === parseInt(id));
  
  if (hotelIndex === -1) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  const hotel = hotels[hotelIndex];
  
  // Disconnect bot if connected
  disconnectBotForHotel(hotel.phone);
  
  hotels.splice(hotelIndex, 1);
  saveHotels(hotels);
  
  res.json({ success: true, message: 'Hotel deleted successfully' });
});

app.post('/api/superadmin/hotels/:id/connect', (req, res) => {
  const { id } = req.params;
  
  const hotels = loadHotels();
  const hotel = hotels.find(h => h.id === parseInt(id));
  
  if (!hotel) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  // Check if bot is already connected
  const clientState = clientStates.get(hotel.phone);
  if (clientState && clientState.isConnected) {
    return res.json({ success: true, connected: true, message: 'Bot already connected' });
  }
  
  // Start bot connection
  startBotForHotel(hotel.phone, hotel.hotelName);
  
  res.json({ success: true, connected: false, message: 'Bot connection initiated' });
});

app.post('/api/superadmin/hotels/:id/disconnect', (req, res) => {
  const { id } = req.params;
  
  const hotels = loadHotels();
  const hotel = hotels.find(h => h.id === parseInt(id));
  
  if (!hotel) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  // Disconnect bot
  disconnectBotForHotel(hotel.phone);
  
  // Update hotel connection status
  const hotelIndex = hotels.findIndex(h => h.id === parseInt(id));
  if (hotelIndex !== -1) {
    hotels[hotelIndex].botConnected = false;
    saveHotels(hotels);
  }
  
  res.json({ success: true, message: 'Bot disconnected successfully' });
});

app.get('/api/superadmin/hotels/:id/qr', (req, res) => {
  const { id } = req.params;
  
  const hotels = loadHotels();
  const hotel = hotels.find(h => h.id === parseInt(id));
  
  if (!hotel) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  const qrData = hotelQRs.get(hotel.phone);
  if (!qrData) {
    return res.status(404).json({ error: 'No QR code available' });
  }
  
  res.json({ qr: qrData });
});

// Hotel Admin Routes
app.post('/api/hotel/login', (req, res) => {
  const { phone, username, password } = req.body;
  
  const hotels = loadHotels();
  const hotel = hotels.find(h => 
    h.phone === phone && 
    h.username === username && 
    bcrypt.compareSync(password, h.password)
  );
  
  if (hotel) {
    res.json({ 
      success: true, 
      message: 'Login successful',
      hotel: {
        id: hotel.id,
        hotelName: hotel.hotelName,
        username: hotel.username,
        phone: hotel.phone
      }
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Hotel-specific API endpoints
app.get('/api/orders', authenticateHotel, (req, res) => {
  const orders = loadOrders(req.hotel.phone);
  res.json(orders);
});

app.post('/api/orders', authenticateHotel, async (req, res) => {
  const { room, items, guestNumber } = req.body;
  const hotelPhone = req.hotel.phone;

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

  const orders = loadOrders(hotelPhone);
  orders.push(newOrder);
  saveOrders(hotelPhone, orders);

  // Notify manager/admin using whatsapp-web.js client
  const client = activeClients.get(hotelPhone);
  if (client && isClientConnected(hotelPhone)) {
    const adminNumber = `${hotelPhone}@c.us`;
    const itemSummary = newOrder.items.map(i => `${i.quantity} x ${i.name}`).join('\n');

    const summary = `📢 *NEW ORDER*\n🆔 #${newOrder.id}\n🏨 Room: ${newOrder.room}\n🍽 Items:\n${itemSummary}`;

    try {
      await client.sendMessage(adminNumber, summary);
      console.log(`📤 Notified manager of new order #${newOrder.id}`);
    } catch (err) {
      console.error('⚠️ Failed to notify manager via WhatsApp:', err.message);
    }
  }

  res.status(201).json({ success: true, order: newOrder });
});

app.post('/api/orders/:id/status', authenticateHotel, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  const hotelPhone = req.hotel.phone;

  const validStatuses = ['Pending', 'Confirmed', 'Done', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  const orders = loadOrders(hotelPhone);
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[index].status = status;
  saveOrders(hotelPhone, orders);

  const order = orders[index];
  const guestNumber = order.guestNumber;

  // Notify guest via whatsapp-web.js
  const client = activeClients.get(hotelPhone);
  if (client && guestNumber && isClientConnected(hotelPhone)) {
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
        await client.sendMessage(guestNumber, msg);
        console.log(`📩 WhatsApp update sent to guest ${guestNumber} → ${status}`);
      } catch (err) {
        console.error('⚠️ Failed to notify guest via WhatsApp:', err.message);
      }
    }
  }

  res.json({ success: true });
});

app.delete('/api/orders/:id', authenticateHotel, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const hotelPhone = req.hotel.phone;
  
  const orders = loadOrders(hotelPhone);
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders.splice(index, 1);
  saveOrders(hotelPhone, orders);

  res.json({ success: true, message: `Order ${id} deleted.` });
});

app.delete('/api/orders/cleanup', authenticateHotel, async (req, res) => {
  try {
    const { statuses } = req.body;
    const hotelPhone = req.hotel.phone;
    
    let orders = loadOrders(hotelPhone);
    orders = orders.filter(order => !statuses.includes(order.status));
    saveOrders(hotelPhone, orders);
    res.json({ message: `Removed all orders with status: ${statuses.join(', ')}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/menu', authenticateHotel, (req, res) => {
  try {
    const menuData = loadMenuConfig(req.hotel.phone);
    res.json(menuData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load menu' });
  }
});

app.post('/api/menu', authenticateHotel, (req, res) => {
  try {
    const { menu, hours } = req.body;
    const hotelPhone = req.hotel.phone;
    
    if (!menu || typeof menu !== 'object' || !hours || typeof hours !== 'object') {
      return res.status(400).json({ error: 'Invalid menu data' });
    }

    saveMenuConfig(hotelPhone, { menu, hours });
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

// WhatsApp Bot Functions

// Check if client is connected
function isClientConnected(phone) {
  const state = clientStates.get(phone);
  return state ? state.isConnected && !state.isDestroying : false;
}

// Safe message sending function
async function safeSendMessage(client, phone, to, message) {
  if (!isClientConnected(phone)) {
    console.log(`❌ Cannot send message - client for ${phone} is not connected`);
    return false;
  }

  try {
    await client.sendMessage(to, message);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send message for ${phone}:`, error.message);
    return false;
  }
}

// Disconnect bot for hotel
function disconnectBotForHotel(phone) {
  const client = activeClients.get(phone);
  const state = clientStates.get(phone);
  
  if (state) {
    state.isDestroying = true;
  }
  
  if (client) {
    try {
      client.removeAllListeners();
      client.destroy().catch(err => {
        console.log(`⚠️ Error during client destruction for ${phone}:`, err.message);
      });
      console.log(`🔌 Disconnected bot for ${phone}`);
    } catch (error) {
      console.error(`❌ Error disconnecting bot for ${phone}:`, error.message);
    }
  }
  
  activeClients.delete(phone);
  clientStates.delete(phone);
  hotelQRs.delete(phone);
  
  // Clear user states for this hotel
  for (const [key, value] of userStates.entries()) {
    if (value.hotelPhone === phone) {
      userStates.delete(key);
    }
  }
}

// Start bot for specific hotel
async function startBotForHotel(phone, hotelName) {
  // Check if bot is already running for this phone
  if (activeClients.has(phone) && isClientConnected(phone)) {
    console.log(`Bot already running for ${phone}`);
    return activeClients.get(phone);
  }

  // Clean up any existing client
  disconnectBotForHotel(phone);

  // Initialize client state
  clientStates.set(phone, {
    isConnected: false,
    isDestroying: false
  });

  // Initialize client with local auth (phone-specific)
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `hotel_${phone}` }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    },
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0
  });

  // Store client
  activeClients.set(phone, client);

  // Handle QR code generation
  client.on('qr', (qr) => {
    if (isClientConnected(phone)) return; // Don't show QR if already connected
    
    console.log(`QR RECEIVED for ${phone}`);
    hotelQRs.set(phone, qr);
    qrcode.generate(qr, { small: true });
  });

  // Handle client ready
  client.on('ready', () => {
    const state = clientStates.get(phone);
    if (state && !state.isDestroying) {
      state.isConnected = true;
      console.log(`✅ WhatsApp Bot Ready for ${hotelName} (${phone})`);
      hotelQRs.delete(phone); // Clear QR after successful connection
      
      // Update hotel connection status
      const hotels = loadHotels();
      const hotelIndex = hotels.findIndex(h => h.phone === phone);
      if (hotelIndex !== -1) {
        hotels[hotelIndex].botConnected = true;
        saveHotels(hotels);
      }
    }
  });

  // Handle authentication failure
  client.on('auth_failure', (msg) => {
    console.log(`❌ Authentication failure for ${phone}:`, msg);
    disconnectBotForHotel(phone);
  });

  // Handle disconnection
  client.on('disconnected', (reason) => {
    console.log(`❌ Client disconnected for ${phone}:`, reason);
    disconnectBotForHotel(phone);
  });

  // Main message handler
  client.on('message', async msg => {
    // Ignore messages from groups and self
    if (msg.isGroup || msg.fromMe) return;

    const from = msg.from;
    const userMsg = msg.body;
    
    // Check if client is connected and not being destroyed
    if (!isClientConnected(phone)) {
      console.log(`⚠️ Ignoring message - client for ${phone} is not connected`);
      return;
    }
    
    const msgId = msg.id._serialized;
    if (processedMessageIds.has(msgId)) {
      return;
    }
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 100) {
      const oldId = processedMessageIds.values().next().value;
      processedMessageIds.delete(oldId);
    }
    
    if (!userMsg) return;
    console.log(`Received message from ${from} for hotel ${phone}: ${userMsg}`);

    let state = userStates.get(from) || {
      awaitingConfirmation: false,
      items: [],
      room: null,
      awaitingRating: false,
      lastOrderId: null,
      hotelPhone: phone
    };

    // Handle button responses and message processing
    try {
      await handleMessage(client, from, userMsg, state, phone, hotelName);
    } catch (error) {
      console.error(`❌ Error handling message for ${phone}:`, error.message);
    }
  });
  
  // Start the client
  try {
    await client.initialize();
    console.log(`🚀 Initialized bot for ${hotelName} (${phone})`);
  } catch (error) {
    console.error(`❌ Failed to initialize bot for ${phone}:`, error.message);
    disconnectBotForHotel(phone);
  }
  
  return client;
}

// Message handler function
async function handleMessage(client, from, userMsg, state, phone, hotelName) {
  // Check if client is still connected before processing
  if (!isClientConnected(phone)) {
    console.log(`⚠️ Cannot process message - client for ${phone} is not connected`);
    return;
  }

  // Handle button responses
  if (userMsg.startsWith("rate_")) {
    const buttonId = userMsg;
    const rating = buttonId.split("_")[1];
    
    if (state?.awaitingRating) {
      console.log(`⭐ Guest ${from} rated ${rating} stars for Order ${state.lastOrderId}`);

      await safeSendMessage(client, phone, from, `⭐ Thanks for rating us ${rating} stars! We appreciate your feedback.`);

      // Forward rating to admin
      const adminNumber = `${phone}@c.us`;
      await safeSendMessage(client, phone, adminNumber, `📩 Guest ${from} rated Order #${state.lastOrderId}: ${rating} ⭐`);

      state.awaitingRating = false;
      userStates.set(from, state);
    }
    return;
  }
  
  // Handle menu category selection
  if (userMsg.startsWith("menu_")) {
    const buttonId = userMsg;
    const category = buttonId.split("_")[1];
    await sendMenuCategory(client, from, category, phone);
    return;
  }
  
  // Handle help options
  if (userMsg.startsWith("help_")) {
    const buttonId = userMsg;
    if (buttonId === "help_reception") {
      await safeSendMessage(client, phone, from, `📞 Please dial extension 22 for reception, or call directly at the front desk. Our staff will be happy to assist you!`);
    } else if (buttonId === "help_amenities") {
      await safeSendMessage(client, phone, from, `🏊‍♂️ Hotel Amenities:\n• Swimming Pool (6AM-10PM)\n• Fitness Center (24/7)\n• Spa (9AM-9PM)\n• Business Center (8AM-8PM)\n• Free WiFi throughout hotel`);
    } else if (buttonId === "help_room") {
      await safeSendMessage(client, phone, from, `🛌 Need room assistance?\nFor housekeeping, maintenance, or other room-related issues, please dial extension 22 and our staff will assist you promptly.`);
    }
    return;
  }

  // Handle reset command
  if (userMsg.toLowerCase() === 'reset') {
    userStates.delete(from);
    await safeSendMessage(client, phone, from, "🔄 Chat reset. How may I assist you today?");
    return;
  }

  // Handle help command
  if (userMsg.toLowerCase().includes('help')) {
    await showHelpOptions(client, from, phone);
    return;
  }

  // Handle status command
  if (userMsg.toLowerCase().includes('status') && state.lastOrderId) {
    const orders = loadOrders(phone);
    const order = orders.find(o => o.id === state.lastOrderId);

    if (order) {
      await safeSendMessage(client, phone, from, `📦 Order #${order.id} Status: ${order.status}\n\nRoom: ${order.room}\nPlaced at: ${new Date(order.timestamp).toLocaleTimeString()}`);
    } else {
      await safeSendMessage(client, phone, from, "I couldn't find your recent order. Please place an order first or contact reception for assistance.");
    }
    return;
  }

  // Handle confirmation responses
  if (state.awaitingConfirmation) {
    const lowerUserMsg = userMsg.toLowerCase();
    if (lowerUserMsg.includes('yes') || lowerUserMsg.includes('confirm') || lowerUserMsg.includes('place order')) {
      await placeOrder(client, from, state, phone, hotelName);
      userStates.delete(from);
      return;
    }
    if (lowerUserMsg.includes('no') || lowerUserMsg.includes('cancel')) {
      await safeSendMessage(client, phone, from, "Order cancelled. Please place a new order when ready.");
      state.awaitingConfirmation = false;
      state.items = [];
      userStates.set(from, state);
      return;
    }

    // If we get here, the response wasn't clear
    await safeSendMessage(client, phone, from, "I didn't understand your response. Please reply 'yes' to confirm your order or 'no' to cancel.");
    return;
  }

  // Parse the message for room number and order items
  const parsed = parseUserMessage(userMsg, state, phone);

  // Update state with detected room number
  if (parsed.roomNumber) {
    state.room = parsed.roomNumber;
    await safeSendMessage(client, phone, from, `✅ Room ${parsed.roomNumber} noted. What would you like to order?`);
  }

  // Update state with detected order items
  if (parsed.orderItems && parsed.orderItems.length > 0) {
    state.items = parsed.orderItems;
  }

  // Handle different intents
  if (parsed.intent === 'order') {
    await handleOrderIntent(client, from, state, hotelName, phone);
  } else if (parsed.intent === 'menu') {
    await sendFullMenu(client, from, phone, hotelName);
  } else if (parsed.intent === 'greeting') {
    await sendWelcomeMessage(client, from, hotelName, phone);
  } else if (parsed.intent === 'provide_room_only') {
    // Already handled above
  } else {
    await safeSendMessage(client, phone, from, `I'm here to help you at ${hotelName}! 😊\n\nYou can:\n• Type "menu" to see food options\n• Provide your room number and order\n• Type "help" for assistance\n• Type "status" to check your order\n• Type "reset" to start over`);
  }

  userStates.set(from, state);
}

// Send welcome message
async function sendWelcomeMessage(client, from, hotelName, phone) {
  await safeSendMessage(client, phone, from, `Hello! Welcome to ${hotelName}! 🏨\n\nI'm your virtual assistant here to help with:\n• Food orders 🍕\n• Menu information 📋\n• Hotel assistance 📞\n\nHow can I help you today?`);
}

// Show help options with buttons
async function showHelpOptions(client, from, phone) {
  if (!isClientConnected(phone)) return;
  
  const buttonSections = [{
    title: 'Select an option',
    buttons: [
      { id: 'help_reception', body: '📞 Reception' },
      { id: 'help_amenities', body: '🏊‍♂️ Amenities' },
      { id: 'help_room', body: '🛌 Room Help' }
    ]
  }];
  
  try {
    let button = new Buttons('🆘 How can we help you?', buttonSections, 'Select a service', 'Hotel Help');
    await client.sendMessage(from, button);
  } catch (error) {
    console.error(`❌ Error sending help buttons for ${phone}:`, error.message);
  }
}

// Show menu categories with buttons
async function showMenuCategories(client, from, phone) {
  if (!isClientConnected(phone)) return;
  
  const currentMenuConfig = loadMenuConfig(phone);
  const menuButtons = currentMenuConfig.categories.map(category => ({
    id: `menu_${category}`,
    body: `🍽 ${category.charAt(0).toUpperCase() + category.slice(1)}`
  }));
  
  const buttonSections = [{
    title: 'Food Categories',
    buttons: menuButtons
  }];

  try {
    let button = new Buttons('📋 Please select whatever u like to order from the menu:', buttonSections, 'Select Category', 'Menu');
    await client.sendMessage(from, button);
  } catch (error) {
    console.error(`❌ Error sending menu buttons for ${phone}:`, error.message);
  }
}

// Send specific menu category
async function sendMenuCategory(client, from, category, phone) {
  const currentMenuConfig = loadMenuConfig(phone);

  if (!currentMenuConfig.menu[category]) {
    await safeSendMessage(client, phone, from, "Sorry, I couldn't find that menu category.");
    return;
  }

  let text = `🍽 ${category.toUpperCase()} Menu (Available: ${currentMenuConfig.hours[category]}):\n\n`;
  text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n');
  text += `\n\nTo order, just message: "Room [your number], [item name]"\nExample: "Room 105, 2 pizzas"`;

  await safeSendMessage(client, phone, from, text);
}

// Send the full menu (all categories at once)
async function sendFullMenu(client, from, phone, hotelName) {
  const currentMenuConfig = loadMenuConfig(phone);

  let text = `🍽 ${hotelName} Menu\n\n`;

  for (const category of currentMenuConfig.categories) {
    text += `📋 ${category.charAt(0).toUpperCase() + category.slice(1)} (${currentMenuConfig.hours[category]}):\n`;
    text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }

  text += "To order, just message: \"Room [your number], [your order]\"\nExample: \"Room 105, 2 pizzas and 1 coffee\"\n\n";
  text += "You can also browse specific categories using the buttons below:";

  await safeSendMessage(client, phone, from, text);
  await showMenuCategories(client, from, phone);
}

// Parse user message without AI - using pattern matching
function parseUserMessage(message, currentState, phone) {
  const text = message.toLowerCase().trim();
  console.log('Processing message:', text);

  const result = {
    intent: 'unknown',
    roomNumber: null,
    orderItems: []
  };

  // SPECIAL CASE: If user is just providing a room number (digits only)
  if (/^\d{3,4}$/.test(text) && currentState && currentState.items && currentState.items.length > 0) {
    result.roomNumber = text;
    result.intent = 'provide_room_only';
    console.log('Special case: Room number provided for existing order:', result.roomNumber);
    return result;
  }

  // Check for room number in normal messages
  const roomMatch = text.match(/(room|rm|#|\b)(\d{3,4})\b/) || text.match(/\b(\d{3,4})\b/);
  if (roomMatch) {
    result.roomNumber = roomMatch[2] || roomMatch[1]; 
    console.log('Found room:', result.roomNumber);
  }

  // Check for order items
  const itemCounts = {};
  const menuItems = getAllMenuItems(phone);
  console.log('Available menu items:', menuItems.map(item => item.name));

  menuItems.forEach(item => {
    const escapedItemName = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const itemRegex = new RegExp(`(?:(\\d+|one|two|three|four|five|a|an)\\s+)?\\b(${escapedItemName})\\b`, 'gi');
    const matches = [...text.matchAll(itemRegex)];

    if (matches.length > 0) {
      console.log('Found match for:', item.name, 'matches:', matches);
    }

    for (const match of matches) {
      let quantity = 1;
      if (match[1]) {
        const quantityText = match[1].toLowerCase();
        if (quantityText === 'one' || quantityText === 'a' || quantityText === 'an') {
          quantity = 1;
        } else if (quantityText === 'two') {
          quantity = 2;
        } else if (quantityText === 'three') {
          quantity = 3;
        } else if (quantityText === 'four') {
          quantity = 4;
        } else if (quantityText === 'five') {
          quantity = 5;
        } else {
          quantity = parseInt(match[1]);
        }
      }
      itemCounts[item.name] = (itemCounts[item.name] || 0) + quantity;
    }
  });

  result.orderItems = Object.keys(itemCounts).map(itemName => {
    const itemDetails = menuItems.find(item => item.name === itemName);
    return {
      name: itemDetails.name,
      full_name: itemDetails.full_name,
      quantity: itemCounts[itemName],
      price: itemDetails.price
    };
  });

  console.log('Parsed order items:', result.orderItems);

  // Determine intent
  const orderKeywords = ['order', 'get', 'like', 'have', 'bring me', 'want', 'need', "i'd like"];
  if (orderKeywords.some(keyword => text.includes(keyword)) || result.orderItems.length > 0) {
    result.intent = 'order';
  } else if (text.includes('menu') || text.includes('food') || text.includes('what do you have') || text.includes('offer')) {
    result.intent = 'menu';
  } else if (text.includes('hello') || text.includes('hi') || text.includes('hey') || text.includes('good')) {
    result.intent = 'greeting';
  } else if (result.roomNumber) {
    result.intent = 'provide_room_only';
  }

  return result;
}

/**
 * Handle order intent
 */
async function handleOrderIntent(client, from, state, hotelName, phone) {
  if (!state.items) {
    state.items = [];
  }

  if (!state.room) {
    await safeSendMessage(client, phone, from, "I'd be happy to help with your order! 🍽️\n\nCould you please tell me your room number first? (Example: 'Room 105' or just '105')");
    return;
  }

  if (state.items.length === 0) {
    await safeSendMessage(client, phone, from, "What would you like to order from our menu? You can say something like '2 pizzas and 1 coffee' or type 'menu' to see options.");
    return;
  }

  // Calculate total
  const total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const orderSummary = state.items.map(item =>
    `${item.quantity} x ${item.full_name} - ₹${item.price * item.quantity}`
  ).join('\n');

  await safeSendMessage(client, phone, from, `📋 Order Summary:\n\n🏨 Room: ${state.room}\n🍽 Items:\n${orderSummary}\n💵 Total: ₹${total}\n\nShould I place this order? Please reply 'yes' to confirm or 'no' to cancel.`);

  state.awaitingConfirmation = true;
  userStates.set(from, state);
}

/**
 * Places the order by saving it to a JSON file and notifying the admin
 */
async function placeOrder(client, from, state, phone, hotelName) {
  console.log('🛒 Placing order for hotel:', hotelName, 'Room:', state.room, 'Items:', state.items);
  
  if (!state.room) {
    await safeSendMessage(client, phone, from, "❌ Sorry, I need your room number to place the order. Please provide your room number first.");
    return;
  }

  if (!state.items || state.items.length === 0) {
    await safeSendMessage(client, phone, from, "❌ Sorry, I need order items to place your order.");
    return;
  }

  const orders = loadOrders(phone);
  const orderId = Date.now();
  
  // Calculate total and prepare items for storage
  const orderItems = state.items.map(item => ({
    name: item.full_name || item.name,
    quantity: item.quantity || 1,
    price: item.price || 0,
    subtotal: (item.price || 0) * (item.quantity || 1)
  }));
  
  const total = orderItems.reduce((sum, item) => sum + item.subtotal, 0);

  const newOrder = {
    id: orderId,
    room: state.room.toString().trim(), // Ensure room is string and trimmed
    items: orderItems,
    total: total,
    guestNumber: from,
    status: "Pending",
    timestamp: new Date().toISOString()
  };

  console.log('💾 Saving order:', newOrder);
  
  orders.push(newOrder);
  saveOrders(phone, orders);

  // Confirm to guest
  const itemSummary = newOrder.items.map(item =>
    `${item.quantity} x ${item.name}`
  ).join(', ');

  await safeSendMessage(client, phone, from, `✅ Order #${newOrder.id} placed successfully!\n\n🏨 Room: ${newOrder.room}\n🍽 Items: ${itemSummary}\n💵 Total: ₹${total}\n\nWe'll notify you when your order is confirmed. You can check status anytime by typing "status".`);

  console.log(`📦 Order #${orderId} saved for hotel ${hotelName}`);

  // Update state
  state.lastOrderId = newOrder.id;
  state.awaitingRating = false;
  userStates.set(from, state);
}

// Start bots for all hotels on server start
function initializeHotelBots() {
  const hotels = loadHotels();
  console.log(`🔄 Initializing bots for ${hotels.length} hotels...`);
  
  hotels.forEach(hotel => {
    // Always try to start the bot for each hotel on server start
    console.log(`🚀 Starting bot for ${hotel.hotelName} (${hotel.phone})`);
    startBotForHotel(hotel.phone, hotel.hotelName);
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🏨 Hotel Management System initialized`);
  console.log(`👑 Super Admin: ${hotelConfig.superAdmin.username}`);
  
  // Initialize bots for hotels that should be connected
  initializeHotelBots();
});