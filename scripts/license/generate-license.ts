import fs from "fs";
import path from "path";
import { LicensePayload, signLicensePayload } from "../../src/utils/system/license.util";

function getArg(name: string, defaultValue?: string): string | undefined {
    const args = process.argv.slice(2);
    const idx = args.findIndex((arg) => arg === `--${name}`);
    if (idx >= 0 && args[idx + 1]) {
        return args[idx + 1];
    }
    return defaultValue;
}

const customerId = getArg("customerId");
const customerName = getArg("customerName");
const expiresAt = getArg("expiresAt");
const issuedAt = getArg("issuedAt", new Date().toISOString());
const privateKeyPath = path.resolve(process.cwd(), getArg("privateKey", "licenses/private.pem") as string);
const outputPath = path.resolve(process.cwd(), getArg("output", "licenses/license.key.json") as string);
const featuresArg = getArg("features", "");

if (!customerId || !customerName || !expiresAt) {
    console.error("Kullanim:");
    console.error("npm run license:generate -- --customerId CEDA-001 --customerName \"Coruh EDAS\" --expiresAt 2027-12-31T23:59:59.000Z");
    process.exit(1);
}

if (!fs.existsSync(privateKeyPath)) {
    console.error(`Private key bulunamadi: ${privateKeyPath}`);
    process.exit(1);
}

const payload: LicensePayload = {
    customerId,
    customerName,
    issuedAt: issuedAt as string,
    expiresAt,
    features: featuresArg ? featuresArg.split(",").map((item) => item.trim()).filter(Boolean) : []
};

const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
const signature = signLicensePayload(payload, privateKeyPem);

const document = {
    ...payload,
    signature
};

const outDir = path.dirname(outputPath);
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

fs.writeFileSync(outputPath, JSON.stringify(document, null, 2), "utf8");
console.log(`Lisans dosyasi olusturuldu: ${outputPath}`);
