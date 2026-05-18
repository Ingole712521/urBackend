const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const { validateEnv } = require('@urbackend/common');

if (process.env.NODE_ENV !== 'test') {
    validateEnv();
}

const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const rateLimit = require('express-rate-limit');


const projectRoutes = require('./routes/project.routes');
const app = express();
app.set('trust proxy', 1);

const dashboardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { error: "Dashboard usage limit exceeded. Slow down!" },
    skip: (req) => process.env.NODE_ENV === 'development',
});

const whitelist = (function() {
    // Default allowed origins
    const allowed = [process.env.FRONTEND_URL];
    
    // Support comma-separated list of origins in .env
    if (process.env.ALLOWED_ORIGINS) {
        const extraOrigins = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
        allowed.push(...extraOrigins);
    }

    if (process.env.NODE_ENV === 'development') {
        allowed.push('http://localhost:5173');
        allowed.push('http://localhost:3000');
    }

    // Filter out duplicates and empty values
    const uniqueAllowed = [...new Set(allowed.filter(Boolean))];

    return {
        get: () => uniqueAllowed
    };
})()

app.use(cors({
    origin: whitelist.get(),
    credentials: true,
}));

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());

const csrfProtection = csurf({ 
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    } 
});

app.use((req, res, next) => {
    // Exclude Razorpay webhook from CSRF protection since it's an external POST request
    if (req.path === '/api/billing/webhook') {
        return next();
    }
    csrfProtection(req, res, next);
});


if (process.env.NODE_ENV !== 'test') {
    // do test specific stuff
}

app.get('/api/server-ip', async (req, res) => {
    const ip = await getPublicIp();
    res.json({ ip });
});

app.get('/', (req, res) => {
    res.status(200).json({ status: "success", message: "urBackend API is running 🚀" })
});

// Mount project routes
app.use('/api/projects', projectRoutes);

app.use((err, req, res, next) => {
    // CSRF Error Handling
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({
            success: false,
            error: "Invalid CSRF token",
            message: "The form has expired or the CSRF token is invalid. Please refresh the page and try again."
        });
    }

    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({
            success: false,
            error: "Invalid JSON format",
            message: "Check your request body syntax. Stray characters outside the JSON object are not allowed."
        });
    }

    const statusCode = err.statusCode || 500;
    const message = err.message || "Something went wrong!";

    // Only log actual server errors (500), not expected operational errors (4xx)
    if (statusCode >= 500) {
        console.error("🔥 Server Error:", err.stack);
    }

    res.status(statusCode).json({
        success: false,
        error: statusCode >= 500 ? "Internal Server Error" : message,
        message: message
    });
});

app.use((req, res) => {
    const id = res.get("X-Kiroo-Replay-ID");
    res.json({error: "Not Found", replayId: id})   
})
if (process.env.NODE_ENV !== 'test') {

    const PORT = process.env.PORT || 1234;

    const { connectDB } = require('@urbackend/common');

    // Start DB & Server
    connectDB();

    const server = app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    // SHUTDOWN
    const gracefulShutdown = async () => {
        console.log('🛑 SIGTERM/SIGINT received. Shutting down gracefully...');

        server.close(async () => {
            console.log('✅ HTTP server closed.');
            try {
                await mongoose.connection.close(false);
                console.log('✅ MongoDB connection closed.');
                process.exit(0);
            } catch (err) {
                console.error('❌ Error closing MongoDB connection:', err);
                process.exit(1);
            }
        });

        // Force close after 10s
        setTimeout(() => {
            console.error('Force shutting down...');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
}

// Export for Testing
module.exports = app;