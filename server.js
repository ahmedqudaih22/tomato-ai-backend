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
                { id: 1, quote_ar: "أداة مذهلة! ساعدتني في إنشاء صور لحملتي التسويقية بسرعة لا تصدق. النتائج كانت أفضل مما توقعت.", quote_en: "Amazing tool! It helped me create images for my marketing campaign with incredible speed. The results were better than I expected.", name_ar: "سارة عبدالله", name_en: "Sara Abdullah", role_ar: "مديرة تسويق", role_en: "Marketing Manager", avatarUrl: "https://i.ibb.co/GvxB34T/avatar1.jpg" },
                { id: 2, quote_ar: "خدمة تحويل النص إلى صوت هي الأفضل التي جربتها، خاصة باللهجة الخليجية. الصوت طبيعي جدًا.", quote_en: "The text-to-speech service is the best I've tried, especially the Gulf dialect. The voice is very natural.", name_ar: "محمد الغامدي", name_en: "Mohammed Al-Ghamdi", role_ar: "صانع محتوى", role_en: "Content Creator", avatarUrl: "https://i.ibb.co/yqgR2s7/avatar2.jpg" },
                { id: 3, quote_ar: "كمصمم، أستخدم مولد الصور يوميًا للحصول على الإلهام. إنه يوفر عليّ ساعات من البحث.", quote_en: "As a designer, I use the image generator daily for inspiration. It saves me hours of searching.", name_ar: "خالد المصري", name_en: "Khaled El-Masry", role_ar: "مصمم جرافيك", role_en: "Graphic Designer", avatarUrl: "https://i.ibb.co/qD2v4T3/avatar3.jpg" },
                { id: 4, quote_ar: "واجهة سهلة وبسيطة، ونظام النقاط واضح وعادل. أحببت التجربة وسأستمر في استخدامها.", quote_en: "Easy and simple interface, and the points system is clear and fair. I loved the experience and will continue to use it.", name_ar: "فاطمة علي", name_en: "Fatima Ali", role_ar: "مدونة", role_en: "Blogger", avatarUrl: "https://i.ibb.co/N1Xq3t3/avatar4.jpg" },
                { id: 5, quote_ar: "أداة إعادة الصياغة ممتازة للطلاب. ساعدتني في تحسين كتاباتي الأكاديمية بشكل كبير.", quote_en: "The rewriting tool is excellent for students. It has significantly helped me improve my academic writing.", name_ar: "عمر الشريف", name_en: "Omar Sharif", role_ar: "طالب جامعي", role_en: "University Student", avatarUrl: "https://i.ibb.co/9h7r2Tf/avatar5.jpg" },
                { id: 6, quote_ar: "كنت مترددًا في البداية، لكن جودة الصور التي تم إنشاؤها أبهرتني. خدمة عملاء سريعة ومتعاونة أيضًا.", quote_en: "I was hesitant at first, but the quality of the generated images amazed me. The customer service is also fast and helpful.", name_ar: "ليلى الخوري", name_en: "Layla El Khoury", role_ar: "مصورة فوتوغرافية", role_en: "Photographer", avatarUrl: "https://i.ibb.co/gDFtNmd/avatar6.jpg" },
                { id: 7, quote_ar: "أفضل استثمار قمت به لعملي. يوفر الوقت والجهد ويقدم نتائج احترافية لا مثيل لها.", quote_en: "The best investment I've made for my business. It saves time, effort, and delivers unparalleled professional results.", name_ar: "يوسف منصور", name_en: "Youssef Mansour", role_ar: "رائد أعمال", role_en: "Entrepreneur", avatarUrl: "https://i.ibb.co/SNk3zS1/avatar7.jpg" },
                { id: 8, quote_ar: "أدير متجرًا صغيرًا، وهذه الأداة هي منقذي لإنشاء منشورات وسائل التواصل الاجتماعي. مولد التغريدات عبقري!", quote_en: "I run a small shop, and this tool is my savior for creating social media posts. The tweet generator is genius!", name_ar: "نادية حسن", name_en: "Nadia Hassan", role_ar: "صاحبة متجر", role_en: "Shop Owner", avatarUrl: "https://i.ibb.co/8mr1f81/avatar8.jpg" },
                { id: 9, quote_ar: "أستخدم ميزة تحويل النص إلى صوت لإنشاء مواد تعليمية لطلابي. اللهجات المختلفة تجعل المحتوى أكثر جاذبية.", quote_en: "I use the text-to-speech feature to create educational materials for my students. The different dialects make the content much more engaging.", name_ar: "أحمد إبراهيم", name_en: "Ahmed Ibrahim", role_ar: "مدرس", role_en: "Teacher", avatarUrl: "https://i.ibb.co/9vVzqB3/avatar9.jpg" },
                { id: 10, quote_ar: "كمطور، أنا معجب جدًا بمدى سلاسة كل شيء. من الواضح أن هناك الكثير من العمل الجيد وراء هذا المشروع.", quote_en: "As a developer, I'm very impressed with how smoothly everything runs. It's clear a lot of good work went into this project.", name_ar: "زينب مراد", name_en: "Zainab Murad", role_ar: "مطور برامج", role_en: "Software Developer", avatarUrl: "https://i.ibb.co/J3BzkzM/avatar10.jpg" }
            ]
        },
        faq: {
            title_ar: "أسئلة شائعة",
            title_en: "Frequently Asked Questions",
            items: [
                { id: 1, q_ar: "كيف أحصل على النقاط؟", q_en: "How do I get points?", a_ar: "يمكنك شراء النقاط من المتجر، أو الحصول عليها مجانًا من خلال المكافأة اليومية ودعوة الأصدقاء.", a_en: "You can buy points from the store, or get them for free through the daily reward and by inviting friends." },
                { id: 2, q_ar: "هل يمكنني استخدام الصور التي أنشئها لأغراض تجارية؟", q_en: "Can I use the images I create for commercial purposes?", a_ar: "نعم، جميع الصور التي تنشئها بدون علامة مائية هي ملكك ولك الحرية في استخدامها لأي غرض، بما في ذلك الأغراض التجارية.", a_en: "Yes, all images you create without a watermark are yours to use for any purpose, including commercial use." },
                { id: 3, q_ar: "ما هي اللغات واللهجات المتاحة لتحويل النص إلى صوت؟", q_en: "What languages and dialects are available for text-to-speech?", a_ar: "نحن ندعم اللغة العربية الفصحى ومجموعة متنوعة من اللهجات العربية الشائعة مثل الخليجية والمصرية والشامية.", a_en: "We support Standard Arabic and a variety of common Arabic dialects such as Gulf, Egyptian, and Levantine." },
                { id: 4, q_ar: "هل بياناتي آمنة؟", q_en: "Is my data secure?", a_ar: "نعم، نحن نأخذ خصوصيتك على محمل الجد. يتم تأمين جميع الاتصالات وتشفير بياناتك الحساسة. نحن لا نشارك بياناتك مع أي طرف ثالث.", a_en: "Yes, we take your privacy very seriously. All communications are secured and your sensitive data is encrypted. We do not share your data with any third parties." }
            ]
        },
        finalCta: {
            title_ar: "هل أنت مستعد للبدء؟",
            title_en: "Ready to Get Started?",
            text_ar: "أنشئ حسابك المجاني اليوم وابدأ في تحويل أفكارك إلى حقيقة.",
            text_en: "Create your free account today and start turning your ideas into reality.",
            button_ar: "أنشئ حسابك الآن",
            button_en: "Create Your Account Now"
        }
    },
    store: {
        packages: [
            { id: 1, points: 100, price: 5 },
            { id: 2, points: 250, price: 10 },
            { id: 3, points: 700, price: 25 },
            { id: 4, points: 1500, price: 50 },
        ]
    },
    announcement: {
        enabled: false,
        imageUrl: "",
        contentAr: "<strong>عرض خاص!</strong> احصل على خصم 50% على جميع باقات النقاط لمدة 48 ساعة فقط!",
        contentEn: "<strong>Special Offer!</strong> Get a 50% discount on all point packages for 48 hours only!",
        textColor: "#000000",
        fontSize: 16
    },
     maintenance: {
        enabled: false,
        message_en: "We are currently performing scheduled maintenance. We should be back online shortly. Thank you for your patience!",
        message_ar: "نقوم حاليًا بإجراء صيانة مجدولة. سنعود للعمل قريبًا. شكرًا لصبركم!"
    }
};

