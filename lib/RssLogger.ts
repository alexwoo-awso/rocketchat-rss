import {
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';

import {
    RssSetting,
} from '../config/Settings';

type RssLogLevel = 'debug' | 'info' | 'warn' | 'error';
type ConfiguredRssLogLevel = RssLogLevel | 'none';

const DEFAULT_LOG_LEVEL: ConfiguredRssLogLevel = 'warn';
const LOG_LEVEL_PRIORITY: Record<ConfiguredRssLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    none: 50,
};

export async function logRss(app: RssFeedApp, read: IRead, level: RssLogLevel, message: string): Promise<void> {
    if (!await shouldLog(read, level)) {
        return;
    }

    switch (level) {
        case 'debug':
            app.getLogger().debug(message);
            break;
        case 'info':
            app.getLogger().info(message);
            break;
        case 'warn':
            app.getLogger().warn(message);
            break;
        case 'error':
            app.getLogger().error(message);
            break;
    }
}

interface RssFeedApp {
    getLogger(): {
        debug(message: string): void;
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}

async function shouldLog(read: IRead, level: RssLogLevel): Promise<boolean> {
    const configuredLevel = normalizeLogLevel(
        await read.getEnvironmentReader().getSettings().getValueById(RssSetting.LogLevel),
    );

    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function normalizeLogLevel(value: unknown): ConfiguredRssLogLevel {
    switch (value) {
        case 'debug':
        case 'info':
        case 'warn':
        case 'error':
        case 'none':
            return value;
        default:
            return DEFAULT_LOG_LEVEL;
    }
}
