type WebLogLevel = 'debug' | 'info' | 'warn' | 'error'

interface WebLogFields {
  [key: string]: unknown
}

interface WebLogEntry {
  ts: string
  service: 'web'
  level: WebLogLevel
  event: string
  data?: WebLogFields
}

function writeLog(level: WebLogLevel, event: string, data?: WebLogFields) {
  const entry: WebLogEntry = {
    ts: new Date().toISOString(),
    service: 'web',
    level,
    event
  }

  if (data && Object.keys(data).length > 0) {
    entry.data = data
  }

  const payload = JSON.stringify(entry)
  if (level === 'error') {
    console.error(payload)
    return
  }
  if (level === 'warn') {
    console.warn(payload)
    return
  }
  console.log(payload)
}

export const webLogger = {
  debug(event: string, data?: WebLogFields) {
    writeLog('debug', event, data)
  },
  info(event: string, data?: WebLogFields) {
    writeLog('info', event, data)
  },
  warn(event: string, data?: WebLogFields) {
    writeLog('warn', event, data)
  },
  error(event: string, data?: WebLogFields) {
    writeLog('error', event, data)
  }
}
