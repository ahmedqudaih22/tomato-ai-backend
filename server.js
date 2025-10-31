// A full-stack backend for Tomato AI
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Stripe = require('stripe');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
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

const MAILERSEND_API_TOKEN = process.env.MAILERSEND_API_TOKEN;
const MAILERSEND_SENDER_EMAIL = process.env.MAILERSEND_SENDER_EMAIL;
let mailerSendInitializationError = null;
if (!MAILERSEND_API_TOKEN || !MAILERSEND_SENDER_EMAIL) {
    mailerSendInitializationError = "MailerSend environment variables (MAILERSEND_API_TOKEN, MAILERSEND_SENDER_EMAIL) are not set. Email sending is disabled.";
    console.warn(mailerSendInitializationError);
}

const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY;
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;
let recaptchaInitializationError = null;
if (!RECAPTCHA_SITE_KEY || !RECAPTCHA_SECRET_KEY) {
    recaptchaInitializationError = "reCAPTCHA environment variables (RECAPTCHA_SITE_KEY, RECAPTCHA_SECRET_KEY) are not set. Registration is not protected against bots.";
    console.warn(recaptchaInitializationError);
}


// --- Middleware ---

app.use(cors());

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
const checkMailerSend = (req, res, next) => {
    if (mailerSendInitializationError) {
        return res.status(503).json({ message: mailerSendInitializationError });
    }
    next();
};


const defaultSettings = {
    costs: { imageEdit: 2, imageCreate: 5, textToSpeech: 1, dailyRewardPoints: 10, referralBonus: 50 },
    theme: { 
        logoUrl: "https://i.ibb.co/mH2WvTz/tomato-logo.png", 
        logoWidth: 150, 
        logoHeight: 40,
        primaryColor: "#FF6B6B", 
        secondaryColor: "#2EC4B6", 
        navbarColor: "#FFFFFF", 
        navTextColor: "#2A323C",
        buttonPadding: 8,
        sliderHeight: 450,
    },
    content: { 
        siteNameAr: "Tomato AI", siteNameEn: "Tomato AI",
        slider: {
            slide1: { image: "https://i.ibb.co/V9Z2xN3/slide1.png", title_ar: "إنشاء صور بالذكاء الاصطناعي", title_en: "AI Image Generation", text_ar: "حول كلماتك إلى روائع بصرية مذهلة.", text_en: "Turn your words into stunning visual masterpieces." },
            slide2: { image: "https://i.ibb.co/yQj5d5h/slide2.png", title_ar: "تعديل الصور بسهولة", title_en: "Effortless Image Editing", text_ar: "قم بإجراء تعديلات معقدة باستخدام أوامر نصية بسيطة.", text_en: "Make complex edits with simple text commands." },
            slide3: { image: "https://i.ibb.co/GvxBf2T/tts-placeholder.jpg", title_ar: "تحويل النص إلى صوت واقعي", title_en: "Realistic Text-to-Speech", text_ar: "أنشئ تعليقات صوتية طبيعية لأي نص.", text_en: "Create natural-sounding voiceovers for any text." }
        },
        cta: {
            title_ar: "أدوات ذكاء اصطناعي قوية لإبداعك",
            title_en: "Powerful AI Tools For Your Creativity",
            subtitle_ar: "حرر، أنشئ، وحول أفكارك إلى واقع بسهولة.",
            subtitle_en: "Unleash, create, and turn your ideas into reality easily.",
            button_ar: "ابدأ الإبداع الآن",
            button_en: "Start Creating Now",
            background_image: "https://i.ibb.co/wzR06pM/cta-bg.png"
        }
    },
    store: { packages: [{ id: 1, points: 100, price: 5 }, { id: 2, points: 250, price: 10 }, { id: 3, points: 300, price: 1 }, { id: 4, points: 1500, price: 40 }] },
    announcement: { 
        enabled: false, imageUrl: "", contentAr: "<h1>عرض خاص!</h1><p>احصل على ضعف النقاط عند الشراء هذا الأسبوع.</p>", 
        contentEn: "<h1>Special Offer!</h1><p>Get double the points on all purchases this week.</p>",
        textColor: "#000000", fontSize: 16
    }
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
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_daily_claim TIMESTAMP WITH TIME ZONE,
                verification_code TEXT,
                verification_expires TIMESTAMP WITH TIME ZONE,
                session_token TEXT UNIQUE,
                token_expires_at TIMESTAMP WITH TIME ZONE,
                referral_code TEXT UNIQUE,
                referred_by INTEGER REFERENCES users(id)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY DEFAULT 1,
                config JSONB NOT NULL
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                prompt TEXT,
                result_url TEXT,
                cost INTEGER NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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

// --- Unified Email Sending Utility ---
const sendEmail = async (to, subject, html, fromName = "Tomato AI") => {
    if (mailerSendInitializationError) {
        throw new Error("Cannot send email because MailerSend is not configured.");
    }
    const emailPayload = {
        from: { email: MAILERSEND_SENDER_EMAIL, name: fromName },
        to: [{ email: to }],
        subject,
        html
    };

    try {
        const response = await fetch('https://api.mailersend.com/v1/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MAILERSEND_API_TOKEN}`
            },
            body: JSON.stringify(emailPayload)
        });

        if (response.ok) {
            const messageId = response.headers.get('x-message-id');
            console.log(`Email sent successfully to ${to}. Message ID: ${messageId}`);
            return {
                success: true,
                message: 'Email sent successfully!',
                details: { status: response.status, statusText: response.statusText, messageId: messageId || 'Not provided' }
            };
        }

        // Handle API error responses
        let errorDetails = `Status: ${response.status} ${response.statusText}`;
        try {
            const errorBody = await response.json();
            console.error('MailerSend API Error:', errorBody);
            errorDetails = errorBody.message || errorDetails;
            if (errorBody.errors) {
                errorDetails += ` Details: ${JSON.stringify(errorBody.errors)}`;
            }
        } catch (e) {
            console.error('Could not parse MailerSend error response as JSON.');
        }
        throw new Error(`Failed to send email. Details: ${errorDetails}`);

    } catch (error) {
        console.error('Error in sendEmail function:', error.message);
        throw error;
    }
};

