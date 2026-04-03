import {
    ParsedRssFeed,
    RssFeedItem,
} from './types';

const ITEM_LIMIT = 20;

export class RssFeedParser {
    public parse(xml: string): ParsedRssFeed {
        const document = xml.trim();
        const isAtom = /<feed[\s>]/i.test(document);
        const itemBlocks = this.extractBlocks(document, isAtom ? 'entry' : 'item');
        const items = itemBlocks
            .map((block) => this.parseItem(block, isAtom))
            .filter((item): item is RssFeedItem => Boolean(item))
            .slice(0, ITEM_LIMIT);

        return {
            title: this.parseFeedTitle(document, isAtom) ?? 'Untitled feed',
            description: this.getText(document, isAtom ? ['subtitle'] : ['channel>description', 'description']),
            siteUrl: this.getFeedLink(document, isAtom),
            items,
        };
    }

    private parseFeedTitle(document: string, isAtom: boolean): string | undefined {
        return this.getText(document, isAtom ? ['title'] : ['channel>title', 'title']);
    }

    private parseItem(block: string, isAtom: boolean): RssFeedItem | undefined {
        const title = this.getText(block, ['title']) ?? 'Untitled item';
        const url = isAtom ? this.getAtomLink(block) : this.getText(block, ['link']);
        const guid = this.getText(block, ['guid', 'id']);
        const summary = this.getText(block, ['description', 'summary', 'content', 'content:encoded']);
        const publishedAt = this.parseDate(this.getText(block, ['pubDate', 'published', 'updated', 'dc:date']));
        const author = this.getText(block, ['author', 'dc:creator', 'name']);
        const key = this.buildItemKey(guid, url, title, publishedAt, summary);

        if (!key) {
            return undefined;
        }

        return {
            key,
            title: sanitizeText(title),
            url: sanitizeUrl(url),
            summary: summary ? sanitizeText(summary) : undefined,
            publishedAt,
            author: author ? sanitizeText(author) : undefined,
        };
    }

    private getFeedLink(document: string, isAtom: boolean): string | undefined {
        const link = isAtom ? this.getAtomLink(document) : this.getText(document, ['channel>link', 'link']);
        return sanitizeUrl(link);
    }

    private getAtomLink(source: string): string | undefined {
        const alternates = Array.from(source.matchAll(/<(?:(?:\w+):)?link\b([^>]*)\/?>/gi));
        for (const match of alternates) {
            const attrs = match[1] ?? '';
            const rel = this.getAttribute(attrs, 'rel');
            if (rel && rel !== 'alternate') {
                continue;
            }

            const href = this.getAttribute(attrs, 'href');
            if (href) {
                return href;
            }
        }

        return undefined;
    }

    private getAttribute(input: string, attribute: string): string | undefined {
        const match = input.match(new RegExp(`${attribute}=["']([^"']+)["']`, 'i'));
        return match?.[1];
    }

    private getText(source: string, selectors: Array<string>): string | undefined {
        for (const selector of selectors) {
            const value = selector.includes('>')
                ? this.getNestedText(source, selector.split('>'))
                : this.getDirectText(source, selector);

            if (value) {
                return value;
            }
        }

        return undefined;
    }

    private getNestedText(source: string, selectors: Array<string>): string | undefined {
        let scope = source;

        for (let index = 0; index < selectors.length - 1; index += 1) {
            const block = this.extractFirstBlock(scope, selectors[index]);
            if (!block) {
                return undefined;
            }

            scope = block;
        }

        return this.getDirectText(scope, selectors[selectors.length - 1]);
    }

    private getDirectText(source: string, tagName: string): string | undefined {
        const escapedTag = escapeTagName(tagName);
        const match = source.match(new RegExp(`<(?:(?:\\w+):)?${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${escapedTag}>`, 'i'));
        if (!match?.[1]) {
            return undefined;
        }

        return decodeEntities(stripCdata(match[1])).trim();
    }

    private extractBlocks(source: string, tagName: string): Array<string> {
        const escapedTag = escapeTagName(tagName);
        return Array.from(source.matchAll(new RegExp(`<(?:(?:\\w+):)?${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${escapedTag}>`, 'gi')))
            .map((match) => match[1]);
    }

    private extractFirstBlock(source: string, tagName: string): string | undefined {
        return this.extractBlocks(source, tagName)[0];
    }

    private parseDate(value: string | undefined): string | undefined {
        if (!value) {
            return undefined;
        }

        const timestamp = Date.parse(value);
        if (Number.isNaN(timestamp)) {
            return undefined;
        }

        return new Date(timestamp).toISOString();
    }

    private buildItemKey(...values: Array<string | undefined>): string | undefined {
        const normalized = values
            .filter((value): value is string => Boolean(value))
            .map((value) => value.trim())
            .filter((value) => value.length > 0);

        if (!normalized.length) {
            return undefined;
        }

        return normalized.join('|').slice(0, 512);
    }
}

function escapeTagName(tagName: string): string {
    return tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCdata(value: string): string {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function sanitizeText(value: string): string {
    const withoutTags = value.replace(/<[^>]+>/g, ' ');
    return withoutTags.replace(/\s+/g, ' ').trim();
}

function sanitizeUrl(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    try {
        return new URL(value).toString();
    } catch {
        return undefined;
    }
}

function decodeEntities(input: string): string {
    const named = input
        .replace(/&nbsp;/g, ' ')
        .replace(/&apos;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lsquo;/g, '\'')
        .replace(/&rsquo;/g, '\'')
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&ndash;/g, '-')
        .replace(/&mdash;/g, '-')
        .replace(/&hellip;/g, '...');

    return named
        .replace(/&#160;/g, ' ')
        .replace(/&#(\d+);/g, (_, value) => String.fromCharCode(Number(value)))
        .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCharCode(parseInt(value, 16)));
}
