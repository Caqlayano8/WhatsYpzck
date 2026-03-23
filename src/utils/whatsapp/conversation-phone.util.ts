export function normalizeConversationPhone(raw: string): string {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/^widget_/i.test(value)) return value;
    if (/@g\.us$/i.test(value)) return value;

    const withoutSuffix = value.replace(/@(c\.us|lid)$/i, "");
    let digits = withoutSuffix.replace(/\D/g, "");

    if (!digits) {
        return withoutSuffix;
    }

    if (digits.startsWith("00")) {
        digits = digits.slice(2);
    }

    if (digits.length === 11 && digits.startsWith("0") && digits[1] === "5") {
        return `90${digits.slice(1)}`;
    }

    if (digits.length === 10 && digits.startsWith("5")) {
        return `90${digits}`;
    }

    return digits;
}

export function isLidConversationPhone(raw: string): boolean {
    return /@lid$/i.test(String(raw || "").trim());
}