let currentSettings = null;

// --- Helper Functions ---

/**
 * Checks if an item is a non-array object.
 * @param item The item to check.
 * @returns True if the item is an object, false otherwise.
 */
const isObject = (item) => {
    return (item && typeof item === 'object' && !Array.isArray(item));
};

/**
 * Deeply merges a source object into a target object, ensuring no default values are lost.
 * @param defaults The default object structure.
 * @param overrides The object with potential overrides from the database.
 * @returns The safely merged object.
 */
const deepMerge = (defaults, overrides) => {
  const merged = { ...defaults };
  for (const key in overrides) {
    if (overrides.hasOwnProperty(key)) {
      if (isObject(overrides[key]) && isObject(merged[key])) {
        merged[key] = deepMerge(merged[key], overrides[key]);
      } else {
        merged[key] = overrides[key];
      }
    }
  }
  return merged;
};

const fetchSettingsFromDB = async () => {
    if (!pool) return defaultSettings;
    try {
        const result = await pool.query('SELECT settings_json FROM settings WHERE id = 1');
        if (result.rows.length > 0 && result.rows[0].settings_json) {
            const dbSettings = result.rows[0].settings_json;
            // Deep merge to ensure defaults are kept for missing nested properties (like image URLs)
            const mergedSettings = deepMerge(defaultSettings, dbSettings);
            return mergedSettings;
        } else {
            // No settings found or it's null, insert defaults
            await pool.query('INSERT INTO settings (id, settings_json) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings_json = $1', [JSON.stringify(defaultSettings)]);
            return defaultSettings;
        }
    } catch (error) {
        console.error("Database error fetching settings:", error);
        return defaultSettings; // Fallback to defaults on error
    }
};

