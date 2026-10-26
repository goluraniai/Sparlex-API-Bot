'use strict';

const fs = require('fs');
const path = require('path');
const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = typeof TelegramBotModule === 'function'
  ? TelegramBotModule
  : (TelegramBotModule.TelegramBot || TelegramBotModule.default);
if (typeof TelegramBot !== 'function') {
  throw new TypeError('node-telegram-bot-api did not export a TelegramBot constructor');
}
const config = require('./config');

if (!config.BOT_TOKEN || config.BOT_TOKEN.includes('PASTE_YOUR')) {
  throw new Error('Set BOT_TOKEN in config.js or the BOT_TOKEN environment variable.');
}

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
const ROOT = __dirname;
const FILES = {
  setup: path.join(ROOT, 'setup.json'),
  users: path.join(ROOT, 'users.json'),
  products: path.join(ROOT, 'products.json'),
  orders: path.join(ROOT, 'orders.json')
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function ensure(file, fallback) { if (!fs.existsSync(file)) writeJson(file, fallback); }
ensure(FILES.setup, { completed: false, adminId: null, famGatewayApiKey: '', supportLink: '' });
ensure(FILES.users, {});
ensure(FILES.products, {});
ensure(FILES.orders, {});

let setup = readJson(FILES.setup, { completed: false, adminId: null, famGatewayApiKey: '', supportLink: '' });
let users = readJson(FILES.users, {});
let products = readJson(FILES.products, {});
let orders = readJson(FILES.orders, {});
const setupFlow = new Map();
const adminFlow = new Map();
const depositFlow = new Map();
const verifyLocks = new Set();
const lastCheck = new Map();
const pollTimers = new Map();
const screenIds = new Map();

const money = n => '₹' + Number(n || 0).toFixed(2).replace(/\.00$/, '');
const now = () => new Date().toISOString();
const id = prefix => prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const saveSetup = () => writeJson(FILES.setup, setup);
const saveUsers = () => writeJson(FILES.users, users);
const saveProducts = () => writeJson(FILES.products, products);
const saveOrders = () => writeJson(FILES.orders, orders);
const isAdmin = uid => Boolean(setup.adminId) && String(setup.adminId) === String(uid);
const ready = () => Boolean(setup.completed && setup.adminId && setup.famGatewayApiKey && setup.supportLink);

function getUser(tg, chatId) {
  const key = String(tg.id);
  if (!users[key]) users[key] = {
    userId: tg.id, chatId, firstName: tg.first_name || '', lastName: tg.last_name || '',
    username: tg.username || '', wallet: 0, createdAt: now(), lastSeen: now()
  };
  Object.assign(users[key], {
    chatId, firstName: tg.first_name || users[key].firstName || '',
    lastName: tg.last_name || users[key].lastName || '',
    username: tg.username || users[key].username || '', lastSeen: now()
  });
  users[key].wallet = Number(users[key].wallet || 0);
  saveUsers();
  return users[key];
}
function userLabel(u) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || (u.username ? '@' + u.username : String(u.userId));
}
function homeText(u) {
  return `👋 <b>Welcome, ${esc(u.firstName || userLabel(u))}!</b>\n\n🛍️ <b>Digital Store</b>\n💰 Balance: <b>${money(u.wallet)}</b>\n\n✨ Choose an option below 👇`;
}
async function clearScreen(chatId) {
  const mid = screenIds.get(String(chatId));
  if (mid) { try { await bot.deleteMessage(chatId, mid); } catch (_) {} }
  screenIds.delete(String(chatId));
}
async function screenMessage(chatId, text, options = {}) {
  await clearScreen(chatId);
  const sent = await bot.sendMessage(chatId, text, options);
  screenIds.set(String(chatId), sent.message_id);
  return sent;
}
async function screenPhoto(chatId, photo, options = {}) {
  await clearScreen(chatId);
  const sent = await bot.sendPhoto(chatId, photo, options);
  screenIds.set(String(chatId), sent.message_id);
  return sent;
}
async function showHome(chatId, u) {
  return screenMessage(chatId, homeText(u), {
    parse_mode: 'HTML',
    reply_markup: inline([
      [btn('🛍️ Products', 'products'), btn('📦 My Orders', 'myorders')],
      [btn('🧾 Deposit History', 'deposithistory')],
      [btn('💚 Add Balance', 'addbalance'), btn('🛟 Support', 'support')]
    ])
  });
}
async function showProducts(chatId) {
  const available = Object.values(products).filter(p => p && p.active !== false);
  const rows = available.map(p => [btn(`${p.name} · ${money(p.price)}`, `buy:${p.id}`)]);
  if (!rows.length) rows.push([btn('No products available yet', 'noop')]);
  rows.push([btn('⬅️ Back', 'home')]);
  return screenMessage(chatId, '🛍️ <b>All Products</b>\n\nSelect a product to view details.', {
    parse_mode: 'HTML', reply_markup: inline(rows)
  });
}
async function showOrders(chatId, uid) {
  const list = Object.values(orders).filter(o => String(o.userId) === String(uid) && o.type === 'purchase')
    .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
  let text = '📦 <b>My Orders</b>\n\n';
  if (!list.length) text += 'No orders found.';
  else text += list.map(o => `• <b>${esc(o.productName)}</b> — ${money(o.amount)}\n  Status: ${esc(o.status)}\n  Order: <code>${esc(o.orderId)}</code>\n  Date: ${esc(new Date(o.createdAt).toLocaleString('en-IN'))}`).join('\n\n');
  return screenMessage(chatId, text, { parse_mode: 'HTML', reply_markup: inline([[btn('🛍️ Products', 'products')], [btn('⬅️ Back', 'home')]]) });
}
async function showDepositHistory(chatId, uid) {
  const list = Object.values(orders).filter(o => String(o.userId) === String(uid) && o.type === 'topup')
    .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
  let text = '🧾 <b>Deposit History</b>\n\n';
  if (!list.length) text += 'No deposits found.';
  else text += list.map(o => `• ${money(o.amount)} — <b>${esc(o.status)}</b>\n  ${esc(new Date(o.createdAt).toLocaleString('en-IN'))}\n  Order: <code>${esc(o.orderId)}</code>`).join('\n\n');
  return screenMessage(chatId, text, { parse_mode: 'HTML', reply_markup: inline([[btn('⬅️ Back', 'home')]]) });
}
async function showSupport(chatId) {
  return screenMessage(chatId, '🛟 <b>Support Center</b>\n\nChoose a support option below.', {
    parse_mode: 'HTML', reply_markup: inline([
      [{ text: 'Telegram Support ↗', url: setup.supportLink }],
      [btn('« Back', 'home')]
    ])
  });
}
async function askDepositAmount(chatId, uid) {
  depositFlow.set(String(chatId), String(uid));
  return bot.sendMessage(chatId,
    '💰 <b>ENTER YOUR DEPOSIT AMOUNT</b>\n\n━━━━━━━━━━━━━━━━━━\n\n🔹 Minimum Deposit: ₹1\n\n🔹 Enter the amount you want to add.\n\n━━━━━━━━━━━━━━━━━━\n\n💡 <i>Example: 100</i>',
    { parse_mode: 'HTML', reply_markup: inline([[btn('❌ Cancel', 'home')]]) });
}
function gatewayStatus(obj) {
  const values = [];
  function walk(v, depth = 0) {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { values.push(String(v).trim().toLowerCase()); return; }
    if (Array.isArray(v)) return v.forEach(x => walk(x, depth + 1));
    if (typeof v === 'object') for (const [k, val] of Object.entries(v)) {
      if (/(status|payment|paid|state|success|result)/i.test(k)) walk(val, depth + 1);
    }
  }
  walk(obj);
  return values;
}
function isPaid(obj) {
  if (obj?.data?.paid === true || obj?.paid === true || obj?.success === true) return true;
  const good = new Set(['paid','success','successful','completed','complete','approved','confirmed','payment_success','payment_successful']);
  return gatewayStatus(obj).some(v => good.has(v) || /^(paid|success|successful|completed|complete|approved|confirmed)(\s|_|-)/.test(v));
}
function isExpired(obj) {
  const bad = new Set(['expired','failed','cancelled','canceled','rejected','declined']);
  return gatewayStatus(obj).some(v => bad.has(v));
}
async function gatewayGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Digital-Store-Bot/1.0' }, signal: controller.signal });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error(`FamGateway returned invalid JSON (HTTP ${res.status}).`); }
    if (!res.ok) throw new Error(`FamGateway HTTP ${res.status}: ${data.message || data.error || data.status || 'Request failed'}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function createGatewayOrder(amount, user) {
  const url = 'https://famgateway.in/api/qr.php' +
    `?api_key=${encodeURIComponent(setup.famGatewayApiKey)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&customer_name=${encodeURIComponent(user.firstName || 'Digital Store User')}` +
    `&customer_phone=`;
  const response = await gatewayGet(url);
  if (response.status !== 'success' || !response.data?.order_id || !response.data?.qr_url) {
    throw new Error(response.message || response.error || 'FamGateway did not return a valid QR order.');
  }
  return response.data;
}
async function verifyGatewayOrder(gatewayOrderId) {
  const status = await gatewayGet('https://famgateway.in/api/checkout-status.php?order_id=' + encodeURIComponent(gatewayOrderId));
  if (isExpired(status)) return { status: 'EXPIRED' };
  if (!isPaid(status)) return { status: 'PENDING' };
  // Only one authoritative API-key verification after public status reports paid.
  const verified = await gatewayGet('https://famgateway.in/api/verify-order.php' +
    `?api_key=${encodeURIComponent(setup.famGatewayApiKey)}&order_id=${encodeURIComponent(gatewayOrderId)}`);
  if (isPaid(verified)) return { status: 'PAID' };
  if (isExpired(verified)) return { status: 'EXPIRED' };
  return { status: 'PENDING' };
}
async function finishTopup(order) {
  if (order.status !== 'PENDING') return;
  const u = users[String(order.userId)];
  if (!u) return;
  order.status = 'PAID';
  order.paidAt = now();
  if (order.type === 'product_payment') {
    const p = products[order.productId];
    saveOrders();
    stopPolling(order.orderId);
    if (!p || p.active === false) {
      await bot.sendMessage(u.chatId, `✅ Payment verified for ${money(order.amount)}, but the product is unavailable. Contact support with order ID ${order.orderId}.`);
      return;
    }
    try {
      await bot.sendDocument(u.chatId, p.fileId, {caption:`✅ Payment successful!\n\n📦 Product: ${p.name}\n💰 Paid: ${money(order.amount)}\n🧾 Order: ${order.orderId}`});
      order.type = 'purchase'; order.productName = p.name; saveOrders();
    } catch (e) {
      order.status = 'PAID_DELIVERY_FAILED'; order.deliveryError = String(e.message || e); saveOrders();
      await bot.sendMessage(u.chatId, `⚠️ Payment verified, but file delivery failed. Contact support with order ID ${order.orderId}.`);
    }
    return;
  }
  u.wallet = Number(u.wallet || 0) + Number(order.amount || 0);
  if (u.currentOrderId === order.orderId) delete u.currentOrderId;
  saveOrders(); saveUsers();
  stopPolling(order.orderId);
  await bot.sendMessage(u.chatId, `✅ <b>DEPOSIT SUCCESSFUL</b>\n\n💰 Added: <b>${money(order.amount)}</b>\n👛 New balance: <b>${money(u.wallet)}</b>`, {
    parse_mode: 'HTML', reply_markup: inline([[btn('🏠 Main Menu', 'home')], [btn('🛍️ Products', 'products')]])
  });
}
function stopPolling(orderId) {
  const t = pollTimers.get(orderId);
  if (t) clearTimeout(t);
  pollTimers.delete(orderId);
}
async function checkOrder(orderId, manual = false, chatId = null) {
  const order = orders[orderId];
  if (!order || order.status !== 'PENDING') return;
  const last = lastCheck.get(orderId) || 0;
  if (manual && Date.now() - last < 10000) {
    if (chatId) await bot.sendMessage(chatId, '⏳ Please wait a few seconds before checking again.');
    return;
  }
  if (verifyLocks.has(orderId)) return;
  verifyLocks.add(orderId);
  if (manual) lastCheck.set(orderId, Date.now());
  try {
    const result = await verifyGatewayOrder(order.gatewayOrderId);
    if (result.status === 'PAID') return finishTopup(order);
    if (result.status === 'EXPIRED') {
      order.status = 'EXPIRED'; saveOrders(); stopPolling(orderId);
      if (chatId) await bot.sendMessage(chatId, '❌ This payment request has expired. Please create a new one.');
      return;
    }
    if (manual && chatId) await bot.sendMessage(chatId, '⏳ Payment is not verified yet. If you have paid, wait briefly and check again.');
  } catch (e) {
    console.error('Payment verification error:', e.message);
    if (manual && chatId) await bot.sendMessage(chatId, '⚠️ Could not verify payment right now. Please try again later.');
  } finally { verifyLocks.delete(orderId); }
}
function startPolling(orderId) {
  stopPolling(orderId);
  const order = orders[orderId];
  if (!order || order.status !== 'PENDING') return;
  const created = Date.parse(order.createdAt);
  if (Number.isFinite(created) && Date.now() - created >= 5 * 60 * 1000) {
    order.status = 'EXPIRED'; saveOrders(); return;
  }
  const timer = setTimeout(async () => {
    await checkOrder(orderId, false);
    if (orders[orderId]?.status === 'PENDING') startPolling(orderId);
  }, 30000);
  pollTimers.set(orderId, timer);
}
async function createTopup(chatId, user, amount) {
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
    return bot.sendMessage(chatId, '❌ Enter a valid amount between ₹1 and ₹100000.');
  }
  if (user.currentOrderId && orders[user.currentOrderId]?.status === 'PENDING') {
    return bot.sendMessage(chatId, '⏳ You already have a pending payment. Complete it or wait until it expires.');
  }
  try {
    const gateway = await createGatewayOrder(amount, user);
    const orderId = id('TOPUP');
    orders[orderId] = {
      orderId, userId: user.userId, amount, gatewayOrderId: gateway.order_id,
      status: 'PENDING', type: 'topup', createdAt: now(), paidAt: null
    };
    user.currentOrderId = orderId;
    saveOrders(); saveUsers();
    await bot.sendPhoto(chatId, gateway.qr_url, {
      caption: `💳 PAYMENT REQUIRED\n\n💰 Amount: ${money(amount)}\n\nScan the QR or tap PAY NOW. After paying, press CHECK PAYMENT.`,
      reply_markup: inline([
        [{ text: '💳 PAY NOW', url: gateway.checkout_url || gateway.qr_url }],
        [btn('🔄 CHECK PAYMENT', `checkpay:${orderId}`)],
        [btn('❌ Cancel', 'home')]
      ])
    });
    startPolling(orderId);
  } catch (e) {
    console.error('Create payment failed:', e.message);
    await bot.sendMessage(chatId, `❌ Could not create payment request.\n\nReason: ${esc(e.message)}\n\nPlease try again later.`, {
      parse_mode: 'HTML', reply_markup: inline([[btn('🔁 Try Again', 'addbalance')], [btn('⬅️ Back', 'home')]])
    });
  }
}

async function createProductPayment(chatId, user, product) {
  try {
    const amount = Number(product.price);
    const gateway = await createGatewayOrder(amount, user);
    const orderId = id('BUY');
    orders[orderId] = {
      orderId, userId: user.userId, amount, gatewayOrderId: gateway.order_id,
      status: 'PENDING', type: 'product_payment', productId: product.id,
      productName: product.name, createdAt: now(), paidAt: null
    };
    user.currentOrderId = orderId;
    saveOrders(); saveUsers();
    return screenPhoto(chatId, gateway.qr_url, {
      caption: `💳 <b>PAY FOR PRODUCT</b>\n\n📦 ${esc(product.name)}\n💰 Amount: <b>${money(amount)}</b>\n\nScan the QR or tap PAY NOW. After payment is verified, the product file will be delivered.`,
      parse_mode: 'HTML',
      reply_markup: inline([
        [{text:'💳 PAY NOW', url: gateway.checkout_url || gateway.qr_url}],
        [btn('🔄 CHECK PAYMENT', `checkpay:${orderId}`)],
        [btn('❌ Cancel', 'home')]
      ])
    });
  } catch (e) {
    console.error('Product payment create failed:', e.message);
    return screenMessage(chatId, `❌ Could not create payment request.\n\n${esc(e.message)}`, {parse_mode:'HTML', reply_markup:inline([[btn('🔁 Try Again', `purchase:${product.id}`)],[btn('⬅️ Back','products')]])});
  }
}
async function showAdmin(chatId) {
  return screenMessage(chatId, '🛠️ <b>Admin Panel</b>\n\nChoose an option:', {
    parse_mode: 'HTML', reply_markup: inline([
      [btn('➕ Add Product', 'admin:add'), btn('🧰 Manage Products', 'admin:manage')],
      [btn('👥 Users', 'admin:users'), btn('💵 Earnings', 'admin:earnings')],
      [btn('⬅️ Back', 'home')]
    ])
  });
}
async function startAddProduct(chatId, uid) {
  adminFlow.set(String(chatId), { uid, step: 'name', data: {} });
  return bot.sendMessage(chatId, '➕ <b>Add Product</b>\n\n1/3 — Send the product name.', { parse_mode: 'HTML', reply_markup: inline([[btn('❌ Cancel', 'admin:home')]]) });
}
async function showManageProducts(chatId) {
  const list = Object.values(products);
  const rows = list.map(p => [btn(`${p.active === false ? '⏸️ ' : '📦 '}${p.name} · ${money(p.price)}`, `admin:product:${p.id}`)]);
  if (!rows.length) rows.push([btn('No products added yet', 'noop')]);
  rows.push([btn('⬅️ Back', 'admin:home')]);
  return screenMessage(chatId, '🧰 <b>Manage Products</b>\n\nSelect a product:', { parse_mode: 'HTML', reply_markup: inline(rows) });
}
async function showProductAdmin(chatId, p) {
  return screenMessage(chatId, `📦 <b>${esc(p.name)}</b>\nPrice: <b>${money(p.price)}</b>\nStatus: ${p.active === false ? 'Disabled' : 'Available'}`, {
    parse_mode: 'HTML', reply_markup: inline([
      [btn('✏️ Edit Name', `admin:editname:${p.id}`), btn('💰 Edit Price', `admin:editprice:${p.id}`)],
      [btn('📁 Replace File', `admin:editfile:${p.id}`)],
      [btn(p.active === false ? '✅ Enable Product' : '⏸️ Disable Product', `admin:toggle:${p.id}`)],
      [btn('🗑️ Delete Product', `admin:delete:${p.id}`)],
      [btn('⬅️ Back', 'admin:manage')]
    ])
  });
}
async function showUsers(chatId) {
  const list = Object.values(users).sort((a,b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  const rows = list.slice(0, 50).map(u => [btn(`${userLabel(u)} · ${money(u.wallet)}`, `admin:user:${u.userId}`)]);
  if (!rows.length) rows.push([btn('No users yet', 'noop')]);
  rows.push([btn(`Total users: ${list.length}`, 'noop')], [btn('⬅️ Back', 'admin:home')]);
  return screenMessage(chatId, '👥 <b>Users</b>\n\nSelect a user (showing latest 50):', { parse_mode: 'HTML', reply_markup: inline(rows) });
}
async function showUserAdmin(chatId, u) {
  return bot.sendMessage(chatId,
    `👤 <b>${esc(userLabel(u))}</b>\nID: <code>${u.userId}</code>\nUsername: ${u.username ? '@' + esc(u.username) : '—'}\nWallet: <b>${money(u.wallet)}</b>\nJoined: ${esc(u.createdAt || '—')}`,
    { parse_mode: 'HTML', reply_markup: inline([[btn('⬅️ Back', 'admin:users')]]) });
}
function salesSummary() {
  const sales = Object.values(orders).filter(o => o.type === 'purchase' && o.status === 'PAID');
  const today = new Date(); today.setHours(0,0,0,0);
  const month = new Date(); month.setDate(1); month.setHours(0,0,0,0);
  const sum = arr => arr.reduce((n,o) => n + Number(o.amount || 0), 0);
  return { total: sum(sales), today: sum(sales.filter(o => Date.parse(o.paidAt || o.createdAt) >= today.getTime())),
    month: sum(sales.filter(o => Date.parse(o.paidAt || o.createdAt) >= month.getTime())), count: sales.length };
}
async function showEarnings(chatId) {
  const s = salesSummary();
  return screenMessage(chatId, `💵 <b>Earnings</b>\n\n🧾 Total sales: <b>${money(s.total)}</b>\n📅 Today's sales: <b>${money(s.today)}</b>\n🗓️ This month's sales: <b>${money(s.month)}</b>\n📦 Paid orders: <b>${s.count}</b>`, {
    parse_mode: 'HTML', reply_markup: inline([[btn('🔄 Refresh', 'admin:earnings')], [btn('⬅️ Back', 'admin:home')]])
  });
}
async function deliverProduct(chatId, user, p) {
  if (Number(user.wallet) < Number(p.price)) {
    return bot.sendMessage(chatId, `❌ Insufficient balance.\n\nProduct: ${p.name}\nPrice: ${money(p.price)}\nYour balance: ${money(user.wallet)}`, {
      reply_markup: inline([[btn('💚 Add Balance', 'addbalance')], [btn('⬅️ Back', 'products')]])
    });
  }
  const orderId = id('ORDER');
  // Persist order and wallet debit together before attempting delivery.
  user.wallet = Number((Number(user.wallet) - Number(p.price)).toFixed(2));
  orders[orderId] = { orderId, userId: user.userId, productId: p.id, productName: p.name, amount: Number(p.price), status: 'PAID', type: 'purchase', createdAt: now(), paidAt: now() };
  saveUsers(); saveOrders();
  try {
    await bot.sendDocument(chatId, p.fileId, { caption: `✅ Purchase successful!\n\n📦 Product: ${p.name}\n💰 Paid: ${money(p.price)}\n🧾 Order: ${orderId}` });
  } catch (e) {
    // Do not silently lose the paid file delivery: mark order for admin support.
    orders[orderId].status = 'PAID_DELIVERY_FAILED';
    orders[orderId].deliveryError = String(e.message || e);
    saveOrders();
    await bot.sendMessage(chatId, '⚠️ Your payment was recorded, but Telegram could not deliver the file. Please contact support and share order ID: ' + orderId);
  }
  return showHome(chatId, user);
}

bot.on('message', async msg => {
  if (!msg.from || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const u = getUser(msg.from, chatId);
  const text = String(msg.text || '').trim();

  if (text === '/start') {
    if (!ready()) return bot.sendMessage(chatId, '⚙️ Store setup is not complete yet. The owner must run /setup.');
    return showHome(chatId, u);
  }
  if (text === '/setup') {
    if (setup.adminId && !isAdmin(uid)) return bot.sendMessage(chatId, '❌ Setup has already been claimed by the store owner.');
    if (!setup.adminId) { setup.adminId = uid; saveSetup(); }
    setupFlow.set(String(chatId), { uid, step: 'api' });
    return bot.sendMessage(chatId, '⚙️ <b>Store Setup (1/2)</b>\n\nSend your FamGateway API key.\nIt will be saved locally in setup.json. Do not share it with anyone.', { parse_mode: 'HTML' });
  }
  if (text === '/admin') {
    if (!isAdmin(uid)) return bot.sendMessage(chatId, '❌ Admin only.');
    if (!ready()) return bot.sendMessage(chatId, '⚙️ Finish setup first with /setup.');
    return showAdmin(chatId);
  }

  // Admin setup conversation: the owner ID is fixed at the first /setup.
  const sf = setupFlow.get(String(chatId));
  if (sf && sf.uid === uid && text && !text.startsWith('/')) {
    if (sf.step === 'api') {
      if (text.length < 8 || text.length > 500) return bot.sendMessage(chatId, 'That API key does not look valid. Please send it again.');
      setup.famGatewayApiKey = text;
      sf.step = 'support';
      saveSetup();
      return bot.sendMessage(chatId, '⚙️ <b>Store Setup (2/2)</b>\n\nSend your Telegram support link (for example, https://t.me/yourchannel).', { parse_mode: 'HTML' });
    }
    if (sf.step === 'support') {
      if (!/^https:\/\/t\.me\/[A-Za-z0-9_+/-]+\/?$/.test(text) && !/^https:\/\/t\.me\/\+[A-Za-z0-9_-]+$/.test(text)) {
        return bot.sendMessage(chatId, 'Please send a valid Telegram link, such as https://t.me/yourchannel.');
      }
      setup.supportLink = text;
      setup.completed = true;
      saveSetup(); setupFlow.delete(String(chatId));
      return bot.sendMessage(chatId, '✅ Setup complete! You are the store admin.\n\nUse /admin to add products and manage your store.');
    }
  }

  // Admin flow accepts text for name/price, and a Telegram document for the file.
  const af = adminFlow.get(String(chatId));
  if (af && af.uid === uid && isAdmin(uid)) {
    if (af.step === 'file' || af.step === 'editfile') {
      if (!msg.document) return bot.sendMessage(chatId, 'Please upload the product as a Telegram document (use the paperclip → File).');
      if (af.step === 'file') {
        const productId = id('PROD');
        products[productId] = { id: productId, name: af.data.name, price: Number(af.data.price), fileId: msg.document.file_id, fileName: msg.document.file_name || '', active: true, createdAt: now() };
        saveProducts(); adminFlow.delete(String(chatId));
        return bot.sendMessage(chatId, `✅ Product added!\n\n📦 ${esc(products[productId].name)}\n💰 ${money(products[productId].price)}`, { parse_mode: 'HTML', reply_markup: inline([[btn('➕ Add Another', 'admin:add')], [btn('🛠️ Admin Panel', 'admin:home')]]) });
      } else {
        const p = products[af.productId];
        if (!p) { adminFlow.delete(String(chatId)); return bot.sendMessage(chatId, 'Product not found.'); }
        p.fileId = msg.document.file_id; p.fileName = msg.document.file_name || ''; saveProducts(); adminFlow.delete(String(chatId));
        return bot.sendMessage(chatId, '✅ Product delivery file updated.', { reply_markup: inline([[btn('⬅️ Manage Products', 'admin:manage')]]) });
      }
    }
    if (!text || text.startsWith('/')) return;
    if (af.step === 'name') {
      if (text.length > 100) return bot.sendMessage(chatId, 'Product name must be 100 characters or fewer.');
      af.data.name = text; af.step = 'price';
      return bot.sendMessage(chatId, '2/3 — Send the product price in INR (example: 499).');
    }
    if (af.step === 'price' || af.step === 'editprice') {
      const price = Number(text);
      if (!Number.isFinite(price) || price <= 0 || price > 10000000) return bot.sendMessage(chatId, 'Enter a valid price greater than ₹0.');
      if (af.step === 'editprice') {
        const p = products[af.productId];
        if (!p) { adminFlow.delete(String(chatId)); return bot.sendMessage(chatId, 'Product not found.'); }
        p.price = price; saveProducts(); adminFlow.delete(String(chatId));
        return bot.sendMessage(chatId, `✅ Price updated to ${money(price)}.`, { reply_markup: inline([[btn('⬅️ Manage Products', 'admin:manage')]]) });
      }
      af.data.price = price; af.step = 'file';
      return bot.sendMessage(chatId, '3/3 — Upload the file users will receive after payment.\n\nUse Telegram attachment → File.');
    }
    if (af.step === 'editname') {
      const p = products[af.productId];
      if (!p) { adminFlow.delete(String(chatId)); return bot.sendMessage(chatId, 'Product not found.'); }
      if (text.length > 100) return bot.sendMessage(chatId, 'Product name must be 100 characters or fewer.');
      p.name = text; saveProducts(); adminFlow.delete(String(chatId));
      return bot.sendMessage(chatId, '✅ Product name updated.', { reply_markup: inline([[btn('⬅️ Manage Products', 'admin:manage')]]) });
    }
  }

  const waitingUid = depositFlow.get(String(chatId));
  if (waitingUid === String(uid) && text && !text.startsWith('/')) {
    depositFlow.delete(String(chatId));
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount)) return bot.sendMessage(chatId, '❌ Enter a whole-number amount of at least ₹1, for example 100.');
    return createTopup(chatId, u, amount);
  }
});

bot.on('callback_query', async q => {
  const chatId = q.message?.chat?.id;
  const uid = q.from.id;
  if (!chatId) return bot.answerCallbackQuery(q.id);
  const u = getUser(q.from, chatId);
  const data = String(q.data || '');
  try {
    await bot.answerCallbackQuery(q.id);
    if (data === 'noop') return;
    if (data === 'home') return showHome(chatId, u);
    if (data === 'products') return showProducts(chatId);
    if (data === 'myorders') return showOrders(chatId, uid);
    if (data === 'deposithistory') return showDepositHistory(chatId, uid);
    if (data === 'addbalance') return askDepositAmount(chatId, uid);
    if (data === 'support') return showSupport(chatId);
    if (data.startsWith('buy:')) {
      const p = products[data.slice(4)];
      if (!p || p.active === false) return bot.sendMessage(chatId, '❌ This product is no longer available.');
      return screenMessage(chatId, `📦 <b>${esc(p.name)}</b>\n\n💰 Price: <b>${money(p.price)}</b>\n\nChoose an option below.`, {
        parse_mode: 'HTML', reply_markup: inline([[btn('✅ Buy Now', `purchase:${p.id}`)], [btn('⬅️ Back', 'products')]])
      });
    }
    if (data.startsWith('purchase:')) {
      const p = products[data.slice(9)];
      if (!p || p.active === false) return screenMessage(chatId, '❌ This product is no longer available.', {reply_markup:inline([[btn('⬅️ Back','products')]])});
      if (Number(u.wallet || 0) < Number(p.price || 0)) {
        // Product-specific checkout: create a payment QR for the exact shortfall/price.
        // Keep the current UI screen and do not send the user back to Add Balance.
        return createProductPayment(chatId, u, p);
      }
      return deliverProduct(chatId, u, p);
    }
    if (data.startsWith('checkpay:')) {
      const orderId = data.slice(9);
      if (!orders[orderId] || String(orders[orderId].userId) !== String(uid)) return bot.sendMessage(chatId, '❌ This payment does not belong to your account.');
      if (orders[orderId].status !== 'PENDING') return bot.sendMessage(chatId, `ℹ️ Payment status: ${orders[orderId].status}`);
      return checkOrder(orderId, true, chatId);
    }

    if (!isAdmin(uid)) return bot.sendMessage(chatId, '❌ Admin only.');
    if (data === 'admin:home') return showAdmin(chatId);
    if (data === 'admin:add') return startAddProduct(chatId, uid);
    if (data === 'admin:manage') return showManageProducts(chatId);
    if (data === 'admin:users') return showUsers(chatId);
    if (data === 'admin:earnings') return showEarnings(chatId);
    if (data.startsWith('admin:user:')) {
      const target = users[data.slice(11)];
      if (!target) return bot.sendMessage(chatId, 'User not found.');
      return showUserAdmin(chatId, target);
    }
    if (data.startsWith('admin:product:')) {
      const p = products[data.slice(14)];
      if (!p) return bot.sendMessage(chatId, 'Product not found.');
      return showProductAdmin(chatId, p);
    }
    if (data.startsWith('admin:editname:')) {
      const productId = data.slice(15);
      if (!products[productId]) return bot.sendMessage(chatId, 'Product not found.');
      adminFlow.set(String(chatId), { uid, step: 'editname', productId });
      return bot.sendMessage(chatId, 'Send the new product name.');
    }
    if (data.startsWith('admin:editprice:')) {
      const productId = data.slice(16);
      if (!products[productId]) return bot.sendMessage(chatId, 'Product not found.');
      adminFlow.set(String(chatId), { uid, step: 'editprice', productId });
      return bot.sendMessage(chatId, 'Send the new price in INR.');
    }
    if (data.startsWith('admin:editfile:')) {
      const productId = data.slice(15);
      if (!products[productId]) return bot.sendMessage(chatId, 'Product not found.');
      adminFlow.set(String(chatId), { uid, step: 'editfile', productId });
      return bot.sendMessage(chatId, 'Upload the replacement file as a Telegram document.');
    }
    if (data.startsWith('admin:toggle:')) {
      const p = products[data.slice(13)];
      if (!p) return bot.sendMessage(chatId, 'Product not found.');
      p.active = p.active === false; saveProducts();
      return showProductAdmin(chatId, p);
    }
    if (data.startsWith('admin:delete:')) {
      const productId = data.slice(13);
      if (!products[productId]) return bot.sendMessage(chatId, 'Product not found.');
      delete products[productId]; saveProducts();
      return bot.sendMessage(chatId, '🗑️ Product deleted.', { reply_markup: inline([[btn('🧰 Manage Products', 'admin:manage')]]) });
    }
  } catch (e) {
    console.error('Callback handler error:', e);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

bot.on('polling_error', e => console.error('Telegram polling error:', e.message));
bot.on('error', e => console.error('Telegram bot error:', e.message));
console.log('Digital Store bot started. Open Telegram and send /setup (first-time owner) or /start.');
