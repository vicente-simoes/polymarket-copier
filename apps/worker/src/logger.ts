type WorkerLogLevel = "debug" | "info" | "warn" | "error";

interface WorkerLogFields {
  [key: string]: unknown;
}

interface WorkerLogEntry {
  ts: string;
  service: "worker";
  level: WorkerLogLevel;
  event: string;
  data?: WorkerLogFields;
}

function writeLog(level: WorkerLogLevel, event: string, data?: WorkerLogFields): void {
  const entry: WorkerLogEntry = {
    ts: new Date().toISOString(),
    service: "worker",
    level,
    event
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  const payload = JSON.stringify(entry);
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.log(payload);
}

export const workerLogger = {
  debug(event: string, data?: WorkerLogFields): void {
    writeLog("debug", event, data);
  },
  info(event: string, data?: WorkerLogFields): void {
    writeLog("info", event, data);
  },
  warn(event: string, data?: WorkerLogFields): void {
    writeLog("warn", event, data);
  },
  error(event: string, data?: WorkerLogFields): void {
    writeLog("error", event, data);
  }
};
