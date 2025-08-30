const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
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

// Set to track processed message IDs to prevent duplicates
const processedMessageIds = new Set();

// Prepare a flat list of all valid menu item names (lowercase) and prices
const allMenuItems = Object.values(hotelConfig.menu)
  .flat()
  .map(item => {
    const [name, price] = item.split(' - ');
    return {
      name: name.toLowerCase().trim(),
      full_name: name.trim(),
      price: parseInt(price.replace('₹', '').trim())
    };
  });

// Global variable for Baileys socket
let sock = null;

// Main function to start the bot connection
async function startBotConnection() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // Suppress verbose Baileys logs
  });

  setClient(sock);

  // Handle connection updates (e.g., QR code, disconnection, reconnection)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        startBotConnection();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Bot Ready');
    }
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR code above to connect your WhatsApp bot.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    // Check if message ID has been processed to prevent duplicates
    if (processedMessageIds.has(msg.key.id)) {
        return;
    }
    processedMessageIds.add(msg.key.id);
    // Keep the Set from growing indefinitely
    if (processedMessageIds.size > 100) {
        const oldId = processedMessageIds.values().next().value;
        processedMessageIds.delete(oldId);
    }

    const from = msg.key.remoteJid;
    const userMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!userMsg) return;
    console.log(`Received message from ${from}: ${userMsg}`);

    let state = userStates.get(from) || { chatHistory: [], awaitingConfirmation: false, items: [], room: null };

    if (state.awaitingConfirmation) {
      const lowerUserMsg = userMsg.toLowerCase();
      if (lowerUserMsg.includes('yes') || lowerUserMsg.includes('confirm') || lowerUserMsg.includes('place order')) {
        await placeOrder(sock, from, state);
        userStates.delete(from); // Clear state after successful order
        return;
      }
      if (lowerUserMsg.includes('no') || lowerUserMsg.includes('cancel')) {
        await sock.sendMessage(from, { text: "Okay, your previous order has been cancelled. Please tell me your order again." });
        state.awaitingConfirmation = false;
        state.items = [];
        userStates.set(from, state);
        return;
      }
    }

    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from);
      await sock.sendMessage(from, { text: "🔄 Chat has been reset. How may I assist you today?" });
      return;
    }

    const { intent, roomNumber, orderItems } = parseUserMessage(userMsg);

    if (roomNumber) {
      state.room = roomNumber;
    }

    if (orderItems && orderItems.length > 0) {
      state.items = orderItems;
    }

    switch (intent) {
      case 'order_food':
        if (!state.room) {
          await sock.sendMessage(from, { text: "Could you please provide your 3 or 4-digit room number?" });
        } else if (state.items.length === 0) {
          await sock.sendMessage(from, { text: "What would you like to order? You can see our menu by typing 'menu'." });
        } else {
          const orderSummary = state.items.map(item => `${item.quantity} x ${item.full_name}`).join(', ');
          await sock.sendMessage(from, { text: `Got it! Room: ${state.room}, Order: ${orderSummary}. Shall I place the order? Reply 'yes' or 'no'.` });
          state.awaitingConfirmation = true;
        }
        break;

      case 'ask_menu':
        await sendFullMenu(sock, from);
        break;

      case 'greeting':
        const greetings = ["Hello!", "Hi there!", "Welcome!"];
        const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
        await sock.sendMessage(from, { text: `${randomGreeting} How can I assist you today at ${hotelConfig.name}?` });
        break;

      case 'provide_room_only':
         if (state.items.length > 0) {
            const orderSummary = state.items.map(item => `${item.quantity} x ${item.full_name}`).join(', ');
            await sock.sendMessage(from, { text: `Thanks! Room number set to ${state.room}. Shall I place your order for ${orderSummary}? Reply 'yes' or 'no'.` });
            state.awaitingConfirmation = true;
        } else {
            await sock.sendMessage(from, { text: `Thanks! I have your room number as ${state.room}. What would you like to order?` });
        }
        break;

      default:
        await sock.sendMessage(from, { text: "I'm sorry, I didn't quite understand that. You can try asking about our menu, placing an order, or asking about check-in/out times." });
        break;
    }

    userStates.set(from, state);
  });
}

/**
 * A rule-based function to parse user messages for intent, room number, and order items.
 * Returns an object with the detected intent, room number, and order items.
 */
