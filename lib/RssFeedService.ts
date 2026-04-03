import {
    IHttp,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    IRoom,
    RoomType,
} from '@rocket.chat/apps-engine/definition/rooms';
import {
    IUser,
} from '@rocket.chat/apps-engine/definition/users';
import {
    SlashCommandContext,
} from '@rocket.chat/apps-engine/definition/slashcommands';

import {
    RssFeedApp,
} from '../RssFeedApp';
import {
    RssSetting,
} from '../config/Settings';
import {
    RssConfigStore,
} from './RssConfigStore';
import {
    RssFeedReader,
} from './RssFeedReader';
import {
    RssProcessor,
} from './RssProcessor';
import {
    RssSubscriptionStore,
} from './RssSubscriptionStore';
import {
    ProcessSubscriptionResult,
    RssChannelConfig,
    RssDeliveryIdentityConfig,
    RssSubscription,
} from './types';

type ConfigScope =
    | { kind: 'global'; label: string; identityConfig?: RssDeliveryIdentityConfig }
    | { kind: 'channel'; label: string; room: IRoom; channelConfig?: RssChannelConfig }
    | { kind: 'subscription'; label: string; subscription: RssSubscription; channelConfig?: RssChannelConfig };

export class RssFeedService {
    private readonly feedReader = new RssFeedReader();
    private readonly processor: RssProcessor;

    constructor(private readonly app: RssFeedApp) {
        this.processor = new RssProcessor(app);
    }

    public async handleCommand(
        context: SlashCommandContext,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persistence: IPersistence,
    ): Promise<string> {
        const [action = 'help', ...args] = context.getArguments();

        switch (action) {
            case 'help':
                return this.getHelpText();
            case 'subscribe':
                return this.handleSubscribe(args, context, read, http, persistence);
            case 'config':
                return this.handleConfig(args, context, read, persistence);
            case 'list':
                return this.handleList(read);
            case 'remove':
            case 'unsubscribe':
                return this.handleRemove(args, read, persistence);
            case 'pause':
                return this.handlePause(args, read, persistence, true);
            case 'resume':
                return this.handlePause(args, read, persistence, false);
            case 'run':
                return this.handleRun(args, read, modify, http, persistence);
            case 'test':
                return this.handleTest(args, read, http);
            default:
                return `Unsupported RSS action: ${action}. Try \`/rss help\`.`;
        }
    }

    private getHelpText(): string {
        return [
            'RSS commands:',
            '/rss help',
            '/rss subscribe <feed-url> [#channel] [interval-minutes]',
            '/rss config global [show|set|clear] [logo|display-name|username] [value]',
            '/rss config <#channel> [show|set|clear] [logo|display-name|username] [value]',
            '/rss config <subscription-id|feed-url> [show|set|clear] [logo|display-name|username] [value]',
            '/rss list',
            '/rss remove <subscription-id|feed-url>',
            '/rss pause <subscription-id|feed-url>',
            '/rss resume <subscription-id|feed-url>',
            '/rss run [subscription-id|feed-url]',
            '/rss test <feed-url>',
            '',
            'Notes:',
            '- `logo` expects an http/https image URL.',
            '- `display-name` sets the visible sender alias for app-posted messages.',
            '- `username` accepts `app` or an existing Rocket.Chat username such as `@newsbot`.',
        ].join('\n');
    }

