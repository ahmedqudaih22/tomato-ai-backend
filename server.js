// A full-stack backend for Tomato AI
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Stripe = require('stripe');
const { GoogleGenAI } = require('@google/genai');
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
        console.log("Database pool created.");
    } catch (e) {
        dbInitializationError = "فشل في إنشاء اتصال قاعدة البيانات. تحقق من متغير البيئة DATABASE_URL.";
        console.error(dbInitializationError, e);
        pool = null;
    }
} else {
    dbInitializationError = "متغير البيئة DATABASE_URL غير موجود. تم تعطيل الميزات التي تعتمد على قاعدة البيانات.";
    console.warn(dbInitializationError);
}

let stripe;
let stripeInitializationError = null;
if (process.env.STRIPE_SECRET_KEY) {
    try {
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        console.log("Stripe initialized.");
    } catch (e) {
        stripeInitializationError = "فشل في تهيئة Stripe. تحقق من متغير البيئة STRIPE_SECRET_KEY.";
        console.error(stripeInitializationError, e);
        stripe = null;
    }
} else {
    stripeInitializationError = "متغير البيئة STRIPE_SECRET_KEY غير موجود. تم تعطيل ميزات الدفع.";
    console.warn(stripeInitializationError);
}
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!webhookSecret) {
    console.warn("متغير البيئة STRIPE_WEBHOOK_SECRET غير موجود. سيفشل التحقق من الويب هوك.");
}

let ai;
let aiInitializationError = null;
if (process.env.API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        console.log("GoogleGenAI initialized successfully.");
    } catch(e) {
        ai = null;
        aiInitializationError = "فشل في تهيئة GoogleGenAI. تحقق من صلاحية API_KEY.";
        console.error(aiInitializationError, e);
    }
} else {
    aiInitializationError = "متغير البيئة API_KEY غير موجود على الخادم. تم تعطيل ميزات الذكاء الاصطناعي.";
    console.warn(aiInitializationError);
}

// --- Middleware ---

const allowedOrigins = [
  'https://tomato-ai-15430077659.us-west1.run.app',
  'http://localhost:8080'
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
};
app.use(cors(corsOptions));

app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// --- Service Availability Middleware ---
const checkDb = (req, res, next) => {
    if (!pool) return res.status(503).json({ message: dbInitializationError || 'خدمة قاعدة البيانات غير متوفرة.' });
    next();
};
const checkStripe = (req, res, next) => {
    if (!stripe) return res.status(503).json({ message: stripeInitializationError || 'خدمة الدفع غير متوفرة.' });
    next();
};
const checkAi = (req, res, next) => {
    if (!ai) return res.status(503).json({ message: aiInitializationError || 'خدمة الذكاء الاصطناعي غير متوفرة.' });
    next();
};


const defaultSettings = {
    costs: { imageEdit: 2, imageCreate: 5, textToSpeech: 1 },
    referralBonus: 50,
    theme: { logoUrl: "https://i.ibb.co/mH2WvTz/tomato-logo.png", logoWidth: 150, logoHeight: 50, logoAlign: 'center', primaryColor: "#FF6B6B", secondaryColor: "#2EC4B6", navbarColor: "#FFFFFF", navTextColor: "#2A323C" },
    content: { siteNameAr: "Tomato AI", siteNameEn: "Tomato AI", heroTitleAr: "أدوات ذكاء اصطناعي قوية لإبداعك", heroTitleEn: "Powerful AI Tools for Your Creativity", heroSubtitleAr: "حرر، أنشئ، وحول أفكارك إلى واقع بسهولة.", heroSubtitleEn: "Edit, create, and bring your ideas to life with ease." },
    store: { packages: [{ id: 1, points: 100, price: 5 }, { id: 2, points: 250, price: 10 }, { id: 3, points: 300, price: 1 }, { id: 4, points: 1500, price: 40 }] },
    announcement: { enabled: false, imageUrl: "", contentAr: "<h1>عرض خاص!</h1><p>احصل على ضعف النقاط عند الشراء هذا الأسبوع.</p>", contentEn: "<h1>Special Offer!</h1><p>Get double the points on all purchases this week.</p>" }
};

