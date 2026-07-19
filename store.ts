


import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { PluginNative } from "@utils/types";

import { getRetentionCutoffMs, getWhitelistedIds } from "./settings";
import { PresenceLogEntry, ProfileSnapshot, UserStalkerConfig } from "./types";
import { formatTimestamp, getDurationLabel, logger } from "./utils";

export const isDesktop = typeof VencordNative !== "undefined" && !!VencordNative.pluginHelpers?.ActivityTracker;
export const Native = isDesktop ? VencordNative.pluginHelpers.ActivityTracker as PluginNative<typeof import("./native")> : null;

export async function readUserLogs(userId: string, cutoffMs?: number): Promise<PresenceLogEntry[]> {
    if (Native) {
        return await Native.readLogs(userId, cutoffMs);
    } else {
        try {
            const logs = await DataStore.get(`stalker-logs-${userId}`) as PresenceLogEntry[] | undefined;
            if (!Array.isArray(logs)) return [];
            if (cutoffMs) {
                return logs.filter(log => log.timestamp >= cutoffMs);
            }
            return logs;
        } catch (e) {
            logger.error(`Failed to read web logs for user ${userId}`, e);
            return [];
        }
    }
}

export async function appendUserLog(userId: string, entry: PresenceLogEntry, cutoffMs: number) {
    if (Native) {
        await Native.appendLog(userId, entry, cutoffMs);
    } else {
        try {
            let existing = await readUserLogs(userId);
            if (cutoffMs) {
                existing = existing.filter(log => log.timestamp >= cutoffMs);
            }
            existing.unshift(entry);
            await DataStore.set(`stalker-logs-${userId}`, existing);
        } catch (e) {
            logger.error(`Failed to append web log for user ${userId}`, e);
        }
    }
}

export async function deleteUserLogs(userId: string) {
    if (Native) {
        await Native.deleteLogs(userId);
    } else {
        try {
            await DataStore.del(`stalker-logs-${userId}`);
        } catch (e) {
            logger.error(`Failed to delete web logs for user ${userId}`, e);
        }
    }
}
const lastOfflineStoreKey = () => "stalker-last-offline";
const profileSnapshotsStoreKey = () => "stalker-profile-snapshots";
const userConfigsStoreKey = () => "stalker-user-configs";
const notificationOverridesKey = () => "stalker-notify-ids";
export const lastOnlineTimestamps = new Map<string, number>();
export const lastOfflineTimestamps = new Map<string, number>();
export const offlineDurations = new Map<string, number>();
export const onlineDurations = new Map<string, number>();
export const recentCurrentUserMessages = new Map<string, number>();
export const lastKnownUsers = new Map<string, ProfileSnapshot>();
export const userConfigs = new Map<string, UserStalkerConfig>();
export const lastKnownStatuses = new Map<string, string | null>();
export const lastKnownActivities = new Map<string, any[]>();
export const activeDeviceTimings = new Map<string, Array<{ device: string; status: string; start: number; end?: number | null }>>();
export const lastKnownClientStatuses = new Map<string, Record<string, string>>();

export function updateDeviceTimings(userId: string, currentStatus: string | null, clientStatusMap: Record<string, string>, timestamp: number) {
    const isUserOffline = !currentStatus || ["offline", "invisible"].includes(currentStatus.toLowerCase());
    
    let segments = activeDeviceTimings.get(userId);
    if (!segments) {
        segments = [];
    }

    const devices = ["desktop", "mobile", "web"];
    let changed = false;

    if (isUserOffline) {
        for (const segment of segments) {
            if (!segment.end) {
                segment.end = timestamp;
                changed = true;
            }
        }
    } else {
        for (const device of devices) {
            const currentDevStatus = clientStatusMap[device] || "offline";
            const lastSegmentIdx = segments.map(s => s.device).lastIndexOf(device);
            const lastSegment = lastSegmentIdx !== -1 ? segments[lastSegmentIdx] : null;

            if (lastSegment && !lastSegment.end) {
                if (currentDevStatus === "offline") {
                    lastSegment.end = timestamp;
                    changed = true;
                } else if (lastSegment.status !== currentDevStatus) {
                    lastSegment.end = timestamp;
                    segments.push({
                        device,
                        status: currentDevStatus,
                        start: timestamp,
                        end: null
                    });
                    changed = true;
                }
            } else {
                if (currentDevStatus !== "offline") {
                    segments.push({
                        device,
                        status: currentDevStatus,
                        start: timestamp,
                        end: null
                    });
                    changed = true;
                }
            }
        }
    }

    if (segments.length > 0) {
        activeDeviceTimings.set(userId, segments);
    } else {
        activeDeviceTimings.delete(userId);
    }

    const result = JSON.parse(JSON.stringify(segments));

    if (isUserOffline) {
        activeDeviceTimings.delete(userId);
    }

    return { result, changed };
}

