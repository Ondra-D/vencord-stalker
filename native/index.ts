


import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent, shell } from "electron";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";

import { PresenceLogEntry } from "../types";

let logsDir: string;

const getLogsDir = async () => {
    if (!logsDir) {
        const oldPath = path.join(DATA_DIR, "StalkerLogs");
        const newPath = path.join(DATA_DIR, "ActivityTrackerLogs");

        let useOld = false;
        try {
            const info = await stat(oldPath);
            if (info.isDirectory()) {
                useOld = true;
            }
        } catch {}

        logsDir = useOld ? oldPath : newPath;
        await mkdir(logsDir, { recursive: true });
    }
    return logsDir;
};

export async function openLogsFolder(_event: IpcMainInvokeEvent) {
    const logsDir = await getLogsDir();
    await shell.openPath(logsDir);
}

export async function openLogFile(_event: IpcMainInvokeEvent, userId: string) {
    const logsDir = await getLogsDir();
    const filePath = path.join(logsDir, `${userId}.jsonl`);
    const error = await shell.openPath(filePath);
    if (error) {
        await shell.openPath(logsDir);
    }
}

export async function appendLog(_event: IpcMainInvokeEvent, userId: string, entry: PresenceLogEntry, cutoffMs: number) {
    const logsDir = await getLogsDir();
    const filePath = path.join(logsDir, `${userId}.jsonl`);

    try {
        let existingLogs = await readLogs(_event, userId);
        if (cutoffMs) {
            existingLogs = existingLogs.filter(log => log.timestamp >= cutoffMs);
        }
        existingLogs.unshift(entry);

        const content = existingLogs.map(log => JSON.stringify(log)).join("\n") + "\n";
        await writeFile(filePath, content, "utf-8");
    } catch (e) {
        console.error("Failed to append log", e);
        throw e;
    }
}

export async function readLogs(_event: IpcMainInvokeEvent, userId: string, cutoffMs?: number): Promise<PresenceLogEntry[]> {
    const logsDir = await getLogsDir();
    const filePath = path.join(logsDir, `${userId}.jsonl`);

    try {
        const content = await readFile(filePath, "utf-8");
        const parsed = content.trim().split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
        if (cutoffMs) {
            return parsed.filter(log => log.timestamp >= cutoffMs);
        }
        return parsed;
    } catch (e) {
        return [];
    }
}


export async function deleteLogs(_event: IpcMainInvokeEvent, userId: string) {
    const logsDir = await getLogsDir();
    const filePath = path.join(logsDir, `${userId}.jsonl`);

    try {
        await unlink(filePath);
    } catch (e) {
    }
}

