import fs from "fs";
import path from "path";
import crypto from "crypto";

function getArg(name: string, defaultValue: string): string {
    const args = process.argv.slice(2);
    const idx = args.findIndex((arg) => arg === `--${name}`);
    if (idx >= 0 && args[idx + 1]) {
        return args[idx + 1];
    }
    return defaultValue;
}

const outDir = path.resolve(process.cwd(), getArg("outDir", "licenses"));
const privateKeyPath = path.join(outDir, "private.pem");
const publicKeyPath = path.join(outDir, "public.pem");

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
    console.error("private.pem/public.pem zaten var. Uzerine yazmak icin once silin.");
    process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

fs.writeFileSync(privateKeyPath, privateKey, "utf8");
fs.writeFileSync(publicKeyPath, publicKey, "utf8");

console.log(`Key pair olusturuldu:`);
console.log(`- Private: ${privateKeyPath}`);
console.log(`- Public:  ${publicKeyPath}`);