function parseUserMessage(message) {
  const lowerMsg = message.toLowerCase();
  const roomNumberMatch = lowerMsg.match(/\b\d{3,4}\b/);
  const roomNumber = roomNumberMatch ? roomNumberMatch[0] : null;

  const itemCounts = {};
  let foundOrderKeyword = false;

  allMenuItems.forEach(item => {
    // Regex to find item name with optional quantity
    const itemRegex = new RegExp(`(?:(\\d+|one|two|a)\\s+)?(${item.name})`, 'gi');
    for (const match of lowerMsg.matchAll(itemRegex)) {
      let quantity = 1; // Default quantity if not specified
      if (match[1]) {
        if (match[1].toLowerCase() === 'one' || match[1].toLowerCase() === 'a') {
          quantity = 1;
        } else if (match[1].toLowerCase() === 'two') {
          quantity = 2;
        } else {
          quantity = parseInt(match[1]);
        }
      }
      if (itemCounts[item.name]) {
        itemCounts[item.name] += quantity;
      } else {
        itemCounts[item.name] = quantity;
      }
    }
  });

  const orderItems = Object.keys(itemCounts).map(itemName => {
    const itemDetails = allMenuItems.find(item => item.name === itemName);
    return {
      name: itemDetails.name,
      full_name: itemDetails.full_name,
      quantity: itemCounts[itemName]
    };
  });

  const orderKeywords = ['order', 'get', 'like', 'have', 'bring me'];
  if (orderKeywords.some(keyword => lowerMsg.includes(keyword)) || orderItems.length > 0) {
    foundOrderKeyword = true;
  }

  let intent = 'unknown';
  if (lowerMsg.includes('hello') || lowerMsg.includes('hi') || lowerMsg.includes('hey')) {
    intent = 'greeting';
  } else if (lowerMsg.includes('menu') || lowerMsg.includes('food') || lowerMsg.includes('what do you have')) {
    intent = 'ask_menu';
  } else if (foundOrderKeyword) {
    intent = 'order_food';
  } else if (roomNumber) {
    intent = 'provide_room_only';
  }

  return { intent, roomNumber, orderItems };
}

/**
 * Places the order by saving it to a JSON file and notifying the admin.
 */
async function placeOrder(sock, from, state) {
  if (!state.room || state.items.length === 0) {
    await sock.sendMessage(from, { text: "Sorry, I need both a room number and order details to place your order." });
    return;
  }

  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderId = Date.now();
  const newOrder = {
    id: orderId,
    room: state.room,
    items: state.items.map(item => ({ name: item.full_name, quantity: item.quantity })),
    guestNumber: from,
    status: "Pending",
    timestamp: new Date().toISOString()
  };

  orders.push(newOrder);
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  // Summary for the admin message
  const orderSummaryForAdmin = newOrder.items.map(item => `${item.quantity} x ${item.name}`).join('\n');
  await sock.sendMessage(hotelConfig.adminNumber, { text: `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${orderSummaryForAdmin}` });

  // Summary for the guest confirmation
  const orderSummaryForGuest = newOrder.items.map(item => `${item.quantity} x ${item.name}`).join(', ');
  await sock.sendMessage(from, { text: `✅ Your order #${orderId} for ${orderSummaryForGuest} has been placed! It will arrive shortly. Thank you for staying with us!` });

  await sock.sendMessage(from, {
    text: '🙏 We’d love your feedback! Please rate us:',
    footer: 'Tap one below to rate our service.',
    buttons: [
      { buttonText: { displayText: '⭐ 1' }, buttonId: 'star_1' },
      { buttonText: { displayText: '⭐ 2' }, buttonId: 'star_2' },
      { buttonText: { displayText: '⭐ 3' }, buttonId: 'star_3' },
      { buttonText: { displayText: '⭐ 4' }, buttonId: 'star_4' },
      { buttonText: { displayText: '⭐ 5' }, buttonId: 'star_5' }
    ],
    headerType: 1
  });
}

/**
 * Sends the full hotel menu to the guest.
 */
async function sendFullMenu(sock, number) {
  let text = `📋 Our Menu:\n\n`;
  for (const category in hotelConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${hotelConfig.hours[category]}):\n`;
    text += hotelConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "You can say things like 'I'd like to order 2 pancakes and a grilled chicken sandwich' or 'Can I get a towel?'\n";
  await sock.sendMessage(number, { text: text });
}

// Start the Express server
app.listen(3000, () => {
  console.log('🌐 Dashboard running at http://localhost:3000/admin.html');
});

// Start the bot connection process
startBotConnection();
