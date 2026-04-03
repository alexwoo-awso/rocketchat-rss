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
    SlashCommandContext,
} from '@rocket.chat/apps-engine/definition/slashcommands';

import {
    RssSetting,
} from '../config/Settings';
import {
    RssFeedApp,
} from '../RssFeedApp';
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
    RssSubscription,
} from './types';

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
            '/rss list',
            '/rss remove <subscription-id|feed-url>',
            '/rss pause <subscription-id|feed-url>',
            '/rss resume <subscription-id|feed-url>',
            '/rss run [subscription-id|feed-url]',
            '/rss test <feed-url>',
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

                return `- ${subscription.id} | ${state} | #${subscription.roomName} | every ${subscription.intervalMinutes}m | ${title} | last success: ${last}`;
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
