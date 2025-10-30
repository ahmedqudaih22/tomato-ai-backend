// A simple backend for Tomato AI
// NOTE: This is a basic implementation and lacks robust error handling, password hashing, etc.
// It's designed to be a functional starting point for the Render deployment.

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware ---
// The Stripe webhook endpoint needs the raw body, so we apply express.json() conditionally.
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(cors());


// --- Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- Secure Data ---
// In a real app, this would come from the database and be managed in the admin panel.
// For simplicity and security, we define it here. Price is in cents.
const packages = [
    { id: 1, points: 100, price: 500 },   // $5.00
    { id: 2, points: 250, price: 1000 },  // $10.00
    { id: 3, points: 300, price: 100 },   // $1.00 (for testing)
    { id: 4, points: 1500, price: 4000 }, // $40.00
];

// --- Database Initialization ---
const initializeDb = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                country VARCHAR(10),
                points INTEGER DEFAULT 10,
                is_admin BOOLEAN DEFAULT FALSE,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database initialized: 'users' table is ready.");
    } catch (err) {
        console.error("Error initializing database:", err);
    } finally {
        client.release();
    }
};

// --- Stripe Setup ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- Auth Middleware ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    try {
        const userId = parseInt(token);
        if (isNaN(userId)) return res.sendStatus(401);

        const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            return res.sendStatus(403);
        }
        req.user = result.rows[0];
        next();
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.sendStatus(500);
    }
};


// --- API Routes ---

// User Registration
app.post('/api/register', async (req, res) => {
    const { email, password, country } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        // Check if it's the first user, make them admin
        const userCountResult = await pool.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCountResult.rows[0].count) === 0;

        // In a real app, you MUST hash the password.
        const result = await pool.query(
            'INSERT INTO users (email, password, country, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, email, country, points, is_admin, status',
            [email, password, country, isFirstUser]
        );
        
        const user = result.rows[0];
        // For simplicity, we'll use the user ID as a token. Use JWT in production.
        const token = user.id.toString(); 

        res.status(201).json({ message: 'User registered successfully', user, token });

    } catch (err) {
        if (err.code === '23505') { // unique_violation
            return res.status(409).json({ message: 'Email already exists.' });
        }
        console.error(err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// User Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (user.status === 'banned') {
            return res.status(403).json({ message: 'This account is banned.' });
        }
        
        const token = user.id.toString();
        delete user.password;
        res.status(200).json({ message: 'Login successful', user, token });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Fetch user data based on a token
app.get('/api/users/me', authenticateToken, async (req, res) => {
    const user = req.user;
    delete user.password;
    res.json({ user });
});

// Update user profile
app.put('/api/users/me', authenticateToken, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.user.id;
    
    try {
        let query;
        let queryParams;
        if (password) {
            query = 'UPDATE users SET email = $1, password = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status';
            queryParams = [email, password, userId];
        } else {
            query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, country, points, is_admin, status';
            queryParams = [email, userId];
        }
        const result = await pool.query(query, queryParams);
        res.json({ user: result.rows[0] });
    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating profile' });
    }
});

// Deduct points for an operation
app.post('/api/users/deduct-points', authenticateToken, async (req, res) => {
    const { amount } = req.body;
    const userId = req.user.id;

    if (req.user.points < amount) {
        return res.status(402).json({ message: 'Insufficient points' });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET points = points - $1 WHERE id = $2 RETURNING id, email, country, points, is_admin, status',
            [amount, userId]
        );
        res.json({ user: result.rows[0] });
    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating points' });
    }
});

// Create Stripe Checkout Session
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    const { packageId } = req.body;
    const user = req.user;

    const pkg = packages.find(p => p.id === packageId);
    if (!pkg) {
        return res.status(404).json({ message: 'Package not found.' });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${pkg.points} Points Package`,
                        description: `Get ${pkg.points} points for your Tomato AI account.`,
                    },
                    unit_amount: pkg.price,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `https://tomato-ai-154300777659.us-west1.run.app/?payment_success=true#store`,
            cancel_url: `https://tomato-ai-154300777659.us-west1.run.app/?payment_cancelled=true#store`,
            customer_email: user.email,
            metadata: {
                userEmail: user.email,
                pointsToAdd: pkg.points.toString(),
            }
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error("Stripe session creation error:", err);
        res.status(500).json({ message: 'Failed to create payment session.' });
    }
});


// --- Stripe Webhook ---
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    const userEmail = session.metadata.userEmail;
    const pointsToAdd = parseInt(session.metadata.pointsToAdd, 10);

    if (userEmail && pointsToAdd) {
        console.log(`Payment successful for ${userEmail}. Attempting to add ${pointsToAdd} points.`);
        try {
            const result = await pool.query(
                'UPDATE users SET points = points + $1 WHERE email = $2 RETURNING email, points',
                [pointsToAdd, userEmail]
            );
            if (result.rowCount > 0) {
                 console.log(`Successfully added ${pointsToAdd} points to ${result.rows[0].email}. New balance: ${result.rows[0].points}`);
            } else {
                console.warn(`Webhook received for non-existent user email: ${userEmail}`);
            }
        } catch (err) {
            console.error('Error updating user points from webhook:', err);
        }
    } else {
        console.warn('Webhook received without required metadata (userEmail, pointsToAdd).');
    }
  }

  res.status(200).json({ received: true });
});


// --- Admin Routes ---
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (!req.user.is_admin) return res.sendStatus(403);
    try {
        const result = await pool.query('SELECT id, email, country, points, is_admin, status FROM users ORDER BY id');
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, async (req, res) => {
     if (!req.user.is_admin) return res.sendStatus(403);
     const { id } = req.params;
     const { points, status } = req.body;
     try {
        const result = await pool.query(
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 AND is_admin = FALSE RETURNING id, email, country, points, is_admin, status',
            [points, status, id]
        );
        if (result.rowCount > 0) {
            res.json({ user: result.rows[0] });
        } else {
            res.status(404).json({ message: 'User not found or is an admin' });
        }
     } catch (err) {
        res.status(500).json({ message: 'Failed to update user' });
     }
});

app.delete('/api/admin/users', authenticateToken, async(req, res) => {
    if (!req.user.is_admin) return res.sendStatus(403);
    try {
        await pool.query("DELETE FROM users WHERE is_admin = FALSE");
        res.status(200).json({message: 'All non-admin users deleted.'});
    } catch(err) {
        res.status(500).json({message: 'Failed to delete users'});
    }
});


// --- Start Server ---
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  initializeDb();
});