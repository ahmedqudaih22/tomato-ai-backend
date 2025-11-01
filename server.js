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
            slide1: { image: "https://i.ibb.co/V9Z2xN3/slide1.png", title_ar: "إنشاء صور بالذكاء الاصطناعي", title_en: "AI Image Generation", text_ar: "حوّل كلماتك إلى صور مذهلة. أطلق العنان لإبداعك.", text_en: "Turn your words into amazing images. Unleash your creativity." },
            slide2: { image: "https://i.ibb.co/gZk8zM4/slide2.png", title_ar: "تعديل احترافي للصور", title_en: "Professional Image Editing", text_ar: "صف التعديل الذي تريده، ودع الذكاء الاصطناعي يقوم بالباقي.", text_en: "Describe the edit you want, and let the AI do the rest." },
            slide3: { image: "https://i.ibb.co/c1xX6gQ/slide3.png", title_ar: "تعليق صوتي فوري", title_en: "Instant Voiceovers", text_ar: "حوّل أي نص إلى تعليق صوتي طبيعي بلهجات متعددة.", text_en: "Convert any text into a natural voiceover in multiple dialects." },
        },
        cta: {
            title_ar: "انضم إلى آلاف المبدعين",
            title_en: "Join Thousands of Creators",
            subtitle_ar: "أطلق العنان لإمكانياتك مع أدوات الذكاء الاصطناعي سهلة الاستخدام.",
            subtitle_en: "Unlock your potential with easy-to-use AI tools.",
            button_ar: "ابدأ مجانًا",
            button_en: "Start for Free"
        },
         benefits: {
            title_ar: "لماذا تختار Tomato AI؟",
            title_en: "Why Choose Tomato AI?",
            items: [
                { icon: "⚡️", title_ar: "نتائج فورية", title_en: "Instant Results", text_ar: "احصل على صور ومحتوى وصوت عالي الجودة في ثوانٍ.", text_en: "Get high-quality images, content, and audio in seconds." },
                { icon: "💡", title_ar: "سهولة الاستخدام", title_en: "Easy to Use", text_ar: "واجهة بسيطة وبديهية مصممة للجميع، لا تتطلب خبرة فنية.", text_en: "A simple and intuitive interface designed for everyone, no technical expertise required." },
                { icon: "💰", title_ar: "نظام نقاط مرن", title_en: "Flexible Points System", text_ar: "استخدم النقاط للوصول إلى الميزات المتقدمة أو اكسبها مجانًا.", text_en: "Use points to access premium features or earn them for free." },
                { icon: "🌍", title_ar: "دعم اللغة العربية", title_en: "Arabic Language Support", text_ar: "تجربة كاملة مصممة للمستخدمين العرب، من الواجهة إلى النتائج.", text_en: "A complete experience designed for Arab users, from the interface to the results." }
            ]
        },
        useCases: {
            title_ar: "مثالي لـ...",
            title_en: "Perfect For...",
            items: [
                { icon: "📈", title_ar: "المسوقين", title_en: "Marketers", text_ar: "أنشئ محتوى إعلاني جذاب وصورًا فريدة لحملاتك.", text_en: "Create engaging ad content and unique images for your campaigns." },
                { icon: "✍️", title_ar: "صناع المحتوى", title_en: "Content Creators", text_ar: "أعد صياغة المقالات، ولّد أفكارًا، وأضف تعليقات صوتية احترافية.", text_en: "Rewrite articles, generate ideas, and add professional voiceovers." },
                { icon: "🎨", title_ar: "المصممين", title_en: "Designers", text_ar: "احصل على الإلهام وأنشئ مفاهيم بصرية بسرعة مذهلة.", text_en: "Get inspiration and create visual concepts with incredible speed." },
                { icon: "🎓", title_ar: "الطلاب والباحثين", title_en: "Students & Researchers", text_ar: "لخص النصوص الطويلة وأعد صياغة الفقرات لتجنب الانتحال.", text_en: "Summarize long texts and rephrase paragraphs to avoid plagiarism." }
            ]
        },
        testimonials: {
            title_ar: "ماذا يقول المستخدمون عنا؟",
            title_en: "What Our Users Say",
            items: [
                { id: 1, quote_ar: "أداة مذهلة! ساعدتني في إنشاء صور لحملتي التسويقية بسرعة لا تصدق. النتائج كانت أفضل مما توقعت.", quote_en: "Amazing tool! It helped me create images for my marketing campaign with incredible speed. The results were better than I expected.", name_ar: "سارة عبدالله", name_en: "Sara Abdullah", role_ar: "مديرة تسويق", role_en: "Marketing Manager", avatarUrl: "https://randomuser.me/api/portraits/women/11.jpg" },
                { id: 2, quote_ar: "خاصية تحويل النص إلى صوت باللغة العربية رائعة. الأصوات طبيعية جدًا ومناسبة لمقاطع الفيديو الخاصة بي.", quote_en: "The text-to-speech feature in Arabic is fantastic. The voices are very natural and perfect for my videos.", name_ar: "أحمد المصري", name_en: "Ahmed Elmasry", role_ar: "صانع محتوى", role_en: "Content Creator", avatarUrl: "https://randomuser.me/api/portraits/men/22.jpg" }
            ]
        },
        faq: {
            title_ar: "الأسئلة الشائعة",
            title_en: "Frequently Asked Questions",
            items: [
                { id: 1, q_ar: "كيف أحصل على النقاط؟", q_en: "How do I get points?", a_ar: "يمكنك شراء النقاط مباشرة من المتجر، أو كسبها مجانًا من خلال المكافآت اليومية وبرنامج الإحالة.", a_en: "You can purchase points directly from the store, or earn them for free through daily rewards and the referral program." },
                { id: 2, q_ar: "هل يمكنني استخدام الصور التي أنشئها لأغراض تجارية؟", q_en: "Can I use the images I create for commercial purposes?", a_ar: "نعم، جميع الصور التي تنشئها بدون علامة مائية هي ملكك ولك كامل الحق في استخدامها لأي غرض، بما في ذلك الأغراض التجارية.", a_en: "Yes, all images you generate without a watermark are yours and you have full rights to use them for any purpose, including commercial." }
            ]
        },
        finalCta: {
            title_ar: "جاهز لتبدأ؟",
            title_en: "Ready to Get Started?",
            text_ar: "سجل الآن وابدأ في تحويل أفكارك إلى حقيقة.",
            text_en: "Sign up now and start turning your ideas into reality.",
            button_ar: "إنشاء حساب مجاني",
            button_en: "Create a Free Account"
        }
    },
    store: {
        packages: [
            { id: 1, points: 100, price: 5, stripePriceId: 'price_1PMEp5RxX3xWz2gL6k0F4zQf' },
            { id: 2, points: 250, price: 10, stripePriceId: 'price_1PMEqDRxX3xWz2gLwZ6yG3Hh' },
            { id: 3, points: 600, price: 20, stripePriceId: 'price_1PMEqlRxX3xWz2gL9c1c8D1J' },
            { id: 4, points: 2000, price: 50, stripePriceId: 'price_1PMErFRxX3xWz2gLo2H2O3p4' }
        ],
        subscriptions: []
    },
    announcement: {
        enabled: false,
        imageUrl: "https://example.com/image.png",
        contentEn: "<h3>Big News!</h3><p>We've just launched a new feature. Check it out now!</p>",
        contentAr: "<h3>خبر عاجل!</h3><p>لقد أطلقنا ميزة جديدة. تفقدها الآن!</p>",
        textColor: "#000000",
        fontSize: 16
    },
    maintenance: {
        enabled: false,
        message_en: "We are currently performing scheduled maintenance. We should be back online shortly. Thank you for your patience.",
        message_ar: "نقوم حاليًا بإجراء صيانة مجدولة. سنعود للعمل قريبًا. شكرًا لصبركم."
    }
};