const sanitizeUser = (user) => {
    if (!user) return null;
    const { password_hash, ...sanitized } = user;
    return sanitized;
};

// --- Middleware for Authentication ---

const authenticate = async (req, res, next) => {
    if (!pool) return res.status(503).json({ message: 'Database service is not available.' });
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    try {
        const result = await pool.query('SELECT * FROM users WHERE auth_token = $1', [token]);
        if (result.rows.length === 0) return res.sendStatus(403);
        req.user = result.rows[0];
        next();
    } catch (error) {
        res.status(500).json({ message: 'Database error during authentication' });
    }
};

const requireAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ message: 'Administrator access required.' });
    }
    next();
};

const maintenanceCheck = (req, res, next) => {
    if (currentSettings && currentSettings.maintenance && currentSettings.maintenance.enabled) {
        if (!pool) {
             return res.status(503).json({ 
                message: 'Service Unavailable - Maintenance Mode',
                settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
            });
        }
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            pool.query('SELECT is_admin FROM users WHERE auth_token = $1', [token])
                .then(result => {
                    if (result.rows.length > 0 && result.rows[0].is_admin) {
                        return next();
                    } else {
                        return res.status(503).json({ 
                            message: 'Service Unavailable - Maintenance Mode',
                            settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
                        });
                    }
                })
                .catch(() => {
                    return res.status(503).json({ 
                        message: 'Service Unavailable - Maintenance Mode',
                        settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
                    });
                });
        } else {
            return res.status(503).json({ 
                message: 'Service Unavailable - Maintenance Mode',
                settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
            });
        }
    } else {
        next();
    }
};

// --- API Routes ---

app.get('/api/config', (req, res) => {
    res.json({
        stripe_pk: process.env.STRIPE_PUBLISHABLE_KEY || null,
    });
});

app.get('/api/settings', maintenanceCheck, (req, res) => {
    if (currentSettings) {
        res.json(currentSettings);
    } else {
        res.status(500).json({ message: "Settings not loaded" });
    }
});

