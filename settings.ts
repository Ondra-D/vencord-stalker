


import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const DEFAULT_HISTORY_RETENTION_DAYS = 14;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const settings = definePluginSettings({
    whitelistedIds: {
        default: "",
        type: OptionType.STRING,
        description: "Whitelisted user IDs to stalk"
    },
    historyRetentionDays: {
        default: DEFAULT_HISTORY_RETENTION_DAYS,
        type: OptionType.NUMBER,
        description: "How many days of presence history to retain (0 to keep everything)"
    },
    debug: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "Enable debug logging"
    }
});

export function getWhitelistedIds(): string[] {
    return settings.store.whitelistedIds ? settings.store.whitelistedIds.split(",").map(s => s.trim()).filter(Boolean) : [];
}

export function getRetentionDays() {
    const value = settings.store.historyRetentionDays;
    if (Number.isNaN(value)) return DEFAULT_HISTORY_RETENTION_DAYS;
    return Math.max(0, value);
}

export function getRetentionCutoffMs() {
    const days = getRetentionDays();
    if (!days) return 0;
    return Date.now() - days * MS_PER_DAY;
}

export function isDebugEnabled() {
    return settings.store.debug;
}

