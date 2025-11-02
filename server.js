// A full-stack backend for Tomato AI
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Stripe = require('stripe');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// --- Service Initialization & Health ---
let pool;
let dbInitializationError = null;
if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
    } catch (e) {
        dbInitializationError = "Failed to create database pool. Check DATABASE_URL.";
        console.error(dbInitializationError, e);
        pool = null;
    }
} else {
    dbInitializationError = "DATABASE_URL environment variable not set. Database-dependent features are disabled.";
    console.warn(dbInitializationError);
}

let stripe;
let stripeInitializationError = null;
if (process.env.STRIPE_SECRET_KEY) {
    try {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    } catch (e) {
        stripeInitializationError = "Failed to initialize Stripe. Check STRIPE_SECRET_KEY.";
        console.error(stripeInitializationError, e);
        stripe = null;
    }
} else {
    stripeInitializationError = "STRIPE_SECRET_KEY environment variable not set. Payment features are disabled.";
    console.warn(stripeInitializationError);
}

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (process.env.STRIPE_SECRET_KEY && !webhookSecret) {
    console.warn("STRIPE_WEBHOOK_SECRET is not set. Payment confirmation will not work automatically.");
}


let ai;
let aiInitializationError = null;
if (process.env.API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    } catch(e) {
        ai = null;
        aiInitializationError = "Failed to initialize GoogleGenAI. Check API_KEY validity.";
        console.error(aiInitializationError, e);
    }
} else {
    aiInitializationError = "API_KEY environment variable not set on server. AI features are disabled.";
    console.warn(aiInitializationError);
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const defaultSettings = {
    costs: { 
        imageEdit: 2, 
        imageCreate: 5, 
        textToSpeech: 1, 
        dailyRewardPoints: 10, 
        referralBonus: 50,
        imageEdit_noWatermark: 8,
        imageCreate_noWatermark: 15,
        contentRewrite: 1,
        tweetGenerator: 1,
        newUserPoints: 25,
    },
    theme: { 
        logoUrl: "https://i.ibb.co/mH2WvTz/tomato-logo.png", 
        logoWidth: 150, 
        logoHeight: 50,
        logoAlign: "left",
        primaryColor: "#FF6B6B", 
        secondaryColor: "#2EC4B6", 
        navbarColor: "#FFFFFF", 
        navTextColor: "#2A323C",
        buttonPadding: 8,
        sliderHeight: 450,
        navButtonFontSize: 16,
        watermarkText: 'tomatoai.net',
        watermarkPosition: 'bottom-right',
        watermarkEffect: 'shadow',
    },
    store: {
        packages: [
            { id: 1, points: 100, price: 5.00, paymentLink: '' },
            { id: 2, points: 550, price: 25.00, paymentLink: '' },
        ]
    },
    announcement: {
        enabled: false,
        imageUrl: "",
        contentEn: "Welcome to Tomato AI!",
        contentAr: "مرحباً بك في Tomato AI!",
        textColor: "#FFFFFF",
        fontSize: 16,
    },
    maintenance: {
        enabled: false,
        message_en: "We are currently down for maintenance. Please check back soon!",
        message_ar: "الموقع حاليًا تحت الصيانة. يرجى العودة قريبًا!",
    },
    content: { 
        siteNameAr: "Tomato AI", siteNameEn: "Tomato AI",
        slider: {
            slide1: { image: "https://i.ibb.co/V9Z2xN3/slide1.png", title_ar: "إنشاء صور بالذكاء الاصطناعي", title_en: "AI Image Generation", text_ar: "حوّل كلماتك إلى صور مذهلة. أطلق العنان لإبداعك.", text_en: "Turn your words into amazing images. Unleash your creativity." },
            slide2: { image: "https://i.ibb.co/gZk8zM4/slide2.png", title_ar: "تعديل احترافي للصور", title_en: "Professional Image Editing", text_ar: "صف التعديل الذي تريده، ودع الذكاء الاصطناعي يقوم بالباقي.", text_en: "Describe the edit you want, and let the AI do the rest." },
            slide3: { image: "https://i.ibb.co/c1xX6gQ/slide3.png", title_ar: "تعليق صوتي فوري", title_en: "Instant Voiceovers", text_ar: "حوّل أي نص إلى تعليق صوتي طبيعي بلهجات متعددة.", text_en: "Convert any text into a natural voiceover in multiple dialects." },
        },
        finalCta: {
            title_ar: "هل أنت مستعد للبدء؟",
            title_en: "Ready to Get Started?",
            text_ar: "انضم إلى آلاف المبدعين الذين يستخدمون Tomato AI لإنشاء محتوى مذهل.",
            text_en: "Join thousands of creators using Tomato AI to create amazing content.",
            button_ar: "أنشئ حسابك المجاني",
            button_en: "Create Your Free Account"
        }
    }
};

// In-memory cache for settings
let settingsCache = null;

async function getSettings() {
    if (settingsCache) return settingsCache;
    if (!pool) return defaultSettings;
    try {
        const res = await pool.query('SELECT settings_data FROM settings WHERE id = 1');
        if (res.rows.length > 0) {
            settingsCache = res.rows[0].settings_data;
            return settingsCache;
        } else {
            // No settings in DB, insert default and return
            await pool.query('INSERT INTO settings (id, settings_data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(defaultSettings)]);
            settingsCache = defaultSettings;
            return settingsCache;
        }
    } catch (e) {
        console.error("Error fetching settings from DB, using default.", e);
        return defaultSettings;
    }
}
async function handleStripeWebhook(req, res) {
    if (!stripe || !webhookSecret) {
        console.log('Stripe webhook endpoint called, but Stripe or webhook secret is not configured.');
        return res.status(400).send('Webhook not configured.');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        const userId = session.client_reference_id;
        const points = session.metadata.points;
        
        console.log(`Checkout session completed for user ${userId}. Attempting to award ${points} points.`);

        try {
            if (pool && userId && points) {
                const result = await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [parseInt(points, 10), parseInt(userId, 10)]);
                if (result.rowCount === 0) {
                     console.error(`Failed to update points: User with ID ${userId} not found.`);
                } else {
                    console.log(`Successfully awarded ${points} points to user ${userId}.`);
                }
            } else {
                 console.error('Webhook received but DB pool is not available or crucial data is missing from session.', { userId, points });
            }
        } catch (dbError) {
            console.error(`Failed to update points for user ${userId}:`, dbError);
        }
    } else {
        console.log(`Received unhandled event type ${event.type}`);
    }

    res.status(200).json({ received: true });
}

// --- Middleware ---
app.use(cors());
app.post('/stripe-webhook', express.raw({type: 'application/json'}), handleStripeWebhook);
app.use(express.json({ limit: '10mb' }));

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const adminRequired = (req, res, next) => {
    if (!req.user.is_admin) return res.status(403).json({ message: 'Admin access required' });
    next();
};

// --- API Helper Functions ---
function generateReferralCode(length = 8) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length).toUpperCase();
}

