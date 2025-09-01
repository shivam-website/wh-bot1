// Add this at the VERY TOP of script.js
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

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
const { app, setClient } = require('./server');

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Welcome",
  adminNumber: '9779819809195@s.whatsapp.net',
  receptionExtension: "22",
  databaseFile: path.join(__dirname, 'orders.json'),
  menuFile: path.join(__dirname, 'menu-config.json'),
  checkInTime: "2:00 PM",
  checkOutTime: "11:00 AM"
};

// Map to store user conversation states
const userStates = new Map();

// Set to track processed message IDs to prevent duplicates
const processedMessageIds = new Set();

// Initialize orders file if it doesn't exist
if (!fs.existsSync(hotelConfig.databaseFile)) {
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify([]));
}

// Function to load menu dynamically
function loadMenuConfig() {
  try {
    if (fs.existsSync(hotelConfig.menuFile)) {
      const menuData = JSON.parse(fs.readFileSync(hotelConfig.menuFile, 'utf8'));
      return {
        menu: menuData.menu,
        hours: menuData.hours,
        categories: menuData.categories || Object.keys(menuData.menu)
      };
    }
  } catch (error) {
    console.error('Error loading menu config:', error);
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

// Function to get fresh menu items (will reload menu every time)
function getAllMenuItems() {
  const currentMenuConfig = loadMenuConfig();
  
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

// Global variable for Baileys socket
let sock = null;

// Main function to start the bot connection
async function startBotConnection() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  setClient(sock);

  // Handle connection updates
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
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    // Check if message ID has been processed
    if (processedMessageIds.has(msg.key.id)) {
      return;
    }
    processedMessageIds.add(msg.key.id);
    if (processedMessageIds.size > 100) {
      const oldId = processedMessageIds.values().next().value;
      processedMessageIds.delete(oldId);
    }

    const from = msg.key.remoteJid;
    
    // Handle button responses
    if (msg.message?.buttonsResponseMessage) {
      const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
      
      // Handle rating button responses
      if (buttonId.startsWith("rate_")) {
        const rating = buttonId.split("_")[1];
        let state = userStates.get(from);

        if (state?.awaitingRating) {
          console.log(`⭐ Guest ${from} rated ${rating} stars for Order ${state.lastOrderId}`);

          await sock.sendMessage(from, { text: `⭐ Thanks for rating us ${rating} stars! We appreciate your feedback.` });

          // Forward rating to admin
          await sock.sendMessage(hotelConfig.adminNumber, { 
            text: `📩 Guest ${from} rated Order #${state.lastOrderId}: ${rating} ⭐`
          });

          state.awaitingRating = false;
          userStates.set(from, state);
        }
        return;
      }
      
      // Handle menu category selection
      if (buttonId.startsWith("menu_")) {
        const category = buttonId.split("_")[1];
        await sendMenuCategory(sock, from, category);
        return;
      }
      
      // Handle help options
      if (buttonId.startsWith("help_")) {
        if (buttonId === "help_reception") {
          await sock.sendMessage(from, { 
            text: `📞 Please dial extension ${hotelConfig.receptionExtension} for reception, or call directly at the front desk. Our staff will be happy to assist you!`
          });
        } else if (buttonId === "help_amenities") {
          await sock.sendMessage(from, { 
            text: `🏊‍♂️ Hotel Amenities:\n• Swimming Pool (6AM-10PM)\n• Fitness Center (24/7)\n• Spa (9AM-9PM)\n• Business Center (8AM-8PM)\n• Free WiFi throughout hotel`
          });
        } else if (buttonId === "help_room") {
          await sock.sendMessage(from, { 
            text: `🛌 Need room assistance?\nFor housekeeping, maintenance, or other room-related issues, please dial extension ${hotelConfig.receptionExtension} and our staff will assist you promptly.`
          });
        }
        return;
      }
    }

    const userMsg = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   (msg.message.buttonsResponseMessage ? msg.message.buttonsResponseMessage.selectedButtonId : '') || 
                   '';

    if (!userMsg) return;
    console.log(`Received message from ${from}: ${userMsg}`);

    let state = userStates.get(from) || { 
      awaitingConfirmation: false, 
      items: [], 
      room: null, 
      awaitingRating: false,
      lastOrderId: null
    };

    // Handle reset command
    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from);
      await sock.sendMessage(from, { text: "🔄 Chat reset. How may I assist you today?" });
      return;
    }

    // Handle help command
    if (userMsg.toLowerCase().includes('help')) {
      await showHelpOptions(sock, from);
      return;
    }

    // Handle status command
    if (userMsg.toLowerCase().includes('status') && state.lastOrderId) {
      const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
      const order = orders.find(o => o.id === state.lastOrderId);
      
      if (order) {
        await sock.sendMessage(from, { 
          text: `📦 Order #${order.id} Status: ${order.status}\n\nRoom: ${order.room}\nPlaced at: ${new Date(order.timestamp).toLocaleTimeString()}`
        });
      } else {
        await sock.sendMessage(from, { 
          text: "I couldn't find your recent order. Please place an order first or contact reception for assistance."
        });
      }
      return;
    }

    // Handle confirmation responses
    if (state.awaitingConfirmation) {
      const lowerUserMsg = userMsg.toLowerCase();
      if (lowerUserMsg.includes('yes') || lowerUserMsg.includes('confirm') || lowerUserMsg.includes('place order')) {
        await placeOrder(sock, from, state);
        userStates.delete(from);
        return;
      }
      if (lowerUserMsg.includes('no') || lowerUserMsg.includes('cancel')) {
        await sock.sendMessage(from, { text: "Order cancelled. Please place a new order when ready." });
        state.awaitingConfirmation = false;
        state.items = [];
        userStates.set(from, state);
        return;
      }
      
      // If we get here, the response wasn't clear
      await sock.sendMessage(from, { 
        text: "I didn't understand your response. Please reply 'yes' to confirm your order or 'no' to cancel."
      });
      return;
    }

    // Parse the message for room number and order items
    const parsed = parseUserMessage(userMsg, state);

    // Update state with detected room number
    if (parsed.roomNumber) {
      state.room = parsed.roomNumber;
      await sock.sendMessage(from, { 
        text: `✅ Room ${parsed.roomNumber} noted. What would you like to order?`
      });
    }

    // Update state with detected order items
    if (parsed.orderItems && parsed.orderItems.length > 0) {
      state.items = parsed.orderItems;
    }

    // Handle different intents
    if (parsed.intent === 'order') {
      await handleOrderIntent(sock, from, state);
    } else if (parsed.intent === 'menu') {
      await showMenuCategories(sock, from);
    } else if (parsed.intent === 'greeting') {
      await sendWelcomeMessage(sock, from);
    } else if (parsed.intent === 'provide_room_only') {
      // Already handled above
    } else {
      await sock.sendMessage(from, { 
        text: `I'm here to help you at ${hotelConfig.name}! 😊\n\nYou can:\n• Type "menu" to see food options\n• Provide your room number and order\n• Type "help" for assistance\n• Type "status" to check your order\n• Type "reset" to start over`
      });
    }

    userStates.set(from, state);
  });
}

