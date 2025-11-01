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
        imageCreate_noWatermark: 15,
        contentRewrite: 1,
        tweetGenerator: 1,
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
                { id: 3, name_ar: "فاطمة الزهراء", name_en: "Fatima Al-Zahra", role_ar: "مديرة تسويق", role_en: "Marketing Manager", quote_ar: "أستخدم محرر الصور يوميًا لتعديل صور منتجاتنا. ميزة الإزالة والتغيير باستخدام النص عبقرية وتوفر الوقت.", quote_en: "I use the image editor daily to modify our product photos. The feature to remove and change things with text is genius and a huge time-saver.", avatarUrl: "https://i.pravatar.cc/150?img=5" },
                { id: 4, name_ar: "سارة عبد الله", name_en: "Sara Abdullah", role_ar: "مدونة", role_en: "Blogger", quote_ar: "أداة إعادة الصياغة ممتازة! تساعدني في تجديد محتوى مقالاتي القديمة بسرعة وكفاءة، مع الحفاظ على المعنى الأصلي.", quote_en: "The rewriting tool is excellent! It helps me quickly and efficiently refresh the content of my old articles, while maintaining the original meaning.", avatarUrl: "https://i.pravatar.cc/150?img=8" }
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

// --- Helper function for safely merging new default settings into existing DB settings ---
const isObject = (item) => item && typeof item === 'object' && !Array.isArray(item);

/**
 * Deep merges a source object into a target object.
 * It prioritizes the source's values, but preserves target keys that don't exist in the source.
 * This is the reverse of a typical merge, designed to "fill in the blanks" in a primary object from a default object.
 * @param {object} primary - The main object (e.g., from DB) that might be missing keys.
 * @param {object} defaults - The complete default object with all possible keys.
 * @returns {object} A new merged object.
 */
const mergeWithDefaults = (primary, defaults) => {
    const output = { ...primary };
    if (isObject(primary) && isObject(defaults)) {
        Object.keys(defaults).forEach(key => {
            // If key from defaults is missing in primary, add it.
            if (!(key in primary)) {
                output[key] = defaults[key];
            } 
            // If both are objects, recurse to merge them.
            else if (isObject(primary[key]) && isObject(defaults[key])) {
                output[key] = mergeWithDefaults(primary[key], defaults[key]);
            }
            // Otherwise, primary's value is kept (already in `output`).
        });
    }
    return output;
};


let settingsCache = null;
const getSettings = async () => {
    if (settingsCache) return settingsCache;
    if (!pool) return defaultSettings;
    try {
        const result = await pool.query('SELECT config FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            const dbSettings = result.rows[0].config;
            // Merge the settings from the DB with the defaults.
            // This ensures any new fields added to `defaultSettings` (like a new service cost)
            // will be available in the live app even if they haven't been saved in the admin panel yet.
            const mergedSettings = mergeWithDefaults(dbSettings, defaultSettings);
            settingsCache = mergedSettings;
            return mergedSettings;
        }
        return defaultSettings;
    } catch (error) {
        console.error("Error fetching settings, falling back to defaults:", error);
        return defaultSettings;
    }
};

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    
    if (!pool) return res.status(503).json({ message: "Database service unavailable." });

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE session_token = $1 AND token_expires_at > NOW()',
            [token]
        );
        if (result.rows.length === 0) return res.sendStatus(403);
        req.user = result.rows[0];
        next();
    } catch (error) {
        console.error("Authentication error:", error);
        res.sendStatus(500);
    }
};

const adminOnly = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }
    next();
};

// --- API Routes ---

// GET /api/config (Public) - Basic app config
app.get('/api/config', (req, res) => {
    res.json({
        stripe_enabled: !!stripe,
        db_enabled: !!pool,
        ai_enabled: !!ai,
        email_enabled: !!MAILERSEND_API_TOKEN && !!MAILERSEND_SENDER_EMAIL
    });
});

// GET /api/status (Public) - Detailed service status
app.get('/api/status', (req, res) => {
    res.json({
        ai_enabled: !!ai,
        message: aiInitializationError || "AI services are fully operational.",
        message_ar: aiInitializationError || "خدمات الذكاء الاصطناعي تعمل بشكل كامل.",
        email_enabled: !mailerSendInitializationError,
        email_message: mailerSendInitializationError || "Email services are fully operational.",
        email_message_ar: mailerSendInitializationError || "خدمات البريد الإلكتروني تعمل بشكل كامل."
    });
});