    private async handleSubscribe(
        args: Array<string>,
        context: SlashCommandContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
    ): Promise<string> {
        const [feedUrl, targetOrInterval, maybeInterval] = args;
        if (!feedUrl) {
            return 'Missing feed URL. Usage: /rss subscribe <feed-url> [#channel] [interval-minutes]';
        }

        const normalizedFeedUrl = this.validateFeedUrl(feedUrl);
        if (!normalizedFeedUrl) {
            return 'The provided feed URL is not valid. Only http and https are supported.';
        }

        const store = new RssSubscriptionStore(read, persistence);
        const existing = await store.findByFeedUrl(normalizedFeedUrl);
        if (existing) {
            return `That feed is already subscribed as \`${existing.id}\` for #${existing.roomName}.`;
        }

        const room = await this.resolveTargetRoom(targetOrInterval, context, read);
        if (!room) {
            return 'Target room not found. Use `#channel`, run the command inside the target room, or configure a default target channel.';
        }

        const intervalToken = isIntervalValue(targetOrInterval) ? targetOrInterval : maybeInterval;
        const intervalMinutes = await this.resolveInterval(intervalToken, read);
        const feed = await this.feedReader.readFeed(normalizedFeedUrl, read, http);
        const now = new Date().toISOString();
        const subscription: RssSubscription = {
            id: createSubscriptionId(normalizedFeedUrl, room.id),
            feedUrl: normalizedFeedUrl,
            roomId: room.id,
            roomName: room.displayName || room.slugifiedName || room.id,
            intervalMinutes,
            isPaused: false,
            createdAt: now,
            updatedAt: now,
            nextRunAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
            recentItemKeys: feed.items.map((item) => item.key),
            feedTitle: feed.title,
            lastCheckedAt: now,
            lastSuccessAt: now,
        };

        await store.save(subscription);

        return [
            'RSS subscription created.',
            `ID: ${subscription.id}`,
            `Feed: ${feed.title}`,
            `URL: ${subscription.feedUrl}`,
            `Target: #${subscription.roomName}`,
            `Interval: ${subscription.intervalMinutes} minute(s)`,
            `Bootstrap: stored ${feed.items.length} existing item(s) without posting them.`,
        ].join('\n');
    }

    private async handleConfig(
        args: Array<string>,
        context: SlashCommandContext,
        read: IRead,
        persistence: IPersistence,
    ): Promise<string> {
        const [scopeToken = 'global', actionToken = 'show', keyToken, ...valueParts] = args;
        const configStore = new RssConfigStore(read, persistence);
        const scope = await this.resolveConfigScope(scopeToken, context, read);
        if (!scope) {
            return 'Config target not found. Use `global`, `#channel`, or a subscription id/feed URL.';
        }

        const action = normalizeConfigAction(actionToken);
        if (!action) {
            return 'Unsupported config action. Use `show`, `set`, or `clear`.';
        }

        if (action === 'show') {
            return this.formatConfigScope(scope, await configStore.getGlobal());
        }

        const key = normalizeConfigKey(keyToken);
        if (!key) {
            return 'Unsupported config key. Use `logo`, `display-name`, or `username`.';
        }

        const currentConfig = this.getScopeConfig(scope);
        const nextConfig = {
            ...currentConfig,
        };

        if (action === 'clear') {
            delete nextConfig[key];
        } else {
            const value = valueParts.join(' ').trim();
            if (!value) {
                return `Missing config value. Usage: /rss config ${scopeToken} set ${keyToken} <value>`;
            }

            nextConfig[key] = await this.validateConfigValue(key, value, read);
        }

        const normalizedConfig = normalizeIdentityConfig(nextConfig);
        await this.saveScopeConfig(scope, normalizedConfig, read, persistence, configStore);

        const updatedScope = await this.resolveConfigScope(scopeToken, context, read);
        if (!updatedScope) {
            return 'Config was saved, but the updated scope could not be loaded.';
        }

        return [
            `${capitalize(action)}ed RSS config for ${updatedScope.label}.`,
            this.formatConfigScope(updatedScope, await configStore.getGlobal()),
        ].join('\n');
    }

    private async handleList(read: IRead): Promise<string> {
        const store = new RssSubscriptionStore(read);
        const subscriptions = await store.getAll();

        if (!subscriptions.length) {
            return 'No RSS subscriptions are configured.';
        }

        return [
            'RSS subscriptions:',
            ...subscriptions.map((subscription) => {
                const state = subscription.isPaused ? 'paused' : 'active';
                const title = subscription.feedTitle ?? subscription.feedUrl;
                const last = subscription.lastSuccessAt ?? 'never';
                const sender = subscription.identityConfig?.senderUsername ? ` | sender @${subscription.identityConfig.senderUsername}` : '';

                return `- ${subscription.id} | ${state} | #${subscription.roomName} | every ${subscription.intervalMinutes}m | ${title} | last success: ${last}${sender}`;
            }),
        ].join('\n');
    }

    private async handleRemove(args: Array<string>, read: IRead, persistence: IPersistence): Promise<string> {
        const subscription = await this.requireSubscription(args[0], read);
        if (!subscription) {
            return 'Subscription not found. Usage: /rss remove <subscription-id|feed-url>';
        }

        const store = new RssSubscriptionStore(read, persistence);
        await store.remove(subscription.id);

        return `Removed RSS subscription \`${subscription.id}\` (${subscription.feedTitle ?? subscription.feedUrl}).`;
    }