app.get('/api/status', maintenanceCheck, (req, res) => {
    res.json({
        ai_enabled: !!ai,
        message: aiInitializationError || "AI services are fully operational.",
        message_ar: aiInitializationError || "خدمات الذكاء الاصطناعي تعمل بكامل طاقتها.",
        email_enabled: !!(MAILERSEND_API_TOKEN && MAILERSEND_SENDER_EMAIL),
        email_message: mailerSendInitializationError || "Email services are fully operational.",
        email_message_ar: mailerSendInitializationError || "خدمات البريد الإلكتروني تعمل بكامل طاقتها."
    });
});

// Auth Routes
app.post('/api/register', maintenanceCheck, async (req, res) => {
    if (!pool) return res.status(503).json({ message: 'Database service is not available.' });
    const { username, email, password, country, referralCode } = req.body;
    
    if (!username || !email || !password || !country) {
        return res.status(400).json({ message: 'All fields are required.' });
    }

    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $2', [email.toLowerCase(), username.toLowerCase()]);
        if (existingUser.rows.length > 0) {
            const isEmail = existingUser.rows.find(u => u.email === email.toLowerCase());
            return res.status(409).json({ message: isEmail ? 'Email already exists.' : 'Username already exists.' });
        }
        
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        const passwordHash = `${salt}:${hash}`;
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if there are any users in the database to determine if this is the first user.
            const userCountResult = await client.query('SELECT COUNT(*) FROM users');
            const isFirstUser = parseInt(userCountResult.rows[0].count, 10) === 0;

            let referrerId = null;
            const bonusPoints = (currentSettings.costs && currentSettings.costs.referralBonus) || 50;
            if (referralCode) {
                const referrerResult = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
                if (referrerResult.rows.length > 0) {
                    referrerId = referrerResult.rows[0].id;
                }
            }
            
            // If it's the first user, make them admin and give them points. Otherwise, apply referral logic.
            const isAdmin = isFirstUser;
            const initialPoints = isFirstUser ? 9999 : (referrerId ? bonusPoints : 0);
            
            const newReferralCode = crypto.randomBytes(4).toString('hex');
            const newUserQuery = `
                INSERT INTO users (username, email, password_hash, country, points, is_admin, referral_code, referrer_id, status) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active') 
                RETURNING *`;

            const newUserResult = await client.query(newUserQuery, [
                username, email.toLowerCase(), passwordHash, country, initialPoints, isAdmin, newReferralCode, referrerId
            ]);
            const newUser = newUserResult.rows[0];

            if (referrerId && !isFirstUser) {
                await client.query('UPDATE users SET points = points + $1, referrals = referrals + 1 WHERE id = $2', [bonusPoints, referrerId]);
            }
            
            const token = crypto.randomBytes(32).toString('hex');
            await client.query('UPDATE users SET auth_token = $1 WHERE id = $2', [token, newUser.id]);

            await client.query('COMMIT');
            
            const userForResponse = { ...newUser, auth_token: token };
            res.status(201).json({ token, user: sanitizeUser(userForResponse) });

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: 'An internal server error occurred during registration.' });
    }
});

app.post('/api/login', maintenanceCheck, async (req, res) => {
    if (!pool) return res.status(503).json({ message: 'Database service is not available.' });
    const { identifier, password } = req.body;

    try {
        // Step 1: Find user by email or username, regardless of status
        const result = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $1', [identifier.toLowerCase()]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }

        const user = result.rows[0];
        
        // Safety check for password hash format
        if (!user.password_hash || !user.password_hash.includes(':')) {
            console.error(`Invalid password hash format for user: ${user.id}`);
            return res.status(500).json({ message: 'An internal server error occurred.' });
        }

        // Step 2: Verify password
        const [salt, storedHash] = user.password_hash.split(':');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');

        if (hash !== storedHash) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }

        // Step 3: Check status, but bypass for admins
        if (user.status === 'banned' && !user.is_admin) {
            return res.status(403).json({ message: 'This account has been banned.' });
        }
        
        // Step 4: Login success - generate token and send response
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query('UPDATE users SET auth_token = $1, last_login = NOW() WHERE id = $2', [token, user.id]);
        
        const updatedUser = { ...user, auth_token: token };
        res.json({ token, user: sanitizeUser(updatedUser) });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});


app.get('/api/users/me', authenticate, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
});