const generateAndSetToken = async (userId, client) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiry
    await client.query(
        'UPDATE users SET session_token = $1, token_expires_at = $2 WHERE id = $3',
        [token, expiresAt, userId]
    );
    return token;
};

const authenticateToken = async (req, res, next) => {
    if (!pool) return res.status(503).json({ message: dbInitializationError });
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    
    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            `SELECT 
                u.id, u.email, u.country, u.points, u.is_admin, u.status, u.last_daily_claim, u.referral_code,
                (SELECT COUNT(*) FROM users WHERE referred_by = u.id) as referrals
             FROM users u
             WHERE u.session_token = $1 AND u.token_expires_at > NOW()`,
            [token]
        );
        
        if (result.rows.length === 0) return res.sendStatus(403);
        
        req.user = result.rows[0];
        next();
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.sendStatus(500);
    } finally {
        if (client) client.release();
    }
};

const isAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }
    next();
};

// --- API Routes ---

app.get('/api/config', (req, res) => {
    res.json({
        recaptchaSiteKey: RECAPTCHA_SITE_KEY,
    });
});

app.post('/api/register', checkDb, async (req, res) => {
    const { email, password, country, recaptchaToken, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

    if (!recaptchaInitializationError) {
        if (!recaptchaToken) {
            return res.status(400).json({ message: 'Please complete the reCAPTCHA.' });
        }
        try {
            const verificationUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`;
            const recaptchaRes = await fetch(verificationUrl, { method: 'POST' });
            const recaptchaData = await recaptchaRes.json();
            if (!recaptchaData.success) {
                console.error("reCAPTCHA verification failed:", recaptchaData['error-codes']);
                return res.status(400).json({ message: 'reCAPTCHA verification failed. Please try again.' });
            }
        } catch (e) {
            console.error("reCAPTCHA request error:", e);
            return res.status(500).json({ message: 'Could not verify reCAPTCHA. Please contact support.' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existingUser = await client.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Email already exists.' });
        }
        
        const userCountResult = await client.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCountResult.rows[0].count) === 0;

        let referredById = null;
        if (referralCode) {
            const referrerRes = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerRes.rows.length > 0) {
                referredById = referrerRes.rows[0].id;
            }
        }

        const newUserPoints = referredById ? 10 + defaultSettings.costs.referralBonus : 10;
        
        const { rows } = await client.query(
            `INSERT INTO users (email, password, country, is_admin, status, referred_by, points, referral_code) 
             VALUES (LOWER($1), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [email, password, country, isFirstUser, 'active', referredById, newUserPoints, `${email.split('@')[0]}${crypto.randomBytes(3).toString('hex')}`]
        );
        const newUser = rows[0];

        if (referredById) {
            await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [defaultSettings.costs.referralBonus, referredById]);
        }

        const token = await generateAndSetToken(newUser.id, client);
        
        await client.query('COMMIT');
        
        delete newUser.password;
        delete newUser.session_token;
        delete newUser.token_expires_at;
        
        return res.status(201).json({ 
            message: 'Registration successful! You are now logged in.', 
            user: newUser, 
            token 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Registration Error:", err);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
});


app.post('/api/login', checkDb, async (req, res) => {
    const { email, password } = req.body;
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
        
        const user = result.rows[0];
        if (user.password !== password) return res.status(401).json({ message: 'Invalid credentials' });
        
        if (user.status === 'pending') {
            return res.status(401).json({ message: 'Your account is not verified. Please contact support.', code: 'ACCOUNT_NOT_VERIFIED' });
        }
        if (user.status === 'banned') return res.status(403).json({ message: 'This account is banned.' });
        
        const token = await generateAndSetToken(user.id, client);
        
        delete user.password;
        delete user.session_token;
        delete user.token_expires_at;
        
        res.status(200).json({ message: 'Login successful', user, token });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
});


app.get('/api/users/me', checkDb, authenticateToken, async (req, res) => {
    const user = req.user;
    // The user object from authenticateToken already has sensitive fields removed
    res.json({ user });
});

app.put('/api/users/me', checkDb, authenticateToken, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.user.id;
    try {
        let query, queryParams;
        const returnFields = 'id, email, country, points, is_admin, status, last_daily_claim';
        if (password) {
            query = `UPDATE users SET email = LOWER($1), password = $2 WHERE id = $3 RETURNING ${returnFields}`;
            queryParams = [email, password, userId];
        } else {
            query = `UPDATE users SET email = LOWER($1) WHERE id = $2 RETURNING ${returnFields}`;
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
        
        const userResult = await client.query('SELECT id, email, country, points, is_admin, status, last_daily_claim FROM users WHERE id = $1', [userId]);
        await client.query('COMMIT');
        
        const user = userResult.rows[0];
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
            contents: [{ parts: [imagePart, textPart] }],
            config: { responseModalities: ['IMAGE'] },
        });
        const firstPart = response.candidates?.[0]?.content?.parts?.[0];
        if (firstPart?.inlineData) {
            res.json({ dataUrl: `data:${firstPart.inlineData.mimeType};base64,${firstPart.inlineData.data}` });
        } else {
            console.error("Unexpected BG Removal Response:", JSON.stringify(response, null, 2));
            throw new Error("AI background removal failed to return an image.");
        }
    } catch (err) {
        console.error("BG Removal Error:", err);
        res.status(500).json({ message: err.message || 'Failed to remove background.' });
    }
});

app.post('/api/claim-daily-reward', checkDb, authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const lastClaim = req.user.last_daily_claim ? new Date(req.user.last_daily_claim).getTime() : 0;
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (now - lastClaim < twentyFourHours) {
        return res.status(429).json({ message: 'You can only claim the daily reward once every 24 hours.' });
    }
    
    try {
        const settingsRes = await pool.query('SELECT config FROM settings WHERE id = 1');
        const pointsToAdd = settingsRes.rows[0].config.costs.dailyRewardPoints || 10;

        const result = await pool.query(
            'UPDATE users SET points = points + $1, last_daily_claim = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, country, points, is_admin, status, last_daily_claim',
            [pointsToAdd, userId]
        );
        const user = result.rows[0];
        res.status(200).json({ message: `You have claimed ${pointsToAdd} points!`, user });
    } catch (err) {
        console.error("Daily reward claim error:", err);
        res.status(500).json({ message: 'Internal server error during reward claim.' });
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
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT id, email, country, points, is_admin, status, last_daily_claim FROM users ORDER BY id');
        res.json({ users: result.rows });
    } catch (err) {
        console.error("Error fetching admin users list:", err);
        res.status(500).json({ message: 'Failed to fetch users' });
    } finally {
        if (client) client.release();
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
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 RETURNING id, email, country, points, is_admin, status, last_daily_claim',
            [points, status, targetUserId]
        );
        res.json({ user: result.rows[0] });
     } catch (err) {
        console.error("Admin user update error:", err);
        res.status(500).json({ message: 'Failed to update user' });
     }
});

