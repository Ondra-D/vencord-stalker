


import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { PluginNative } from "@utils/types";
import { Forms, GuildStore, NavigationRouter, ScrollerThin, TabBar, Text, Tooltip, useEffect, useMemo, UserStore,useState } from "@webpack/common";

import { isDebugEnabled } from "../settings";
import { clearProfileSnapshots, loadPresenceLogs, presenceLogListeners, presenceLogs, isDesktop, deleteUserLogs } from "../store";
import { PresenceLogEntry } from "../types";
import { formatTimestamp, getDurationLabel, getStatusClass, getStatusLabel, logger } from "../utils";
import { renderPresenceActivitySummary } from "./ActivityBadges";
import { DeviceBadges } from "./Icons";
import { renderProfileChangeBadges } from "./ProfileCard";
import { openSnapshotsModal } from "./SnapshotsModal";
import { openUserStalkerSettings } from "./UserSettings";

const Native = isDesktop ? VencordNative.pluginHelpers.ActivityTracker as PluginNative<typeof import("../native")> : null;

const cl = classNameFactory("stalker-modal-");

function renderDeviceBadges(entry: PresenceLogEntry) {
    const clientStatus = (entry as any).clientStatus as Record<string, string> | undefined;
    const deviceTimings = (entry as any).deviceTimings as Array<{ device: string; status: string; start: number; end?: number | null }> | undefined;
    if (!clientStatus && !deviceTimings) return null;
    return <DeviceBadges clientStatus={clientStatus} deviceTimings={deviceTimings} entryTimestamp={entry.timestamp} />;
}

function renderPresenceStatuses(entry: PresenceLogEntry) {
    const deviceTimings = (entry as any).deviceTimings as Array<{ device: string; status: string; start: number; end?: number | null }> | undefined;

    if (Array.isArray(deviceTimings) && deviceTimings.length > 0) {
        const devices = ["desktop", "mobile", "web"];
        const transitions: React.ReactNode[] = [];

        for (const device of devices) {
            const endedSegment = deviceTimings.find(t => t.device === device && t.end === entry.timestamp);
            const startedSegment = deviceTimings.find(t => t.device === device && t.start === entry.timestamp);

            if (endedSegment || startedSegment) {
                const prevStatus = endedSegment ? endedSegment.status : "offline";
                const currStatus = startedSegment ? startedSegment.status : "offline";

                if (prevStatus !== currStatus) {
                    transitions.push(
                        <div key={device} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                            <span style={{ fontSize: "12px", opacity: 0.7, textTransform: "capitalize", fontWeight: 600, color: "white" }}>{device}:</span>
                            <span className={getStatusClass(prevStatus)}>{getStatusLabel(prevStatus)}</span>
                            <span className="stalker-log-entry__arrow">→</span>
                            <span className={getStatusClass(currStatus)}>{getStatusLabel(currStatus)}</span>
                        </div>
                    );
                }
            }
        }

        if (transitions.length > 0) {
            return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
                    {transitions}
                </div>
            );
        }
    }

    return (
        <div className="stalker-log-entry__statuses">
            {entry.previousStatus && (
                <>
                    <span className={getStatusClass(entry.previousStatus)}>{getStatusLabel(entry.previousStatus)}</span>
                    <span className="stalker-log-entry__arrow">→</span>
                </>
            )}
            <span className={getStatusClass(entry.currentStatus)}>{getStatusLabel(entry.currentStatus)}</span>
        </div>
    );
}