const initializeDatabase = async () => {
    if (!pool) {
        console.warn('Database initialization skipped: pool is not available.');
        return;
    }
    console.log('Initializing database schema...');
    const client = await pool.connect();
    try {
        // Use CREATE TABLE IF NOT EXISTS to prevent errors on restart
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                points INTEGER DEFAULT 10,
                country VARCHAR(5),
                is_admin BOOLEAN DEFAULT FALSE,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP WITH TIME ZONE,
                referral_code VARCHAR(20) UNIQUE,
                referrer_id INTEGER,
                referrals INTEGER DEFAULT 0,
                last_daily_claim TIMESTAMP WITH TIME ZONE
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(255) PRIMARY KEY,
                value JSONB
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(50),
                prompt TEXT,
                result_url TEXT,
                cost INTEGER,
                date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS operations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) UNIQUE NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                result JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Check if default settings exist, if not, insert them
        const res = await client.query("SELECT * FROM settings WHERE key = 'app_settings'");
        if (res.rows.length === 0) {
            console.log('No settings found in DB, inserting defaults...');
            await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['app_settings', JSON.stringify(defaultSettings)]);
        } else {
             console.log('Settings already exist in DB.');
        }

        console.log('Database schema initialization complete.');
    } catch (err) {
        console.error('Database initialization failed:', err);
        // This is a critical error, the app might not function correctly
        dbInitializationError = `فشل في تهيئة مخطط قاعدة البيانات: ${err.message}`;
    } finally {
        client.release();
    }
};