// GET /api/settings (Conditionally Authenticated)
app.get('/api/settings', async (req, res) => {
    let currentUser = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token && pool) {
        try {
            const result = await pool.query('SELECT is_admin FROM users WHERE session_token = $1 AND token_expires_at > NOW()', [token]);
            if (result.rows.length > 0) {
                currentUser = result.rows[0];
            }
        } catch (dbError) {
             console.error("Error checking user auth for settings:", dbError);
        }
    }
    
    const settings = await getSettings();
    if (settings.maintenance?.enabled && !currentUser?.is_admin) {
        // Send only minimal settings required for the maintenance page
        return res.status(503).json({ 
            message: 'Service Unavailable',
            settings: {
                theme: settings.theme,
                maintenance: settings.maintenance
            }
        });
    }

    res.json(settings);
});

app.post('/api/register', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable." });
    
    const { username, email, password, country, referralCode } = req.body;
    if (!username || !email || !password || !country) {
        return res.status(400).json({ message: 'All fields are required.' });
    }
    
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const emailCheck = await client.query('SELECT id FROM users WHERE email = $1', [email]);
            if (emailCheck.rows.length > 0) {
                return res.status(409).json({ message: 'Email already exists.' });
            }

            const usernameCheck = await client.query('SELECT id FROM users WHERE username = $1', [username]);
            if (usernameCheck.rows.length > 0) {
                return res.status(409).json({ message: 'Username already exists.' });
            }

            const salt = crypto.randomBytes(16).toString('hex');
            const hashedPassword = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
            const finalPassword = `${salt}:${hashedPassword}`;
            
            // Check if this is the first user
            const userCountResult = await client.query('SELECT COUNT(*) FROM users');
            const isFirstUser = parseInt(userCountResult.rows[0].count, 10) === 0;

            const newReferralCode = crypto.randomBytes(4).toString('hex');

            let referredById = null;
            if (referralCode) {
                const referrerResult = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
                if (referrerResult.rows.length > 0) {
                    referredById = referrerResult.rows[0].id;
                }
            }
            
            const newUserResult = await client.query(
                'INSERT INTO users (username, email, password, country, is_admin, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                [username, email, finalPassword, country, isFirstUser, newReferralCode, referredById]
            );
            const newUser = newUserResult.rows[0];

            if (referredById) {
                const settings = await getSettings();
                const bonus = settings.costs.referralBonus || 50;
                await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [bonus, referredById]);
                await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [bonus, newUser.id]);
            }

            const sessionToken = crypto.randomBytes(32).toString('hex');
            const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
            await client.query(
                'UPDATE users SET session_token = $1, token_expires_at = $2 WHERE id = $3',
                [sessionToken, tokenExpiresAt, newUser.id]
            );

            await client.query('COMMIT');

            // Don't send password back
            delete newUser.password;
            res.status(201).json({ 
                message: 'Registration successful!', 
                token: sessionToken,
                user: newUser
            });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