app.post('/api/admin/test-email', checkDb, authenticateToken, isAdmin, checkMailerSend, async (req, res) => {
    const { testEmail } = req.body;
    if (!testEmail) {
        return res.status(400).json({ message: 'testEmail is required.' });
    }
    try {
        const subject = `[TEST] Your Email Configuration for Tomato AI`;
        const html = `<div style="font-family: Arial, sans-serif; text-align: center; color: #333;"><h2>This is a TEST email from Tomato AI!</h2><p>If you received this, your email configuration is working correctly.</p></div>`;
        const result = await sendEmail(testEmail, subject, html, "Tomato AI (Test)");
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Failed to send test email.', details: error.details || error.message || 'Unknown error' });
    }
});

app.post('/api/history', checkDb, authenticateToken, async (req, res) => {
    const { type, prompt, resultUrl, cost } = req.body;
    try {
        await pool.query(
            'INSERT INTO history (user_id, type, prompt, result_url, cost) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, type, prompt, resultUrl, cost]
        );
        res.sendStatus(201);
    } catch (err) {
        console.error("Error saving history:", err);
        res.status(500).json({ message: 'Failed to save history' });
    }
});

app.get('/api/history', checkDb, authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, type, prompt, cost, result_url AS "resultUrl", created_at AS date FROM history WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json({ history: result.rows });
    } catch (err) {
        console.error("Error fetching history:", err);
        res.status(500).json({ message: 'Failed to fetch history' });
    }
});