// --- Helper Functions ---
const createToken = (userId) => {
    // This is a placeholder for a real JWT implementation
    return `token-for-user-${userId}-${Date.now()}`;
};

const getUserIdFromToken = async (token) => {
    // Placeholder for JWT verification
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7, token.length);
        const parts = token.split('-');
        const userId = parseInt(parts[3], 10);

        if (!isNaN(userId) && pool) {
            const client = await pool.connect();
            try {
                const res = await client.query('SELECT status FROM users WHERE id = $1', [userId]);
                if (res.rows.length > 0 && res.rows[0].status === 'active') {
                    return userId;
                }
            } finally {
                client.release();
            }
        }
    }
    return null;
};

const getSettings = async (client) => {
     try {
        const res = await client.query("SELECT value FROM settings WHERE key = 'app_settings'");
        if (res.rows.length > 0) {
            return res.rows[0].value;
        }
     } catch (e) {
         console.error("Error fetching settings, returning default. Error:", e);
         return defaultSettings;
     }
    return defaultSettings; // Fallback
};

const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }
    const userId = await getUserIdFromToken(token);
    if (!userId) {
        return res.status(401).json({ message: 'Invalid token' });
    }
    req.userId = userId;
    next();
};

const adminMiddleware = async (req, res, next) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });
    const client = await pool.connect();
    try {
        const userRes = await client.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
        if (userRes.rows.length === 0 || !userRes.rows[0].is_admin) {
            return res.status(403).json({ message: 'Admin access required' });
        }
        next();
    } catch (err) {
        res.status(500).json({ message: 'Error checking admin status' });
    } finally {
        client.release();
    }
};

// --- API Endpoints ---

// Registration
app.post('/api/register', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable for registration" });

    const { username, email, password, country, referralCode } = req.body;
    
    if (!username) {
        return res.status(400).json({ message: 'Username is required.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if email or username exists
        const emailExists = await client.query('SELECT id FROM users WHERE email = $1', [email]);
        if (emailExists.rows.length > 0) {
            return res.status(409).json({ message: 'Email already exists.' });
        }
        const usernameExists = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (usernameExists.rows.length > 0) {
            return res.status(409).json({ message: 'Username already exists.' });
        }
        
        let initialPoints = 10;
        let referrerId = null;

        // Handle referral logic
        if (referralCode) {
            const referrerResult = await client.query('SELECT id, points, referrals FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerResult.rows.length > 0) {
                const referrer = referrerResult.rows[0];
                referrerId = referrer.id;
                const referralBonus = (await getSettings(client)).costs.referralBonus || 50;
                
                await client.query('UPDATE users SET points = points + $1, referrals = COALESCE(referrals, 0) + 1 WHERE id = $2', [referralBonus, referrerId]);

                initialPoints += referralBonus;
            }
        }


        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        const newReferralCode = crypto.randomBytes(8).toString('hex');
        
        // Determine if this user should be an admin (first registered user)
        const userCountResult = await client.query('SELECT COUNT(*) FROM users');
        const isAdmin = parseInt(userCountResult.rows[0].count, 10) === 0;
        
        if(isAdmin) {
             initialPoints = 10000; // Give admin a lot of points
        }
        
        // Insert new user
        const insertUserQuery = 'INSERT INTO users (username, email, password_hash, country, is_admin, points, referral_code, referrer_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *';
        const insertUserValues = [username, email, hashedPassword, country, isAdmin, initialPoints, newReferralCode, referrerId];
        const newUserResult = await client.query(insertUserQuery, insertUserValues);
        const newUser = newUserResult.rows[0];

        await client.query('COMMIT');
        
        delete newUser.password_hash;
        const token = createToken(newUser.id);
        res.status(201).json({ user: newUser, token });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Registration error:', error);
        res.status(500).json({ message: 'An internal server error occurred during registration' });
    } finally {
        client.release();
    }
});

// Login
app.post('/api/login', async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });

    const { identifier, password } = req.body; // identifier can be email or username
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    const client = await pool.connect();
    try {
        const query = 'SELECT * FROM users WHERE (email = $1 OR username = $1) AND status = \'active\'';
        const result = await client.query(query, [identifier]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }

        const user = result.rows[0];
        if (user.password_hash !== hashedPassword) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }
        
        // Update last login timestamp
        await client.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        delete user.password_hash;
        const token = createToken(user.id);
        res.json({ user, token });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'An internal server error occurred' });
    } finally {
        client.release();
    }
});