const initializeDbSchema = async () => {
    if (!pool) {
        console.warn("Database pool not available. Skipping DB schema initialization.");
        return;
    }
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
        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY DEFAULT 1,
                config JSONB NOT NULL
            );
        `);
        const settingsRes = await client.query('SELECT * FROM settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO settings (id, config) VALUES (1, $1)', [JSON.stringify(defaultSettings)]);
            console.log("Database initialized: Default settings inserted.");
        } else {
            console.log("Database schema is ready.");
        }
    } catch (err) {
        console.error("Error initializing database schema:", err);
    } finally {
        client.release();
    }
};

const authenticateToken = async (req, res, next) => {
    if (!pool) return res.status(503).json({ message: dbInitializationError });
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    try {
        const userId = parseInt(token);
        if (isNaN(userId)) return res.sendStatus(401);
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) return res.sendStatus(403);
        req.user = result.rows[0];
        next();
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.sendStatus(500);
    }
};

const isAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }
    next();
};

// --- API Routes ---

app.post('/api/register', checkDb, async (req, res) => {
    const { email, password, country } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    try {
        const userCountResult = await pool.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCountResult.rows[0].count) === 0;
        const result = await pool.query(
            'INSERT INTO users (email, password, country, is_admin) VALUES (LOWER($1), $2, $3, $4) RETURNING id, email, country, points, is_admin, status',
            [email, password, country, isFirstUser]
        );
        const user = result.rows[0];
        const token = user.id.toString();
        res.status(201).json({ message: 'User registered successfully', user, token });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Email already exists.' });
        console.error("Registration Error:", err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/api/login', checkDb, async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
        const user = result.rows[0];
        if (user.password !== password) return res.status(401).json({ message: 'Invalid credentials' });
        if (user.status === 'banned') return res.status(403).json({ message: 'This account is banned.' });
        const token = user.id.toString();
        delete user.password;
        res.status(200).json({ message: 'Login successful', user, token });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/api/users/me', checkDb, authenticateToken, async (req, res) => {
    const user = req.user;
    delete user.password;
    res.json({ user });
});

app.put('/api/users/me', checkDb, authenticateToken, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.user.id;
    try {
        let query, queryParams;
        if (password) {
            query = 'UPDATE users SET email = LOWER($1), password = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status';
            queryParams = [email, password, userId];
        } else {
            query = 'UPDATE users SET email = LOWER($1) WHERE id = $2 RETURNING id, email, country, points, is_admin, status';
            queryParams = [email, userId];
        }
        const result = await pool.query(query, queryParams);
        res.json({ user: result.rows[0] });
    } catch(err) {
        console.error("Profile update error:", err);
        res.status(500).json({ message: 'Error updating profile' });
    }
});

app.post('/api/ai/generate', checkDb, checkAi, authenticateToken, async (req, res) => {
    const { cost, payload } = req.body;
    const userId = req.user.id;
    if (req.user.points < cost) return res.status(402).json({ message: 'Insufficient points' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET points = points - $1 WHERE id = $2', [cost, userId]);

        const { type, ...params } = payload;
        let apiResult;
        
        if (type === 'generateImages') {
            const response = await ai.models.generateImages(params);
            if (response.promptFeedback?.blockReason) throw new Error("تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل الوصف.");
            if (response.generatedImages?.[0]?.image?.imageBytes) {
                 apiResult = { dataUrl: `data:image/png;base64,${response.generatedImages[0].image.imageBytes}` };
            } else {
                 console.error("Unexpected Imagen response:", JSON.stringify(response, null, 2));
                 throw new Error("فشل الذكاء الاصطناعي في إنشاء الصورة. يرجى تجربة وصف مختلف.");
            }
        } else if (type === 'generateContent') {
            const response = await ai.models.generateContent(params);
            if (response.promptFeedback?.blockReason) throw new Error("تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل طلبك أو الصورة المستخدمة.");
            const firstPart = response.candidates?.[0]?.content?.parts?.[0];
            if (firstPart?.inlineData) {
                if (params.config?.responseModalities?.includes('AUDIO')) {
                    apiResult = { base64Audio: firstPart.inlineData.data };
                } else {
                    apiResult = { dataUrl: `data:${firstPart.inlineData.mimeType};base64,${firstPart.inlineData.data}` };
                }
            } else {
                const finishReason = response.candidates?.[0]?.finishReason;
                let userMessage = finishReason ? `توقف الإنشاء لسبب غير متوقع: ${finishReason}` : "لم يتم إرجاع البيانات المتوقعة من الذكاء الاصطناعي. قد تكون الاستجابة فارغة.";
                if (['NO_IMAGE', 'NO_AUDIO'].includes(finishReason)) userMessage = "فشل الذكاء الاصطناعي في إنشاء المخرجات. قد يكون هذا بسبب قيود الأمان على النص أو المحتوى الذي تم تحميله. يرجى تجربة طلب مختلف.";
                else if (finishReason === 'SAFETY') userMessage = "تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل طلبك.";
                else if (finishReason === 'RECITATION') userMessage = "تم حظر الطلب لمنع عرض محتوى محمي بحقوق الطبع والنشر.";
                else if (finishReason === 'OTHER') userMessage = "توقف الذكاء الاصطناعي لسبب غير معروف. يرجى المحاولة مرة أخرى.";
                console.error("AI Generation Stopped:", finishReason, JSON.stringify(response, null, 2));
                throw new Error(userMessage);
            }
        } else {
            throw new Error('Invalid AI operation type');
        }
        
        const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        await client.query('COMMIT');
        
        const user = userResult.rows[0];
        delete user.password;
        res.json({ result: apiResult, user });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("AI Generation Error:", err.message, err.stack);
        res.status(500).json({ message: err.message || 'An error occurred during AI generation.' });
    } finally {
        client.release();
    }
});

app.post('/api/ai/remove-background', checkAi, authenticateToken, isAdmin, async (req, res) => {
    try {
        const { imagePart, textPart } = req.body;
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [imagePart, textPart] },
            config: { responseModalities: ['IMAGE'] },
        });
        const firstPart = response.candidates?.[0]?.content?.parts?.[0];
        if (firstPart?.inlineData) {
            res.json({ dataUrl: `data:${firstPart.inlineData.mimeType};base64,${firstPart.inlineData.data}` });
        } else {
            throw new Error("AI background removal failed to return an image.");
        }
    } catch (err) {
        console.error("BG Removal Error:", err);
        res.status(500).json({ message: err.message || 'Failed to remove background.' });
    }
});

app.get('/api/settings', checkDb, async (req, res) => {
    try {
        const result = await pool.query('SELECT config FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            res.json(result.rows[0].config);
        } else {
            console.warn("Settings not found, returning default. DB might be initializing.");
            res.json(defaultSettings);
        }
    } catch (err) {
        console.error("Get settings error:", err);
        res.status(500).json({ message: 'Failed to fetch settings' });
    }
});

app.put('/api/admin/settings', checkDb, authenticateToken, isAdmin, async (req, res) => {
    const newSettings = req.body;
    try {
        await pool.query('UPDATE settings SET config = $1 WHERE id = 1', [newSettings]);
        res.status(200).json({ message: 'Settings updated successfully' });
    } catch (err) {
        console.error("Update settings error:", err);
        res.status(500).json({ message: 'Failed to update settings' });
    }
});

app.post('/api/create-checkout-session', checkDb, checkStripe, authenticateToken, async (req, res) => {
    const { packageId } = req.body;
    const user = req.user;
    try {
        const settingsRes = await pool.query('SELECT config FROM settings WHERE id = 1');
        const pkg = settingsRes.rows[0].config.store.packages.find(p => p.id === packageId);
        if (!pkg) return res.status(404).json({ message: 'Package not found.' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: `${pkg.points} Points Package` },
                    unit_amount: pkg.price * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'https://tomato-ai-15430077659.us-west1.run.app'}/?payment_success=true#store`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://tomato-ai-15430077659.us-west1.run.app'}/?payment_cancelled=true#store`,
            customer_email: user.email,
            metadata: { userEmail: user.email, pointsToAdd: pkg.points.toString() }
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error("Stripe session creation error:", err);
        res.status(500).json({ message: 'Failed to create payment session.' });
    }
});