app.post('/api/login', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable." });
    
    const { identifier, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE (email = $1 OR username = $1) AND status = \'active\'', 
            [identifier]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        const user = result.rows[0];
        const [salt, key] = user.password.split(':');
        const hashedPassword = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');

        if (key !== hashedPassword) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }
        
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await pool.query(
            'UPDATE users SET session_token = $1, token_expires_at = $2 WHERE id = $3',
            [sessionToken, tokenExpiresAt, user.id]
        );
        
        delete user.password;
        res.json({ token: sessionToken, user });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

app.get('/api/users/me', authenticateToken, (req, res) => {
    delete req.user.password;
    res.json({ user: req.user });
});

app.put('/api/users/me', authenticateToken, async (req, res) => {
    const { email, password } = req.body;
    let updateQuery = 'UPDATE users SET email = $1';
    const queryParams = [email, req.user.id];

    if (password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hashedPassword = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        const finalPassword = `${salt}:${hashedPassword}`;
        updateQuery += ', password = $3';
        queryParams.push(finalPassword);
    }
    
    updateQuery += ' WHERE id = $2 RETURNING *';

    try {
        const result = await pool.query(updateQuery, queryParams);
        const updatedUser = result.rows[0];
        delete updatedUser.password;
        res.json({ user: updatedUser });
    } catch (error) {
        console.error("Profile update error:", error);
        if (error.code === '23505') { // Unique constraint violation
            return res.status(409).json({ message: 'Email is already in use.' });
        }
        res.status(500).json({ message: 'Server error during profile update.' });
    }
});

app.post('/api/claim-daily-reward', authenticateToken, async (req, res) => {
    try {
        const now = new Date();
        const lastClaim = req.user.last_daily_claim ? new Date(req.user.last_daily_claim) : null;
        
        if (lastClaim && now - lastClaim < 24 * 60 * 60 * 1000) {
            return res.status(429).json({ message: 'You have already claimed your daily reward.' });
        }
        
        const settings = await getSettings();
        const reward = settings.costs.dailyRewardPoints || 10;
        
        const result = await pool.query(
            'UPDATE users SET points = points + $1, last_daily_claim = NOW() WHERE id = $2 RETURNING *',
            [reward, req.user.id]
        );
        
        const updatedUser = result.rows[0];
        delete updatedUser.password;
        res.json({ user: updatedUser });

    } catch (error) {
        console.error("Daily reward claim error:", error);
        res.status(500).json({ message: 'Server error while claiming reward.' });
    }
});


// --- History Routes ---
app.post('/api/history', authenticateToken, async (req, res) => {
    const { type, prompt, resultUrl, cost } = req.body;
    try {
        await pool.query(
            'INSERT INTO history (user_id, type, prompt, result_url, cost) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, type, prompt, resultUrl, cost]
        );
        res.sendStatus(201);
    } catch (error) {
        console.error("Failed to save history:", error);
        res.status(500).json({ message: 'Failed to save history item.' });
    }
});

app.get('/api/history', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json({ history: result.rows });
    } catch (error) {
        console.error("Failed to fetch history:", error);
        res.status(500).json({ message: 'Failed to fetch history.' });
    }
});


// --- AI Generation Routes (Authenticated) ---
app.post('/api/ai/generate', authenticateToken, async (req, res) => {
    if (!ai) {
        return res.status(503).json({ message: 'AI service is not configured on the server.' });
    }

    const { payload, removeWatermark } = req.body;
    const settings = await getSettings();
    let cost = 0;
    
    // Calculate cost based on operation type
    try {
        if (payload.type === 'generateImages') {
            cost = removeWatermark ? settings.costs.imageCreate_noWatermark : settings.costs.imageCreate;
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-image') {
            cost = removeWatermark ? settings.costs.imageEdit_noWatermark : settings.costs.imageEdit;
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-preview-tts') {
            cost = Math.ceil((payload.contents[0].parts[0].text.length || 0) / 100) * settings.costs.textToSpeech;
        } else if (payload.type === 'rewrite') {
            cost = settings.costs.contentRewrite ?? 1;
        } else if (payload.type === 'generate-tweets') {
            cost = settings.costs.tweetGenerator ?? 1;
        } else if (payload.type !== 'generateContent') {
             return res.status(400).json({ message: 'Invalid AI operation type.' });
        }
    } catch (e) {
        return res.status(400).json({ message: 'Invalid payload structure for cost calculation.'});
    }


    if (cost > 0 && req.user.points < cost) {
        return res.status(402).json({ message: 'Insufficient points.' });
    }
    
    let updatedUser = req.user;
    if (cost > 0) {
        const result = await pool.query(
            'UPDATE users SET points = points - $1 WHERE id = $2 RETURNING *',
            [cost, req.user.id]
        );
        updatedUser = result.rows[0];
    }
    
    delete updatedUser.password;

    try {
        let aiResult;
        switch (payload.type) {
            case 'generateImages': {
                const response = await ai.models.generateImages({ ...payload, model: 'imagen-4.0-generate-001' });
                const base64Image = response.generatedImages[0].image.imageBytes;
                aiResult = { dataUrl: `data:image/png;base64,${base64Image}` };
                break;
            }
            case 'generateContent': {
                const response = await ai.models.generateContent(payload);
                if (payload.config.responseModalities?.includes('IMAGE')) {
                    const base64Image = response.candidates[0].content.parts[0].inlineData.data;
                    aiResult = { dataUrl: `data:image/png;base64,${base64Image}` };
                } else if (payload.config.responseModalities?.includes('AUDIO')) {
                    const base64Audio = response.candidates[0].content.parts[0].inlineData.data;
                    aiResult = { base64Audio };
                } else {
                    aiResult = { text: response.text };
                }
                break;
            }
            case 'rewrite': {
                const prompt = `أعد صياغة النص التالي بأسلوب احترافي وجذاب مع الحفاظ على المعنى الأساسي. اجعل النص أكثر وضوحًا وسلاسة. النص الأصلي: "${payload.text}"`;
                const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
                aiResult = { text: response.text };
                break;
            }
            case 'generate-tweets': {
                const prompt = `بصفتك خبيرًا في وسائل التواصل الاجتماعي، قم بإنشاء 3 تغريدات قصيرة وجذابة (بتنسيق تويتر) حول الموضوع التالي. استخدم الهاشتاجات ذات الصلة واجعلها قابلة للمشاركة. الموضوع: "${payload.idea}"`;
                const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
                aiResult = { text: response.text };
                break;
            }
            default:
                throw new Error('Unsupported AI operation type in execution.');
        }

        res.json({ result: aiResult, user: updatedUser });

    } catch (error) {
        console.error("AI Generation Error:", error);
        // Refund points on AI error
        if (cost > 0) {
             const refundResult = await pool.query(
                'UPDATE users SET points = points + $1 WHERE id = $2 RETURNING *',
                [cost, req.user.id]
            );
            updatedUser = refundResult.rows[0];
            delete updatedUser.password;
        }
        res.status(500).json({ message: `AI generation failed: ${error.message}`, user: updatedUser });
    }
});


