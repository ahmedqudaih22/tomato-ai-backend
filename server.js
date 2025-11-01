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

// --- Middleware ---

app.use(cors());

app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

const defaultSettings = {
    costs: { 
        imageEdit: 2, 
        imageCreate: 5, 
        textToSpeech: 1, 
        dailyRewardPoints: 10, 
        referralBonus: 50,
        imageEdit_noWatermark: 8,
        imageCreate_noWatermark: 15
    },
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
        },
        benefits: {
            title_ar: "ثورة الإبداع بالذكاء الاصطناعي: لماذا Tomato AI هو الخيار الأفضل؟",
            title_en: "The AI Creativity Revolution: Why Tomato AI is the Best Choice?",
            items: [
                { icon: "⚡️", title_ar: "سرعة فائقة", text_ar: "معالجة طلباتك في ثوانٍ بفضل خوادمنا السريعة.", title_en: "Blazing Speed", text_en: "Process your requests in seconds with our fast servers." },
                { icon: "💎", title_ar: "جودة لا تُضاهى", text_ar: "نتائج AI احترافية تنافس أفضل الأدوات المدفوعة.", title_en: "Unmatched Quality", text_en: "Professional AI results that rival the best paid tools." },
                { icon: "🛡️", title_ar: "أمان بياناتك", text_ar: "بياناتك وملفاتك مشفرة ومؤمنة بالكامل.", title_en: "Your Data's Security", text_en: "Your data and files are fully encrypted and secured." },
                { icon: "🌍", title_ar: "دعم عربي متكامل", text_ar: "واجهة ودعم فني باللغة العربية.", title_en: "Full Arabic Support", text_en: "Interface and technical support in Arabic." }
            ]
        },
        useCases: {
            title_ar: "مَن يستفيد من Tomato AI؟",
            title_en: "Who Benefits from Tomato AI?",
            items: [
                { icon: "🎬", title_ar: "صناع المحتوى", text_ar: "إنشاء تعليق صوتي طبيعي لفيديوهات يوتيوب وتيك توك.", title_en: "Content Creators", text_en: "Create natural voiceovers for YouTube and TikTok videos." },
                { icon: "🎨", title_ar: "المصممون والفنانون", text_ar: "تحويل الأفكار النصية المجردة إلى صور فنية عالية الجودة.", title_en: "Designers & Artists", text_en: "Turn abstract text ideas into high-quality artistic images." },
                { icon: "💼", title_ar: "المسوقون وأصحاب الأعمال", text_ar: "تعديل وتحسين صور المنتجات للإعلانات في ثوانٍ.", title_en: "Marketers & Businesses", text_en: "Edit and enhance product photos for ads in seconds." }
            ]
        },
        testimonials: {
            title_ar: "ماذا يقول المستخدمون عنا؟",
            title_en: "What Do Our Users Say?",
            items: [
                { id: 1, name_ar: "علياء منصور", name_en: "Alia Mansour", role_ar: "صانعة محتوى", role_en: "Content Creator", quote_ar: "وفر عليّ أداة تحويل النص إلى صوت ساعات من التسجيل الصوتي! الجودة مذهلة واللهجة طبيعية جدًا.", quote_en: "The text-to-speech tool saved me hours of voice recording! The quality is amazing and the dialect is very natural.", avatarUrl: "https://i.pravatar.cc/150?img=1" },
                { id: 2, name_ar: "خالد الغامدي", name_en: "Khalid Al-Ghamdi", role_ar: "مصمم جرافيك", role_en: "Graphic Designer", quote_ar: "مولّد الصور غيّر طريقة عملي. أستطيع الآن تجربة أفكار بصرية بسرعة فائقة قبل البدء في التصميم الفعلي.", quote_en: "The image generator has changed my workflow. I can now experiment with visual ideas incredibly fast before starting the actual design.", avatarUrl: "https://i.pravatar.cc/150?img=3" },
                { id: 3, name_ar: "فاطمة الزهراء", name_en: "Fatima Al-Zahra", role_ar: "مديرة تسويق", role_en: "Marketing Manager", quote_ar: "أستخدم محرر الصور يوميًا لتعديل صور منتجاتنا. ميزة الإزالة والتغيير باستخدام النص عبقرية وتوفر الوقت.", quote_en: "I use the image editor daily to modify our product photos. The feature to remove and change things with text is genius and a huge time-saver.", avatarUrl: "https://i.pravatar.cc/150?img=5" }
            ]
        },
        faq: {
            title_ar: "إجابات سريعة لأسئلتكم",
            title_en: "Quick Answers to Your Questions",
            items: [
                { id: 1, q_ar: "هل الخدمات مجانية؟", q_en: "Are the services free?", a_ar: "نحن نقدم 10 نقاط مجانية عند التسجيل لتجربة خدماتنا. بعد ذلك، يمكنك شراء باقات نقاط بأسعار معقولة من المتجر.", a_en: "We offer 10 free points upon registration to try our services. Afterwards, you can purchase affordable points packages from the store." },
                { id: 2, q_ar: "ماذا أفعل إذا واجهت مشكلة؟", q_en: "What if I encounter a problem?", a_ar: "يمكنك التواصل مع فريق الدعم الفني عبر البريد الإلكتروني support@tomatoai.net وسنكون سعداء بمساعدتك.", a_en: "You can contact our technical support team via email at support@tomatoai.net and we will be happy to assist you." },
                { id: 3, q_ar: "كيف أضمن أمان بياناتي؟", q_en: "How is my data security ensured?", a_ar: "نحن نستخدم أحدث تقنيات التشفير لحماية جميع بياناتك وصورك. خصوصيتك هي أولويتنا القصوى.", a_en: "We use the latest encryption technologies to protect all your data and images. Your privacy is our top priority." },
                { id: 4, q_ar: "هل يمكنني استخدام النتائج لأغراض تجارية؟", q_en: "Can I use the results for commercial purposes?", a_ar: "نعم، جميع الصور والملفات الصوتية التي تنشئها هي ملكك ولك كامل الحق في استخدامها لأي غرض، سواء كان شخصيًا أو تجاريًا.", a_en: "Yes, all images and audio files you generate are your property and you have the full right to use them for any purpose, whether personal or commercial." }
            ]
        },
        finalCta: {
            title_ar: "هل أنت مستعد لبدء الإبداع؟",
            title_en: "Ready to Start Creating?",
            text_ar: "انضم إلى آلاف المبدعين والمحترفين الذين يستخدمون Tomato AI. سجل الآن مجانًا.",
            text_en: "Join thousands of creators and professionals using Tomato AI. Sign up now for free.",
            button_ar: "أنشئ حسابك المجاني",
            button_en: "Create Your Free Account"
        }
    },
    store: { packages: [{ id: 1, points: 100, price: 5 }, { id: 2, points: 250, price: 10 }, { id: 3, points: 300, price: 1 }, { id: 4, points: 1500, price: 40 }] },
    announcement: { 
        enabled: false, imageUrl: "", contentAr: "<h1>عرض خاص!</h1><p>احصل على ضعف النقاط عند الشراء هذا الأسبوع.</p>", 
        contentEn: "<h1>Special Offer!</h1><p>Get double the points on all purchases this week.</p>",
        textColor: "#000000", fontSize: 16
    },
    maintenance: {
        enabled: false,
        message_ar: "🚧 الموقع قيد الصيانة حاليًا 🚧\n\nنحن نعمل بجد لتحسين تجربتك. سنعود قريبًا!",
        message_en: "🚧 Site is Currently Under Maintenance 🚧\n\nWe're working hard to improve your experience. We will be back soon!"
    }
};