// Get current user
app.get('/api/users/me', authMiddleware, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT id, username, email, points, country, is_admin, last_daily_claim, referral_code, referrals FROM users WHERE id = $1', [req.userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ message: 'An internal server error occurred' });
    } finally {
        client.release();
    }
});

// Update current user profile
app.put('/api/users/me', authMiddleware, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });
    const { email, password } = req.body;
    
    let query, values;
    if (password) {
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        query = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, username, email, points, country, is_admin';
        values = [email, hashedPassword, req.userId];
    } else {
        query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, username, email, points, country, is_admin';
        values = [email, req.userId];
    }
    
    const client = await pool.connect();
    try {
        const result = await client.query(query, values);
        res.json({ user: result.rows[0] });
    } catch (error) {
        console.error('Update user error:', error);
        if (error.code === '23505') { // Unique constraint violation
             return res.status(409).json({ message: 'Email is already in use by another account.' });
        }
        res.status(500).json({ message: 'An internal server error occurred' });
    } finally {
        client.release();
    }
});

// Daily Reward
app.post('/api/claim-daily-reward', authMiddleware, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const userRes = await client.query('SELECT last_daily_claim FROM users WHERE id = $1', [req.userId]);
        const lastClaim = userRes.rows[0].last_daily_claim;
        const now = new Date();

        if (lastClaim && (now.getTime() - new Date(lastClaim).getTime()) < 24 * 60 * 60 * 1000) {
            return res.status(429).json({ message: 'You have already claimed your daily reward in the last 24 hours.' });
        }
        
        const settings = await getSettings(client);
        const rewardPoints = settings.costs.dailyRewardPoints;

        const updateRes = await client.query(
            'UPDATE users SET points = points + $1, last_daily_claim = $2 WHERE id = $3 RETURNING id, username, email, points, country, is_admin, last_daily_claim, referral_code, referrals', 
            [rewardPoints, now, req.userId]
        );
        
        await client.query('COMMIT');
        res.json({ user: updateRes.rows[0], message: `You claimed ${rewardPoints} points!` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Daily reward error:", error);
        res.status(500).json({ message: "An error occurred while claiming the reward." });
    } finally {
        client.release();
    }
});


// Get operation history
app.get('/api/history', authMiddleware, async (req, res) => {
     if (!pool) return res.status(503).json({ message: "Database service unavailable" });
     const client = await pool.connect();
     try {
        const result = await client.query('SELECT * FROM history WHERE user_id = $1 ORDER BY date DESC', [req.userId]);
        res.json({ history: result.rows });
     } catch (error) {
        res.status(500).json({ message: 'Failed to fetch history' });
     } finally {
        client.release();
     }
});

// Add to history
app.post('/api/history', authMiddleware, async (req, res) => {
    if (!pool) return res.status(503).json({ message: "Database service unavailable" });
    const { type, prompt, resultUrl, cost } = req.body;
    const client = await pool.connect();
    try {
        await client.query(
            'INSERT INTO history (user_id, type, prompt, result_url, cost) VALUES ($1, $2, $3, $4, $5)',
            [req.userId, type, prompt, resultUrl, cost]
        );
        res.status(201).json({ message: 'History saved' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to save history' });
    } finally {
        client.release();
    }
});

// Get public settings
app.get('/api/settings', async (req, res) => {
    if (!pool) {
        return res.status(503).json({ 
            message: "Database service unavailable",
            settings: defaultSettings, // Send default settings so the frontend can at least render
        });
    }
    const client = await pool.connect();
    try {
        const settings = await getSettings(client);
        
        const token = req.headers.authorization;
        const userId = await getUserIdFromToken(token);
        let userIsAdmin = false;
        if (userId) {
            const userRes = await client.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) {
                userIsAdmin = userRes.rows[0].is_admin;
            }
        }

        if (settings.maintenance?.enabled && !userIsAdmin) {
            return res.status(503).json({
                message: settings.maintenance.message_en,
                settings: { 
                    theme: settings.theme,
                    maintenance: settings.maintenance
                }
            });
        }
        
        res.json(settings);
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ message: 'Could not fetch settings', settings: defaultSettings });
    } finally {
        client.release();
    }
});