function ConfirmDeleteModal({ modalProps, onConfirm }: { modalProps: ModalProps; onConfirm: () => void; }) {
    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Text variant="heading-lg/semibold">Delete Logs?</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <Text variant="text-md/normal">
                    Are you sure you want to delete all logs for this user? This action cannot be undone.
                </Text>
            </ModalContent>
            <ModalFooter>
                <Button
                    variant="dangerPrimary"
                    onClick={() => {
                        onConfirm();
                        modalProps.onClose();
                    }}
                >
                    Delete
                </Button>
                <Button
                    variant="secondary"
                    onClick={modalProps.onClose}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

function ConfirmClearSnapshotsModal({ modalProps, onConfirm }: { modalProps: ModalProps; onConfirm: () => void; }) {
    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Text variant="heading-lg/semibold">Clear All Snapshots?</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <Text variant="text-md/normal">
                    Are you sure you want to delete ALL profile snapshots?
                    This will reset change detection for all users. The next time you view them, a new baseline snapshot will be created.
                </Text>
            </ModalContent>
            <ModalFooter>
                <Button
                    variant="dangerPrimary"
                    onClick={() => {
                        onConfirm();
                        modalProps.onClose();
                    }}
                >
                    Clear Snapshots
                </Button>
                <Button
                    variant="secondary"
                    onClick={modalProps.onClose}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function PresenceHistoryPanel({ modalProps, initialUserId }: { modalProps: ModalProps; initialUserId?: string; }) {
    const [logs, setLogs] = useState<PresenceLogEntry[]>(presenceLogs);
    const filterUserId = initialUserId ?? null;

    const userLogsMap = useMemo(() => {
        const map = new Map<string, PresenceLogEntry[]>();
        for (const log of logs) {
            if (!map.has(log.userId)) {
                map.set(log.userId, []);
            }
            map.get(log.userId)!.push(log);
        }
        return map;
    }, [logs]);
    const [selectedSection, setSelectedSection] = useState<number>(0);
    const [dayOffset, setDayOffset] = useState(0);
    const [platformFilter, setPlatformFilter] = useState<"all" | "desktop" | "mobile" | "web">("all");

    const dayRange = useMemo(() => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - dayOffset);
        const end = new Date(start);
        end.setDate(start.getDate() + 1);
        return { start: start.getTime(), end: end.getTime(), label: start.toLocaleDateString() };
    }, [dayOffset]);

    const dayLabel = dayRange.label;
    const logsForDay = useMemo(() => logs.filter(entry => entry.timestamp >= dayRange.start && entry.timestamp < dayRange.end), [logs, dayRange]);

    const showPrevDay = () => setDayOffset(prev => prev + 1);
    const showNextDay = () => setDayOffset(prev => Math.max(0, prev - 1));
    const isToday = dayOffset === 0;

    useEffect(() => {
        const updateLogs = (newLogs: PresenceLogEntry[]) => setLogs([...newLogs]);
        presenceLogListeners.add(updateLogs);
        return () => { presenceLogListeners.delete(updateLogs); };
    }, []);

    const forUser = (entry: PresenceLogEntry) => !filterUserId || entry.userId === filterUserId;

    const presenceItems = logsForDay.filter(e => forUser(e) && (e as any).type !== "profile" && (e as any).type !== "message" && (e as any).type !== "typing" && (e.previousStatus !== undefined || e.currentStatus !== undefined || (e as any).deviceChange));
    const basePresenceItems = presenceItems.filter(e => (e.previousStatus !== undefined && e.previousStatus !== e.currentStatus) || (e as any).deviceChange);
    const richActivityItems = presenceItems.filter(e => {
        const hasActivities = Array.isArray((e as any).activities) && (e as any).activities.length > 0;
        if (!hasActivities) return false;
        return (e as any).activityChange === undefined || (e as any).activityChange === true;
    });
    const profileItems = logsForDay.filter(e => forUser(e) && ((e as any).type === "profile"));
    const messageItems = logsForDay.filter(e => forUser(e) && (((e as any).type === "message") || (e.guildId && e.guildId !== "@me")));

    const filteredPresenceItems = useMemo(() => {
        if (platformFilter === "all") return basePresenceItems;
        return basePresenceItems.filter(e => {
            const deviceTimings = (e as any).deviceTimings;
            if (Array.isArray(deviceTimings) && deviceTimings.length > 0) {
                return deviceTimings.some((t: any) => t.device === platformFilter && (t.start === e.timestamp || t.end === e.timestamp));
            }
            return e.clientStatus && e.clientStatus[platformFilter] && e.clientStatus[platformFilter] !== "offline";
        });
    }, [basePresenceItems, platformFilter]);

    const sectionCounts = [basePresenceItems.length, profileItems.length, messageItems.length, richActivityItems.length];

    const subtitle = filterUserId
        ? `${basePresenceItems.length + profileItems.length + messageItems.length + richActivityItems.length} changes for ${UserStore.getUser(filterUserId)?.username ?? filterUserId}`
        : `${basePresenceItems.length + profileItems.length + messageItems.length + richActivityItems.length} stalked changes`;

    const openLogs = async () => {
        if (!Native) return;
        try {
            if (filterUserId) {
                await Native.openLogFile(filterUserId);
            } else {
                await Native.openLogsFolder();
            }
        } catch (e) {
            logger.error("Failed to open logs folder", e);
        }
    };

    const exportLogs = () => {
        if (!logs.length) return;
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(logs, null, 2));
        const downloadAnchor = document.createElement("a");
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `${filterUserId ?? "all"}_activity_logs.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    };

    const deleteAllLogs = async () => {
        if (!filterUserId) return;
        try {
            await deleteUserLogs(filterUserId);
            await loadPresenceLogs();
            setLogs([]);
        } catch (e) {
            logger.error("Failed to delete logs", e);
        }
    };

    const clearAllSnapshots = async () => {
        try {
            await clearProfileSnapshots();
            logger.log("Successfully cleared all profile snapshots.");
        } catch (e) {
            logger.error("Failed to clear profile snapshots", e);
        }
    };

    const confirmDeleteLogs = () => {
        openModal(props => (
            <ConfirmDeleteModal
                modalProps={props}
                onConfirm={deleteAllLogs}
            />
        ));
    };

    const confirmClearSnapshots = () => {
        openModal(props => (
            <ConfirmClearSnapshotsModal
                modalProps={props}
                onConfirm={clearAllSnapshots}
            />
        ));
    };

    const showDebugTools = isDebugEnabled();

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} className={cl("root") + " stalker-modal-root"}>
            <ModalHeader className={cl("head")}>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Discord Activity Tracker History</Text>
                {filterUserId && (
                    <Tooltip text="User Settings">
                        {tooltipProps => (
                            <button
                                {...tooltipProps}
                                onClick={() => openUserStalkerSettings(filterUserId, UserStore)}
                                style={{
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "8px",
                                    backgroundColor: "var(--button-secondary-background)",
                                    border: "none",
                                    borderRadius: "4px",
                                    transition: "all 0.2s",
                                    color: "var(--interactive-normal)"
                                }}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                                </svg>
                            </button>
                        )}
                    </Tooltip>
                )}
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("contents") + " stalker-modal-contents"}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                        <Forms.FormText>{subtitle}</Forms.FormText>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        {isDesktop && <Button onClick={openLogs}>Open Logs</Button>}
                        {logs.length > 0 && <Button onClick={exportLogs} variant="secondary">Export All Logs</Button>}
                        {filterUserId && <Button onClick={confirmDeleteLogs} variant="dangerPrimary">Delete All Logs</Button>}
                        {!filterUserId && <Button onClick={confirmClearSnapshots} variant="dangerPrimary">Clear All Snapshots</Button>}
                        {showDebugTools && (
                            <Button onClick={() => openSnapshotsModal(filterUserId ?? undefined)} variant="secondary">
                                {filterUserId ? "View Current Snapshot" : "View Snapshots"}
                            </Button>
                        )}
                    </div>
                </div>

                <TabBar type="top" look="brand" className={cl("tab-bar") + " stalker-modal-tab-bar"} selectedItem={selectedSection} onItemSelect={(id: number) => setSelectedSection(id)}>
                    <TabBar.Item id={0}>Presence ({sectionCounts[0]})</TabBar.Item>
                    <TabBar.Item id={1}>Profile ({sectionCounts[1]})</TabBar.Item>
                    <TabBar.Item id={2}>Messages ({sectionCounts[2]})</TabBar.Item>
                    <TabBar.Item id={3}>Rich ({sectionCounts[3]})</TabBar.Item>
                </TabBar>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
                    <Button size="small" variant="secondary" onClick={showPrevDay}>Previous day</Button>
                    <Text variant="text-sm/semibold" style={{ flexGrow: 1, textAlign: "center" }}>{dayLabel}</Text>
                    <Button size="small" variant="secondary" onClick={showNextDay} disabled={isToday}>Next day</Button>
                </div>

                <div style={{ marginTop: 16 }}>
                    {selectedSection === 0 && (
                        <>
                            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                                {["all", "desktop", "mobile", "web"].map(p => (
                                    <Button
                                        key={p}
                                        size="small"
                                        variant={platformFilter === p ? "primary" : "secondary"}
                                        onClick={() => setPlatformFilter(p as any)}
                                    >
                                        {p.charAt(0).toUpperCase() + p.slice(1)}
                                    </Button>
                                ))}
                            </div>
                            {filteredPresenceItems.length ? (
                                <ScrollerThin className="stalker-log-list">
                                    {filteredPresenceItems.map(entry => (
                                        <div key={`${entry.userId}-${entry.timestamp}`} className="stalker-log-entry">
                                            <div className="stalker-log-entry__header">
                                                <div className="stalker-log-entry__identity">
                                                    {(() => {
                                                        const user = UserStore.getUser(entry.userId);
                                                        const avatarUrl = user?.avatar ? `https://cdn.discordapp.com/avatars/${entry.userId}/${user.avatar}.png?size=64` : null;
                                                        return avatarUrl ? <img src={avatarUrl} alt="" className="stalker-log-entry__avatar" /> : <div className="stalker-log-entry__avatar stalker-log-entry__avatar--fallback">{entry.username?.charAt(0)?.toUpperCase() ?? "?"}</div>;
                                                    })()}
                                                    <Text variant="text-md/semibold" className="stalker-log-entry__header-name">{entry.username}</Text>
                                                </div>
                                                {renderPresenceStatuses(entry)}
                                            </div>
                                            <div className="stalker-log-entry__meta">
                                                <span>{formatTimestamp(entry.timestamp)}</span>
                                                {entry.offlineDuration && <span>Offline {getDurationLabel(entry.offlineDuration)}</span>}
                                                {entry.onlineDuration && <span>Online {getDurationLabel(entry.onlineDuration)}</span>}
                                                {renderDeviceBadges(entry)}
                                            </div>
                                        </div>
                                    ))}
                                </ScrollerThin>
                            ) : (
                                <Forms.FormText>No presence updates recorded yet.</Forms.FormText>
                            )}
                        </>
                    )}

                    {selectedSection === 1 && (
                        profileItems.length ? (
                            <ScrollerThin className="stalker-log-list">
                                {profileItems.map(entry => (
                                    <div key={`${entry.userId}-${entry.timestamp}`} className="stalker-log-entry">
                                        <div className="stalker-log-entry__header">
                                            <div className="stalker-log-entry__identity">
                                                {(() => {
                                                    const user = UserStore.getUser(entry.userId);
                                                    const avatarUrl = user?.avatar ? `https://cdn.discordapp.com/avatars/${entry.userId}/${user.avatar}.png?size=64` : null;
                                                    return avatarUrl ? <img src={avatarUrl} alt="" className="stalker-log-entry__avatar" /> : <div className="stalker-log-entry__avatar stalker-log-entry__avatar--fallback">{entry.username?.charAt(0)?.toUpperCase() ?? "?"}</div>;
                                                })()}
                                                <Text variant="text-md/semibold" className="stalker-log-entry__header-name">{entry.username}</Text>
                                            </div>
                                            <div className="stalker-log-entry__statuses">
                                                {renderProfileChangeBadges(entry)}
                                            </div>
                                        </div>
                                        <div className="stalker-log-entry__meta">
                                            <span>{formatTimestamp(entry.timestamp)}</span>
                                            {renderDeviceBadges(entry)}
                                        </div>
                                    </div>
                                ))}
                            </ScrollerThin>
                        ) : (
                            <Forms.FormText>No profile updates recorded yet.</Forms.FormText>
                        )
                    )}

                    {selectedSection === 2 && (
                        messageItems.length ? (
                            <ScrollerThin className="stalker-log-list">
                                {messageItems.map(entry => {
                                    const guild = entry.guildId ? GuildStore.getGuild(entry.guildId) : null;
                                    const guildIcon = guild?.icon ? `https://cdn.discordapp.com/icons/${entry.guildId}/${guild.icon}.png?size=32` : null;
                                    const channelName = entry.channelName ?? entry.channelId;
                                    const jumpLink = entry.guildId && entry.channelId && entry.messageId ? `/channels/${entry.guildId}/${entry.channelId}/${entry.messageId}` : null;

                                    return (
                                        <div key={`${entry.userId}-${entry.timestamp}`} className="stalker-log-entry">
                                            <div className="stalker-log-entry__header">
                                                <div className="stalker-log-entry__identity">
                                                    {(() => {
                                                        const user = UserStore.getUser(entry.userId);
                                                        const avatarUrl = user?.avatar ? `https://cdn.discordapp.com/avatars/${entry.userId}/${user.avatar}.png?size=64` : null;
                                                        return avatarUrl ? <img src={avatarUrl} alt="" className="stalker-log-entry__avatar" /> : <div className="stalker-log-entry__avatar stalker-log-entry__avatar--fallback">{entry.username?.charAt(0)?.toUpperCase() ?? "?"}</div>;
                                                    })()}
                                                    <Text variant="text-md/semibold" className="stalker-log-entry__header-name">{entry.username}</Text>
                                                </div>
                                                <div className="stalker-log-entry__meta">
                                                    <span>{formatTimestamp(entry.timestamp)}</span>
                                                </div>
                                            </div>

                                            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", padding: "8px", backgroundColor: "var(--background-tertiary)", borderRadius: "4px" }}>
                                                {guildIcon ? (
                                                    <img src={guildIcon} alt="" style={{ width: "24px", height: "24px", borderRadius: "50%" }} />
                                                ) : (
                                                    <div style={{ width: "24px", height: "24px", borderRadius: "50%", backgroundColor: "var(--background-accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", color: "var(--text-normal)" }}>
                                                        {entry.guildName?.charAt(0) ?? "?"}
                                                    </div>
                                                )}
                                                <div style={{ display: "flex", flexDirection: "column" }}>
                                                    <Text variant="text-sm/semibold">{entry.guildName ?? "Unknown Server"}</Text>
                                                    {channelName && <Text variant="text-xs/normal" color="header-secondary">#{channelName}</Text>}
                                                </div>
                                                {jumpLink && (
                                                    <Button size="small" variant="primary" style={{ marginLeft: "auto" }} onClick={() => NavigationRouter.transitionTo(jumpLink)}>
                                                        Jump
                                                    </Button>
                                                )}
                                            </div>

                                            {(entry as any).messageContent && (
                                                <div style={{ marginTop: "8px", padding: "8px", backgroundColor: "var(--background-secondary-alt)", borderRadius: "4px", borderLeft: "4px solid var(--brand-experiment)" }}>
                                                    <Text variant="text-md/normal" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                                        {(entry as any).messageContent}
                                                    </Text>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </ScrollerThin>
                        ) : (
                            <Forms.FormText>No messages recorded yet.</Forms.FormText>
                        )
                    )}

                    {selectedSection === 3 && (
                        richActivityItems.length ? (
                            <ScrollerThin className="stalker-log-list">
                                {richActivityItems.map(entry => (
                                    <div key={`${entry.userId}-${entry.timestamp}-rich`} className="stalker-log-entry">
                                        <div className="stalker-log-entry__header">
                                            <div className="stalker-log-entry__identity">
                                                {(() => {
                                                    const user = UserStore.getUser(entry.userId);
                                                    const avatarUrl = user?.avatar ? `https://cdn.discordapp.com/avatars/${entry.userId}/${user.avatar}.png?size=64` : null;
                                                    return avatarUrl ? <img src={avatarUrl} alt="" className="stalker-log-entry__avatar" /> : <div className="stalker-log-entry__avatar stalker-log-entry__avatar--fallback">{entry.username?.charAt(0)?.toUpperCase() ?? "?"}</div>;
                                                })()}
                                                <Text variant="text-md/semibold" className="stalker-log-entry__header-name">{entry.username}</Text>
                                            </div>
                                                {renderPresenceStatuses(entry)}
                                        </div>
                                        <div className="stalker-log-entry__meta">
                                            <span>{formatTimestamp(entry.timestamp)}</span>
                                            {renderPresenceActivitySummary(entry, userLogsMap.get(entry.userId) || [])}
                                            {renderDeviceBadges(entry)}
                                        </div>
                                    </div>
                                ))}
                            </ScrollerThin>
                        ) : (
                            <Forms.FormText>No rich presence updates recorded yet.</Forms.FormText>
                        )
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

export function openPresenceHistoryModal(targetUserId?: string) {
    openModal(modalProps => (
        <PresenceHistoryPanel modalProps={modalProps} initialUserId={targetUserId} />
    ));
}
