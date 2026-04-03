import {
    IHttp,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';

import {
    RssSetting,
} from '../config/Settings';
import {
    ParsedRssFeed,
} from './types';
import {
    RssFeedParser,
} from './RssFeedParser';

export class RssFeedReader {
    private readonly parser = new RssFeedParser();

    public async readFeed(feedUrl: string, read: IRead, http: IHttp): Promise<ParsedRssFeed> {
        const settings = read.getEnvironmentReader().getSettings();
        const timeout = Number(await settings.getValueById(RssSetting.RequestTimeoutMs)) || 10000;
        const userAgent = String(await settings.getValueById(RssSetting.UserAgent) || 'RocketChatRSS/0.1.0');
        const response = await http.get(feedUrl, {
            headers: {
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
                'User-Agent': userAgent,
            },
            timeout,
        });

        if (response.statusCode < 200 || response.statusCode >= 300 || !response.content) {
            throw new Error(`Feed request failed with status ${response.statusCode}.`);
        }

        const feed = this.parser.parse(response.content);
        if (!feed.items.length) {
            throw new Error('Feed response did not contain any RSS or Atom items.');
        }

        return feed;
    }
}