// Update settings (Admin only)
app.post('/api/settings', authMiddleware, adminMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("UPDATE settings SET value = $1 WHERE key = 'app_settings'", [req.body.settings]);
        res.json({ message: 'Settings updated successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update settings' });
    } finally {
        client.release();
    }
});

// Get app config (for Stripe keys etc.)
app.get('/api/config', (req, res) => {
    res.json({
        stripePublicKey: process.env.STRIPE_PUBLIC_KEY,
    });
});

app.get('/api/status', (req, res) => {
    const ai_enabled = !aiInitializationError && !!ai;
    const email_enabled = !mailerSendInitializationError;

    res.json({
        db_enabled: !dbInitializationError,
        stripe_enabled: !stripeInitializationError,
        ai_enabled: ai_enabled,
        email_enabled: email_enabled,
        message: ai_enabled ? "Operational" : aiInitializationError,
        message_ar: ai_enabled ? "فعّال" : "خدمات الذكاء الاصطناعي معطلة: تحقق من مفتاح الواجهة البرمجية (API Key).",
        email_message: email_enabled ? "Operational" : mailerSendInitializationError,
        email_message_ar: email_enabled ? "فعّال" : "خدمة البريد الإلكتروني معطلة: تحقق من إعدادات MailerSend.",
    });
});

// Stripe Checkout
app.post('/api/create-checkout-session', authMiddleware, async (req, res) => {
    if (!stripe) {
        return res.status(503).json({ message: "Payment service is not available." });
    }
    const { packageId } = req.body;
    
    const client = await pool.connect();
    try {
        const settings = await getSettings(client);
        const pkg = settings.store.packages.find(p => p.id == packageId);

        if (!pkg) {
            return res.status(404).json({ message: 'Package not found' });
        }
        
        const userRes = await client.query('SELECT email FROM users WHERE id = $1', [req.userId]);
        const userEmail = userRes.rows[0].email;
        
        const successUrl = `${process.env.FRONTEND_URL || 'http://localhost:8080'}?payment_success=true`;
        const cancelUrl = `${process.env.FRONTEND_URL || 'http://localhost:8080'}?payment_cancelled=true`;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: pkg.stripePriceId,
                quantity: 1,
            }],
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_email: userEmail,
            metadata: {
                userId: req.userId,
                packageId: pkg.id,
                points: pkg.points
            }
        });

        res.json({ url: session.url });

    } catch (error) {
        console.error("Stripe session error:", error);
        res.status(500).json({ message: 'Failed to create checkout session' });
    } finally {
        client.release();
    }
});


// Stripe Webhook
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { userId, points } = session.metadata;

        if (userId && points) {
            const client = await pool.connect();
            try {
                await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [parseInt(points), parseInt(userId)]);
                console.log(`User ${userId} was credited ${points} points.`);
            } catch (err) {
                console.error('Failed to update user points after payment:', err);
            } finally {
                client.release();
            }
        }
    }
    res.json({ received: true });
});