app.put('/api/users/me', authenticate, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.user.id;
    
    let query = 'UPDATE users SET email = $1';
    const values = [email, userId];
    
    if (password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        const passwordHash = `${salt}:${hash}`;
        query += ', password_hash = $3 WHERE id = $2 RETURNING *';
        values.splice(2, 0, passwordHash);
    } else {
        query += ' WHERE id = $2 RETURNING *';
    }

    try {
        const result = await pool.query(query, values);
        res.json({ user: sanitizeUser(result.rows[0]) });
    } catch (error) {
        console.error("Profile update error:", error);
        res.status(500).json({ message: "Failed to update profile." });
    }
});


// History Routes
app.get('/api/history', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM history WHERE user_id = $1 ORDER BY date DESC LIMIT 50', [req.user.id]);
        res.json({ history: result.rows });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch history.' });
    }
});

app.post('/api/history', authenticate, async (req, res) => {
    const { type, prompt, resultUrl, cost } = req.body;
    try {
        await pool.query('INSERT INTO history (user_id, type, prompt, result_url, cost) VALUES ($1, $2, $3, $4, $5)', [req.user.id, type, prompt, resultUrl, cost]);
        res.sendStatus(201);
    } catch (error) {
        res.status(500).json({ message: 'Failed to save history item.' });
    }
});

// Points & Rewards Routes
app.post('/api/claim-daily-reward', authenticate, async (req, res) => {
    const userId = req.user.id;
    const lastClaim = req.user.last_daily_claim ? new Date(req.user.last_daily_claim).getTime() : 0;
    const now = new Date().getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (now - lastClaim < twentyFourHours) {
        return res.status(429).json({ message: 'You have already claimed your daily reward.' });
    }
    
    try {
        const rewardPoints = (currentSettings.costs && currentSettings.costs.dailyRewardPoints) || 10;
        const result = await pool.query(
            'UPDATE users SET points = points + $1, last_daily_claim = NOW() WHERE id = $2 RETURNING *',
            [rewardPoints, userId]
        );
        res.json({ user: sanitizeUser(result.rows[0]) });
    } catch (error) {
        res.status(500).json({ message: 'Failed to claim reward.' });
    }
});

// --- AI Generation Proxy ---
app.post('/api/ai/generate', authenticate, async (req, res) => {
    if (!ai) {
        return res.status(503).json({ message: aiInitializationError });
    }

    const { payload } = req.body;
    const user = req.user;
    
    let cost = 0;
    try {
        switch (payload.type) {
            case 'generateImages':
                cost = req.body.removeWatermark ? (currentSettings.costs.imageCreate_noWatermark ?? 15) : (currentSettings.costs.imageCreate ?? 5);
                break;
            case 'generateContent':
                if (payload.model === 'gemini-2.5-flash-image') {
                    cost = req.body.removeWatermark ? (currentSettings.costs.imageEdit_noWatermark ?? 8) : (currentSettings.costs.imageEdit ?? 2);
                } else if (payload.model === 'gemini-2.5-flash-preview-tts') {
                    const textLength = payload.contents[0]?.parts[0]?.text?.length || 0;
                    cost = Math.ceil(textLength / 100) * (currentSettings.costs.textToSpeech ?? 1);
                }
                break;
            case 'rewrite':
                 cost = currentSettings.costs.contentRewrite ?? 1;
                 break;
            case 'generate-tweets':
                 cost = currentSettings.costs.tweetGenerator ?? 1;
                 break;
        }
    } catch (e) {
        return res.status(400).json({ message: 'Invalid AI operation type or model for cost calculation.' });
    }


    if (cost > 0 && user.points < cost) {
        return res.status(402).json({ message: 'Insufficient points.' });
    }

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const updatedUserResult = await client.query(
                'UPDATE users SET points = points - $1 WHERE id = $2 RETURNING *',
                [cost, user.id]
            );
            const updatedUser = sanitizeUser(updatedUserResult.rows[0]);
            
            await client.query(
                'INSERT INTO operations (user_id, type, cost) VALUES ($1, $2, $3)',
                [user.id, payload.type, cost]
            );

            // Fix: Destructure `payload` to remove the internal `type` property before sending to the Gemini API.
            const { type, ...apiPayload } = payload;
            let result;
            if (type === 'generateImages') {
                const response = await ai.models.generateImages(apiPayload);
                const base64Image = response.generatedImages[0].image.imageBytes;
                result = { dataUrl: `data:image/png;base64,${base64Image}` };
            } else if (type === 'generateContent') {
                const response = await ai.models.generateContent(apiPayload);
                if (apiPayload.model === 'gemini-2.5-flash-image') {
                    const part = response.candidates[0].content.parts.find(p => p.inlineData);
                    result = { dataUrl: `data:image/png;base64,${part.inlineData.data}` };
                } else if (apiPayload.model === 'gemini-2.5-flash-preview-tts') {
                    const part = response.candidates[0].content.parts.find(p => p.inlineData);
                    result = { base64Audio: part.inlineData.data };
                }
            } else if (type === 'rewrite') {
                 const styleInstruction = {
                    professional: 'Rewrite the following text in a professional and formal tone.',
                    simplify: 'Rewrite the following text to make it simpler and easier to understand.',
                    summarize: 'Summarize the key points of the following text concisely.',
                    expand: 'Expand on the following text, adding more detail and explanation.',
                    points: 'Convert the main ideas of the following text into a bulleted list.'
                };
                const prompt = `${styleInstruction[payload.style] || 'Rewrite the following text:'}\n\n---\n\n${payload.text}`;
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                });
                result = { text: response.text };

            } else if (type === 'generate-tweets') {
                const prompt = `Generate 3-5 engaging and creative tweets based on the following topic or idea. Use relevant hashtags. The tweets should be ready to post.\n\nTopic: "${payload.idea}"`;
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                });
                result = { text: response.text };
            }

            await client.query('COMMIT');
            res.json({ result, user: updatedUser });

        } catch (e) {
            await client.query('ROLLBACK');
            throw e; 
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("AI Generation Error:", error);
        res.status(500).json({ message: `AI generation failed: ${error.message}` });
    }
});

