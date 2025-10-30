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

        // In a real app, you MUST hash the password. For simplicity, we are storing it plain.
        const result = await pool.query(
            'INSERT INTO users (email, password, country, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, email, country, points, is_admin, status',
            [email, password, country, isFirstUser]
        );
        
        const user = result.rows[0];
        // In a real app, you would generate a JWT (JSON Web Token) here.
        // For simplicity, we'll use the user ID as a token.
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
        // In a real app, you would compare hashed passwords.
        if (user.password !== password) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (user.status === 'banned') {
            return res.status(403).json({ message: 'This account is banned.' });
        }
        
        const token = user.id.toString();
        // Don't send the password back
        delete user.password;
        res.status(200).json({ message: 'Login successful', user, token });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// A placeholder for fetching user data based on a token
app.get('/api/users/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }
    try {
        const userId = parseInt(token);
        const result = await pool.query('SELECT id, email, country, points, is_admin, status FROM users WHERE id = $1', [userId]);
         if (result.rows.length > 0) {
            res.json({ user: result.rows[0] });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch(err) {
        res.status(500).json({ message: 'Server error' });
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
    
    // The metadata should contain the user ID and points to add
    const userId = session.metadata.userId;
    const pointsToAdd = parseInt(session.metadata.points, 10);
    const userEmail = session.customer_details.email; // Get email from the session

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
        console.warn('Webhook received without required metadata (userEmail, points).');
    }
  }

  res.status(200).json({ received: true });
});


// --- Admin Routes (Add middleware later for real security) ---
app.get('/api/admin/users', async (req, res) => {
    // In a real app, you'd verify the user is an admin from their token
    try {
        const result = await pool.query('SELECT id, email, country, points, is_admin, status FROM users ORDER BY id');
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

app.put('/api/admin/users/:id', async (req, res) => {
     const { id } = req.params;
     const { points, status } = req.body; // points is the amount to add/subtract
     try {
        const result = await pool.query(
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status',
            [points, status, id]
        );
        if (result.rowCount > 0) {
            res.json({ user: result.rows[0] });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
     } catch (err) {
        res.status(500).json({ message: 'Failed to update user' });
     }
});

app.delete('/api/admin/users', async(req, res) => {
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