app.post('/api/ai/remove-background', authenticateToken, async (req, res) => {
    if (!ai) return res.status(503).json({ message: 'AI service not configured.' });
    
    const { imagePart, textPart } = req.body;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [{ parts: [imagePart, textPart] }],
            config: { responseModalities: ['IMAGE'] },
        });

        const base64Image = response.candidates[0].content.parts[0].inlineData.data;
        const dataUrl = `data:image/png;base64,${base64Image}`;
        res.json({ dataUrl });

    } catch (error) {
        console.error("Background removal AI error:", error);
        res.status(500).json({ message: `Background removal failed: ${error.message}` });
    }
});


// --- Stripe Routes ---
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    if (!stripe) {
        return res.status(503).json({ message: 'Payment service is not configured.' });
    }
    const { packageId } = req.body;
    const settings = await getSettings();
    const pkg = settings.store.packages.find(p => p.id == packageId);

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
                        name: `${pkg.points.toLocaleString()} Points Package`,
                    },
                    unit_amount: pkg.price * 100, // Price in cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:8000'}#store?payment_success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:8000'}#store?payment_cancelled=true`,
            metadata: {
                userId: req.user.id,
                packageId: pkg.id,
                points: pkg.points
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe session creation error:", error);
        res.status(500).json({ message: 'Failed to create payment session.' });
    }
});

// Stripe Webhook
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.log(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { userId, points } = session.metadata;

        if (userId && points) {
            try {
                await pool.query(
                    'UPDATE users SET points = points + $1 WHERE id = $2',
                    [parseInt(points, 10), parseInt(userId, 10)]
                );
                console.log(`Successfully awarded ${points} points to user ${userId}.`);
            } catch (error) {
                console.error(`Failed to update points for user ${userId}:`, error);
                // Consider adding to a retry queue or alerting system
            }
        }
    }
    res.status(200).json({ received: true });
});

// --- Admin Routes (Authenticated & Admin Only) ---