async function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            resolve(salt + ':' + derivedKey.toString('hex'));
        });
    });
}

async function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        const [salt, key] = storedHash.split(':');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            const keyBuffer = Buffer.from(key, 'hex');
            const match = crypto.timingSafeEqual(derivedKey, keyBuffer);
            resolve(match);
        });
    });
}

// --- API Endpoints ---
app.get('/api/config', (req, res) => {
    res.json({
        stripePublicKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
});

app.get('/api/health', async (req, res) => {
    let dbStatus = { ok: false, message: dbInitializationError || "Unknown database error." };
    if (pool) {
        try {
            await pool.query('SELECT NOW()');
            dbStatus = { ok: true, message: 'Connected successfully.' };
        } catch (e) {
            dbStatus = { ok: false, message: e.message };
        }
    }

    const aiStatus = { ok: !!ai, message: aiInitializationError || 'Operational.' };
    const paymentStatus = { ok: !!stripe, message: stripeInitializationError || 'Operational.' };
    
    res.json({
        database: dbStatus,
        ai_service: aiStatus,
        payment_service: paymentStatus
    });
});

app.post('/api/register', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { username, email, password, country, referralCode } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'Username, email, and password are required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existingUser = await client.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (existingUser.rows.length > 0) {
            const user = existingUser.rows[0];
            if (user.username === username) return res.status(409).json({ message: 'Username already exists.' });
            if (user.email === email) return res.status(409).json({ message: 'Email already exists.' });
        }
        
        const settings = await getSettings();
        let newUserPoints = settings.costs.newUserPoints || 25;
        
        if (referralCode) {
            const referrerResult = await client.query('SELECT id, points FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerResult.rows.length > 0) {
                const referrer = referrerResult.rows[0];
                const bonus = settings.costs.referralBonus || 50;
                await client.query('UPDATE users SET points = points + $1, referrals = referrals + 1 WHERE id = $2', [bonus, referrer.id]);
                newUserPoints += bonus;
                console.log(`Awarded ${bonus} points to referrer ${referrer.id}`);
            }
        }
        
        const passwordHash = await hashPassword(password);
        const newReferralCode = generateReferralCode();

        const newUserResult = await client.query(
            'INSERT INTO users (username, email, password_hash, country, points, referral_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [username, email, passwordHash, country, newUserPoints, newReferralCode]
        );
        const newUser = newUserResult.rows[0];
        
        const token = jwt.sign({ id: newUser.id, username: newUser.username, is_admin: newUser.is_admin }, JWT_SECRET, { expiresIn: '7d' });
        
        await client.query('COMMIT');

        const { password_hash, ...userResponse } = newUser;
        res.status(201).json({ token, user: userResponse });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Registration error:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    } finally {
        client.release();
    }
});


