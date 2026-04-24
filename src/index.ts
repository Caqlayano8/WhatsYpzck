/**
 * Author: Ç.Kurtoğlu
 * Description: Main Entry Point - Uygulamanın giriş noktası
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bodyParser from 'body-parser';
import net from 'net';

/** Verilen port meşgulse bir sonrakini dener — tamamen offline, async. */
function findFreePort(startPort: number): Promise<number> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(startPort, '0.0.0.0', () => {
            const addr = server.address() as net.AddressInfo;
            server.close(() => resolve(addr.port));
        });
        server.on('error', () => findFreePort(startPort + 1).then(resolve));
    });
}
import logger from "./configs/logger.config";
import EnvConfig from "./configs/env.config";
import apiRoutes from "./api/index.api";
import { readAsciiArt } from "./utils/system/ascii-art.util";
import path from "path";
import { BotManager } from "./bot.manager";
import { connectDB } from "./configs/db.config";
import { initCrons } from "./crons/index.cron";
import { hydrateRuntimeConfigFromSettings } from "./utils/system/runtime-config.util";
import { initializeSherpaModels } from "./utils/media/sherpa-model-downloader.util";
import { AppConfig } from "./configs/app.config";
import { ensureDefaultUsers } from "./crm/utils/seed-default-admin.util";
import { enforceLicenseOrThrow } from "./utils/system/license.util";

// Global error handlers to prevent crashes (Log but don't exit - let the app continue running)
process.on('uncaughtException', (error: Error) => {
    // EPIPE = broken pipe (WhatsApp Chrome connection yazma hatası) - ölümcül değil, yoksay
    if ((error as any).code === 'EPIPE') {
        return;
    }
    logger.error('Uncaught Exception:', error);
    logger.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('Unhandled Rejection at:', promise);
    logger.error('Reason:', reason);
});

const gracefulShutdown = (signal: string) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    // Give ongoing operations 10 seconds to complete
    setTimeout(() => {
        logger.info('Forcing shutdown after timeout');
        process.exit(0);
    }, 10000);

    // Attempt graceful cleanup
    try {
        const botManager = BotManager.getInstance();
        if (botManager.client) {
            botManager.client.destroy().catch((err: Error) =>
                logger.error('Error destroying WhatsApp client:', err)
            );
        }
    } catch (err) {
        logger.error('Error during shutdown:', err);
    }

    logger.info('Graceful shutdown initiated');
    setTimeout(() => process.exit(0), 2000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Serve widget.js with CORS so it can be loaded cross-origin
app.get('/public/js/widget.js', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(process.cwd(), 'public', 'js', 'widget.js'));
});
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use("/public", express.static("public"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/admin', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.render('admin');
});

app.get('/admin/login', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.render('admin-login');
});

app.get('/admin/security', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.render('admin-security');
});

app.get('/panel', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.render('panel');
});

app.get('/technician', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.render('panel');
});

app.get(['/mobile', '/web-mobile', '/webmobil', '/panel/mobile'], (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.render('panel');
});

app.get('/panel/login', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.render('panel-login');
});

app.get('/technician/login', (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.render('panel-login');
});

app.get(['/mobile/login', '/web-mobile/login', '/webmobil/login', '/panel/mobile/login'], (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.render('panel-login');
});

const botManager = BotManager.getInstance();

app.use("/", apiRoutes(botManager));

async function bootstrap() {
    enforceLicenseOrThrow();
    await connectDB();
    await ensureDefaultUsers();
    await hydrateRuntimeConfigFromSettings();
    await initializeSherpaModels();
    initCrons(botManager);

    const preferredPort = parseInt(String(EnvConfig.PORT || '3500'), 10);
    const port = await findFreePort(preferredPort);
    if (port !== preferredPort) {
        logger.warn(`PORT ${preferredPort} mesgul veya kullanilamaz, yerine ${port} kullaniliyor.`);
        process.env.PORT = String(port);
    }

    app.listen(port, '0.0.0.0', () => {
        logger.info(readAsciiArt());
        logger.info(`Imza: ${AppConfig.instance.getBotAuthor()}`);
        logger.info(`Server running on port ${port}`);
        logger.info(`Access: http://localhost:${port}/`);
        logger.info(`Admin Panel : http://localhost:${port}/admin`);
        const shouldAutoStartBot = (EnvConfig.BOT_AUTO_START ?? 'true').toLowerCase() !== 'false';
        if (shouldAutoStartBot) {
            botManager.initialize();
        } else {
            logger.warn('BOT_AUTO_START=false -> WhatsApp bot auto-start skipped to reduce memory usage.');
        }
    });
}

bootstrap().catch((error) => {
    logger.error('Application bootstrap failed:', error);
    process.exit(1);
});
