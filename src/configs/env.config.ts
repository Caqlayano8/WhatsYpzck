/**
 * Author: Ç.Kurtoğlu
 * Description: Environment Configuration - Ortam değişkenleri
 */

import { config } from "dotenv";
import logger from "./logger.config";

const fs = require('fs');

config();

class EnvConfig {

    static GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    static CHAT_GPT_PROJECT_ID = process.env.CHAT_GPT_PROJECT_ID;
    static CHAT_GPT_ORG_ID = process.env.CHAT_GPT_ORG_ID;
    static CHAT_GPT_API_KEY = process.env.CHAT_GPT_API_KEY;
    static ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    static SERPER_API_KEY = process.env.SERPER_API_KEY;
    static AI_WEB_LOOKUP_ENABLED = process.env.AI_WEB_LOOKUP_ENABLED;
    static AI_WEB_LOOKUP_MODE = process.env.AI_WEB_LOOKUP_MODE;
    static WEB_LOOKUP_TIMEOUT_MS = process.env.WEB_LOOKUP_TIMEOUT_MS;
    static WEB_LOOKUP_CACHE_TTL_MS = process.env.WEB_LOOKUP_CACHE_TTL_MS;
    static AI_WEB_ALLOWED_DOMAINS = process.env.AI_WEB_ALLOWED_DOMAINS;
    static PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;
    static OPENWEATHERMAP_API_KEY = process.env.OPENWEATHERMAP_API_KEY;
    static ENV = process.env.ENV;
    static PORT = process.env.PORT;
    static MONGODB_URI = process.env.MONGODB_URI;
    static JWT_SECRET = process.env.JWT_SECRET;
    static SMTP_HOST = process.env.SMTP_HOST;
    static SMTP_PORT = process.env.SMTP_PORT;
    static SMTP_SECURE = process.env.SMTP_SECURE;
    static SMTP_USER = process.env.SMTP_USER;
    static SMTP_PASS = process.env.SMTP_PASS;
    static SMTP_FROM_NAME = process.env.SMTP_FROM_NAME;
    static SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL;
    static M365_TENANT_ID = process.env.M365_TENANT_ID;
    static M365_CLIENT_ID = process.env.M365_CLIENT_ID;
    static M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET;
    static M365_SENDER_UPN = process.env.M365_SENDER_UPN;
    static LICENSE_ENFORCEMENT = process.env.LICENSE_ENFORCEMENT;
    static LICENSE_ALLOW_UNLICENSED = process.env.LICENSE_ALLOW_UNLICENSED;
    static LICENSE_FILE_PATH = process.env.LICENSE_FILE_PATH;
    static LICENSE_PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY_PATH;

    static validate() {

        if (!this.PUPPETEER_EXECUTABLE_PATH) {
            throw new Error("Environment variable PUPPETEER_EXECUTABLE_PATH is missing. Please provide a valid Chrome path.");
        }
        if (!this.ENV) {
            throw new Error("Environment variable ENV is missing. Please provide a valid ENV.");
        }
        if (!this.PORT) {
            throw new Error("Environment variable PORT is missing. Please provide a valid PORT.");
        }
        if (!this.MONGODB_URI) {
            throw new Error("Environment variable MONGODB_URI is missing. Please provide a valid MONGODB_URI.");
        }
        if (!this.JWT_SECRET) {
            throw new Error("Environment variable JWT_SECRET is missing. Please provide a valid JWT_SECRET.");
        }
    }
}

try {
    EnvConfig.validate();
} catch (error) {
    logger.error(error);
    process.exit(1);
}

export default EnvConfig;
