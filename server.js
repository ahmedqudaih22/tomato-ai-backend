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
                { id: 7, quote_ar: "أفضل استثمار قمت به لعملي. يوفر الوقت والجهد ويقدم نتائج احترافية لا مثيل لها.", quote_en: "The best investment I've made for my business. It saves time, effort, and delivers unparalleled professional results.", name_ar: "يوسف منصور", name_en: "Youssef Mansour", role_ar: "رائد أعمال", role_en: "Entrepreneur", avatarUrl: "https://i.ibb.co/SNk3zS1/avatar7.jpg" }
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

const fetchSettingsFromDB = async () => {
    if (!pool) return defaultSettings;
    try {
        const result = await pool.query('SELECT settings_json FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            return { ...defaultSettings, ...result.rows[0].settings_json };
        } else {
            await pool.query('INSERT INTO settings (id, settings_json) VALUES (1, $1)', [JSON.stringify(defaultSettings)]);
            return defaultSettings;
        }
    } catch (error) {
        console.error("Database error fetching settings:", error);
        return defaultSettings;
    }
};

const sanitizeUser = (user) => {
    if (!user) return null;
    const { password_hash, ...sanitized } = user;
    return sanitized;
};

// --- Middleware for Authentication ---

const authenticate = async (req, res, next) => {
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
        // Allow authenticated admins to bypass
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            pool.query('SELECT is_admin FROM users WHERE auth_token = $1', [token])
                .then(result => {
                    if (result.rows.length > 0 && result.rows[0].is_admin) {
                        return next(); // Is an admin, proceed
                    } else {
                         // Not an admin or invalid token, show maintenance
                        return res.status(503).json({ 
                            message: 'Service Unavailable - Maintenance Mode',
                            settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
                        });
                    }
                })
                .catch(() => {
                    // DB error, fail safe to maintenance
                    return res.status(503).json({ 
                        message: 'Service Unavailable - Maintenance Mode',
                        settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
                    });
                });
        } else {
            // No token, show maintenance
            return res.status(503).json({ 
                message: 'Service Unavailable - Maintenance Mode',
                settings: { maintenance: currentSettings.maintenance, theme: currentSettings.theme }
            });
        }
    } else {
        next(); // Not in maintenance mode
    }
};

// --- API Routes ---

app.get('/api/config', async (req, res) => {
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
    if (!pool) return res.status(500).json({ message: 'Database service is not available.' });
    const { username, email, password, country, referralCode } = req.body;
    
    if (!username || !email || !password || !country) {
        return res.status(400).json({ message: 'All fields are required.' });
    }

    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $2', [email, username]);
        if (existingUser.rows.length > 0) {
            const isEmail = existingUser.rows.find(u => u.email === email);
            return res.status(409).json({ message: isEmail ? 'Email already exists.' : 'Username already exists.' });
        }
        
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        const passwordHash = `${salt}:${hash}`;
        
        let referralData = { referrerId: null, bonusPoints: 0 };
        if (referralCode) {
            const referrerResult = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerResult.rows.length > 0) {
                referralData.referrerId = referrerResult.rows[0].id;
                referralData.bonusPoints = currentSettings.costs.referralBonus || 50;
            }
        }
        
        const newReferralCode = crypto.randomBytes(4).toString('hex');