// Send welcome message with interactive buttons
async function sendWelcomeMessage(sock, from) {
  await sock.sendMessage(from, { 
    text: `Hello! Welcome to ${hotelConfig.name}! 🏨\n\nI'm your virtual assistant here to help with:\n• Food orders 🍕\n• Menu information 📋\n• Hotel assistance 📞\n\nHow can I help you today?`
  });
}

// Show help options with buttons
async function showHelpOptions(sock, from) {
  const buttons = [
    { buttonId: 'help_reception', buttonText: { displayText: '📞 Reception' } },
    { buttonId: 'help_amenities', buttonText: { displayText: '🏊‍♂️ Amenities' } },
    { buttonId: 'help_room', buttonText: { displayText: '🛌 Room Help' } }
  ];
  
  await sock.sendMessage(from, {
    text: '🆘 How can we help you?',
    buttons: buttons,
    headerType: 1
  });
}

// Show menu categories with buttons
async function showMenuCategories(sock, from) {
  const currentMenuConfig = loadMenuConfig();
  const buttons = currentMenuConfig.categories.map(category => ({
    buttonId: `menu_${category}`,
    buttonText: { displayText: `🍽 ${category.charAt(0).toUpperCase() + category.slice(1)}` }
  }));
  
  await sock.sendMessage(from, {
    text: '📋 Please select a menu category:',
    buttons: buttons,
    headerType: 1
  });
}

// Send specific menu category
async function sendMenuCategory(sock, from, category) {
  const currentMenuConfig = loadMenuConfig();
  
  if (!currentMenuConfig.menu[category]) {
    await sock.sendMessage(from, { text: "Sorry, I couldn't find that menu category." });
    return;
  }
  
  let text = `🍽 ${category.toUpperCase()} Menu (Available: ${currentMenuConfig.hours[category]}):\n\n`;
  text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n');
  text += `\n\nTo order, just message: "Room [your number], [item name]"\nExample: "Room 105, 2 pizzas"`;
  
  await sock.sendMessage(from, { text: text });
}