app.get('/api/admin/users', authenticateToken, adminOnly, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, email, country, points, status, is_admin FROM users ORDER BY id ASC');
        res.json({ users: result.rows });
    } catch (error) {
        console.error("Admin fetch users error:", error);
        res.status(500).json({ message: 'Failed to fetch users.' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, adminOnly, async (req, res) => {
    const { id } = req.params;
    const { points, status } = req.body;

    try {
        const targetUserRes = await pool.query('SELECT is_admin FROM users WHERE id = $1', [id]);
        if (targetUserRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        
        // Prevent changing status of an admin
        if (targetUserRes.rows[0].is_admin && status !== undefined && req.user.id != id) {
            // Allow admin to change their own status if needed (unlikely)
            return res.status(403).json({ message: 'Cannot change status for another admin account.' });
        }
        
        let updateParts = [];
        let queryParams = [];
        let paramIndex = 1;

        if (points !== undefined) {
            updateParts.push(`points = points + $${paramIndex++}`);
            queryParams.push(points);
        }
        if (status !== undefined) {
            updateParts.push(`status = $${paramIndex++}`);
            queryParams.push(status);
        }

        if (updateParts.length === 0) {
            return res.status(400).json({ message: 'No update parameters provided.' });
        }

        queryParams.push(id);
        const query = `UPDATE users SET ${updateParts.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, email, country, points, status, is_admin`;
        
        const result = await pool.query(query, queryParams);
        res.json({ user: result.rows[0] });

    } catch (error) {
        console.error("Admin update user error:", error);
        res.status(500).json({ message: 'Failed to update user.' });
    }
});


app.put('/api/admin/settings', authenticateToken, adminOnly, async (req, res) => {
    const newSettings = req.body;
    try {
        await pool.query(
            'UPDATE settings SET config = $1 WHERE id = 1',
            [JSON.stringify(newSettings)]
        );
        settingsCache = newSettings; // Update cache immediately
        res.status(200).json({ message: 'Settings updated successfully.' });
    } catch (error) {
        console.error("Admin update settings error:", error);
        res.status(500).json({ message: 'Failed to save settings.' });
    }
});

// FIX: Added a new endpoint to fetch comprehensive statistics for the admin dashboard. This includes total registered users, total AI operations performed, and total successful referrals. This resolves the bug where the dashboard showed incorrect or zero values.
app.get('/api/stats', authenticateToken, adminOnly, async (req, res) => {
    try {
        const userCountQuery = pool.query('SELECT COUNT(*) FROM users;');
        const opCountQuery = pool.query('SELECT COUNT(*) FROM history;');
        const refCountQuery = pool.query("SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL;");

        const [userCount, opCount, refCount] = await Promise.all([userCountQuery, opCountQuery, refCountQuery]);

        res.json({
            users: parseInt(userCount.rows[0]?.count || 0, 10),
            operations: parseInt(opCount.rows[0]?.count || 0, 10),
            referrals: parseInt(refCount.rows[0]?.count || 0, 10),
        });
    } catch (error) {
        console.error("Failed to fetch admin stats:", error);
        res.status(500).json({ message: 'Failed to retrieve statistics.' });
    }
});

app.post('/api/admin/test-email', authenticateToken, adminOnly, async (req, res) => {
    if (!MAILERSEND_API_TOKEN || !MAILERSEND_SENDER_EMAIL) {
        return res.status(503).json({ message: 'MailerSend service is not configured on the server.' });
    }
    const { testEmail } = req.body;
    if (!testEmail) {
        return res.status(400).json({ message: 'Recipient email is required.' });
    }

    try {
        const response = await fetch('https://api.mailersend.com/v1/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MAILERSEND_API_TOKEN}`
            },
            body: JSON.stringify({
                from: { email: MAILERSEND_SENDER_EMAIL },
                to: [{ email: testEmail }],
                subject: 'Tomato AI - Test Email',
                text: 'This is a test email from your Tomato AI application. If you received this, your email configuration is working correctly!',
                html: '<p>This is a test email from your Tomato AI application. If you received this, your <strong>email configuration is working correctly!</strong></p>'
            })
        });

        if (!response.ok) {
            // Try to parse error from MailerSend if possible
            const errorBody = await response.json().catch(() => ({ message: `MailerSend API returned status ${response.status}` }));
            return res.status(response.status).json({
                message: 'Failed to send test email.',
                details: errorBody
            });
        }
        
        res.status(200).json({ message: 'Test email sent successfully! Check the recipient\'s inbox.' });

    } catch (error) {
        console.error("Test email sending error:", error);
        res.status(500).json({ message: 'An internal server error occurred while trying to send the email.', details: error.message });
    }
});



// --- Server Initialization ---
const startServer = async () => {
    await initializeDbSchema();
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        if(dbInitializationError) console.error("DATABASE WARNING:", dbInitializationError);
        if(stripeInitializationError) console.error("STRIPE WARNING:", stripeInitializationError);
        if(aiInitializationError) console.error("AI WARNING:", aiInitializationError);
        if(mailerSendInitializationError) console.error("EMAIL WARNING:", mailerSendInitializationError);
    });
};

startServer();