app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  if (!stripe || !pool) {
    console.warn('Webhook received but Stripe or DB is not configured. Aborting.');
    return res.status(503).send('Webhook handler is not available.');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const { userEmail, pointsToAdd } = event.data.object.metadata;
    if (userEmail && pointsToAdd) {
        console.log(`Payment successful for ${userEmail}. Attempting to add ${pointsToAdd} points.`);
        try {
            const result = await pool.query('UPDATE users SET points = points + $1 WHERE LOWER(email) = LOWER($2) RETURNING email, points', [parseInt(pointsToAdd, 10), userEmail]);
            if (result.rowCount > 0) console.log(`Successfully added points to ${result.rows[0].email}.`);
            else console.warn(`Webhook received for non-existent user email: ${userEmail}`);
        } catch (err) {
            console.error('Error updating user points from webhook:', err);
        }
    }
  }
  res.status(200).json({ received: true });
});

app.get('/api/admin/users', checkDb, authenticateToken, isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, country, points, is_admin, status FROM users ORDER BY id');
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

app.put('/api/admin/users/:id', checkDb, authenticateToken, isAdmin, async (req, res) => {
     const targetUserId = parseInt(req.params.id);
     const { points, status } = req.body;
     if (isNaN(targetUserId)) return res.status(400).json({ message: 'Invalid user ID' });
     try {
        const targetUserRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
        if (targetUserRes.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        if (targetUserRes.rows[0].is_admin && req.user.id === targetUserId && status === 'banned') {
             return res.status(403).json({ message: 'Admins cannot ban themselves.' });
        }
        const result = await pool.query(
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status',
            [points, status, targetUserId]
        );
        res.json({ user: result.rows[0] });
     } catch (err) {
        console.error("Admin user update error:", err);
        res.status(500).json({ message: 'Failed to update user' });
     }
});

app.delete('/api/admin/users', checkDb, authenticateToken, isAdmin, async(req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE is_admin = FALSE");
        res.status(200).json({message: 'All non-admin users deleted.'});
    } catch(err) {
        res.status(500).json({message: 'Failed to delete users'});
    }
});

app.get('/api/status', async (req, res) => {
    if (!ai) {
        return res.json({
            ai_enabled: false,
            message: aiInitializationError,
            message_ar: aiInitializationError || "خدمات الذكاء الاصطناعي معطلة."
        });
    }
    try {
        await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hello' });
        res.json({
            ai_enabled: true,
            message: 'AI services are operational and the API key is valid.',
            message_ar: 'خدمات الذكاء الاصطناعي فعّالة ومفتاح الواجهة البرمجية (API Key) صالح.'
        });
    } catch (error) {
        console.error("AI Status Check Error:", error.message);
        let userMessage = "The API key is likely invalid or has restrictions.";
        let userMessageAr = "مفتاح الواجهة البرمجية (API Key) غير صالح على الأرجح أو عليه قيود.";
        if (error.message.includes('API key not valid')) {
            userMessage = "API key not valid. Please check your key.";
            userMessageAr = "مفتاح الواجهة البرمجية (API Key) غير صالح. يرجى التحقق من المفتاح الخاص بك.";
        } else if (error.message.includes('billing')) {
            userMessage = "API key is valid, but billing is not enabled for the project.";
            userMessageAr = "مفتاح الواجهة البرمجية صالح، ولكن الفوترة غير مفعلة للمشروع.";
        } else if (error.message.includes('permission denied')) {
            userMessage = "The API key does not have permission to use the Gemini API.";
            userMessageAr = "مفتاح الواجهة البرمجية لا يملك الصلاحية لاستخدام Gemini API.";
        }
        res.json({ ai_enabled: false, message: userMessage, message_ar: userMessageAr });
    }
});

// --- Start Server ---
app.listen(port, async () => {
    console.log(`Server listening on port ${port}`);
    // Initialize the DB schema after the server starts listening
    await initializeDbSchema();
});