// Parse user message without AI - using pattern matching
function parseUserMessage(message, currentState) {
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
  const menuItems = getAllMenuItems();
  console.log('Available menu items:', menuItems.map(item => item.name));
  
  menuItems.forEach(item => {
    const itemRegex = new RegExp(`(?:(\\d+|one|two|three|four|five|a|an)\\s+)?\\b(${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
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
  const orderKeywords = ['order', 'get', 'like', 'have', 'bring me', 'want', 'need', 'i\'d like'];
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
async function handleOrderIntent(sock, from, state) {
  // Ensure state.items is always an array
  if (!state.items) {
    state.items = [];
  }

  if (!state.room) {
    await sock.sendMessage(from, { 
      text: "I'd be happy to help with your order! 🍽️\n\nCould you please tell me your room number first? (Example: 'Room 105' or just '105')"
    });
    return;
  }

  if (state.items.length === 0) {
    await sock.sendMessage(from, { 
      text: "What would you like to order from our menu? You can say something like '2 pizzas and 1 coffee' or type 'menu' to see options."
    });
    return;
  }

  // Calculate total
  const total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const orderSummary = state.items.map(item => 
    `${item.quantity} x ${item.full_name} - ₹${item.price * item.quantity}`
  ).join('\n');
  
  await sock.sendMessage(from, { 
    text: `📋 Order Summary:\n\n🏨 Room: ${state.room}\n🍽 Items:\n${orderSummary}\n💵 Total: ₹${total}\n\nShould I place this order? Please reply 'yes' to confirm or 'no' to cancel.` 
  });
  
  state.awaitingConfirmation = true;
  userStates.set(from, state);
}

/**
 * Places the order by saving it to a JSON file and notifying the admin.
 */
async function placeOrder(sock, from, state) {
  if (!state.room || state.items.length === 0) {
    await sock.sendMessage(from, { text: "Sorry, I need both room number and order details to place your order." });
    return;
  }

  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderId = Date.now();
  const total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  
  const newOrder = {
    id: orderId,
    room: state.room,
    items: state.items.map(item => ({ 
      name: item.full_name, 
      quantity: item.quantity,
      price: item.price,
      subtotal: item.price * item.quantity
    })),
    total: total,
    guestNumber: from,
    status: "Pending",
    timestamp: new Date().toISOString()
  };

  orders.push(newOrder);
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  // Notify admin
  const orderSummaryForAdmin = newOrder.items.map(item => 
    `${item.quantity} x ${item.name} - ₹${item.subtotal}`
  ).join('\n');
  
  await sock.sendMessage(hotelConfig.adminNumber, { 
    text: `📢 NEW ORDER #${orderId}\n\n🏨 Room: ${state.room}\n📞 Guest: ${from}\n🍽 Items:\n${orderSummaryForAdmin}\n💵 Total: ₹${total}\n⏰ Time: ${new Date().toLocaleTimeString()}\n\nPlease confirm when ready.` 
  });

  // Confirm to guest
  const orderSummaryForGuest = newOrder.items.map(item => 
    `${item.quantity} x ${item.name}`
  ).join(', ');
  
  await sock.sendMessage(from, { 
    text: `✅ Order confirmed! #${orderId}\n\nYour order (${orderSummaryForGuest}) has been placed and will arrive shortly to room ${state.room}. Thank you!` 
  });

  // Ask for rating after a delay (simulated with setTimeout)
  state.lastOrderId = orderId;
  state.awaitingRating = true;
  userStates.set(from, state);
  
  setTimeout(async () => {
    const currentState = userStates.get(from);
    if (currentState && currentState.lastOrderId === orderId && currentState.awaitingRating) {
      const buttons = [
        { buttonId: 'rate_1', buttonText: { displayText: '⭐' } },
        { buttonId: 'rate_2', buttonText: { displayText: '⭐⭐' } },
        { buttonId: 'rate_3', buttonText: { displayText: '⭐⭐⭐' } },
        { buttonId: 'rate_4', buttonText: { displayText: '⭐⭐⭐⭐' } },
        { buttonId: 'rate_5', buttonText: { displayText: '⭐⭐⭐⭐⭐' } }
      ];
      
      await sock.sendMessage(from, {
        text: 'How would you rate your order experience?',
        buttons: buttons,
        headerType: 1
      });
    }
  }, 60000); // Ask for rating after 1 minute
}

// Start the server
app.listen(3000, () => {
  console.log('🌐 Dashboard running at http://localhost:3000/admin.html');
});

// Start the bot
startBotConnection();