    private async handlePause(args: Array<string>, read: IRead, persistence: IPersistence, isPaused: boolean): Promise<string> {
        const subscription = await this.requireSubscription(args[0], read);
        if (!subscription) {
            return `Subscription not found. Usage: /rss ${isPaused ? 'pause' : 'resume'} <subscription-id|feed-url>`;
        }

        const store = new RssSubscriptionStore(read, persistence);
        await store.save({
            ...subscription,
            isPaused,
            updatedAt: new Date().toISOString(),
        });

        return `${isPaused ? 'Paused' : 'Resumed'} RSS subscription \`${subscription.id}\`.`;
    }

    private async handleRun(
        args: Array<string>,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persistence: IPersistence,
    ): Promise<string> {
        const store = new RssSubscriptionStore(read);
        const subscriptions = args[0]
            ? [await this.requireSubscription(args[0], read)].filter((subscription): subscription is RssSubscription => Boolean(subscription))
            : await store.getAll();

        if (!subscriptions.length) {
            return args[0]
                ? 'Subscription not found.'
                : 'No RSS subscriptions are configured.';
        }

        const results: Array<ProcessSubscriptionResult> = [];
        for (const subscription of subscriptions) {
            results.push(await this.processor.processSubscription(subscription, read, modify, http, persistence, true));
        }

        return [
            'RSS run complete:',
            ...results.map((result) => this.formatRunResult(result)),
        ].join('\n');
    }

    private async handleTest(args: Array<string>, read: IRead, http: IHttp): Promise<string> {
        const feedUrl = args[0];
        if (!feedUrl) {
            return 'Missing feed URL. Usage: /rss test <feed-url>';
        }

        const normalizedFeedUrl = this.validateFeedUrl(feedUrl);
        if (!normalizedFeedUrl) {
            return 'The provided feed URL is not valid. Only http and https are supported.';
        }

        const feed = await this.feedReader.readFeed(normalizedFeedUrl, read, http);
        const previewItems = feed.items.slice(0, 3);

        return [
            `Feed title: ${feed.title}`,
            `Site: ${feed.siteUrl ?? 'n/a'}`,
            `Items parsed: ${feed.items.length}`,
            'Preview:',
            ...previewItems.map((item, index) => `${index + 1}. ${item.title}${item.url ? ` | ${item.url}` : ''}`),
        ].join('\n');
    }

    private async resolveConfigScope(scopeToken: string, context: SlashCommandContext, read: IRead): Promise<ConfigScope | undefined> {
        const configStore = new RssConfigStore(read);
        if (scopeToken === 'global') {
            return {
                kind: 'global',
                label: 'global defaults',
                identityConfig: await configStore.getGlobal(),
            };
        }

        if (scopeToken.startsWith('#')) {
            const room = await read.getRoomReader().getByName(scopeToken.slice(1));
            if (!room) {
                return undefined;
            }

            return {
                kind: 'channel',
                label: `channel #${room.displayName || room.slugifiedName || room.id}`,
                room,
                channelConfig: await configStore.getChannel(room.id),
            };
        }

        const subscription = await this.requireSubscription(scopeToken, read);
        if (subscription) {
            return {
                kind: 'subscription',
                label: `subscription \`${subscription.id}\``,
                subscription,
                channelConfig: await configStore.getChannel(subscription.roomId),
            };
        }

        if (scopeToken === context.getRoom().slugifiedName || scopeToken === `#${context.getRoom().slugifiedName}`) {
            return this.resolveConfigScope(`#${context.getRoom().slugifiedName}`, context, read);
        }

        return undefined;
    }

    private getScopeConfig(scope: ConfigScope): RssDeliveryIdentityConfig {
        if (scope.kind === 'global') {
            return scope.identityConfig ?? {};
        }

        if (scope.kind === 'channel') {
            return scope.channelConfig?.identityConfig ?? {};
        }

        return scope.subscription.identityConfig ?? {};
    }