const initializeDbSchema = async () => {
    if (!pool) {
        console.warn("Database pool not available. Skipping DB schema initialization.");
        return;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Create users table with a minimal schema if it doesn't exist to prevent alter errors.
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            );
        `);

        const columnExists = async (column) => {
             const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`, [column]);
             return res.rows.length > 0;
        };
        
        const addColumn = async (column, definition) => {
            if (!(await columnExists(column))) {
                await client.query(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
                console.log(`Schema updated: Added '${column}' column to 'users' table.`);
            }
        };

        // ONE-TIME RESET LOGIC: This logic was previously used to clear the user table.
        // It has been disabled to prevent accidental data loss on production deployments.
        if (!(await columnExists('username'))) {
            console.log("!!! WARNING: POTENTIAL SCHEMA RESET DETECTED ('username' column missing) !!!");
            // The following line is extremely dangerous and has been permanently disabled.
            // It was intended for initial setup only. If you need to reset the users table, do it manually.
            // await client.query('TRUNCATE TABLE users CASCADE');
            console.log("User table truncation has been SKIPPED to prevent data loss. The first user to register on an EMPTY table will still become an admin.");
        }
        
        // --- Schema Migration: Ensure all columns exist ---
        await addColumn('username', 'VARCHAR(50) UNIQUE');
        await addColumn('country', 'VARCHAR(10)');
        await addColumn('points', 'INTEGER DEFAULT 10');
        await addColumn('is_admin', 'BOOLEAN DEFAULT FALSE');
        await addColumn('status', 'VARCHAR(20) DEFAULT \'active\'');
        await addColumn('created_at', 'TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP');
        await addColumn('last_daily_claim', 'TIMESTAMP WITH TIME ZONE');
        await addColumn('session_token', 'TEXT UNIQUE');
        await addColumn('token_expires_at', 'TIMESTAMP WITH TIME ZONE');
        await addColumn('referral_code', 'TEXT UNIQUE');
        await addColumn('referred_by', 'INTEGER'); // Add constraint later if needed

        // Cleanup old columns
        if (await columnExists('verification_code')) {
            await client.query('ALTER TABLE users DROP COLUMN verification_code');
            console.log("Schema cleanup: Removed 'verification_code' column.");
        }
        if (await columnExists('verification_expires')) {
            await client.query('ALTER TABLE users DROP COLUMN verification_expires');
            console.log("Schema cleanup: Removed 'verification_expires' column.");
        }

        // Initialize other tables
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
        
        // Initialize settings if they don't exist
        const settingsRes = await client.query('SELECT * FROM settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO settings (id, config) VALUES (1, $1)', [JSON.stringify(defaultSettings)]);
            console.log("Database initialized: Default settings inserted.");
        } else {
            console.log("Database schema is ready.");
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error initializing database schema:", err);
        dbInitializationError = `Database initialization failed: ${err.message}`;
    } finally {
        client.release();
    }
};


