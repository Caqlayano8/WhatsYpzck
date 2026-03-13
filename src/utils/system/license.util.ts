import fs from "fs";
import path from "path";
import crypto from "crypto";
import EnvConfig from "../../configs/env.config";
import logger from "../../configs/logger.config";

export interface LicensePayload {
    customerId: string;
    customerName: string;
    issuedAt: string;
    expiresAt: string;
    features?: string[];
    metadata?: Record<string, string>;
}

interface LicenseDocument extends LicensePayload {
    signature: string;
}

const DEFAULT_LICENSE_FILE_PATH = "licenses/license.key.json";
const DEFAULT_PUBLIC_KEY_PATH = "licenses/public.pem";

function sortObject(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortObject);
    }

    if (value !== null && typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            output[key] = sortObject((value as Record<string, unknown>)[key]);
        }
        return output;
    }

    return value;
}

function canonicalizePayload(payload: LicensePayload): string {
    return JSON.stringify(sortObject(payload));
}

function validatePayloadShape(payload: LicensePayload): void {
    if (!payload.customerId?.trim()) {
        throw new Error("Lisans customerId bos olamaz.");
    }
    if (!payload.customerName?.trim()) {
        throw new Error("Lisans customerName bos olamaz.");
    }
    if (!payload.issuedAt?.trim()) {
        throw new Error("Lisans issuedAt bos olamaz.");
    }
    if (!payload.expiresAt?.trim()) {
        throw new Error("Lisans expiresAt bos olamaz.");
    }

    const issuedAt = new Date(payload.issuedAt);
    const expiresAt = new Date(payload.expiresAt);
    if (Number.isNaN(issuedAt.getTime())) {
        throw new Error("Lisans issuedAt gecersiz tarih.");
    }
    if (Number.isNaN(expiresAt.getTime())) {
        throw new Error("Lisans expiresAt gecersiz tarih.");
    }
    if (expiresAt.getTime() < issuedAt.getTime()) {
        throw new Error("Lisans expiresAt, issuedAt tarihinden once olamaz.");
    }
}

function readLicenseDocument(licenseFilePath: string): LicenseDocument {
    if (!fs.existsSync(licenseFilePath)) {
        throw new Error(`Lisans dosyasi bulunamadi: ${licenseFilePath}`);
    }

    const raw = fs.readFileSync(licenseFilePath, "utf8");
    let parsed: LicenseDocument;
    try {
        parsed = JSON.parse(raw) as LicenseDocument;
    } catch {
        throw new Error("Lisans dosyasi JSON formatinda degil.");
    }

    if (!parsed.signature?.trim()) {
        throw new Error("Lisans imzasi bulunamadi.");
    }

    validatePayloadShape(parsed);
    return parsed;
}

function verifySignature(payload: LicensePayload, signature: string, publicKeyPem: string): boolean {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(canonicalizePayload(payload));
    verifier.end();

    return verifier.verify(publicKeyPem, Buffer.from(signature, "base64"));
}

export function verifyLicenseFromDisk(): { valid: boolean; payload?: LicensePayload; message: string } {
    const enforcementEnabled = (EnvConfig.LICENSE_ENFORCEMENT ?? "true").toLowerCase() !== "false";
    const allowUnlicensed = (EnvConfig.LICENSE_ALLOW_UNLICENSED ?? "false").toLowerCase() === "true";

    if (!enforcementEnabled) {
        return { valid: true, message: "Lisans zorunlulugu devre disi." };
    }

    if (allowUnlicensed) {
        return { valid: true, message: "Lisanssiz calisma modu aktif." };
    }

    const licenseFilePath = path.resolve(process.cwd(), EnvConfig.LICENSE_FILE_PATH || DEFAULT_LICENSE_FILE_PATH);
    const publicKeyPath = path.resolve(process.cwd(), EnvConfig.LICENSE_PUBLIC_KEY_PATH || DEFAULT_PUBLIC_KEY_PATH);

    if (!fs.existsSync(publicKeyPath)) {
        return { valid: false, message: `Public key dosyasi bulunamadi: ${publicKeyPath}` };
    }

    const publicKeyPem = fs.readFileSync(publicKeyPath, "utf8");

    try {
        const licenseDoc = readLicenseDocument(licenseFilePath);
        const payload: LicensePayload = {
            customerId: licenseDoc.customerId,
            customerName: licenseDoc.customerName,
            issuedAt: licenseDoc.issuedAt,
            expiresAt: licenseDoc.expiresAt,
            features: licenseDoc.features,
            metadata: licenseDoc.metadata
        };

        if (!verifySignature(payload, licenseDoc.signature, publicKeyPem)) {
            return { valid: false, message: "Lisans imzasi dogrulanamadi." };
        }

        const expiresAt = new Date(payload.expiresAt).getTime();
        if (Date.now() > expiresAt) {
            return { valid: false, message: `Lisans suresi dolmus: ${payload.expiresAt}` };
        }

        return {
            valid: true,
            payload,
            message: `Lisans dogrulandi. Musteri: ${payload.customerName} (${payload.customerId})`
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Bilinmeyen lisans hatasi";
        return { valid: false, message };
    }
}

export function enforceLicenseOrThrow(): void {
    const result = verifyLicenseFromDisk();
    if (!result.valid) {
        throw new Error(`Lisans dogrulama basarisiz: ${result.message}`);
    }

    if (result.payload) {
        logger.info(`Lisans aktif: ${result.payload.customerName} / Bitis: ${result.payload.expiresAt}`);
    } else {
        logger.warn(`Lisans bypass: ${result.message}`);
    }
}

export function signLicensePayload(payload: LicensePayload, privateKeyPem: string): string {
    validatePayloadShape(payload);

    const signer = crypto.createSign("RSA-SHA256");
    signer.update(canonicalizePayload(payload));
    signer.end();
    return signer.sign(privateKeyPem).toString("base64");
}