    private async saveScopeConfig(
        scope: ConfigScope,
        identityConfig: RssDeliveryIdentityConfig | undefined,
        read: IRead,
        persistence: IPersistence,
        configStore: RssConfigStore,
    ): Promise<void> {
        if (scope.kind === 'global') {
            await configStore.saveGlobal(identityConfig ?? {});
            return;
        }

        if (scope.kind === 'channel') {
            await configStore.saveChannel({
                roomId: scope.room.id,
                roomName: scope.room.displayName || scope.room.slugifiedName || scope.room.id,
                updatedAt: new Date().toISOString(),
                identityConfig,
            });
            return;
        }

        const store = new RssSubscriptionStore(read, persistence);
        await store.save({
            ...scope.subscription,
            identityConfig,
            updatedAt: new Date().toISOString(),
        });
    }

    private async validateConfigValue(
        key: keyof RssDeliveryIdentityConfig,
        value: string,
        read: IRead,
    ): Promise<string> {
        if (key === 'avatarUrl') {
            const avatarUrl = this.validateFeedUrl(value);
            if (!avatarUrl) {
                throw new Error('Logo must be a valid http or https URL.');
            }

            return avatarUrl;
        }

        if (key === 'displayName') {
            const displayName = value.trim();
            if (!displayName) {
                throw new Error('Display name cannot be empty.');
            }

            return displayName;
        }

        const normalizedUsername = normalizeUsernameToken(value);
        if (!normalizedUsername) {
            throw new Error('Username must be `app` or an existing Rocket.Chat username like `@newsbot`.');
        }

        if (normalizedUsername === 'app') {
            return normalizedUsername;
        }

        const user = await this.findUserByUsername(read, normalizedUsername);
        if (!user) {
            throw new Error(`Rocket.Chat user \`@${normalizedUsername}\` was not found.`);
        }

        return normalizedUsername;
    }

    private formatConfigScope(scope: ConfigScope, globalConfig: RssDeliveryIdentityConfig): string {
        const storedConfig = this.getScopeConfig(scope);
        const effectiveConfig = scope.kind === 'global'
            ? globalConfig
            : mergeIdentityConfig(
                globalConfig,
                scope.channelConfig?.identityConfig,
                scope.kind === 'subscription' ? scope.subscription.identityConfig : scope.channelConfig?.identityConfig,
            );

        return [
            `RSS config for ${scope.label}:`,
            'Stored values:',
            ...this.formatIdentityConfig(storedConfig),
            ...(scope.kind === 'global'
                ? []
                : [
                    'Effective values:',
                    ...this.formatIdentityConfig(effectiveConfig),
                ]),
        ].join('\n');
    }

    private formatIdentityConfig(config: RssDeliveryIdentityConfig | undefined): Array<string> {
        const senderUsername = normalizeStoredSenderUsername(config?.senderUsername);

        return [
            `- logo: ${config?.avatarUrl ?? '(inherit/default)'}`,
            `- display-name: ${config?.displayName ?? '(inherit/default)'}`,
            `- username: ${senderUsername ? `@${senderUsername}` : 'app'}`,
        ];
    }

    private async requireSubscription(identifier: string | undefined, read: IRead): Promise<RssSubscription | undefined> {
        if (!identifier) {
            return undefined;
        }

        const store = new RssSubscriptionStore(read);
        const byId = await store.getById(identifier);
        if (byId) {
            return byId;
        }

        return store.findByFeedUrl(identifier);
    }

