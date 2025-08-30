// Fix for Render: make crypto global (needed by Baileys)
const crypto = require('crypto');
global.crypto = crypto;

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
// Removed: const { GoogleGenerativeAI } = require("@google/generative-ai");
const { app, setClient } = require('./server'); // Assuming your server file is separate

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Welcome",
  // IMPORTANT: Baileys uses JID format for numbers. Replace with your admin's full WhatsApp JID.
  // Example: '9779819809195@s.whatsapp.net' for a phone number or '1234567890-123456@g.us' for a group
  adminNumber: '9779819809195@s.whatsapp.net', 
  receptionExtension: "22",
  databaseFile: path.join(__dirname, 'orders.json'),
  menu: {
    breakfast: [
      "Continental Breakfast - ₹500",
      "Full English Breakfast - ₹750",
      "Pancakes with Maple Syrup - ₹450"
    ],
    lunch: [
      "Grilled Chicken Sandwich - ₹650",
      "Margherita Pizza - ₹800",
      "Vegetable Pasta - ₹550"
    ],
    dinner: [
      "Grilled Salmon - ₹1200",
      "Beef Steak - ₹1500",
      "Vegetable Curry - ₹600"
    ],
    roomService: [
      "Club Sandwich - ₹450",
      "Chicken Burger - ₹550",
      "Chocolate Lava Cake - ₹350"
    ]
  },
  hours: {
    breakfast: "7:00 AM - 10:30 AM",
    lunch: "12:00 PM - 3:00 PM",
    dinner: "6:30 PM - 11:00 PM",
    roomService: "24/7"
  },
  checkInTime: "2:00 PM",
  checkOutTime: "11:00 AM"
};

// Ensure orders.json database file exists
if (!fs.existsSync(hotelConfig.databaseFile)) {
  fs.writeFileSync(hotelConfig.databaseFile, '[]');
}

// Map to store user conversation states
const userStates = new Map();

// Prepare a flat list of all valid menu item names (lowercase)
const allMenuItems = Object.values(hotelConfig.menu)
  .flat()
  .map(item => item.split(' - ')[0].toLowerCase());

// Helper function to filter only valid menu items
function filterValidItems(items) {
  return items.filter(item => {
    const lowered = item.toLowerCase();
    // Accept if item contains any valid menu item substring
    return allMenuItems.some(menuItem => lowered.includes(menuItem));
  });
}

/**
 * Uses a rule-based system to parse the user's message.
 * Returns an object: { intent: string, roomNumber: string|null, orderItems: string[] }
 */