app.post('/api/ai/remove-background', authenticate, async (req, res) => {
    if (!ai) return res.status(503).json({ message: aiInitializationError });
    
    const { imagePart, textPart } = req.body;
    try {
        const payload = {
            model: 'gemini-2.5-flash-image',
            contents: { parts: [imagePart, textPart] },
            config: { responseModalities: ['IMAGE'] },
        };
        const response = await ai.models.generateContent(payload);
        const part = response.candidates[0].content.parts.find(p => p.inlineData);
        const dataUrl = `data:image/png;base64,${part.inlineData.data}`;
        res.json({ dataUrl });
    } catch(error) {
        console.error("BG Removal Error:", error);
        res.status(500).json({ message: 'Background removal failed.' });
    }
});

// --- Stripe & Store Routes ---
app.post('/api/create-checkout-session', authenticate, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: stripeInitializationError });

    const { packageId } = req.body;
    const userId = req.user.id;
    
    const pkg = currentSettings.store.packages.find(p => p.id === packageId);
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
                        description: `Get ${pkg.points.toLocaleString()} points for Tomato AI`,
                    },
                    unit_amount: pkg.price * 100, // Price in cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}?payment_success=true`,
            cancel_url: `${process.env.FRONTEND_URL}?payment_cancelled=true`,
            metadata: {
                userId: userId,
                points: pkg.points
            }
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe session error:", error);
        res.status(500).json({ message: 'Failed to create payment session.' });
    }
});

