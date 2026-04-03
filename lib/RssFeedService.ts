import { IHttp } from '@rocket.chat/apps-engine/definition/accessors';

import { RssFeedApp } from '../RssFeedApp';

export class RssFeedService {
    constructor(private readonly app: RssFeedApp) {}

    public async handleCommand(args: Array<string>, _http: IHttp): Promise<string> {
        const [action, ...rest] = args;

        switch (action) {
            case 'subscribe':
                return this.handleSubscribe(rest);
            default:
                return `Unsupported RSS action: ${action}. Try \`/rss help\`.`;
        }
    }

    private handleSubscribe(args: Array<string>): string {
        const [feedUrl, targetChannel] = args;

        if (!feedUrl) {
            return 'Missing feed URL. Usage: /rss subscribe <feed-url> [#channel]';
        }

        try {
            const parsed = new URL(feedUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return 'Only http and https feed URLs are supported.';
            }
        } catch {
            return 'The provided feed URL is not valid.';
        }

        this.app.getLogger().debug(`Prepared subscription for ${feedUrl} ${targetChannel ?? ''}`.trim());

        return [
            'Subscription request accepted.',
            `Feed: ${feedUrl}`,
            `Target: ${targetChannel ?? 'workspace default setting'}`,
            'Note: persistence and scheduled delivery are the next implementation step.',
        ].join('\n');
    }
}