function parseMessageWithoutAI(message) {
  const lowerMsg = message.toLowerCase();
  let intent = 'unknown';
  let roomNumber = null;
  const orderItems = [];

  // 1. Check for greetings
  if (/(hi|hello|hey|greetings)/.test(lowerMsg)) {
    intent = 'greeting';
  }

  // 2. Check for menu request
  if (/(menu|what's on the menu|list food|list dishes)/.test(lowerMsg)) {
    intent = 'ask_menu';
  }
  
  // 3. Check for a room number (3 or 4 digits)
  const roomMatch = message.match(/\b\d{3,4}\b/);
  if (roomMatch) {
    roomNumber = roomMatch[0];
    if (intent === 'unknown') {
      intent = 'provide_room_only';
    }
  }

  // 4. Check for order items
  allMenuItems.forEach(menuItem => {
    if (lowerMsg.includes(menuItem)) {
      orderItems.push(menuItem);
      if (intent === 'unknown' || intent === 'provide_room_only') {
        intent = 'order_food';
      }
    }
  });

  return { intent, roomNumber, orderItems };
}

// Global variable for Baileys socket
let sock = null;

// Main function to start the bot connection
async function startBotConnection() {
  // useMultiFileAuthState stores session data in 'auth' folder
  const { state, saveCreds } = await useMultiFileAuthState('auth'); 
  
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // Suppress verbose Baileys logs
    // printQRInTerminal: true, // Deprecated, handled by connection.update event listener
  });

  // Set the client instance for the server, if server.js needs it
  setClient(sock);

  // Handle connection updates (e.g., QR code, disconnection, reconnection)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      // Reconnect if not explicitly logged out
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        startBotConnection(); // Attempt to reconnect
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Bot Ready');
    }
    // Display QR code for initial login
    if (qr) {
      console.log('QR code generated, visit /qr to scan');
      // Convert QR to Data URL and serve via Express
      QRCode.toDataURL(qr).then(url => {
        app.get('/qr', (req, res) => {
          res.send(`<h3>Scan this QR with your WhatsApp</h3><img src="${url}" />`);
        });
      });
    }
  });

  // Save credentials when they are updated (e.g., new session, token refresh)
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    // Ignore messages if:
    // - There's no message content
    // - The message is sent by the bot itself
    // - The message is from a group (configurable, enable if you want group interaction)
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    const from = msg.key.remoteJid; // Sender's JID
    // Extract message body from different message types
    const userMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!userMsg) return; // Ignore empty messages
    console.log(`Received message from ${from}: ${userMsg}`);

    // Initialize or get user state
    let state = userStates.get(from) || { awaitingConfirmation: false };

    // Handle order confirmation step
    if (state.awaitingConfirmation) {
      const lowerUserMsg = userMsg.toLowerCase();
      // FIX: More robust check for 'yes' confirmation (includes 'yes', 'confirm', 'place order')
      if (lowerUserMsg.includes('yes') || lowerUserMsg.includes('confirm') || lowerUserMsg.includes('place order')) {
        await placeOrder(sock, from, state); // This is where the order is supposed to be placed
        state.awaitingConfirmation = false;
        delete state.items; // Clear ordered items after placing the order
        userStates.set(from, state); // Save the updated state
        return; // Exit the message handler
      }
      // FIX: More robust check for 'no' confirmation
      if (lowerUserMsg.includes('no') || lowerUserMsg.includes('cancel')) {
        await sock.sendMessage(from, { text: "Okay, your previous order request has been cancelled. Please tell me your order again." });
        delete state.items;
        state.awaitingConfirmation = false;
        userStates.set(from, state);
        return;
      }
    }

    // Reset chat command
    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from);
      await sock.sendMessage(from, { text: "🔄 Chat has been reset. How may I assist you today?" });
      return;
    }

    // Use rule-based parsing instead of AI
    const parsed = parseMessageWithoutAI(userMsg);

    // Update state with detected room number & items if any
    if (parsed.roomNumber) {
      state.room = parsed.roomNumber;
    }

    if (parsed.orderItems && parsed.orderItems.length > 0) {
      state.items = parsed.orderItems;
    }

    // Handle special case: user provides room only after ordering items
    if (parsed.intent === 'provide_room_only' && state.items && state.items.length > 0) {
      await sock.sendMessage(from, { text: `Thanks! Room number set to ${state.room}. Shall I place your order for ${state.items.join(', ')}. Reply 'yes' or 'no'.` });
      state.awaitingConfirmation = true;
      userStates.set(from, state); // Update state for confirmation
      return;
    }

    // Handle intents from parser
    switch (parsed.intent) {
      case 'order_food':
        if (!state.room) {
          await sock.sendMessage(from, { text: "Could you please provide your 3-4 digit room number?" });
        } else if (!state.items || state.items.length === 0) {
          await sock.sendMessage(from, { text: "What would you like to order from our menu?" });
        } else {
          await sock.sendMessage(from, { text: `Got it! Room: ${state.room}, Order: ${state.items.join(', ')}. Shall I place the order? Reply 'yes' or 'no'.` });
          state.awaitingConfirmation = true;
        }
        break;

      case 'ask_menu':
        await sendFullMenu(sock, from);
        break;

      case 'greeting':
        await sock.sendMessage(from, { text: `Hello! Welcome to ${hotelConfig.name}. How can I assist you today?` });
        break;

      default:
        // Default fallback: a simple hardcoded reply
        await sock.sendMessage(from, { text: "I'm sorry, I didn't understand that. Please ask for the menu or place an order." });
        break;
    }

    // Save the updated state
    userStates.set(from, state);
  });
}

/**
 * Places the order: saves it in JSON DB and notifies the manager/admin
 * @param {object} sock - The Baileys socket instance
 * @param {string} from - The JID of the sender
 * @param {object} state - The current user state
 */
async function placeOrder(sock, from, state) {
  if (!state.room || !state.items || state.items.length === 0) {
    await sock.sendMessage(from, { text: "Sorry, I need both room number and order details to place your order." });
    return;
  }

  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderId = Date.now(); // Corrected Date.Now() to Date.now()

  const newOrder = {
    id: orderId,
    room: state.room,
    items: state.items,
    guestNumber: from,
    status: "Pending",
    timestamp: new Date().toISOString()
  };

  orders.push(newOrder);
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  // Notify admin
  await sock.sendMessage(hotelConfig.adminNumber, { text: `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${newOrder.items.join('\n')}` }); // Fixed: Use newOrder.items

  // Confirm to guest
  await sock.sendMessage(from, { text: `Your order #${orderId} has been placed! It will arrive shortly.` });

  // Send rating buttons (Baileys button message format)
  await sock.sendMessage(from, {
    text: '🙏 We’d love your feedback! Please rate us:',
    footer: 'Tap one below to rate our service.', // Optional footer for buttons
    buttons: [
      { buttonText: { displayText: '⭐ 1' }, buttonId: 'star_1' },
      { buttonText: { displayText: '⭐ 2' }, buttonId: 'star_2' },
      { buttonText: { displayText: '⭐ 3' }, buttonId: 'star_3' },
      { buttonText: { displayText: '⭐ 4' }, buttonId: 'star_4' },
      { buttonText: { displayText: '⭐ 5' }, buttonId: 'star_5' }
    ],
    headerType: 1 // Indicates a text header
  });
}

/**
 * Sends full hotel menu to the guest.
 * @param {object} sock - The Baileys socket instance
 * @param {string} number - The JID of the recipient
 */
async function sendFullMenu(sock, number) {
  let text = `📋 Our Menu:\n\n`;
  for (const category in hotelConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${hotelConfig.hours[category]}):\n`;
    text += hotelConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "You can say things like 'I'd like to order 2 pancakes' or 'Can I get a towel + chicken sandwich?'\n";
  await sock.sendMessage(number, { text: text });
}

// Start the Express server once
app.listen(3000, () => {
  console.log('🌐 Dashboard running at http://localhost:3000/admin.html');
});

// Start the bot connection process
startBotConnection();