export const typingCooldowns = new Map<string, number>();
export const pendingOnlineLogs = new Map<string, { timeout: ReturnType<typeof setTimeout>; entry: any; }>();
export const pendingActivityLogs = new Map<string, { timeout: ReturnType<typeof setTimeout>; entry: any; }>();
export const activityLogCooldowns = new Map<string, number>();
export const notificationOverrideIds = new Set<string>();
const DEFAULT_USER_CONFIG: Omit<UserStalkerConfig, "userId"> = {
    logPresenceChanges: true,
    logProfileChanges: true,
    logMessages: true,
    notifyPresenceChanges: false,
    notifyProfileChanges: true,
    notifyMessages: true,
    notifyTyping: true,
    typingConversationWindow: 10,
    serverFilterMode: "all",
    serverList: [],
    notifyOnline: true,
    notifyOffline: true,
    notifyIdle: true,
    notifyDnd: true,
    notifyUsername: true,
    notifyAvatar: true,
    notifyBanner: true,
    notifyBio: true,
    notifyPronouns: true,
    notifyGlobalName: true
};
export const presenceLogListeners = new Set<(logs: PresenceLogEntry[]) => void>();
export let presenceLogs: PresenceLogEntry[] = [];

export function setPresenceLogs(next: PresenceLogEntry[]) {
    presenceLogs = next;
    for (const listener of presenceLogListeners) listener(presenceLogs);
}

export function filterLogsByRetention(logs: PresenceLogEntry[], cutoffMs?: number) {
    const cutoff = cutoffMs ?? getRetentionCutoffMs();
    if (!cutoff) return logs;
    return logs.filter(entry => entry.timestamp >= cutoff);
}

export function addPresenceLog(entry: PresenceLogEntry & { activitySummary?: string; clientStatusSummary?: string; offlineDuration?: number; onlineDuration?: number; }) {
    const cutoffMs = getRetentionCutoffMs();
    const updatedLogs = [entry, ...filterLogsByRetention(presenceLogs, cutoffMs)];
    setPresenceLogs(updatedLogs);

    const line = `${formatTimestamp(entry.timestamp)} | ${entry.username} (${entry.userId}) | ${entry.previousStatus ?? "unknown"} -> ${entry.currentStatus}`;
    const parts = [line];
    if (entry.offlineDuration) parts.push(`Offline: ${getDurationLabel(entry.offlineDuration)}`);
    if (entry.onlineDuration) parts.push(`Online: ${getDurationLabel(entry.onlineDuration)}`);
    if (entry.activitySummary) parts.push(`Activity: ${entry.activitySummary}`);
    if (entry.clientStatusSummary) parts.push(`Clients: ${entry.clientStatusSummary}`);

    logger.info(parts.join(" | "));
    appendUserLog(entry.userId, entry, cutoffMs).catch(e => logger.error("Failed to save log entry", e));
    if (entry.type === "presence" && entry.previousStatus !== entry.currentStatus) {
        const userConfig = getUserConfig(entry.userId);
        if (userConfig.notifyPresenceChanges) {
            let shouldNotify = false;
            const currentStatus = entry.currentStatus?.toLowerCase();

            if (currentStatus === "online" && userConfig.notifyOnline !== false) shouldNotify = true;
            else if (currentStatus === "offline" && userConfig.notifyOffline !== false) shouldNotify = true;
            else if (currentStatus === "idle" && userConfig.notifyIdle !== false) shouldNotify = true;
            else if (currentStatus === "dnd" && userConfig.notifyDnd !== false) shouldNotify = true;
            else if (!["online", "offline", "idle", "dnd"].includes(currentStatus || "")) shouldNotify = true; // fallback for unknown statuses

            if (shouldNotify) {
                try {
                    const statusLabel = entry.currentStatus ? entry.currentStatus.charAt(0).toUpperCase() + entry.currentStatus.slice(1) : "Unknown";
                    let body = `Status changed to ${statusLabel}`;

                    if (entry.offlineDuration && entry.currentStatus !== "offline") {
                        body += ` (was offline for ${getDurationLabel(entry.offlineDuration)})`;
                    }

                    if (entry.activitySummary && entry.activitySummary !== "typing" && !entry.activitySummary.startsWith("profile:")) {
                        body += ` - ${entry.activitySummary}`;
                    }

                    showNotification({
                        title: `${entry.username} is ${statusLabel}`,
                        body,
                        icon: undefined
                    });
                } catch (e) {  }
            }
        }
    }
}
export async function loadUserConfigs() {
    try {
        const saved = await DataStore.get(userConfigsStoreKey()) as Record<string, UserStalkerConfig> | undefined;
        if (!saved) return;
        Object.entries(saved).forEach(([id, config]) => {
            if (config) {
                userConfigs.set(id, config);
            }
        });
        logger.info(`Loaded ${userConfigs.size} user configs from storage`);
    } catch (e) {
        logger.error("Failed to load user configs", e);
    }
}