app.post('/api/login', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { identifier, password } = req.body;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [identifier]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        const user = userResult.rows[0];

        if (user.status === 'banned') {
            return res.status(403).json({ message: 'This account has been banned.' });
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }
        
        const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
        
        const { password_hash, ...userResponse } = user;
        res.json({ token, user: userResponse });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

app.get('/api/users/me', authenticateToken, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        const { password_hash, ...userResponse } = userResult.rows[0];
        res.json({ user: userResponse });
    } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: "Payment service is not configured." });
    if (!pool) return res.status(503).json({ message: "Database is not configured." });

    const { packageId } = req.body;
    const userId = req.user.id;
    let pkg; 

    try {
        const settings = await getSettings();
        pkg = settings.store.packages.find(p => p.id === packageId);

        if (!pkg) {
            return res.status(404).json({ error: 'Package not found' });
        }

        let line_items;
    
        if (pkg.priceId && pkg.priceId.startsWith('price_')) {
            console.log(`Using Stripe Price ID: ${pkg.priceId} for package ${pkg.id}`);
            line_items = [{ price: pkg.priceId, quantity: 1 }];
        } else {
            console.log(`Using dynamic price_data for package ${pkg.id}`);
            line_items = [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${pkg.points.toLocaleString()} Points Package`,
                        description: `Purchase ${pkg.points.toLocaleString()} points for your Tomato AI account.`,
                    },
                    unit_amount: Math.round(pkg.price * 100),
                },
                quantity: 1,
            }];
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: line_items,
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'https://tomatoai.net'}/#store?payment_success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://tomatoai.net'}/#store?payment_cancelled=true`,
            client_reference_id: userId.toString(),
            metadata: { packageId: pkg.id, points: pkg.points, userId: userId }
        });

        res.json({ url: session.url });

    } catch (error) {
        console.error('Stripe session creation error:', error);

        if (error.type === 'StripeInvalidRequestError' && error.message && error.message.toLowerCase().includes('amount must be at least')) {
            return res.status(400).json({ 
                error: 'Invalid Amount', 
                message: `The price for package ${pkg.id} is too low. Stripe requires a minimum amount (e.g., $0.50). Please set a valid price in the admin dashboard.` 
            });
        }

        if (error.code === 'resource_missing' || (error.message && error.message.toLowerCase().includes('no such price'))) {
            return res.status(400).json({ 
                error: 'Invalid Stripe Price ID', 
                message: `The Price ID for package ${pkg.id} ('${pkg.priceId}') is invalid or doesn't exist in the current mode (Live vs. Test).` 
            });
        }
        
        if (error.type === 'StripeInvalidRequestError' && error.message && error.message.includes('recurring Price')) {
             return res.status(400).json({ 
                error: 'Recurring Price ID Used', 
                message: `The Price ID for package ${pkg.id} is for a recurring subscription, not a one-time payment.` 
            });
        }

        const userMessage = "An error occurred with the payment provider. This could be due to incorrect Stripe API keys or network issues. Please check the server logs for details.";
        res.status(500).json({ error: 'Failed to create checkout session', message: userMessage });
    }
});

