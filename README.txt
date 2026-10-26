# Digital Store Telegram Bot

## Features
- `/setup`: first-time setup asks for the FamGateway API key and support Telegram link. The first user to complete setup becomes the owner/admin.
- `/start`: welcome message with wallet balance and buttons in the requested layout.
- Products: lists available products. Buying uses the user's wallet balance and delivers the uploaded Telegram file.
- My Orders: shows previous purchases and their statuses.
- Deposit History: shows wallet top-up history.
- Add Balance: creates a FamGateway QR/checkout request and credits the wallet only after gateway verification.
- Support: opens the configured Telegram support link and has a Back button.
- `/admin`: Add Product, Manage Products, Users, Earnings.
- Manage Products: edit product name, price, or delivery file.
- Earnings: total sales, today's sales, and this month's sales.

## Setup
1. Install Node.js 18 or newer.
2. Create a Telegram bot using `@BotFather`.
3. Put your bot token in `config.js` or set environment variable `BOT_TOKEN`.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open your bot and send `/setup`. Enter the FamGateway API key and support Telegram link.

## Important payment notes
- The QR creation route and response fields are adapted from your uploaded `index.js`: `https://famgateway.in/api/qr.php`, `order_id`, `qr_url`, and optional `checkout_url`.
- Status checks use `checkout-status.php`; when it reports paid, the bot calls `verify-order.php` once for authoritative verification before crediting the wallet.
- Payment status response formats can differ by gateway account/API version. Test with a small amount first and check FamGateway's current API documentation. Never manually mark a payment paid based only on a screenshot.
- The bot applies a per-order check cooldown and uses a slow retry interval; it does not continuously hammer the verification endpoint.
- This is a starter implementation. Before large-scale use, consider moving JSON storage to SQLite/PostgreSQL and adding webhook verification if FamGateway supports it.

## Files and privacy
- Uploaded product files are stored as Telegram `file_id` values in `products.json`; the actual file remains on Telegram.
- `setup.json` contains the gateway API key. Do not publish it, commit it to GitHub, or share the bot's private JSON files.
- Back up the JSON files securely.