app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    if (!stripe) return res.status(503).json({ message: stripeInitializationError });
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed:`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { userId, points } = session.metadata;

        if (!pool) {
            console.error("CRITICAL: Stripe webhook received but database is not available. User points not awarded.");
            return res.status(500).send('Internal Server Error: Database unavailable.');
        }

        try {
            await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [Number(points), Number(userId)]);
            console.log(`Successfully awarded ${points} to user ${userId}.`);
        } catch (dbError) {
            console.error(`Failed to update points for user ${userId}:`, dbError);
        }
    }

    res.json({received: true});
});


// --- Admin Routes ---

app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, email, country, points, status, is_admin FROM users ORDER BY id ASC');
        res.json({ users: result.rows });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch users.' });
    }
});

app.put('/api/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { points, status } = req.body;

    try {
        // Prevent changing status of an admin
        const targetUser = await pool.query('SELECT is_admin FROM users WHERE id = $1', [id]);
        if (targetUser.rows.length > 0 && targetUser.rows[0].is_admin && req.user.id.toString() !== id) {
             if (status && status !== 'active') { // Admins can't ban other admins for safety
                return res.status(403).json({ message: 'Cannot change the status of an administrator account.' });
             }
        }

        const result = await pool.query(
            'UPDATE users SET points = points + $1, status = $2 WHERE id = $3 RETURNING *',
            [points, status, id]
        );
        res.json({ user: sanitizeUser(result.rows[0]) });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update user.' });
    }
});

app.put('/api/admin/settings', authenticate, requireAdmin, async (req, res) => {
    const newSettings = req.body;
    try {
        await pool.query('UPDATE settings SET settings_json = $1 WHERE id = 1', [newSettings]);
        currentSettings = newSettings;
        res.json({ message: 'Settings updated successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to save settings.' });
    }
});

app.get('/api/stats', authenticate, requireAdmin, async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const operationsCount = await pool.query('SELECT COUNT(*) FROM operations');
        const referralsCount = await pool.query('SELECT SUM(referrals) FROM users');

        res.json({
            users: parseInt(usersCount.rows[0].count) || 0,
            operations: parseInt(operationsCount.rows[0].count) || 0,
            referrals: parseInt(referralsCount.rows[0].sum) || 0,
            visitors: parseInt(usersCount.rows[0].count) || 0, // Approximating visitors with user count
        });
    } catch (error) {
        console.error("Stats Error:", error);
        res.status(500).json({ message: 'Failed to get statistics.' });
    }
});

app.post('/api/admin/test-email', authenticate, requireAdmin, async (req, res) => {
    if (!MAILERSEND_API_TOKEN || !MAILERSEND_SENDER_EMAIL) {
        return res.status(503).json({ message: mailerSendInitializationError });
    }
    const { testEmail } = req.body;
    
    try {
        const response = await fetch('https://api.mailersend.com/v1/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MAILERSEND_API_TOKEN}`,
            },
            body: JSON.stringify({
                from: { email: MAILERSEND_SENDER_EMAIL, name: 'Tomato AI Test' },
                to: [{ email: testEmail }],
                subject: 'Tomato AI - Test Email',
                text: 'This is a test email from your Tomato AI application. If you received this, your email configuration is working!',
                html: '<p>This is a test email from your Tomato AI application. If you received this, your email configuration is working!</p>',
            }),
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({ message: `MailerSend API returned status ${response.status}` }));
            throw { message: 'Failed to send test email via MailerSend.', details: errorBody };
        }
        
        res.json({ message: 'Test email sent successfully!', details: { to: testEmail, from: MAILERSEND_SENDER_EMAIL } });

    } catch (error) {
        console.error('MailerSend Error:', error);
        res.status(500).json({ message: error.message || 'An internal error occurred.', details: error.details || null });
    }
});

// --- Server Startup ---
const startServer = async () => {
    if (pool) {
        try {
            // User requested a definite wipe of all user data to solve login issues.
            console.log("Wiping all user-related data as requested...");
            // Using TRUNCATE with CASCADE to ensure all related data is cleared and sequences are reset.
            await pool.query('TRUNCATE TABLE users, history, operations RESTART IDENTITY CASCADE');
            console.log("All user, history, and operations data has been cleared.");

            // Force reset settings to default on every startup to fulfill user request
            console.log("Attempting to reset application settings to default...");
            await pool.query(
                'INSERT INTO settings (id, settings_json) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings_json = EXCLUDED.settings_json', 
                [JSON.stringify(defaultSettings)]
            );
            console.log("Application settings have been successfully reset to defaults.");
        } catch (error) {
            console.error("CRITICAL: Failed to reset database tables on startup.", error);
        }
    }

    currentSettings = await fetchSettingsFromDB();
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        if(dbInitializationError) console.error("DATABASE WARNING:", dbInitializationError);
        if(stripeInitializationError) console.error("STRIPE WARNING:", stripeInitializationError);
        if(aiInitializationError) console.error("AI WARNING:", aiInitializationError);
    });
};

startServer();