let settingsCache = null;
const getSettings = async () => {
    if (settingsCache) return settingsCache;
    if (!pool) return defaultSettings;
    try {
        const result = await pool.query('SELECT config FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            settingsCache = result.rows[0].config;
            return settingsCache;
        }
        return defaultSettings;
    } catch (err) {
        console.error("Error fetching settings, returning default:", err);
        return defaultSettings;
    }
}
const invalidateSettingsCache = () => { settingsCache = null; };


const maintenanceMiddleware = async (req, res, next) => {
    if (!pool) return next();

    const settings = await getSettings();
    if (!settings.maintenance?.enabled) {
        return next();
    }

    // First, check if the user is an already authenticated admin. If so, let them pass.
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        try {
            const userRes = await pool.query(
                `SELECT is_admin FROM users WHERE session_token = $1 AND token_expires_at > NOW()`,
                [token]
            );
            if (userRes.rows.length > 0 && userRes.rows[0].is_admin) {
                return next(); // Admin is allowed for any endpoint.
            }
        } catch (dbError) {
            console.error("Maintenance middleware DB error:", dbError);
            // Fall through to block if we can't verify admin status.
        }
    }

    // If the user is not an authenticated admin, check for publicly allowed paths.
    // These are needed for the maintenance page and login form to function.
    if (req.path === '/api/config' || req.path === '/api/login') {
        return next();
    }

    if (req.path === '/api/settings') {
        // This endpoint is special: it's "allowed" but returns a 503 with data
        // so the frontend knows to display the maintenance page.
        return res.status(503).json({
            message: "Site is in maintenance mode",
            settings: settings
        });
    }
    
    // For all other requests from non-admins, block them.
    return res.status(503).json({
        message: "Site is in maintenance mode",
        maintenance_message_en: settings.maintenance.message_en,
        maintenance_message_ar: settings.maintenance.message_ar
    });
};

app.use(maintenanceMiddleware);


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
                u.id, u.username, u.email, u.country, u.points, u.is_admin, u.status, u.last_daily_claim, u.referral_code,
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
    res.json({});
});