// Proxy for AI Generation
app.post('/api/ai/generate', authMiddleware, async (req, res) => {
    if (!ai) {
        return res.status(503).json({ message: "AI service is not available." });
    }
    
    const { payload, removeWatermark } = req.body;
    let cost = 0;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const settings = await getSettings(client);
        
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
        
        // Deduct points
        const userRes = await client.query('SELECT points FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
        if (userRes.rows[0].points < cost) {
            return res.status(402).json({ message: 'Insufficient points' });
        }
        const updatedUserRes = await client.query('UPDATE users SET points = points - $1 WHERE id = $2 RETURNING *', [cost, req.userId]);
        
        let aiResult;
        
        if (payload.type === 'generateImages') {
            const response = await ai.models.generateImages({ model: payload.model, prompt: payload.prompt, config: payload.config });
            aiResult = { dataUrl: `data:image/png;base64,${response.generatedImages[0].image.imageBytes}` };
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-image') {
            const response = await ai.models.generateContent(payload);
            const part = response.candidates[0].content.parts.find(p => p.inlineData);
            aiResult = { dataUrl: `data:image/png;base64,${part.inlineData.data}` };
        } else if (payload.type === 'generateContent' && payload.model === 'gemini-2.5-flash-preview-tts') {
            const response = await ai.models.generateContent(payload);
            const part = response.candidates[0].content.parts.find(p => p.inlineData);
            aiResult = { base64Audio: part.inlineData.data };
        } else if (payload.type === 'rewrite') {
             const systemInstruction = {
                'simplify': "You are an expert content editor. Rewrite the following text to make it simpler and easier to understand, as if explaining it to a high school student. Maintain the core message.",
                'summarize': "You are a skilled summarizer. Condense the following text into its most essential points. The result should be significantly shorter but capture the main idea.",
                'expand': "You are a creative writer. Expand on the following text, adding more detail, examples, and descriptive language to make it longer and more comprehensive.",
                'professional': "You are a professional business writer. Rewrite the following text in a formal, corporate tone. Use professional vocabulary and a structured format.",
                'points': "You are a content organizer. Convert the main ideas of the following text into a clear, concise bulleted list. Each point should be easy to scan."
            }[payload.style];
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: payload.text,
                config: { systemInstruction: systemInstruction }
            });
            aiResult = { text: response.text };

        } else if (payload.type === 'generate-tweets') {
             const prompt = `Based on the topic "${payload.idea}", generate 3-5 engaging and distinct tweets. Each tweet should be concise, include relevant hashtags, and have a different angle (e.g., a question, a surprising fact, a call to action). Format the output clearly, separating each tweet.`;
              const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
              });
             aiResult = { text: response.text };
        }
        
        await client.query('COMMIT');
        const updatedUser = updatedUserRes.rows[0];
        delete updatedUser.password_hash;
        res.json({ result: aiResult, user: updatedUser });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('AI Generation Proxy Error:', error);
        res.status(500).json({ message: error.message || 'An error occurred during AI generation.' });
    } finally {
        client.release();
    }
});

// Admin get all users
app.get('/api/admin/users', authMiddleware, adminMiddleware, async(req, res) => {
     const client = await pool.connect();
     try {
         const result = await client.query('SELECT id, username, email, points, country, status, is_admin, created_at FROM users ORDER BY created_at DESC');
         res.json({ users: result.rows });
     } catch (e) {
         res.status(500).json({ message: 'Failed to fetch users' });
     } finally {
         client.release();
     }
});

// Admin update user
app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, async(req, res) => {
    const { id } = req.params;
    const { points, status } = req.body;
    const client = await pool.connect();
    try {
        const result = await client.query(
            'UPDATE users SET points = $1, status = $2 WHERE id = $3 RETURNING id, username, email, points, country, status, is_admin, created_at',
            [points, status, id]
        );
        res.json({ user: result.rows[0] });
    } catch(e) {
        res.status(500).json({ message: 'Failed to update user'});
    } finally {
        client.release();
    }
});

// Admin Stats
app.get('/api/stats', authMiddleware, adminMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const usersCount = await client.query('SELECT COUNT(*) FROM users');
        const operationsCount = await client.query('SELECT COUNT(*) FROM history');
        const totalReferrals = await client.query('SELECT SUM(referrals) FROM users WHERE referrals IS NOT NULL');

        res.json({
            users: parseInt(usersCount.rows[0].count, 10),
            operations: parseInt(operationsCount.rows[0].count, 10),
            referrals: parseInt(totalReferrals.rows[0].sum, 10) || 0,
            visitors: 0, // This would require a more complex tracking mechanism
        });
    } catch (e) {
        res.status(500).json({ message: 'Failed to get stats' });
    } finally {
        client.release();
    }
});


// --- Server Startup ---
const startServer = async () => {
    await initializeDatabase();
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        if(dbInitializationError) console.error("SERVER IS RUNNING WITH DATABASE ERRORS.");
        if(stripeInitializationError) console.error("SERVER IS RUNNING WITH STRIPE ERRORS.");
        if(aiInitializationError) console.error("SERVER IS RUNNING WITH AI ERRORS.");
        if(mailerSendInitializationError) console.error("SERVER IS RUNNING WITH MAILERSEND ERRORS.");
    });
};

startServer();
