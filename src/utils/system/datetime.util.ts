const TR_TIME_ZONE = "Europe/Istanbul";

export function getTrNow(): Date {
    return new Date();
}

export function formatTrDateTime(value: Date | string | number): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleString("tr-TR", {
        timeZone: TR_TIME_ZONE
    });
}

export function formatTrDate(value: Date | string | number): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleDateString("tr-TR", {
        timeZone: TR_TIME_ZONE
    });
}

export function formatTrTime(value: Date | string | number): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString("tr-TR", {
        timeZone: TR_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
}

export { TR_TIME_ZONE };