app.post('/api/register', checkDb, async (req, res) => {
    const { username, email, password, country, referralCode } = req.body;
    if (!username || !email || !password) return res.status(400).json({ message: 'Username, email and password are required.' });
    if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters.'});

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userCountResult = await client.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(userCountResult.rows[0].count) === 0;
        
        const currentSettings = await getSettings();

        const existingUser = await client.query('SELECT email, username FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)', [email, username]);
        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            const user = existingUser.rows[0];
            if (user.email.toLowerCase() === email.toLowerCase()) {
                return res.status(409).json({ message: 'Email already exists.' });
            }
            if (user.username.toLowerCase() === username.toLowerCase()) {
                return res.status(409).json({ message: 'Username already exists.' });
            }
        }
        
        let referredById = null;
        if (referralCode) {
            const referrerRes = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerRes.rows.length > 0) {
                referredById = referrerRes.rows[0].id;
            }
        }

        const newUserPoints = referredById ? 10 + currentSettings.costs.referralBonus : 10;
        
        // Generate a more random referral code to prevent unique constraint violations
        const newReferralCode = crypto.randomBytes(8).toString('hex');

        const { rows } = await client.query(
            `INSERT INTO users (username, email, password, country, is_admin, status, referred_by, points, referral_code) 
             VALUES ($1, LOWER($2), $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [username, email, password, country, isFirstUser, 'active', referredById, newUserPoints, newReferralCode]
        );
        const newUser = rows[0];

        if (referredById) {
            await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [currentSettings.costs.referralBonus, referredById]);
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
    const { identifier, password } = req.body;
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)', [identifier]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }
        
        if (user.status === 'banned') {
            return res.status(403).json({ message: 'This account is banned.' });
        }
        
        const token = await generateAndSetToken(user.id, client);
        
        delete user.password;
        delete user.session_token;
        delete user.token_expires_at;
        
        res.status(200).json({ message: 'Login successful', user, token });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        if (client) client.release();
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
        const returnFields = 'id, username, email, country, points, is_admin, status, last_daily_claim';
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
        if (err.code === '23505' && err.constraint.includes('email')) {
             return res.status(409).json({ message: 'This email is already in use.' });
        }
        res.status(500).json({ message: 'Error updating profile' });
    }
});

app.post('/api/ai/generate', checkDb, checkAi, authenticateToken, async (req, res) => {
    const { payload, removeWatermark } = req.body;
    const userId = req.user.id;
    
    let cost = 0;
    const settings = await getSettings();
    const { type, ...params } = payload;
    
    try {
        // --- Server-side cost calculation ---
        if (type === 'generateImages') {
            cost = removeWatermark ? settings.costs.imageCreate_noWatermark : settings.costs.imageCreate;
        } else if (type === 'generateContent' && params.model === 'gemini-2.5-flash-image') {
            cost = removeWatermark ? settings.costs.imageEdit_noWatermark : settings.costs.imageEdit;
        } else if (type === 'generateContent' && params.model === 'gemini-2.5-flash-preview-tts') {
            cost = Math.ceil(params.contents[0].parts[0].text.length / 100) * settings.costs.textToSpeech;
        } else {
            throw new Error('Invalid AI operation type or model for cost calculation.');
        }

        if (req.user.points < cost) return res.status(402).json({ message: 'Insufficient points' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('UPDATE users SET points = points - $1 WHERE id = $2', [cost, userId]);
    
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
            
            const userResult = await client.query('SELECT id, username, email, country, points, is_admin, status, last_daily_claim FROM users WHERE id = $1', [userId]);
            await client.query('COMMIT');
            
            const user = userResult.rows[0];
            res.json({ result: apiResult, user });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err; // Re-throw to be caught by the outer catch block
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("AI Generation Error:", err.message, err.stack);
        res.status(500).json({ message: err.message || 'An error occurred during AI generation.' });
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
        const settings = await getSettings();
        const pointsToAdd = settings.costs.dailyRewardPoints || 10;

        const result = await pool.query(
            'UPDATE users SET points = points + $1, last_daily_claim = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, username, email, country, points, is_admin, status, last_daily_claim',
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
        const settings = await getSettings();
        res.json(settings);
    } catch (err) {
        console.error("Get settings error:", err);
        res.status(500).json({ message: 'Failed to fetch settings' });
    }
});

app.put('/api/admin/settings', checkDb, authenticateToken, isAdmin, async (req, res) => {
    const newSettings = req.body;
    try {
        await pool.query('UPDATE settings SET config = $1 WHERE id = 1', [newSettings]);
        invalidateSettingsCache();
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
        const settings = await getSettings();
        const pkg = settings.store.packages.find(p => p.id === packageId);
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
            success_url: `${process.env.FRONTEND_URL || 'https://tomatoai.net'}/?payment_success=true#store`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://tomatoai.net'}/?payment_cancelled=true#store`,
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
        const result = await client.query('SELECT id, username, email, country, points, is_admin, status, last_daily_claim FROM users ORDER BY id');
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
        
        const targetUser = targetUserRes.rows[0];

        // Security check: Prevent admins from banning other admins or themselves
        if (targetUser.is_admin && status === 'banned') {
            return res.status(403).json({ message: 'Admins cannot be banned.' });
        }

        const updates = [];
        const values = [];
        let valueIndex = 1;

        if (points !== undefined && typeof points === 'number') {
            updates.push(`points = $${valueIndex++}`);
            values.push(points);
        }
        if (status !== undefined && ['active', 'banned'].includes(status)) {
            updates.push(`status = $${valueIndex++}`);
            values.push(status);
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No valid fields to update provided.' });
        }

        values.push(targetUserId);
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${valueIndex} RETURNING id, username, email, country, points, is_admin, status, last_daily_claim`;
        
        const result = await pool.query(query, values);
        res.json({ user: result.rows[0], message: 'User updated successfully.' });

     } catch(err) {
         console.error(`Error updating user ${targetUserId}:`, err);
         res.status(500).json({ message: 'Internal server error' });
     }
});

// --- Server Startup ---
(async () => {
    await initializeDbSchema();
    app.listen(port, () => {
        console.log(`Server is listening on port ${port}`);
    });
})();