app.get('/api/settings', async (req, res) => {
    const settings = await getSettings();
    const token = req.headers['authorization']?.split(' ')[1];
    let user = null;
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const userResult = await pool.query('SELECT is_admin FROM users WHERE id = $1', [decoded.id]);
            if (userResult.rows.length > 0) {
                user = { is_admin: userResult.rows[0].is_admin };
            }
        } catch (e) {
            // Invalid token, ignore
        }
    }
    
    if (settings.maintenance?.enabled && !user?.is_admin) {
        // Send a minimal settings object for maintenance page
        const minimalSettings = {
            maintenance: settings.maintenance,
            theme: { logoUrl: settings.theme.logoUrl }
        };
        return res.status(503).json({ settings: minimalSettings, message: "Site is under maintenance." });
    }

    res.json(settings);
});
app.post('/api/settings', authenticateToken, adminRequired, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { settings } = req.body;
    try {
        await pool.query('UPDATE settings SET settings_data = $1 WHERE id = 1', [JSON.stringify(settings)]);
        settingsCache = settings; // Update cache
        res.json({ message: 'Settings updated successfully!', settings: settings });
    } catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({ message: 'Failed to update settings.' });
    }
});

app.get('/api/stats', authenticateToken, adminRequired, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const operations = await pool.query('SELECT COUNT(*) FROM history');
        const referrals = await pool.query('SELECT SUM(referrals) FROM users');
        // Note: Total visitors is not tracked in this simplified backend
        res.json({
            users: parseInt(users.rows[0].count),
            operations: parseInt(operations.rows[0].count),
            referrals: parseInt(referrals.rows[0].sum) || 0,
            visitors: 0 // Placeholder
        });
    } catch (error) {
        console.error("Get stats error:", error);
        res.status(500).json({ message: 'Failed to get stats.' });
    }
});

app.get('/api/admin/users', authenticateToken, adminRequired, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    try {
        const result = await pool.query('SELECT id, username, email, points, country, status, is_admin FROM users ORDER BY id ASC');
        res.json({ users: result.rows });
    } catch (error) {
        console.error("Get users error:", error);
        res.status(500).json({ message: 'Failed to fetch users.' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, adminRequired, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { id } = req.params;
    const { points, status } = req.body;
    try {
        const result = await pool.query(
            'UPDATE users SET points = $1, status = $2 WHERE id = $3 RETURNING id, username, email, points, country, status, is_admin',
            [points, status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error("Update user error:", error);
        res.status(500).json({ message: 'Failed to update user.' });
    }
});


app.put('/api/users/me', authenticateToken, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { email, password } = req.body;
    let query;
    let values;
    try {
        if (password) {
            const passwordHash = await hashPassword(password);
            query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING *';
            values = [email, passwordHash, req.user.id];
        } else {
            query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING *';
            values = [email, req.user.id];
        }
        const result = await pool.query(query, values);
        const { password_hash, ...userResponse } = result.rows[0];
        res.json({ user: userResponse, message: 'Profile updated successfully.' });
    } catch (error) {
        console.error("Update profile error:", error);
        res.status(500).json({ message: 'Failed to update profile.' });
    }
});


app.post('/api/history', authenticateToken, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const { type, prompt, resultUrl, cost } = req.body;
    try {
        await pool.query(
            'INSERT INTO history (user_id, type, prompt, result_url, cost) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, type, prompt, resultUrl, cost]
        );
        res.sendStatus(201);
    } catch (error) {
        console.error("Save history error:", error);
        res.status(500).json({ message: 'Failed to save history.' });
    }
});

app.get('/api/history', authenticateToken, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    try {
        const result = await pool.query('SELECT * FROM history WHERE user_id = $1 ORDER BY date DESC LIMIT 50', [req.user.id]);
        res.json({ history: result.rows });
    } catch (error) {
        console.error("Get history error:", error);
        res.status(500).json({ message: 'Failed to fetch history.' });
    }
});

app.post('/api/claim-daily-reward', authenticateToken, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database not connected." });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query('SELECT last_daily_claim FROM users WHERE id = $1', [req.user.id]);
        const lastClaim = userResult.rows[0].last_daily_claim;
        const now = new Date();
        const twentyFourHours = 24 * 60 * 60 * 1000;

        if (lastClaim && (now.getTime() - new Date(lastClaim).getTime() < twentyFourHours)) {
            return res.status(429).json({ message: 'You can only claim the daily reward once every 24 hours.' });
        }
        
        const settings = await getSettings();
        const reward = settings.costs.dailyRewardPoints || 10;

        const updateResult = await client.query(
            'UPDATE users SET points = points + $1, last_daily_claim = NOW() WHERE id = $2 RETURNING *',
            [reward, req.user.id]
        );
        await client.query('COMMIT');
        
        const { password_hash, ...userResponse } = updateResult.rows[0];
        res.json({ user: userResponse });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Claim reward error:", error);
        res.status(500).json({ message: 'Failed to claim reward.' });
    } finally {
        client.release();
    }
});


