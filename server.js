// A full-stack backend for Tomato AI
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Stripe = require('stripe');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware ---
// The Stripe webhook endpoint needs the raw body, so we apply express.json() conditionally.
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next); // Increase limit for data URLs
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

const defaultSettings = {
    costs: { imageEdit: 2, imageCreate: 5, textToSpeech: 1 },
    referralBonus: 50,
    theme: { logoUrl: "https://i.ibb.co/mH2WvTz/tomato-logo.png", logoWidth: 150, logoHeight: 50, logoAlign: 'center', primaryColor: "#FF6B6B", secondaryColor: "#2EC4B6", navbarColor: "#FFFFFF", navTextColor: "#2A323C" },
    content: { siteNameAr: "Tomato AI", siteNameEn: "Tomato AI", heroTitleAr: "أدوات ذكاء اصطناعي قوية لإبداعك", heroTitleEn: "Powerful AI Tools for Your Creativity", heroSubtitleAr: "حرر، أنشئ، وحول أفكارك إلى واقع بسهولة.", heroSubtitleEn: "Edit, create, and bring your ideas to life with ease." },
    store: { packages: [{ id: 1, points: 100, price: 5 }, { id: 2, points: 250, price: 10 }, { id: 3, points: 300, price: 1 }, { id: 4, points: 1500, price: 40 }] },
    announcement: { enabled: false, imageUrl: "", contentAr: "<h1>عرض خاص!</h1><p>احصل على ضعف النقاط عند الشراء هذا الأسبوع.</p>", contentEn: "<h1>Special Offer!</h1><p>Get double the points on all purchases this week.</p>" }
};


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
            console.log("Database initialized: 'settings' table is ready.");
        }

    } catch (err) {
        console.error("Error initializing database:", err);
        throw err; // Re-throw the error to be caught by the server starter
    } finally {
        client.release();
    }
};

// --- Stripe Setup ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- Gemini AI Setup ---
let ai;
let aiInitializationError = null;
if (process.env.API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        console.log("GoogleGenAI initialized successfully.");
    } catch(e) {
        ai = null;
        aiInitializationError = "Failed to initialize GoogleGenAI. Check if the API_KEY is valid.";
        console.error(aiInitializationError, e);
    }
} else {
    aiInitializationError = "API_KEY environment variable not set on the server. AI features are disabled.";
    console.warn(aiInitializationError);
}

// --- Auth Middleware ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    try {
        // Simple token is user ID. In production, use JWT.
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

const isAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }
    next();
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
            'INSERT INTO users (email, password, country, is_admin) VALUES (LOWER($1), $2, $3, $4) RETURNING id, email, country, points, is_admin, status',
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
        console.error("Registration Error:", err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// User Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const user = result.rows[0];
        if (user.password !== password) { // IMPORTANT: In production, use bcrypt.compare
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (user.status === 'banned') {
            return res.status(403).json({ message: 'This account is banned.' });
        }
        
        const token = user.id.toString();
        delete user.password;
        res.status(200).json({ message: 'Login successful', user, token });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// --- User Routes (Authenticated) ---
app.get('/api/users/me', authenticateToken, async (req, res) => {
    const user = req.user;
    delete user.password;
    res.json({ user });
});

app.put('/api/users/me', authenticateToken, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.user.id;
    
    try {
        let query;
        let queryParams;
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

// Note: This endpoint is no longer used by the client but kept for potential future use.
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
        console.error("Deduct points error:", err);
        res.status(500).json({ message: 'Error updating points' });
    }
});

// --- AI Generation Proxy ---
app.post('/api/ai/generate', authenticateToken, async (req, res) => {
    if (!ai) {
        const message = aiInitializationError || 'AI services are not available on the server.';
        return res.status(503).json({ message });
    }
    const { cost, payload } = req.body;
    const userId = req.user.id;

    if (req.user.points < cost) {
        return res.status(402).json({ message: 'Insufficient points' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET points = points - $1 WHERE id = $2', [cost, userId]);

        const { type, ...params } = payload;
        let apiResult;
        
        if (type === 'generateImages') {
            const response = await ai.models.generateImages(params);
            
            const blockReason = response.promptFeedback?.blockReason;
            if (blockReason) {
                throw new Error("تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل الوصف.");
            }

            if (response.generatedImages && response.generatedImages.length > 0 && response.generatedImages[0].image.imageBytes) {
                 const base64 = response.generatedImages[0].image.imageBytes;
                 apiResult = { dataUrl: `data:image/png;base64,${base64}` };
            } else {
                 console.error("Unexpected Imagen response structure:", JSON.stringify(response, null, 2));
                 throw new Error("فشل الذكاء الاصطناعي في إنشاء الصورة. يرجى تجربة وصف مختلف.");
            }
           
        } else if (type === 'generateContent') {
            const response = await ai.models.generateContent(params);
            
            const blockReason = response.promptFeedback?.blockReason;
            if (blockReason) {
                 throw new Error("تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل طلبك أو الصورة المستخدمة.");
            }
            
            const firstPart = response.candidates?.[0]?.content?.parts?.[0];

            if (firstPart && firstPart.inlineData) {
                const base64 = firstPart.inlineData.data;
                const mimeType = firstPart.inlineData.mimeType;
                if (params.config?.responseModalities?.includes('AUDIO')) {
                    apiResult = { base64Audio: base64 };
                } else { // Assume image
                    apiResult = { dataUrl: `data:${mimeType};base64,${base64}` };
                }
            } else {
                const finishReason = response.candidates?.[0]?.finishReason;
                let userMessage;
                switch (finishReason) {
                    case 'NO_IMAGE':
                    case 'NO_AUDIO':
                        userMessage = "فشل الذكاء الاصطناعي في إنشاء المخرجات. قد يكون هذا بسبب قيود الأمان على النص أو المحتوى الذي تم تحميله. يرجى تجربة طلب مختلف.";
                        break;
                    case 'SAFETY':
                        userMessage = "تم حظر الطلب بسبب سياسات الأمان. يرجى تعديل طلبك.";
                        break;
                    case 'RECITATION':
                        userMessage = "تم حظر الطلب لمنع عرض محتوى محمي بحقوق الطبع والنشر.";
                        break;
                    case 'OTHER':
                         userMessage = "توقف الذكاء الاصطناعي لسبب غير معروف. يرجى المحاولة مرة أخرى.";
                         break;
                    default:
                        userMessage = finishReason ? `توقف الإنشاء لسبب غير متوقع: ${finishReason}` : "لم يتم إرجاع البيانات المتوقعة من الذكاء الاصطناعي. قد تكون الاستجابة فارغة.";
                }
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
        console.error("AI Generation Error:", err);
        res.status(500).json({ message: err.message || 'An error occurred during AI generation.' });
    } finally {
        client.release();
    }
});

app.post('/api/ai/remove-background', authenticateToken, isAdmin, async (req, res) => {
    if (!ai) {
        const message = aiInitializationError || 'AI services are not available on the server.';
        return res.status(503).json({ message });
    }
    try {
        const { imagePart, textPart } = req.body;
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [imagePart, textPart] },
            config: { responseModalities: ['IMAGE'] },
        });

        const firstPart = response.candidates?.[0]?.content?.parts?.[0];
        if (firstPart && firstPart.inlineData) {
            const newBase64 = firstPart.inlineData.data;
            const newMimeType = firstPart.inlineData.mimeType;
            res.json({ dataUrl: `data:${newMimeType};base64,${newBase64}` });
        } else {
            throw new Error("AI background removal failed to return an image.");
        }
    } catch (err) {
        console.error("BG Removal Error:", err);
        res.status(500).json({ message: err.message || 'Failed to remove background.' });
    }
});


// --- Settings Routes ---
app.get('/api/settings', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        let result = await client.query('SELECT config FROM settings WHERE id = 1');
        
        // SELF-HEALING: If settings don't exist, create and return them.
        if (result.rows.length === 0) {
            console.warn("Settings not found, creating from default...");
            await client.query('INSERT INTO settings (id, config) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(defaultSettings)]);
            // Re-fetch the settings after insertion
            result = await client.query('SELECT config FROM settings WHERE id = 1');
            console.log("Default settings successfully created and fetched.");
        }
        
        if (result.rows.length > 0) {
            res.json(result.rows[0].config);
        } else {
             // This case should now be virtually impossible to reach.
            console.error("CRITICAL: Failed to fetch settings even after attempting to create them.");
            res.status(500).json({ message: 'Failed to retrieve or create settings.' });
        }

    } catch (err) {
        console.error("Get settings error:", err);
        res.status(500).json({ message: 'Failed to fetch settings' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

app.put('/api/admin/settings', authenticateToken, isAdmin, async (req, res) => {
    const newSettings = req.body;
    try {
        await pool.query('UPDATE settings SET config = $1 WHERE id = 1', [newSettings]);
        res.status(200).json({ message: 'Settings updated successfully' });
    } catch (err) {
        console.error("Update settings error:", err);
        res.status(500).json({ message: 'Failed to update settings' });
    }
});

// --- Store & Payment Routes ---
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    const { packageId } = req.body;
    const user = req.user;

    try {
        const settingsRes = await pool.query('SELECT config FROM settings WHERE id = 1');
        const settings = settingsRes.rows[0].config;
        const pkg = settings.store.packages.find(p => p.id === packageId);

        if (!pkg) {
            return res.status(404).json({ message: 'Package not found.' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${pkg.points} Points Package`,
                        description: `Get ${pkg.points} points for your Tomato AI account.`,
                    },
                    unit_amount: pkg.price * 100, // Price in cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'https://tomato-ai-15430077659.us-west1.run.app'}/?payment_success=true#store`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://tomato-ai-15430077659.us-west1.run.app'}/?payment_cancelled=true#store`,
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
                'UPDATE users SET points = points + $1 WHERE LOWER(email) = LOWER($2) RETURNING email, points',
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
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, country, points, is_admin, status FROM users ORDER BY id');
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
     const targetUserId = parseInt(req.params.id);
     const { points, status } = req.body;
     const adminUserId = req.user.id;
     
     if (isNaN(targetUserId)) return res.status(400).json({ message: 'Invalid user ID' });

     try {
        const targetUserRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
        if (targetUserRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const targetUser = targetUserRes.rows[0];

        // Safety check: Prevent an admin from banning themselves
        if (targetUser.is_admin && targetUser.id === adminUserId && status === 'banned') {
             return res.status(403).json({ message: 'Admins cannot ban themselves.' });
        }

        const result = await pool.query(
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status',
            [points, status, targetUserId]
        );

        if (result.rowCount > 0) {
            res.json({ user: result.rows[0] });
        } else {
            // This case should ideally not be reached due to the check above
            res.status(404).json({ message: 'User not found' });
        }
     } catch (err) {
        console.error("Admin user update error:", err);
        res.status(500).json({ message: 'Failed to update user' });
     }
});

app.delete('/api/admin/users', authenticateToken, isAdmin, async(req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE is_admin = FALSE");
        res.status(200).json({message: 'All non-admin users deleted.'});
    } catch(err) {
        res.status(500).json({message: 'Failed to delete users'});
    }
});

// --- Server Status Route ---
app.get('/api/status', async (req, res) => {
    if (!ai) {
        return res.json({
            ai_enabled: false,
            message: aiInitializationError,
            message_ar: "خدمات الذكاء الاصطناعي معطلة: لم يتم العثور على مفتاح الواجهة البرمجية (API Key)."
        });
    }

    try {
        // Perform a quick, low-cost test call to validate the API key
        await ai.models.generateContent({
            model: 'gemini-2.5-flash', // Use a fast and cheap model for the test
            contents: 'hello',
        });
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
        
        res.json({
            ai_enabled: false,
            message: userMessage,
            message_ar: userMessageAr
        });
    }
});


// --- Start Server ---
const startServer = async () => {
    try {
        // Wait for the database to be ready before starting the server
        await initializeDb();
        app.listen(port, () => {
            console.log(`Server listening on port ${port}`);
        });
    } catch (error) {
        console.error("Failed to initialize database and start server:", error);
        process.exit(1); // Exit if the database can't be initialized
    }
};

startServer();