export async function persistUserConfig(userId: string, config: UserStalkerConfig) {
    userConfigs.set(userId, config);
    DataStore.set(userConfigsStoreKey(), Object.fromEntries(userConfigs)).catch(e => {
        logger.error("Failed to persist user config", e);
    });
}

export function getUserConfig(userId: string): UserStalkerConfig {
    if (!userConfigs.has(userId)) {
        const newConfig: UserStalkerConfig = {
            userId,
            ...DEFAULT_USER_CONFIG
        };
        userConfigs.set(userId, newConfig);
        persistUserConfig(userId, newConfig);
        return newConfig;
    }
    const existing = userConfigs.get(userId)!;
    const merged: UserStalkerConfig = {
        ...DEFAULT_USER_CONFIG,
        ...existing,
        userId
    };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
        userConfigs.set(userId, merged);
        persistUserConfig(userId, merged);
    }
    return merged;
}
export async function loadLastOfflineTimestamps() {
    try {
        const saved = await DataStore.get(lastOfflineStoreKey()) as Record<string, number> | undefined;
        if (!saved) return;
        Object.entries(saved).forEach(([id, ts]) => {
            if (ts > 0) {
                lastOfflineTimestamps.set(id, ts);
            }
        });
    } catch (e) {
        logger.error("Failed to load last offline timestamps", e);
    }
}

export function persistLastOfflineTimestamp(userId: string, timestamp: number) {
    lastOfflineTimestamps.set(userId, timestamp);
    DataStore.set(lastOfflineStoreKey(), Object.fromEntries(lastOfflineTimestamps)).catch(e => {
        logger.error("Failed to persist last offline timestamps", e);
    });
}
export async function loadProfileSnapshots() {
    try {
        const saved = await DataStore.get(profileSnapshotsStoreKey()) as Record<string, ProfileSnapshot> | undefined;
        if (!saved) return;
        Object.entries(saved).forEach(([id, snapshot]) => {
            if (snapshot) {
                lastKnownUsers.set(id, snapshot);
            }
        });
        logger.info(`Loaded ${lastKnownUsers.size} profile snapshots from storage`);
    } catch (e) {
        logger.error("Failed to load profile snapshots", e);
    }
}

export async function persistProfileSnapshot(userId: string, snapshot: ProfileSnapshot) {
    lastKnownUsers.set(userId, snapshot);
    DataStore.set(profileSnapshotsStoreKey(), Object.fromEntries(lastKnownUsers)).catch(e => {
        logger.error("Failed to persist profile snapshot", e);
    });
}

export async function clearProfileSnapshots() {
    lastKnownUsers.clear();
    try {
        await DataStore.del(profileSnapshotsStoreKey());
        logger.info("Cleared all profile snapshots");
    } catch (e) {
        logger.error("Failed to clear profile snapshots", e);
    }
}