// --- AI Generation Endpoint ---
app.post('/api/ai/generate', authenticateToken, async (req, res) => {
    if (!ai) return res.status(503).json({ message: "AI service is not configured." });
    if (!pool) return res.status(503).json({ message: "Database is not configured." });

    const { payload, removeWatermark } = req.body;
    const userId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query('SELECT points FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }
        let currentPoints = userResult.rows[0].points;
        const settings = await getSettings();
        
        let cost = 0;
        if(payload.type === 'generateImages') {
            cost = removeWatermark ? settings.costs.imageCreate_noWatermark : settings.costs.imageCreate;
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-image') {
            cost = removeWatermark ? settings.costs.imageEdit_noWatermark : settings.costs.imageEdit;
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-preview-tts') {
            cost = Math.ceil(payload.contents[0].parts[0].text.length / 100) * settings.costs.textToSpeech;
        } else if (payload.type === 'rewrite') {
            cost = settings.costs.contentRewrite ?? 0;
        } else if (payload.type === 'generate-tweets') {
            cost = settings.costs.tweetGenerator ?? 0;
        }

        if (currentPoints < cost) {
            return res.status(402).json({ message: "Insufficient points." });
        }

        // --- AI API Call Logic ---
        let aiResult;
        if (payload.type === 'generateImages') {
            const response = await ai.models.generateImages(payload);
            const base64ImageBytes = response.generatedImages[0].image.imageBytes;
            aiResult = { dataUrl: `data:image/png;base64,${base64ImageBytes}` };
        } else if (payload.type === 'rewrite' || payload.type === 'generate-tweets') {
            // This is a custom abstraction, not a direct GenAI call type
            const model = ai.models['gemini-2.5-flash'];
            const prompt = payload.type === 'rewrite'
                ? `Rewrite the following text in a "${payload.style}" style. Keep the original language:\n\n${payload.text}`
                : `Generate 3-5 engaging tweets based on this topic/idea: ${payload.idea}`;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            aiResult = { text: response.text };
        } else { // Default to generateContent
            const response = await ai.models.generateContent(payload);
            if (payload.config.responseModalities?.includes('AUDIO')) {
                const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                aiResult = { base64Audio };
            } else if (payload.config.responseModalities?.includes('IMAGE')) {
                 for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData) {
                        aiResult = { dataUrl: `data:image/png;base64,${part.inlineData.data}` };
                        break;
                    }
                }
            } else {
                 aiResult = { text: response.text };
            }
        }
        
        // --- Deduct points and commit transaction ---
        const updatedUserResult = await client.query(
            'UPDATE users SET points = points - $1 WHERE id = $2 RETURNING *',
            [cost, userId]
        );
        await client.query('COMMIT');
        
        const { password_hash, ...userResponse } = updatedUserResult.rows[0];
        res.json({ result: aiResult, user: userResponse });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("AI Generation Error:", error);
        res.status(500).json({ message: `AI Service Error: ${error.message}` });
    } finally {
        client.release();
    }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static('public'));
    app.get('*', (req, res) => {
        res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
    });
}

app.listen(port, () => {
    console.log(`Tomato AI Server listening on port ${port}`);
    getSettings().then(s => console.log("Initial settings loaded.")); // Pre-cache settings on start
});