app.get('/api/stats', checkDb, authenticateToken, isAdmin, async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const operationsCount = await pool.query('SELECT COUNT(*) FROM history');

        res.json({
            users: parseInt(usersCount.rows[0].count, 10),
            operations: parseInt(operationsCount.rows[0].count, 10),
            visitors: 0 // Placeholder for future implementation
        });
    } catch (err) {
        console.error("Error fetching stats:", err);
        res.status(500).json({ message: 'Failed to fetch statistics' });
    }
});


app.get('/api/status', async (req, res) => {
    let ai_enabled = false;
    let message = aiInitializationError;
    let message_ar = aiInitializationError || "خدمات الذكاء الاصطناعي معطلة.";

    if (ai) {
        try {
            await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hello' });
            ai_enabled = true;
            message = 'AI services are operational and the API key is valid.';
            message_ar = 'خدمات الذكاء الاصطناعي فعّالة ومفتاح الواجهة البرمجية (API Key) صالح.';
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
            message = userMessage;
            message_ar = userMessageAr;
        }
    }
    
    const recaptcha_enabled = !recaptchaInitializationError;
    const recaptcha_message = recaptcha_enabled ? 'reCAPTCHA is configured and active for registration.' : recaptchaInitializationError;
    const recaptcha_message_ar = recaptcha_enabled ? 'نظام reCAPTCHA مُعد وجاهز للعمل لحماية التسجيل.' : "متغيرات بيئة reCAPTCHA غير مُعينة. التسجيل غير محمي ضد البوتات.";

    res.json({
        ai_enabled: ai_enabled,
        message: message,
        message_ar: message_ar,
        email_enabled: !mailerSendInitializationError,
        email_message: !mailerSendInitializationError ? 'Email services are operational.' : mailerSendInitializationError,
        email_message_ar: !mailerSendInitializationError ? 'خدمات البريد الإلكتروني فعّالة.' : "متغيرات بيئة MailerSend غير مُعينة. إرسال البريد الإلكتروني معطل.",
        recaptcha_enabled,
        recaptcha_message,
        recaptcha_message_ar
    });
});

// --- Start Server ---
app.listen(port, async () => {
    console.log(`Server listening on port ${port}`);
    await initializeDbSchema();
});