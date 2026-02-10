require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const TICKET_PRICE = 5000; // $50.00 in cents

// =============================================
// WP Shell — fetch header/footer from main site
// =============================================
let wpShell = { head: '', header: '', footer: '', bodyClass: '', ready: false };

async function fetchWpShell() {
  try {
    const res = await fetch('https://michaelwilliamsscholarship.com/');
    const html = await res.text();

    // Extract body classes so Elementor kit selectors work
    const bodyMatch = html.match(/<body[^>]*class="([^"]*)"/i);
    wpShell.bodyClass = bodyMatch ? bodyMatch[1] : '';

    // Extract <head> content (stylesheets + inline styles)
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const headContent = headMatch ? headMatch[1] : '';

    // Pull all <link rel="stylesheet"> and <style> tags from head
    const linkTags = headContent.match(/<link[^>]+rel=['"]stylesheet['"][^>]*>/gi) || [];
    const styleTags = headContent.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
    wpShell.head = linkTags.join('\n') + '\n' + styleTags.join('\n');

    // Extract first <header> ... </header> (the Elementor nav)
    const headerMatch = html.match(/<header data-elementor-type="header"[\s\S]*?<\/header>/i);
    wpShell.header = headerMatch ? headerMatch[0] : '';

    // Extract <footer> ... </footer> (the Elementor footer)
    const footerMatch = html.match(/<footer data-elementor-type="footer"[\s\S]*?<\/footer>/i);
    wpShell.footer = footerMatch ? footerMatch[0] : '';

    wpShell.ready = true;
    console.log('WP shell loaded successfully');
  } catch (err) {
    console.error('Failed to fetch WP shell:', err.message);
  }
}

// Fetch on startup, refresh every 30 minutes
fetchWpShell();
setInterval(fetchWpShell, 30 * 60 * 1000);

// Helper: wrap page content in WP shell
function wrapInWpShell(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${wpShell.head}
  <link rel="stylesheet" href="/style.css">
</head>
<body class="${wpShell.bodyClass}">
  ${wpShell.header}
  ${bodyContent}
  ${wpShell.footer}
</body>
</html>`;
}

// Initialize Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Turso (cloud SQLite)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Create table on startup
(async () => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      num_tickets INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      stripe_session_id TEXT,
      payment_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

// Stripe webhook needs raw body — must be before express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.log('No webhook secret configured, skipping webhook verification');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await db.execute({
      sql: 'UPDATE registrations SET payment_status = ? WHERE stripe_session_id = ?',
      args: ['paid', session.id],
    });
    console.log(`Payment confirmed via webhook for session ${session.id}`);
  }

  res.json({ received: true });
});

// Parse form data and JSON for other routes
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static assets (CSS, images, etc.) but NOT HTML pages
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Homepage — ticket purchase page wrapped in WP shell
app.get('/', (req, res) => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'content-home.html'), 'utf8');
  res.send(wrapInWpShell('MWS Hockey Fundraiser — Quinnipiac vs Colgate', content));
});

// Create Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, num_tickets } = req.body;

    // Validate
    if (!first_name || !last_name || !email || !phone || !num_tickets) {
      return res.status(400).send('All fields are required.');
    }

    const tickets = parseInt(num_tickets, 10);
    if (isNaN(tickets) || tickets < 1 || tickets > 20) {
      return res.status(400).send('Please select between 1 and 20 tickets.');
    }

    const totalAmount = tickets * TICKET_PRICE;

    // Save registration as pending
    const result = await db.execute({
      sql: `INSERT INTO registrations (first_name, last_name, email, phone, num_tickets, total_amount, payment_status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      args: [first_name, last_name, email, phone, tickets, totalAmount],
    });
    const registrationId = result.lastInsertRowid;

    // Build base URL — trust X-Forwarded headers on Vercel
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'MWS Hockey Fundraiser Ticket',
              description: 'Quinnipiac vs Colgate — Feb 21, 2025',
            },
            unit_amount: TICKET_PRICE,
          },
          quantity: tickets,
        },
      ],
      mode: 'payment',
      success_url: `${proto}://${host}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/cancel`,
      metadata: {
        registration_id: registrationId.toString(),
        first_name,
        last_name,
      },
    });

    // Update registration with Stripe session ID
    await db.execute({
      sql: 'UPDATE registrations SET stripe_session_id = ? WHERE id = ?',
      args: [session.id, Number(registrationId)],
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// Success page — update payment status
app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;

  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === 'paid') {
        await db.execute({
          sql: 'UPDATE registrations SET payment_status = ? WHERE stripe_session_id = ?',
          args: ['paid', sessionId],
        });
      }
    } catch (err) {
      console.error('Error retrieving session:', err);
    }
  }

  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'content-success.html'), 'utf8');
  res.send(wrapInWpShell('Payment Successful — MWS Hockey Fundraiser', content));
});

// Cancel page
app.get('/cancel', (req, res) => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'content-cancel.html'), 'utf8');
  res.send(wrapInWpShell('Payment Cancelled — MWS Hockey Fundraiser', content));
});

// Admin dashboard — HTTP Basic Auth
app.get('/admin', async (req, res) => {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';

  // Check for Basic Auth header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="MWS Admin"');
    return res.status(401).send('Authentication required');
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [user, pass] = credentials.split(':');

  if (user !== adminUser || pass !== adminPass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="MWS Admin"');
    return res.status(401).send('Invalid credentials');
  }

  // Fetch all registrations
  const result = await db.execute('SELECT * FROM registrations ORDER BY created_at DESC');
  const registrations = result.rows;

  // Calculate summary stats
  const totalRegistrations = registrations.length;
  const paidRegistrations = registrations.filter(r => r.payment_status === 'paid');
  const totalTicketsSold = paidRegistrations.reduce((sum, r) => sum + Number(r.num_tickets), 0);
  const totalRevenue = paidRegistrations.reduce((sum, r) => sum + Number(r.total_amount), 0);

  // Build table rows
  const rows = registrations
    .map(
      (r) => `
      <tr>
        <td>${r.first_name} ${r.last_name}</td>
        <td>${r.email}</td>
        <td>${r.phone}</td>
        <td>${r.num_tickets}</td>
        <td>$${(Number(r.total_amount) / 100).toFixed(2)}</td>
        <td><span class="status status-${r.payment_status}">${r.payment_status}</span></td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
      </tr>`
    )
    .join('');

  const html = ADMIN_TEMPLATE
    .replace('{{rows}}', rows)
    .replace('{{totalRegistrations}}', totalRegistrations)
    .replace('{{totalTicketsSold}}', totalTicketsSold)
    .replace('{{totalRevenue}}', `$${(totalRevenue / 100).toFixed(2)}`);

  res.send(html);
});

// Admin template inlined (avoids fs.readFileSync issues on serverless)
const ADMIN_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — MWS Hockey Registrations</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="admin-header">
    <h1>MWS Hockey — Registrations</h1>
  </div>
  <div class="admin-body">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{{totalRegistrations}}</div>
        <div class="stat-label">Registrations</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{totalTicketsSold}}</div>
        <div class="stat-label">Tickets Sold</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{totalRevenue}}</div>
        <div class="stat-label">Revenue</div>
      </div>
    </div>
    <table class="admin-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Tickets</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        {{rows}}
      </tbody>
    </table>
  </div>
</body>
</html>`;

// Local development — start server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`MWS Hockey server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