    private async resolveTargetRoom(targetToken: string | undefined, context: SlashCommandContext, read: IRead): Promise<IRoom | undefined> {
        if (targetToken?.startsWith('#')) {
            return read.getRoomReader().getByName(targetToken.slice(1));
        }

        if (!isIntervalValue(targetToken) && !this.requiresConfiguredDefaultRoom(context.getRoom())) {
            return context.getRoom();
        }

        const configuredDefault = String(await read.getEnvironmentReader().getSettings().getValueById(RssSetting.DefaultTargetChannel) || '').trim();
        if (configuredDefault) {
            return read.getRoomReader().getByName(configuredDefault.replace(/^#/, ''));
        }

        return context.getRoom();
    }

    private async resolveInterval(intervalToken: string | undefined, read: IRead): Promise<number> {
        const configuredDefault = Number(await read.getEnvironmentReader().getSettings().getValueById(RssSetting.DefaultPollIntervalMinutes)) || 15;
        const parsed = Number(intervalToken);

        if (!intervalToken || Number.isNaN(parsed)) {
            return Math.max(1, configuredDefault);
        }

        return Math.max(1, Math.floor(parsed));
    }

    private validateFeedUrl(feedUrl: string): string | undefined {
        try {
            const parsed = new URL(feedUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return undefined;
            }

            return parsed.toString();
        } catch {
            return undefined;
        }
    }

    private async findUserByUsername(read: IRead, username: string): Promise<IUser | undefined> {
        try {
            return await read.getUserReader().getByUsername(username);
        } catch {
            return undefined;
        }
    }

    private formatRunResult(result: ProcessSubscriptionResult): string {
        if (result.error) {
            return `- ${result.subscription.id}: error - ${result.error}`;
        }

        if (result.skipped) {
            return `- ${result.subscription.id}: skipped - ${result.skipped}`;
        }

        if (result.bootstrapItemCount > 0) {
            return `- ${result.subscription.id}: bootstrapped ${result.bootstrapItemCount} item(s) from ${result.feedTitle ?? result.subscription.feedUrl}`;
        }

        if (result.detectedCount === 0) {
            return `- ${result.subscription.id}: no new items`;
        }

        if (result.dryRun) {
            return `- ${result.subscription.id}: detected ${result.detectedCount} new item(s), delivery skipped because dry-run mode is enabled`;
        }

        return `- ${result.subscription.id}: delivered ${result.deliveredCount}/${result.detectedCount} new item(s)`;
    }

    private requiresConfiguredDefaultRoom(room: IRoom): boolean {
        return room.type === RoomType.DIRECT_MESSAGE || room.type === RoomType.LIVE_CHAT;
    }
}

function isIntervalValue(value: string | undefined): boolean {
    return typeof value === 'string' && /^\d+$/.test(value);
}

function createSubscriptionId(feedUrl: string, roomId: string): string {
    const input = `${feedUrl}|${roomId}`;
    let hash = 0;

    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }

    return `rss-${Math.abs(hash).toString(36)}`;
}

function normalizeConfigAction(action: string | undefined): 'show' | 'set' | 'clear' | undefined {
    if (!action) {
        return 'show';
    }

    if (['show', 'get', 'list'].includes(action)) {
        return 'show';
    }

    if (['set', 'update'].includes(action)) {
        return 'set';
    }

    if (['clear', 'unset', 'reset'].includes(action)) {
        return 'clear';
    }

    return undefined;
}

function normalizeConfigKey(key: string | undefined): keyof RssDeliveryIdentityConfig | undefined {
    switch ((key || '').toLowerCase()) {
        case 'logo':
        case 'avatar':
        case 'icon':
            return 'avatarUrl';
        case 'display-name':
        case 'displayname':
        case 'name':
        case 'alias':
            return 'displayName';
        case 'username':
        case 'user':
        case 'sender':
            return 'senderUsername';
        default:
            return undefined;
    }
}

function normalizeIdentityConfig(config: RssDeliveryIdentityConfig | undefined): RssDeliveryIdentityConfig | undefined {
    if (!config) {
        return undefined;
    }

    const identityConfig: RssDeliveryIdentityConfig = {
        avatarUrl: normalizeOptionalString(config.avatarUrl),
        displayName: normalizeOptionalString(config.displayName),
        senderUsername: normalizeStoredSenderUsername(config.senderUsername),
    };

    return identityConfig.avatarUrl || identityConfig.displayName || identityConfig.senderUsername
        ? identityConfig
        : undefined;
}

function mergeIdentityConfig(...configs: Array<RssDeliveryIdentityConfig | undefined>): RssDeliveryIdentityConfig {
    return configs.reduce<RssDeliveryIdentityConfig>((merged, current) => ({
        avatarUrl: current?.avatarUrl ?? merged.avatarUrl,
        displayName: current?.displayName ?? merged.displayName,
        senderUsername: normalizeStoredSenderUsername(current?.senderUsername) ?? merged.senderUsername,
    }), {});
}

function normalizeOptionalString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}

function normalizeUsernameToken(value: string | undefined): string | undefined {
    const trimmed = normalizeOptionalString(value)?.replace(/^@/, '');
    if (!trimmed) {
        return undefined;
    }

    return trimmed === 'app' ? 'app' : trimmed;
}

function normalizeStoredSenderUsername(value: string | undefined): string | undefined {
    const normalized = normalizeUsernameToken(value);
    return normalized === 'app' ? undefined : normalized;
}

function capitalize(value: string): string {
    return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