export function captureProfileSnapshot(user: any, profileStore?: any, activities?: any[]): ProfileSnapshot {
    const profile = profileStore?.getUserProfile?.(user.id);
    const avatar = user.avatar ?? null;
    const banner = profile ? (profile.banner ?? user.banner ?? null) : undefined;
    const banner_color = profile ? (profile.bannerColor ?? (user as any).banner_color ?? (user as any).bannerColor ?? null) : undefined;
    const avatarDecorationData = (profile as any)?.avatarDecorationData ?? (user as any).avatarDecorationData ?? (user as any).avatar_decoration_data ?? null;
    const customStatusActivity = activities?.find(act => act.type === 4);
    const customStatus = customStatusActivity?.state ?? null;

    const connectedAccounts = profile?.connected_accounts ? (profile.connected_accounts || []).map((acc: any) => ({
        type: acc.type,
        name: acc.name,
        verified: acc.verified
    })) : undefined;

    return {
        username: user.username,
        avatar,
        discriminator: user.discriminator,
        global_name: (user as any).global_name ?? (user as any).globalName ?? null,
        bio: profile ? (profile.bio ?? null) : undefined,
        banner,
        banner_color: banner_color,
        avatarDecoration: avatarDecorationData?.asset ?? null,
        avatarDecorationData,
        customStatus,
        pronouns: profile ? (profile.pronouns ?? null) : undefined,
        theme_colors: profile?.theme_colors ?? undefined,
        emoji: profile?.emoji ?? undefined,
        connected_accounts: connectedAccounts
    };
}
export function mergeProfileSnapshots(prev: ProfileSnapshot | undefined, current: ProfileSnapshot): ProfileSnapshot {
    if (!prev) return current;

    const merged: ProfileSnapshot = { ...prev };
    const basicFields: (keyof ProfileSnapshot)[] = [
        "username", "avatar", "discriminator", "global_name",
        "avatarDecoration", "avatarDecorationData"
    ];

    for (const field of basicFields) {
        if (current[field] !== undefined) {
            merged[field] = current[field] as any;
        }
    }
    const profileFields: (keyof ProfileSnapshot)[] = [
        "bio", "banner", "banner_color", "pronouns",
        "theme_colors", "emoji", "connected_accounts"
    ];

    for (const field of profileFields) {
        if (current[field] !== undefined) {
            merged[field] = current[field] as any;
        }
    }
    if (current.customStatus !== undefined) merged.customStatus = current.customStatus;

    return merged;
}
export function detectProfileChanges(prev: ProfileSnapshot, current: ProfileSnapshot): string[] {
    const changes: string[] = [];
    const simpleKeys: (keyof ProfileSnapshot)[] = [
        "username", "avatar", "discriminator", "global_name",
        "avatarDecoration", "bio", "banner", "banner_color",
        "pronouns", "customStatus"
    ];

    for (const key of simpleKeys) {
        if (prev[key] !== undefined && current[key] !== undefined && prev[key] !== current[key]) {
            changes.push(key === "global_name" ? "display_name" : key);
        }
    }
    const complexKeys: (keyof ProfileSnapshot)[] = [
        "theme_colors", "emoji", "connected_accounts"
    ];

    for (const key of complexKeys) {
        if (prev[key] !== undefined && current[key] !== undefined) {
            if (JSON.stringify(prev[key]) !== JSON.stringify(current[key])) {
                changes.push(key === "emoji" ? "profile_emoji" : key);
            }
        }
    }

    return changes;
}
export async function loadPresenceLogs() {
    try {
        const userIds = getWhitelistedIds();
        const allLogs: PresenceLogEntry[] = [];
        const cutoffMs = getRetentionCutoffMs();

        for (const userId of userIds) {
            try {
                const userLogs = await readUserLogs(userId, cutoffMs);
                allLogs.push(...userLogs);
            } catch (e) {
                logger.error(`Failed to load logs for user ${userId}`, e);
            }
        }
        allLogs.sort((a, b) => b.timestamp - a.timestamp);

        presenceLogs = allLogs;
        setPresenceLogs(presenceLogs);
        logger.info(`Loaded ${allLogs.length} presence logs from disk`);

        const overrides = await DataStore.get(notificationOverridesKey()) as string[] | undefined;
        if (Array.isArray(overrides)) {
            notificationOverrideIds.clear();
            overrides.forEach(id => notificationOverrideIds.add(id));
        }
    } catch (e) {
        logger.error("Failed to load presence logs", e);
    }
}


export function getProfileChangeLabel(field: string): string {
    const labels: Record<string, string> = {
        username: "Username",
        avatar: "Avatar",
        discriminator: "Discriminator",
        global_name: "Display Name",
        display_name: "Display Name",
        bio: "Bio",
        banner: "Banner",
        banner_color: "Banner Color",
        avatar_decoration: "Avatar Decoration",
        connected_accounts: "Connected Accounts",
        mutual_friends_count: "Mutual Friends",
        mutual_guilds: "Mutual Servers",
        badges: "Badges",
        pronouns: "Pronouns",
        theme_colors: "Profile Colors",
        profile_emoji: "Profile Emoji",
        customStatus: "Custom Status"
    };
    return labels[field] ?? field;
}

